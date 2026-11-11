import http from 'node:http';
import {networkInterfaces} from 'node:os';
import {mkdir, readFile, writeFile, access, chmod} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createMobileBridge} from '../lib/mobile.mjs';

const addresses = Object.values(networkInterfaces()).flat().filter(x => !x.internal && x.family === 'IPv4').map(x => x.address);
const privateIP = value => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value);
const address = process.argv[2] || addresses.find(x => x.startsWith('172.20.10.')) || addresses.find(privateIP);
if (!addresses.includes(address) || !privateIP(address)) throw new Error('Укажи локальный IPv4 адрес Mac: npm run mobile -- 172.20.10.2');
const port = 4319, certificatePort = 4320;
const directory = fileURLToPath(new URL('../.runtime/mobile/', import.meta.url));
await mkdir(directory, {recursive:true, mode:0o700});
await chmod(directory, 0o700);
const openssl = (...args) => execFileSync('openssl', args, {cwd:directory, stdio:'pipe'});
try {await access(`${directory}ca.pem`); await access(`${directory}ca.key`);} catch {
  await writeFile(`${directory}ca.cnf`, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=Claro Local Development\n[ca]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
  openssl('req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','365','-keyout','ca.key','-out','ca.pem','-config','ca.cnf');
  await chmod(`${directory}ca.key`,0o600);
}
await writeFile(`${directory}server.cnf`, `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=Claro on Mac\n[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${address}\n`);
openssl('req','-new','-newkey','rsa:2048','-nodes','-sha256','-keyout','server.key','-out','server.csr','-config','server.cnf');
await chmod(`${directory}server.key`,0o600);
openssl('x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','90','-sha256','-extfile','server.cnf','-extensions','server');
openssl('x509','-in','ca.pem','-outform','DER','-out','claro.cer');
const certificate = await readFile(`${directory}claro.cer`);
let credentials = {};
try {credentials = JSON.parse(await readFile(`${directory}credentials.json`,'utf8'));} catch (error) {if (error.code !== 'ENOENT') throw error;}
for (const [name,length] of [['pairingKey',64],['pairingCode',12],['session',64]]) {
  if (credentials[name] !== undefined && !new RegExp(`^[a-fA-F0-9]{${length}}$`).test(credentials[name])) throw new Error('Некорректный файл credentials.json');
}
// Preserve the previously issued link when upgrading the mobile bridge.
if (!credentials.pairingKey) try {
  const previous = JSON.parse(await readFile(`${directory}connection.json`,'utf8'));
  const previousKey = new URL(previous.pairingURL).searchParams.get('key');
  if (/^[a-f0-9]{64}$/.test(previousKey)) credentials.pairingKey = previousKey;
} catch {}
const {server, pairingKey, pairingCode, session} = createMobileBridge({...credentials,address, key:await readFile(`${directory}server.key`), cert:await readFile(`${directory}server.pem`), upstreamPort:Number(process.env.PORT || 4317)});
await writeFile(`${directory}credentials.json`,JSON.stringify({pairingKey,pairingCode,session}),{mode:0o600});
await chmod(`${directory}credentials.json`,0o600);
// Unencrypted bootstrap serves only the public CA certificate, never app data or keys.
const bootstrap = http.createServer((req,res) => {
  if (req.headers.host !== `${address}:${certificatePort}` || req.method !== 'GET' || req.url !== '/claro.cer') {res.writeHead(404); return res.end();}
  res.writeHead(200, {'Content-Type':'application/x-x509-ca-cert', 'Content-Disposition':'attachment; filename="claro.cer"', 'Cache-Control':'no-store'}); res.end(certificate);
});
const listen = (server, port) => new Promise((resolve,reject) => {server.once('error',reject); server.listen(port,address,resolve);});
try {await listen(server,port); await listen(bootstrap,certificatePort);} catch (error) {server.close(); bootstrap.close(); throw error;}
const pairingURL = `https://${address}:${port}/pair?key=${pairingKey}`;
const displayCode = pairingCode.match(/.{4}/g).join('-');
await writeFile(`${directory}connection.json`, JSON.stringify({address, pairingURL, pairingCode:displayCode, appURL:`https://${address}:${port}/mobile`, certificateURL:`http://${address}:${certificatePort}/claro.cer`},null,2), {mode:0o600});
console.log(`Сертификат: http://${address}:${certificatePort}/claro.cer\nClaro: ${pairingURL}\nКод подключения: ${displayCode}\nОставь Mac включённым. Ctrl+C отключает мобильный доступ. При смене сети перезапусти эту команду.`);
const stop = () => {server.closeAllConnections(); bootstrap.closeAllConnections(); server.close(); bootstrap.close();};
process.on('SIGINT',stop); process.on('SIGTERM',stop);
