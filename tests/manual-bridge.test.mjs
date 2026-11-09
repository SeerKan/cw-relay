import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {BridgeEngine} from '../cozywash_bridge/bridge/engine.mjs';
function fixture(path=':memory:'){
 let now=Date.now(),output=false,power=0,fail=false;const writes=[];
 const adapter={qualify:async()=>{},read:async()=>{if(fail)throw Error('device_unreachable');return {output,apower:power};},set:async(m,on)=>{output=on;writes.push(on);}};
 const machine={id:'m',channel:0,deviceId:'d',locationId:'l',hardwareApproved:true,startWatts:15,idleWatts:5,minimumRunSeconds:30,idleConfirmSeconds:30,device:{id:'d',mode:'shelly',host:'192.168.1.50'}};
 const command={id:'manual:on',manualId:'session',action:'manual_relay',on:true,machine,deadline:now+60000};
 return {engine:new BridgeEngine({path,adapter,now:()=>now}),adapter,command,machine,writes,advance(ms){now+=ms;},setPower(p){power=p;},out(){return output;},fail(v){fail=v;}};
}
test('manual relay stays on across idle, consumption, days offline and connector restart without replay',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'cw-manual-')),path=join(dir,'journal.sqlite'),f=fixture(path);let engine=f.engine;
 try{
  const ack=await engine.command(f.command);assert.equal(ack.ok,true);
  for(const power of [0,3000,0]){f.setPower(power);f.advance(86400000);await engine.tick();assert.equal(f.out(),true);assert.equal(engine.task('m').phase,'manual_on');}
  f.fail(true);await engine.tick();assert.equal(f.out(),true);f.fail(false);engine.close();engine=new BridgeEngine({path,adapter:f.adapter});
  await engine.tick();assert.deepEqual(await engine.command(f.command),ack);assert.deepEqual(f.writes,[true]);
  const stop={...f.command,id:'manual:off',on:false,deadline:Date.now()+60000};assert.equal((await engine.command(stop)).ok,true);assert.deepEqual(f.writes,[true,false]);
  engine.reconcile([]);assert.equal(engine.task('m'),undefined);
 }finally{engine.close();rmSync(dir,{recursive:true});}
});
test('manual commands never take over or alter a customer task; expired commands never energize',async()=>{
 const f=fixture();try{
  f.engine.save({orderId:'customer',machine:f.machine,phase:'running',output:true,startedAt:1});const before=f.engine.task('m');
  for(const on of [true,false])assert.equal((await f.engine.command({...f.command,id:`manual:${on}`,on})).ok,false);
  assert.deepEqual(f.engine.task('m'),before);assert.deepEqual(f.writes,[]);
  const expired=await f.engine.command({...f.command,id:'manual:expired',deadline:0});assert.equal(expired.ok,false);assert.deepEqual(f.writes,[]);
 }finally{f.engine.close();}
});
test('manual output readback mismatch retains a lock and explicit OFF works at high power',async()=>{
 const f=fixture();try{
  await f.engine.command(f.command);f.setPower(3500);
  const ack=await f.engine.command({...f.command,id:'manual:off',on:false});assert.equal(ack.ok,true);assert.equal(f.out(),false);
  const readings=await f.engine.readings([f.machine]);assert.equal(readings[0].phase,'manual_off');assert.equal(readings[0].manualRelaySupported,true);
 }finally{f.engine.close();}
});
test('slow telemetry cannot execute a manual command past its delivery deadline',async()=>{
 let now=1000,writes=0;const machine={id:'m',device:{mode:'shelly'}};
 const adapter={qualify:async()=>{},read:async()=>{now=3000;return {output:false,apower:0};},set:async()=>{writes++;}};
 const engine=new BridgeEngine({adapter,now:()=>now});try{
  const ack=await engine.command({id:'slow',action:'manual_relay',manualId:'s',machine,on:true,deadline:2000});assert.equal(ack.ok,false);assert.equal(ack.error,'expired_command');assert.equal(writes,0);
 }finally{engine.close();}
});
