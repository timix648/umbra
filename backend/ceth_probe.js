require("dotenv").config();
const { ledgerFetch } = require("./token");
(async () => {
  const party = "requester-1783890522020::122098dc9bd952af179cc1b8226cb08c506c75cb5c7069defd2fd934c2951cf1166d";
  const off = (await (await ledgerFetch("/v2/state/ledger-end", { method: "GET" })).json()).offset;
  const body = { activeAtOffset: off, verbose: false, filter: { filtersByParty: { [party]: { cumulative: [{ identifierFilter: { InterfaceFilter: { value: { interfaceId: "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation", includeInterfaceView: true } } } }] } } } };
  const r = await ledgerFetch("/v2/state/active-contracts", { method: "POST", body: JSON.stringify(body) });
  const lines = (await r.text()).trim().split("\n").filter(Boolean);
  console.log("total allocations visible to requester:", lines.length);
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch (e) { continue; }
    const arr = Array.isArray(o) ? o : [o];
    for (const rec of arr) {
      const e = rec && rec.contractEntry && rec.contractEntry.JsActiveContract && rec.contractEntry.JsActiveContract.createdEvent;
      if (!e || !e.interfaceViews) continue;
      for (const v of e.interfaceViews) {
        const tl = v && v.viewValue && v.viewValue.allocation && v.viewValue.allocation.transferLeg;
        if (!tl) continue;
        const id = tl.instrumentId && tl.instrumentId.id;
        const ref = v.viewValue.allocation.settlement.settlementRef.id;
        const sender = (tl.sender || "").slice(0, 22);
        console.log(" ", id, "amt:", tl.amount, "| leg:", v.viewValue.allocation.transferLegId, "| sender:", sender, "| ref:", ref);
      }
    }
  }
})().catch(e => console.log("ERR", e.message));
