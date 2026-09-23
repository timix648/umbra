const { ledgerFetch } = require("./token");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const SYNC = process.env.SYNCHRONIZER_ID ||
  "global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
const USER_ID = process.env.LEDGER_USER_ID || "6";
// The venue's own party keys live behind signer.js and never come back out of it:
// callers ask it to sign and receive a signature. That is what makes a KMS
// backend droppable later without touching a single call site here.
const { getSigner, newKey } = require("./signer");
const signer = getSigner();

// Sign `hashB64` as `rec`'s party. rec carries no key -- only the role that
// names one inside the keystore.
const signAs = (rec, hashB64) => signer.sign(rec.role, hashB64);

// POST helper: returns parsed JSON, throws on non-2xx with the body text
async function jpost(p, body) {
  const r = await ledgerFetch(p, { method: "POST", body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${t.slice(0, 400)}`);
  try { return JSON.parse(t); } catch { return {}; }
}

// Onboard (or reuse) an external party for a role. Persists its ed25519 key.
async function onboardExternalParty(role) {
  const existing = signer.recordFor(role);
  if (existing) return existing;

  // Held only until the party id exists -- allocate needs a signature over the
  // topology, and there is nothing to file the key under until that lands.
  const handle = newKey();
  const pk = { format: "CRYPTO_KEY_FORMAT_RAW", keyData: handle.publicKeyRaw, keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519" };

  const g = await jpost("/v2/parties/external/generate-topology", {
    partyHint: role + "-" + Date.now(), synchronizer: SYNC, publicKey: pk,
  });
  const sigTopo = handle.sign(g.multiHash);
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

  const rec = signer.commit(role, handle,
    { partyId: g.partyId, fingerprint: g.publicKeyFingerprint });
  console.log(`[ext] onboarded ${role} -> ${g.partyId}`);
  return rec;
}

// prepare -> sign (with the party's OWN key) -> execute. The operator never signs.
async function prepareSignExecute(rec, commands, tag = "ext", disclosed = []) {
  // The commandId is the ONLY handle the caller has for looking this submission up
  // in /v2/commands/completions afterwards. execute is async-accepted, so without it
  // a rejection is indistinguishable from a slow commit. Generate it once and hand
  // it back rather than burning it inline.
  const commandId = `${tag}-${Date.now()}`;
  const prep = await jpost("/v2/interactive-submission/prepare", {
    userId: USER_ID, actAs: [rec.partyId], commandId,
    synchronizerId: SYNC, packageIdSelectionPreference: [], commands,
    disclosedContracts: disclosed,
  });
  const sig = signAs(rec, prep.preparedTransactionHash);
  const out = await jpost("/v2/interactive-submission/execute", {
    preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion,
    submissionId: `${tag}-${Date.now()}`, userId: USER_ID,
    deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: rec.partyId, signatures: [{
      format: "SIGNATURE_FORMAT_RAW", signature: sig, signedBy: rec.fingerprint,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }] },
  });
  return Object.assign({}, out, { commandId, actAs: [rec.partyId] });
}

// Multi-party prepare -> sign -> execute. Every party signs with its OWN key;
// the operator still signs nothing. Needed whenever a contract has more than one
// external signatory (e.g. AssetHolding = signatory owner, asset.admin).
async function prepareSignExecuteMulti(recs, commands, tag = "extm", disclosed = []) {
  const parties = recs.map((r) => r.partyId);
  const commandId = `${tag}-${Date.now()}`;   // see note in prepareSignExecute
  const prep = await jpost("/v2/interactive-submission/prepare", {
    userId: USER_ID, actAs: parties, commandId,
    synchronizerId: SYNC, packageIdSelectionPreference: [], commands,
    disclosedContracts: disclosed,
  });
  const signatures = recs.map((rec) => {
    const sig = signAs(rec, prep.preparedTransactionHash);
    return { party: rec.partyId, signatures: [{
      format: "SIGNATURE_FORMAT_RAW", signature: sig, signedBy: rec.fingerprint,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] };
  });
  const out = await jpost("/v2/interactive-submission/execute", {
    preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion,
    submissionId: `${tag}-${Date.now()}`, userId: USER_ID,
    deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures },
  });
  return Object.assign({}, out, { commandId, actAs: parties });
}

// ---------------------------------------------------------------------------
// SPLIT prepare / execute -- for signers whose key this server does NOT have.
//
// Interactive submission is prepare -> sign -> execute. The functions above do all
// three, which is only possible because we hold the demo parties' keys. A party
// bringing its OWN Canton wallet must keep the middle step private, so these expose
// the outer two and nothing else.
//
// prepareInteractive() confers no authority: a prepared transaction is inert until a
// signature is attached, and the ledger verifies that signature against the party's
// registered key. Holding a prepared transaction without the key is useless.
// ---------------------------------------------------------------------------
async function prepareInteractive(partyId, commands, tag = "wallet", disclosed = []) {
  const commandId = `${tag}-${Date.now()}`;
  const prep = await jpost("/v2/interactive-submission/prepare", {
    userId: USER_ID, actAs: [partyId], commandId,
    synchronizerId: SYNC, packageIdSelectionPreference: [], commands,
    disclosedContracts: disclosed,
  });
  return {
    commandId,
    party: partyId,
    preparedTransaction: prep.preparedTransaction,
    preparedTransactionHash: prep.preparedTransactionHash,
    hashingSchemeVersion: prep.hashingSchemeVersion,
  };
}

// Submit a transaction signed by someone else. The signature and fingerprint come
// from the wallet; this process never sees the private key that produced them.
async function executeSigned(o) {
  return jpost("/v2/interactive-submission/execute", {
    preparedTransaction: o.preparedTransaction,
    hashingSchemeVersion: o.hashingSchemeVersion,
    submissionId: o.submissionId || `${o.commandId || "wallet"}-${Date.now()}`,
    userId: USER_ID,
    deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: o.partyId, signatures: [{
      format: "SIGNATURE_FORMAT_RAW", signature: o.signature, signedBy: o.signedBy,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }] },
  });
}

// ---------------------------------------------------------------------------
// ONBOARD A PARTY FROM A PUBLIC KEY -- the server never sees the private half.
//
// onboardExternalParty() above generates the keypair for a VENUE party and files it
// in the keystore, which is why this process can sign as those parties at all. Even
// encrypted, that would be disqualifying for a real user: a venue that can sign for
// you can transact as you. So a user's wallet never takes that path.
//
// Onboarding is generate-topology -> sign multiHash -> allocate. Only the middle step
// needs the private key, so it is split out and left to the wallet. What gets stored
// here is deliberately only the partyId and fingerprint -- there is no field for a
// private key, so there is nothing to leak, and no way for this server to act as the
// party without a signature it was given.
// ---------------------------------------------------------------------------
const WALLET_STORE = path.join(__dirname, "ext-wallets.local.txt"); // gitignored by *.local.txt
function loadWallets() { try { return JSON.parse(fs.readFileSync(WALLET_STORE, "utf8")); } catch { return {}; } }
function saveWallets(s) {
  fs.writeFileSync(WALLET_STORE, JSON.stringify(s, null, 2), { mode: 0o600 });
  try { fs.chmodSync(WALLET_STORE, 0o600); } catch { /* non-posix */ }
}

// A party id is <hint>::<fingerprint of its namespace key>, and the fingerprint is
// computed by the participant from the key itself. So a claimed public key is PROVEN
// to belong to a party - never taken on the caller's word - by having the participant
// fingerprint it and checking the party id carries that fingerprint. Without this, a
// caller could record their own key against someone else's party, sign in as it, and
// read its quotes.
async function fingerprintOf(publicKeyB64) {
  const g = await jpost("/v2/parties/external/generate-topology", {
    partyHint: "keycheck", synchronizer: SYNC,
    publicKey: { format: "CRYPTO_KEY_FORMAT_RAW", keyData: publicKeyB64,
                 keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519" },
  });
  return g.publicKeyFingerprint;
}
const ownsParty = (fingerprint, partyId) =>
  !!fingerprint && String(partyId || "").endsWith("::" + fingerprint);

async function onboardWalletPrepare(publicKeyB64, partyHint) {
  if (!publicKeyB64) throw new Error("need the wallet's raw ed25519 public key (base64)");
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) throw new Error(`public key must be 32 raw ed25519 bytes, got ${raw.length}`);
  const publicKey = {
    format: "CRYPTO_KEY_FORMAT_RAW", keyData: publicKeyB64,
    keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519",
  };
  const g = await jpost("/v2/parties/external/generate-topology", {
    partyHint: partyHint || ("wallet-" + Date.now()), synchronizer: SYNC, publicKey,
  });
  // Backfill. Wallets onboarded before confirm recorded the key have publicKey null
  // and can never sign in. g.publicKeyFingerprint was computed by the participant
  // from THIS key, so a record with that fingerprint and that namespace is provably
  // this key's party. Only ever fills a missing key; never replaces one.
  const s = loadWallets();
  let filled = 0;
  for (const rec of Object.values(s)) {
    if (!rec.publicKey && rec.fingerprint === g.publicKeyFingerprint &&
        ownsParty(g.publicKeyFingerprint, rec.partyId)) {
      rec.publicKey = publicKeyB64; filled++;
    }
  }
  if (filled) {
    saveWallets(s);
    console.log("[wallet] recorded the missing public key for", g.publicKeyFingerprint);
  }
  return {
    partyId: g.partyId,
    fingerprint: g.publicKeyFingerprint,
    publicKey: publicKeyB64,                  // kept so the party can authenticate later
    multiHash: g.multiHash,                   // the wallet signs THIS
    topologyTransactions: g.topologyTransactions,
  };
}

async function onboardWalletConfirm(o) {
  // Verify the key BEFORE allocating, so a refusal leaves nothing half-done.
  if (!o.publicKey) {
    throw Object.assign(new Error(
      "need the wallet's public key - without it this party could never sign in"), { status: 400 });
  }
  if ((await fingerprintOf(o.publicKey)) !== o.fingerprint || !ownsParty(o.fingerprint, o.partyId)) {
    throw Object.assign(new Error("that public key does not belong to this party"), { status: 400 });
  }
  const prev = loadWallets()[o.partyId];
  if (prev && prev.publicKey && prev.publicKey !== o.publicKey) {
    throw Object.assign(new Error("this party is already onboarded with a different key"), { status: 409 });
  }
  await jpost("/v2/parties/external/allocate", {
    synchronizer: SYNC,
    onboardingTransactions: (o.topologyTransactions || []).map((t) => ({ transaction: t })),
    multiHashSignatures: [{
      format: "SIGNATURE_FORMAT_RAW", signature: o.multiHashSignature,
      signedBy: o.fingerprint, signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519",
    }],
  });
  // CanReadAs lets the UI display the party. CanActAs is what lets this process
  // SUBMIT a transaction the wallet has already signed: /v2/interactive-submission/
  // execute refuses with 403 for a party the submitting user cannot act as, no matter
  // who signed. Granting CanReadAs alone means every wallet user 403s on its first
  // trade.
  //
  // Granting CanActAs on an EXTERNAL party is not a custody concession, and it was
  // worth proving rather than assuming. Executing requires partySignatures verified
  // against the party's registered key; with CanActAs held and the key absent, both a
  // random signature and a valid signature from a different wallet's key are refused
  // with FAILED_TO_EXECUTE_TRANSACTION. Custody lives in the signature, not in
  // withholding the grant. (A LOCAL party is the opposite case -- there the
  // participant signs, so CanActAs really is control. External parties are why this
  // is safe.)
  try {
    await jpost(`/v2/users/${USER_ID}/rights`, {
      userId: USER_ID, rights: [
        { kind: { CanActAs: { value: { party: o.partyId } } } },
        { kind: { CanReadAs: { value: { party: o.partyId } } } },
      ],
    });
  } catch (e) { console.log("[wallet] rights grant skipped:", e.message); }

  const s = loadWallets();
  // The PUBLIC key is recorded so this party can later prove it is itself: it
  // signs a nonce and we check it against this. The fingerprint alone is a hash
  // and cannot verify anything. Still no private key field, and never one.
  s[o.partyId] = { partyId: o.partyId, fingerprint: o.fingerprint,
                   publicKey: o.publicKey,          // verified above, never null
                   onboardedAt: new Date().toISOString() };   // note: no private key field
  saveWallets(s);
  console.log("[wallet] onboarded", o.partyId, "(no private key held)");
  return s[o.partyId];
}

module.exports = { onboardExternalParty, prepareSignExecute, prepareSignExecuteMulti,
                   prepareInteractive, executeSigned,
                   onboardWalletPrepare, onboardWalletConfirm, loadWallets };
