const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const code = html.slice(html.indexOf('  async function consoleFundingContext()'), html.indexOf('  const custodial ='));
function setup({party='native-party', network='CANTON_NETWORK_DEV', result={status:true}}={}) {
  const calls=[];
  const cw={getPrimaryAccount:async()=>({partyId:party}),getActiveNetwork:async()=>({id:network}),
    getCoinsBalance:async p=>{calls.push(['read',p]);return {tokens:[{symbol:'CC',balance:'12.5'}],utxos:{CC:[{amount:'12.5'}]}}},
    submitCommands:async p=>{calls.push(['send',p]);return result}};
  const context={consoleWalletSdk:async()=>cw,cust:{funding:'console',home:'native-party'},dispSym:s=>s==='Amulet'?'CC':s};
  vm.createContext(context);vm.runInContext(code,context);return {context,calls};
}
test('Console balances query the native party and exclude duplicate UTXO totals',async()=>{
  const {context,calls}=setup();const res=await context.consoleWalletHoldings();
  assert.equal(calls[0][1].party,'native-party');assert.equal(calls[0][1].network,'CANTON_NETWORK_DEV');
  assert.equal(res.tokens[0].balance,'12.5');assert.equal(res.utxos,undefined);
});
test('Console deposit asks wallet to send from native party to Umbra',async()=>{
  const {context,calls}=setup();await context.consoleDeposit({recipient:'umbra-party',amount:'1.25',id:'Amulet'});
  assert.equal(calls.length,1);const p=calls[0][1];assert.equal(p.from,'native-party');assert.equal(p.to,'umbra-party');
  assert.equal(p.token,'CC');assert.equal(p.amount,'1.25');assert.ok(Date.parse(p.expireDate)>Date.now());
});
test('changed account blocks reads and deposits before any ledger action',async()=>{
  const {context,calls}=setup({party:'different-party'});
  await assert.rejects(context.consoleWalletHoldings(),/account changed/);
  await assert.rejects(context.consoleDeposit({recipient:'umbra',amount:1,id:'CC'}),/account changed/);assert.equal(calls.length,0);
});
test('wrong network blocks deposit',async()=>{
  const {context,calls}=setup({network:'CANTON_NETWORK'});
  await assert.rejects(context.consoleDeposit({recipient:'umbra',amount:1,id:'CC'}),/Devnet/);assert.equal(calls.length,0);
});
test('wallet rejection is never reported as a successful deposit',async()=>{
  for(const result of [undefined,{status:false}]) {
    const {context}=setup({result:result===undefined?null:result});
    await assert.rejects(context.consoleDeposit({recipient:'umbra',amount:1,id:'CC'}),/not submitted/);
  }
});
test('invalid amounts never reach wallet submission',async()=>{
  const {context,calls}=setup();
  for(const amount of [0,-1,'bad',Infinity]) await assert.rejects(context.consoleDeposit({recipient:'umbra',amount,id:'CC'}),/valid deposit/);
  assert.equal(calls.length,0);
});
const balanceCode=html.slice(html.indexOf('function walletBalancesOf('),html.indexOf('function Funding('));
test('Console totals and empty balances preserve unknown versus zero',()=>{
  const context={dispSym:s=>s};vm.createContext(context);vm.runInContext(balanceCode,context);
  assert.equal(context.walletBalancesOf({tokens:[{symbol:'CC',balance:'12.5'}]}).CC,12.5);
  assert.equal(Object.keys(context.walletBalancesOf({tokens:[]})).length,0);
  assert.equal(context.walletBalancesOf(null),null);
});
