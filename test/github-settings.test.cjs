'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
function page({saved=false, host=false, fail=false, locale='zh-CN'}={}) {
  const nodes = new Map(); const calls=[]; const messages=[];
  const get = id => {
    if (!nodes.has(id)) nodes.set(id,{value:'',disabled:false,textContent:'',hidden:false,dataset:{},style:{},events:{},addEventListener(k,f){this.events[k]=f;},replaceChildren(){}});
    return nodes.get(id);
  };
  let stored=saved;
  const context={Map,Date,Promise,window:{addEventListener(){}},document:{addEventListener(){},documentElement:{},getElementById:get,querySelectorAll:()=>[],createElement:()=>get('button')},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},BroadcastChannel:class {postMessage(m){messages.push(m);}},fetch:async(url,opts)=>{
    calls.push({url,opts});
    if(url==='/app-context') return {json:async()=>({context:{uiLocale:locale}})};
    if(url==='/secrets') return {ok:true,json:async()=>[{key:'github_token',saved:stored,hostAvailable:host,tail:stored?'1234':undefined}]};
    if(url==='/secrets/github_token') {if(!fail) stored=opts.method==='PUT';return {ok:!fail};}
    return {ok:true};
  }};
  vm.runInNewContext(fs.readFileSync(path.join(root,'settings.js'),'utf8'),context);
  return {get,calls,messages,settle:()=>new Promise(setImmediate)};
}
test('password submission goes only to secret endpoint, clears input, refreshes status',async()=>{
  const p=page();await p.settle();p.get('github-token').value='test-token-never-broadcast';
  p.get('github-form').events.submit({preventDefault(){}});await p.settle();
  assert.equal(p.get('github-token').value,'');assert.equal(p.get('github-clear').disabled,false);
  assert.match(p.get('github-status').textContent,/1234/);
  assert.equal(p.calls.filter(x=>x.url==='/secrets/github_token').length,1);
  assert.ok(!JSON.stringify(p.messages).includes('test-token'));
  assert.ok(!p.calls.some(x=>x.url==='/kv'));
});
test('clear removes backup and retains local login status',async()=>{
  const p=page({saved:true,host:true});await p.settle();p.get('github-clear').events.click();await p.settle();
  assert.equal(p.get('github-clear').disabled,true);assert.match(p.get('github-status').textContent,/本机 GitHub 登录/);
  assert.equal(p.calls.find(x=>x.url==='/secrets/github_token').opts.method,'DELETE');
});
test('failed save is shown without claiming success or retaining input',async()=>{
  const p=page({fail:true,locale:'en'});await p.settle();p.get('github-token').value='dummy';p.get('github-form').events.submit({preventDefault(){}});await p.settle();
  assert.match(p.get('github-feedback').textContent,/failed/);assert.equal(p.get('github-token').value,'');assert.equal(p.get('github-save').disabled,false);
});
test('empty token does not overwrite saved credential',async()=>{
  const p=page({saved:true});await p.settle();p.get('github-form').events.submit({preventDefault(){}});await p.settle();
  assert.ok(!p.calls.some(x=>x.url==='/secrets/github_token'));assert.equal(p.get('github-clear').disabled,false);
});
test('HTTP authentication, rate limit, network failure and successful release are distinct',async()=>{
  const code=fs.readFileSync(path.join(root,'main.js'),'utf8').split('cindy.onHostMessage(')[0];
  let response;const ctx={BroadcastChannel:class {},cindy:{fetch:async()=>response}};vm.createContext(ctx);vm.runInContext(code,ctx);
  for(const [status,body,expected] of [[401,'','GITHUB_AUTH_FAILED'],[403,'API rate limit exceeded','GITHUB_RATE_LIMITED'],[403,'Forbidden','GITHUB_AUTH_FAILED'],[429,'','GITHUB_RATE_LIMITED'],[500,'','NETWORK_FAILED']]) {
    response={ok:true,status,body};await assert.rejects(ctx.installerSizeFromApi({version:'0.1.17',assetName:'installer'}),e=>e.errorCode===expected);
  }
  response={ok:true,status:200,body:JSON.stringify({assets:[{name:'installer',size:100}]})};assert.equal(await ctx.installerSizeFromApi({version:'0.1.17',assetName:'installer'}),100);
});
