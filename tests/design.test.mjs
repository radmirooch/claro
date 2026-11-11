import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const appearanceSource = await readFile(new URL('../public/appearance.js', import.meta.url), 'utf8');

function appearance(preferences, dark = false) {
  const root = { dataset: {} };
  const meta = {};
  let systemChanged;
  const media = { matches: dark, addEventListener(type, listener) { systemChanged = listener; } };
  const context = vm.createContext({
    window: { matchMedia: () => media },
    document: { documentElement: root, querySelector: () => meta },
    localStorage: { getItem: () => preferences }
  });
  vm.runInContext(appearanceSource, context);
  return { root, meta, media, change: () => systemChanged(), apply: context.window.claroAppearance.apply };
}

test('appearance is applied synchronously and system changes respect an explicit theme', () => {
  const h = appearance('{"theme":"auto","palette":"sand"}');
  assert.equal(h.root.dataset.theme, 'light');
  assert.equal(h.root.dataset.palette, 'sand');
  assert.equal(h.meta.content, '#fbf8f3');
  h.media.matches = true;
  h.change();
  assert.equal(h.root.dataset.theme, 'dark');
  assert.equal(h.meta.content, '#16130f');
  h.apply('light', 'ocean');
  h.change();
  assert.equal(h.root.dataset.theme, 'light');
  assert.equal(h.meta.content, '#f5f9fd');
});

test('malformed and older preferences use the system theme and graphite palette', () => {
  for (const preferences of ['{', 'null', '{}', '{"theme":"unknown","palette":"__proto__"}']) {
    const h = appearance(preferences, true);
    assert.equal(h.root.dataset.theme, 'dark');
    assert.equal(h.root.dataset.palette, 'graphite');
    assert.equal(h.meta.content, '#111111');
  }
});

test('every palette provides matching light and dark theme-color values', () => {
  const palettes = {
    graphite: ['#fcfcfc', '#111111'],
    sand: ['#fbf8f3', '#16130f'],
    sage: ['#f7faf7', '#0e1511'],
    ocean: ['#f5f9fd', '#0b1320'],
    lilac: ['#faf8fd', '#15111b']
  };
  const h = appearance('{}');
  for (const [palette, backgrounds] of Object.entries(palettes)) {
    for (const [index, theme] of ['light', 'dark'].entries()) {
      h.apply(theme, palette);
      assert.equal(h.root.dataset.palette, palette);
      assert.equal(h.meta.content, backgrounds[index]);
    }
  }
});

test('client uses external prepaint assets and preserves the strict content policy', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /\sstyle\s*=|\son\w+\s*=|<style\b/i);
  assert.ok([...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].every(match => /\bsrc=/.test(match[1]) && !match[2].trim()));
  assert.ok(html.indexOf('src="/appearance.js"') < html.indexOf('href="/style.css"'));
  assert.match(server, /'\/appearance\.js': \['appearance\.js', 'text\/javascript'\]/);
  assert.match(server, /script-src 'self'; style-src 'self'/);
  assert.doesNotMatch(css, /line-clamp|text-overflow:\s*ellipsis|@import|https?:\/\//);
  assert.match(css, /text-wrap: balance/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(html, /<textarea[^>]*><\/textarea>/);
  assert.equal((html.match(/id="demoIndicator"/g) || []).length, 0, 'demo uses the existing status indicator');
});

async function sheetHarness(desktop = false) {
  const listeners = new Map();
  const documentListeners = new Map();
  const dialogs = new Map(['wordDialog', 'settingsDialog'].map(id => [id, {
    open: false,
    modal: false,
    addEventListener(type, handler) { listeners.set(`${id}:${type}`, handler); },
    getBoundingClientRect() { return { top: 300, bottom: 700, left: 0, right: 390 }; },
    setPointerCapture() {},
    show() { this.open = true; this.modal = false; },
    showModal() { this.open = true; this.modal = true; },
    matches() { return this.modal; },
    contains() { return false; },
    close() { this.open = false; listeners.get(`${id}:close`)?.(); }
  }]));
  const document = {
    getElementById: id => dialogs.get(id),
    querySelector: () => null,
    addEventListener(type, handler) { documentListeners.set(type, handler); }
  };
  const context = vm.createContext({
    document,
    window: { matchMedia: query => ({ matches: query.includes('min-width') ? desktop : !desktop }) }
  });
  const module = new vm.SourceTextModule(await readFile(new URL('../public/dom.js', import.meta.url), 'utf8'), { context });
  const languages = new vm.SyntheticModule(['languageByCode'], function () {
    this.setExport('languageByCode', () => null);
  }, { context });
  await module.link(() => languages);
  await module.evaluate();
  module.namespace.initializeSheets();
  return { dialogs, listeners, documentListeners, open: module.namespace.openWordDialog };
}

test('word sheets dismiss by downward swipe, backdrop and Escape', async () => {
  const h = await sheetHarness();
  const word = h.dialogs.get('wordDialog');
  h.open();
  assert.equal(word.modal, true);
  const target = { closest: () => null };
  h.listeners.get('wordDialog:pointerdown')({ clientY: 320, timeStamp: 0, target });
  h.listeners.get('wordDialog:pointerup')({ clientY: 460, timeStamp: 500 });
  assert.equal(word.open, false);
  h.open();
  h.listeners.get('wordDialog:click')({ target: word, clientX: 100, clientY: 250 });
  assert.equal(word.open, false);
  h.open();
  h.documentListeners.get('keydown')({ key: 'Escape' });
  assert.equal(word.open, false);
  h.open();
  h.listeners.get('wordDialog:pointerdown')({ clientY: 320, timeStamp: 0, target });
  h.listeners.get('wordDialog:pointerup')({ clientY: 310, timeStamp: 500 });
  assert.equal(word.open, true, 'an upward gesture preserves the sheet');
});

test('desktop word window remains nonmodal and dismisses on outside input', async () => {
  const h = await sheetHarness(true);
  h.open();
  const word = h.dialogs.get('wordDialog');
  assert.equal(word.open, true);
  assert.equal(word.modal, false);
  h.documentListeners.get('pointerdown')({ target: { closest: () => null } });
  assert.equal(word.open, false);
});

test('existing select identities and persisted option values remain available', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const controls = {
    translationMode: ['always', 'tap', 'peek', 'off'],
    readingMode: ['steady', 'live'],
    interval: ['1', '1.5', '2'],
    threshold: ['0.006', '0.012', '0.025'],
    engine: ['qwen', 'whisper'],
    translationLayout: ['line', 'words'],
    sentencePause: ['0.6', '1.2', '2'],
    showOriginal: ['show', 'hide'],
    textSize: ['normal', 'large', 'extra'],
    showParticipants: ['hide', 'show'],
    saveConversations: ['on', 'off']
  };
  for (const [id, expected] of Object.entries(controls)) {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(select, id);
    assert.deepEqual([...select[1].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]), expected, id);
  }
});

test('palette text and meanings meet the contrast requirement on both bubble fills', async () => {
  const css = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
  function color(value, background = [0, 0, 0]) {
    if (value.startsWith('#'))
      return [1, 3, 5].map(index => parseInt(value.slice(index, index + 2), 16));
    const [red, green, blue, alpha] = value.match(/[\d.]+/g).map(Number);
    return [red, green, blue].map((channel, index) => channel * alpha + background[index] * (1 - alpha));
  }
  function luminance(rgb) {
    return rgb.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  }
  function contrast(first, second) {
    const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }
  const palettes = [...css.matchAll(/:root\[data-theme="(light|dark)"\]\[data-palette="(\w+)"\]\s*\{([^}]+)\}/g)];
  assert.equal(palettes.length, 10);
  for (const [, theme, palette, block] of palettes) {
    const tokens = Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2]]));
    const background = color(tokens['--bg']);
    const ink = color(tokens['--accent-ink']);
    const text = color(theme === 'light' ? '#202020' : '#eeeeee');
    for (const fill of ['--them', '--me']) {
      const bubble = color(tokens[fill], background);
      assert.ok(contrast(ink, bubble) >= 4.5, `${theme} ${palette} ${fill} meaning`);
      assert.ok(contrast(text, bubble) >= 4.5, `${theme} ${palette} ${fill} text`);
    }
  }
});
