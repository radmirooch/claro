import {spawn} from 'node:child_process';
import {mkdir, writeFile, chmod, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createMobileBridge} from '../lib/mobile.mjs';

const directory=fileURLToPath(new URL('../.runtime/remote/',import.meta.url));
await mkdir(directory,{recursive:true,mode:0o700});
await chmod(directory,0o700);
await writeFile(directory+'quick.yml','{}\n',{mode:0o600});
const upstreamPort=Number(process.env.PORT || 4317);
const check=await fetch(`http://127.0.0.1:${upstreamPort}/api/config`);
if(!check.ok)throw new Error('Сначала запусти Claro.');
let origin, closing=false, ready=false;
const bridge=createMobileBridge({publicOrigin:()=>origin,upstreamPort});
await new Promise((resolve,reject)=>{bridge.server.once('error',reject);bridge.server.listen(4321,'127.0.0.1',resolve);});
const tunnel=spawn(process.env.CLOUDFLARED_BIN || '/opt/homebrew/bin/cloudflared',[
  'tunnel','--config',directory+'quick.yml','--no-autoupdate','--url','http://127.0.0.1:4321','--protocol','http2',
],{stdio:['ignore','pipe','pipe']});
// Keep only the public URL; do not persist tunnel tokens or service logs.
let buffer='';
async function announce(chunk){
  buffer=(buffer+chunk.toString()).slice(-16000);
  const found=buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/);
  if(!origin && found){
    origin=found[0];
    const connection={appURL:origin+'/mobile',pairingCode:bridge.pairingCode.match(/.{4}/g).join('-'),pid:process.pid};
    await writeFile(directory+'connection.json',JSON.stringify(connection,null,2),{mode:0o600});
    console.log(`Claro: ${connection.appURL}\nКод: ${connection.pairingCode}`);
  }
  if(buffer.includes('Registered tunnel connection') && !ready){ready=true;console.log('Удалённое подключение готово.');}
}
tunnel.stdout.on('data',chunk=>announce(chunk).catch(stop));
tunnel.stderr.on('data',chunk=>announce(chunk).catch(stop));
const awake=spawn('/usr/bin/caffeinate',['-i','-w',String(process.pid)],{stdio:'ignore'});
awake.on('error',()=>{});
async function stop(error){
  if(closing)return;closing=true;
  if(error)console.error('Подключение остановлено:',error.message || error);
  tunnel.kill('SIGTERM');awake.kill('SIGTERM');
  bridge.server.closeAllConnections();bridge.server.close();
  await rm(directory+'connection.json',{force:true});
  if(error)process.exitCode=1;
}
tunnel.on('error',stop);
tunnel.on('exit',code=>{if(!closing)stop(new Error(`Туннель завершился (${code}).`));});
process.on('SIGTERM',()=>stop());process.on('SIGINT',()=>stop());
const timeout=setTimeout(()=>{if(!ready)stop(new Error('Туннель не подключился за минуту.'));},60000);
timeout.unref();
