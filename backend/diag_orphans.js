// Read-only inspection of the orphaned UmbraSwap:RealSwapPending contracts and the
// stale RFQ/invitation/quote backlog.
//
// An orphan is created when ProposeRealSwap commits but the caller gave up waiting,
// rolled back (withdrew) both allocations, and left the pending swap live. This
// script answers, for each one:
//     - who the parties are, what the trade was, when it was proposed
//     - whether the allocations it points at are STILL ACTIVE or were withdrawn
// A pending whose allocations are gone can never be accepted: it is dead weight.
//
// Writes nothing. Submits nothing. Archives nothing.
//   cd /root/umbra/backend && node diag_orphans.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ledgerFetch } = require("./token");

const PKGN = process.env.PACKAGE_NAME;
const SIGNED = String(process.env.SIGNED_MODE || "false").toLowerCase() === "true";
const ALLOC_IFACE = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";
const STORE = path.join(__dirname, "ext-parties.local.txt");

function loadStore() { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch { return {}; } }
function partyIdFor(role, store) {
  if (SIGNED && store[role] && store[role].partyId) return store[role].partyId;
  return process.env[role.toUpperCase()];
}
async function ledgerEnd() {
  const r = await ledgerFetch("/v2/state/ledger-end");
  return (await r.json()).offset;
}
function parseMaybeNdjson(text) {
  try { return JSON.parse(text); }
  catch {
    return text.trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
}
function eventOf(x) {
  return x?.contractEntry?.JsActiveContract?.createdEvent || x?.activeContract?.createdEvent || x?.createdEvent;
}

async function queryByFilter(party, identifierFilter) {
  const offset = await ledgerEnd();
  const body = {
    filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter }] } } },
    verbose: false, activeAtOffset: offset,
  };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
  return [].concat(parseMaybeNdjson(text));
}
async function queryTemplate(party, tmpl) {
  const rows = await queryByFilter(party, { TemplateFilter: { value: {
    templateId: `#${PKGN}:${tmpl}`, includeCreatedEventBlob: false } } });
  return rows.map((x) => { const ce = eventOf(x); return ce
    ? { contractId: ce.contractId, payload: ce.createArgument || ce.createArguments } : null; }).filter(Boolean);
}
async function queryAllocationCids(party) {
  const rows = await queryByFilter(party, { InterfaceFilter: { value: {
    interfaceId: ALLOC_IFACE, includeInterfaceView: true, includeCreatedEventBlob: false } } });
  const out = new Set();
  for (const x of rows) { const ce = eventOf(x); if (ce && ce.contractId) out.add(ce.contractId); }
  return out;
}

const short = (s) => (s ? String(s).slice(0, 24) + "…" : "(none)");

(async () => {
  const store = loadStore();
  const roles = ["requester", "dealer1", "dealer2"];
  const ids = {};
  for (const r of roles) ids[r] = partyIdFor(r, store);
  const requester = ids.requester;
  if (!requester) return console.log("No requester party resolved.");
  const roleOf = (pid) => roles.find((r) => ids[r] === pid) || short(pid);

  // Every allocation cid any of our parties can still see = "still active".
  const activeAllocs = new Set();
  for (const r of roles) {
    if (!ids[r]) continue;
    try { for (const c of await queryAllocationCids(ids[r])) activeAllocs.add(c); }
    catch (e) { console.log(`(allocation query failed for ${r}: ${e.message})`); }
  }
  console.log("active allocation contracts visible across our parties:", activeAllocs.size);

  // ---- the orphans -------------------------------------------------------
  console.log("\n=== ORPHANED UmbraSwap:RealSwapPending ===");
  const pend = await queryTemplate(requester, "UmbraSwap:RealSwapPending");
  if (!pend.length) console.log("none.");
  for (const c of pend) {
    const p = c.payload || {};
    const offCid = p.realOfferAllocCid, wantCid = p.realWantAllocCid;
    const offLive = offCid ? activeAllocs.has(offCid) : null;
    const wantLive = wantCid ? activeAllocs.has(wantCid) : null;
    console.log("\ncid            :", c.contractId);
    console.log("  requester    :", roleOf(p.requester));
    console.log("  dealer       :", roleOf(p.dealer));
    console.log("  offer        :", p.offerAmount, (p.offerAsset && p.offerAsset.symbol) || "?");
    console.log("  want (price) :", p.price, (p.wantAsset && p.wantAsset.symbol) || "?");
    if (p.proposedAt || p.createdAt) console.log("  proposedAt   :", p.proposedAt || p.createdAt);
    if (p.expiresAt) console.log("  expiresAt    :", p.expiresAt);
    console.log("  offerAlloc   :", short(offCid), offLive === null ? "" : (offLive ? "STILL ACTIVE" : "WITHDRAWN"));
    console.log("  wantAlloc    :", short(wantCid), wantLive === null ? "" : (wantLive ? "STILL ACTIVE" : "WITHDRAWN"));
    const dead = (offCid && !offLive) || (wantCid && !wantLive);
    console.log("  verdict      :", dead
      ? "DEAD - its allocations were withdrawn; AcceptRealSwap can never succeed"
      : "allocations intact - this one may still be completable");
  }

  // ---- the backlog -------------------------------------------------------
  console.log("\n=== LIVE BACKLOG (expiry breakdown) ===");
  const now = Date.now();
  for (const t of ["UmbraSwap:SwapRfq", "UmbraSwap:SwapInvitation", "UmbraSwap:SwapQuote", "UmbraSwap:SwapProposal"]) {
    try {
      const items = await queryTemplate(requester, t);
      let expired = 0, live = 0, noExpiry = 0;
      for (const c of items) {
        const e = c.payload && c.payload.expiresAt;
        if (!e) { noExpiry++; continue; }
        const ms = new Date(e).getTime();
        if (isNaN(ms)) noExpiry++; else if (ms <= now) expired++; else live++;
      }
      console.log(`${t.padEnd(28)} total ${String(items.length).padStart(3)}  ` +
                  `| expired ${String(expired).padStart(3)}  live ${String(live).padStart(3)}  no-expiry ${noExpiry}`);
    } catch (e) { console.log(`${t}: query failed - ${e.message}`); }
  }
  console.log("\nExpired contracts stay ACTIVE on the ledger until archived - Canton enforces");
  console.log("the deadline on exercise, it does not delete them. That is why the UI backlog");
  console.log("never clears on its own.");
})().catch((e) => console.log("FATAL", e && (e.stack || e.message)));
