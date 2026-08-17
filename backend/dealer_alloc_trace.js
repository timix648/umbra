require("dns").setDefaultResultOrder("ipv4first");
require("dotenv").config();
const { ledgerFetch } = require("./token");

const CETH_ADMIN = "rails-cethMain-1-dev::12200b6de051e66bacd250de4bc76292e9d0ef71b478d7c11e49799b8e26f853493e";
const REGISTRY = process.env.REGISTRY_URL || "https://api.utilities.digitalasset-dev.com";

(async () => {
  const fs = require("fs");
  const store = JSON.parse(fs.readFileSync("./ext-parties.local.txt", "utf8"));
  const dealer = store.dealer1;
  if (!dealer) { console.log("no dealer1; keys:", Object.keys(store)); return; }
  const dealerParty = dealer.partyId;
  console.log("dealer1:", dealerParty.slice(0,40));
  console.log("has privDer:", !!dealer.privDer, "| has fingerprint:", !!dealer.fingerprint);

  const off = (await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
  const hbody = { activeAtOffset: off, verbose:false, filter:{filtersByParty:{[dealerParty]:{cumulative:[{identifierFilter:{InterfaceFilter:{value:{interfaceId:"#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",includeInterfaceView:true}}}}]}}}};
  const hr = await ledgerFetch("/v2/state/active-contracts",{method:"POST",body:JSON.stringify(hbody)});
  let cethCid=null, cethAmt=null;
  for (const l of (await hr.text()).trim().split("\n").filter(Boolean)) {
    try { const o=JSON.parse(l); for (const rec of (Array.isArray(o)?o:[o])) {
      const e=rec?.contractEntry?.JsActiveContract?.createdEvent;
      for (const v of (e?.interfaceViews||[])) {
        const inst=v?.viewValue?.instrumentId;
        if (inst && inst.admin===CETH_ADMIN && /eth/i.test(inst.id)) {
          if(!cethCid){cethCid=e.contractId;cethAmt=v.viewValue.amount;}
        }
      }
    }} catch(x){}
  }
  console.log("dealer1 real cETH holding:", cethCid?cethCid.slice(0,20):"NONE", "amt:", cethAmt);
  if (!cethCid) { console.log("dealer1 has no real cETH - can't trace."); return; }

  console.log("\n--- calling /api/real/allocate for dealer cETH want-leg ---");
  const r = await fetch("http://localhost:"+(process.env.PORT||4000)+"/api/real/allocate", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      senderRole:"dealer1", receiverRole:"requester",
      admin: CETH_ADMIN, id:"cETH", amount:"0.169",
      holdingCids:[cethCid], settleId:"trace-"+Date.now(), legId:"want-leg",
      registry: REGISTRY,
    }),
  });
  const txt = await r.text();
  console.log("HTTP", r.status);
  console.log("BODY:", txt.slice(0,500));

  console.log("\n--- polling 8s to see if it committed ---");
  for (let i=0;i<8;i++){
    const off2=(await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
    const abody={activeAtOffset:off2,verbose:false,filter:{filtersByParty:{[dealerParty]:{cumulative:[{identifierFilter:{InterfaceFilter:{value:{interfaceId:"#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation",includeInterfaceView:true}}}}]}}}};
    const ar=await ledgerFetch("/v2/state/active-contracts",{method:"POST",body:JSON.stringify(abody)});
    let c=0;
    for(const l of (await ar.text()).trim().split("\n").filter(Boolean)){try{const o=JSON.parse(l);for(const rec of(Array.isArray(o)?o:[o])){const e=rec?.contractEntry?.JsActiveContract?.createdEvent;const leg=e?.interfaceViews?.[0]?.viewValue?.allocation?.transferLeg;if(leg?.instrumentId?.admin===CETH_ADMIN)c++;}}catch(x){}}
    console.log("  ["+i+"] dealer real cETH allocations:", c);
    if(c>0){console.log("  -> COMMITTED (matcher/timing issue, not commit failure)");break;}
    await new Promise(z=>setTimeout(z,1500));
  }
  console.log("\nHTTP 500 -> the BODY above is the real error.");
  console.log("HTTP 200 + 0 allocations -> dealer submit accepts but never commits (the bug).");
})().catch(e=>console.log("ERR",e.message));
