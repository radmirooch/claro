export function recognitionMissing(config) {
  if (!config)
    return false;
  return !Object.values(config.engines || {}).some(engine => {
    if (engine.ready || engine.installed === true)
      return true;
    if (engine.installed === false)
      return false;
    return Boolean(engine.message) && !/не установлен|не найден/iu.test(engine.message);
  });
}

export function recognitionMessage(config, selected) {
  const engine = config?.engines?.[selected];
  if (engine?.ready)
    return 'Готово';
  if (recognitionMissing(config))
    return 'Распознавание не установлено — запустите npm run setup';
  if (/загружается|прогревается/iu.test(engine?.message || ''))
    return 'Загружаем распознавание…';
  return engine?.message
    ? `${engine.message} Проверьте настройки и перезапустите Claro.`
    : 'Распознавание недоступно — выберите установленный движок в настройках';
}
