import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const project = fileURLToPath(new URL('../', import.meta.url));

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: project, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0)
        resolve();
      else
        reject(new Error(`Не удалось выполнить ${command}. Повторите установку после исправления ошибки (код ${code}).`));
    });
  });
}

export function missingEnvSettings(contents, settings) {
  const keys = new Set(Object.keys(parseEnv(contents)));
  const missing = Object.entries(settings).filter(([key]) => !keys.has(key));
  if (!missing.length)
    return '';
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const prefix = contents && !contents.endsWith('\n') ? newline : '';
  return prefix + missing.map(([key, value]) => `${key}=${value}${newline}`).join('');
}

export async function ensureEnvSettings(path, settings) {
  const file = await open(path, 'a+', 0o600);
  try {
    const contents = await file.readFile('utf8');
    const addition = missingEnvSettings(contents, settings);
    if (addition)
      await file.writeFile(addition);
  } finally {
    await file.close();
  }
}
