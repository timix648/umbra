require("dotenv").config();
const { ledgerFetch } = require("./token");
(async()=>{
  const fs=require("fs");
  const store=JSON.parse(fs.readFileSync("./ext-parties.local.txt","utf8"));
  const dealerParty=store.dealer1.partyId;
  const end=(await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
  const USER_ID=process.env.LEDGER_USER_ID||"6";
  // try the completions endpoint with a few likely shapes
  const shapes=[
    {userId:USER_ID,parties:[dealerParty],beginExclusive:Math.max(0,end-50)},
    {userId:USER_ID,parties:[dealerParty],beginExclusive:{Absolute:Math.max(0,end-50)}},
    {applicationId:USER_ID,parties:[dealerParty],beginExclusive:Math.max(0,end-50)},
  ];
  for(const [i,body] of shapes.entries()){
    const r=await ledgerFetch("/v2/commands/completions",{method:"POST",body:JSON.stringify(body)});
    const t=await r.text();
    console.log("shape",i,"-> HTTP",r.status,"|",t.slice(0,160).replace(/\n/g," "));
  }
})().catch(e=>console.log("ERR",e.message));
