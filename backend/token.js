const fetch = require("node-fetch");
require("dotenv").config();

let cached = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (cached.token && now < cached.expiresAt - 60_000) {
    return cached.token;
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    audience: process.env.AUDIENCE,
    scope: process.env.SCOPE,
  });
  const res = await fetch(process.env.AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cached = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  console.log(`[token] refreshed, expires in ${data.expires_in}s`);
  return cached.token;
}

async function ledgerFetch(path, options = {}) {
  let token = await getToken();
  let res = await doFetch(path, options, token);
  if (res.status === 401) {
    console.log("[token] got 401, forcing refresh and retrying once");
    cached = { token: null, expiresAt: 0 };
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
