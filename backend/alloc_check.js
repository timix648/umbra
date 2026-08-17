require("dotenv").config();
const { ledgerFetch } = require("./token");
(async () => {
  const party = "requester-1783890522020::122098dc9bd952af179cc1b8226cb08c506c75cb5c7069defd2fd934c2951cf1166d";
  const off = (await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
  const body = { activeAtOffset: off, verbose:false, filter:{ filtersByParty:{ [party]:{ cumulative:[{ identifierFilter:{ InterfaceFilter:{ value:{ interfaceId:"#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation", includeInterfaceView:true } } } }] } } } };
  const r = await ledgerFetch("/v2/state/active-contracts",{method:"POST",body:JSON.stringify(body)});
  const lines = (await r.text()).trim().split("\n").filter(Boolean);
  console.log("allocations:", lines.length);
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch(e){ continue; }
    for (const rec of (Array.isArray(o)?o:[o])) {
      const e = rec?.contractEntry?.JsActiveContract?.createdEvent;
      for (const v of (e?.interfaceViews||[])) {
        const tl = v?.viewValue?.allocation?.transferLeg;
        if (!tl) continue;
        console.log("  id:", tl.instrumentId?.id, "| amount:", JSON.stringify(tl.amount), "| ref:", v.viewValue.allocation.settlement.settlementRef.id);
      }
    }
  }
})().catch(e => console.log("ERR", e.message));
