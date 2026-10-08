const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const helper = html.slice(html.indexOf('function fundingSameParty('), html.indexOf('function Funding('));
const holding = (contractId, amount, extra = {}) => ({contractId, amount, admin:'issuer', id:'Amulet', ...extra});
function setup(extra = {}) { const c = {...extra}; vm.createContext(c); vm.runInContext(helper, c); return c; }

test('withdrawal combines holdings when total covers an amount larger than every individual lot', () => {
  const c = setup();
  const selected = c.fundingInputs([holding('a','18000'),holding('b','14000'),holding('c','9913.941532')], 'issuer','Amulet','41494.8021167');
  assert.deepEqual(Array.from(selected,h=>h.contractId), ['a','b','c']);
});
test('single smallest covering input remains preferred', () => {
  const c = setup();
  assert.deepEqual(Array.from(c.fundingInputs([holding('a','9'),holding('b','6'),holding('c','2')],'issuer','Amulet','5'),h=>h.contractId),['b']);
});
test('locked funds, another issuer, another asset and duplicate CIDs cannot pad a balance', () => {
  const c=setup();
  const rows=[holding('a','2'),holding('a','2'),holding('lock','100',{lock:{}}),holding('other','100',{admin:'other'}),holding('btc','100',{id:'CBTC'})];
  assert.throws(()=>c.fundingInputs(rows,'issuer','Amulet','3'),/Not enough unlocked/);
});
test('selection preserves decimal precision and rejects insufficient totals', () => {
  const c=setup();
  assert.equal(c.fundingInputs([holding('a','0.1'),holding('b','0.2')],'issuer','Amulet','0.3').length,2);
  assert.throws(()=>c.fundingInputs([holding('a','0.1'),holding('b','0.2')],'issuer','Amulet','0.3000000001'),/Not enough/);
  for(const amount of ['0','-1','NaN','Infinity','0.00000000001']) assert.throws(()=>c.fundingInputs([],'issuer','Amulet',amount));
});
function withdrawal({dest='recipient::1',committed=true,raw=[holding('a','2'),holding('b','3')]}={}) {
  const messages=[],calls=[];
  const c=setup({busy:'',party:'sender::1',raw,regAssets:[{symbol:'Amulet',admin:'issuer'}],ledgerSym:()=> 'Amulet',
    say:(...x)=>messages.push(x),setBusy:()=>{},post:async(url,body)=>{calls.push(body);return {commands:[],disclosedContracts:[]};},
    WalletLink:{submit:async()=>({committed})},load:async()=>{},onChanged:null});
  const start=html.indexOf('  const withdraw = async (w) => {',html.indexOf('function Funding('));
  const end=html.indexOf('  // Deposit started here',start);
  vm.runInContext(html.slice(start,end)+';this.withdraw=withdraw;',c);
  return {run:()=>c.withdraw({asset:'CC',amount:'4',dest}),messages,calls};
}
test('self-withdrawal is stopped before building or signing a transaction',async()=>{
  const t=withdrawal({dest:' sender::1 '});await t.run();assert.equal(t.calls.length,0);assert.match(t.messages[0][0],/not a withdrawal destination/);
});
test('withdrawal sends selected input list and keeps the chosen recipient and amount',async()=>{
  const t=withdrawal();await t.run();assert.deepEqual(Array.from(t.calls[0].holdingCids),['b','a']);assert.equal(t.calls[0].receiver,'recipient::1');assert.equal(t.calls[0].amount,'4');
});
test('accepted without a commit is reported as pending, never confirmed',async()=>{
  const t=withdrawal({committed:false});await t.run();assert.match(t.messages[0][0],/confirmation is still pending/);assert.doesNotMatch(t.messages[0][0],/Transfer confirmed/);
});
test('wallet wrapper does not convert HTTP acceptance into a committed result',async()=>{
  const c={post:async url=>url.endsWith('/prepare')?{commandId:'test',preparedTransactionHash:'hash'}:{ok:true,committed:false},window:{UmbraTxVerify:{verifyPrepared:async()=>{}},CantonTx:{}}};
  vm.createContext(c);const a=html.indexOf('  async function custodySubmit('),b=html.indexOf('  // The connected wallet',a);vm.runInContext(html.slice(a,b),c);
  const r=await c.custodySubmit('sender::1',async()=> 'signature',{commands:[]},'console');assert.equal(r.committed,false);
});
test('Console blocks a deposit to the same party before asking the wallet to submit',async()=>{
  let sent=false;const c={cust:{funding:'console',home:'same::1'},consoleWalletSdk:async()=>({getPrimaryAccount:async()=>({partyId:'same::1'}),getActiveNetwork:async()=>({id:'CANTON_NETWORK_DEV'}),submitCommands:async()=>{sent=true;}})};
  vm.createContext(c);vm.runInContext(html.slice(html.indexOf('  async function consoleFundingContext()'),html.indexOf('  const custodial =')),c);
  await assert.rejects(c.consoleDeposit({recipient:'same::1',amount:'1',id:'Amulet'}),/No deposit is needed/);assert.equal(sent,false);
});
test('funding UI disables self-withdrawals and explains identical deposit accounts',()=>{
  function render(mode){let stateIndex=0;const initial=[mode,'CC','1','same::1',false,false];
    const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState:value=>[stateIndex<initial.length?initial[stateIndex++]:value,()=>{}],useEffect:()=>{}};
    const c={window:{React}};vm.createContext(c);vm.runInContext(fs.readFileSync(path.join(__dirname,'../public/umbra-redesign.js'),'utf8'),c);
    return c.window.UmbraRedesign.FundingPanel({homeParty:'same::1',umbraParty:'same::1',mode,canDeposit:true,balances:{CC:20},walletBalances:{CC:20}});
  }
  assert.match(JSON.stringify(render('deposit')),/No deposit is needed/);
  const nodes=[];function walk(x){if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(walk);return;}nodes.push(x);(x.children||[]).forEach(walk);}walk(render('withdraw'));
  const btn=nodes.find(n=>n.type==='button'&&n.children.includes('Send from Umbra'));assert.ok(btn);assert.equal(btn.props.disabled,true);
});
