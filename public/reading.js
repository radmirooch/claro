// Finalized reading turns keep sentence context for translation.
// Source offsets preserve provenance without inventing per-word audio times.
export function splitFinalCaption(event) {
  if (event.final === false)
    return [event];
  // Bound unusually long input for the translation model. Ordinary sentences
  // can wrap inside a bubble without being sent as separate translations.
  const maxChars = 300;
  const words = [...event.text.matchAll(/\S+/gu)],
    ranges = [];
  for (let start = 0; start < words.length;) {
    let end = start;
    while (end < words.length) {
      if (end > start && words[end].index + words[end][0].length - words[start].index > maxChars)
        break;
      const word = words[end++][0];
      if (end - start >= 3 && /[.!?。！？][»”"')\]]*$/u.test(word))
        break;
    }
    ranges.push([words[start].index, words[end - 1].index + words[end - 1][0].length]);
    start = end;
  }
  if (ranges.length < 2)
    return [event];
  return ranges.map(([start, end], index) => ({
    ...event,
    id: index ? `${event.id}_turn${index}` : event.id,
    text: event.text.slice(start, end),
    source_record: { id: event.id, text: event.text, revision: event.revision, start, end },
    translation: null,
    translation_status: null,
    translation_revision: null,
    translated_text: null,
    glosses: [],
    gloss_text: null,
    gloss_status: null,
    revealed: false
  }));
}

export function draftTail(text, maxWords = 9) {
  const words = text.trim().split(/\s+/u);
  return (words.length > maxWords ? '… ' : '') + words.slice(-maxWords).join(' ');
}
