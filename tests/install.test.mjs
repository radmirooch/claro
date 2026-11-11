import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync, spawn } from 'node:child_process';
import { missingEnvSettings, ensureEnvSettings } from '../scripts/setup-common.mjs';
import { localOllamaModelInstalled, ensureOllamaModel } from '../scripts/setup-translation.mjs';
import { warmModels } from '../lib/warmup.mjs';
import { createApp } from '../server.mjs';

const settings = {
  OLLAMA_MODEL: 'translategemma:4b',
  OLLAMA_URL: 'http://127.0.0.1:11435',
  OLLAMA_BIN: '.runtime/ollama/ollama'
};

test('setup appends missing environment keys and preserves values, comments and line endings', async () => {
  const original = '# Synthetic settings\r\nexport OLLAMA_MODEL = "custom:4b"\r\nOLLAMA_URL=\r\nEXTRA="value\r\nOLLAMA_BIN=inside a multiline value\r\nend"';
  const addition = missingEnvSettings(original, settings);
  assert.equal(addition, '\r\nOLLAMA_BIN=.runtime/ollama/ollama\r\n');
  assert.equal(missingEnvSettings(original + addition, settings), '');
  const directory = await mkdtemp(join(tmpdir(), 'claro-setup-'));
  try {
    const path = join(directory, '.env');
    await ensureEnvSettings(path, settings);
    assert.equal(await readFile(path, 'utf8'), missingEnvSettings('', settings));
    await writeFile(path, original);
    await ensureEnvSettings(path, settings);
    await ensureEnvSettings(path, settings);
    assert.equal(await readFile(path, 'utf8'), original + addition);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('shell entry points pass syntax checks without execution', t => {
  for (const [shell, path] of [['bash', 'install.sh'], ['bash', 'scripts/uninstall.sh'], ['zsh', 'start.command']]) {
    const result = spawnSync(shell, ['-n', path], { encoding: 'utf8' });
    if (result.error?.code === 'ENOENT' && shell === 'zsh') {
      t.diagnostic('zsh отсутствует на этой платформе, проверка start.command пропущена');
      continue;
    }
    assert.equal(result.status, 0, `${path}: ${result.stderr || result.error || ''}`);
  }
});

test('local Ollama cache is ready only when every manifest blob is present with its full size', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'claro-models-'));
  const digest = `sha256:${'a'.repeat(64)}`;
  try {
    const manifest = join(directory, 'manifests/registry.ollama.ai/library/qwen3');
    await mkdir(manifest, { recursive: true });
    await mkdir(join(directory, 'blobs'));
    await writeFile(join(manifest, '4b'), JSON.stringify({ config: { digest, size: 3 }, layers: [{ digest, size: 3 }] }));
    assert.equal(await localOllamaModelInstalled('qwen3:4b', directory), false);
    await writeFile(join(directory, 'blobs', digest.replace(':', '-')), 'ok');
    assert.equal(await localOllamaModelInstalled('qwen3:4b', directory), false);
    await writeFile(join(directory, 'blobs', digest.replace(':', '-')), 'abc');
    assert.equal(await localOllamaModelInstalled('qwen3:4b', directory), true);
    assert.equal(await localOllamaModelInstalled('../qwen3:4b', directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('already installed Ollama models never call the download endpoint', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network request'); });
  await ensureOllamaModel('qwen3:4b', [{ name: 'qwen3:4b' }]);
  assert.equal(fetch.mock.callCount(), 0);
});

test('creating an application never warms providers or makes network requests', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network request'); });
  const provider = { status() { calls.push('status'); }, translate() { calls.push('translate'); }, gloss() { calls.push('gloss'); } };
  const server = createApp({ translator: provider, glosser: provider });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, []);
  assert.equal(fetch.mock.callCount(), 0);
  server.close();
});

test('warmup waits for Ollama and uses synthetic requests with independent model options', async () => {
  const calls = [];
  let polls = 0;
  let pauses = 0;
  const providers = [
    { url: 'http://127.0.0.1:11435', model: 'translategemma:4b' },
    { url: 'http://127.0.0.1:11435', model: 'qwen3:4b' }
  ];
  await warmModels(providers, {
    pause: async () => { pauses++; },
    request: async (url, options) => {
      if (url.endsWith('/api/tags')) {
        if (polls++ === 0)
          throw new Error('starting');
        return { ok: true, json: async () => ({ models: providers.map(provider => ({ name: provider.model })) }) };
      }
      calls.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ done: true }) };
    }
  });
  assert.equal(pauses, 1);
  assert.deepEqual(calls.map(call => call.model), providers.map(provider => provider.model));
  assert.deepEqual(calls.map(call => call.options.num_ctx), [2048, 4096]);
  for (const payload of calls) {
    assert.equal(payload.keep_alive, '30m');
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.messages, [{ role: 'user', content: 'Translate into Russian: Hello.' }]);
  }
});

test('warmup logs one generic line per failure and keeps warming the next model', async () => {
  const lines = [];
  let requests = 0;
  await warmModels([{ url: 'http://127.0.0.1', model: 'one' }, { url: 'http://127.0.0.1', model: 'two' }], {
    attempts: 1,
    pause: async () => {},
    request: async () => { requests++; throw new Error('synthetic private error'); },
    log: line => lines.push(line)
  });
  assert.equal(requests, 2);
  assert.deepEqual(lines, ['Не удалось прогреть модель перевода.', 'Не удалось прогреть модель значений слов.']);
});

test('manifest opens the conversation in standalone mode with the current light theme', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.theme_color, '#fcfcfc');
  assert.equal(manifest.background_color, '#fcfcfc');
});


test('word hints are accepted through the API while the separate warmup request is pending', async () => {
  let releaseWarmup;
  let warmupStarted;
  const started = new Promise(resolve => { warmupStarted = resolve; });
  const provider = {
    url: 'http://127.0.0.1:11435',
    model: 'qwen3:4b',
    async status() { return { ready:true }; },
    async gloss() { return [{source:'Hello',meaning:'привет',index:0}]; }
  };
  const warming = warmModels([null, provider], {
    request: async url => {
      if (url.endsWith('/api/tags'))
        return {ok:true,json:async()=>({models:[{name:provider.model}]})};
      warmupStarted();
      return new Promise(resolve => {
        releaseWarmup = () => resolve({ok:true,json:async()=>({done:true})});
      });
    }
  });
  await started;
  const server = createApp({glosser:provider});
  async function request(method, url, input, token) {
    const req = Readable.from(input ? [Buffer.from(JSON.stringify(input))] : []);
    req.method = method;
    req.url = url;
    req.headers = {host:'127.0.0.1:4317', 'x-session-token':token};
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.writeHead = status => { res.status = status; };
    const finished = new Promise(resolve => {
      res.end = body => resolve({status:res.status, body:JSON.parse(body)});
    });
    server.emit('request', req, res);
    return finished;
  }
  try {
    const config = await request('GET', '/api/config');
    const result = await request('POST', '/api/gloss', {
      text:'Hello.',translation:'Привет.',source_language:'en',target_language:'ru',caption_id:'synthetic'
    }, config.body.token);
    assert.equal(result.status, 200);
    assert.equal(result.body.caption_id, 'synthetic');
    assert.equal(result.body.glosses[0].meaning, 'привет');
  } finally {
    releaseWarmup();
    await warming;
    server.close();
  }
});


for (const alreadyRunning of [true, false]) {
  test(`launcher ${alreadyRunning ? 'reuses a running server and opens Chrome' : 'starts a server, opens the browser and stops its child'}`, {timeout:10000}, async t => {
    if (spawnSync('zsh', ['--version']).error?.code === 'ENOENT') {
      t.skip('zsh отсутствует на этой платформе');
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), 'claro-launcher-'));
    const project = join(directory, 'project with spaces');
    const bin = join(directory, '.local/bin');
    let launcher;
    try {
      await mkdir(project);
      await mkdir(bin, {recursive:true});
      await mkdir(join(directory, 'Applications'));
      if (alreadyRunning)
        await mkdir(join(directory, 'Applications/Google Chrome.app'));
      const source = (await readFile(new URL('../start.command', import.meta.url), 'utf8'))
        .replace("'/Applications/Google Chrome.app'", '"$HOME/System Applications/Google Chrome.app"');
      await writeFile(join(project, 'start.command'), source);
      const entry = join(directory, 'Applications/Claro.command');
      await symlink(join(project, 'start.command'), entry);
      const scripts = {
        node: `
          const fs = require('node:fs');
          if (!process.argv[2]) {
            console.log('54321');
          } else {
            process.on('SIGTERM', () => {
              fs.writeFileSync('stopped', 'yes');
              process.exit(0);
            });
            fs.writeFileSync('started', 'yes');
            setInterval(() => {}, 1000);
          }
        `,
        curl: `
          const fs = require('node:fs');
          process.exit(process.env.TEST_RUNNING === 'yes' || fs.existsSync('started') ? 0 : 1);
        `,
        open: `require('node:fs').writeFileSync('opened', JSON.stringify(process.argv.slice(2)));`
      };
      for (const [name, source] of Object.entries(scripts)) {
        await writeFile(join(bin, name), `#!${process.execPath}\n${source}`);
        await chmod(join(bin, name), 0o700);
      }
      launcher = spawn('zsh', [entry], {
        env:{...process.env,HOME:directory,TEST_RUNNING:alreadyRunning ? 'yes' : 'no'},
        stdio:['ignore','pipe','pipe']
      });
      let output = '';
      launcher.stdout.on('data', chunk => { output += chunk; });
      launcher.stderr.on('data', chunk => { output += chunk; });
      const finished = new Promise(resolve => launcher.once('exit', code => resolve(code)));
      if (!alreadyRunning) {
        for (let attempt = 0; attempt < 100 && !output.includes('Claro работает.'); attempt++)
          await new Promise(resolve => setTimeout(resolve, 20));
        assert.match(output, /Claro работает. Закройте это окно, чтобы остановить/u);
        launcher.kill('SIGTERM');
      }
      const exit = await finished;
      assert.equal(exit, alreadyRunning ? 0 : 143, output);
      const argumentsUsed = JSON.parse(await readFile(join(project, 'opened'), 'utf8'));
      assert.deepEqual(argumentsUsed, alreadyRunning
        ? ['-na','Google Chrome','--args','--app=http://127.0.0.1:54321/']
        : ['http://127.0.0.1:54321/']);
      if (!alreadyRunning)
        assert.equal(await readFile(join(project, 'stopped'), 'utf8'), 'yes');
    } finally {
      if (launcher?.exitCode === null)
        launcher.kill('SIGTERM');
      await rm(directory, {recursive:true,force:true});
    }
  });
}
