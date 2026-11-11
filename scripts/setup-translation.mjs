// Explicit opt-in bootstrap. npm start never downloads software or model weights.
import {mkdir, access, writeFile} from 'node:fs/promises';
import {createWriteStream, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const runtime = `${project}.runtime`;
const archive = `${runtime}/ollama-darwin.tgz`;
const binary = `${runtime}/ollama/ollama`;
const version = 'v0.40.15';
const sha256 = '607c79d5d6315ef9d896db83adde736a4c0057196329843544e79b95afb260a8';
const endpoint = 'http://127.0.0.1:11435';
const model = process.argv[2] || 'translategemma:4b';
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: 'inherit'}); child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
let engine;
async function main() {
  if (process.platform !== 'darwin') throw new Error('This bootstrap is for macOS. Install Ollama from ollama.com on your platform and follow README.');
  console.log(`Installing a project-local Ollama runtime (~186 MB) and ${model} (TranslateGemma 4B: ~3.3 GB). No app audio/text is uploaded.`);
  await mkdir(`${runtime}/ollama`, {recursive: true});
  try {await access(archive);} catch {
    const response = await fetch(`https://github.com/ollama/ollama/releases/download/${version}/ollama-darwin.tgz`);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  }
  const hash = createHash('sha256'); for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest('hex') !== sha256) throw new Error('Ollama archive checksum mismatch. Remove .runtime/ollama-darwin.tgz and retry.');
  try {await access(binary); console.log('Reusing the existing project-local runtime.');}
  catch {await run('tar', ['-xzf', archive, '-C', `${runtime}/ollama`]);}
  let reachable = false;
  try {reachable = (await fetch(`${endpoint}/api/tags`, {signal: AbortSignal.timeout(1000)})).ok;} catch {}
  if (!reachable) {
    engine = spawn(binary, ['serve'], {stdio: 'ignore', env: {...process.env, OLLAMA_HOST: '127.0.0.1:11435', OLLAMA_MODELS: `${runtime}/models`, OLLAMA_NO_CLOUD: '1'}});
    let launchError; engine.on('error', error => {launchError = error;});
    for (let attempt = 0; attempt < 40; attempt++) {
      if (launchError) throw launchError;
      try {if ((await fetch(`${endpoint}/api/tags`, {signal: AbortSignal.timeout(1000)})).ok) {reachable = true; break;}} catch {}
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!reachable) throw new Error('Ollama did not become ready.');
  }
  console.log(`Downloading ${model} from the Ollama registry…`);
  const response = await fetch(`${endpoint}/api/pull`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model, stream: true})});
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`);
  let pending = '', last = -1, success = false;
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, {stream: true});
    const lines = pending.split('\n'); pending = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const event = JSON.parse(line); if (event.error) throw new Error(event.error);
      if (event.status === 'success') success = true;
      if (event.total && Number.isFinite(event.completed)) {const progress = Math.floor(10 * event.completed / event.total); if (progress !== last) {console.log(`${progress * 10}%`); last = progress;}}
    }
  }
  if (!success) throw new Error('Model download did not report success.');
  const settings = `OLLAMA_MODEL=${model}\nOLLAMA_URL=${endpoint}\nOLLAMA_BIN=.runtime/ollama/ollama\n`;
  try {await access(`${project}.env`); console.log('Existing .env preserved. Ensure these settings are present:\n' + settings);}
  catch {await writeFile(`${project}.env`, settings, {flag: 'wx'});}
  console.log('Ready. Start the app with npm start.');
}
const stop = () => {engine?.kill('SIGTERM');};
process.on('SIGINT', () => {stop(); process.exit(130);});
process.on('SIGTERM', () => {stop(); process.exit(143);});
main().catch(e => {console.error(e.message); process.exitCode = 1;}).finally(stop);
