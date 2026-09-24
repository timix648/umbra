// The venue signer's policy (signer-daemon.js), against a real prepared transaction:
// a RequestDesk create acting for one DevNet test party.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
process.env.DOTENV_CONFIG_QUIET = "true";

const S = require("./fixtures/prepared-requestdesk.json");
const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "signer-")), "keys.json");
const kp = crypto.generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "der" } });
// "requester" is mapped to the fixture's party so the transaction acts for it.
fs.writeFileSync(store, JSON.stringify({
  requester: { partyId: S.party, fingerprint: "f", privDer: kp.privateKey.toString("base64") },
  other: { partyId: "someone-else::1220aa", fingerprint: "g", privDer: kp.privateKey.toString("base64") },
}));
process.env.UMBRA_KEYSTORE = "plaintext";
process.env.UMBRA_KEYSTORE_FILE = store;
const { judge, POLICY } = require("../signer-daemon");
const { preparedTransaction: tx, preparedTransactionHash: hash } = S.prep;

test("an action the venue does not perform is refused", async () => {
  assert.match(await judge("requester", hash, tx), /not allowed for requester: create UmbraSwap:RequestDesk/);
});

test("the same transaction passes once the action is on the list", async () => {
  POLICY.requester.add("create UmbraSwap:RequestDesk");
  try { assert.strictEqual(await judge("requester", hash, tx), null); }
  finally { POLICY.requester.delete("create UmbraSwap:RequestDesk"); }
});

test("a hash that is not this transaction's is refused", async () => {
  assert.match(await judge("requester", Buffer.alloc(32, 1).toString("base64"), tx), /hash is not the hash/);
});

test("a bare hash is refused", async () => {
  assert.match(await judge("requester", hash, null), /bare hash/);
});

test("a key is not lent to a transaction acting for another party", async () => {
  assert.match(await judge("other", hash, tx), /does not act for other/);
});

test("an unknown role is refused", async () => {
  assert.match(await judge("dealer9", hash, tx), /no key for role/);
});
