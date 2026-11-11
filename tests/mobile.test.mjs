import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createMobileBridge} from '../lib/mobile.mjs';

test('mobile TLS bridge requires pairing, rejects foreign origins, and forwards authenticated audio and SSE', async () => {
  const directory = await mkdtemp(join(tmpdir(),'claro-tls-'));
  let upstream, server;
  try {
    await writeFile(join(directory,'tls.cnf'), '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=CA:TRUE\n');
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout','key.pem','-out','cert.pem','-config','tls.cnf'],{cwd:directory,stdio:'pipe'});
    const key = await readFile(join(directory,'key.pem')), cert = await readFile(join(directory,'cert.pem'));
    upstream = http.createServer(async (req,res) => {
      if (req.url === '/api/events') {res.writeHead(200,{'Content-Type':'text/event-stream'}); res.write('data: {"type":"caption"}\n\n'); return res.end();}
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({headers:req.headers,body:Buffer.concat(chunks).toString()}));
    });
    await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve));
    const bridge = createMobileBridge({key,cert,address:'127.0.0.1',upstreamPort:upstream.address().port});
    server = bridge.server;
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    let port = server.address().port;
    const request = (path,headers={},method='GET',body) => new Promise((resolve,reject) => {
      const req = https.request({hostname:'127.0.0.1',port,path,headers,method,ca:cert,checkServerIdentity:(_host,certificate) => checkServerIdentity('127.0.0.1',certificate)}, res => {
        const chunks = []; res.on('data',chunk => chunks.push(chunk)); res.on('end',() => resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
      }); req.on('error',reject); req.end(body);
    });
    assert.equal((await request('/api/config')).status,401);
    const login = await request('/mobile'); assert.equal(login.status,200); assert.match(login.body,/Код подключения/);
    assert.equal(login.headers['referrer-policy'],'same-origin','native form posts must retain their real Origin');
    const manifest = await request('/manifest.webmanifest'); assert.equal(manifest.status,200); assert.equal(JSON.parse(manifest.body).start_url,'/mobile');
    assert.equal((await request('/apple-touch-icon.png')).headers['content-type'],'image/png');
    assert.equal((await request('/pair?key=bad')).status,403);
    const wrongCode = await request('/pair',{'content-type':'application/x-www-form-urlencoded',origin:`https://127.0.0.1:${port}`},'POST','code=wrong');
    assert.equal(wrongCode.status,403); assert.equal(wrongCode.headers['referrer-policy'],'same-origin','retry form also preserves Origin');
    assert.equal((await request('/pair',{origin:'https://evil.example'},'POST',`code=${bridge.pairingCode}`)).status,403);
    assert.equal((await request('/pair',{origin:'null'},'POST',`code=${bridge.pairingCode}`)).status,403);
    const codePair = await request('/pair',{'content-type':'application/x-www-form-urlencoded',origin:`https://127.0.0.1:${port}`},'POST',`code=${bridge.pairingCode.toLowerCase().match(/.{4}/g).join('-')}`);
    assert.equal(codePair.status,303); assert.equal(codePair.headers.location,'/mobile');
    const pair = await request(`/pair?key=${bridge.pairingKey}`);
    assert.equal(pair.status,303); assert.equal(pair.headers.location,'/mobile');
    assert.equal(pair.headers['referrer-policy'],'no-referrer','pairing links must not leak their URL secret');
    assert.match(pair.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);
    assert.match(pair.headers['set-cookie'][0],/Max-Age=2592000/);
    const cookie = pair.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request('/api/config',{cookie,origin:'https://evil.example'})).status,403);
    assert.equal((await request('/api/config',{cookie,host:'evil.example'})).status,403);
    const response = await request('/api/transcribe',{cookie,origin:`https://127.0.0.1:${port}`,'x-session-token':'token','content-type':'audio/wav','x-forwarded-host':'evil.example'},'POST','audio bytes');
    assert.equal(response.status,200);
    const forwarded = JSON.parse(response.body);
    assert.equal(forwarded.body,'audio bytes');
    assert.equal(forwarded.headers.host,`127.0.0.1:${upstream.address().port}`);
    assert.equal(forwarded.headers.origin,`http://127.0.0.1:${upstream.address().port}`);
    assert.equal(forwarded.headers['x-session-token'],'token');
    assert.equal(forwarded.headers.cookie,undefined); assert.equal(forwarded.headers['x-forwarded-host'],undefined);
    const events = await request('/api/events',{cookie});
    assert.equal(events.headers['content-type'],'text/event-stream'); assert.match(events.body,/caption/);
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
    // An installed Home Screen app can reuse its cookie after the bridge restarts.
    server = createMobileBridge({key,cert,address:'127.0.0.1',upstreamPort:upstream.address().port,pairingKey:bridge.pairingKey,pairingCode:bridge.pairingCode,session:bridge.session}).server;
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); port=server.address().port;
    assert.equal((await request('/mobile',{cookie})).status,200);
    assert.equal((await request('/api/config',{cookie})).status,200);
    for(let i=0;i<8;i++) assert.equal((await request('/pair?key=bad')).status,403);
    assert.equal((await request('/pair?key=bad')).status,429);
  } finally {
    for (const listener of [server,upstream]) if (listener) {listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve));}
    await rm(directory,{recursive:true,force:true});
  }
});
