// Proofs that a caller cannot read a party's view without controlling that party.
//
// The defect these exist for: every party-scoped read took the party from the
// QUERY STRING, and the only global middleware was CORS with
// Access-Control-Allow-Origin: *. `?role=requester` returned the buyer's view --
// every dealer's price -- to anybody who could reach the port.
//
// The tests that matter are the negative ones. A check that accepts a valid
// signature proves very little; a check that rejects a signature from the wrong
// key, a replayed nonce, and a tampered token is the one worth having.
const { test } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

process.env.UMBRA_SESSION_SECRET = "test-secret-not-used-anywhere-real";
const auth = require("../auth.js");

// A party with a real ed25519 keypair, shaped like an onboarded wallet record.
function party(name) {
  const kp = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const raw = kp.publicKey.subarray(kp.publicKey.length - 32);
  return {
    partyId: `${name}-${Date.now()}::1220${crypto.randomBytes(8).toString("hex")}`,
    publicKey: raw.toString("base64"),
    sign: (msgB64) => crypto.sign(null, Buffer.from(msgB64, "base64"),
      crypto.createPrivateKey({ key: kp.privateKey, format: "der", type: "pkcs8" })
    ).toString("base64"),
  };
}

const store = (...ps) => Object.fromEntries(
  ps.map(p => [p.partyId, { partyId: p.partyId, publicKey: p.publicKey }]));

const bearer = (tok) => ({ headers: { authorization: `Bearer ${tok}` } });
const anon = () => ({ headers: {} });
const noDemoRoles = () => false;

test("a party that signs the nonce with its own key gets a session", () => {
  const p = party("alice");
  const { nonce } = auth.issueChallenge(p.partyId);
  const out = auth.verifyChallenge(
    { party: p.partyId, nonce, signature: p.sign(nonce) }, store(p));
  assert.strictEqual(out.party, p.partyId);
  assert.ok(out.token);
  assert.strictEqual(auth.callerParty(bearer(out.token)), p.partyId);
});

test("signing the readable message (what a wallet shows) also gets a session", () => {
  const p = party("alice");
  const { nonce, message } = auth.issueChallenge(p.partyId);
  assert.match(message, /^Sign in to Umbra/);
  assert.ok(message.includes(p.partyId), "the message names the party");
  assert.ok(/^[\x20-\x7e\n]*$/.test(message), "plain ASCII, so a wallet shows it as written");
  const sig = p.sign(Buffer.from(message, "utf8").toString("base64"));
  const out = auth.verifyChallenge({ party: p.partyId, nonce, signature: sig }, store(p));
  assert.strictEqual(out.party, p.partyId);
});

test("another party's readable message cannot be used to sign in", () => {
  const alice = party("alice"), mallory = party("mallory");
  const a = auth.issueChallenge(alice.partyId);
  const m = auth.issueChallenge(mallory.partyId);
  // mallory signs her OWN message and offers it against alice's challenge
  assert.throws(() => auth.verifyChallenge(
    { party: alice.partyId, nonce: a.nonce,
      signature: mallory.sign(Buffer.from(m.message, "utf8").toString("base64")) },
    store(alice, mallory)), /does not match/);
});

test("a signature from a DIFFERENT key is refused", () => {
  const alice = party("alice"), mallory = party("mallory");
  const { nonce } = auth.issueChallenge(alice.partyId);
  // mallory signs alice's challenge, hoping to be issued alice's session
  assert.throws(() => auth.verifyChallenge(
    { party: alice.partyId, nonce, signature: mallory.sign(nonce) },
    store(alice, mallory)), /does not match/);
});

test("random bytes as a signature are refused", () => {
  const p = party("alice");
  const { nonce } = auth.issueChallenge(p.partyId);
  assert.throws(() => auth.verifyChallenge(
    { party: p.partyId, nonce, signature: crypto.randomBytes(64).toString("base64") },
    store(p)), /does not match/);
});

test("a nonce cannot be replayed", () => {
  const p = party("alice");
  const { nonce } = auth.issueChallenge(p.partyId);
  const sig = p.sign(nonce);
  auth.verifyChallenge({ party: p.partyId, nonce, signature: sig }, store(p));
  // the same signed nonce a second time: the challenge was consumed
  assert.throws(() => auth.verifyChallenge(
    { party: p.partyId, nonce, signature: sig }, store(p)), /no live challenge/);
});

test("signing a nonce that was never issued is refused", () => {
  const p = party("alice");
  const invented = crypto.randomBytes(32).toString("base64");
  assert.throws(() => auth.verifyChallenge(
    { party: p.partyId, nonce: invented, signature: p.sign(invented) }, store(p)),
    /no live challenge/);
});

test("a party with no recorded public key cannot authenticate", () => {
  const p = party("legacy");
  const { nonce } = auth.issueChallenge(p.partyId);
  // onboarded before public keys were stored
  const legacyStore = { [p.partyId]: { partyId: p.partyId } };
  assert.throws(() => auth.verifyChallenge(
    { party: p.partyId, nonce, signature: p.sign(nonce) }, legacyStore),
    /no recorded public key/);
});

test("a tampered token is refused", () => {
  const alice = party("alice"), mallory = party("mallory");
  const { nonce } = auth.issueChallenge(alice.partyId);
  const { token } = auth.verifyChallenge(
    { party: alice.partyId, nonce, signature: alice.sign(nonce) }, store(alice));

  // swap the payload for one naming mallory, keep alice's signature
  const [, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ party: mallory.partyId, exp: Date.now() + 1e6 }))
    .toString("base64url") + "." + mac;
  assert.strictEqual(auth.callerParty(bearer(forged)), null);

  // and a token with a plausible but wrong mac
  const [payload] = token.split(".");
  const badMac = payload + "." + crypto.randomBytes(32).toString("base64url");
  assert.strictEqual(auth.callerParty(bearer(badMac)), null);
});

test("an expired session is refused", () => {
  process.env.UMBRA_SESSION_TTL_MS = "1";
  delete require.cache[require.resolve("../auth.js")];
  const shortLived = require("../auth.js");
  const p = party("alice");
  const { nonce } = shortLived.issueChallenge(p.partyId);
  const { token } = shortLived.verifyChallenge(
    { party: p.partyId, nonce, signature: p.sign(nonce) }, store(p));
  const until = Date.now() + 5;
  while (Date.now() < until) { /* let it lapse */ }
  assert.strictEqual(shortLived.callerParty(bearer(token)), null);
  delete process.env.UMBRA_SESSION_TTL_MS;
  delete require.cache[require.resolve("../auth.js")];
});

// --- the hole itself ---------------------------------------------------------

test("THE DEFECT: an anonymous caller cannot name a party and read its view", () => {
  const victim = party("requester");
  assert.throws(() => auth.resolveReadParty(anon(), victim.partyId, noDemoRoles),
    /party-scoped/);
  // nor by naming a venue role while demo roles are off
  assert.throws(() => auth.resolveReadParty(anon(), "requester", noDemoRoles),
    /party-scoped/);
  // nor by asking for nothing at all and getting a default
  assert.throws(() => auth.resolveReadParty(anon(), "", noDemoRoles), /party-scoped/);
});

test("an authenticated caller reads its OWN view, named or not", () => {
  const p = party("dealerA");
  const { nonce } = auth.issueChallenge(p.partyId);
  const { token } = auth.verifyChallenge(
    { party: p.partyId, nonce, signature: p.sign(nonce) }, store(p));
  assert.strictEqual(auth.resolveReadParty(bearer(token), "", noDemoRoles), p.partyId);
  assert.strictEqual(auth.resolveReadParty(bearer(token), p.partyId, noDemoRoles), p.partyId);
});

test("authentication is not authorization: a dealer cannot read a rival's view", () => {
  const a = party("dealerA"), b = party("dealerB");
  const { nonce } = auth.issueChallenge(a.partyId);
  const { token } = auth.verifyChallenge(
    { party: a.partyId, nonce, signature: a.sign(nonce) }, store(a, b));
  // dealerA is genuinely authenticated, and still may not ask for dealerB
  assert.throws(() => auth.resolveReadParty(bearer(token), b.partyId, noDemoRoles),
    /may only read its own view/);
});

// --- operator actions ----------------------------------------------------------

test("listing assets needs the operator token - a wallet session is not enough", () => {
  process.env.UMBRA_OPERATOR_TOKEN = "op-secret-for-tests-only";
  delete require.cache[require.resolve("../auth.js")];
  const a = require("../auth.js");
  const req = (h) => ({ headers: h });
  assert.strictEqual(a.isOperator(req({})), false);
  assert.strictEqual(a.isOperator(req({ "x-umbra-operator": "wrong" })), false);
  // same length, one character off
  assert.strictEqual(a.isOperator(req({ "x-umbra-operator": "op-secret-for-tests-onlX" })), false);
  // the right secret in the WRONG header is not an operator
  assert.strictEqual(a.isOperator(req({ authorization: "Bearer op-secret-for-tests-only" })), false);
  assert.strictEqual(a.isOperator(req({ "x-umbra-operator": "op-secret-for-tests-only" })), true);
  delete process.env.UMBRA_OPERATOR_TOKEN;
  delete require.cache[require.resolve("../auth.js")];
});

test("with no operator token configured, operator actions are OFF - even for an empty header", () => {
  delete process.env.UMBRA_OPERATOR_TOKEN;
  delete require.cache[require.resolve("../auth.js")];
  const a = require("../auth.js");
  assert.strictEqual(a.isOperator({ headers: { "x-umbra-operator": "" } }), false);
  assert.strictEqual(a.isOperator({ headers: {} }), false);
  delete require.cache[require.resolve("../auth.js")];
});
