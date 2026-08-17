require("dotenv").config();
const { ledgerFetch } = require("./token");
const fs = require("fs");
(async () => {
  const store = JSON.parse(fs.readFileSync("./ext-parties.local.txt", "utf8"));
  for (const role of ["requester","dealer1","dealer2"]) {
    const party = store[role] && store[role].partyId;
    if (!party) { console.log(role, "no party"); continue; }
    const off = (await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
    const body = { activeAtOffset: off, verbose:false, filter:{ filtersByParty:{ [party]:{ cumulative:[{ identifierFilter:{ InterfaceFilter:{ value:{ interfaceId:"#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding", includeInterfaceView:true } } } }] } } } };
    const r = await ledgerFetch("/v2/state/active-contracts",{method:"POST",body:JSON.stringify(body)});
    const lines = (await r.text()).trim().split("\n").filter(Boolean);
    const holds = {};
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch(e){ continue; }
      for (const rec of (Array.isArray(o)?o:[o])) {
        const e = rec?.contractEntry?.JsActiveContract?.createdEvent;
        for (const v of (e?.interfaceViews||[])) {
          const vv = v?.viewValue; if(!vv||!vv.instrumentId) continue;
          const key = vv.instrumentId.id + "@" + (vv.instrumentId.admin||"").slice(0,14);
          holds[key] = (holds[key]||0) + parseFloat(vv.amount||0);
        }
      }
    }
    console.log(role, "("+party.slice(0,20)+"):");
    for (const k in holds) console.log("   ", k, "=", holds[k]);
  }
})().catch(e => console.log("ERR", e.message));
