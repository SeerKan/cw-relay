import {BridgeEngine} from './engine.mjs';
import {ShellyAdapter} from './shelly.mjs';

export function startBridge({origin,token,path,allowHardware=false,allowedHosts=[],passwords={},deviceHosts,simulationSpeed=60,fetchImpl=fetch,adapter,engine,log=console.error,syncInterval=3000,tickInterval=500}={}){
  if(typeof token!=='string'||!token.trim())throw new Error('bridge_token_required');
  const server=new URL(origin);
  if(server.username||server.password||server.search||server.hash||!['','/'].includes(server.pathname))throw new Error('invalid_server_url');
  origin=server.origin;
  adapter??=new ShellyAdapter({allowHardware,allowedHosts,passwords,deviceHosts});
  engine??=new BridgeEngine({path,adapter,simulationSpeed});
  let machines=[],networkBusy=false,localBusy=false,clockValid=false,stopping=false,lastLog=0;
  const state={connected:false,lastSync:null,lastLocalTick:null,lastError:null,machineCount:0,clockValid:false};
  const pending=new Set();
  let localDone=Promise.resolve();
  async function withLocal(operation){
    while(localBusy)await localDone;
    localBusy=true;let release;localDone=new Promise(resolve=>{release=resolve;});
    try{return await operation();}finally{localBusy=false;release();}
  }
  function warning(code){state.lastError=code;if(Date.now()-lastLog>30000){lastLog=Date.now();log(code);}}
  async function api(route,body){
    const response=await fetchImpl(`${origin}/api/bridge${route}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000),redirect:'error'});
    if(!response.ok)throw new Error(response.status===401?'bridge_authentication_failed':'bridge_server_unavailable');
    return response.json();
  }
  async function sync(){
    if(stopping||networkBusy)return;networkBusy=true;
    try{
      const remote=await api('/poll');
      if(!Array.isArray(remote.machines)||!Array.isArray(remote.commands)||!Number.isFinite(remote.serverTime))throw new Error('invalid_bridge_response');
      clockValid=Math.abs(remote.serverTime-Date.now())<30000;state.clockValid=clockValid;if(!clockValid)warning('bridge_clock_out_of_sync');machines=remote.machines;state.machineCount=machines.length;
      for(const command of remote.commands){
        if(stopping)break;
        const ack=await withLocal(async()=>{
          if(stopping)return;
          const matching=machines.find(m=>m.id===command.machine.id);
          if(!matching||matching.deviceId!==command.machine.deviceId||matching.channel!==command.machine.channel||matching.device.host!==command.machine.device.host)throw new Error('mapping_mismatch');
          if(command.action==='enable'&&!clockValid)return;
          return await engine.command(command);
        });
        if(ack)try{await api(`/commands/${encodeURIComponent(command.id)}/ack`,ack);}catch{warning('bridge_acknowledgement_unavailable');}
      }
      if(stopping)return;
      const readings=await withLocal(()=>engine.readings(machines));
      const response=await api('/heartbeat',{readings});
      if(!Array.isArray(response.orders))throw new Error('invalid_bridge_response');
      await withLocal(()=>engine.reconcile(response.orders));state.connected=true;state.lastSync=Date.now();state.lastError=clockValid?null:'bridge_clock_out_of_sync';
    }catch(error){state.connected=false;warning(['bridge_authentication_failed','mapping_mismatch','invalid_bridge_response'].includes(error.message)?error.message:'bridge_sync_unavailable');}
    finally{networkBusy=false;}
  }
  async function tick(){
    if(stopping||localBusy)return;
    try{await withLocal(()=>engine.tick());state.lastLocalTick=Date.now();}catch{warning('bridge_local_journal_error');}
  }
  function track(operation){const promise=operation();pending.add(promise);promise.finally(()=>pending.delete(promise));return promise;}
  const localTimer=setInterval(()=>track(tick),tickInterval),networkTimer=setInterval(()=>track(sync),syncInterval);
  track(tick);track(sync);
  return {
    status(){const tasks=engine.tasks();return {...state,running:!stopping,hardwareEnabled:allowHardware,activeTasks:tasks.length,uncertainTasks:tasks.filter(t=>t.phase==='uncertain').length};},
    async close(){if(stopping)return;stopping=true;clearInterval(localTimer);clearInterval(networkTimer);await Promise.allSettled([...pending]);engine.close();},
  };
}
