import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BridgeEngine} from '../cozywash_bridge/bridge/engine.mjs';
function fixture({meter=true,mode='shelly'}={}) {
 const dir=mkdtempSync(join(tmpdir(),'cw-usage-')),path=join(dir,'journal.sqlite');
 const b={now:100000,energy:100,output:false,power:0,mac:'AABBCCDDEEFF',boot:0,writes:[]};
 const machine={id:'m',deviceId:'d',channel:1,startWatts:15,idleWatts:5,startConfirmSeconds:3,idleConfirmSeconds:30,minimumRunSeconds:30,device:{id:'d',mode}};
 const adapter={qualify:async()=>{},read:async()=>({output:b.output,apower:b.power,deviceMac:b.mac,deviceUptime:(b.now-b.boot)/1000,...(meter?{energyWh:b.energy}:{})}),set:async(m,on)=>{b.output=on;b.writes.push(on);}};
 let engine=new BridgeEngine({path,adapter,now:()=>b.now});
 return {b,machine,get engine(){return engine;},advance(n){b.now+=n*1000;},async enable(){await engine.command({id:'o:enable',orderId:'o',action:'enable',machine,loadingSeconds:60,durationSeconds:1800,deadline:b.now+10000});},async start(){await this.enable();b.now+=10000;b.power=400;await engine.tick();b.now+=3000;await engine.tick();},restart(){engine.close();engine=new BridgeEngine({path,adapter,now:()=>b.now});},async read(){return (await engine.readings([machine]))[0];},close(){engine.close();rmSync(dir,{recursive:true,force:true});}};
}
test('order energy excludes earlier counter history, freezes at relay off, duration excludes final confirmation',async()=>{
 const f=fixture();try{
  await f.start();f.advance(120);f.b.energy=450;f.b.power=0;await f.engine.tick();const ended=f.b.now;
  f.advance(30);f.b.energy=451;await f.engine.tick();const r=await f.read();
  assert.equal(r.phase,'completed');assert.equal(r.usage.energyWh,351);assert.equal(r.usage.energyComplete,true);assert.equal(r.usage.cycleEndedAt,ended);assert.equal(r.usage.completedAt,ended+30000);assert.deepEqual(f.b.writes,[true,false]);
  f.b.energy=999;f.advance(60);assert.deepEqual((await f.read()).usage,r.usage);
 }finally{f.close();}
});
test('counter baseline and final timing survive a bridge restart and delayed cloud reporting',async()=>{
 const f=fixture();try{
  await f.start();const start=f.engine.task('m').startedAt;f.advance(10);f.b.energy=200;await f.engine.tick();f.restart();f.advance(3);await f.engine.tick();
  f.advance(40);f.b.power=0;f.b.energy=400;await f.engine.tick();f.advance(30);await f.engine.tick();const done=f.b.now;
  f.restart();f.advance(300);const r=await f.read();assert.equal(r.startedAt,start);assert.equal(r.usage.completedAt,done);assert.equal(r.usage.energyWh,300);assert.equal(r.usage.energyComplete,true);assert.deepEqual(f.b.writes,[true,false]);
 }finally{f.close();}
});
test('missing initial meter never fabricates zero consumption',async()=>{
 const f=fixture({meter:false});try{await f.start();f.advance(50);f.b.power=0;await f.engine.tick();f.advance(30);await f.engine.tick();const r=await f.read();assert.equal(r.phase,'completed');assert.equal(r.usage.energyWh,null);assert.equal(r.usage.energyStatus,'unavailable');assert.equal(r.usage.energyComplete,false);assert.ok(r.usage.cycleEndedAt);}finally{f.close();}
});
test('counter reset, device replacement and reboot permanently invalidate energy for that order',async()=>{
 for(const kind of ['reset','replacement','reboot']){const f=fixture();try{
  await f.start();f.advance(10);f.b.energy=kind==='reset'?1:101;if(kind==='replacement')f.b.mac='112233445566';if(kind==='reboot')f.b.boot=f.b.now-1000;
  await f.engine.tick();assert.equal(f.engine.task('m').phase,'uncertain');assert.equal((await f.read()).usage.energyStatus,'invalid');
  f.b.energy=500;assert.equal((await f.read()).usage.energyWh,null);assert.deepEqual(f.b.writes,[true]);
 }finally{f.close();}}
});
test('old journals expose no invented historical measurements',async()=>{
 const f=fixture();try{await f.start();const task=f.engine.task('m');delete task.usageVersion;f.engine.save(task);assert.equal((await f.read()).usage,undefined);}finally{f.close();}
});
test('simulator energy is marked simulated and uses elapsed time rather than the nominal program',async()=>{
 const f=fixture({mode:'simulator'});try{await f.enable();f.b.now+=5000;await f.engine.command({id:'o:start',orderId:'o',action:'simulate_start',machine:f.machine});f.advance(30);await f.engine.tick();const r=await f.read();assert.equal(r.usage.simulated,true);assert.equal(r.usage.energyWh,400*30/3600);assert.equal(r.usage.cycleEndedAt-r.startedAt,30000);}finally{f.close();}
});
