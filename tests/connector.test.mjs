import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addonOptions} from '../cozywash_bridge/options.mjs';
import {ShellyAdapter} from '../cozywash_bridge/bridge/shelly.mjs';
import {startBridge} from '../cozywash_bridge/bridge/runtime.mjs';
const valid=()=>({server_url:'https://cozywash.ro/',bridge_token:'a'.repeat(43),allow_hardware:false,shelly_devices:[]});
test('HA options produce HTTPS configuration and an explicit private-IP and password mapping',()=>{
 const input={...valid(),allow_hardware:true,shelly_devices:[{device_id:'shelly-1',host:'192.168.1.50',password:'test-password'},{device_id:'shelly-2',host:'172.20.0.5'}]};const out=addonOptions(input);assert.equal(out.origin,'https://cozywash.ro');assert.deepEqual(out.allowedHosts,['192.168.1.50','172.20.0.5']);assert.equal(out.passwords['shelly-1'],'test-password');assert.equal(Object.getPrototypeOf(out.passwords),null);assert.equal(out.token,input.bridge_token);
});
test('HA options reject unsafe URLs, credential-bearing URLs, invalid tokens and hardware without allowlist',()=>{
 for(const server_url of ['http://cozywash.ro','https://user:password@cozywash.ro','https://cozywash.ro/?token=secret','https://cozywash.ro/#secret','https://cozywash.ro/path','not-a-url'])assert.throws(()=>addonOptions({...valid(),server_url}));
 for(const bridge_token of ['', 'x'.repeat(31),'x'.repeat(257),'x'.repeat(40)+'\n'])assert.throws(()=>addonOptions({...valid(),bridge_token}));
 assert.throws(()=>addonOptions({...valid(),allow_hardware:true}),/shelly_devices_required/);assert.throws(()=>addonOptions({...valid(),allow_hardware:'true'}));
});
test('HA options reject public IPs, DNS, duplicate device mappings and invalid credentials',()=>{
 const device={device_id:'shelly',host:'192.168.1.50'};
 for(const host of ['8.8.8.8','127.0.0.1','169.254.1.2','shelly.local','192.168.1.50:80','192.168.1.50/','::1','192.168.1.999'])assert.throws(()=>addonOptions({...valid(),shelly_devices:[{...device,host}]}));
 assert.throws(()=>addonOptions({...valid(),shelly_devices:[device,{...device,host:'10.0.0.5'}]}),/duplicate/);assert.throws(()=>addonOptions({...valid(),shelly_devices:[device,{...device,device_id:'other'}]}),/duplicate/);assert.throws(()=>addonOptions({...valid(),shelly_devices:[{...device,password:42}]}));
});
const response=(data,status=200)=>({ok:status<300,status,json:async()=>data});
const waitFor=async check=>{const end=Date.now()+1500;while(!check()){if(Date.now()>end)throw Error('Condition timed out');await new Promise(r=>setTimeout(r,5));}};
function fakeEngine(){return {ticks:0,closed:false,executions:[],tasks:()=>[],async tick(){this.ticks++;},async readings(){return [];},async command(c){this.executions.push(c);return {ok:true,output:true,at:Date.now()};},reconcile(){},close(){this.closed=true;}};}
test('bridge keeps local safety ticks running during cloud outage and sanitizes errors',async()=>{
 const engine=fakeEngine(),logs=[];const bridge=startBridge({origin:'https://cozywash.test',token:'private-token',engine,tickInterval:5,syncInterval:10,log:x=>logs.push(x),fetchImpl:async()=>{throw Error('private-token Shelly-password');}});
 try{await waitFor(()=>engine.ticks>=3);const status=bridge.status();assert.equal(status.connected,false);assert.ok(status.lastLocalTick);assert.equal(status.running,true);assert.equal(logs.join(' ').includes('private-token'),false);assert.equal(logs.join(' ').includes('Shelly-password'),false);assert.equal(logs.length,1);}finally{await bridge.close();}assert.equal(engine.closed,true);const ticks=engine.ticks;await new Promise(r=>setTimeout(r,20));assert.equal(engine.ticks,ticks);
});
test('bridge rejects mismatched commands and refuses new activation with an invalid clock',async()=>{
 for(const drift of [0,60000]){const engine=fakeEngine();const machine={id:'m',deviceId:'d',channel:0,device:{host:'10.0.0.1'}};const command={id:'o:enable',action:'enable',machine:drift?machine:{...machine,channel:1}};
 const bridge=startBridge({origin:'https://cozywash.test',token:'token',engine,tickInterval:5,syncInterval:10,log:()=>{},fetchImpl:async url=>response(url.endsWith('/poll')?{serverTime:Date.now()+drift,machines:[machine],commands:[command]}:{orders:[]})});
 try{await waitFor(()=>engine.ticks>2);assert.equal(engine.executions.length,0);assert.equal(bridge.status().lastError,drift?'bridge_clock_out_of_sync':'mapping_mismatch');}finally{await bridge.close();}}
});
test('bridge retries synchronization, records health and preserves acknowledgement delivery',async()=>{
 const engine=fakeEngine();let polls=0,acks=0;const machine={id:'m',deviceId:'d',channel:0,device:{host:'10.0.0.1'}};
 const bridge=startBridge({origin:'https://cozywash.test',token:'token',engine,syncInterval:10,tickInterval:5,log:()=>{},fetchImpl:async(url,options)=>{
 assert.equal(options.headers.Authorization,'Bearer token');assert.equal(options.redirect,'error');if(url.endsWith('/poll')){if(++polls===1)return response({},401);return response({serverTime:Date.now(),machines:[machine],commands:acks?[]:[{id:'o:enable',action:'enable',machine}]});}if(url.endsWith('/ack')){acks++;return response({ok:true});}return response({orders:[]});}});
 try{await waitFor(()=>bridge.status().connected&&acks>0);assert.equal(bridge.status().machineCount,1);assert.equal(bridge.status().lastError,null);assert.ok(bridge.status().lastSync);}finally{await bridge.close();}
});

test('HA device IDs stay bound to their configured IP even when multiple devices are allowlisted',async()=>{
 const options=addonOptions({...valid(),allow_hardware:true,shelly_devices:[{device_id:'a',host:'192.168.1.50'},{device_id:'b',host:'192.168.1.51'}]});
 const adapter=new ShellyAdapter(options),machine={deviceId:'a',hardwareApproved:true,channel:0,device:{id:'a',host:'192.168.1.50',mode:'shelly'}};
 await adapter.qualify(machine);await assert.rejects(()=>adapter.qualify({...machine,device:{...machine.device,host:'192.168.1.51'}}),/device_mapping_mismatch/);
 await assert.rejects(()=>adapter.qualify({...machine,deviceId:'b'}),/device_mapping_mismatch/);
});
