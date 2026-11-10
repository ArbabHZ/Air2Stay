import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { initTheme, bindChartInteractions, chartLabel, THEME_STORAGE_KEY } from '../prototype/theme.mjs';

function fixture({ saved = null, denied = false } = {}) {
  const events = new Map(), windowEvents = new Map();
  const writes = [];
  const doc = { activeElement: null, marks: [], querySelectorAll(selector) { return selector === '[data-theme-toggle]' ? [button] : this.marks; },
    addEventListener(type, fn) { events.set(type, fn); }, removeEventListener(type) { events.delete(type); },
    createElement() { return new Element(); }, dispatch(type, event) { events.get(type)?.(event); } };
  class Element {
    constructor() {
      this.attrs = new Map(); this.classes = new Set(); this.children = []; this.textContent = ''; this.style = {};
      this.hidden = false; this.isConnected = true; this.lang = 'en'; this.offsetWidth = 220; this.offsetHeight = 40;
      this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)), [Symbol.iterator]: () => this.classes.values() };
    }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    removeAttribute(name) { this.attrs.delete(name); }
    querySelector(selector) { return selector === 'title' && this.titleText ? { textContent: this.titleText } : this.parts?.[selector] ?? null; }
    querySelectorAll() { return []; }
    closest(selector) {
      if (selector.includes('#planPrintSheet')) return this.excluded ? this : null;
      if (selector === '[data-theme-toggle]') return this === button ? this : null;
      if (selector === '.chart-interactive') return this.classes.has('chart-interactive') ? this : null;
      if (selector === '[role="img"]') return this.getAttribute('role') === 'img' ? this : this.parentElement?.closest(selector);
      if (selector === '[data-interactive-chart]') return this.group?.getAttribute('data-interactive-chart') !== null ? this.group : null;
      return this.group || null;
    }
    matches() { return false; }
    append(child) { this.children.push(child); child.parentElement = this; }
    contains(child) { return this.children.includes(child); }
    remove() { this.isConnected = false; }
    getBoundingClientRect() { return { left: 300, top: 120, width: 20, height: 30 }; }
    focus() { doc.activeElement = this; doc.dispatch('focusin', { target: this }); }
  }
  const button = new Element();
  button.parts = { '[data-theme-icon]': new Element(), '[data-theme-label]': new Element() };
  doc.documentElement = new Element(); doc.body = new Element();
  const storage = { getItem() { if (denied) throw new Error('denied'); return saved; }, setItem(key, value) { if (denied) throw new Error('denied'); writes.push([key, value]); } };
  const win = { innerWidth: 900, innerHeight: 700, addEventListener(type, fn) { windowEvents.set(type, fn); }, removeEventListener(type) { windowEvents.delete(type); } };
  return { doc, win, button, writes, storage, events, windowEvents, Element };
}

test('saved theme restores; switching persists only the appearance choice and updates accessible action', () => {
  const f = fixture({ saved: 'light' });
  const ui = initTheme({ document: f.doc, window: f.win, storage: f.storage });
  assert.equal(f.doc.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(f.button.getAttribute('aria-label'), 'Dark mode');
  assert.equal(f.writes.length, 0);
  f.doc.dispatch('click', { target: f.button });
  assert.equal(ui.getTheme(), 'dark');
  assert.deepEqual(f.writes, [[THEME_STORAGE_KEY, 'dark']]);
  assert.equal(ui.setTheme('unexpected-value'), false);
  assert.equal(ui.getTheme(), 'dark');
  f.doc.documentElement.lang = 'ar'; ui.refresh();
  assert.equal(f.button.getAttribute('aria-label'), 'الوضع الفاتح');
  f.windowEvents.get('storage')({ key: THEME_STORAGE_KEY, newValue: 'light' });
  assert.equal(ui.getTheme(), 'light');
  assert.equal(f.writes.length, 1, 'Cross-tab synchronization must not write back');
  ui.destroy();
  assert.equal(f.events.has('click'), false);
});

test('denied or malformed storage does not prevent either appearance', () => {
  for (const options of [{ denied: true }, { saved: '{broken json' }]) {
    const f = fixture(options);
    const ui = initTheme({ document: f.doc, window: f.win, storage: f.storage });
    assert.equal(ui.getTheme(), 'dark');
    assert.doesNotThrow(() => ui.toggle());
    assert.equal(f.doc.documentElement.getAttribute('data-theme'), 'light');
    ui.destroy();
  }
});

test('chart values work by pointer and keyboard, update from current titles, and exclude printed reports', () => {
  const f = fixture();
  const wrapper = new f.Element(); wrapper.setAttribute('role', 'img');
  const group = new f.Element(); group.setAttribute('role', 'img'); group.setAttribute('aria-hidden', 'true'); wrapper.append(group);
  const first = new f.Element(), second = new f.Element(), printed = new f.Element();
  first.group = group; first.titleText = 'January: 100 guest nights';
  second.group = group; second.titleText = 'February: 200 guest nights';
  printed.group = group; printed.titleText = 'Printed chart'; printed.excluded = true;
  f.doc.marks = [first, second, printed];
  const ui = bindChartInteractions({ document: f.doc, window: f.win });
  const tip = f.doc.body.children[0];
  assert.equal(first.getAttribute('tabindex'), '0');
  assert.equal(second.getAttribute('tabindex'), '-1');
  assert.equal(printed.getAttribute('tabindex'), null);
  assert.equal(group.getAttribute('role'), 'group', 'Accessible children must not be hidden by an image role');
  assert.equal(group.getAttribute('aria-hidden'), null);
  assert.equal(wrapper.getAttribute('role'), 'group', 'Outer image wrapper must expose individual keyboard values');
  f.doc.dispatch('pointerover', { target: first, clientX: 880, clientY: 690 });
  assert.equal(tip.hidden, false);
  assert.equal(tip.textContent, 'January: 100 guest nights');
  assert.ok(parseFloat(tip.style.left) <= 672, 'Tooltip stays inside viewport');
  let prevented = false;
  f.doc.dispatch('keydown', { target: first, key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.doc.activeElement, second);
  assert.equal(tip.textContent, 'February: 200 guest nights');
  f.windowEvents.get('scroll')();
  assert.equal(tip.hidden, false, 'Browser focus scrolling must not hide a keyboard tooltip');
  second.titleText = 'February: 250 guest nights'; ui.refresh();
  assert.equal(tip.textContent, 'February: 250 guest nights');
  assert.equal(second.getAttribute('aria-label'), 'February: 250 guest nights');
  f.doc.dispatch('keydown', { target: second, key: 'Escape' });
  assert.equal(tip.hidden, true);
  assert.equal(second.getAttribute('aria-describedby'), null);
  f.doc.dispatch('pointermove', { target: first, clientX: 320, clientY: 120 });
  assert.equal(tip.hidden, false, 'Pointer movement restores a dismissed value tooltip');
  assert.equal(tip.textContent, 'January: 100 guest nights');
  ui.destroy();
  assert.equal(first.getAttribute('tabindex'), null);
  assert.equal(group.getAttribute('role'), 'img');
  assert.equal(group.getAttribute('aria-hidden'), 'true');
  assert.equal(wrapper.getAttribute('role'), 'img');
  assert.equal(f.events.has('pointerover'), false);
});

test('tooltip text preserves the chart-provided value without HTML or numeric reinterpretation', () => {
  const f = fixture(); const mark = new f.Element();
  mark.titleText = '  June: −1,234.56\n guest nights  ';
  assert.equal(chartLabel(mark), 'June: −1,234.56 guest nights');
});

const luminance = hex => {
  const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
};
const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + .05) / (values[1] + .05); };
test('actual CSS palettes meet WCAG AA text and chart contrast on all three main surfaces', async () => {
  const css = await readFile(new URL('../prototype/styles.css', import.meta.url), 'utf8');
  const blocks = {
    dark: css.match(/\/\* Desert Night: shared visual theme[^]*?:root\s*\{([^]*?)\}/)[1],
    light: css.match(/:root\[data-theme="light"\]\s*\{([^]*?)\}/)[1],
  };
  for (const [mode, block] of Object.entries(blocks)) {
    const colors = Object.fromEntries([...block.matchAll(/--theme-([a-z-]+):\s*(#[a-f\d]{6})/gi)].map(match => [match[1], match[2]]));
    for (const background of ['navy', 'card', 'raised']) {
      for (const foreground of ['text', 'muted', 'gold-light', 'rose-light']) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(ratio >= 4.5, `${mode} ${foreground}/${background}: ${ratio.toFixed(2)} < 4.5`);
      }
      for (const foreground of ['gold', 'rose', 'rose-light', 'complete', 'pending', 'overdue']) {
        const ratio = contrast(colors[foreground], colors[background]);
        assert.ok(ratio >= 3, `${mode} chart ${foreground}/${background}: ${ratio.toFixed(2)} < 3`);
      }
    }
  }
  for (const accent of ['#72520B', '#806011', '#A62C52']) assert.ok(contrast('#FFFFFF', accent) >= 4.5);
});
