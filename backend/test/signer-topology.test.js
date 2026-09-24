// The venue signer's check on a hosting change (signer-daemon.js judgeTopology),
// against a real PartyToParticipant topology prepared by DecMan on LocalNet.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
process.env.DOTENV_CONFIG_QUIET = "true";

const F = require("./fixtures/topology-ptp.json");
const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "signer-topo-")), "keys.json");
const kp = crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "der" } });
fs.writeFileSync(store, JSON.stringify({
  requester: { partyId: F.party, fingerprint: "f", privDer: kp.privateKey.toString("base64") },
  other: { partyId: "someone-else::1220aa", fingerprint: "g", privDer: kp.privateKey.toString("base64") },
}));
process.env.UMBRA_KEYSTORE = "plaintext";
process.env.UMBRA_KEYSTORE_FILE = store;
process.env.UMBRA_SIGNER_HOSTS = F.participants.join(",");
const { judgeTopology } = require("../signer-daemon");

test("a hosting change onto allowed nodes passes", async () => {
  assert.strictEqual(await judgeTopology("requester", F.hash, F.tx), null);
});

test("a hash that is not this topology's is refused", async () => {
  assert.match(await judgeTopology("requester", Buffer.alloc(32, 2).toString("base64"), F.tx), /hash is not the hash/);
});

test("a hosting change for another party is refused", async () => {
  assert.match(await judgeTopology("other", F.hash, F.tx), /another party/);
});

test("a node that is not allowed is refused", async () => {
  // re-load with only the first node allowed
  delete require.cache[require.resolve("../signer-daemon")];
  process.env.UMBRA_SIGNER_HOSTS = F.participants[0];
  const again = require("../signer-daemon");
  assert.match(await again.judgeTopology("requester", F.hash, F.tx), /not allowed/);
});
