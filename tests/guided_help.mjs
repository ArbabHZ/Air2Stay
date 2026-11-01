// These tests exercise the help module's real storage/consent paths with a tiny
// DOM adapter. They do not replace browser checks of layout or walkthroughs.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../prototype/guided_help.mjs', import.meta.url), 'utf8'))
  .replace('export function createGuidedHelp', 'function createGuidedHelp')
  + '\nthis.createHelpForTest = createGuidedHelp;';

function fixture({ seed = null, readFails = false, writeFails = false, assets = [] } = {}) {
  const elements = [];
  const local = { value: seed == null ? null : typeof seed === 'string' ? seed : JSON.stringify(seed), writes: 0, readFails, writeFails };
  let document;
  class FakeElement {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.className = ''; this.children = []; this.nodes = new Map(); this.events = new Map(); this.attributes = new Map();
      this.value = ''; this.checked = false; this.hidden = false; this.open = false; this.disabled = false; this.dataset = {}; this.isConnected = true;
      this.classList = { add() {}, remove() {}, contains() { return false; } };
      elements.push(this);
    }
    set innerHTML(value) { this.html = value; this.nodes.clear(); }
    get innerHTML() { return this.html || ''; }
    append(...items) { for (const child of items) { this.children.push(child); child.parentElement = this; } }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    querySelector(selector) {
      if (selector === ':scope > .gh-inline-feedback') return this.children.find(child => child.className === 'gh-inline-feedback') || null;
      const key = selector === '[data-gh-message]' ? 'textarea' : selector;
      if (!this.nodes.has(key)) this.nodes.set(key, new FakeElement(key === 'textarea' ? 'textarea' : key === 'form' ? 'form' : 'div'));
      return this.nodes.get(key);
    }
    querySelectorAll(selector) {
      if (selector === '[data-gh-rating]') {
        if (!this.ratings) this.ratings = ['helpful', 'not-helpful'].map(rating => { const button = new FakeElement('button'); button.dataset.ghRating = rating; return button; });
        return this.ratings;
      }
      return [];
    }
    addEventListener(name, callback) { const list = this.events.get(name) || []; list.push(callback); this.events.set(name, list); }
    dispatch(name) { for (const callback of this.events.get(name) || []) callback({ target: this, key: name === 'escape' ? 'Escape' : undefined, preventDefault() {} }); }
    click() { this.dispatch('click'); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { document.activeElement = this; }
    remove() { this.isConnected = false; }
    setCustomValidity(message) { this.validityMessage = message; }
    reportValidity() { return !this.validityMessage; }
    closest() { return null; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    scrollIntoView() {}
  }
  document = { body: new FakeElement('body'), activeElement: null, createElement: tag => new FakeElement(tag), querySelector: () => null, addEventListener() {}, removeEventListener() {} };
  const location = { href: 'http://localhost:8765/', protocol: 'http:', origin: 'http://localhost:8765' };
  const window = { location, parent: { location }, __AIR2STAY_HELP_ASSETS__: assets };
  const localStorage = {
    getItem() { if (local.readFails) throw new Error('Storage blocked'); return local.value; },
    setItem(key, value) { if (local.writeFails) throw new Error('Storage quota'); local.writes++; local.value = value; },
  };
  const sandbox = vm.createContext({ document, window, localStorage, Element: FakeElement, URL, requestAnimationFrame: callback => callback() });
  vm.runInContext(source, sandbox);
  const mount = new FakeElement();
  const api = sandbox.createHelpForTest({ mount, getContext: () => ({ inputs: { originKey: 'FRANCE', month: 12 }, result: { route: { origin: 'France' } } }) });
  const hub = elements.find(element => element.className === 'gh-hub');
  const dialog = elements.find(element => element.className === 'gh-feedback-dialog');
  return { api, hub, dialog, local, document, window, elements, FakeElement, state: () => JSON.parse(local.value), consent(value) { const box = hub.querySelector('[data-gh-optin]'); box.checked = value; box.dispatch('change'); } };
}

test('usage is off by default and ignores tracking before consent', () => {
  const f = fixture();
  f.api.track('assistant_question');
  f.api.track('scenario_change');
  assert.equal(f.local.writes, 0);
  assert.equal(f.hub.querySelector('[data-gh-optin]').checked, false);
});

test('counts only known feature names, never questions or arbitrary keys', () => {
  const f = fixture(); f.consent(true);
  f.api.track('assistant_question'); f.api.track('assistant_question');
  f.api.track('My passenger details are private'); f.api.track('__proto__'); f.api.track('toString');
  assert.deepEqual(f.state().counts, { assistant_question: 2 });
  assert.equal(f.local.value.includes('passenger details'), false);
  assert.equal(f.local.value.includes('FRANCE'), false);
  f.consent(false); f.api.track('assistant_question');
  assert.equal(f.state().counts.assistant_question, 2);
});

test('count opt-in and counts persist, and clearing preserves consent', () => {
  const first = fixture(); first.consent(true); first.api.track('view_chat');
  const next = fixture({ seed: first.local.value });
  assert.equal(next.hub.querySelector('[data-gh-optin]').checked, true);
  next.api.track('export_csv');
  assert.deepEqual(next.state().counts, { view_chat: 1, export_csv: 1 });
  next.hub.querySelector('[data-gh-clear-counts]').click();
  assert.deepEqual(next.state().counts, {});
  assert.equal(next.state().optedIn, true);
});

test('corrupt storage and denied reads fail safely without enabling tracking', () => {
  for (const options of [{ seed: '{invalid' }, { readFails: true }]) {
    const f = fixture(options); f.api.track('assistant_question');
    assert.equal(f.local.writes, 0);
    assert.equal(f.hub.querySelector('[data-gh-storage]').hidden, false);
    assert.equal(f.hub.querySelector('[data-gh-optin]').checked, false);
  }
});

test('invalid persisted counters and inherited object keys are rejected', () => {
  const f = fixture({ seed: { version: 1, optedIn: true, feedback: [], counts: { view_chat: 4, export_csv: -1, export_json: 1.5, toString: 5, 'sensitive arbitrary text': 8 } } });
  f.api.track('view_chat');
  assert.deepEqual(f.state().counts, { view_chat: 5 });
});

test('feedback works without analytics consent and escapes report content', () => {
  const f = fixture();
  f.api.addFeedback('An answer <script>');
  assert.equal(f.dialog.open, true);
  f.dialog.querySelector('textarea').value = '<img src=x onerror=alert(1)> Wrong calculation';
  f.dialog.querySelector('form').dispatch('submit');
  assert.equal(f.state().feedback.length, 1);
  assert.equal(f.state().feedback[0].rating, 'problem');
  assert.deepEqual(f.state().counts, {});
  assert.match(f.hub.querySelector('[data-gh-feedback-list]').innerHTML, /&lt;img/);
  assert.doesNotMatch(f.hub.querySelector('[data-gh-feedback-list]').innerHTML, /<img/);
  assert.match(f.dialog.querySelector('[data-gh-feedback-status]').textContent, /not been sent/);
});

test('empty reports are rejected and reports are capped at the stated local limit', () => {
  const feedback = Array.from({ length: 100 }, (_, n) => ({ id: `test${n}`, subject: 'Test', rating: 'helpful', message: '', createdAt: '2026-11-01T00:00:00Z' }));
  const f = fixture({ seed: { version: 1, optedIn: false, counts: {}, feedback } });
  f.api.addFeedback('Test'); f.dialog.querySelector('textarea').value = '   '; f.dialog.querySelector('form').dispatch('submit');
  assert.equal(f.local.writes, 0);
  assert.match(f.dialog.querySelector('textarea').validityMessage, /Describe/);
  f.dialog.querySelector('textarea').value = 'This needs checking'; f.dialog.querySelector('form').dispatch('submit');
  assert.equal(f.state().feedback.length, 100);
  assert.equal(f.state().feedback[0].id, 'test1');
});

test('inline feedback is not duplicated and records one selected rating', () => {
  const f = fixture(); const answer = new f.FakeElement();
  const row = f.api.addFeedback({ element: answer, id: 'answer-1', label: 'Assistant answer' });
  assert.equal(f.api.addFeedback({ element: answer, id: 'answer-1' }), row);
  assert.equal(answer.children.length, 1);
  row.querySelectorAll('[data-gh-rating]')[0].click();
  assert.equal(f.state().feedback[0].rating, 'helpful');
  assert.equal(row.querySelectorAll('[data-gh-rating]')[0].disabled, true);
  assert.equal(row.querySelectorAll('[data-gh-rating]')[1].disabled, true);
  assert.match(row.querySelector('[data-gh-vote-status]').textContent, /this browser only/);
  const redrawn = f.api.addFeedback({ element: new f.FakeElement(), id: 'answer-1', label: 'Assistant answer' });
  assert.equal(redrawn.querySelectorAll('[data-gh-rating]')[0].disabled, true);
  assert.equal(redrawn.querySelectorAll('[data-gh-rating]')[0].getAttribute('aria-pressed'), 'true');
  redrawn.querySelectorAll('[data-gh-rating]')[0].click();
  assert.equal(f.state().feedback.length, 1);
  const reloaded = fixture({ seed: f.local.value });
  const restored = reloaded.api.addFeedback({ element: new reloaded.FakeElement(), id: 'answer-1', label: 'Assistant answer' });
  assert.equal(restored.querySelectorAll('[data-gh-rating]')[0].disabled, true);
  assert.equal(restored.querySelectorAll('[data-gh-rating]')[0].getAttribute('aria-pressed'), 'true');
});

test('failed feedback persistence visibly warns rather than claiming it was saved', () => {
  const f = fixture({ writeFails: true });
  f.api.addFeedback('Answer'); f.dialog.querySelector('textarea').value = 'A problem'; f.dialog.querySelector('form').dispatch('submit');
  assert.equal(f.local.writes, 0);
  assert.equal(f.hub.querySelector('[data-gh-storage]').hidden, false);
  assert.match(f.dialog.querySelector('[data-gh-feedback-status]').textContent, /storage failed/);
  f.consent(true); f.api.track('view_chat');
  assert.match(f.hub.querySelector('[data-gh-insights]').innerHTML, /Chat opened/);
});

test('reference assets reject unsafe/external links and download reviewed files with correct names', () => {
  const f = fixture({ assets: [
    { name: 'Data dictionary', filename: 'data-dictionary.html', url: 'data:text/html;base64,PGgxPkRpY3Rpb25hcnk8L2gxPg==' },
    { name: 'Audit', filename: 'Air2Stay_Calculation_Audit_v2.0.xlsx', url: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEs=' },
    { name: 'Unsafe', url: 'javascript:alert(1)' },
    { name: 'External', url: 'https://example.com/doc' },
  ] });
  const html = f.hub.querySelector('[data-gh-assets]').innerHTML;
  assert.match(html, /download="data-dictionary.html"/);
  assert.match(html, /download="Air2Stay_Calculation_Audit_v2.0.xlsx"/);
  assert.doesNotMatch(html, /Unsafe|External|javascript:/);
  f.window.location = { protocol: 'about:', href: 'about:srcdoc' };
  f.window.__AIR2STAY_HELP_ASSETS__ = [{ name: 'Local dictionary', url: '/help/dictionary.html' }];
  f.api.update({});
  assert.match(f.hub.querySelector('[data-gh-assets]').innerHTML, /http:\/\/localhost:8765\/help\/dictionary.html/);
});

test('destroy prevents later telemetry writes', () => {
  const f = fixture(); f.consent(true); const writes = f.local.writes;
  f.api.destroy(); f.api.track('view_chat');
  assert.equal(f.local.writes, writes);
});
