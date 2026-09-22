// Proofs for the keystore. Self-contained: it builds its own fixture rather
// than reading ext-parties.local.txt, which is gitignored and absent in CI.
//
// The claim under test is narrow. A keystore that encrypts but quietly
// substitutes a different key would pass every obvious check -- the file looks
// encrypted, signing "works", and every signature verifies against the wrong
// party. So the central assertion here is not "it encrypts", it is that the
// signature after migration is BYTE-IDENTICAL to the one the plaintext path
// produced. Anything less does not prove the key survived.
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SIGNER = require.resolve("../signer.js");
const PASS = "a passphrase that is not the default";

// signer.js memoises its backend, which is right for a server and wrong for a
// test that exercises four of them.
function freshSigner(env) {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("UMBRA_KEY")) delete process.env[k];
  }
  Object.assign(process.env, env);
  delete require.cache[SIGNER];
  return require(SIGNER);
}

function legacyStore(roles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "umbra-keystore-"));
  const file = path.join(dir, "ext-parties.local.txt");
  const out = {};
  for (const role of roles) {
    const kp = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    out[role] = {
      role,
      partyId: `${role}-${Date.now()}::1220${crypto.randomBytes(8).toString("hex")}`,
      fingerprint: `1220${crypto.randomBytes(8).toString("hex")}`,
      privDer: kp.privateKey.toString("base64"),
    };
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { mode: 0o644 });
  return { dir, file, records: out };
}

// what the OLD code path produced, straight from privDer
const signLegacy = (privDer, msgB64) => crypto.sign(
  null, Buffer.from(msgB64, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(privDer, "base64"), format: "der", type: "pkcs8" }),
).toString("base64");

test("migration preserves the key: signatures are byte-identical", () => {
  const fx = legacyStore(["requester", "dealer1"]);
  const msg = crypto.randomBytes(32).toString("base64");
  const before = {};
  for (const [role, r] of Object.entries(fx.records)) before[role] = signLegacy(r.privDer, msg);

  const signer = freshSigner({
    UMBRA_KEYSTORE: "file",
    UMBRA_KEYSTORE_FILE: fx.file,
    UMBRA_KEYSTORE_PASSPHRASE: PASS,
  }).getSigner();

  for (const role of Object.keys(fx.records)) {
    assert.strictEqual(signer.sign(role, msg), before[role],
      `${role} signs differently after migration -- the key did not survive`);
  }
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("the private key is gone from disk, and the file is 0600", () => {
  const fx = legacyStore(["requester"]);
  freshSigner({
    UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: fx.file, UMBRA_KEYSTORE_PASSPHRASE: PASS,
  }).getSigner();

  const raw = fs.readFileSync(fx.file, "utf8");
  assert.ok(!raw.includes("privDer"), "plaintext key field still on disk");
  assert.ok(!raw.includes(fx.records.requester.privDer), "the key itself is still on disk");

  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.v, 1);
  assert.strictEqual(parsed.kdf.name, "scrypt");
  assert.ok(parsed.records.requester.key.iv && parsed.records.requester.key.tag);

  // mode is meaningless on win32, where chmod is a no-op
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(fx.file).mode & 0o777, 0o600,
      "keystore must not be group- or world-readable");
  }
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("the plaintext is preserved once, so a migration cannot lose a key", () => {
  const fx = legacyStore(["requester"]);
  freshSigner({
    UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: fx.file, UMBRA_KEYSTORE_PASSPHRASE: PASS,
  }).getSigner();

  const backup = fx.file + ".plaintext-backup";
  assert.ok(fs.existsSync(backup), "no backup written");
  assert.strictEqual(JSON.parse(fs.readFileSync(backup, "utf8")).requester.privDer,
    fx.records.requester.privDer);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("a key is bound to its role: a ciphertext moved between records is refused", () => {
  const fx = legacyStore(["requester", "dealer1"]);
  freshSigner({
    UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: fx.file, UMBRA_KEYSTORE_PASSPHRASE: PASS,
  }).getSigner();

  // paste dealer1's encrypted key into requester's record
  const store = JSON.parse(fs.readFileSync(fx.file, "utf8"));
  store.records.requester.key = store.records.dealer1.key;
  const swapped = path.join(fx.dir, "swapped.txt");
  fs.writeFileSync(swapped, JSON.stringify(store));

  const s2 = freshSigner({
    UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: swapped, UMBRA_KEYSTORE_PASSPHRASE: PASS,
  }).getSigner();
  // Without the role|partyId AAD this would decrypt happily and sign as the
  // WRONG party -- a failure that announces itself nowhere.
  assert.throws(() => s2.sign("requester", crypto.randomBytes(32).toString("base64")));
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("the wrong passphrase cannot open the store", () => {
  const fx = legacyStore(["requester"]);
  freshSigner({
    UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: fx.file, UMBRA_KEYSTORE_PASSPHRASE: PASS,
  }).getSigner();

  const s2 = freshSigner({
    UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: fx.file,
    UMBRA_KEYSTORE_PASSPHRASE: PASS + " (wrong)",
  }).getSigner();
  assert.throws(() => s2.sign("requester", crypto.randomBytes(32).toString("base64")));
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("callers cannot get a key back out", () => {
  const fx = legacyStore(["requester"]);
  const signer = freshSigner({
    UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: fx.file, UMBRA_KEYSTORE_PASSPHRASE: PASS,
  }).getSigner();

  const rec = signer.recordFor("requester");
  assert.deepStrictEqual(Object.keys(rec).sort(), ["fingerprint", "partyId", "role"]);
  assert.ok(!JSON.stringify(rec).includes(fx.records.requester.privDer));
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("file mode without a passphrase refuses to start, and says how to proceed", () => {
  const fx = legacyStore(["requester"]);
  const mod = freshSigner({ UMBRA_KEYSTORE: "file", UMBRA_KEYSTORE_FILE: fx.file });
  // Silently falling back to plaintext here is the failure mode this guards.
  assert.throws(() => mod.getSigner(), /UMBRA_KEYSTORE_PASSPHRASE/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("env backend signs from the environment with nothing on disk", () => {
  const fx = legacyStore(["requester"]);
  const msg = crypto.randomBytes(32).toString("base64");
  const expected = signLegacy(fx.records.requester.privDer, msg);

  const signer = freshSigner({
    UMBRA_KEYSTORE: "env",
    UMBRA_KEYSTORE_FILE: path.join(fx.dir, "does-not-exist.txt"),
    UMBRA_KEY_REQUESTER: fx.records.requester.privDer,
  }).getSigner();

  assert.strictEqual(signer.kind, "env");
  assert.strictEqual(signer.sign("requester", msg), expected);
  assert.throws(() => signer.sign("dealer1", msg), /UMBRA_KEY_DEALER1/);
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

test("kms backend is honest about being unimplemented", () => {
  const signer = freshSigner({ UMBRA_KEYSTORE: "kms" }).getSigner();
  // The message is the spec a driver has to meet, including the trap: Canton
  // signs the prepared hash directly, so a KMS that pre-hashes produces
  // signatures the ledger rejects.
  assert.throws(() => signer.sign("requester", "AAAA"), /not implemented/);
  assert.throws(() => signer.sign("requester", "AAAA"), /must NOT pre-hash/);
});

test("an unknown backend name is rejected rather than defaulted", () => {
  const mod = freshSigner({ UMBRA_KEYSTORE: "s3" });
  assert.throws(() => mod.getSigner(), /unknown UMBRA_KEYSTORE/);
});
