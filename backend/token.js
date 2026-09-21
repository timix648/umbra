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
const GRANT = (process.env.AUTH_GRANT || "client_credentials").toLowerCase();

let cached = { token: null, expiresAt: 0, refreshToken: null, refreshExpiresAt: 0 };

function form(fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    // Keycloak rejects an empty audience outright, and an absent one is fine
    // on both providers, so only send what is actually set.
    if (v !== undefined && v !== null && v !== "") body.append(k, v);
  }
  return body;
}

function credentialsBody() {
  if (GRANT === "password") {
    return form({
      grant_type: "password",
      client_id: process.env.CLIENT_ID,
      client_secret: process.env.CLIENT_SECRET, // public clients omit this
      username: process.env.AUTH_USERNAME,
      password: process.env.AUTH_PASSWORD,
      scope: process.env.SCOPE,
      audience: process.env.AUDIENCE,
    });
  }
  return form({
    grant_type: "client_credentials",
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    audience: process.env.AUDIENCE,
    scope: process.env.SCOPE,
  });
}

async function post(body) {
  const res = await fetch(process.env.AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function store(data) {
  const now = Date.now();
  cached = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
    // Only the password grant hands back a refresh token; client_credentials
    // does not, and does not need one.
    refreshToken: data.refresh_token || null,
    refreshExpiresAt: data.refresh_expires_in
      ? now + data.refresh_expires_in * 1000
      : 0,
  };
  return cached.token;
}

async function getToken() {
  if (GRANT === "static") {
    const t = process.env.AUTH_STATIC_TOKEN;
    if (!t) throw new Error("AUTH_GRANT=static requires AUTH_STATIC_TOKEN");
    return t;
  }

  const now = Date.now();
  if (cached.token && now < cached.expiresAt - 60_000) {
    return cached.token;
  }

  // Access tokens last about three hours here. Spending the refresh token
  // rather than the password keeps the credentials off the wire on every
  // renewal, and keeps working if the account later gains MFA.
  if (cached.refreshToken && now < cached.refreshExpiresAt - 60_000) {
    try {
      const data = await post(
        form({
          grant_type: "refresh_token",
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.CLIENT_SECRET,
          refresh_token: cached.refreshToken,
        })
      );
      console.log(`[token] refreshed via refresh_token, expires in ${data.expires_in}s`);
      return store(data);
    } catch (e) {
      // A revoked or expired refresh token is normal, not an error worth
      // failing the request over -- fall through to a full re-auth.
      console.log(`[token] refresh_token rejected (${e.message}), re-authenticating`);
      cached = { token: null, expiresAt: 0, refreshToken: null, refreshExpiresAt: 0 };
    }
  }

  const data = await post(credentialsBody());
  console.log(`[token] ${GRANT} grant, expires in ${data.expires_in}s`);
  return store(data);
}

async function ledgerFetch(path, options = {}) {
  let token = await getToken();
  let res = await doFetch(path, options, token);
  if (res.status === 401) {
    console.log("[token] got 401, forcing refresh and retrying once");
    cached = { token: null, expiresAt: 0, refreshToken: null, refreshExpiresAt: 0 };
    token = await getToken();
    res = await doFetch(path, options, token);
  }
  return res;
}

function doFetch(path, options, token) {
  return fetch(`${process.env.LEDGER_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

module.exports = { getToken, ledgerFetch };
