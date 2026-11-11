import { fileURLToPath } from 'node:url';
import { project, run } from './setup-common.mjs';

export const qwenModel = 'moona3k/mlx-qwen3-asr-0.6b-4bit';
const pinnedRevision = '4c59c533f95c84afb796655e814709034f826f04';

export async function setupQwen(model = qwenModel) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64')
    throw new Error('Для Qwen MLX нужен Mac на Apple Silicon. См. docs/setup.md.');
  const env = {
    ...process.env,
    UV_CACHE_DIR: `${project}.runtime/uv-cache`,
    HF_HOME: `${project}.runtime/huggingface`,
    HF_HUB_DISABLE_TELEMETRY: '1'
  };
  const python = `${project}.runtime/qwen-venv/bin/python`;
  const revision = model === qwenModel ? pinnedRevision : 'main';
  try {
    await run(python, [
      '-c',
      `import importlib.metadata
assert importlib.metadata.version("mlx-qwen3-asr") == "0.4.4"`
    ], { env, stdio: 'ignore' });
  } catch {
    console.log('Распознавание — создаём окружение Qwen.');
    await run('uv', ['venv', '--python', process.env.QWEN_SETUP_PYTHON || '3.12', '--allow-existing', '.runtime/qwen-venv'], { env });
    await run('uv', ['pip', 'install', '--python', python, 'mlx-qwen3-asr==0.4.4'], { env });
  }
  const snapshot = `
from pathlib import Path
import sys
from huggingface_hub import snapshot_download
path = Path(snapshot_download(sys.argv[1], revision=sys.argv[2], local_files_only=True))
if sys.argv[1] == "${qwenModel}":
    required = ["config.json", "weights.safetensors", "tokenizer_config.json", "vocab.json", "merges.txt", "quantization_config.json"]
    for name in required:
        file = path / name
        assert file.is_file() and file.stat().st_size > 0
`;
  try {
    await run(python, ['-c', snapshot, model, revision], { env, stdio: 'ignore' });
    console.log('Распознавание — Qwen уже установлен.');
    return;
  } catch {}
  console.log('Распознавание — скачиваем модель Qwen.');
  await run(python, [
    '-c',
    `import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], revision=sys.argv[2])`,
    model,
    revision
  ], { env });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupQwen(process.argv[2]).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
