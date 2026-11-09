// Isolated test fixture: no real account, device, or payment provider is contacted.
import {createServer as http} from 'node:http';
import {createServer as https} from 'node:https';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {networkInterfaces} from 'node:os';
const host=Object.values(networkInterfaces()).flat().find(n=>n.family==='IPv4'&&!n.internal).address;
const machine={id:'test-machine',deviceId:'test-shelly',locationId:'test-location',channel:0,hardwareApproved:true,startWatts:15,idleWatts:5,startConfirmSeconds:1,idleConfirmSeconds:3,minimumRunSeconds:5,device:{id:'test-shelly',host,mode:'shelly'}};
const initialBootAt=Date.now()-120000;
const state={bootAt:initialBootAt,mac:'AABBCCDDEEFF',online:true,output:false,power:0,energyWh:100,sets:[],acks:[],readings:[],command:null,orders:[],replay:false};
const read=async req=>{let body='';for await(const c of req)body+=c;return body?JSON.parse(body):{};};
const send=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
http(async(req,res)=>{
 if(req.url!=='/rpc')return send(res,{},404);
 const call=await read(req);
 const digest=Object.fromEntries([...(req.headers.authorization||'').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)].map(m=>[m[1],m[2]??m[3]]));
 const sha=x=>createHash('sha256').update(x).digest('hex');
 const expected=sha(sha('admin:shelly-test:fixture-password')+':test-nonce:'+digest.nc+':'+digest.cnonce+':auth:'+sha('POST:/rpc'));
 // Exercise the real adapter's digest challenge path before accepting local RPC.
 if(digest.username!=='admin'||digest.nonce!=='test-nonce'||digest.uri!=='/rpc'||digest.response!==expected){res.setHeader('WWW-Authenticate','Digest realm="shelly-test", nonce="test-nonce", algorithm=SHA-256, qop="auth"');return send(res,{},401);}
 if(call.method==='Switch.Set'){state.output=call.params.on;state.sets.push({on:state.output,at:Date.now()});}
 else if(call.method==='Sys.GetStatus')return send(res,{id:call.id,result:{mac:state.mac,uptime:Math.floor((Date.now()-state.bootAt)/1000)}});
 else if(call.method!=='Switch.GetStatus')return send(res,{error:{code:-1}});
 send(res,{id:call.id,result:{output:state.output,apower:state.power,aenergy:{total:state.energyWh}}});
}).listen(80,'0.0.0.0');
https({key:readFileSync('/fixture/tls/key.pem'),cert:readFileSync('/fixture/tls/cert.pem')},async(req,res)=>{
 if(req.url==='/test/state')return send(res,state);
 if(req.url==='/test/control'){const body=await read(req);Object.assign(state,body);if(body.newOrder){const oid=body.newOrder;state.command={id:oid+':enable',orderId:oid,action:'enable',locationId:'test-location',machine,loadingSeconds:body.loadingSeconds||60,durationSeconds:1800,deadline:Date.now()+15000};state.orders=[{id:oid,status:'activating'}];state.acks=[];state.readings=[];state.replay=false;}return send(res,{ok:true});}
 if(!state.online)return send(res,{error:'test_outage'},503);
 if(req.headers.authorization!=='Bearer '+ 'T'.repeat(43))return send(res,{error:'unauthorized'},401);
 const snapshot=()=>({serverTime:Date.now(),machines:[machine],commands:state.command&&(state.replay||!state.acks.length)?[state.command]:[],orders:state.orders});
 if(req.url==='/api/bridge/poll')return send(res,snapshot());
 if(req.url==='/api/bridge/heartbeat'){state.readings=(await read(req)).readings;return send(res,snapshot());}
 if(req.url.startsWith('/api/bridge/commands/')&&req.url.endsWith('/ack')){state.acks.push(await read(req));return send(res,{ok:true});}
 send(res,{},404);
}).listen(8443,'0.0.0.0');
