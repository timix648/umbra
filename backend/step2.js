require("dotenv").config();
const crypto=require("crypto");
const { ledgerFetch } = require("./token");
const CETH="rails-cethMain-1-dev::12200b6de051e66bacd250de4bc76292e9d0ef71b478d7c11e49799b8e26f853493e";
const BASE=process.env.REGISTRY_URL||"https://api.utilities.digitalasset-dev.com";
const USER_ID=process.env.LEDGER_USER_ID||"6";
const SYNC="global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
const AF_IFACE="#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
const CID="00d18ac99d554f01fbb8d23149a435889478f59ff4bba4f4123fb14f5d76af2e02ca121220b1198ea1b905704fde7eb516fc9eeacc79dba4d767663d5520b0255b632dbcc4";
(async()=>{
  const fs=require("fs");
  const store=JSON.parse(fs.readFileSync("./ext-parties.local.txt","utf8"));
  const dealer=store.dealer1, dp=dealer.partyId, rp=store.requester.partyId;
  const now=new Date(),iso=d=>d.toISOString();
  const mk=ctx=>({expectedAdmin:CETH,allocation:{settlement:{executor:dp,settlementRef:{id:"s2-"+Date.now(),cid:null},requestedAt:iso(now),allocateBefore:iso(new Date(now.getTime()+9e5)),settleBefore:iso(new Date(now.getTime()+18e5)),meta:{values:{}}},transferLegId:"want-leg",transferLeg:{sender:dp,receiver:rp,amount:"0.169",instrumentId:{admin:CETH,id:"cETH"},meta:{values:{}}}},requestedAt:iso(now),inputHoldingCids:[CID],extraArgs:{context:ctx||{values:{}},meta:{values:{}}}});
  const url=BASE+"/api/token-standard/v0/registrars/"+encodeURIComponent(CETH)+"/registry/allocation-instruction/v1/allocation-factory";
  const fr=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({choiceArguments:mk({values:{}}),excludeDebugFields:true})});
  const fc=JSON.parse(await fr.text());
  const ctx=(fc.choiceContext&&fc.choiceContext.choiceContextData)||{values:{}};
  const disc=((fc.choiceContext&&fc.choiceContext.disclosedContracts)||[]).map(d=>({templateId:d.templateId,contractId:d.contractId,createdEventBlob:d.createdEventBlob,synchronizerId:d.synchronizerId||""}));
  console.log("factory ok, disclosed:",disc.length,"factoryId:",fc.factoryId.slice(0,20));
  const cmds=[{ExerciseCommand:{templateId:AF_IFACE,contractId:fc.factoryId,choice:"AllocationFactory_Allocate",choiceArgument:mk(ctx)}}];
  const begin=(await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
  const pr=await ledgerFetch("/v2/interactive-submission/prepare",{method:"POST",body:JSON.stringify({userId:USER_ID,actAs:[dp],commandId:"s2-"+Date.now(),synchronizerId:SYNC,packageIdSelectionPreference:[],commands:cmds,disclosedContracts:disc})});
  console.log("PREPARE:",pr.status);
  const pt=await pr.text();
  if(!pr.ok){console.log("PREPARE BODY:",pt.slice(0,600));return;}
  const prep=JSON.parse(pt);
  const priv=crypto.createPrivateKey({key:Buffer.from(dealer.privDer,"base64"),format:"der",type:"pkcs8"});
  const sig=crypto.sign(null,Buffer.from(prep.preparedTransactionHash,"base64"),priv).toString("base64");
  const ex=await ledgerFetch("/v2/interactive-submission/execute",{method:"POST",body:JSON.stringify({preparedTransaction:prep.preparedTransaction,hashingSchemeVersion:prep.hashingSchemeVersion,submissionId:"s2-"+Date.now(),userId:USER_ID,deduplicationPeriod:{Empty:{}},partySignatures:{signatures:[{party:dp,signatures:[{format:"SIGNATURE_FORMAT_RAW",signature:sig,signedBy:dealer.fingerprint,signingAlgorithmSpec:"SIGNING_ALGORITHM_SPEC_ED25519"}]}]}})});
  console.log("EXECUTE:",ex.status,"BODY:",(await ex.text()).slice(0,300));
  for(let i=0;i<6;i++){
    await new Promise(z=>setTimeout(z,1500));
    const cr=await ledgerFetch("/v2/commands/completions",{method:"POST",body:JSON.stringify({userId:USER_ID,parties:[dp],beginExclusive:begin})});
    for(const l of (await cr.text()).trim().split("\n").filter(Boolean)){try{const arr=JSON.parse(l);for(const it of(Array.isArray(arr)?arr:[arr])){const c=it?.completionResponse?.Completion?.value;if(c){console.log("COMPLETION status:",JSON.stringify(c.status||c.statusV2),"update:",c.updateId||"(none)");}}}catch(x){}}
  }
})().catch(e=>console.log("ERR",e.message));
