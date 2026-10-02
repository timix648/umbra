const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');
const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
function setup(selected,fail=false){
 const calls=[];const adapters={};for(const id of ['loop','partylayer'])adapters[id]={get:()=>({id}),init:async()=>{calls.push(id);if(fail&&id==='partylayer')throw new Error('selected failed');}};
 const c={adapters,ORDER:['loop','partylayer'],localStorage:{getItem:()=>selected},initing:null,picked:null};
 vm.createContext(c);const a=html.indexOf('  const ensure = () =>');const b=html.indexOf('  // A Wallet from listAccounts()',a);vm.runInContext(html.slice(a,b)+';this.run=ensure;',c);return {c,calls};
}
test('explicit PartyLayer choice cannot be replaced by present Loop',async()=>{const {c,calls}=setup('partylayer');assert.equal((await c.run()).id,'partylayer');assert.deepEqual(calls,['partylayer']);});
test('explicit wallet failure does not silently connect a different wallet',async()=>{const {c,calls}=setup('partylayer',true);await assert.rejects(c.run(),/selected failed/);assert.deepEqual(calls,['partylayer']);});
test('without a saved choice discovery still works',async()=>{const {c}=setup(null);assert.equal((await c.run()).id,'loop');});
test('picker offers Console with honest verification scope and selected routing',()=>{
 const picked=[];const c={useState:()=>[[],()=>{}],useEffect:()=>{},React:{createElement:(type,props,...children)=>({type,props,children})},LoopMark:()=>{}};
 vm.createContext(c);const a=html.indexOf('function WalletPicker('),b=html.indexOf('function WalletConnect(',a);vm.runInContext(html.slice(a,b),c);
 const tree=c.WalletPicker({busy:false,onPick:(...v)=>picked.push(v),onClose:()=>{}});const all=[];function walk(n){if(n&&typeof n==='object'){all.push(n);(n.children||[]).flat().forEach(walk);}}walk(tree);
 const consoleButton=all.find(n=>n.type==='button'&&JSON.stringify(n.children).includes('Continue with Console'));
 assert.ok(consoleButton);assert.match(JSON.stringify(consoleButton),/Full trade pending/);consoleButton.props.onClick();assert.deepEqual(picked,[['partylayer','console']]);
});
test('all inline application scripts and redesign bundle parse',()=>{
 for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){if(match[1].trim())new vm.Script(match[1]);}
 new vm.Script(fs.readFileSync(path.join(__dirname,'../public/umbra-redesign.js'),'utf8'));
});
