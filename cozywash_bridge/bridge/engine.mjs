import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class BridgeEngine {
  constructor({path=':memory:',adapter,now=Date.now,simulationSpeed=60}) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY,data TEXT NOT NULL,ack TEXT); CREATE TABLE IF NOT EXISTS tasks(machine_id TEXT PRIMARY KEY,data TEXT NOT NULL);");
    this.adapter=adapter;this.now=now;this.speed=simulationSpeed;
    for(const task of this.tasks())if(['enabling','loading','running'].includes(task.phase)&&task.machine.device.mode==='shelly')this.save({...task,phase:'uncertain',error:'bridge_restarted'});
  }
  tasks(){return this.db.prepare('SELECT data FROM tasks').all().map(r=>JSON.parse(r.data));}
  task(machineId){const r=this.db.prepare('SELECT data FROM tasks WHERE machine_id=?').get(machineId);return r&&JSON.parse(r.data);}
  save(task){this.db.prepare('INSERT INTO tasks VALUES(?,?) ON CONFLICT(machine_id) DO UPDATE SET data=excluded.data').run(task.machine.id,JSON.stringify(task));}
  async read(machine){return this.adapter.read(machine,this.task(machine.id));}
  async set(machine,on){await this.adapter.set(machine,on,this.task(machine.id));const reading=await this.read(machine);if(reading.output!==on)throw new Error('readback_mismatch');return reading;}
  async command(command){
    const previous=this.db.prepare('SELECT * FROM journal WHERE id=?').get(command.id);
    if(previous?.ack)return JSON.parse(previous.ack);
    if(previous){const reading=await this.read(command.machine).catch(()=>({output:true}));const ack={ok:false,output:reading.output,at:this.now(),error:'interrupted_command',definitelyNotStarted:false};this.finish(command,ack);return ack;}
    this.db.prepare('INSERT INTO journal(id,data) VALUES(?,?)').run(command.id,JSON.stringify(command));
    const machine=command.machine;let task=this.task(machine.id);let ack;
    try{
      if(command.action==='enable'){
        const initial=await this.read(machine);
        if(this.now()>command.deadline)throw new Error('expired_command');
        if(initial.output!==false||task)throw new Error('machine_not_idle');
        await this.adapter.qualify(machine);
        task={orderId:command.orderId,machine,phase:'enabling',loadingSeconds:command.loadingSeconds,durationSeconds:command.durationSeconds,output:false};this.save(task);
        await this.set(machine,true);
        task={...task,phase:'loading',output:true,activatedAt:this.now(),loadingDeadline:this.now()+command.loadingSeconds*1000};this.save(task);
        ack={ok:true,output:true,at:task.activatedAt};
      }else if(command.action==='simulate_start'){
        if(machine.device.mode!=='simulator'||task?.orderId!==command.orderId||task.phase!=='loading'||this.now()>task.loadingDeadline)throw new Error('cannot_simulate_start');
        task={...task,phase:'running',startedAt:this.now()};this.save(task);ack={ok:true,output:true,at:this.now()};
      }else if(command.action==='disable'){
        if(task&&task.orderId!==command.orderId)throw new Error('order_mismatch');
        const reading=await this.read(machine);
        const safe=task?.phase==='loading'&&(!task.startCandidate)&&reading.apower<=machine.idleWatts;
        const done=task?.phase==='completed'||task?.phase==='loading_expired';
        if(reading.output&&!(safe||done))throw new Error('unsafe_power_cut');
        await this.set(machine,false);
        ack={ok:true,output:false,at:this.now(),definitelyNotStarted:!task||task.phase==='loading_expired'||safe,cycleCompleted:task?.phase==='completed'};
        if(task&&safe){task={...task,phase:command.reason==='loading_expired'?'loading_expired':'uncertain',output:false};this.save(task);}
      }else throw new Error('invalid_command');
    }catch(e){
      const reading=await this.read(machine).catch(()=>({output:true}));
      const current=this.task(machine.id);
      const definitelyNotStarted=reading.output===false&&(!current||current.phase==='enabling');
      if(current)this.save({...current,phase:'uncertain',error:e.message,output:reading.output});
      ack={ok:false,output:reading.output,at:this.now(),definitelyNotStarted,error:e.message};
    }
    this.finish(command,ack);return ack;
  }
  finish(command,ack){this.db.prepare('UPDATE journal SET ack=? WHERE id=?').run(JSON.stringify(ack),command.id);}
  async tick(){
    for(let task of this.tasks()){
      try{
        const reading=await this.read(task.machine);const now=this.now();
        if(['loading','running'].includes(task.phase)&&reading.output!==true)throw new Error('unexpected_power_loss');
        if(task.phase==='loading'){
          if(task.machine.device.mode==='shelly'){
            if(reading.apower>=task.machine.startWatts){
              task.startCandidate??=now;
              if(task.startCandidate>task.loadingDeadline)throw new Error('late_physical_start');
              if(now-task.startCandidate>=task.machine.startConfirmSeconds*1000){task.phase='running';task.startedAt=task.startCandidate;task.startCandidate=null;}
            }else if(reading.apower<=task.machine.idleWatts)task.startCandidate=null;
          }
          if(task.phase==='loading'&&now>=task.loadingDeadline&&!task.startCandidate){
            if(reading.apower>task.machine.idleWatts)throw new Error('start_detection_ambiguous');
            await this.set(task.machine,false);task.phase='loading_expired';task.output=false;
          }
        }
        if(task.phase==='running'){
          if(task.machine.device.mode==='simulator'){
            if(now-task.startedAt>=Math.max(8000,task.durationSeconds*1000/this.speed)){await this.set(task.machine,false);task.phase='completed';task.output=false;}
          }else{
            if(reading.apower<=task.machine.idleWatts&&now-task.startedAt>=task.machine.minimumRunSeconds*1000){task.idleCandidate??=now;if(now-task.idleCandidate>=task.machine.idleConfirmSeconds*1000){await this.set(task.machine,false);task.phase='completed';task.output=false;}}
            else task.idleCandidate=null;
          }
        }
        this.save(task);
      }catch(e){this.save({...task,phase:'uncertain',error:e.message});}
    }
  }
  async recoverAddress(machine,task){
    if(!task||task.machine.device.host===machine.device.host)return task;
    const old=task.machine;
    if(task.phase!=='uncertain'||old.id!==machine.id||old.deviceId!==machine.deviceId||old.locationId!==machine.locationId||old.channel!==machine.channel||old.device.id!==machine.device.id||old.device.mode!==machine.device.mode)throw new Error('mapping_mismatch');
    // Only replace the endpoint on a locked task. Keep every original safety threshold and never resume it.
    const recovered={...old,device:{...old.device,host:machine.device.host}};
    await this.adapter.qualify(recovered,{control:false});
    const reading=await this.adapter.read(recovered,task);
    task={...task,machine:recovered,output:reading.output,deviceError:null};this.save(task);return task;
  }
  async readings(machines){
    const readings=[];
    for(const machine of machines){
            let task=this.task(machine.id);
      try{
        task=await this.recoverAddress(machine,task);
        const target=task?.machine||machine,reading=await this.read(target);
        if(task)this.save({...task,output:reading.output,deviceError:null});
        readings.push({machineId:machine.id,orderId:task?.orderId,phase:task?.phase||(!reading.output?'idle':'uncertain'),activatedAt:task?.activatedAt,startedAt:task?.startedAt,...reading,error:task?.error,deviceError:null,deviceHost:target.device.host,observedAt:this.now()});
      }catch(e){
        const deviceError=/^[a-z_]{1,60}$/.test(e.message)?e.message:'device_unreachable';
        if(task)this.save({...task,deviceError});
        readings.push({machineId:machine.id,orderId:task?.orderId,phase:'uncertain',output:task?.output??true,error:deviceError,deviceError});
      }
    }return readings;
  }
  reconcile(serverOrders){
    const ids=new Set(serverOrders.map(o=>o.id));
    for(const task of this.tasks())if(!ids.has(task.orderId)&&task.output===false&&task.deviceError===null&&['completed','loading_expired','uncertain'].includes(task.phase))this.db.prepare('DELETE FROM tasks WHERE machine_id=?').run(task.machine.id);
  }
  close(){this.db.close();}
}
