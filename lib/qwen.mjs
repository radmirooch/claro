import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { languageByCode } from '../public/languages.js';

export class QwenAdapter {
  constructor({ python, model, env = {} }) {
    this.state = { ready: false, message: 'Qwen3-ASR загружается и прогревается…' };
    this.pending = new Map();
    this.child = spawn(
      python,
      [fileURLToPath(new URL('../scripts/qwen-worker.py', import.meta.url))],
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          ...env,
          QWEN_MODEL: model,
          HF_HUB_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1'
        }
      }
    );
    const failed = message => {
      this.state = { ready: false, message };
      for (const job of this.pending.values()) {
        clearTimeout(job.timer);
        job.reject(new Error(message));
      }
      this.pending.clear();
    };
    this.child.on('error', () => failed('Qwen не установлен. Запусти npm run setup:qwen:mac.'));
    this.child.on('exit', () => failed('Qwen остановлен. Проверь журнал локального сервера.'));
    this.child.stdin.on('error', () => failed('Нет связи с Qwen.'));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let data;
      try {
        data = JSON.parse(line);
      } catch {
        return;
      }
      if ('ready' in data) {
        this.state = {
          ready: data.ready,
          message: data.ready ? 'Qwen3-ASR готов' : 'Не удалось загрузить Qwen: ' + data.error
        };
        return;
      }
      const job = this.pending.get(data.id);
      if (!job)
        return;
      clearTimeout(job.timer);
      this.pending.delete(data.id);
      if (data.error)
        job.reject(new Error(data.error));
      else
        job.resolve(data.text);
    });
  }
  transcribe(wav, language, live) {
    if (!this.state.ready)
      return Promise.reject(new Error(this.state.message));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.child.kill('SIGTERM');
        reject(new Error('Qwen превысил время обработки.'));
        this.pending.delete(id);
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({
          id,
          wav: wav.toString('base64'),
          language: language === 'zh' ? 'Chinese' : languageByCode(language).name,
          live
        }) + '\n'
      );
    });
  }
  close() {
    this.child.kill('SIGTERM');
  }
}
