// The venue's keys, in their own process.
//
// The app used to hold the keystore passphrase in its own .env and decrypt the
// venue's keys in its own memory, so anything that took over the app took the
// venue's signing authority with it. This daemon runs as its own OS user, holds the
// keystore and its passphrase, and answers one question over a local socket:
// "sign this transaction as this role".
//
// It is sent the WHOLE prepared transaction, not a bare hash, so it can see what it
// signs. It recomputes the hash itself (Canton's own hashing code) and decodes the
// transaction, and signs only if it acts for that role's party alone and every
// top-level action is one the venue performs (POLICY below). A compromised app can
// then get the venue key to settle or cancel deals by their contract rules -- which
// it could already ask for -- and nothing else.
//
// UMBRA_SIGNER_POLICY=audit signs everything but logs what enforce would refuse:
// run it that way first, read the log, then switch to enforce.
//
//   env: UMBRA_KEYSTORE=file  UMBRA_KEYSTORE_FILE  UMBRA_KEYSTORE_PASSPHRASE
//        UMBRA_SIGNER_SOCKET (default /run/umbra-signer/signer.sock)
//        UMBRA_SIGNER_RECORDS (public metadata for the app, default beside the socket)
//        UMBRA_SIGNER_POLICY  audit | enforce (default enforce)
const net = require("net");
const fs = require("fs");
const path = require("path");
const { getSigner } = require("./signer");
const { decodePreparedTransaction, hashPreparedTransaction, decodeTopologyTransaction, computeSha256CantonHash } = require("@canton-network/core-tx-visualizer");

const SOCK = process.env.UMBRA_SIGNER_SOCKET || "/run/umbra-signer/signer.sock";
const RECORDS = process.env.UMBRA_SIGNER_RECORDS || path.join(path.dirname(SOCK), "records.json");
const MODE = (process.env.UMBRA_SIGNER_POLICY || "enforce").toLowerCase();

// What each role may sign, as "Module:Entity.Choice" for the top-level actions.
// The venue (role "requester") does the venue's half of a trade and its admin; the
// demo dealers are not used on a real deployment and get nothing.
const POLICY = {
  requester: new Set([
    "UmbraSwap:SwapDeal.SettleDeal", "UmbraSwap:SwapDeal.CancelDeal",
    "UmbraSwap:FirmRelock.ReleaseFunded", "UmbraSwap:FirmRelock.LockPart", "UmbraSwap:FirmRelock.DropRelock",
    "UmbraSwap:SwapSettlement.ExecuteRealSwap", "UmbraSwap:SwapSettlement.ExecuteSwap",
    "UmbraSwap:AssetRegistry.ListAsset", "UmbraSwap:AssetRegistry.DelistAsset",
    "UmbraSwap:AssetRegistry.SetParticipants",
  ]),
};

let signer = null;
const S = () => (signer = signer || getSigner());

function publish() {
  const recs = {};
  for (const r of S().roles()) recs[r] = S().recordFor(r);
  fs.writeFileSync(RECORDS, JSON.stringify(recs), { mode: 0o644 });
}

const modEnt = (id) => id ? (id.moduleName || "") + ":" + (id.entityName || "") : "";

async function judge(role, hashB64, txB64) {
  const rec = S().recordFor(role);
  if (!rec) return "no key for role " + role;
  if (!txB64) return "no transaction sent (a bare hash is not signed)";
  const h = await hashPreparedTransaction(txB64, "base64");
  if (h !== hashB64) return "the hash is not the hash of the transaction sent";
  const tx = decodePreparedTransaction(txB64);
  const acts = (tx.metadata && tx.metadata.submitterInfo && tx.metadata.submitterInfo.actAs) || [];
  if (!acts.includes(rec.partyId)) return "the transaction does not act for " + role;
  const allowed = POLICY[role];
  if (!allowed) return "role " + role + " may not sign anything here";
  const t = tx.transaction || {};
  const byId = new Map((t.nodes || []).map((n) => [n.nodeId, n]));
  for (const id of (t.roots || [])) {
    const nt = byId.get(id).versionedNode.v1.nodeType;
    const n = nt[nt.oneofKind];
    const what = nt.oneofKind === "exercise"
      ? modEnt(n.templateId) + "." + n.choiceId
      : nt.oneofKind + " " + modEnt(n.templateId);
    if (!allowed.has(what)) return "not allowed for " + role + ": " + what;
  }
  return null;
}

// Nodes a venue party may be hosted on (participant ids, comma separated). A hosting
// change naming any other node is refused: that is how a compromised app would try to
// move the venue's party somewhere it controls.
const HOSTS = new Set(String(process.env.UMBRA_SIGNER_HOSTS || "").split(",").map((x) => x.trim()).filter(Boolean));

async function judgeTopology(role, hashB64, txB64) {
  const rec = S().recordFor(role);
  if (!rec) return "no key for role " + role;
  if (!txB64) return "no topology sent";
  const h = Buffer.from(await computeSha256CantonHash(11, new Uint8Array(Buffer.from(txB64, "base64")))).toString("base64");
  if (h !== hashB64) return "the hash is not the hash of the topology sent";
  const d = decodeTopologyTransaction(txB64);
  const m = d && d.mapping && d.mapping.mapping;
  if (!m || m.oneofKind !== "partyToParticipant") return "not a hosting change";
  if (m.partyToParticipant.party !== rec.partyId) return "a hosting change for another party";
  if (!HOSTS.size) return "no nodes are allowed (UMBRA_SIGNER_HOSTS is empty)";
  for (const p of m.partyToParticipant.participants || []) {
    if (!HOSTS.has(p.participantUid)) return "a node that is not allowed: " + String(p.participantUid).slice(0, 40);
  }
  return null;
}

async function handle(msg) {
  if (msg.op === "signTopology") {
    const why = await judgeTopology(msg.role, msg.hash, msg.tx).catch((e) => "could not check the topology: " + e.message);
    if (why) {
      console.error(`[signer] ${MODE === "enforce" ? "REFUSED" : "AUDIT (would refuse)"} topology ${msg.role}: ${why}`);
      if (MODE === "enforce") return { error: "the venue signer refused: " + why };
    }
    console.log(`[signer] signed a hosting change for ${msg.role}`);
    return { signature: await S().sign(msg.role, msg.hash) };
  }
  if (msg.op === "records") { const r = {}; for (const x of S().roles()) r[x] = S().recordFor(x); return { records: r }; }
  if (msg.op !== "sign") return { error: "unknown op" };
  const why = await judge(msg.role, msg.hash, msg.tx).catch((e) => "could not check the transaction: " + e.message);
  if (why) {
    console.error(`[signer] ${MODE === "enforce" ? "REFUSED" : "AUDIT (would refuse)"} ${msg.role}: ${why}`);
    if (MODE === "enforce") return { error: "the venue signer refused: " + why };
  }
  return { signature: await S().sign(msg.role, msg.hash) };
}

module.exports = { judge, judgeTopology, POLICY };
if (require.main === module) {
try { fs.unlinkSync(SOCK); } catch (e) { /* not there */ }
const server = net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    if (buf.length > 8 * 1024 * 1024) return c.destroy();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let msg; try { msg = JSON.parse(line); } catch (e) { c.write(JSON.stringify({ error: "bad request" }) + "\n"); continue; }
      handle(msg).then((out) => c.write(JSON.stringify(Object.assign({ id: msg.id }, out)) + "\n"),
        (e) => c.write(JSON.stringify({ id: msg.id, error: e.message }) + "\n"));
    }
  });
  c.on("error", () => {});
});
server.listen(SOCK, () => {
  fs.chmodSync(SOCK, 0o660);            // the app's group may connect; nobody else
  publish();
  console.log(`[signer] listening on ${SOCK}, policy ${MODE}, roles: ${S().roles().join(", ")}`);
});
}
