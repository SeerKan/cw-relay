import {readFileSync,mkdirSync,chownSync,chmodSync} from 'node:fs';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {addonOptions} from './options.mjs';
import {startBridge} from './bridge/runtime.mjs';
process.umask(0o077);
const data=process.env.COZYWASH_DATA_DIR||'/data';
let options;
try{options=addonOptions(JSON.parse(readFileSync(join(data,'options.json'),'utf8')));}
catch(error){console.error(`CozyWash: configuration_error (${['invalid_options','invalid_server_url','https_server_url_required','bridge_token_required','invalid_hardware_option','invalid_shelly_devices','shelly_devices_required','invalid_device_id','private_shelly_ip_required','duplicate_shelly_device','invalid_shelly_password'].includes(error.message)?error.message:'options_unavailable'}). Check the Configuration tab.`);process.exit(1);}
const stateDir=join(data,'bridge');
try{
  mkdirSync(stateDir,{recursive:true,mode:0o700});
  if(process.getuid?.()===0){chownSync(data,1000,1000);chmodSync(data,0o700);chownSync(stateDir,1000,1000);chmodSync(stateDir,0o700);process.setgroups([]);process.setgid(1000);process.setuid(1000);}
}catch{console.error('CozyWash: private_data_directory_unavailable');process.exit(1);}
const runtime=startBridge({...options,path:join(stateDir,'bridge.sqlite')});
const health=createServer((req,res)=>{
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  if(req.url!=='/health'||req.method!=='GET'){res.writeHead(404);res.end('{"error":"not_found"}');return;}
  // Cloud disconnection must not restart local safety timers or replay relays.
  res.writeHead(200);res.end(JSON.stringify({ok:true,...runtime.status()}));
});
health.listen(8099,'0.0.0.0');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;health.close();await runtime.close();}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
console.log('CozyWash Shelly Connector started. Local journal preserved in /data/bridge.');
