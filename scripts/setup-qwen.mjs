// Explicit download step; normal application startup is offline.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const project = fileURLToPath(new URL('../', import.meta.url));
const env = {...process.env, UV_CACHE_DIR: `${project}.runtime/uv-cache`, HF_HOME: `${project}.runtime/huggingface`, HF_HUB_DISABLE_TELEMETRY:'1'};
async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd:project, env, stdio:'inherit'});
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command}: exit ${code}`)));
  });
}
try {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Qwen MLX requires an Apple Silicon Mac.');
  await run('uv', ['venv', '--python', process.env.QWEN_SETUP_PYTHON || '3.12', '--allow-existing', '.runtime/qwen-venv']);
  await run('uv', ['pip', 'install', '--python', '.runtime/qwen-venv/bin/python', 'mlx-qwen3-asr==0.4.4']);
  const model = process.argv[2] || 'moona3k/mlx-qwen3-asr-0.6b-4bit';
  const revision = model === 'moona3k/mlx-qwen3-asr-0.6b-4bit' ? '4c59c533f95c84afb796655e814709034f826f04' : 'main';
  await run('.runtime/qwen-venv/bin/python', ['-c', 'import sys; from huggingface_hub import snapshot_download; print(snapshot_download(sys.argv[1], revision=sys.argv[2]))', model, revision]);
  console.log('Qwen installed. Run npm start; select Qwen in the app. For a custom model set QWEN_MODEL in .env.');
} catch (error) {console.error(error.message); process.exitCode = 1;}
