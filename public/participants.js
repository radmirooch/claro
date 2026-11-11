// Profiles describe user choices; voice evidence is a separate, optional input.
export const SPEAKER_COLORS = ['blue', 'green', 'orange', 'pink', 'teal'];
export function defaultParticipants() {
  return [
    { id: 'self', name: 'Я', color: 'blue', is_self: true },
    { id: 'guest', name: 'Собеседник', color: 'green', is_self: false }
  ];
}
export function readParticipants(value) {
  if (!Array.isArray(value))
    return defaultParticipants();
  const seen = new Set();
  const profiles = value
    .filter(p => p && /^[a-zA-Z0-9_-]{1,80}$/.test(p.id) && !seen.has(p.id) && seen.add(p.id))
    .slice(0, 30)
    .map(p => ({
      id: p.id,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : 'Участник',
      color: SPEAKER_COLORS.includes(p.color) ? p.color : 'blue',
      is_self: p.id === 'self'
    }));
  if (!profiles.some(p => p.id === 'self'))
    profiles.unshift(defaultParticipants()[0]);
  return profiles;
}
export function assignSpeaker(event, speakerId, profiles, origin = 'manual', confidence = null) {
  if (speakerId !== null && !profiles.some(p => p.id === speakerId))
    throw new Error('Неизвестный участник.');
  if (!['manual', 'voice', 'channel'].includes(origin))
    throw new Error('Неизвестный источник участника.');
  // A recognizer must not overwrite a human correction or explicit channel.
  if (origin === 'voice' && ['manual', 'channel'].includes(event.speaker_assignment?.origin))
    return false;
  event.speaker_id = speakerId;
  event.speaker_assignment = {
    origin,
    confidence:
      typeof confidence === 'number' && confidence >= 0 && confidence <= 1 ? confidence : null,
    confirmed: origin !== 'voice'
  };
  return true;
}
