"""Run on a Docker host against the packaged add-on and an isolated Shelly/HTTPS emulator."""
import json, os, pathlib, shutil, subprocess, tempfile, time
ROOT=pathlib.Path(__file__).resolve().parents[1]
# Each run needs an empty journal; replay behavior is tested within that run.
BASE=ROOT/'.local'/('ha-container-test-'+str(time.time_ns()))
IMAGE=os.environ.get('COZYWASH_ADDON_TEST_IMAGE','cozywash-ha-connector:1.0.0')
NETWORK='cozywash-ha-test-network'
EMULATOR='cozywash-ha-test-cloud'
ADDON='cozywash-ha-test-addon'
def run(*args,input=None):
 return subprocess.run(args,input=input,text=True,check=True,capture_output=True).stdout.strip()
def docker(*args,**kw):return run('docker',*args,**kw)
def control(body):return cloud('/test/control',body)
def cloud(path,body=None):
 code="const r=await fetch('https://localhost:8443'+process.argv[1],{method:process.argv[2]?'POST':'GET',headers:{'Content-Type':'application/json'},body:process.argv[2]||undefined});console.log(await r.text())"
 return json.loads(docker('exec',EMULATOR,'node','--input-type=module','-e',code,path,json.dumps(body) if body is not None else ''))
def health():
 return json.loads(docker('exec',ADDON,'node','--input-type=module','-e',"console.log(await(await fetch('http://localhost:8099/health')).text())"))
def until(check,timeout=15):
 end=time.monotonic()+timeout
 while True:
  try:
   result=check()
   if result:return result
  except (subprocess.CalledProcessError,ValueError):pass
  if time.monotonic()>end:raise AssertionError('Container integration condition timed out')
  time.sleep(.2)
def start_addon():
 docker('run','-d','--name',ADDON,'--network',NETWORK,'--init','--read-only','--tmpfs','/tmp','--cap-drop','NET_RAW','--cap-drop','AUDIT_WRITE','--cap-drop','MKNOD','--cap-drop','SETFCAP','--security-opt','no-new-privileges:true','-v',str(BASE/'data')+':/data','-v',str(BASE/'tls')+':/tls:ro','-e','NODE_EXTRA_CA_CERTS=/tls/cert.pem',IMAGE)
def main():
 BASE.mkdir(parents=True,exist_ok=True)
 (BASE/'tls').mkdir(exist_ok=True);(BASE/'data').mkdir(exist_ok=True)
 run('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',str(BASE/'tls'/'key.pem'),'-out',str(BASE/'tls'/'cert.pem'),'-subj','/CN=cloud','-addext','subjectAltName=DNS:cloud,DNS:localhost')
 # The bridge reads its trust anchor after dropping privileges.
 os.chmod(BASE/'tls'/'cert.pem',0o644)
 docker('network','create',NETWORK)
 try:
  shutil.copy2(ROOT/'tests/fixtures/ha-shelly-emulator.mjs',BASE/'emulator.mjs')
  docker('run','-d','--name',EMULATOR,'--network',NETWORK,'--network-alias','cloud','-v',str(BASE)+':/fixture:ro','-e','NODE_EXTRA_CA_CERTS=/fixture/tls/cert.pem','node:24-bookworm-slim','node','/fixture/emulator.mjs')
  address=json.loads(docker('inspect',EMULATOR))[0]['NetworkSettings']['Networks'][NETWORK]['IPAddress']
  options={'server_url':'https://cloud:8443','bridge_token':'T'*43,'allow_hardware':True,'shelly_devices':[{'device_id':'test-shelly','host':address,'password':'fixture-password'}]}
  (BASE/'data'/'options.json').write_text(json.dumps(options));os.chmod(BASE/'data'/'options.json',0o600)
  until(lambda:cloud('/test/state'))
  start_addon();until(lambda:health()['connected'])
  uid=docker('exec',ADDON,'node','--input-type=module','-e',"import{readdirSync,readFileSync}from'node:fs';for(const p of readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){try{if(readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')[0].endsWith('node')&&readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes('entrypoint.mjs'))console.log(readFileSync('/proc/'+p+'/status','utf8').match(/^Uid:\\s+(\\d+)/m)[1]);}catch{}}")
  assert uid=='1000',uid
  assert not json.loads(docker('inspect',ADDON))[0]['HostConfig']['PortBindings']
  print('PASS: HA options, unprivileged runtime, private data, no published ports, HTTPS and Shelly Digest handshake',flush=True)
  control({'newOrder':'offline-deadline','loadingSeconds':2});until(lambda:len(cloud('/test/state')['acks'])>0)
  control({'online':False});until(lambda:not cloud('/test/state')['output'])
  until(lambda:not health()['connected']);assert health()['ok']
  assert len(cloud('/test/state')['sets'])==2
  print('PASS: local loading expiry switches the emulated relay off during cloud outage; watchdog stays healthy',flush=True)
  control({'online':True,'orders':[],'command':None});until(lambda:health()['activeTasks']==0)
  control({'newOrder':'restart-safe','loadingSeconds':60,'power':50});until(lambda:any(r.get('phase')=='running' for r in cloud('/test/state')['readings']))
  before=len(cloud('/test/state')['sets']);assert before==3
  # Docker versions may include deprecation notices in stdout; the command's
  # successful exit and the container exit status are the shutdown contract.
  docker('stop','--time','20',ADDON)
  assert json.loads(docker('inspect',ADDON))[0]['State']['ExitCode']==0
  control({'replay':True});docker('start',ADDON)
  until(lambda:any(r.get('phase')=='running' and r.get('monitoringResumedAt') for r in cloud('/test/state')['readings']))
  restored=next(r for r in cloud('/test/state')['readings'] if r.get('phase')=='running')
  started_at=restored['startedAt']
  assert health()['uncertainTasks']==0
  assert len(cloud('/test/state')['sets'])==before and cloud('/test/state')['output']
  # Abrupt crash: committed journal must preserve the same start time too.
  docker('kill','--signal','KILL',ADDON);docker('start',ADDON)
  until(lambda:any(r.get('phase')=='running' and r.get('startedAt')==started_at for r in cloud('/test/state')['readings']))
  assert health()['uncertainTasks']==0 and len(cloud('/test/state')['sets'])==before
  # A hardware reboot is distinct from a software restart, even if output stays on.
  control({'bootAt':int(time.time()*1000)})
  until(lambda:health()['uncertainTasks']==1)
  until(lambda:any(r.get('error')=='device_restarted_or_clock_changed' for r in cloud('/test/state')['readings']))
  assert len(cloud('/test/state')['sets'])==before and cloud('/test/state')['output']
  assert 'T'*43 not in docker('logs',ADDON) and 'fixture-password' not in docker('logs',ADDON)
  print('PASS: graceful restart and SIGKILL preserve running session/start time without replay; hardware reboot retains review lock',flush=True)
  print('PASS: logs contain no configured token or Shelly password',flush=True)
 finally:
  for name in [ADDON,EMULATOR]:subprocess.run(['docker','rm','-f',name],capture_output=True)
  subprocess.run(['docker','network','rm',NETWORK],capture_output=True)
if __name__=='__main__':main()
