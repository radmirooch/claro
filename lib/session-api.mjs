import { languageByCode } from '../public/languages.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const turnId = /^[a-zA-Z0-9_-]{1,100}$/;

async function readInput(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65536) {
      req.resume();
      throw fail(400, 'Тело запроса превышает 64 КБ.');
    }
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw fail(400, 'Нужен JSON.');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw fail(400, 'Нужен объект JSON.');
  return input;
}

function validateLanguages(input) {
  if (!languageByCode(input.source_language) || !languageByCode(input.target_language))
    throw fail(400, 'Укажи source_language и target_language из списка языков.');
}

function validateTurn(input) {
  validateLanguages(input);
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 3000)
    throw fail(400, 'Нужен непустой текст до 3000 символов.');
  if (input.translation != null && (typeof input.translation !== 'string' || input.translation.length > 4000))
    throw fail(400, 'Перевод должен быть строкой до 4000 символов.');
  if (typeof input.created_at !== 'string' || !Number.isFinite(Date.parse(input.created_at)))
    throw fail(400, 'Нужна дата создания реплики.');
  if (input.speaker_id != null && typeof input.speaker_id !== 'string')
    throw fail(400, 'Некорректный участник реплики.');
  if (input.glosses != null) {
    if (!Array.isArray(input.glosses) || input.glosses.length > 300)
      throw fail(400, 'Допустимо до 300 значений слов.');
    for (const gloss of input.glosses) {
      if (!gloss || typeof gloss !== 'object' ||
          !Number.isSafeInteger(gloss.index) || gloss.index < 0 ||
          !Number.isSafeInteger(gloss.start) || gloss.start < 0 ||
          !Number.isSafeInteger(gloss.end) || gloss.end < gloss.start ||
          typeof gloss.source !== 'string' || gloss.source.length > 300 ||
          typeof gloss.meaning !== 'string' || gloss.meaning.length > 300)
        throw fail(400, 'Некорректное значение слова.');
    }
  }
}

export async function sessionRoute(req, url, store) {
  try {
    return await route(req, url, store);
  } catch (error) {
    if (error.status)
      throw error;
    throw fail(500, 'Не удалось обратиться к хранилищу разговоров.');
  }
}

async function route(req, url, store) {
  const path = url.pathname;
  if (path === '/api/sessions') {
    if (req.method === 'GET') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw fail(400, 'Некорректное число разговоров.');
      return { sessions: store.listSessions({ limit }) };
    }
    if (req.method === 'POST') {
      const input = await readInput(req);
      validateLanguages(input);
      if (input.kind !== undefined && !['conversation', 'watch'].includes(input.kind))
        throw fail(400, 'Неизвестный вид разговора.');
      return store.createSession(input);
    }
    throw fail(404, 'Не найдено.');
  }
  if (path === '/api/sessions/active' && req.method === 'GET')
    return store.latestActive(120) ?? { session: null };
  const match = /^\/api\/sessions\/([^/]+)(?:\/turns\/([^/]+))?$/.exec(path);
  if (!match)
    throw fail(404, 'Не найдено.');
  const [, id, captionId] = match;
  if (!uuid.test(id) || (captionId !== undefined && !turnId.test(captionId)))
    throw fail(400, 'Некорректный идентификатор.');
  if (captionId !== undefined) {
    if (req.method !== 'PUT')
      throw fail(404, 'Не найдено.');
    const input = await readInput(req);
    validateTurn(input);
    if (!store.hasSession(id))
      throw fail(404, 'Разговор не найден.');
    const seq = store.upsertTurn(id, { ...input, id: captionId });
    return { ok: true, seq };
  }
  if (!store.hasSession(id))
    throw fail(404, 'Разговор не найден.');
  if (req.method === 'GET')
    return store.getSession(id);
  if (req.method === 'PATCH') {
    const input = await readInput(req);
    if ((input.title !== undefined && input.title !== null && typeof input.title !== 'string') ||
        (input.ended !== undefined && input.ended !== true))
      throw fail(400, 'Некорректные свойства разговора.');
    return store.updateSession(id, input);
  }
  if (req.method === 'DELETE') {
    store.deleteSession(id);
    return { ok: true };
  }
  throw fail(404, 'Не найдено.');
}
