require("dotenv").config();
const crypto=require("crypto");
const { ledgerFetch } = require("./token");
const CETH_ADMIN="rails-cethMain-1-dev::12200b6de051e66bacd250de4bc76292e9d0ef71b478d7c11e49799b8e26f853493e";
const REGISTRY=process.env.REGISTRY_URL||"https://api.utilities.digitalasset-dev.com";
const USER_ID=process.env.LEDGER_USER_ID||"6";
const SYNC=process.env.SYNCHRONIZER_ID||"global-domain::1220be58c29e65de40bf273be1dc2b266d43a9a002ea5b18955aeef7aac881bb471a";
const AF_IFACE="#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory";
(async()=>{
  const fs=require("fs");
  const store=JSON.parse(fs.readFileSync("./ext-parties.local.txt","utf8"));
  const dealer=store.dealer1, dp=dealer.partyId, rp=store.requester.partyId;
  const end=async()=>(await (await ledgerFetch("/v2/state/ledger-end",{method:"GET"})).json()).offset;
  // find dealer cETH holding
  const o0=await end();
  const hb={activeAtOffset:o0,verbose:false,filter:{filtersByParty:{[dp]:{cumulative:[{identifierFilter:{InterfaceFilter:{value:{interfaceId:"#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding",includeInterfaceView:true}}}}]}}}};
  const hr=await ledgerFetch("/v2/state/active-contracts",{method:"POST",body:JSON.stringify(hb)});
  let cid=null;
  for(const l of (await hr.text()).trim().split("\n").filter(Boolean)){try{const o=JSON.parse(l);for(const rec of(Array.isArray(o)?o:[o])){const e=rec?.contractEntry?.JsActiveContract?.createdEvent;for(const v of(e?.interfaceViews||[])){const inst=v?.viewValue?.instrumentId;if(inst&&inst.admin===CETH_ADMIN&&/eth/i.test(inst.id)&&!cid)cid=e.contractId;}}}catch(x){}}
  console.log("cETH cid:",cid?cid.slice(0,20):"NONE");
  // build allocate args + fetch factory context
  const now=new Date(),iso=d=>d.toISOString();
  const mkArgs=ctx=>({expectedAdmin:CETH_ADMIN,allocation:{settlement:{executor:dp,settlementRef:{id:"ex-"+Date.now(),cid:null},requestedAt:iso(now),allocateBefore:iso(new Date(now.getTime()+9e5)),settleBefore:iso(new Date(now.getTime()+18e5)),meta:{values:{}}},transferLegId:"want-leg",transferLeg:{sender:dp,receiver:rp,amount:"0.169",instrumentId:{admin:CETH_ADMIN,id:"cETH"},meta:{values:{}}}},requestedAt:iso(now),inputHoldingCids:[cid],extraArgs:{context:ctx||{values:{}},meta:{values:{}}}});
  const regUrl=REGISTRY+"/api/token-standard/v0/registrars/"+CETH_ADMIN+"/allocation-instruction/v1/allocation-factory";
  const fr=await fetch(regUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({choiceArguments:mkArgs({values:{}}),excludeDebugFields:true})});
  console.log("factory HTTP:",fr.status);
  const ft=await fr.text();
  if(!fr.ok){console.log("FACTORY ERROR:",ft.slice(0,400));return;}
  const fc=JSON.parse(ft);
  const ctx=(fc.choiceContext&&fc.choiceContext.choiceContextData)||{values:{}};
  const disc=((fc.choiceContext&&fc.choiceContext.disclosedContracts)||[]).map(d=>({templateId:d.templateId,contractId:d.contractId,createdEventBlob:d.createdEventBlob,synchronizerId:d.synchronizerId||""}));
  console.log("factoryId:",fc.factoryId?fc.factoryId.slice(0,20):"NONE","| disclosed:",disc.length);
  // prepare
  const cmds=[{ExerciseCommand:{templateId:AF_IFACE,contractId:fc.factoryId,choice:"AllocationFactory_Allocate",choiceArgument:mkArgs(ctx)}}];
  const pr=await ledgerFetch("/v2/interactive-submission/prepare",{method:"POST",body:JSON.stringify({userId:USER_ID,actAs:[dp],commandId:"ex-"+Date.now(),synchronizerId:SYNC,packageIdSelectionPreference:[],commands:cmds,disclosedContracts:disc})});
  console.log("PREPARE HTTP:",pr.status);
  const pt=await pr.text();
  if(!pr.ok){console.log("PREPARE ERROR:",pt.slice(0,500));return;}
  const prep=JSON.parse(pt);
  const priv=crypto.createPrivateKey({key:Buffer.from(dealer.privDer,"base64"),format:"der",type:"pkcs8"});
  const sig=crypto.sign(null,Buffer.from(prep.preparedTransactionHash,"base64"),priv).toString("base64");
  const ex=await ledgerFetch("/v2/interactive-submission/execute",{method:"POST",body:JSON.stringify({preparedTransaction:prep.preparedTransaction,hashingSchemeVersion:prep.hashingSchemeVersion,submissionId:"ex-"+Date.now(),userId:USER_ID,deduplicationPeriod:{Empty:{}},partySignatures:{signatures:[{party:dp,signatures:[{format:"SIGNATURE_FORMAT_RAW",signature:sig,signedBy:dealer.fingerprint,signingAlgorithmSpec:"SIGNING_ALGORITHM_SPEC_ED25519"}]}]}})});
  console.log("EXECUTE HTTP:",ex.status);
  console.log("EXECUTE BODY:",(await ex.text()).slice(0,400));
})().catch(e=>console.log("ERR",e.message));
