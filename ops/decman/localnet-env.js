// Write backend/.env.localnet for the DecMan LocalNet sandbox: Umbra's server on
// port 4000, both sandbox nodes in LEDGER_NODES, both DecMans in DECMAN_HOSTS.
//
//   node ops/decman/localnet-env.js            -> backend/.env.localnet
//   cp backend/.env.localnet backend/.env
//
// Reads the participant ids and the synchronizer from the running sandbox, and mints
// ledger tokens with the sandbox's PUBLIC dev secret ("unsafe"). Sandbox only.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const USER = "ledger-api-user";
const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b({ alg: "HS256", typ: "JWT" });
const p = b({ aud: "https://canton.network.global", sub: USER, iat: Math.floor(Date.now() / 1000) });
const TOKEN = h + "." + p + "." + crypto.createHmac("sha256", "unsafe").update(h + "." + p).digest("base64url");

const get = async (url, auth) => {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + auth } });
  if (!r.ok) throw new Error(url + " " + r.status + " -- is the sandbox up (./hackathon/up.sh)?");
  return r.json();
};
const pid = async (dm) => (await get(dm + "/participants-status", "sandbox")).statuses.find((x) => x.status === "CurrentNode").id;

(async () => {
  const sync = (await get("http://127.0.0.1:3975/v2/state/connected-synchronizers", TOKEN)).connectedSynchronizers[0].synchronizerId;
  const [a, bb] = await Promise.all([pid("http://127.0.0.1:8081"), pid("http://127.0.0.1:8082")]);
  const nodes = [
    { name: "A", url: "http://127.0.0.1:3975", grant: "static", token: TOKEN, userId: USER },
    { name: "B", url: "http://127.0.0.1:2975", grant: "static", token: TOKEN, userId: USER },
  ];
  const hosts = [
    { name: "A", url: "http://127.0.0.1:8081", apiKey: "sandbox", participantId: a },
    { name: "B", url: "http://127.0.0.1:8082", apiKey: "sandbox", participantId: bb },
  ];
  const env = [
    "# DecMan LocalNet sandbox -- written by ops/decman/localnet-env.js. Sandbox only.",
    "PORT=4000",
    "PACKAGE_NAME=umbra-v9",
    "SYNCHRONIZER_ID=" + sync,
    "LEDGER_API=http://127.0.0.1:3975",
    "AUTH_GRANT=static",
    "AUTH_STATIC_TOKEN=" + TOKEN,
    "LEDGER_USER_ID=" + USER,
    "LEDGER_NODES=" + JSON.stringify(nodes),
    "DECMAN_HOSTS=" + JSON.stringify(hosts),
    "UMBRA_KEYSTORE=plaintext",
    "UMBRA_SESSION_SECRET=" + crypto.randomBytes(24).toString("hex"),
    "UMBRA_OPERATOR_TOKEN=" + crypto.randomBytes(16).toString("hex"),
    "UMBRA_FAUCET_POW_KEY=" + crypto.randomBytes(16).toString("hex"),
    "",
  ].join("\n");
  const out = path.join(__dirname, "../../backend/.env.localnet");
  fs.writeFileSync(out, env, { mode: 0o600 });
  console.log("wrote", out, "\n  node A", a, "\n  node B", bb);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
