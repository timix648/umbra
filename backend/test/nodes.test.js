// Ledger node failover (token.js): two stand-in participants, one of which dies.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
// dotenv announces itself on stdout, which the test runner reads as its own channel.
process.env.DOTENV_CONFIG_QUIET = "true";

function stubNode(name) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push(req.method + " " + req.url);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ node: name, offset: 1, connectedSynchronizers: [{ synchronizerId: "s" }] }));
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ srv, seen, port: srv.address().port })));
}

test("reads move to the next node when the preferred one is down, submissions do not", async () => {
  const a = await stubNode("A");
  const b = await stubNode("B");
  process.env.LEDGER_PROBE_MS = "100000";
  process.env.LEDGER_NODES = JSON.stringify([
    { name: "A", url: `http://127.0.0.1:${a.port}`, grant: "static", token: "ta", userId: "ua" },
    { name: "B", url: `http://127.0.0.1:${b.port}`, grant: "static", token: "tb", userId: "ub" },
  ]);
  const tok = require("../token");

  // both up: the preferred node serves
  let r = await tok.ledgerFetch("/v2/state/ledger-end");
  assert.strictEqual((await r.json()).node, "A");
  assert.strictEqual(tok.userId(), "ua");

  // A dies
  const closed = new Promise((ok) => a.srv.close(ok));
  a.srv.closeAllConnections();
  await closed;

  // a read is retried on B, and B becomes active with its own ledger user
  r = await tok.ledgerFetch("/v2/state/active-contracts", { method: "POST", body: "{}" });
  assert.strictEqual((await r.json()).node, "B");
  assert.strictEqual(tok.userId(), "ub");
  const st = tok.nodesStatus();
  assert.deepStrictEqual(st.map((n) => [n.name, n.healthy, n.active]), [["A", false, false], ["B", true, true]]);

  // with A already known down, a submission goes straight to B
  r = await tok.ledgerFetch("/v2/interactive-submission/execute", { method: "POST", body: "{}" });
  assert.strictEqual((await r.json()).node, "B");
  b.srv.closeAllConnections(); b.srv.close();
});

test("a submission is never replayed on another node", async () => {
  // fresh module state: node C preferred and dead from the start, D alive
  delete require.cache[require.resolve("../token")];
  const d = await stubNode("D");
  process.env.LEDGER_NODES = JSON.stringify([
    { name: "C", url: "http://127.0.0.1:1", grant: "static", token: "tc" },
    { name: "D", url: `http://127.0.0.1:${d.port}`, grant: "static", token: "td" },
  ]);
  const tok = require("../token");
  await assert.rejects(tok.ledgerFetch("/v2/interactive-submission/execute", { method: "POST", body: "{}" }));
  assert.strictEqual(d.seen.length, 0, "the submission must not have reached the other node");
  // the next attempt goes to D, which is now active
  const r = await tok.ledgerFetch("/v2/interactive-submission/execute", { method: "POST", body: "{}" });
  assert.strictEqual((await r.json()).node, "D");
  d.srv.closeAllConnections(); d.srv.close();
});
