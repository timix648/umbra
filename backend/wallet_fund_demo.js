// Give a wallet-onboarded party real DevNet tokens, and have IT accept them.
//
//   node wallet_fund_demo.js                       dry run (shows the plan, writes nothing)
//   node wallet_fund_demo.js --execute             send + wallet-accept
//   node wallet_fund_demo.js --execute --amount 1.0 --asset Amulet
//
// The send half is signed by the operator as `requester` (a demo party whose key the
// server legitimately holds). The ACCEPT half is signed by the wallet: the server
// assembles the registry choice-context and disclosures it alone can build, hands the
// commands back via build=1, and never touches the signature. That split is the whole
// point -- registry plumbing from the venue, authority from the wallet.

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
const AMOUNT = val("--amount", "1.0");
const FROM = val("--from", "requester");

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
  const wallets = JSON.parse(fs.readFileSync(WALLET_STORE, "utf8"));
  // Fund the party THIS keyfile owns. Falling back to the first entry is only safe
  // when there is exactly one wallet; with several it silently funds a stranger.
  const wallet = (key.partyId && wallets[key.partyId]) || Object.values(wallets)[0];
  if (!wallet) return console.log("no onboarded wallet party - run wallet_onboard_demo.js --execute first");
  if (!key.partyId) console.log("note: keyfile predates partyId recording - using first wallet in store");
  console.log("wallet party :", wallet.partyId);

  // Pick a holding of the requested asset that covers the amount on its own.
  const h = await jfetch(`/api/real/holdings?role=${encodeURIComponent(FROM)}`);
  const cands = (h.raw || []).filter(x =>
    x.id === ASSET && !x.lock && Number(x.amount) >= Number(AMOUNT));
  if (!cands.length) return console.log(`no unlocked ${ASSET} holding >= ${AMOUNT} for ${FROM}`);
  const pick = cands.sort((a, b) => Number(a.amount) - Number(b.amount))[0]; // smallest that fits
  console.log(`funding      : ${AMOUNT} ${ASSET} from ${FROM}`);
  console.log(`using holding: ${pick.contractId.slice(0, 24)}… (${pick.amount})`);
  console.log(`admin        : ${pick.admin.slice(0, 34)}…`);

  if (!EXECUTE) return console.log("\ndry run - nothing sent. Re-run with --execute.");

  const pendingFor = async () => {
    const p = await jfetch(`/api/real/pending?role=${encodeURIComponent(wallet.partyId)}`).catch(() => null);
    const offers = (p && (p.pending || p.offers || p.transfers)) || [];
    return offers.find(o => o.instrument === ASSET) || offers[0] || null;
  };

  // Idempotent: if a transfer is already waiting, accept THAT rather than sending more.
  // A failed accept must not cost another 1.0 on every retry.
  let offer = await pendingFor();
  if (offer) {
    console.log("existing offer found - skipping send");
  } else {
    const sent = await jfetch("/api/real/send", {
      senderRole: FROM, receiver: wallet.partyId,
      admin: pick.admin, id: ASSET, amount: AMOUNT,
      holdingCids: [pick.contractId],
    });
    console.log("SENT         :", JSON.stringify(sent.sent || sent));
    for (let i = 0; i < 25 && !offer; i++) {
      await sleep(2000);
      offer = await pendingFor();
      if (!offer) process.stdout.write(".");
    }
    console.log();
  }
  if (!offer) return console.log("no pending transfer appeared for the wallet party (registry lag?)");
  console.log("pending offer:", String(offer.contractId).slice(0, 28) + "…", offer.amount, offer.instrument);

  // BUILD the accept command server-side, SIGN it wallet-side.
  const built = await jfetch(`/api/real/pending/${offer.contractId}/accept?build=1`, {
    role: wallet.partyId, build: true,
  });
  console.log("built accept : commands=" + built.commands.length,
              "disclosed=" + (built.disclosedContracts || []).length);

  const prep = await jfetch("/api/ext/prepare", {
    party: wallet.partyId, commands: built.commands,
    disclosedContracts: built.disclosedContracts, tag: "walletaccept",
  });
  const out = await jfetch("/api/ext/execute", {
    party: wallet.partyId, commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion,
    signature: sign(prep.preparedTransactionHash, key.privDer),
    signedBy: wallet.fingerprint,
  });
  console.log("ACCEPT       :", JSON.stringify(out));

  await sleep(4000);
  const wh = await jfetch(`/api/real/holdings?role=${encodeURIComponent(wallet.partyId)}`);
  console.log("\nWALLET HOLDINGS:", JSON.stringify(wh.instruments || []));
})().catch((e) => console.log("FAILED:", e.message));
