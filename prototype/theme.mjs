// Local appearance preferences and progressive chart interaction. No network dependencies.
export const THEME_STORAGE_KEY = 'air2stay-theme';
const validTheme = value => value === 'light' || value === 'dark';

export function initTheme(options = {}) {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis.window;
  const root = doc.documentElement;
  let storage;
  try { storage = options.storage ?? win?.localStorage; } catch { /* Browser storage may be unavailable. */ }
  let theme = 'dark';
  try { const saved = storage?.getItem(THEME_STORAGE_KEY); if (validTheme(saved)) theme = saved; } catch { /* Keep the default. */ }
  const refresh = () => {
    const arabic = root.lang?.toLowerCase().startsWith('ar');
    root.setAttribute('data-theme', theme);
    for (const button of doc.querySelectorAll('[data-theme-toggle]')) {
      const label = theme === 'dark'
        ? (arabic ? 'الوضع الفاتح' : 'Light mode')
        : (arabic ? 'الوضع الداكن' : 'Dark mode');
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(theme === 'light'));
      // The app's translator must not replace the current theme action.
      button.setAttribute('data-i18n-ignore', '');
      const text = button.querySelector('[data-theme-label]');
      const icon = button.querySelector('[data-theme-icon]');
      if (text && text.textContent !== label) text.textContent = label;
      if (icon) icon.textContent = theme === 'dark' ? '☀' : '☾';
    }
  };
  const setTheme = (next, persist = true) => {
    if (!validTheme(next)) return false;
    theme = next;
    refresh();
    if (persist) try { storage?.setItem(THEME_STORAGE_KEY, theme); } catch { /* Changing appearance still works. */ }
    return true;
  };
  const toggle = () => setTheme(theme === 'dark' ? 'light' : 'dark');
  const click = event => { if (event.target.closest?.('[data-theme-toggle]')) toggle(); };
  const sync = event => { if (event.key === THEME_STORAGE_KEY) setTheme(validTheme(event.newValue) ? event.newValue : 'dark', false); };
  const observer = win?.MutationObserver ? new win.MutationObserver(refresh) : null;
  doc.addEventListener('click', click);
  win?.addEventListener('storage', sync);
  observer?.observe(root, { attributes: true, attributeFilter: ['lang'] });
  refresh();
  return { refresh, setTheme, toggle, getTheme: () => theme, destroy() {
    observer?.disconnect(); doc.removeEventListener('click', click); win?.removeEventListener('storage', sync);
  } };
}

const markSelector = [
  '.result-spark svg rect', '.validation-chart circle', '.validation-chart .validation-error-band',
  '.pack-line-chart circle', '.season-column', '.month-comparison-column', '.monthly-metric-card',
  '.comparison-step-plot', '.stress-comparison-bars > li', '.bar-row', '.sensitivity-row',
  '.pack-bar-chart > li', '[data-chart-label]',
].join(',');
const groupSelector = [
  'svg', '.season-profile', '.month-comparison-bars', '.monthly-metric-grid',
  '.comparison-steps', '.stress-comparison-bars', '.bars', '#sensitivityBars', '.pack-bar-chart',
].join(',');
const excludedSelector = '#planPrintSheet, #decisionPrintSheet, [data-chart-interactions="off"]';

export function chartLabel(mark) {
  return (mark.getAttribute('data-chart-label') || mark.querySelector('title')?.textContent
    || mark.getAttribute('title') || mark.getAttribute('aria-label') || mark.textContent || '')
    .replace(/\s+/g, ' ').trim();
}

// Decorate the existing values, including replacement charts after changing a plan.
// One Tab stop per chart; arrow keys move between values, Escape dismisses a tooltip.
export function bindChartInteractions(options = {}) {
  const doc = options.document ?? globalThis.document;
  const win = options.window ?? globalThis.window;
  const tooltip = doc.createElement('div');
  tooltip.id = 'air2stay-chart-tooltip';
  tooltip.className = 'chart-value-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.setAttribute('data-i18n-ignore', '');
  tooltip.hidden = true;
  doc.body.append(tooltip);
  let active = null;
  let selectedGroup = null;
  let selectedSeries = [];
  let groups = new Map();
  let queued = false;
  let destroyed = false;
  const original = new Map();
  const groupOriginal = new Map();
  const remember = (element, map, names) => {
    if (!map.has(element)) map.set(element, Object.fromEntries(names.map(name => [name, element.getAttribute(name)])));
  };
  const restore = (element, values) => {
    for (const [name, value] of Object.entries(values)) value === null ? element.removeAttribute(name) : element.setAttribute(name, value);
  };
  const hide = () => {
    if (active) {
      active.classList.remove('chart-point-active');
      const described = original.get(active)?.['aria-describedby'];
      if (described == null) active.removeAttribute('aria-describedby'); else active.setAttribute('aria-describedby', described);
    }
    selectedGroup?.classList.remove('chart-group-active');
    selectedSeries.forEach(series => series.classList.remove('chart-series-active'));
    selectedSeries = []; active = null; selectedGroup = null; tooltip.hidden = true;
  };
  const place = (mark, event) => {
    const box = mark.getBoundingClientRect();
    const x = Number.isFinite(event?.clientX) ? event.clientX : box.left + box.width / 2;
    const y = Number.isFinite(event?.clientY) ? event.clientY : box.top;
    const width = tooltip.offsetWidth || 280;
    const height = tooltip.offsetHeight || 60;
    const viewportWidth = win?.innerWidth || doc.documentElement.clientWidth;
    const viewportHeight = win?.innerHeight || doc.documentElement.clientHeight;
    tooltip.style.left = `${Math.max(8, Math.min(x + 14, viewportWidth - width - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(y + 18 + height > viewportHeight ? y - height - 12 : y + 18, viewportHeight - height - 8))}px`;
  };
  const show = (mark, event) => {
    if (!mark || mark.closest(excludedSelector)) return;
    const label = chartLabel(mark);
    if (!label) return;
    if (active !== mark) hide();
    active = mark;
    selectedGroup = mark.closest('[data-interactive-chart]');
    mark.classList.add('chart-point-active');
    selectedGroup?.classList.add('chart-group-active');
    const previous = original.get(mark)?.['aria-describedby'];
    mark.setAttribute('aria-describedby', [previous, tooltip.id].filter(Boolean).join(' '));
    const series = Array.from(mark.classList).find(name => /^pack-series-\d+$/.test(name));
    if (series && selectedGroup) selectedSeries = Array.from(selectedGroup.querySelectorAll(`polyline.${series}`));
    else if (mark.matches('.validation-chart circle')) selectedSeries = Array.from(selectedGroup?.querySelectorAll('.transparent-line') || []);
    selectedSeries.forEach(line => line.classList.add('chart-series-active'));
    tooltip.textContent = label;
    tooltip.hidden = false;
    place(mark, event);
  };
  const markFrom = target => target?.closest?.('.chart-interactive');
  const refresh = () => {
    if (destroyed) return;
    queued = false;
    if (active && !active.isConnected) hide();
    // Removed charts must not remain strongly referenced after repeated plan edits.
    for (const mark of original.keys()) if (!mark.isConnected) original.delete(mark);
    for (const group of groupOriginal.keys()) if (!group.isConnected) groupOriginal.delete(group);
    groups = new Map();
    for (const mark of doc.querySelectorAll(markSelector)) {
      if (mark.closest(excludedSelector)) continue;
      const label = chartLabel(mark);
      const group = mark.closest(groupSelector) || mark.parentElement;
      if (!label || !group) continue;
      remember(mark, original, ['tabindex', 'role', 'aria-label', 'aria-describedby']);
      remember(group, groupOriginal, ['role', 'aria-hidden', 'data-interactive-chart']);
      mark.classList.add('chart-interactive');
      if (!original.get(mark)['aria-label']) mark.setAttribute('aria-label', label);
      mark.setAttribute('role', 'img');
      group.setAttribute('data-interactive-chart', '');
      // role=img would otherwise hide individually accessible values from AT.
      if (group.getAttribute('role') === 'img') group.setAttribute('role', 'group');
      if (group.getAttribute('aria-hidden') === 'true') group.removeAttribute('aria-hidden');
      // The seats-to-nights chart also has an image wrapper around its bars.
      // Expose the individually named values without removing its overall description.
      for (let wrapper = group.parentElement?.closest('[role="img"]'); wrapper; wrapper = wrapper.parentElement?.closest('[role="img"]')) {
        remember(wrapper, groupOriginal, ['role']);
        wrapper.setAttribute('role', 'group');
      }
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(mark);
    }
    for (const marks of groups.values()) {
      const selected = marks.includes(doc.activeElement) ? doc.activeElement : marks.find(mark => mark.getAttribute('tabindex') === '0') || marks[0];
      for (const mark of marks) mark.setAttribute('tabindex', mark === selected ? '0' : '-1');
    }
    if (active) { const label = chartLabel(active); if (tooltip.textContent !== label) tooltip.textContent = label; }
  };
  const pointerOver = event => show(markFrom(event.target), event);
  const pointerMove = event => {
    const mark = markFrom(event.target);
    if (mark && (mark !== active || tooltip.hidden)) show(mark, event);
    else if (mark) place(mark, event);
  };
  const pointerOut = event => {
    if (markFrom(event.target) !== markFrom(event.relatedTarget) && doc.activeElement !== active) hide();
  };
  const focusIn = event => show(markFrom(event.target));
  const focusOut = event => { if (markFrom(event.target) !== markFrom(event.relatedTarget)) hide(); };
  const viewportChanged = () => {
    // Browsers may scroll when an arrow-key action focuses the next SVG value.
    // Keep that keyboard tooltip anchored; mouse-only tooltips dismiss on scroll.
    if (active && doc.activeElement === active) place(active);
    else hide();
  };
  const keydown = event => {
    if (event.key === 'Escape') { hide(); return; }
    const mark = markFrom(event.target);
    if (!mark || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const marks = groups.get(mark.closest('[data-interactive-chart]')) || [];
    if (!marks.length) return;
    event.preventDefault();
    const current = marks.indexOf(mark);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? marks.length - 1
      : (current + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + marks.length) % marks.length;
    marks.forEach((item, i) => item.setAttribute('tabindex', i === index ? '0' : '-1'));
    marks[index].focus();
  };
  const handlers = { pointerover: pointerOver, pointermove: pointerMove, pointerout: pointerOut, focusin: focusIn, focusout: focusOut, keydown };
  for (const [event, handler] of Object.entries(handlers)) doc.addEventListener(event, handler);
  win?.addEventListener('scroll', viewportChanged, true);
  win?.addEventListener('resize', viewportChanged);
  const observer = win?.MutationObserver ? new win.MutationObserver(records => {
    if (queued || records.every(record => record.target === tooltip || tooltip.contains(record.target))) return;
    queued = true;
    (win.requestAnimationFrame || (callback => setTimeout(callback, 0)))(refresh);
  }) : null;
  observer?.observe(doc.body, { childList: true, subtree: true });
  refresh();
  return { refresh, destroy() {
    destroyed = true; observer?.disconnect(); hide(); tooltip.remove();
    for (const [event, handler] of Object.entries(handlers)) doc.removeEventListener(event, handler);
    win?.removeEventListener('scroll', viewportChanged, true); win?.removeEventListener('resize', viewportChanged);
    for (const [mark, attributes] of original) { mark.classList.remove('chart-interactive'); restore(mark, attributes); }
    for (const [group, attributes] of groupOriginal) restore(group, attributes);
    original.clear(); groupOriginal.clear(); groups.clear();
  } };
}
