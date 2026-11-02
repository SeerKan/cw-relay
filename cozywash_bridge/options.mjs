import {isIP} from 'node:net';
export function addonOptions(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('invalid_options');
  let server;
  try{server=new URL(input.server_url);}catch{throw new Error('invalid_server_url');}
  if(server.protocol!=='https:'||server.username||server.password||server.hash||server.search||!['','/'].includes(server.pathname))throw new Error('https_server_url_required');
  if(typeof input.bridge_token!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(input.bridge_token))throw new Error('bridge_token_required');
  if(typeof input.allow_hardware!=='boolean')throw new Error('invalid_hardware_option');
  if(!Array.isArray(input.shelly_devices)||input.shelly_devices.length>200)throw new Error('invalid_shelly_devices');
  if(input.allow_hardware&&!input.shelly_devices.length)throw new Error('shelly_devices_required');
  const allowedHosts=[],passwords=Object.create(null),deviceHosts=Object.create(null),ids=new Set();
  for(const device of input.shelly_devices){
    if(!device||typeof device.device_id!=='string'||!device.device_id.trim()||device.device_id.length>80||!/^[A-Za-z0-9_-]+$/.test(device.device_id))throw new Error('invalid_device_id');
    if(isIP(device.host)!==4||!(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(device.host)))throw new Error('private_shelly_ip_required');
    if(ids.has(device.device_id)||allowedHosts.includes(device.host))throw new Error('duplicate_shelly_device');
    if(device.password!==undefined&&(typeof device.password!=='string'||device.password.length>512))throw new Error('invalid_shelly_password');
    ids.add(device.device_id);allowedHosts.push(device.host);deviceHosts[device.device_id]=device.host;
    if(device.password)passwords[device.device_id]=device.password;
  }
  return {origin:server.origin,token:input.bridge_token,allowHardware:input.allow_hardware,allowedHosts,passwords,deviceHosts};
}
