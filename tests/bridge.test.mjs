import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeEngine } from '../cozywash_bridge/bridge/engine.mjs';
import { ShellyAdapter, digestHeader } from '../cozywash_bridge/bridge/shelly.mjs';
function fixture(mode='simulator',path=':memory:'){let now=100000,output=false,power=0,sets=0;const machine={id:'m',channel:0,hardwareApproved:true,startWatts:15,idleWatts:5,startConfirmSeconds:3,idleConfirmSeconds:30,minimumRunSeconds:30,device:{id:'d',host:'192.168.1.50',mode}};const adapter={qualify:async()=>{},read:async()=>({output,apower:power}),set:async(m,on)=>{sets++;output=on;}};const engine=new BridgeEngine({path,adapter,now:()=>now});const command={id:'o:enable',orderId:'o',action:'enable',machine,loadingSeconds:30,durationSeconds:1800,deadline:now+10000};return{engine,machine,command,advance:secs=>now+=secs*1000,power:p=>power=p,get sets(){return sets;},get output(){return output;},off:()=>output=false};}
test('duplicate delivery does not energize twice or extend lease',async()=>{const f=fixture();const first=await f.engine.command(f.command);f.advance(5);const repeated=await f.engine.command(f.command);assert.deepEqual(repeated,first);assert.equal(f.sets,1);assert.equal(f.engine.task('m').loadingDeadline,130000);f.engine.close();});
test('expired command never energizes',async()=>{const f=fixture();f.advance(11);const ack=await f.engine.command(f.command);assert.equal(ack.ok,false);assert.equal(ack.definitelyNotStarted,true);assert.equal(f.sets,0);f.engine.close();});
test('loading timeout switches off locally without a server connection',async()=>{const f=fixture();await f.engine.command(f.command);f.advance(31);await f.engine.tick();assert.equal(f.output,false);assert.equal(f.engine.task('m').phase,'loading_expired');f.engine.close();});
test('physical start at window boundary is confirmed without cutting power',async()=>{const f=fixture('shelly');await f.engine.command(f.command);f.advance(29);f.power(50);await f.engine.tick();f.advance(4);await f.engine.tick();assert.equal(f.engine.task('m').phase,'running');assert.equal(f.engine.task('m').startedAt,129000);assert.equal(f.output,true);f.engine.close();});
test('active cycle cannot be cut by an expired activation recovery command',async()=>{const f=fixture('shelly');await f.engine.command(f.command);f.power(50);await f.engine.tick();f.advance(4);await f.engine.tick();const ack=await f.engine.command({...f.command,id:'o:disable',action:'disable',reason:'activation_failed'});assert.equal(ack.ok,false);assert.equal(f.output,true);f.engine.close();});
test('estimated duration alone cannot cut a real washer, sustained qualified completion can',async()=>{const f=fixture('shelly');await f.engine.command(f.command);f.power(50);await f.engine.tick();f.advance(4);await f.engine.tick();f.advance(1801);await f.engine.tick();assert.equal(f.output,true);f.power(0);await f.engine.tick();f.advance(31);await f.engine.tick();assert.equal(f.output,false);assert.equal(f.engine.task('m').phase,'completed');f.engine.close();});
test('bridge restart retains command journal and verifies relay readback without replay',async()=>{const dir=mkdtempSync(join(tmpdir(),'cozywash-'));const path=join(dir,'state.sqlite');const f=fixture('shelly',path);const ack=await f.engine.command(f.command);f.engine.close();const adapter={read:async()=>({output:true,apower:0}),set:async()=>assert.fail('must not replay power'),qualify:async()=>{}};const engine=new BridgeEngine({path,adapter,now:()=>120000});assert.equal(engine.task('m').phase,'loading');assert.equal(engine.task('m').recovering,true);assert.deepEqual(await engine.command(f.command),ack);await engine.tick();assert.equal(engine.task('m').recovering,false);assert.equal(engine.task('m').activatedAt,ack.at);engine.close();rmSync(dir,{recursive:true});});
test('safety gate requires commissioning and exact private-IP allowlist',async()=>{const adapter=new ShellyAdapter({allowHardware:true,allowedHosts:['192.168.1.50']});await assert.rejects(()=>adapter.qualify({channel:0,hardwareApproved:false,device:{mode:'shelly',host:'192.168.1.50'}}));await assert.rejects(()=>adapter.qualify({channel:0,hardwareApproved:true,device:{mode:'shelly',host:'8.8.8.8'}}));await adapter.qualify({channel:0,hardwareApproved:true,device:{mode:'shelly',host:'192.168.1.50'}});});
test('Shelly SHA-256 digest challenge is handled without exposing password',()=>{const header=digestHeader('Digest qop="auth", realm="shellypro4pm-abc", nonce="abcd", algorithm=SHA-256','example-password');assert.match(header,/algorithm=SHA-256/);assert.match(header,/nc=00000001/);assert.equal(header.includes('example-password'),false);assert.throws(()=>digestHeader('Basic realm="x"','test'));});
test('operator resolution clears an uncertain durable task after fresh power-off observation',async()=>{const f=fixture();await f.engine.command(f.command);f.off();await f.engine.tick();assert.equal(f.engine.task('m').phase,'uncertain');const readings=await f.engine.readings([f.machine]);assert.equal(readings[0].output,false);f.engine.reconcile([]);assert.equal(f.engine.task('m'),undefined);f.engine.close();});
test('address recovery reads the new endpoint on an uncertain task without replaying or resuming',async()=>{
 const f=fixture('shelly');await f.engine.command(f.command);f.off();await f.engine.tick();
 const old=f.engine.task('m');assert.equal(old.phase,'uncertain');let host;
 f.engine.adapter.read=async m=>{host=m.device.host;return {output:false,apower:0};};
 const current={...f.machine,device:{...f.machine.device,host:'192.168.30.68'}};
 const result=(await f.engine.readings([current]))[0];
 assert.equal(host,current.device.host);assert.equal(result.deviceError,null);assert.equal(result.deviceHost,current.device.host);assert.equal(result.phase,'uncertain');assert.equal(f.sets,1);
 assert.equal(f.engine.task('m').machine.startWatts,old.machine.startWatts);assert.equal(f.engine.task('m').orderId,'o');
 f.engine.reconcile([{id:'o'}]);assert.ok(f.engine.task('m'));f.engine.reconcile([]);assert.equal(f.engine.task('m'),undefined);f.engine.close();
});
test('address recovery refuses active phases, different channels, and unallowlisted endpoints',async()=>{
 for(const scenario of ['active','channel','allowlist']){
  const f=fixture('shelly');await f.engine.command(f.command);if(scenario!=='active'){f.off();await f.engine.tick();}
  if(scenario==='allowlist')f.engine.adapter.qualify=async()=>{throw Error('host_not_allowlisted');};
  const current={...f.machine,channel:scenario==='channel'?1:0,device:{...f.machine.device,host:'192.168.30.68'}};
  const r=(await f.engine.readings([current]))[0];assert.equal(r.deviceError,scenario==='allowlist'?'host_not_allowlisted':'mapping_mismatch');assert.equal(r.observedAt,undefined);assert.equal(f.sets,1);assert.equal(f.engine.task('m').machine.device.host,'192.168.1.50');
  f.engine.reconcile([]);assert.ok(f.engine.task('m'));f.engine.close();
 }
});
test('read failures never count cached output-off as a fresh observation or release a durable task',async()=>{
 const f=fixture();await f.engine.command(f.command);f.off();await f.engine.tick();await f.engine.readings([f.machine]);
 f.engine.adapter.read=async()=>{throw Error('device_unreachable');};
 const r=(await f.engine.readings([f.machine]))[0];assert.equal(r.output,false);assert.equal(r.deviceError,'device_unreachable');assert.equal(r.observedAt,undefined);
 f.engine.reconcile([]);assert.ok(f.engine.task('m'));f.engine.close();
});
test('reading an uncommissioned channel is allowed but relay writes retain commissioning gates',async()=>{
 const calls=[];const a=new ShellyAdapter({allowHardware:false,allowedHosts:['192.168.30.68'],deviceHosts:{d:'192.168.30.68'},fetchImpl:async(url,o)=>{const method=JSON.parse(o.body).method;calls.push(method);return {ok:true,json:async()=>({result:method==='Sys.GetStatus'?{mac:'AABBCCDDEEFF',uptime:100}:{output:false,apower:0}})};}});
 const m={deviceId:'d',channel:2,hardwareApproved:false,device:{id:'d',mode:'shelly',host:'192.168.30.68'}};
 assert.deepEqual(await a.read(m),{output:false,apower:0,deviceMac:'AABBCCDDEEFF',deviceUptime:100});await assert.rejects(()=>a.set(m,true),/hardware_not_commissioned/);await assert.rejects(()=>a.set(m,false),/hardware_not_commissioned/);assert.deepEqual(calls,['Switch.GetStatus','Sys.GetStatus']);
 await assert.rejects(()=>a.read({...m,device:{...m.device,host:'192.168.30.69'}}),/host_not_allowlisted/);
});
