// Stand-in for an external Canton wallet, to exercise /api/ext/prepare and
// /api/ext/execute end to end.
//
//   node wallet_sign_demo.js --list
//   node wallet_sign_demo.js --withdraw-pending <cid>            (PREPARE ONLY, no write)
//   node wallet_sign_demo.js --withdraw-pending <cid> --execute  (signs and submits)
//
// Default is prepare-only: it stops after printing the transaction hash, so it can be
// run safely against a live backend without touching the ledger. Nothing is submitted
// unless --execute is passed explicitly.
//
// HONEST LIMITATION: this reads the party's key from ext-parties.local.txt, i.e. the
// key the SERVER still holds. That is enough to prove the prepare -> sign -> execute
// wiring works, but it does NOT yet prove the custody property -- the server could
// have signed this itself. Proving that needs onboard-by-public-key, so a party exists
// whose private half this machine has never seen. Until then, read this as a test of
// the plumbing, not of trustlessness.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://localhost:" + (process.env.PORT || 4000));
const PKGN = process.env.PACKAGE_NAME;
const STORE = path.join(__dirname, "ext-parties.local.txt");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const ROLE = val("--role") || "requester";
const EXECUTE = has("--execute");

function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}

async function jfetch(p, body) {
  const r = await fetch(API + p, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${(j.error || j.raw || "").toString().slice(0, 300)}`);
  return j;
}

(async () => {
  const store = loadStore();
  const rec = store[ROLE];
  if (!rec || !rec.partyId) return console.log(`no party '${ROLE}' in ${STORE}`);

  if (has("--list")) {
    const r = await fetch(`${API}/api/swap/pending?role=${ROLE}`).catch(() => null);
    console.log("party:", rec.partyId);
    console.log("Use diag_orphans.js to list RealSwapPending cids.", r ? "" : "");
    return;
  }

  const cid = val("--withdraw-pending");
  if (!cid) return console.log("nothing to do - pass --withdraw-pending <cid>");

  // WithdrawRealSwap is controller `requester` and its body is `pure ()`: it archives a
  // dead pending swap and moves no assets. A deliberately inert choice to test with.
  const commands = [{
    ExerciseCommand: {
      templateId: `#${PKGN}:UmbraSwap:RealSwapPending`,
      contractId: cid,
      choice: "WithdrawRealSwap",
      choiceArgument: {},
    },
  }];

  console.log("party        :", rec.partyId);
  console.log("command      : WithdrawRealSwap on", String(cid).slice(0, 28) + "…");

  const prep = await jfetch("/api/ext/prepare", { party: rec.partyId, commands, tag: "walletdemo" });
  console.log("commandId    :", prep.commandId);
  console.log("hash (b64)   :", String(prep.preparedTransactionHash).slice(0, 44) + "…");
  console.log("hashScheme   :", prep.hashingSchemeVersion);
  console.log("PREPARE OK   - the server produced a transaction it cannot submit alone.");

  if (!EXECUTE) {
    console.log("\nstopping here (prepare-only). Re-run with --execute to sign and submit.");
    return;
  }

  // ---- the part a real wallet does, with a key the server would never hold ----
  const priv = crypto.createPrivateKey({
    key: Buffer.from(rec.privDer, "base64"), format: "der", type: "pkcs8",
  });
  const signature = crypto
    .sign(null, Buffer.from(prep.preparedTransactionHash, "base64"), priv)
    .toString("base64");
  console.log("signed locally, submitting…");

  const out = await jfetch("/api/ext/execute", {
    party: rec.partyId,
    commandId: prep.commandId,
    preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion,
    signature,
    signedBy: rec.fingerprint,
  });
  console.log("EXECUTE      :", JSON.stringify(out));
})().catch((e) => console.log("FAILED:", e.message));
