// Shared by browser, server and future clients. Codes are Whisper/ISO language codes.
export const LANGUAGES = Object.freeze([
  { code: 'en', label: 'Английский', name: 'English', dir: 'ltr' },
  { code: 'es', label: 'Испанский', name: 'Spanish', dir: 'ltr' },
  { code: 'ru', label: 'Русский', name: 'Russian', dir: 'ltr' },
  { code: 'fr', label: 'Французский', name: 'French', dir: 'ltr' },
  { code: 'de', label: 'Немецкий', name: 'German', dir: 'ltr' },
  { code: 'it', label: 'Итальянский', name: 'Italian', dir: 'ltr' },
  { code: 'pt', label: 'Португальский', name: 'Portuguese', dir: 'ltr' },
  { code: 'zh', label: 'Китайский', name: 'Simplified Chinese', dir: 'ltr' },
  { code: 'ja', label: 'Японский', name: 'Japanese', dir: 'ltr' },
  { code: 'ar', label: 'Арабский', name: 'Arabic', dir: 'rtl' }
]);
export const languageByCode = code => LANGUAGES.find(language => language.code === code);
