// Onboard a Canton party whose private key this server has NEVER held, then transact
// as it. This is the step that turns "the venue coordinates, it never holds your
// authority" from a design claim into something demonstrable.
//
//   node wallet_onboard_demo.js                 generate key + prepare topology (NO ledger write)
//   node wallet_onboard_demo.js --execute       also allocate the party on-ledger
//   node wallet_onboard_demo.js --execute --rfq also create a SwapRfq as that party
//
// The keypair is generated HERE and the private half is written outside the backend
// directory, never sent anywhere. The server only ever receives:
//   - the raw public key (to build the topology transactions)
//   - a signature over the topology multiHash
//   - later, signatures over prepared transaction hashes
// Whether that is true is checkable, not just assertable: this script greps the
// server's own party store for the private key and reports what it finds.

require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const API = process.env.UMBRA_API || ("http://localhost:" + (process.env.PORT || 4000));
const PKGN = process.env.PACKAGE_NAME;
const KEYFILE = process.env.WALLET_KEY_FILE || path.join(os.homedir(), "umbra-wallet-key.local.json");
const SERVER_STORE = path.join(__dirname, "ext-parties.local.txt");
const WALLET_STORE = path.join(__dirname, "ext-wallets.local.txt");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const EXECUTE = has("--execute");

async function jfetch(p, body, method) {
  const r = await fetch(API + p, {
    method: method || "POST",
    headers: { "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body || {}),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { raw: t }; }
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${(j.error || j.raw || "").toString().slice(0, 300)}`);
  return j;
}

// Reuse a previously generated wallet key so re-runs don't orphan parties.
function loadOrCreateKey() {
  if (fs.existsSync(KEYFILE)) {
    const k = JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
    console.log("reusing wallet key from", KEYFILE);
    return k;
  }
  const kp = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const k = {
    publicKeyRaw: kp.publicKey.subarray(kp.publicKey.length - 32).toString("base64"),
    privDer: kp.privateKey.toString("base64"),
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  console.log("generated a NEW wallet key ->", KEYFILE, "(private half stays here)");
  return k;
}

const sign = (b64hash, privDer) => crypto.sign(
  null, Buffer.from(b64hash, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(privDer, "base64"), format: "der", type: "pkcs8" })
).toString("base64");

// The check that matters: is this key anywhere in the server's own stores?
//
// This used to be a substring search for the raw key. Once the venue keystore
// was encrypted that check started passing VACUOUSLY -- ciphertext never
// contains the plaintext, so it would have reported "the property holds" even
// if the key were sitting right there. A test that cannot fail is not evidence.
//
// So the keystore is now OPENED rather than grepped, and the substring search is
// kept only for the wallet registry, which is plaintext by design because it
// holds no keys at all.
function auditServerStore(k, partyId) {
  console.log("");
  console.log("=== CUSTODY AUDIT ===");

  try {
    const { getSigner } = require("./signer");
    const signer = getSigner();
    const roles = signer.roles();
    const ours = roles.filter((r) => {
      const rec = signer.recordFor(r);
      return rec && partyId && rec.partyId === partyId;
    });
    console.log("operator keystore   : backend=" + signer.kind +
      " roles=[" + roles.join(", ") + "] holdsOurParty=" + (ours.length > 0));
    if (ours.length) {
      console.log("  *** the venue holds a key for this party - the property does NOT hold ***");
    }
  } catch (e) {
    // No passphrase is the normal case when running this as an outsider. Say so
    // rather than printing a pass we did not earn.
    console.log("operator keystore   : could not open (" + String(e.message).split(String.fromCharCode(10))[0] + ")");
    console.log("  -> set UMBRA_KEYSTORE_PASSPHRASE to make this check meaningful");
    let raw = "";
    try { raw = fs.readFileSync(SERVER_STORE, "utf8"); } catch {}
    if (raw && raw.includes("privDer")) {
      console.log("  *** the keystore is UNENCRYPTED (privDer present on disk) ***");
    }
  }

  let txt = "";
  try { txt = fs.readFileSync(WALLET_STORE, "utf8"); }
  catch { console.log("wallet registry     : (absent)"); return; }
  const hasPriv = txt.includes(k.privDer) || txt.includes("privDer");
  const hasParty = partyId ? txt.includes(partyId) : false;
  console.log("wallet registry     : containsAnyPrivateKey=" + hasPriv +
    " mentionsOurParty=" + hasParty);
  if (hasPriv) console.log("  *** a wallet private key is on disk - the property does NOT hold ***");
}

(async () => {
  const k = loadOrCreateKey();
  console.log("public key  :", k.publicKeyRaw);

  const prep = await jfetch("/api/ext/onboard/prepare", {
    publicKey: k.publicKeyRaw, partyHint: "wallet-" + Date.now(),
  });
  console.log("partyId     :", prep.partyId);
  console.log("fingerprint :", String(prep.fingerprint).slice(0, 28) + "…");
  console.log("multiHash   :", String(prep.multiHash).slice(0, 32) + "…");
  console.log("PREPARE OK  - topology built from the public key alone.");

  if (!EXECUTE) {
    auditServerStore(k, null);
    console.log("\nstopping (no ledger write). Re-run with --execute to allocate the party.");
    return;
  }

  const confirmed = await jfetch("/api/ext/onboard/confirm", {
    partyId: prep.partyId,
    fingerprint: prep.fingerprint,
    topologyTransactions: prep.topologyTransactions,
    multiHashSignature: sign(prep.multiHash, k.privDer),
  });
  console.log("ONBOARDED   :", JSON.stringify(confirmed.party));

  // Record which party this key became. Without it a keyfile is anonymous, and every
  // downstream script has to guess -- which is fine with one wallet and wrong with three.
  k.partyId = prep.partyId;
  k.fingerprint = prep.fingerprint;
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });

  auditServerStore(k, prep.partyId);

  if (!has("--rfq")) {
    console.log("\nparty exists on-ledger. Add --rfq to have it transact.");
    return;
  }

  // Transact as a party the server cannot sign for. SwapRfq's only signatory is the
  // requester, so this party can create one alone -- and the server must ask us to sign.
  const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  const commands = [{
    CreateCommand: {
      templateId: `#${PKGN}:UmbraSwap:SwapRfq`,
      createArguments: {
        requester: prep.partyId, operator: prep.partyId,
        offerAsset: { admin: prep.partyId, symbol: "WALLETTEST" }, offerAmount: "1.0",
        wantAsset: { admin: prep.partyId, symbol: "WALLETTEST2" },
        invited: [], expiresAt,
      },
    },
  }];
  const tx = await jfetch("/api/ext/prepare", { party: prep.partyId, commands, tag: "walletrfq" });
  console.log("\nprepared    :", tx.commandId);
  const out = await jfetch("/api/ext/execute", {
    party: prep.partyId, commandId: tx.commandId,
    preparedTransaction: tx.preparedTransaction,
    hashingSchemeVersion: tx.hashingSchemeVersion,
    signature: sign(tx.preparedTransactionHash, k.privDer),
    signedBy: prep.fingerprint,
  });
  console.log("EXECUTE     :", JSON.stringify(out));
  console.log("\nA party whose key this server never had just committed a transaction.");
})().catch((e) => console.log("FAILED:", e.message));
