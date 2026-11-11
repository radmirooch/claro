(() => {
  const themes = ['auto', 'light', 'dark'];
  const backgrounds = {
    graphite: ['#fcfcfc', '#111111'],
    sand: ['#fbf8f3', '#16130f'],
    sage: ['#f7faf7', '#0e1511'],
    ocean: ['#f5f9fd', '#0b1320'],
    lilac: ['#faf8fd', '#15111b']
  };
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  let theme = 'auto';
  let palette = 'graphite';

  function apply(nextTheme, nextPalette) {
    theme = themes.includes(nextTheme) ? nextTheme : 'auto';
    palette = Object.hasOwn(backgrounds, nextPalette) ? nextPalette : 'graphite';
    const dark = theme === 'dark' || (theme === 'auto' && systemTheme.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.palette = palette;
    document.querySelector('meta[name="theme-color"]').content = backgrounds[palette][Number(dark)];
  }

  try {
    const preferences = JSON.parse(localStorage.getItem('claro.preferences.v1') || '{}');
    theme = preferences.theme;
    palette = preferences.palette;
  } catch {}
  apply(theme, palette);
  systemTheme.addEventListener('change', () => apply(theme, palette));
  window.claroAppearance = { apply };
})();
