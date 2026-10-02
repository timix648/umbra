const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const code = html.slice(html.indexOf('  async function primaryOf('), html.indexOf('  let cust = null;'));
function subject(account, walletId = 'console') {
  const context = { window: { ConsoleWallet: { getPrimaryAccount: async () => account } },
    consoleWalletSdk: async () => context.window.ConsoleWallet, activeWalletId: async () => walletId, rawKeyB64: k => { if (k !== 'public-key') throw new Error('invalid key'); return 'normalized-key'; } };
  vm.createContext(context); vm.runInContext(code, context); return context.primaryOf;
}
const base = { id: 'partylayer', accounts: async () => [] };
const session = { getActiveSession: async () => ({ walletId: 'console', partyId: 'party-A' }) };
test('Console key is recovered when PartyLayer session omits it', async () => {
  const result = await subject({partyId: 'party-A', publicKey: 'public-key'})(base, session);
  assert.equal(result.partyId, 'party-A'); assert.equal(result.pub, 'normalized-key');
});
test('Console account drift cannot associate another key with the session', async () => {
  await assert.rejects(subject({partyId: 'party-B', publicKey: 'public-key'})(base, session), /account changed/);
});
test('missing Console key remains unavailable', async () => {
  assert.equal((await subject({partyId: 'party-A'})(base, session)).pub, null);
});
test('malformed Console key is rejected', async () => {
  await assert.rejects(subject({partyId: 'party-A',publicKey: 'bad'})(base, session), /invalid key/);
});
test('other wallet adapters keep their own account lookup', async () => {
  const result = await subject(null, 'other')({id:'other',accounts:async()=>[]}, {getPrimaryAccount:async()=>({partyId:'party-C',publicKey:'public-key'})});
  assert.equal(result.partyId,'party-C'); assert.equal(result.pub,'normalized-key');
});

const loaderCode = html.slice(html.indexOf('  let consoleSdkLoading = null;'), html.indexOf('  async function primaryOf('));
test('Console SDK loads on demand, shares concurrent loads and exports the SDK', async () => {
  let loads = 0, script;
  const context = {window:{}, document:{createElement:()=>({remove(){}}),head:{appendChild:s=>{loads++;script=s;}}}};
  vm.createContext(context); vm.runInContext(loaderCode,context);
  assert.equal(loads,0);
  const a=context.consoleWalletSdk(), b=context.consoleWalletSdk();
  assert.equal(loads,1); assert.equal(script.src,'/console-wallet-sdk.js');
  const sdk={getPrimaryAccount:async()=>({})}; context.window.ConsoleWalletSDK={consoleWallet:sdk};script.onload();
  assert.equal(await a,sdk);assert.equal(await b,sdk);assert.equal(context.window.ConsoleWallet,sdk);
});
test('Console SDK load failure can be retried', async () => {
  let loads=0, script;
  const context={window:{},document:{createElement:()=>({remove(){}}),head:{appendChild:s=>{loads++;script=s;}}}};
  vm.createContext(context);vm.runInContext(loaderCode,context);
  const first=context.consoleWalletSdk();script.onerror();await assert.rejects(first,/could not be loaded/);
  const second=context.consoleWalletSdk();assert.equal(loads,2);
  context.window.ConsoleWalletSDK={consoleWallet:{getPrimaryAccount:async()=>({})}};script.onload();await second;
});
