import { readInput, validateLanguages } from './session-api.mjs';
import { cardGrades, schedule } from './cards.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function validateString(value, maximum, required = false) {
  if (value == null && !required)
    return;
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()))
    throw fail(400, `Нужна строка до ${maximum} символов${required ? ', не пустая' : ''}.`);
}

function present(card, now) {
  if (!card)
    throw fail(404, 'Карточка не найдена.');
  return { ...card, review_labels: schedule(card, 'good', now).labels };
}

export async function cardRoute(req, url, store) {
  try {
    return await route(req, url, store);
  } catch (error) {
    if (error.status)
      throw error;
    if (error.code?.startsWith('ERR_SQLITE') && error.message?.includes('UNIQUE constraint failed'))
      throw fail(400, 'Такое слово уже есть в карточках.');
    throw fail(500, 'Не удалось обратиться к хранилищу карточек.');
  }
}

async function route(req, url, store) {
  const now = new Date();
  if (url.pathname === '/api/cards') {
    if (req.method === 'GET') {
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 50;
      const due = url.searchParams.get('due');
      if (!Number.isSafeInteger(limit) || limit < 1 || (due !== null && !['0', '1'].includes(due)))
        throw fail(400, 'Некорректные параметры списка карточек.');
      return {
        cards: store.listCards({ due: due === '1', limit, now }).map(card => present(card, now)),
        stats: store.cardStats(now)
      };
    }
    if (req.method === 'POST') {
      const input = await readInput(req);
      validateLanguages(input);
      validateString(input.source, 300, true);
      validateString(input.meaning, 300, true);
      validateString(input.example, 3000);
      validateString(input.example_translation, 3000);
      validateString(input.session_id, 300);
      validateString(input.turn_id, 300);
      return present(store.createCard(input), now);
    }
    throw fail(404, 'Не найдено.');
  }
  const match = /^\/api\/cards\/([^/]+)(\/review)?$/.exec(url.pathname);
  if (!match)
    throw fail(404, 'Не найдено.');
  const [, id, review] = match;
  if (!uuid.test(id))
    throw fail(400, 'Некорректный идентификатор карточки.');
  if (review && req.method === 'POST') {
    const input = await readInput(req);
    if (!cardGrades.includes(input.grade))
      throw fail(400, 'Некорректная оценка.');
    return present(store.reviewCard(id, input.grade, now), now);
  }
  if (!review && req.method === 'PATCH') {
    const input = await readInput(req);
    if (input.source === undefined && input.meaning === undefined)
      throw fail(400, 'Укажи слово или значение.');
    if (input.source !== undefined)
      validateString(input.source, 300, true);
    if (input.meaning !== undefined)
      validateString(input.meaning, 300, true);
    return present(store.updateCard(id, input), now);
  }
  if (!review && req.method === 'DELETE') {
    if (!store.deleteCard(id))
      throw fail(404, 'Карточка не найдена.');
    return { ok: true };
  }
  throw fail(404, 'Не найдено.');
}
