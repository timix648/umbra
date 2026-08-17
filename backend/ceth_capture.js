// READ-ONLY live capture of a cETH swap's allocation window.
// Watches the requester AND dealer allocation sets continuously while YOU run a
// cETH swap in the browser. Catches the real cETH want-leg allocation in the
// moment between "created" and "reverted" - the only place the answer lives.
//
// Touches nothing. Only reads /v2/state/active-contracts and queryAllocations.
// Run from ~/umbra/backend, THEN trigger a cETH swap in the UI within ~40s.

require("dns").setDefaultResultOrder("ipv4first");
require("dotenv").config();
const { ledgerFetch } = require("./token");

const REQ  = "requester-1783890522020::122098dc9bd952af179cc1b8226cb08c506c75cb5c7069defd2fd934c2951cf1166d";
const D1   = "dealer1-1783890525928::122003619e1cb9503bf0252bbeb49229ae96ff58a62f5a2e74f442a876b90d856aa5";
const D2   = "dealer2-1783890527728::122003b0fdd32a0a4affe2e024c753012565016642cefda0ce535b9b7f315d3b6408";
const ALLOC_IFACE = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation";

async function allocs(party) {
  const off = (await (await ledgerFetch("/v2/state/ledger-end", { method: "GET" })).json()).offset;
  const body = { activeAtOffset: off, verbose: false, filter: { filtersByParty: {
    [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: {
      interfaceId: ALLOC_IFACE, includeInterfaceView: true } } } }] } } } };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const out = [];
  for (const line of (await r.text()).trim().split("\n").filter(Boolean)) {
    let p; try { p = JSON.parse(line); } catch { continue; }
    for (const rec of (Array.isArray(p) ? p : [p])) {
      const e = rec?.contractEntry?.JsActiveContract?.createdEvent;
      for (const v of (e?.interfaceViews || [])) {
        const vv = v?.viewValue; if (!vv) continue;
        // capture instrument + amount in whatever shape the view uses
        const legs = vv.transferLegs || {};
        const legKeys = Object.keys(legs);
        if (legKeys.length) {
          for (const k of legKeys) {
            out.push({ cid: (e.contractId||"").slice(0,16),
              inst: legs[k].instrumentId?.id, amt: legs[k].amount,
              off: e.offset });
          }
        } else {
          out.push({ cid: (e.contractId||"").slice(0,16),
            inst: vv.instrumentId?.id || vv.instrument, amt: vv.amount, off: e.offset });
        }
      }
    }
  }
  return out;
}

(async () => {
  console.log("Baseline (run a cETH swap in the UI now)...");
  const base = {
    REQ: new Set((await allocs(REQ)).map(a => a.cid)),
    D1:  new Set((await allocs(D1)).map(a => a.cid)),
    D2:  new Set((await allocs(D2)).map(a => a.cid)),
  };
  console.log("baseline counts -> REQ:", base.REQ.size, "D1:", base.D1.size, "D2:", base.D2.size);
  console.log("watching 300s (5min) for NEW allocations on any party...\n");

  const seen = new Set();
  const hb = new Set();
  const t0 = Date.now();
  while (Date.now() - t0 < 300000) {
    for (const [label, party, bset] of [["REQ",REQ,base.REQ],["D1",D1,base.D1],["D2",D2,base.D2]]) {
      let list; try { list = await allocs(party); } catch { continue; }
      for (const a of list) {
        if (!bset.has(a.cid) && !seen.has(a.cid)) {
          seen.add(a.cid);
          const t = ((Date.now()-t0)/1000).toFixed(1);
          console.log(`[+${t}s] NEW on ${label}: inst=${a.inst} amt=${JSON.stringify(a.amt)} off=${a.off} cid=${a.cid}`);
        }
      }
    }
    const el = Math.floor((Date.now()-t0)/1000);
    if (el > 0 && el % 15 === 0 && !hb.has(el)) { hb.add(el); console.log(`  ...watching (${el}s elapsed, ${seen.size} new seen)`); }
    await new Promise(z => setTimeout(z, 250));
  }
  console.log("\n--- done. If a cETH allocation flashed then vanished, you'll see it above with a rails-cethMain inst.");
  console.log("If NOTHING cETH appeared at all, the dealer cETH leg never committed (not a matcher miss).");
})().catch(e => console.log("ERR", e.message));
