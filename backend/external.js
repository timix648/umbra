const { ledgerFetch } = require("./token");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const SYNC = process.env.SYNCHRONIZER_ID ||
  "global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
const USER_ID = process.env.LEDGER_USER_ID || "6";
const STORE = path.join(__dirname, "ext-parties.local.txt"); // gitignored by *.local.txt

function loadStore() { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } }
function saveStore(s) { fs.writeFileSync(STORE, JSON.stringify(s, null, 2)); }

// POST helper: returns parsed JSON, throws on non-2xx with the body text
async function jpost(p, body) {
  const r = await ledgerFetch(p, { method: "POST", body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${t.slice(0, 400)}`);
  try { return JSON.parse(t); } catch { return {}; }
}

// Onboard (or reuse) an external party for a role. Persists its ed25519 key.
async function onboardExternalParty(role) {
  const store = loadStore();
  if (store[role]) return store[role];

  const kp = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const rawPub = kp.publicKey.subarray(kp.publicKey.length - 32).toString("base64");
  const privDer = kp.privateKey.toString("base64");
  const priv = crypto.createPrivateKey({ key: kp.privateKey, format: "der", type: "pkcs8" });
  const pk = { format: "CRYPTO_KEY_FORMAT_RAW", keyData: rawPub, keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519" };

  const g = await jpost("/v2/parties/external/generate-topology", {
    partyHint: role + "-" + Date.now(), synchronizer: SYNC, publicKey: pk,
  });
  const sigTopo = crypto.sign(null, Buffer.from(g.multiHash, "base64"), priv).toString("base64");
  await jpost("/v2/parties/external/allocate", {
    synchronizer: SYNC,
    onboardingTransactions: g.topologyTransactions.map((t) => ({ transaction: t })),
    multiHashSignatures: [{ format: "SIGNATURE_FORMAT_RAW", signature: sigTopo,
      signedBy: g.publicKeyFingerprint, signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }],
  });

  // Let the operator READ this party (display only; cannot transact without the key).
  try {
    await jpost(`/v2/users/${USER_ID}/rights`, {
      userId: USER_ID, rights: [{ kind: { CanReadAs: { value: { party: g.partyId } } } }],
    });
  } catch (e) { console.log("[ext] readAs grant skipped:", e.message); }

  const rec = { role, partyId: g.partyId, fingerprint: g.publicKeyFingerprint, privDer };
  store[role] = rec; saveStore(store);
  console.log(`[ext] onboarded ${role} -> ${g.partyId}`);
  return rec;
}

// prepare -> sign (with the party's OWN key) -> execute. The operator never signs.
async function prepareSignExecute(rec, commands, tag = "ext") {
  const prep = await jpost("/v2/interactive-submission/prepare", {
    userId: USER_ID, actAs: [rec.partyId], commandId: `${tag}-${Date.now()}`,
    synchronizerId: SYNC, packageIdSelectionPreference: [], commands,
  });
  const priv = crypto.createPrivateKey({ key: Buffer.from(rec.privDer, "base64"), format: "der", type: "pkcs8" });
  const sig = crypto.sign(null, Buffer.from(prep.preparedTransactionHash, "base64"), priv).toString("base64");
  return jpost("/v2/interactive-submission/execute", {
    preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion,
    submissionId: `${tag}-${Date.now()}`, userId: USER_ID,
    deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: rec.partyId, signatures: [{
      format: "SIGNATURE_FORMAT_RAW", signature: sig, signedBy: rec.fingerprint,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }] },
  });
}

module.exports = { onboardExternalParty, prepareSignExecute };
