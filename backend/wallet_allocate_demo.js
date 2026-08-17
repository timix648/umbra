// A wallet party allocates its OWN leg, with its own key.
//
//   node wallet_allocate_demo.js                    dry run
//   node wallet_allocate_demo.js --execute          allocate for real
//   node wallet_allocate_demo.js --execute --amount 0.5 --asset Amulet
//
// This is the piece settle-real now adopts: findExistingAllocation() looks for an
// allocation from this sender, for this leg, under this settlement reference, and uses
// it instead of allocating on the party's behalf. Proving the wallet can produce one
// means Umbra never needs that party's key to settle its side of a trade.
//
// The settlement reference here is supplied on the command line. In a real trade it is
// the SwapProposal's tradeId, which the CIP-56 AllocationRequest view publishes -- so a
// standard wallet reads it off the ledger rather than being told.

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://localhost:" + (process.env.PORT || 4000));
const KEYFILE = process.env.WALLET_KEY_FILE || path.join(os.homedir(), "umbra-wallet-key.local.json");
const WALLET_STORE = path.join(__dirname, "ext-wallets.local.txt");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const EXECUTE = has("--execute");
const ASSET = val("--asset", "Amulet");
const AMOUNT = val("--amount", "0.5");
const LEG = val("--leg", "offer");
const SETTLE_ID = val("--settle-id", "wallet-selfalloc-" + Date.now());
const TO = val("--to", "dealer1");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function jfetch(p, body, method) {
  const r = await fetch(API + p, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${(j.error || j.raw || "").toString().slice(0, 300)}`);
  return j;
}

const sign = (b64hash, privDer) => crypto.sign(
  null, Buffer.from(b64hash, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(privDer, "base64"), format: "der", type: "pkcs8" })
).toString("base64");

(async () => {
  const key = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const wallet = Object.values(JSON.parse(fs.readFileSync(WALLET_STORE, "utf8")))[0];
  if (!wallet) return console.log("no onboarded wallet party");

  const h = await jfetch(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
  const cands = (h.raw || []).filter(x => x.id === ASSET && !x.lock && Number(x.amount) >= Number(AMOUNT));
  if (!cands.length) return console.log(`wallet has no unlocked ${ASSET} >= ${AMOUNT}. Run wallet_fund_demo.js first.`);
  const pick = cands.sort((a, b) => Number(a.amount) - Number(b.amount))[0];

  console.log("wallet party :", wallet.partyId.slice(0, 40) + "…");
  console.log("allocating   :", AMOUNT, ASSET, "as leg", `"${LEG}"`);
  console.log("settlementRef:", SETTLE_ID);
  console.log("holding      :", pick.contractId.slice(0, 24) + "…", `(${pick.amount})`);

  if (!EXECUTE) return console.log("\ndry run - nothing allocated. Re-run with --execute.");

  // Server assembles the registry choice-context and disclosures; it cannot submit it.
  const built = await jfetch("/api/real/allocate?build=1", {
    build: true,
    senderRole: wallet.partyId,
    receiverRole: TO,
    admin: pick.admin, id: ASSET, amount: AMOUNT,
    holdingCids: [pick.contractId],
    settleId: SETTLE_ID, legId: LEG,
  });
  console.log("built alloc  : commands=" + built.commands.length,
              "disclosed=" + (built.disclosedContracts || []).length);

  const prep = await jfetch("/api/ext/prepare", {
    party: wallet.partyId, commands: built.commands,
    disclosedContracts: built.disclosedContracts, tag: "walletalloc",
  });
  const out = await jfetch("/api/ext/execute", {
    party: wallet.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, key.privDer),
    signedBy: wallet.fingerprint,
  });
  console.log("EXECUTE      :", JSON.stringify(out));

  await sleep(4000);
  const al = await jfetch(`/api/real/allocations?party=${encodeURIComponent(wallet.partyId)}`);
  const mine = (al.allocations || []).filter(a => a.settlementRef && a.settlementRef.id === SETTLE_ID);
  console.log("\nALLOCATIONS UNDER THIS REF:", JSON.stringify(mine.map(a => ({
    cid: String(a.contractId).slice(0, 20) + "…", leg: a.transferLegId,
    amount: a.amount, instrument: a.instrument,
  })), null, 1));
  console.log(mine.length
    ? "\nsettle-real's findExistingAllocation() would adopt this leg instead of signing for the party."
    : "\nno allocation found under that reference - check the registry lag or the ref/leg names.");
})().catch((e) => console.log("FAILED:", e.message));
