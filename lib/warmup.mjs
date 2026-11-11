import { setTimeout as delay } from 'node:timers/promises';

export async function warmModels(providers, {
  signal,
  request = fetch,
  pause = () => delay(500, undefined, { signal }),
  attempts = 60,
  log = message => console.error(message)
} = {}) {
  for (const [index, provider] of providers.entries()) {
    if (!provider)
      continue;
    try {
      let available = false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        signal?.throwIfAborted();
        let response;
        try {
          response = await request(`${provider.url}/api/tags`, {
            signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(1000)])
          });
        } catch {}
        if (response?.ok) {
          const data = await response.json();
          if (!data.models?.some(model => model.name === provider.model || model.name === `${provider.model}:latest`))
            throw new Error('missing model');
          available = true;
          break;
        }
        await pause();
      }
      if (!available)
        throw new Error('unavailable');
      const response = await request(`${provider.url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]),
        body: JSON.stringify({
          model: provider.model,
          messages: [{ role: 'user', content: 'Translate into Russian: Hello.' }],
          stream: false,
          think: false,
          keep_alive: '30m',
          options: {
            num_predict: 1,
            num_ctx: index === 0 ? 2048 : 4096,
            num_gpu: Number(index === 0 ? process.env.OLLAMA_NUM_GPU ?? 0 : process.env.GLOSS_NUM_GPU ?? 0),
            num_thread: index === 0 ? Number(process.env.OLLAMA_NUM_THREAD ?? 2) : 2
          }
        })
      });
      if (!response.ok || (await response.json()).error)
        throw new Error('warmup failed');
    } catch {
      if (signal?.aborted)
        return;
      log(index === 0 ? 'Не удалось прогреть модель перевода.' : 'Не удалось прогреть модель значений слов.');
    }
  }
}
