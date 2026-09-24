// Hosting a party on more than one node, through DecMan's tenant API.
//
// A party that lives on one participant is gone when that participant is. DecMan's
// tenant API (one DecMan per hosting node) lets the owner's own key put the party on
// several nodes, so any one of them can be down while the party keeps trading. The
// key never comes here: every node builds the same topology, this server checks the
// nodes agree byte for byte, the owner signs the hashes in their own wallet, and the
// signed bundle goes to every node.
//
//   DECMAN_HOSTS='[{"name":"umbra","url":"http://127.0.0.1:8090","apiKey":"...",
//                   "participantId":"umbra::1220..."},
//                  {"name":"bitsafe","url":"https://...","apiKey":"...","participantId":"..."}]'
//
// Fewer than two hosts: everything here is off and onboarding works as before.
const fetch = require("node-fetch");

function loadHosts() {
  try {
    const list = JSON.parse(process.env.DECMAN_HOSTS || "[]");
    return Array.isArray(list) ? list.filter((h) => h && h.url && h.participantId) : [];
  } catch (e) {
    console.error("[hosts] DECMAN_HOSTS is not valid JSON:", e.message);
    return [];
  }
}
const HOSTS = loadHosts();
const enabled = () => HOSTS.length >= 2;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = encodeURIComponent;

async function dm(h, method, path, body) {
  const r = await fetch(h.url.replace(/\/$/, "") + path, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + (h.apiKey || "") },
    body: body ? JSON.stringify(body) : undefined, timeout: 60000,
  });
  const t = await r.text();
  if (!r.ok) {
    throw Object.assign(new Error(`${h.name || h.url}: ${r.status} ${t.slice(0, 300)}`), { status: r.status === 409 ? 409 : 502 });
  }
  return t ? JSON.parse(t) : {};
}

// Every host prepares; they must agree, or the owner would be signing something one
// host made up. Returns what the owner signs.
async function agreeOn(hosts, path, bodyFor) {
  const preps = await Promise.all(hosts.map((h, i) => dm(h, "POST", path, bodyFor(h, i))));
  const first = preps[0];
  for (const p of preps.slice(1)) {
    if (!same(p.transaction_hashes, first.transaction_hashes) || !same(p.topology_transactions, first.topology_transactions)) {
      throw Object.assign(new Error("the hosting nodes prepared different topologies; nothing was signed"), { status: 502 });
    }
  }
  return first;
}

async function hostedOn(h, party) {
  try { return /completed/i.test(JSON.stringify(await dm(h, "GET", `/v0/tenant/${enc(party)}/status`))); }
  catch (e) { return false; }
}

// ---- a new party on every host ---------------------------------------------------
async function prepareOnboard(publicKey, hint) {
  const p = await agreeOn(HOSTS, "/v0/tenant/prepare", (h) => ({
    party_hint: hint, public_key: publicKey,
    hosting_peers: HOSTS.filter((x) => x !== h).map((x) => x.participantId),
  }));
  return { partyId: p.party_id, hashes: p.transaction_hashes, topologyTransactions: p.topology_transactions };
}

async function confirmOnboard(o) {
  for (const h of HOSTS) {
    await dm(h, "POST", "/v0/tenant/onboard", { party_hint: o.hint, public_key: o.publicKey,
      topology_transactions: o.topologyTransactions, signatures: o.signatures, signed_by: o.fingerprint });
  }
  // A proposal until every host has signed; then live.
  for (let i = 0; i < 40; i++) {
    const ok = await Promise.all(HOSTS.map((h) => hostedOn(h, o.partyId)));
    if (ok.every(Boolean)) return { hosts: HOSTS.map((h) => h.name) };
    await wait(1500);
  }
  throw Object.assign(new Error("the party was signed but not every node confirmed hosting it yet -- try again in a minute"), { status: 504 });
}

// ---- adding hosts to a party that exists -------------------------------------------
async function status(party) {
  const on = await Promise.all(HOSTS.map((h) => hostedOn(h, party)));
  return { enabled: enabled(), hosts: HOSTS.map((h, i) => ({ name: h.name, hosted: on[i] })),
           backup: on.filter(Boolean).length >= 2 };
}

async function stateFrom(hosts, party) {
  for (const h of hosts) { try { return await dm(h, "GET", `/v0/tenant/${enc(party)}/state`); } catch (e) { /* next */ } }
  throw Object.assign(new Error("no hosting node knows this party"), { status: 404 });
}

async function prepareAddHosts(party) {
  const on = await Promise.all(HOSTS.map((h) => hostedOn(h, party)));
  const current = HOSTS.filter((_, i) => on[i]);
  const joining = HOSTS.filter((_, i) => !on[i]);
  if (!current.length) throw Object.assign(new Error("none of the configured nodes hosts this party"), { status: 409 });
  if (!joining.length) return { nothingToDo: true };
  const st = await stateFrom(current, party);
  const req = { party_id: party, permission: "confirmation",
                new_hosts: joining.map((h) => h.participantId), base_serial: st.serial };
  const p = await agreeOn(current.concat(joining), "/v0/tenant/add-hosts/prepare", () => req);
  return { partyId: party, baseSerial: st.serial, hashes: p.transaction_hashes,
           topologyTransactions: p.topology_transactions, joining: joining.map((h) => h.name) };
}

// Submit on the joining hosts, wait for the mapping, then carry the party's contracts
// from a current host to each joiner, block by block, and wait for them to go live.
async function confirmAddHosts(o) {
  const on = await Promise.all(HOSTS.map((h) => hostedOn(h, o.partyId)));
  const current = HOSTS.filter((_, i) => on[i]);
  const joining = HOSTS.filter((_, i) => !on[i]);
  for (const h of joining) {
    await dm(h, "POST", "/v0/tenant/add-hosts/onboard", { party_id: o.partyId, base_serial: o.baseSerial,
      topology_transactions: o.topologyTransactions, signatures: o.signatures, signed_by: o.fingerprint });
  }
  const want = current.length + joining.length;
  for (let i = 0; i < 40; i++) {
    const s = await stateFrom(current, o.partyId).catch(() => null);
    if (s && s.host_count >= want) break;
    if (i === 39) throw Object.assign(new Error("the new host was signed but never appeared in the party's mapping"), { status: 504 });
    await wait(1500);
  }
  const src = current[0];
  const report = [];
  for (const j of joining) {
    let seq = 1, last = null;
    for (;;) {
      const blk = await dm(src, "GET", `/v0/tenant/${enc(o.partyId)}/acs/${enc(j.participantId)}?base_serial=${o.baseSerial}&seq=${seq}`);
      last = await dm(j, "POST", "/v0/tenant/add-hosts/import", { party_id: o.partyId, base_serial: o.baseSerial, seq,
        chunk: blk.chunk, end: blk.end, total_len: blk.total_len, sha256: blk.sha256, package_ids: blk.package_ids });
      if (blk.end) break;
      seq++;
    }
    let live = false;
    for (let i = 0; i < 40 && !live; i++) { live = await hostedOn(j, o.partyId); if (!live) await wait(3000); }
    report.push({ host: j.name, blocks: seq, complete: !!(last && last.complete), live });
  }
  return { report, status: await status(o.partyId) };
}

module.exports = { enabled, status, prepareOnboard, confirmOnboard, prepareAddHosts, confirmAddHosts,
  hostNames: () => HOSTS.map((h) => h.name), participantIds: () => HOSTS.map((h) => h.participantId) };
