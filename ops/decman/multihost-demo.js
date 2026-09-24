// Party hosting on two nodes, and failover, on the DecMan LocalNet sandbox.
//
// Plays the part of a wallet (holding a key it never sends) against two DecMan
// tenant APIs and two Canton JSON ledger APIs, and proves:
//
//   onboard   a new party, hosted on BOTH nodes, from one signature
//   addhost   a party that exists on node A only gains node B: one signature for the
//             topology, then its contracts are relayed A -> B block by block
//   failover  node A is taken off the synchronizer; the party still transacts
//             through node B; A reconnects and catches up
//
//   node ops/decman/multihost-demo.js all        (or one step at a time)
//
// Defaults match the sandbox: decman-1 (8081) on the app-provider participant
// (JSON 3975, admin 3902), decman-2 (8082) on app-user (JSON 2975). The sandbox runs
// Canton's unsafe dev auth, so ledger tokens are minted here with its public dev
// secret -- never do that against a real network.
//
// Needs: Node 20+, the sandbox up, Umbra's DAR at UMBRA_DAR, and for `failover`
// `npm i @grpc/grpc-js @grpc/proto-loader` plus the admin protos, copied with
//   docker cp canton:/app/protobuf ./ops/decman/proto
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const E = process.env;
const A = { name: "A", dm: E.DECMAN_A || "http://127.0.0.1:8081", json: E.LEDGER_A || "http://127.0.0.1:3975" };
const B = { name: "B", dm: E.DECMAN_B || "http://127.0.0.1:8082", json: E.LEDGER_B || "http://127.0.0.1:2975" };
const ADMIN_A = E.ADMIN_A || "127.0.0.1:3902";
const PROTO = E.PROTO_DIR || path.join(__dirname, "proto");
const DAR = E.UMBRA_DAR || path.join(__dirname, "../../.daml/dist/umbra-v9-0.12.2.dar");
const USER = E.LEDGER_USER || "ledger-api-user";
const STATE = E.DEMO_STATE || path.join(__dirname, ".demo-state.json");
const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = encodeURIComponent;

// The sandbox's unsafe auth: HS256 over its public dev secret.
function devToken() {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b({ alg: "HS256", typ: "JWT" });
  const p = b({ aud: E.TOKEN_AUDIENCE || "https://canton.network.global", sub: USER, iat: Math.floor(Date.now() / 1000) });
  return h + "." + p + "." + crypto.createHmac("sha256", E.TOKEN_SECRET || "unsafe").update(h + "." + p).digest("base64url");
}
const TOKEN = E.LEDGER_TOKEN || devToken();

async function http(base, method, p, body, token, raw) {
  const r = await fetch(base + p, { method, body: raw || (body ? JSON.stringify(body) : undefined),
    headers: { "Content-Type": raw ? "application/octet-stream" : "application/json", Authorization: "Bearer " + token } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${base}${p.split("?")[0]} ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}
const dm = (h, m, p, b) => http(h.dm, m, p, b, E.DECMAN_KEY || "sandbox");
const lj = (h, m, p, b) => http(h.json, m, p, b, TOKEN);

async function participantId(h) {
  const s = await dm(h, "GET", "/participants-status");
  return s.statuses.find((x) => x.status === "CurrentNode").id;
}
function newKey() {
  const kp = crypto.generateKeyPairSync("ed25519");
  const raw = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const fp = "1220" + crypto.createHash("sha256").update(Buffer.concat([Buffer.from([0, 0, 0, 12]), raw])).digest("hex");
  return { pkcs8: kp.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), pub: raw.toString("base64"), fp };
}
const signer = (k) => (b64) => crypto.sign(null, Buffer.from(b64, "base64"),
  crypto.createPrivateKey({ key: Buffer.from(k.pkcs8, "base64"), format: "der", type: "pkcs8" })).toString("base64");
const hosted = async (h, party) => /completed/i.test(JSON.stringify(await dm(h, "GET", `/v0/tenant/${enc(party)}/status`).catch(() => ({}))));

async function sync(h) { return (await lj(h, "GET", "/v2/state/connected-synchronizers")).connectedSynchronizers[0].synchronizerId; }
async function grant(h, party) {
  for (const kind of [{ CanReadAs: { value: { party } } }, { CanActAs: { value: { party } } }]) {
    await lj(h, "POST", `/v2/users/${USER}/rights`, { userId: USER, rights: [{ kind }] }).catch(() => {});
  }
}
// Transact as the party through ONE node: prepare there, sign here, execute there.
async function submitVia(h, who, commands) {
  await grant(h, who.party);
  const prep = await lj(h, "POST", "/v2/interactive-submission/prepare", { userId: USER, actAs: [who.party],
    commandId: "demo-" + Date.now(), synchronizerId: who.sync, packageIdSelectionPreference: [], commands });
  await lj(h, "POST", "/v2/interactive-submission/execute", { preparedTransaction: prep.preparedTransaction,
    hashingSchemeVersion: prep.hashingSchemeVersion, submissionId: "demo-" + Date.now(), userId: USER,
    deduplicationPeriod: { Empty: {} },
    partySignatures: { signatures: [{ party: who.party, signatures: [{ format: "SIGNATURE_FORMAT_RAW",
      signature: signer(who.key)(prep.preparedTransactionHash), signedBy: who.key.fp,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] }] } });
}
const holdingCmd = (party, amount) => [{ CreateCommand: { templateId: "#umbra-v9:UmbraSwap:AssetHolding",
  createArguments: { owner: party, asset: { admin: party, symbol: "DEMO" }, amount: String(amount) } } }];
async function holdings(h, party) {
  await grant(h, party);
  const end = (await lj(h, "GET", "/v2/state/ledger-end")).offset;
  const r = await lj(h, "POST", "/v2/state/active-contracts", { filter: { filtersByParty: { [party]: { cumulative: [{
    identifierFilter: { TemplateFilter: { value: { templateId: "#umbra-v9:UmbraSwap:AssetHolding", includeCreatedEventBlob: false } } } }] } } },
    verbose: false, activeAtOffset: end });
  return (Array.isArray(r) ? r : [r]).map((x) => x.contractEntry && x.contractEntry.JsActiveContract && x.contractEntry.JsActiveContract.createdEvent)
    .filter(Boolean).map((c) => Number(c.createArgument.amount));
}

async function dar() {
  const bytes = fs.readFileSync(DAR);
  for (const h of [A, B]) {
    await http(h.json, "POST", "/v2/packages", null, TOKEN, bytes).catch((e) => {
      if (!/KNOWN|already/i.test(e.message)) throw e;
    });
  }
  console.log("Umbra's package is on both nodes");
}

async function onboard() {
  const k = newKey();
  const [idA, idB] = await Promise.all([participantId(A), participantId(B)]);
  const hint = "demo-alice-" + Date.now();
  const preps = await Promise.all([[A, idB], [B, idA]].map(([h, peer]) =>
    dm(h, "POST", "/v0/tenant/prepare", { party_hint: hint, public_key: k.pub, hosting_peers: [peer] })));
  if (!same(preps[0].transaction_hashes, preps[1].transaction_hashes) || !same(preps[0].topology_transactions, preps[1].topology_transactions)) {
    throw new Error("the two nodes prepared different topologies");
  }
  const sigs = preps[0].transaction_hashes.map(signer(k));
  for (const h of [A, B]) {
    await dm(h, "POST", "/v0/tenant/onboard", { party_hint: hint, public_key: k.pub,
      topology_transactions: preps[0].topology_transactions, signatures: sigs, signed_by: k.fp });
  }
  const party = preps[0].party_id;
  for (let i = 0; i < 30 && !((await hosted(A, party)) && (await hosted(B, party))); i++) await wait(2000);
  const s = await dm(A, "GET", `/v0/tenant/${enc(party)}/state`);
  console.log(`onboard: ${sigs.length} signature -> host_count ${s.host_count}, threshold ${s.threshold}`);
  st.alice = { party, key: k, sync: await sync(A) }; save();
}

async function single() {
  const k = newKey(), s = await sync(A);
  const g = await lj(A, "POST", "/v2/parties/external/generate-topology", { partyHint: "demo-bob-" + Date.now(), synchronizer: s,
    publicKey: { format: "CRYPTO_KEY_FORMAT_RAW", keyData: k.pub, keySpec: "SIGNING_KEY_SPEC_EC_CURVE25519" } });
  await lj(A, "POST", "/v2/parties/external/allocate", { synchronizer: s,
    onboardingTransactions: g.topologyTransactions.map((t) => ({ transaction: t })),
    multiHashSignatures: [{ format: "SIGNATURE_FORMAT_RAW", signature: signer(k)(g.multiHash), signedBy: g.publicKeyFingerprint,
      signingAlgorithmSpec: "SIGNING_ALGORITHM_SPEC_ED25519" }] });
  st.bob = { party: g.partyId, key: k, sync: s }; save();
  await wait(3000);
  await submitVia(A, st.bob, holdingCmd(st.bob.party, 42));
  await wait(3000);
  console.log(`single: a party on node A only, holding ${JSON.stringify(await holdings(A, st.bob.party))}`);
}

async function addhost() {
  const who = st.bob;
  const idB = await participantId(B);
  const s0 = await dm(A, "GET", `/v0/tenant/${enc(who.party)}/state`);
  const req = { party_id: who.party, permission: "confirmation", new_hosts: [idB], base_serial: s0.serial };
  const [pa, pb] = await Promise.all([A, B].map((h) => dm(h, "POST", "/v0/tenant/add-hosts/prepare", req)));
  if (!same(pa.transaction_hashes, pb.transaction_hashes) || !same(pa.topology_transactions, pb.topology_transactions)) {
    throw new Error("the two nodes prepared different topologies");
  }
  await dm(B, "POST", "/v0/tenant/add-hosts/onboard", { party_id: who.party, base_serial: s0.serial,
    topology_transactions: pa.topology_transactions, signatures: pa.transaction_hashes.map(signer(who.key)), signed_by: who.key.fp });
  for (let i = 0; i < 30; i++) { if ((await dm(A, "GET", `/v0/tenant/${enc(who.party)}/state`)).host_count === 2) break; await wait(2000); }
  let seq = 1;
  for (;;) {
    const blk = await dm(A, "GET", `/v0/tenant/${enc(who.party)}/acs/${enc(idB)}?base_serial=${s0.serial}&seq=${seq}`);
    await dm(B, "POST", "/v0/tenant/add-hosts/import", { party_id: who.party, base_serial: s0.serial, seq,
      chunk: blk.chunk, end: blk.end, total_len: blk.total_len, sha256: blk.sha256, package_ids: blk.package_ids });
    if (blk.end) break;
    seq++;
  }
  for (let i = 0; i < 40 && !(await hosted(B, who.party)); i++) await wait(3000);
  console.log(`addhost: 1 signature, ${seq} block(s) relayed; on node B now: ${JSON.stringify(await holdings(B, who.party))}`);
}

function adminA() {
  const grpc = require("@grpc/grpc-js"), loader = require("@grpc/proto-loader");
  const def = loader.loadSync("com/digitalasset/canton/admin/participant/v30/synchronizer_connectivity_service.proto",
    { includeDirs: [path.join(PROTO, "admin-api"), path.join(PROTO, "lib")], keepCase: false, defaults: true });
  const svc = grpc.loadPackageDefinition(def).com.digitalasset.canton.admin.participant.v30.SynchronizerConnectivityService;
  const c = new svc(ADMIN_A, grpc.credentials.createInsecure());
  return (m, req) => new Promise((ok, no) => c[m](req, (e, r) => (e ? no(e) : ok(r))));
}

async function failover() {
  const call = adminA(), who = st.bob;
  await call("disconnectAllSynchronizers", {});
  console.log("failover: node A is OFF the synchronizer");
  try {
    await submitVia(B, who, holdingCmd(who.party, 7));
    await wait(4000);
    console.log(`          the party transacted through node B alone: ${JSON.stringify(await holdings(B, who.party))}`);
  } finally {
    await call("reconnectSynchronizers", { ignoreFailures: false });
  }
  for (let i = 0; i < 20; i++) { if ((await call("listConnectedSynchronizers", {})).connectedSynchronizers.length) break; await wait(2000); }
  await wait(8000);
  console.log(`          node A back, caught up: ${JSON.stringify(await holdings(A, who.party))}`);
}

// Take node A off the synchronizer, or put it back -- to watch Umbra's own failover.
async function down() { await adminA()("disconnectAllSynchronizers", {}); console.log("node A is OFF the synchronizer"); }
async function up() {
  const call = adminA();
  await call("reconnectSynchronizers", { ignoreFailures: false });
  for (let i = 0; i < 20; i++) { if ((await call("listConnectedSynchronizers", {})).connectedSynchronizers.length) break; await wait(2000); }
  console.log("node A is back on the synchronizer");
}

const STEPS = { dar, onboard, single, addhost, failover };
const EXTRA = { down, up };
(async () => {
  const step = process.argv[2] || "all";
  const all = Object.assign({}, STEPS, EXTRA);
  const run = step === "all" ? Object.keys(STEPS) : [step];
  for (const s of run) {
    if (!all[s]) throw new Error("steps: " + Object.keys(all).join(", ") + ", all");
    await all[s]();
  }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
