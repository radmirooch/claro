import { fileURLToPath } from 'node:url';
import { setupQwen } from './setup-qwen.mjs';
import { setupTranslation } from './setup-translation.mjs';

export async function setup({ lite = false } = {}) {
  await setupQwen();
  await setupTranslation('translategemma:4b', { gloss: !lite });
  console.log('Claro установлен. Запустите двойным кликом по start.command.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(argument => argument !== '--lite')) {
    console.error('Доступный флаг установки — --lite (без модели значений слов).');
    process.exitCode = 1;
  } else {
    setup({ lite: args.includes('--lite') }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
