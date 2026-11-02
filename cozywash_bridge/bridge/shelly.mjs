import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
const sha=value=>createHash('sha256').update(value).digest('hex');
export function digestHeader(challenge,password){
  const fields=Object.fromEntries([...challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m=>[m[1],m[2]??m[3]]));
  if(fields.algorithm!=='SHA-256'||!fields.realm||!fields.nonce||!fields.qop?.split(',').includes('auth'))throw new Error('unsupported_auth_challenge');
  const nc='00000001',cnonce=randomBytes(12).toString('hex'),response=sha(`${sha(`admin:${fields.realm}:${password}`)}:${fields.nonce}:${nc}:${cnonce}:auth:${sha('POST:/rpc')}`);
  const quote=v=>JSON.stringify(v);
  return `Digest username="admin", realm=${quote(fields.realm)}, nonce=${quote(fields.nonce)}, uri="/rpc", algorithm=SHA-256, response=${quote(response)}, qop=auth, nc=${nc}, cnonce=${quote(cnonce)}`;
}
export class ShellyAdapter {
  constructor({allowHardware=false,allowedHosts=[],passwords={},deviceHosts=null,fetchImpl=fetch}={}){this.allowHardware=allowHardware;this.allowedHosts=allowedHosts;this.passwords=passwords;this.deviceHosts=deviceHosts;this.fetch=fetchImpl;this.simOutputs=new Map();}
  async qualify(machine){
    if(machine.device.mode==='simulator')return;
    if(!this.allowHardware||!machine.hardwareApproved)throw new Error('hardware_not_commissioned');
    const host=machine.device.host;
    const privateIP=isIP(host)===4&&(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host));
    if(!privateIP||!this.allowedHosts.includes(host))throw new Error('host_not_allowlisted');
    if(this.deviceHosts&&(!Object.hasOwn(this.deviceHosts,machine.device.id)||this.deviceHosts[machine.device.id]!==host||machine.deviceId!==machine.device.id))throw new Error('device_mapping_mismatch');
    if(!Number.isInteger(machine.channel)||machine.channel<0||machine.channel>3)throw new Error('invalid_channel');
  }
  async rpc(machine,method,params){
    await this.qualify(machine);
    const url=`http://${machine.device.host}/rpc`,body=JSON.stringify({id:1,method,params}),options={method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(4000),redirect:'error'};
    let response=await this.fetch(url,options);
    if(response.status===401){const password=this.passwords[machine.device.id];if(!password)throw new Error('device_credentials_missing');const challenge=response.headers.get('www-authenticate')||'';await response.arrayBuffer();response=await this.fetch(url,{...options,headers:{...options.headers,Authorization:digestHeader(challenge,password)},signal:AbortSignal.timeout(4000)});}
    if(!response.ok)throw new Error('device_http_error');const data=await response.json();if(data.error)throw new Error('device_rpc_error');return data.result;
  }
  async read(machine,task){
    if(machine.device.mode==='simulator'){const output=this.simOutputs.has(machine.id)?this.simOutputs.get(machine.id):task?.output??false;return {output,apower:output&&task?.phase==='running'?400:0};}
    const data=await this.rpc(machine,'Switch.GetStatus',{id:machine.channel});if(typeof data?.output!=='boolean'||!Number.isFinite(data.apower))throw new Error('invalid_device_telemetry');return {output:data.output,apower:data.apower};
  }
  async set(machine,on){
    if(machine.device.mode==='simulator'){this.simOutputs.set(machine.id,on);return;}
    // Do not install a blind auto-off timer: it could cut power during a running cycle.
    await this.rpc(machine,'Switch.Set',{id:machine.channel,on});
  }
}
