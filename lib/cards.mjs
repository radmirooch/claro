const dayMilliseconds = 86400000;
export const cardGrades = ['again', 'hard', 'good', 'easy'];

function nextReview(card, grade, now) {
  let interval = card.interval_days;
  let ease = card.ease;
  let reps = card.reps;
  let lapses = card.lapses;
  if (grade === 'again') {
    interval = 0;
    ease -= 0.2;
    reps = 0;
    lapses++;
  } else {
    if (grade === 'hard') {
      interval = Math.max(1, interval * 1.2);
      ease -= 0.15;
    } else {
      interval = reps === 0 ? 1 : reps === 1 ? 3 : interval * ease;
      if (grade === 'easy') {
        interval *= 1.3;
        ease += 0.15;
      }
    }
    reps++;
  }
  return {
    interval_days: interval,
    due_at: new Date(now + (grade === 'again' ? 600000 : interval * dayMilliseconds)).toISOString(),
    ease: Math.max(1.3, Math.min(3, ease)),
    reps,
    lapses
  };
}

export function schedule(card, grade, now = new Date()) {
  const time = new Date(now).getTime();
  if (!cardGrades.includes(grade) || !Number.isFinite(time))
    throw new RangeError('Некорректная оценка или дата повторения.');
  const labels = Object.fromEntries(cardGrades.map(value => {
    const next = nextReview(card, value, time);
    return [value, value === 'again' ? '10 мин' : `${Math.max(1, Math.round(next.interval_days))} д`];
  }));
  return { ...nextReview(card, grade, time), labels };
}
