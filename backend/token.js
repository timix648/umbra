const fetch = require("node-fetch");
require("dotenv").config();

// Two ledgers, two kinds of OIDC client.
//
// Five North's sandbox gave us a confidential client, so a client_credentials
// service account worked. The NODERS hackathon node does not: both of its
// clients are public, and Keycloak answers client_credentials there with
// "Public client not allowed to retrieve service account". A public client
// can still issue tokens through the password grant, so that is what we use
// against NODERS.
//
// LocalNet is a third case again: it issues no tokens at all. canton-devkit
// ships one pre-signed JWT with no `exp`, signed with its hardcoded dev secret,
// and every request carries it unchanged. AUTH_GRANT=static takes that token
// straight from AUTH_STATIC_TOKEN and never contacts an auth server.
//
// AUTH_GRANT selects between them and defaults to client_credentials, so a
// deployment that says nothing behaves exactly as it did before.

// ---- SEVERAL NODES ------------------------------------------------------------
//
// A party hosted on more than one participant can be served by any of them, so
// the venue should not stop when one participant does. LEDGER_NODES lists them in
// order of preference, each with its own URL, credentials and ledger user (a user
// id is per participant):
//
//   LEDGER_NODES='[{"name":"umbra","url":"http://127.0.0.1:7575","grant":"static",
//                   "token":"...","userId":"6"},
//                  {"name":"bitsafe","url":"https://...","grant":"client_credentials",
//                   "authUrl":"...","clientId":"...","clientSecret":"...","userId":"..."}]'
//
// Unset, there is one node built from the old single-ledger variables, so an
// existing deployment behaves exactly as before.
//
// A health probe keeps the first healthy node active. A request that cannot reach
// its node is retried on the next one only when repeating it is harmless: reads,
// and prepare (which commits nothing). A submission is never replayed on another
// node -- it may have landed -- so it fails and the caller asks again, and the new
// attempt goes to whichever node is active by then.
//
// Offsets are per participant: an offset read from one node means nothing to
// another, so code that captured one across a switch simply starts over.

function envNode() {
  return {
    name: process.env.LEDGER_NAME || "primary",
    url: process.env.LEDGER_API,
    grant: (process.env.AUTH_GRANT || "client_credentials").toLowerCase(),
    token: process.env.AUTH_STATIC_TOKEN,
    authUrl: process.env.AUTH_URL,
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    username: process.env.AUTH_USERNAME,
    password: process.env.AUTH_PASSWORD,
    audience: process.env.AUDIENCE,
    scope: process.env.SCOPE,
    userId: process.env.LEDGER_USER_ID || "6",
  };
}

function loadNodes() {
  if (process.env.LEDGER_NODES) {
    try {
      const list = JSON.parse(process.env.LEDGER_NODES);
      if (Array.isArray(list) && list.length) {
        return list.map((n, i) => Object.assign({ name: "node" + (i + 1), grant: "client_credentials", userId: "6" }, n,
          { grant: String(n.grant || "client_credentials").toLowerCase() }));
      }
    } catch (e) {
      console.error("[nodes] LEDGER_NODES is not valid JSON, using LEDGER_API alone:", e.message);
    }
  }
  return [envNode()];
}

const NODES = loadNodes().map((n) => Object.assign(n, {
  cache: { token: null, expiresAt: 0, refreshToken: null, refreshExpiresAt: 0 },
  healthy: true, fails: 0, lastError: null, since: Date.now(),
}));
let activeIdx = 0;

function form(fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    // Keycloak rejects an empty audience outright, and an absent one is fine
    // on both providers, so only send what is actually set.
    if (v !== undefined && v !== null && v !== "") body.append(k, v);
  }
  return body;
}

function credentialsBody(n) {
  if (n.grant === "password") {
    return form({
      grant_type: "password",
      client_id: n.clientId,
      client_secret: n.clientSecret, // public clients omit this
      username: n.username,
      password: n.password,
      scope: n.scope,
      audience: n.audience,
    });
  }
  return form({
    grant_type: "client_credentials",
    client_id: n.clientId,
    client_secret: n.clientSecret,
    audience: n.audience,
    scope: n.scope,
  });
}

async function post(n, body) {
  const res = await fetch(n.authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function store(n, data) {
  const now = Date.now();
  n.cache = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
    // Only the password grant hands back a refresh token; client_credentials
    // does not, and does not need one.
    refreshToken: data.refresh_token || null,
    refreshExpiresAt: data.refresh_expires_in
      ? now + data.refresh_expires_in * 1000
      : 0,
  };
  return n.cache.token;
}

async function tokenFor(n) {
  if (n.grant === "static") {
    if (!n.token) throw new Error(`node ${n.name}: grant static requires a token`);
    return n.token;
  }

  const now = Date.now();
  if (n.cache.token && now < n.cache.expiresAt - 60_000) {
    return n.cache.token;
  }

  // Access tokens last about three hours here. Spending the refresh token
  // rather than the password keeps the credentials off the wire on every
  // renewal, and keeps working if the account later gains MFA.
  if (n.cache.refreshToken && now < n.cache.refreshExpiresAt - 60_000) {
    try {
      const data = await post(n, form({
        grant_type: "refresh_token",
        client_id: n.clientId,
        client_secret: n.clientSecret,
        refresh_token: n.cache.refreshToken,
      }));
      console.log(`[token] ${n.name}: refreshed via refresh_token, expires in ${data.expires_in}s`);
      return store(n, data);
    } catch (e) {
      // A revoked or expired refresh token is normal, not an error worth
      // failing the request over -- fall through to a full re-auth.
      console.log(`[token] ${n.name}: refresh_token rejected (${e.message}), re-authenticating`);
      n.cache = { token: null, expiresAt: 0, refreshToken: null, refreshExpiresAt: 0 };
    }
  }

  const data = await post(n, credentialsBody(n));
  console.log(`[token] ${n.name}: ${n.grant} grant, expires in ${data.expires_in}s`);
  return store(n, data);
}

// ---- which node ----------------------------------------------------------------

function active() { return NODES[activeIdx]; }

function pickActive() {
  const i = NODES.findIndex((n) => n.healthy);
  const next = i >= 0 ? i : activeIdx;          // none healthy: keep trying the current one
  if (next !== activeIdx) {
    console.log(`[nodes] switching ledger node: ${NODES[activeIdx].name} -> ${NODES[next].name}`);
    activeIdx = next;
  }
  return NODES[activeIdx];
}

function markDown(n, err) {
  n.fails += 1;
  n.lastError = String((err && err.message) || err || "unreachable").slice(0, 200);
  // Two misses before a node is written off: one dropped probe is not an outage.
  if (n.healthy && n.fails >= 2) {
    n.healthy = false; n.since = Date.now();
    console.error(`[nodes] ${n.name} is DOWN: ${n.lastError}`);
    pickActive();
  }
}

function markUp(n) {
  n.fails = 0; n.lastError = null;
  if (!n.healthy) {
    n.healthy = true; n.since = Date.now();
    console.log(`[nodes] ${n.name} is back`);
    pickActive();                                 // back to the preferred node
  }
}

async function probe(n) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 4000);
  try {
    // Up means connected to a synchronizer, not merely answering: a participant cut off
    // from the network still serves reads, but nothing submitted through it commits.
    const res = await doFetch(n, "/v2/state/connected-synchronizers", { signal: ctl.signal }, await tokenFor(n));
    if (!res.ok) { markDown(n, new Error("connected-synchronizers " + res.status)); return; }
    const j = await res.json().catch(() => ({}));
    if ((j.connectedSynchronizers || []).length) markUp(n);
    else markDown(n, new Error("not connected to any synchronizer"));
  } catch (e) {
    markDown(n, e);
  } finally { clearTimeout(t); }
}

// Probe every node on a timer. With one node this is only a status report.
const PROBE_MS = Number(process.env.LEDGER_PROBE_MS || 5000);
const probeTimer = setInterval(() => { NODES.forEach((n) => { probe(n).catch(() => {}); }); }, PROBE_MS);
if (probeTimer.unref) probeTimer.unref();

// Safe to repeat on another node: nothing here can have changed the ledger.
function retryable(path, options) {
  const m = String((options && options.method) || "GET").toUpperCase();
  if (m === "GET") return true;
  return /^\/v2\/(state\/|updates|events\/|commands\/completions|interactive-submission\/prepare|parties\/external\/generate-topology)/.test(path);
}

async function ledgerFetchOn(n, path, options) {
  let token = await tokenFor(n);
  let res = await doFetch(n, path, options, token);
  if (res.status === 401 && n.grant !== "static") {
    console.log(`[token] ${n.name}: got 401, forcing refresh and retrying once`);
    n.cache = { token: null, expiresAt: 0, refreshToken: null, refreshExpiresAt: 0 };
    token = await tokenFor(n);
    res = await doFetch(n, path, options, token);
  }
  return res;
}

async function ledgerFetch(path, options = {}) {
  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < NODES.length; attempt++) {
    const n = pickActive();
    if (tried.has(n)) break;
    tried.add(n);
    try {
      const res = await ledgerFetchOn(n, path, options);
      // A participant shutting down or not yet connected answers 503.
      if (res.status === 503 && NODES.length > 1 && retryable(path, options)) {
        markDown(n, new Error("503 on " + path)); markDown(n, new Error("503 on " + path));
        lastErr = new Error(`${n.name} answered 503`);
        continue;
      }
      return res;
    } catch (e) {
      // Could not reach the node at all: it is down now, not after two probes.
      markDown(n, e); markDown(n, e);
      lastErr = e;
      if (!retryable(path, options)) throw e;
    }
  }
  throw lastErr || new Error("no ledger node reachable");
}

function doFetch(n, path, options, token) {
  return fetch(`${n.url}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

// Run one call on EVERY node -- for things each participant keeps for itself, like a
// ledger user's rights. Never throws; reports per node.
async function ledgerFetchEach(pathFor, options) {
  return Promise.all(NODES.map(async (n) => {
    try {
      const p = typeof pathFor === "function" ? pathFor(n) : pathFor;
      const body = typeof options.body === "function" ? options.body(n) : options.body;
      const res = await ledgerFetchOn(n, p, Object.assign({}, options, { body }));
      return { node: n.name, ok: res.ok, status: res.status, text: res.ok ? "" : (await res.text()).slice(0, 200) };
    } catch (e) { return { node: n.name, ok: false, status: 0, text: e.message }; }
  }));
}

// The active node's token and ledger user -- both are per participant.
async function getToken() { return tokenFor(pickActive()); }
function userId() { return pickActive().userId; }

// For health and metrics: every node, without its secrets.
function nodesStatus() {
  return NODES.map((n, i) => ({ name: n.name, active: i === activeIdx, healthy: n.healthy,
    since: new Date(n.since).toISOString(), lastError: n.lastError }));
}

module.exports = { getToken, ledgerFetch, ledgerFetchEach, userId, nodesStatus };
