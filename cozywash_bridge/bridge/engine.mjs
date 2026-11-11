import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class BridgeEngine {
  constructor({path=':memory:',adapter,now=Date.now,simulationSpeed=60}) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS journal(id TEXT PRIMARY KEY,data TEXT NOT NULL,ack TEXT); CREATE TABLE IF NOT EXISTS tasks(machine_id TEXT PRIMARY KEY,data TEXT NOT NULL);");
    this.adapter=adapter;this.now=now;this.speed=simulationSpeed;
    for(const task of this.tasks())if(task.machine.device.mode==='shelly'){
      if(['loading','running'].includes(task.phase))this.save({...task,recovering:true,recoveryPhase:task.phase,startConfirmSince:null,idleCandidate:null});
      else if(task.phase==='enabling')this.save({...task,phase:'uncertain',error:'interrupted_enable'});
      // Hardware faults and sessions without a confirmed start retain operator review.
    }
  }
  tasks(){return this.db.prepare('SELECT data FROM tasks').all().map(r=>JSON.parse(r.data));}
  task(machineId){const r=this.db.prepare('SELECT data FROM tasks WHERE machine_id=?').get(machineId);return r&&JSON.parse(r.data);}
  save(task){this.db.prepare('INSERT INTO tasks VALUES(?,?) ON CONFLICT(machine_id) DO UPDATE SET data=excluded.data').run(task.machine.id,JSON.stringify(task));}
  measure(task,reading){
    if(task.usageVersion!==1||task.energyFinal)return task;
    const now=this.now(),simulated=task.machine.device.mode==='simulator';
    const energy=simulated?(Number.isFinite(task.startedAt)?Math.max(0,(now-task.startedAt))*400/3600000:0):reading.energyWh;
    let status=task.energyStatus;
    if(status!=='invalid'&&((Number.isFinite(energy)&&energy<0)||(Number.isFinite(energy)&&Number.isFinite(task.energyLastWh)&&energy+0.001<task.energyLastWh)||(task.energyMac&&reading.deviceMac!==task.energyMac)))status='invalid';
    const valid=Number.isFinite(energy)&&energy>=0&&Number.isFinite(task.energyStartWh)&&status!=='invalid';
    return {...task,energyStatus:valid?'measured':status==='invalid'?'invalid':'unavailable',
      ...(valid?{energyLastWh:energy,energyObservedAt:now,energyUsedWh:Math.max(0,energy-task.energyStartWh)}:{}),
      ...(['completed','loading_expired'].includes(task.phase)?{energyFinal:true,energyComplete:valid}:{} )};
  }
  usage(task){
    if(task?.usageVersion!==1)return undefined;
    return {version:1,energyWh:task.energyStatus==='measured'?task.energyUsedWh:null,energyStatus:task.energyStatus,
      energyComplete:task.energyComplete===true,energyObservedAt:task.energyObservedAt??null,
      cycleEndedAt:task.cycleEndedAt??null,completedAt:task.completedAt??null,
      simulated:task.machine.device.mode==='simulator'};
  }
  checkpoint(task,reading){
    task=this.measure(task,reading);
    return {...task,output:reading.output,deviceError:null,checkpoint:{at:this.now(),deviceMac:reading.deviceMac,deviceUptime:reading.deviceUptime,energyWh:reading.energyWh,output:reading.output}};
  }
  verifyContinuity(task,reading){
    const c=task.checkpoint;
    if(c&&['loading','running'].includes(task.phase)&&c.output!==true)throw new Error('unexpected_power_loss');
    if(!c?.deviceMac||!Number.isFinite(c.deviceUptime))return false;
    if(!Number.isFinite(c.at))throw new Error('invalid_recovery_checkpoint');
    if(reading.deviceMac!==c.deviceMac)throw new Error('device_identity_changed');
    if(!Number.isFinite(reading.deviceUptime))throw new Error('device_identity_unavailable');
    const elapsed=this.now()-c.at,uptimeElapsed=(reading.deviceUptime-c.deviceUptime)*1000;
    if(elapsed<0||uptimeElapsed<0||Math.abs(elapsed-uptimeElapsed)>5000)throw new Error('device_restarted_or_clock_changed');
    if(Number.isFinite(c.energyWh)&&Number.isFinite(reading.energyWh)&&reading.energyWh+0.001<c.energyWh)throw new Error('device_energy_reset');
    return true;
  }
  recover(task,reading){
    if(!task.recovering)return task;
    if(!['loading','running'].includes(task.phase))throw new Error('invalid_recovery_phase');
    if(reading.output!==true)throw new Error('unexpected_power_loss');
    const continuous=this.verifyContinuity(task,reading);
    const phase=task.recoveryPhase;
    if(!['loading','running'].includes(phase))throw new Error('invalid_recovery_phase');
    if(phase==='running'&&!Number.isFinite(task.startedAt))throw new Error('start_time_missing');
    if(phase==='loading'&&this.now()>=task.loadingDeadline&&!task.startCandidate)throw new Error('start_during_outage_unknown');
    // A legacy journal has no hardware checkpoint. Preserve its known start time,
    // but require fresh running power before allowing automatic completion.
    return {...task,phase,recovering:false,recoveryPhase:null,error:null,deviceError:null,monitoringResumedAt:this.now(),
      completionNotBefore:this.now()+task.machine.minimumRunSeconds*1000,
      needsActivityEvidence:task.needsActivityEvidence||!continuous,
      loadingObservationGap:phase==='loading'||task.loadingObservationGap,
      startConfirmSince:null,idleCandidate:null};
  }
  dryerLimit(task){
    return !task.manualId && task.machine.type==='dryer' && task.machine.cyclePolicy?.dryerMaxRunPercent===150 &&
      Number.isFinite(task.startedAt) && Number.isFinite(task.durationSeconds) && task.durationSeconds>0
      ? task.startedAt+task.durationSeconds*1500 : null;
  }
  pendingDryerStop(task){return task.phase==='running' && Number.isFinite(task.dryerStopRequestedAt) && this.dryerLimit(task)!==null;}
  dryerCompleted(task){
    return {...task,phase:'completed',output:false,recovering:false,recoveryPhase:null,error:null,deviceError:null,
      completedAt:this.now(),cycleEndedAt:this.now(),completionReason:'dryer_time_limit'};
  }
  async read(machine){return this.adapter.read(machine,this.task(machine.id));}
  async set(machine,on){await this.adapter.set(machine,on,this.task(machine.id));const reading=await this.read(machine);if(reading.output!==on)throw new Error('readback_mismatch');return reading;}
  async command(command){
    const previous=this.db.prepare('SELECT * FROM journal WHERE id=?').get(command.id);
    if(previous?.ack)return JSON.parse(previous.ack);
    if(previous){const reading=await this.read(command.machine).catch(()=>({output:true}));const ack={ok:false,output:reading.output,at:this.now(),error:'interrupted_command',definitelyNotStarted:false};this.finish(command,ack);return ack;}
    this.db.prepare('INSERT INTO journal(id,data) VALUES(?,?)').run(command.id,JSON.stringify(command));
    if(command.action==='manual_relay')return this.manualCommand(command);
    const machine=command.machine;let task=this.task(machine.id);let ack;
    try{
      if(task?.manualId)throw Error('manual_hold_active');
      if(command.action==='enable'){
        const initial=await this.read(machine);
        if(this.now()>command.deadline)throw new Error('expired_command');
        if(initial.output!==false||task)throw new Error('machine_not_idle');
        await this.adapter.qualify(machine);
        task={orderId:command.orderId,machine,phase:'enabling',loadingSeconds:command.loadingSeconds,durationSeconds:command.durationSeconds,output:false,usageVersion:1,energyStartWh:machine.device.mode==='simulator'?0:initial.energyWh,energyLastWh:machine.device.mode==='simulator'?0:initial.energyWh,energyMac:initial.deviceMac,energyStatus:'unavailable'};this.save(task);
        await this.set(machine,true);
        task=this.checkpoint({...task,phase:'loading',output:true,activatedAt:this.now(),loadingDeadline:this.now()+command.loadingSeconds*1000},await this.read(machine));this.save(task);
        ack={ok:true,output:true,at:task.activatedAt};
      }else if(command.action==='simulate_start'){
        if(machine.device.mode!=='simulator'||task?.orderId!==command.orderId||task.phase!=='loading'||this.now()>task.loadingDeadline)throw new Error('cannot_simulate_start');
        task={...task,phase:'running',startedAt:this.now()};this.save(task);ack={ok:true,output:true,at:this.now()};
      }else if(command.action==='disable'){
        if(task&&task.orderId!==command.orderId)throw new Error('order_mismatch');
        const reading=await this.read(machine);
        if(task&&machine.device.mode==='shelly')this.verifyContinuity(task,reading);
        const safe=task?.phase==='loading'&&!task.recovering&&!task.loadingObservationGap&&(!task.startCandidate)&&reading.apower<=machine.idleWatts;
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
      if(current)this.save({...current,phase:'uncertain',recovering:false,recoveryPhase:null,error:e.message,output:reading.output});
      ack={ok:false,output:reading.output,at:this.now(),definitelyNotStarted,error:e.message};
    }
    this.finish(command,ack);return ack;
  }
  async manualCommand(command){
    const machine=command.machine,existing=this.task(machine.id);let ack;
    try{
      if(typeof command.on!=='boolean'||!command.manualId||!Number.isFinite(command.deadline))throw Error('invalid_manual_command');
      if(this.now()>command.deadline)throw Error('expired_command');
      // Never take over a customer task, including one locked for operator review.
      if(existing&&(!existing.manualId||existing.manualId!==command.manualId))throw Error('machine_not_idle');
      const reading=await this.read(machine);
      if(command.on&&(existing||reading.output!==false))throw Error('machine_not_idle');
      await this.adapter.qualify(machine);
      if(this.now()>command.deadline)throw Error('expired_command');
      this.save({machine,manualId:command.manualId,manualCommandId:command.id,manualOn:command.on,phase:'uncertain',output:reading.output,error:'manual_unconfirmed'});
      const confirmed=await this.set(machine,command.on);
      this.save(this.checkpoint({machine,manualId:command.manualId,manualCommandId:command.id,manualOn:command.on,phase:command.on?'manual_on':'manual_off',output:command.on,error:null},confirmed));
      ack={ok:true,output:command.on,at:this.now()};
    }catch(error){
      const reading=await this.read(machine).catch(()=>({output:true}));
      const task=this.task(machine.id);
      if(task?.manualId===command.manualId)this.save({...task,phase:'uncertain',output:reading.output,error:error.message});
      ack={ok:false,output:reading.output,at:this.now(),error:error.message};
    }
    this.finish(command,ack);return ack;
  }
  observeManual(task,reading){
    return this.checkpoint({...task,phase:reading.output===task.manualOn?(task.manualOn?'manual_on':'manual_off'):'uncertain',error:reading.output===task.manualOn?null:'manual_output_changed'},reading);
  }
  finish(command,ack){this.db.prepare('UPDATE journal SET ack=? WHERE id=?').run(JSON.stringify(ack),command.id);}
  async tick(){
    for(let task of this.tasks()){
      try{
        let reading=await this.read(task.machine);const now=this.now();
        task=this.measure(task,reading);
        if(task.manualId){this.save(this.observeManual(task,reading));continue;}
        if(this.pendingDryerStop(task)){
          // OFF intent is durable before the write. A restart can confirm OFF without replaying ON.
          this.verifyContinuity(task,reading);
          if(reading.output)reading=await this.set(task.machine,false);
          task=this.dryerCompleted(task);this.save(this.checkpoint(task,reading));continue;
        }
        if(task.recovering)task=this.recover(task,reading);
        else if(['loading','running'].includes(task.phase))this.verifyContinuity(task,reading);
        if(reading.apower>=task.machine.startWatts)task.needsActivityEvidence=false;
        if(['loading','running'].includes(task.phase)&&reading.output!==true)throw new Error('unexpected_power_loss');
        if(task.phase==='loading'){
          if(task.machine.device.mode==='shelly'){
            if(reading.apower>=task.machine.startWatts){
              task.startCandidate??=now;
              if(task.startCandidate>task.loadingDeadline)throw new Error('late_physical_start');
              task.startConfirmSince??=now;
              if(now-task.startConfirmSince>=task.machine.startConfirmSeconds*1000){task.phase='running';task.startedAt=task.startCandidate;task.startCandidate=null;}
            }else if(reading.apower<=task.machine.idleWatts){task.startCandidate=null;task.startConfirmSince=null;}
          }
          if(task.phase==='loading'&&now>=task.loadingDeadline&&!task.startCandidate){
            if(task.loadingObservationGap)throw new Error('start_during_outage_unknown');
            if(reading.apower>task.machine.idleWatts)throw new Error('start_detection_ambiguous');
            reading=await this.set(task.machine,false);task.phase='loading_expired';task.output=false;
          }
        }
        if(task.phase==='running'){
          const limit=this.dryerLimit(task);
          if(limit!==null&&now>limit){
            task={...task,dryerStopRequestedAt:now};this.save(task);
            reading=await this.set(task.machine,false);task=this.dryerCompleted(task);
          }else if(task.machine.device.mode==='simulator'){
            if(now-task.startedAt>=Math.max(8000,task.durationSeconds*1000/this.speed)){reading=await this.set(task.machine,false);task.phase='completed';task.output=false;task.completedAt=now;task.cycleEndedAt=now;}
          }else{
            if(!task.needsActivityEvidence&&now>=(task.completionNotBefore||0)&&reading.apower<=task.machine.idleWatts&&now-task.startedAt>=task.machine.minimumRunSeconds*1000){task.idleCandidate??=now;if(now-task.idleCandidate>=task.machine.idleConfirmSeconds*1000){reading=await this.set(task.machine,false);task.phase='completed';task.output=false;task.completedAt=now;task.cycleEndedAt=task.idleCandidate;}}
            else task.idleCandidate=null;
          }
        }
        this.save(this.checkpoint(task,reading));
      }catch(e){
        if(['device_identity_changed','device_restarted_or_clock_changed','device_energy_reset'].includes(e.message))task={...task,energyStatus:'invalid'};
        const transient=['device_unreachable','device_http_error','device_rpc_error','invalid_device_telemetry','fetch failed','The operation was aborted due to timeout'].includes(e.message)||e.name==='TimeoutError'||e.name==='TypeError';
        this.save(transient&&['loading','running'].includes(task.phase)?{...task,recovering:true,recoveryPhase:task.recoveryPhase||task.phase,error:'device_unreachable',deviceError:'device_unreachable',idleCandidate:null,startConfirmSince:null}:task.phase==='uncertain'?{...task,deviceError:e.message}:{...task,phase:'uncertain',recovering:false,error:e.message});
      }
    }
  }
  async recoverAddress(machine,task){
    if(!task||task.machine.device.host===machine.device.host)return task;
    const old=task.machine;
    if((!task.manualId&&task.phase!=='uncertain'&&!task.recovering)||old.id!==machine.id||old.deviceId!==machine.deviceId||old.locationId!==machine.locationId||old.channel!==machine.channel||old.device.id!==machine.device.id||old.device.mode!==machine.device.mode)throw new Error('mapping_mismatch');
    // Only replace the endpoint on a locked task. Keep every original safety threshold and never resume it.
    const recovered={...old,device:{...old.device,host:machine.device.host}};
    await this.adapter.qualify(recovered,{control:false});
    const reading=await this.adapter.read(recovered,task);
    task={...task,phase:'uncertain',recovering:false,machine:recovered,output:reading.output,deviceError:null};this.save(task);return task;
  }
  async readings(machines){
    const readings=[];
    for(const machine of machines){
      let task=this.task(machine.id);
      try{
        task=await this.recoverAddress(machine,task);
        const target=task?.machine||machine,reading=await this.read(target);
        if(task)task=this.measure(task,reading);
        if(task?.manualId){task=this.observeManual(task,reading);this.save(task);}
        else if(task){
          // A report cannot overwrite the last continuity checkpoint before the
          // safety loop verifies it, nor publish an unverified running phase.
          if(this.pendingDryerStop(task)&&reading.output===false){
            this.verifyContinuity(task,reading);task=this.dryerCompleted(task);
          }else if(task.recovering)task=this.recover(task,reading);
          else if(['loading','running'].includes(task.phase)){
            if(reading.output!==true)throw new Error('unexpected_power_loss');
            this.verifyContinuity(task,reading);
          }
          task=this.checkpoint(task,reading);this.save(task);
        }
        readings.push({machineId:machine.id,manualRelaySupported:true,manualId:task?.manualId,manualCommandId:task?.manualCommandId,orderId:task?.orderId,phase:task?.phase||(!reading.output?'idle':'uncertain'),activatedAt:task?.activatedAt,startedAt:task?.startedAt,monitoringResumedAt:task?.monitoringResumedAt,usage:this.usage(task),completionReason:task?.completionReason,...reading,error:task?.error,deviceError:null,deviceHost:target.device.host,observedAt:this.now()});
      }catch(e){
        const deviceError=/^[a-z_]{1,60}$/.test(e.message)?e.message:'device_unreachable';
        if(task&&['device_identity_changed','device_restarted_or_clock_changed','device_energy_reset'].includes(deviceError))task={...task,energyStatus:'invalid'};
        const fatal=['unexpected_power_loss','device_identity_changed','device_identity_unavailable','device_restarted_or_clock_changed','device_energy_reset','invalid_recovery_checkpoint','invalid_recovery_phase','start_time_missing','start_during_outage_unknown'].includes(deviceError);
        if(task)this.save(fatal?{...task,phase:'uncertain',recovering:false,error:deviceError,deviceError}:{...task,deviceError});
        readings.push({machineId:machine.id,manualRelaySupported:true,manualId:task?.manualId,manualCommandId:task?.manualCommandId,orderId:task?.orderId,phase:'uncertain',output:task?.output??true,usage:this.usage(task),error:deviceError,deviceError});
      }
    }return readings;
  }
  reconcile(serverOrders){
    const ids=new Set(serverOrders.map(o=>o.id));
    for(const task of this.tasks())if(!ids.has(task.manualId||task.orderId)&&task.output===false&&task.deviceError===null&&['completed','loading_expired','uncertain','manual_off'].includes(task.phase))this.db.prepare('DELETE FROM tasks WHERE machine_id=?').run(task.machine.id);
  }
  close(){this.db.close();}
}
