import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeEngine} from '../cozywash_bridge/bridge/engine.mjs';
function fixture({type='dryer',policy=true}={}){
 const dir=mkdtempSync(join(tmpdir(),'cw-dryer-')),path=join(dir,'journal.sqlite');
 const b={now:100000,output:false,power:0,energy:100,boot:0,mac:'ABCDEF',writes:[],failure:null};
 const machine={id:'dryer',deviceId:'shelly',type,cyclePolicy:policy?{dryerMaxRunPercent:150}:null,channel:0,hardwareApproved:true,
  startWatts:15,idleWatts:5,startConfirmSeconds:3,idleConfirmSeconds:30,minimumRunSeconds:120,device:{id:'shelly',mode:'shelly',host:'192.168.1.8'}};
 const adapter={qualify:async()=>{},read:async()=>{if(b.failure==='read')throw Error('device_unreachable');return {output:b.output,apower:b.power,energyWh:b.energy,deviceMac:b.mac,deviceUptime:(b.now-b.boot)/1000};},
  set:async(m,on)=>{b.writes.push(on);if(b.failure==='write'&&!on)throw Error('device_rpc_error');if(b.failure==='readback'&&!on)return;b.output=on;if(b.failure==='after-off'&&!on)throw Error('device_unreachable');}};
 let engine=new BridgeEngine({path,adapter,now:()=>b.now});
 return {b,machine,get engine(){return engine;},advance(seconds){b.now+=seconds*1000;},restart(){engine.close();engine=new BridgeEngine({path,adapter,now:()=>b.now});},
  async start(duration=60){const ack=await engine.command({id:'order:enable',orderId:'order',action:'enable',machine,durationSeconds:duration,loadingSeconds:60,deadline:b.now+10000});assert.equal(ack.ok,true);b.now+=10000;b.power=400;await engine.tick();b.now+=3000;await engine.tick();assert.equal(engine.task(machine.id).phase,'running');},
  async reading(){return (await engine.readings([machine]))[0];},close(){engine.close();rmSync(dir,{recursive:true,force:true});}};
}
test('dryer uses 150% of the purchased duration from detected start, confirms OFF and freezes metrics',async()=>{
 const f=fixture();try{
  await f.start(60);const start=f.engine.task('dryer').startedAt;
  f.b.now=start+89999;await f.engine.tick();assert.equal(f.b.output,true);
  f.b.now=start+90000;await f.engine.tick();assert.equal(f.b.output,true,'exactly +50% is not beyond limit');
  f.b.now=start+90001;f.b.energy=130;await f.engine.tick();const r=await f.reading();
  assert.equal(f.b.output,false);assert.equal(r.phase,'completed');assert.equal(r.completionReason,'dryer_time_limit');assert.equal(r.usage.cycleEndedAt,start+90001);assert.equal(r.usage.completedAt,start+90001);assert.equal(r.usage.energyWh,30);assert.equal(r.usage.energyComplete,true);assert.deepEqual(f.b.writes,[true,false]);
  f.b.energy=300;f.advance(100);await f.engine.tick();assert.deepEqual((await f.reading()).usage,r.usage);assert.deepEqual(f.b.writes,[true,false]);
 }finally{f.close();}
});
test('washer, legacy session and manual relay never inherit the dryer deadline',async()=>{
 for(const opts of [{type:'washer'},{policy:false}]){const f=fixture(opts);try{await f.start();f.advance(5000);await f.engine.tick();assert.equal(f.b.output,true);assert.equal(f.engine.task('dryer').phase,'running');}finally{f.close();}}
 const f=fixture();try{await f.engine.command({id:'manual-enable',manualId:'manual-session',action:'manual_relay',machine:f.machine,on:true,reason:'Test manual',deadline:f.b.now+60000});f.advance(5000);await f.engine.tick();assert.equal(f.b.output,true);assert.equal(f.engine.task('dryer').phase,'manual_on');}finally{f.close();}
});
test('natural dryer completion before the limit retains ordinary completion',async()=>{
 const f=fixture();try{await f.start(300);f.advance(130);f.b.power=0;await f.engine.tick();f.advance(31);await f.engine.tick();assert.equal(f.b.output,false);assert.equal(f.engine.task('dryer').phase,'completed');assert.equal((await f.reading()).completionReason,undefined);}finally{f.close();}
});
test('connector restart and an offline cloud do not extend the original dryer deadline or replay ON',async()=>{
 const f=fixture();try{await f.start();const start=f.engine.task('dryer').startedAt;f.advance(50);await f.engine.tick();f.restart();f.b.now=start+90001;await f.engine.tick();assert.equal(f.b.output,false);assert.equal(f.engine.task('dryer').startedAt,start);assert.equal((await f.reading()).completionReason,'dryer_time_limit');assert.deepEqual(f.b.writes,[true,false]);}finally{f.close();}
});
test('failed read/write/readback never produces a false completion',async()=>{
 for(const failure of ['read','write','readback']){const f=fixture();try{await f.start();f.advance(100);f.b.failure=failure;await f.engine.tick();const r=await f.reading();assert.notEqual(r.phase,'completed');assert.equal(r.completionReason,undefined);assert.equal(f.b.output,true);}finally{f.close();}}
});
test('durable OFF intent recovers an interruption after the relay changed, without replaying ON or losing completion',async()=>{
 for(const viaReading of [false,true]){const f=fixture();try{
  await f.start();f.advance(100);f.b.failure='after-off';await f.engine.tick();assert.equal(f.b.output,false);assert.ok(f.engine.task('dryer').dryerStopRequestedAt);assert.notEqual(f.engine.task('dryer').phase,'completed');
  f.restart();f.b.failure=null;f.advance(1);if(!viaReading)await f.engine.tick();const r=await f.reading();assert.equal(r.phase,'completed');assert.equal(r.completionReason,'dryer_time_limit');assert.deepEqual(f.b.writes,[true,false]);
 }finally{f.close();}}
});
test('hardware reboot and an existing fault retain operator review even after the dryer deadline',async()=>{
 const f=fixture();try{await f.start();f.advance(100);f.b.boot=f.b.now-1000;await f.engine.tick();assert.equal(f.engine.task('dryer').phase,'uncertain');assert.equal(f.b.output,true);f.advance(100);await f.engine.tick();assert.equal(f.b.output,true);assert.equal(f.engine.task('dryer').phase,'uncertain');assert.deepEqual(f.b.writes,[true]);}finally{f.close();}
});
