require("dotenv").config();
const { ledgerFetch } = require("./token");
const CETH_ADMIN="rails-cethMain-1-dev::12200b6de051e66bacd250de4bc76292e9d0ef71b478d7c11e49799b8e26f853493e";
const REGISTRY=process.env.REGISTRY_URL||"https://api.utilities.digitalasset-dev.com";
const USER_ID=process.env.LEDGER_USER_ID||"6";
const end=async()=>(await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
(async()=>{
  const fs=require("fs");
  const store=JSON.parse(fs.readFileSync("./ext-parties.local.txt","utf8"));
  const dp=store.dealer1.partyId;
  const o0=await end();
  const hb={activeAtOffset:o0,verbose:false,filter:{filtersByParty:{[dp]:{cumulative:[{identifierFilter:{InterfaceFilter:{value:{interfaceId:"#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",includeInterfaceView:true}}}}]}}}};
  const hr=await ledgerFetch("/v2/state/active-contracts",{method:"POST",body:JSON.stringify(hb)});
  let cid=null;
  for(const l of (await hr.text()).trim().split("\n").filter(Boolean)){try{const o=JSON.parse(l);for(const rec of(Array.isArray(o)?o:[o])){const e=rec?.contractEntry?.JsActiveContract?.createdEvent;for(const v of(e?.interfaceViews||[])){const inst=v?.viewValue?.instrumentId;if(inst&&inst.admin===CETH_ADMIN&&/eth/i.test(inst.id)&&!cid)cid=e.contractId;}}}catch(x){}}
  if(!cid){console.log("no dealer cETH");return;}
  const begin=await end();
  console.log("begin offset:",begin,"| submitting dealer cETH allocation...");
  const r=await fetch("http://localhost:"+(process.env.PORT||4000)+"/api/real/allocate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({senderRole:"dealer1",receiverRole:"requester",admin:CETH_ADMIN,id:"cETH",amount:"0.169",holdingCids:[cid],settleId:"ct-"+Date.now(),legId:"want-leg",registry:REGISTRY})});
  console.log("allocate HTTP:",r.status,(await r.text()).slice(0,90));
  for(let i=0;i<8;i++){
    await new Promise(z=>setTimeout(z,1500));
    const cr=await ledgerFetch("/v2/commands/completions",{method:"POST",body:JSON.stringify({userId:USER_ID,parties:[dp],beginExclusive:begin})});
    const t=await cr.text();
    for(const l of t.trim().split("\n").filter(Boolean)){
      try{const arr=JSON.parse(l);for(const item of(Array.isArray(arr)?arr:[arr])){
        const c=item?.completionResponse?.Completion?.value||item?.completionResponse?.completion||item?.completion;
        if(c&&c.commandId){
          console.log("\nCOMPLETION:");
          console.log("  commandId:",c.commandId);
          console.log("  updateId:",c.updateId||"(NONE - rejected)");
          console.log("  status:",JSON.stringify(c.status||c.statusV2));
        }
      }}catch(x){}
    }
  }
  console.log("\n(status with code!=0 or a message = the rejection reason)");
})().catch(e=>console.log("ERR",e.message));
