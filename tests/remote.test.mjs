import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createMobileBridge} from '../lib/mobile.mjs';

test('remote bridge pins HTTPS origin, requires pairing and strips untrusted proxy headers',async()=>{
  let origin;
  const upstream=http.createServer((req,res)=>res.end(JSON.stringify({url:req.url,headers:req.headers})));
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const bridge=createMobileBridge({publicOrigin:()=>origin,upstreamPort:upstream.address().port});
  await new Promise(resolve=>bridge.server.listen(0,'127.0.0.1',resolve));
  const request=(path,headers={},method='GET',body)=>new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port:bridge.server.address().port,path,headers:{host:'claro-test.trycloudflare.com',...headers},method},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));
    });req.on('error',reject);req.end(body);
  });
  try{
    assert.equal((await request('/mobile')).status,503);
    origin='https://claro-test.trycloudflare.com';
    assert.equal((await request('/mobile')).status,200);
    assert.equal((await request('/api/config')).status,401);
    assert.equal((await request('/api/transcribe',{},'POST','audio')).status,401);
    assert.equal((await request('/mobile',{host:'evil.example','x-forwarded-host':'claro-test.trycloudflare.com'})).status,403);
    assert.equal((await request('/pair',{origin:'https://evil.example'},'POST',`code=${bridge.pairingCode}`)).status,403);
    const pair=await request('/pair',{origin,'content-type':'application/x-www-form-urlencoded'},'POST',`code=${bridge.pairingCode}`);
    assert.equal(pair.status,303);assert.match(pair.headers['set-cookie'][0],/Secure; HttpOnly; SameSite=Strict/);
    const cookie=pair.headers['set-cookie'][0].split(';')[0];
    const result=await request('/api/config',{cookie,origin,'x-forwarded-host':'evil.example','x-session-token':'test'});
    assert.equal(result.status,200);
    const forwarded=JSON.parse(result.body);
    assert.equal(forwarded.headers.origin,`http://127.0.0.1:${upstream.address().port}`);
    assert.equal(forwarded.headers.cookie,undefined);
    assert.equal(forwarded.headers['x-forwarded-host'],undefined);
    assert.equal(forwarded.headers['x-session-token'],'test');
    assert.equal((await request('/api/config',{cookie,origin:'null'})).status,403);
  }finally{for(const server of [bridge.server,upstream]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
});
