// The same thing through UMBRA's server, driven the way the page and a wallet drive it.
//
//   legacy   onboard a wallet the way Umbra did before (one node). Run this while the
//            server has NO DECMAN_HOSTS set.
//   new      onboard a wallet onto every configured node (server has DECMAN_HOSTS).
//   backup   the legacy wallet presses "Add backup node": one signature, contracts copied.
//   venue    the operator puts the venue's own party on every node (UMBRA_OPERATOR_TOKEN).
//   trade    the legacy wallet transacts through Umbra (try it with a node down).
//
// Every topology is checked with the page's own verifier (backend/public/tx-verify.js)
// before the wallet signs it, and the backup step also offers a forged signature first,
// which the server must refuse.
//
//   UMBRA_URL=http://127.0.0.1:4000 node ops/decman/umbra-flow.js new
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const BACKEND = path.join(__dirname, "../../backend");
const CT = require(path.join(BACKEND, "node_modules/@canton-network/core-tx-visualizer"));
const V = require(path.join(BACKEND, "public/tx-verify.js"));
const U = process.env.UMBRA_URL || "http://127.0.0.1:4000";
const STATE = process.env.DEMO_STATE || path.join(__dirname, ".umbra-flow-state.json");
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));

async function call(method, p, body, headers) {
  const r = await fetch(U + p, { method, headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(p.split("?")[0] + " " + r.status + " " + (j.error || JSON.stringify(j).slice(0, 200)));
  return j;
}
function newKey() {
  const kp = crypto.generateKeyPairSync("ed25519");
  const raw = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { pkcs8: kp.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), pub: raw.toString("base64") };
}
const signer = (k) => (b64) => crypto.sign(null, Buffer.from(b64, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(k.pkcs8, "base64"), format: "der", type: "pkcs8" })).toString("base64");
async function session(party, k) {
  const ch = await call("POST", "/api/auth/challenge", { party });
  const v = await call("POST", "/api/auth/verify", { party, nonce: ch.nonce,
    signature: signer(k)(Buffer.from(ch.message, "utf8").toString("base64")) });
  return { Authorization: "Bearer " + v.token };
}
const q = (party) => "?role=" + encodeURIComponent(party);

async function onboard(expectMulti) {
  const k = newKey(), sign = signer(k);
  const d = await call("POST", "/api/ext/onboard/prepare", { publicKey: k.pub });
  if (!!d.multiHost !== expectMulti) throw new Error(`the server ${d.multiHost ? "has" : "has no"} DECMAN_HOSTS; this step expects the opposite`);
  let extra = {};
  if (d.multiHost) {
    await V.verifyTopology(CT, d.partyId, d.hashes, d.topologyTransactions, d.participants);
    const signatures = d.hashes.map(sign);
    extra = { multiHost: true, hint: d.hint, hashes: d.hashes, signatures };
  }
  const c = await call("POST", "/api/ext/onboard/confirm", Object.assign({ partyId: d.partyId, fingerprint: d.fingerprint,
    publicKey: d.publicKey, topologyTransactions: d.topologyTransactions, multiHash: d.multiHash,
    multiHashSignature: extra.signatures ? extra.signatures[0] : sign(d.multiHash) }, extra));
  return { party: c.party.partyId, key: k };
}

const STEPS = {
  async legacy() {
    st.legacy = await onboard(false); save();
    console.log("legacy wallet on one node:", st.legacy.party);
  },
  async new() {
    const w = await onboard(true);
    const s = await call("GET", "/api/ext/hosts" + q(w.party), null, await session(w.party, w.key));
    console.log("new wallet:", w.party, "->", JSON.stringify(s.hosts), "backup=" + s.backup);
  },
  async backup() {
    const w = st.legacy, h = await session(w.party, w.key);
    console.log("before:", JSON.stringify((await call("GET", "/api/ext/hosts" + q(w.party), null, h)).hosts));
    const p = await call("POST", "/api/ext/hosts/prepare", { party: w.party }, h);
    await V.verifyTopology(CT, w.party, p.hashes, p.topologyTransactions, p.participants);
    const forged = p.hashes.map(signer(newKey()));
    await call("POST", "/api/ext/hosts/confirm", { party: w.party, baseSerial: p.baseSerial,
      topologyTransactions: p.topologyTransactions, hashes: p.hashes, signatures: forged }, h)
      .then(() => { throw new Error("a forged signature was accepted"); }, (e) => console.log("forged signature refused:", e.message.slice(0, 60)));
    const t0 = Date.now();
    const r = await call("POST", "/api/ext/hosts/confirm", { party: w.party, baseSerial: p.baseSerial,
      topologyTransactions: p.topologyTransactions, hashes: p.hashes, signatures: p.hashes.map(signer(w.key)) }, h);
    console.log(`backup node added in ${Date.now() - t0}ms:`, JSON.stringify(r.report), "backup=" + r.status.backup);
  },
  // The legacy wallet makes a contract through Umbra -- run with a node down to see
  // Umbra carry on through the other one (GET /api/status shows which it is using).
  async trade() {
    const w = st.legacy, sign = signer(w.key);
    const cmd = [{ CreateCommand: { templateId: "#umbra-v9:UmbraSwap:AssetHolding",
      createArguments: { owner: w.party, asset: { admin: w.party, symbol: "DEMO" }, amount: "3" } } }];
    const prep = await call("POST", "/api/ext/prepare", { party: w.party, commands: cmd, tag: "demo-trade" });
    await call("POST", "/api/ext/execute", { party: w.party, commandId: prep.commandId, preparedTransaction: prep.preparedTransaction,
      hashingSchemeVersion: prep.hashingSchemeVersion, signature: sign(prep.preparedTransactionHash), signedBy: w.party.split("::")[1] });
    const s = await call("GET", "/api/status");
    console.log("transacted through Umbra via node", (s.nodes.find((n) => n.active) || {}).name, "| nodes:",
      s.nodes.map((n) => n.name + (n.healthy ? "=up" : "=DOWN")).join(" "));
  },
  async venue() {
    const r = await call("POST", "/api/admin/venue-hosts", { role: "requester" }, { "X-Umbra-Operator": process.env.UMBRA_OPERATOR_TOKEN || "" });
    console.log("venue party:", r.party || "", r.nothingToDo ? "already on every node" : JSON.stringify(r.report));
  },
};
(async () => {
  const s = process.argv[2];
  if (!STEPS[s]) throw new Error("steps: " + Object.keys(STEPS).join(", "));
  await STEPS[s]();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
