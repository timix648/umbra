// Where Umbra's own party keys live, and the only place a private key is ever
// in memory as a key rather than as ciphertext.
//
// THE PROBLEM THIS EXISTS TO SOLVE: ext-parties.local.txt held `privDer`, a raw
// PKCS8 ed25519 private key, base64, unencrypted, at mode 0644. Any process or
// user on the host could read the venue's signing authority out of a text file.
// Fine on a throwaway DevNet box; disqualifying the moment real money moves.
//
// THE SHAPE OF THE FIX: callers never receive a key. They ask this module to
// sign, and get a signature back. That single constraint is what makes a KMS
// backend droppable later without touching a single call site -- a remote
// signer can satisfy `sign(role, bytes)` and cannot satisfy "give me the key".
//
// BACKENDS -- UMBRA_KEYSTORE:
//   file       (default) AES-256-GCM at rest, key derived with scrypt from
//              UMBRA_KEYSTORE_PASSPHRASE. File written 0600.
//   env        keys from UMBRA_KEY_<ROLE> (base64 PKCS8). Nothing on disk, which
//              is what containers and CI want.
//   kms        not implemented. Throws with the interface a driver must meet.
//   plaintext  the old behaviour, kept as an EXPLICIT opt-out so LocalNet demos
//              do not break silently. Still forces 0600 and warns on every read.
//
// NOTE the deliberate asymmetry with BYOW. A bring-your-own-wallet user's key is
// never here at all -- ext-wallets.local.txt stores only partyId, fingerprint and
// a timestamp. This module is for the venue's OWN parties. Users were already
// safe; the venue was not.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE = process.env.UMBRA_KEYSTORE_FILE ||
  path.join(__dirname, "ext-parties.local.txt");
const MODE = (process.env.UMBRA_KEYSTORE || "file").toLowerCase();
const PASSPHRASE = process.env.UMBRA_KEYSTORE_PASSPHRASE || "";

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// crypto helpers
// ---------------------------------------------------------------------------

function deriveKey(salt) {
  if (!PASSPHRASE) {
    throw new Error(
      "UMBRA_KEYSTORE=file needs UMBRA_KEYSTORE_PASSPHRASE. Set it, or set " +
      "UMBRA_KEYSTORE=plaintext to keep the old unencrypted behaviour on a " +
      "throwaway network, or UMBRA_KEYSTORE=env to pass keys in as " +
      "UMBRA_KEY_<ROLE> without touching disk."
    );
  }
  return crypto.scryptSync(PASSPHRASE, salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
}

// The role and partyId are authenticated but not encrypted, so a ciphertext
// cannot be lifted from one record and pasted into another: decryption of a
// moved blob fails instead of silently signing for the wrong party.
function aad(role, partyId) {
  return Buffer.from(`${role}|${partyId || ""}`, "utf8");
}

function encryptKey(dk, role, partyId, privDerB64) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", dk, iv);
  c.setAAD(aad(role, partyId));
  const ct = Buffer.concat([c.update(Buffer.from(privDerB64, "base64")), c.final()]);
  return {
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function decryptKey(dk, role, partyId, box) {
  const d = crypto.createDecipheriv("aes-256-gcm", dk, Buffer.from(box.iv, "base64"));
  d.setAAD(aad(role, partyId));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.ct, "base64")), d.final()])
    .toString("base64");
}

// ---------------------------------------------------------------------------
// disk
// ---------------------------------------------------------------------------

function readRaw() {
  try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; }
}

// Always 0600. writeFileSync's mode argument only applies when it CREATES the
// file, so an existing 0644 file keeps its mode -- hence the explicit chmod.
// That is exactly how the old store stayed world-readable through every write.
function writeRaw(obj) {
  fs.writeFileSync(STORE, JSON.stringify(obj, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STORE, 0o600); } catch { /* windows / non-posix */ }
}

const isLegacy = (raw) =>
  raw && !raw.v && Object.values(raw).some(r => r && typeof r === "object" && r.privDer);

// ---------------------------------------------------------------------------
// the file backend
// ---------------------------------------------------------------------------

function fileBackend() {
  let raw = readRaw();
  let salt, dk;

  // One-way migration, run once, with the plaintext preserved beside it until
  // the operator deletes it. Losing a key to an over-eager migration would be a
  // worse outcome than the exposure being fixed.
  if (isLegacy(raw)) {
    salt = crypto.randomBytes(16);
    dk = deriveKey(salt);
    const backup = STORE + ".plaintext-backup";
    if (!fs.existsSync(backup)) {
      fs.writeFileSync(backup, JSON.stringify(raw, null, 2), { mode: 0o600 });
      try { fs.chmodSync(backup, 0o600); } catch {}
    }
    const records = {};
    for (const [role, r] of Object.entries(raw)) {
      if (!r || !r.privDer) continue;
      records[role] = {
        partyId: r.partyId, fingerprint: r.fingerprint,
        key: encryptKey(dk, role, r.partyId, r.privDer),
      };
    }
    raw = { v: FORMAT_VERSION, kdf: { name: "scrypt", salt: salt.toString("base64"), ...SCRYPT }, records };
    writeRaw(raw);
    console.log(`[keystore] migrated ${Object.keys(records).length} plaintext key(s) ` +
      `to AES-256-GCM. Plaintext preserved at ${path.basename(backup)} (0600) -- ` +
      `delete it once you have confirmed signing still works.`);
  } else if (raw.v) {
    salt = Buffer.from(raw.kdf.salt, "base64");
    dk = deriveKey(salt);
  } else {
    salt = crypto.randomBytes(16);
    dk = deriveKey(salt);
    raw = { v: FORMAT_VERSION, kdf: { name: "scrypt", salt: salt.toString("base64"), ...SCRYPT }, records: {} };
  }

  const privFor = (role) => {
    const r = raw.records[role];
    if (!r) return null;
    return decryptKey(dk, role, r.partyId, r.key);
  };

  return {
    kind: "file",
    roles: () => Object.keys(raw.records),
    // Public metadata only. No caller has a reason for more, and none gets it.
    recordFor: (role) => {
      const r = raw.records[role];
      return r ? { role, partyId: r.partyId, fingerprint: r.fingerprint } : null;
    },
    commit: (role, handle, meta) => {
      raw.records[role] = {
        partyId: meta.partyId, fingerprint: meta.fingerprint,
        key: encryptKey(dk, role, meta.partyId, handle._privDer),
      };
      writeRaw(raw);
      return { role, partyId: meta.partyId, fingerprint: meta.fingerprint };
    },
    sign: (role, bytesB64) => {
      const p = privFor(role);
      if (!p) throw new Error(`no key for role '${role}'`);
      return signWithDer(p, bytesB64);
    },
  };
}

// ---------------------------------------------------------------------------
// the env backend -- nothing on disk
// ---------------------------------------------------------------------------

function envBackend() {
  const envName = (role) => "UMBRA_KEY_" + String(role).toUpperCase().replace(/[^A-Z0-9]/g, "_");
  // Party metadata still has to come from somewhere; it is not secret, so the
  // store file is read for it when present and simply absent otherwise.
  const meta = (() => { const r = readRaw(); return r.records || r || {}; })();
  return {
    kind: "env",
    roles: () => Object.keys(process.env)
      .filter(k => k.startsWith("UMBRA_KEY_"))
      .map(k => k.slice("UMBRA_KEY_".length).toLowerCase()),
    recordFor: (role) => {
      const m = meta[role];
      return m ? { role, partyId: m.partyId, fingerprint: m.fingerprint } : null;
    },
    commit: () => {
      throw new Error(
        "UMBRA_KEYSTORE=env cannot onboard a new party: it has nowhere to put " +
        "the key. Onboard with UMBRA_KEYSTORE=file, then pass the key in as " +
        envName("<role>") + "."
      );
    },
    sign: (role, bytesB64) => {
      const der = process.env[envName(role)];
      if (!der) throw new Error(`no key for role '${role}' (set ${envName(role)})`);
      return signWithDer(der, bytesB64);
    },
  };
}

// ---------------------------------------------------------------------------
// the kms backend -- deliberately not implemented, but pinned down
// ---------------------------------------------------------------------------

function kmsBackend() {
  const unimplemented = () => {
    throw new Error(
      "UMBRA_KEYSTORE=kms is not implemented. A driver needs exactly three " +
      "things: sign(role, bytesB64) -> base64 ed25519 signature over the RAW " +
      "bytes (Canton signs the prepared-transaction hash directly, so the KMS " +
      "must NOT pre-hash); recordFor(role) -> { partyId, fingerprint }; and " +
      "roles(). Key generation can stay out of band -- Umbra only needs the " +
      "public key at onboarding time. AWS KMS supports ed25519 only via " +
      "external key stores, so Vault transit or GCP KMS is the shorter path."
    );
  };
  return { kind: "kms", roles: unimplemented, recordFor: unimplemented, commit: unimplemented, sign: unimplemented };
}

// ---------------------------------------------------------------------------
// the plaintext backend -- the old behaviour, but you have to ask for it
// ---------------------------------------------------------------------------

function plaintextBackend() {
  console.log("[keystore] WARNING: UMBRA_KEYSTORE=plaintext. Private keys are " +
    "stored unencrypted. Acceptable on LocalNet and DevNet, never with real value.");
  let raw = readRaw();
  if (raw.v) raw = {};   // an encrypted store cannot be read in plaintext mode
  return {
    kind: "plaintext",
    roles: () => Object.keys(raw),
    recordFor: (role) => {
      const r = raw[role];
      return r ? { role, partyId: r.partyId, fingerprint: r.fingerprint } : null;
    },
    commit: (role, handle, meta) => {
      raw[role] = { role, partyId: meta.partyId, fingerprint: meta.fingerprint, privDer: handle._privDer };
      writeRaw(raw);      // 0600 even here; there is no reason for 0644 ever
      return { role, partyId: meta.partyId, fingerprint: meta.fingerprint };
    },
    sign: (role, bytesB64) => {
      const r = raw[role];
      if (!r) throw new Error(`no key for role '${role}'`);
      return signWithDer(r.privDer, bytesB64);
    },
  };
}

// ---------------------------------------------------------------------------

// Canton signs the prepared-transaction hash directly: `null` as the algorithm
// is ed25519's pure mode, NOT a missing argument. Pre-hashing here would produce
// a signature the ledger rejects.
function signWithDer(privDerB64, bytesB64) {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privDerB64, "base64"), format: "der", type: "pkcs8",
  });
  return crypto.sign(null, Buffer.from(bytesB64, "base64"), key).toString("base64");
}

// ---------------------------------------------------------------------------
// the remote backend -- the keys live in signer-daemon.js, another OS user
// ---------------------------------------------------------------------------
// The app keeps no key and no passphrase. It sends the daemon the whole prepared
// transaction, which the daemon checks against its policy before signing. Public
// metadata (party id, fingerprint) comes from the file the daemon publishes.

function remoteBackend() {
  const net = require("net");
  const SOCK = process.env.UMBRA_SIGNER_SOCKET || "/run/umbra-signer/signer.sock";
  const RECORDS = process.env.UMBRA_SIGNER_RECORDS || path.join(path.dirname(SOCK), "records.json");
  const records = () => { try { return JSON.parse(fs.readFileSync(RECORDS, "utf8")); } catch { return {}; } };
  let seq = 0;
  const ask = (msg) => new Promise((resolve, reject) => {
    const id = ++seq;
    const c = net.createConnection(SOCK);
    let buf = "";
    const t = setTimeout(() => { c.destroy(); reject(new Error("the venue signer did not answer")); }, 15000);
    c.on("connect", () => c.write(JSON.stringify(Object.assign({ id }, msg)) + "\n"));
    c.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(t); c.end();
      let out; try { out = JSON.parse(buf.slice(0, i)); } catch (e) { return reject(new Error("bad answer from the venue signer")); }
      if (out.error) reject(new Error(out.error)); else resolve(out);
    });
    c.on("error", (e) => { clearTimeout(t); reject(new Error("the venue signer is unreachable: " + e.message)); });
  });
  const noKeys = () => { throw new Error("UMBRA_KEYSTORE=remote: venue keys are created in the signer, not the app"); };
  return {
    kind: "remote",
    roles: () => Object.keys(records()),
    recordFor: (role) => { const r = records()[role]; return r ? { role, partyId: r.partyId, fingerprint: r.fingerprint } : null; },
    commit: noKeys,
    // async: callers await it. `tx` is the prepared transaction the hash belongs to.
    sign: async (role, bytesB64, tx) => (await ask({ op: "sign", role, hash: bytesB64, tx })).signature,
  };
}

let cached = null;
function getSigner() {
  if (cached) return cached;
  const make = { file: fileBackend, env: envBackend, kms: kmsBackend, plaintext: plaintextBackend, remote: remoteBackend }[MODE];
  if (!make) throw new Error(`unknown UMBRA_KEYSTORE '${MODE}' (file|env|kms|plaintext|remote)`);
  cached = make();
  return cached;
}

// A keypair that has not been committed yet. Onboarding has to sign the topology
// transaction with a key the store has never seen -- the party id does not exist
// until that signature lands -- so the key lives in this handle for exactly that
// long, then goes into the store encrypted.
function newKey() {
  const kp = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const privDer = kp.privateKey.toString("base64");
  return {
    // raw 32 bytes, which is what Canton's CRYPTO_KEY_FORMAT_RAW wants
    publicKeyRaw: kp.publicKey.subarray(kp.publicKey.length - 32).toString("base64"),
    sign: (bytesB64) => signWithDer(privDer, bytesB64),
    _privDer: privDer,   // read only by commit(), never returned to a caller
  };
}

module.exports = { getSigner, newKey };
