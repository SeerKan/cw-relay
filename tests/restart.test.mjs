import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeEngine} from '../cozywash_bridge/bridge/engine.mjs';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'cozywash-restart-')),path=join(dir,'journal.sqlite');
 const b={now:100000,bootAt:0,mac:'AABBCCDDEEFF',output:false,power:0,energy:10,writes:[],unreachable:false};
 const adapter={qualify:async()=>{},read:async()=>{if(b.unreachable)throw Error('device_unreachable');return {output:b.output,apower:b.power,deviceMac:b.mac,deviceUptime:Math.floor((b.now-b.bootAt)/1000),energyWh:b.energy};},set:async(m,on)=>{b.writes.push(on);b.output=on;}};
 const machine={id:'m',deviceId:'d',locationId:'l',channel:0,hardwareApproved:true,startWatts:15,idleWatts:5,startConfirmSeconds:3,idleConfirmSeconds:30,minimumRunSeconds:30,device:{id:'d',mode:'shelly',host:'192.168.30.68'}};
 let engine=new BridgeEngine({path,adapter,now:()=>b.now});
 const command={id:'o:enable',orderId:'o',action:'enable',machine,loadingSeconds:30,durationSeconds:900,deadline:b.now+10000};
 return {b,machine,command,get engine(){return engine;},advance(s){b.now+=s*1000;},async start(){await engine.command(command);b.power=50;await engine.tick();b.now+=4000;await engine.tick();assert.equal(engine.task('m').phase,'running');},restart(){engine.close();engine=new BridgeEngine({path,adapter,now:()=>b.now});},close(){engine.close();rmSync(dir,{recursive:true,force:true});}};
}
test('running session survives repeated restarts with the same start time, order and relay lease',async()=>{
 const f=fixture();try{
  await f.start();const startedAt=f.engine.task('m').startedAt,activatedAt=f.engine.task('m').activatedAt;
  for(let n=0;n<3;n++){
   f.advance(5);f.restart();await f.engine.tick();const t=f.engine.task('m');
   assert.equal(t.phase,'running');assert.equal(t.startedAt,startedAt);assert.equal(t.activatedAt,activatedAt);assert.equal(t.orderId,'o');assert.equal(t.recovering,false);
   assert.equal((await f.engine.command(f.command)).ok,true);assert.deepEqual(f.b.writes,[true]);
  }
 }finally{f.close();}
});
test('restart discards blind idle time and requires a full fresh qualified completion window',async()=>{
 const f=fixture();try{
  await f.start();f.advance(40);f.b.power=0;await f.engine.tick();const candidate=f.engine.task('m').idleCandidate;assert.ok(candidate);
  f.advance(25);f.restart();await f.engine.tick();assert.equal(f.b.output,true);assert.equal(f.engine.task('m').idleCandidate,null);
  f.advance(31);await f.engine.tick();assert.equal(f.b.output,true);f.advance(29);await f.engine.tick();assert.equal(f.b.output,true);
  f.advance(2);await f.engine.tick();assert.equal(f.engine.task('m').phase,'completed');assert.deepEqual(f.b.writes,[true,false]);
 }finally{f.close();}
});
test('device reboot, changed identity, reset energy or clock jumps require review and never replay power',async()=>{
 for(const kind of ['reboot','identity','energy','clock']){
  const f=fixture();try{
   await f.start();f.advance(5);f.restart();
   if(kind==='reboot')f.b.bootAt=f.b.now-1000;if(kind==='identity')f.b.mac='112233445566';if(kind==='energy')f.b.energy=0;if(kind==='clock')f.b.bootAt-=100000;
   await f.engine.tick();assert.equal(f.engine.task('m').phase,'uncertain');assert.deepEqual(f.b.writes,[true]);assert.equal(f.b.output,true);
  }finally{f.close();}
 }
});
test('unexpected output-off after restart is never energized automatically',async()=>{
 const f=fixture();try{await f.start();f.restart();f.b.output=false;await f.engine.tick();assert.equal(f.engine.task('m').phase,'uncertain');assert.equal(f.engine.task('m').error,'unexpected_power_loss');assert.deepEqual(f.b.writes,[true]);}finally{f.close();}
});
test('transient RPC failure recovers the same running session after fresh continuity checks',async()=>{
 const f=fixture();try{
  await f.start();const startedAt=f.engine.task('m').startedAt;f.b.unreachable=true;await f.engine.tick();assert.equal(f.engine.task('m').recovering,true);
  assert.equal((await f.engine.readings([f.machine]))[0].phase,'uncertain');f.advance(10);f.b.unreachable=false;await f.engine.tick();
  assert.equal(f.engine.task('m').phase,'running');assert.equal(f.engine.task('m').startedAt,startedAt);assert.equal(f.engine.task('m').error,null);assert.deepEqual(f.b.writes,[true]);
 }finally{f.close();}
});
test('loading sessions keep their original deadline and require fresh start confirmation after restart',async()=>{
 const f=fixture();try{
  await f.engine.command(f.command);f.advance(20);f.b.power=50;await f.engine.tick();const start=f.engine.task('m').startCandidate;
  f.advance(8);f.restart();await f.engine.tick();assert.equal(f.engine.task('m').phase,'loading');assert.equal(f.engine.task('m').loadingDeadline,130000);
  f.advance(4);await f.engine.tick();assert.equal(f.engine.task('m').phase,'running');assert.equal(f.engine.task('m').startedAt,start);assert.deepEqual(f.b.writes,[true]);
 }finally{f.close();}
});
test('a loading window crossed without start evidence stays locked instead of guessing a start or cutting power',async()=>{
 for(const power of [0,50]){const f=fixture();try{
  await f.engine.command(f.command);f.advance(31);f.restart();f.b.power=power;await f.engine.tick();assert.equal(f.engine.task('m').phase,'uncertain');assert.equal(f.engine.task('m').error,'start_during_outage_unknown');assert.deepEqual(f.b.writes,[true]);
 }finally{f.close();}}
});
test('legacy running journals retain their countdown but cannot auto-complete before fresh activity evidence',async()=>{
 const f=fixture();try{
  await f.start();const task=f.engine.task('m');delete task.checkpoint;f.engine.save(task);f.advance(40);f.b.power=0;f.restart();await f.engine.tick();
  assert.equal(f.engine.task('m').phase,'running');assert.equal(f.engine.task('m').needsActivityEvidence,true);f.advance(400);await f.engine.tick();assert.deepEqual(f.b.writes,[true]);
  f.b.power=50;await f.engine.tick();assert.equal(f.engine.task('m').needsActivityEvidence,false);
 }finally{f.close();}
});
test('an observed relay loss or changed identity in a heartbeat is a durable lock even if it returns before the next tick',async()=>{
 for(const incident of ['output','identity']){const f=fixture();try{
  await f.start();if(incident==='output')f.b.output=false;else f.b.mac='112233445566';
  const r=(await f.engine.readings([f.machine]))[0];assert.equal(r.phase,'uncertain');assert.equal(f.engine.task('m').phase,'uncertain');
  f.b.output=true;f.b.mac='AABBCCDDEEFF';f.restart();await f.engine.tick();assert.equal(f.engine.task('m').phase,'uncertain');assert.deepEqual(f.b.writes,[true]);
 }finally{f.close();}}
});
test('a refused command during restart recovery cannot silently release its resulting review lock',async()=>{
 const f=fixture();try{
  await f.start();f.restart();const ack=await f.engine.command({...f.command,id:'o:disable',action:'disable'});
  assert.equal(ack.ok,false);assert.equal(ack.error,'unsafe_power_cut');assert.equal(f.engine.task('m').recovering,false);
  await f.engine.tick();assert.equal(f.engine.task('m').phase,'uncertain');assert.deepEqual(f.b.writes,[true]);
 }finally{f.close();}
});
