// Who is asking?
//
// THE HOLE THIS CLOSES: every party-scoped read took the party from the QUERY
// STRING. `GET /api/swap/quotes?role=requester` returned the buyer's view --
// every dealer's price -- to anyone who could reach the port, because the
// backend holds CanReadAs on all of them and was happy to read as whichever
// party it was told. The only global middleware was CORS, with
// Access-Control-Allow-Origin: *, so any web page could make that call from a
// visitor's browser.
//
// The ledger guarantee was never broken: a dealer's participant genuinely cannot
// see a rival's quote. The BACKEND gave it away. "dealer1 sees one quote,
// requester sees two" demonstrates filtering, not access control.
//
// HOW A CALLER PROVES WHO IT IS: it signs a nonce with the same ed25519 key the
// party was onboarded with. That key is the party's identity on Canton, so
// nothing weaker is worth having -- and the wallet can already sign, since
// signing is how it trades. No password, no shared secret, nothing to leak.
//
//   POST /api/auth/challenge { party }            -> { nonce }
//   POST /api/auth/verify    { party, nonce, signature } -> { token }
//   ... then: Authorization: Bearer <token>
//
// THE RULE THE REST OF THE SERVER MUST FOLLOW: the party comes from the TOKEN,
// never from the request. A handler that still reads `?role=` for identity has
// reopened the hole.
const crypto = require("crypto");

const TTL_MS = Number(process.env.UMBRA_SESSION_TTL_MS || 30 * 60 * 1000);
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

// Venue-owned demo parties (requester/dealer1/dealer2) are signed for by this
// server, so a caller cannot prove control of them -- there is nothing to prove.
// They exist to make the sample-data walkthrough work. OFF unless explicitly
// enabled, because enabling it means anyone who can reach the port can read
// those parties' views.
const DEMO_ROLES = process.env.UMBRA_DEMO_ROLES === "1";

// Sessions do not survive a restart unless this is set. That is a deliberate
// nuisance: an ephemeral secret is safe, and a silently persistent default
// would not be.
const SECRET = process.env.UMBRA_SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.UMBRA_SESSION_SECRET) {
  console.log("[auth] UMBRA_SESSION_SECRET not set - generated an ephemeral one, " +
    "so sessions end at restart.");
}
if (DEMO_ROLES) {
  console.log("[auth] UMBRA_DEMO_ROLES=1 - the venue's own demo parties " +
    "(requester/dealer1/dealer2) are readable WITHOUT authentication. Never set " +
    "this on a deployment carrying real order flow.");
}

// party -> { nonce, expiresAt }. In memory on purpose: a challenge outliving a
// restart buys nothing and a nonce that can be replayed is not a nonce.
const challenges = new Map();

function issueChallenge(party) {
  if (!party || !String(party).includes("::")) {
    throw Object.assign(new Error("need a full party id"), { status: 400 });
  }
  const nonce = crypto.randomBytes(32).toString("base64");
  challenges.set(party, { nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return { nonce, expiresInMs: CHALLENGE_TTL_MS };
}

// The party's public key, as recorded when it was onboarded. A party we have no
// key for cannot authenticate -- which is correct: we cannot check anything.
function publicKeyFor(party, wallets) {
  const rec = (wallets || {})[party];
  if (!rec) return null;
  return rec.publicKey || null;
}

// raw 32-byte ed25519 -> the SPKI DER form node's verifier wants.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function verifyRawEd25519(publicKeyB64, messageB64, signatureB64) {
  const raw = Buffer.from(publicKeyB64, "base64");
  if (raw.length !== 32) return false;
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: "der", type: "spki",
  });
  try {
    return crypto.verify(null, Buffer.from(messageB64, "base64"), key,
      Buffer.from(signatureB64, "base64"));
  } catch { return false; }
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", SECRET).update(payloadB64).digest("base64url");
}

function mintToken(party) {
  const payload = Buffer.from(JSON.stringify({ party, exp: Date.now() + TTL_MS }))
    .toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payload, mac] = token.split(".", 2);
  const expected = sign(payload);
  // timingSafeEqual throws on length mismatch, which is itself a signal, so
  // compare lengths first and keep the comparison constant-time after that.
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  let body;
  try { body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return null; }
  if (!body || !body.party || !body.exp || Date.now() > body.exp) return null;
  return body;
}

// Exchange a signed nonce for a session. `wallets` is the onboarded-wallet store.
function verifyChallenge({ party, nonce, signature }, wallets) {
  const c = challenges.get(party);
  if (!c || c.nonce !== nonce || Date.now() > c.expiresAt) {
    throw Object.assign(new Error("no live challenge for that party - request one first"),
      { status: 401 });
  }
  const pk = publicKeyFor(party, wallets);
  if (!pk) {
    throw Object.assign(new Error(
      "this party has no recorded public key, so its signature cannot be checked. " +
      "Parties onboarded before public keys were stored must re-onboard."),
      { status: 401 });
  }
  if (!verifyRawEd25519(pk, nonce, signature)) {
    throw Object.assign(new Error("signature does not match this party's key"),
      { status: 401 });
  }
  // One challenge, one session.
  challenges.delete(party);
  return { token: mintToken(party), party, expiresInMs: TTL_MS };
}

// The party this request has PROVEN it controls, or null.
function callerParty(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  const body = readToken(m[1].trim());
  return body ? body.party : null;
}

// Resolve the party a party-scoped handler should read as.
//
// `requested` is whatever the caller asked for. It is honoured ONLY when the
// caller has proven it controls that party, or when it names a venue demo role
// and demo roles are enabled. Otherwise the caller gets its own party, and an
// unauthenticated caller gets a 401 rather than somebody else's data.
function resolveReadParty(req, requested, isDemoRole) {
  const proven = callerParty(req);
  const asked = (requested || "").trim();

  if (proven) {
    // A caller may always read as itself. Asking for a different party is
    // refused even when authenticated -- authentication is not authorization.
    if (!asked || asked === proven) return proven;
    if (isDemoRole(asked) && DEMO_ROLES) return asked;
    throw Object.assign(new Error(
      "authenticated as a different party; a session may only read its own view"),
      { status: 403 });
  }

  if (asked && isDemoRole(asked) && DEMO_ROLES) return asked;

  throw Object.assign(new Error(
    "this view is party-scoped. Authenticate first: POST /api/auth/challenge " +
    "then /api/auth/verify, and send Authorization: Bearer <token>."),
    { status: 401 });
}

// Operator actions (listing an asset on the venue's menu) are not a wallet's to take,
// however well it has authenticated. They need a secret only someone with shell access
// to the box holds, sent as X-Umbra-Operator. Unset means operator actions are OFF.
const OPERATOR_TOKEN = process.env.UMBRA_OPERATOR_TOKEN || "";
function isOperator(req) {
  const got = String((req.headers && req.headers["x-umbra-operator"]) || "");
  if (!OPERATOR_TOKEN || got.length !== OPERATOR_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(OPERATOR_TOKEN));
}

module.exports = {
  issueChallenge, verifyChallenge, callerParty, resolveReadParty,
  verifyRawEd25519, isOperator, DEMO_ROLES,
};
