import { state } from './state.js';
import { $, status } from './dom.js';
import { sourceUnits } from './annotations.js';
import { removeDemo, show } from './render-history.js';

const examples = {
  en: 'Shall we meet at the café at eight?',
  es: '¿Nos vemos en la cafetería a las ocho?',
  ru: 'Встретимся в кафе в восемь?',
  fr: 'On se retrouve au café à huit heures ?',
  de: 'Treffen wir uns um acht im Café?',
  it: 'Ci vediamo al bar alle otto?',
  pt: 'Nos encontramos no café às oito?',
  zh: '我们八点在咖啡馆见面好吗？',
  ja: '8時にカフェで会いませんか？',
  ar: 'هل نلتقي في المقهى الساعة الثامنة؟'
};

export function showDemo() {
  if (state.starting || state.running)
    return;
  removeDemo();
  state.demoActive = true;
  $('mode').textContent = 'Пример разговора';
  status('Демо');
  const source = $('language').value,
    target = $('targetLanguage').value;
  const pairs =
    source === 'es' && target === 'ru'
      ? [
          ['Hola, ¿cómo estás?', 'Привет, как дела?'],
          ['¿Nos vemos en la cafetería a las ocho?', 'Встретимся в кафе в восемь?'],
          ['Sí, perfecto. Te espero allí.', 'Да, отлично. Буду ждать тебя там.']
        ]
      : [[examples[source], examples[target]]];
  const prepared = [
    ['Привет,', 'как', 'ты?'],
    ['друг друга', 'увидим', 'в', 'артикль', 'кафе', 'в', 'артикль', 'восемь?'],
    ['Да,', 'отлично.', 'Тебя', 'жду', 'там.']
  ];
  for (const [index, pair] of pairs.entries()) {
    const event = {
      id: 'demo' + index,
      demo: true,
      source_language: source,
      target_language: target,
      text: pair[0],
      translation: pair[1],
      translation_status: 'ready',
      revealed: !['tap', 'peek'].includes($('translationMode').value),
      final: true,
      created_at: new Date().toISOString(),
      speaker_id: index === 1 ? 'self' : 'guest'
    };
    if (source === 'es' && target === 'ru') {
      event.glosses = sourceUnits(pair[0]).map(unit => ({
        ...unit,
        meaning: prepared[index][unit.index]
      }));
      event.gloss_status = 'ready';
    }
    show(event, false);
  }
}
