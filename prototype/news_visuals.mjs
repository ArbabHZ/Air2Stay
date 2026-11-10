// Pure presentation helpers. Values and coverage come only from the supplied evidence.
const nvEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const nvText = (lang, en, ar) => lang === 'ar' ? ar : en;
const nvNumber = (value, digits = 0) => Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const nvSigned = (value, digits = 0) => `${Number(Math.abs(value).toFixed(digits)) === 0 ? '' : value < 0 ? '−' : '+'}${nvNumber(Math.abs(value), digits)}`;
const nvName = (summary, lang) => lang === 'ar' ? summary?.event?.nameAr || summary?.event?.name : summary?.event?.name;
const nvLang = (lang) => `data-i18n-ignore lang="${lang === 'ar' ? 'ar' : 'en'}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"`;
const nvMetrics = {
  international_pct: ['International guest nights', 'ليالي النزلاء الدوليين'],
  extra_nights: ['Extra international guest nights', 'ليالي النزلاء الدوليين الإضافية'],
  domestic_pct: ['UAE-resident guest nights', 'ليالي النزلاء المقيمين في الإمارات'],
  checkins_pct: ['International check-ins', 'تسجيلات وصول النزلاء الدوليين'],
};
const nvTopics = { flights: ['Flights', 'الطيران'], tourism: ['Tourism', 'السياحة'], events: ['Events', 'الفعاليات'] };

function nvDate(day, lang) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return nvText(lang, 'Date unavailable', 'التاريخ غير متاح');
  const date = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return nvText(lang, 'Date unavailable', 'التاريخ غير متاح');
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-AE-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function nvScale(values, left, right) {
  const finite = values.filter(Number.isFinite);
  let low = Math.min(0, ...finite), high = Math.max(0, ...finite);
  if (low === high) { low = -1; high = 1; }
  const rough = (high - low) / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((factor) => factor * power >= rough) * power;
  low = Math.floor(low / step) * step;
  high = Math.ceil(high / step) * step;
  const ticks = Array.from({ length: Math.round((high - low) / step) + 1 }, (_, index) => low + index * step);
  return { low, high, ticks, x: (value) => left + (value - low) / (high - low) * (right - left) };
}

function nvAxes(scale, top, bottom, format) {
  return scale.ticks.map((tick) => `<line class="${Math.abs(tick) < 1e-10 ? 'nv-zero' : 'nv-grid'}" x1="${scale.x(tick)}" x2="${scale.x(tick)}" y1="${top}" y2="${bottom}"/><text class="nv-axis" x="${scale.x(tick)}" y="${bottom + 23}" text-anchor="middle">${nvEscape(format(tick))}</text>`).join('');
}

function nvSvg(width, height, label, content) {
  return `<div class="nv-chart-scroll" dir="ltr"><svg class="nv-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="group" aria-label="${nvEscape(label)}" style="font-size:14px" xmlns="http://www.w3.org/2000/svg"><title>${nvEscape(label)}</title>${content}</svg></div>`;
}

function nvMark(label, x, y, width, height, content) {
  return `<g class="nv-mark" data-chart-label="${nvEscape(label)}"><title>${nvEscape(label)}</title><rect class="nv-hit" x="${x}" y="${y}" width="${width}" height="${height}" fill="transparent"/>${content}</g>`;
}

function nvEmpty(lang, text, arabic) {
  return `<p class="nv-caption">${nvEscape(nvText(lang, text, arabic))}</p>`;
}

export function newsUpcomingVisual(summaries = [], lang = 'en') {
  const upcoming = summaries.filter((summary) => summary?.upcoming);
  const ready = upcoming.filter((summary) => ['low', 'mid', 'high'].every((key) => Number.isFinite(summary.forecast?.perNight?.[key])));
  const missing = upcoming.filter((summary) => !ready.includes(summary));
  const title = nvText(lang, 'Upcoming events · guests per night', 'الفعاليات القادمة · النزلاء في الليلة');
  const caption = nvText(lang, 'Estimated change in international hotel guests per event night. The line spans the lowest to highest measured past edition; the dot uses their mean. This historical-edition range is not a confidence interval.', 'التغير المتوقع في عدد نزلاء الفنادق الدوليين لكل ليلة فعالية. يمتد الخط من أدنى أثر إلى أعلاه في الدورات السابقة المقاسة، وتمثل النقطة متوسطها. نطاق الدورات التاريخية ليس فترة ثقة.');
  let chart = '';
  if (ready.length) {
    const scale = nvScale(ready.flatMap((summary) => Object.values(summary.forecast.perNight)), 48, 712);
    const bottom = ready.length * 100 + 2;
    const rows = ready.map((summary, index) => {
      const y = index * 100 + 72, forecast = summary.forecast.perNight;
      const name = nvName(summary, lang), dates = `${nvDate(summary.upcoming.start, lang)} – ${nvDate(summary.upcoming.end, lang)}`;
      const values = `${nvSigned(forecast.low)} ${nvText(lang, 'to', 'إلى')} ${nvSigned(forecast.high)}; ${nvText(lang, 'mean', 'المتوسط')} ${nvSigned(forecast.mid)}`;
      const tooltip = `${name}. ${dates}. ${nvText(lang, 'International guests per night', 'النزلاء الدوليون في الليلة')}: ${values}. ${nvText(lang, 'Measured editions', 'الدورات المقاسة')}: ${(summary.effect?.years || []).join(', ')}.`;
      return nvMark(tooltip, 12, y - 63, 736, 85,
        `<text class="nv-label" x="24" y="${y - 44}">${nvEscape(name)}</text><text class="nv-date" x="24" y="${y - 24}">${nvEscape(dates)}</text><text class="nv-value" x="736" y="${y - 24}" text-anchor="end">${nvEscape(nvText(lang, 'Mean ', 'المتوسط ') + nvSigned(forecast.mid))}</text><line class="nv-range" x1="${scale.x(forecast.low)}" x2="${scale.x(forecast.high)}" y1="${y}" y2="${y}" stroke-width="6" stroke-linecap="round"/><line class="nv-range" x1="${scale.x(forecast.low)}" x2="${scale.x(forecast.low)}" y1="${y - 7}" y2="${y + 7}"/><line class="nv-range" x1="${scale.x(forecast.high)}" x2="${scale.x(forecast.high)}" y1="${y - 7}" y2="${y + 7}"/><circle class="nv-dot" cx="${scale.x(forecast.mid)}" cy="${y}" r="6"/>`);
    }).join('');
    chart = nvSvg(760, bottom + 40, title, nvAxes(scale, 60, bottom, (value) => nvSigned(value)) + rows);
  }
  const notes = missing.map((summary) => `<li class="nv-status" data-status="unavailable"><strong>${nvEscape(nvName(summary, lang))}</strong> · ${nvEscape(nvDate(summary.upcoming.start, lang))} · ${nvEscape(nvText(lang, 'No forecast: enough measured editions and a matching reference period are required.', 'لا يوجد توقع: يلزم عدد كافٍ من الدورات المقاسة وفترة مرجعية مطابقة.'))}</li>`).join('');
  const legend = `<div class="nv-legend"><span class="nv-legend-item"><i class="nv-key nv-key-range" aria-hidden="true"></i>${nvText(lang, 'Historical-edition range', 'نطاق الدورات التاريخية')}</span><span class="nv-legend-item"><i class="nv-key nv-key-dot" aria-hidden="true"></i>${nvText(lang, 'Mean estimate', 'متوسط التقدير')}</span></div>`;
  return `<section class="nv-panel nv-upcoming" ${nvLang(lang)}><h2 class="nv-heading">${title}</h2><p class="nv-caption">${caption}</p>${chart ? legend + chart : ''}${!upcoming.length ? nvEmpty(lang, 'No upcoming event with announced dates is available.', 'لا تتوفر فعالية قادمة ذات مواعيد معلنة.') : ''}${notes ? `<ul class="nv-status-list">${notes}</ul>` : ''}</section>`;
}

export function newsTopicVisual(items = [], lang = 'en') {
  const counts = new Map();
  for (const item of items) counts.set(item.topic || 'other', (counts.get(item.topic || 'other') || 0) + 1);
  const topics = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topicName = (topic) => nvTopics[topic]?.[lang === 'ar' ? 1 : 0] || nvText(lang, 'Other news', 'أخبار أخرى');
  const title = nvText(lang, 'What is in this news selection?', 'ما محتوى هذه المجموعة من الأخبار؟');
  const caption = nvText(lang, `${items.length} articles in the current filter. Bars count articles, not visitors or demand. Dates are the publisher’s publication or update dates.`, `${items.length} مقالات ضمن عامل التصفية الحالي. تعدّ الأشرطة المقالات، ولا تقيس الزوار أو الطلب. التواريخ هي تواريخ النشر أو التحديث لدى الناشر.`);
  let chart = '';
  if (topics.length) {
    const max = Math.max(...topics.map(([, count]) => count));
    const x = (value) => 140 + value / max * 270;
    const bottom = topics.length * 48 + 10;
    const axes = Array.from({ length: Math.min(max, 5) + 1 }, (_, index) => Math.round(index * max / Math.min(max, 5))).filter((value, index, list) => list.indexOf(value) === index)
      .map((value) => `<line class="${value === 0 ? 'nv-zero' : 'nv-grid'}" x1="${x(value)}" x2="${x(value)}" y1="10" y2="${bottom}"/><text class="nv-axis" x="${x(value)}" y="${bottom + 24}" text-anchor="middle">${value}</text>`).join('');
    const bars = topics.map(([topic, count], index) => {
      const y = index * 48 + 32, label = `${topicName(topic)}: ${count} ${nvText(lang, 'articles', 'مقالات')}`;
      return nvMark(label, 8, y - 20, 444, 42, `<text class="nv-label" x="16" y="${y + 5}">${nvEscape(topicName(topic))}</text><rect class="nv-bar nv-positive" x="140" y="${y - 12}" width="${x(count) - 140}" height="24" rx="4"/><text class="nv-value" x="430" y="${y + 5}" text-anchor="middle">${count}</text>`);
    }).join('');
    chart = nvSvg(460, bottom + 42, nvText(lang, 'Article counts by category', 'عدد المقالات حسب الفئة'), axes + bars);
  }
  const timeline = [...items].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.id || '').localeCompare(String(b.id || ''))).map((item) => {
    const kind = item.dateKind === 'updated' ? nvText(lang, 'Updated', 'حُدّث') : item.dateKind === 'published' ? nvText(lang, 'Published', 'نُشر') : nvText(lang, 'Article date', 'تاريخ المقال');
    const label = lang === 'ar' ? item.headlineAr || item.summaryAr || item.headline : item.headline || item.summary;
    return `<li class="nv-timeline-item"><div class="nv-timeline-date"><time datetime="${nvEscape(item.date || '')}">${nvEscape(nvDate(item.date, lang))}</time><span class="nv-date-kind">${kind}</span></div><div class="nv-timeline-copy"><strong>${nvEscape(label)}</strong><small>${nvEscape(item.source)} · ${nvEscape(topicName(item.topic))}</small></div></li>`;
  }).join('');
  return `<section class="nv-panel nv-topics" ${nvLang(lang)}><h2 class="nv-heading">${title}</h2><p class="nv-caption">${caption}</p>${items.length ? `<div class="nv-topic-layout">${chart}<ol class="nv-timeline" aria-label="${nvEscape(nvText(lang, 'Publication and update timeline, earliest first', 'تسلسل النشر والتحديث، الأقدم أولاً'))}">${timeline}</ol></div>` : nvEmpty(lang, 'No articles match this filter.', 'لا توجد مقالات تطابق عامل التصفية هذا.')}</section>`;
}

function nvMetric(metric) { return Object.hasOwn(nvMetrics, metric) ? metric : 'international_pct'; }

function nvMetricValue(row, metric) {
  if (row?.status !== 'measured') return null;
  const evidence = row.evidence;
  const value = metric === 'extra_nights' ? evidence?.nights?.international?.extra
    : metric === 'domestic_pct' ? evidence?.nights?.domestic?.pct
      : metric === 'checkins_pct' ? evidence?.checkins?.international?.pct : evidence?.nights?.international?.pct;
  return Number.isFinite(value) ? value * (metric === 'extra_nights' ? 1 : 100) : null;
}

function nvCoverage(row, metric, lang) {
  const evidence = row.evidence || {};
  const section = metric === 'domestic_pct' ? evidence.nights?.domestic : evidence.nights?.international;
  const measured = section?.days?.length;
  const coverage = Number.isInteger(measured) && Number.isFinite(evidence.eventNights)
    ? nvText(lang, `${measured}/${evidence.eventNights} event nights measured`, `${measured}/${evidence.eventNights} ليالٍ مقاسة للفعالية`)
    : nvText(lang, 'Night coverage unavailable', 'تغطية الليالي غير متاحة');
  const days = evidence.checkins?.international?.days?.length;
  return metric === 'checkins_pct' && Number.isInteger(days)
    ? nvText(lang, `${days} check-in observation days; ${coverage}`, `${days} أيام لرصد الوصول؛ ${coverage}`) : coverage;
}

function nvStatus(status, lang) {
  const labels = {
    upcoming: ['Upcoming; not measured', 'قادمة؛ غير مقاسة'],
    no_guest_nights: ['Guest-night data unavailable', 'بيانات ليالي النزلاء غير متاحة'],
    after_data: ['After the available data period', 'بعد فترة البيانات المتاحة'],
    before_data: ['Before the available data period', 'قبل فترة البيانات المتاحة'],
    too_few_days: ['Too few clean comparison days', 'أيام المقارنة الصالحة غير كافية'],
    stale: ['Dates changed; evidence needs updating', 'تغيرت المواعيد؛ يجب تحديث الأدلة'],
    measured: ['Selected metric not measured', 'المؤشر المحدد غير مقاس'],
  };
  return (labels[status] || ['Not measured', 'غير مقاسة'])[lang === 'ar' ? 1 : 0];
}

export function newsPastVisual(summary, metric = 'international_pct', lang = 'en', allSummaries = []) {
  metric = nvMetric(metric);
  const name = nvName(summary, lang), label = nvMetrics[metric][lang === 'ar' ? 1 : 0];
  const rows = summary?.rows || [];
  const measured = rows.filter((row) => nvMetricValue(row, metric) !== null);
  const unavailable = rows.filter((row) => nvMetricValue(row, metric) === null);
  const format = (value) => metric === 'extra_nights' ? nvSigned(value) : `${nvSigned(value, 1)}%`;
  const caption = nvText(lang, 'Change from nearby normal weekdays. Every event chart uses the same scale for this metric; zero means no measured change. Negative values are retained.', 'التغير مقارنة بأيام الأسبوع العادية القريبة. تستخدم رسوم جميع الفعاليات المقياس نفسه لهذا المؤشر؛ والصفر يعني عدم وجود تغير مقاس. تُعرض القيم السالبة كما هي.');
  let chart = '';
  if (measured.length) {
    const all = [...allSummaries, summary].filter(Boolean).flatMap((item) => item.rows || []).map((row) => nvMetricValue(row, metric)).filter(Number.isFinite);
    const scale = nvScale(all, 92, 564), bottom = measured.length * 66 + 6;
    const bars = measured.map((row, index) => {
      const y = index * 66 + 30, value = nvMetricValue(row, metric), year = String(row.edition?.start || '').slice(0, 4);
      const coverage = nvCoverage(row, metric, lang), tooltip = `${name}, ${year}. ${label}: ${format(value)}. ${coverage}.`;
      const x = Math.min(scale.x(0), scale.x(value)), width = Math.abs(scale.x(value) - scale.x(0));
      const mark = value === 0 ? `<circle class="nv-dot" cx="${scale.x(0)}" cy="${y}" r="4"/>`
        : `<rect class="nv-bar ${value < 0 ? 'nv-negative' : 'nv-positive'}" x="${x}" y="${y - 11}" width="${width}" height="22" rx="3"/>`;
      return nvMark(tooltip, 8, y - 20, 664, 62, `<text class="nv-label" x="18" y="${y + 5}">${nvEscape(year)}</text>${mark}<text class="nv-value" x="656" y="${y + 5}" text-anchor="end">${nvEscape(format(value))}</text><text class="nv-date" x="92" y="${y + 29}">${nvEscape(coverage)}</text>`);
    }).join('');
    chart = nvSvg(680, bottom + 40, `${name}: ${label}`, nvAxes(scale, 10, bottom, (value) => metric === 'extra_nights' ? nvSigned(value) : `${nvSigned(value, 1)}%`) + bars);
  }
  const statuses = unavailable.map((row) => `<li class="nv-status" data-status="${nvEscape(row.status)}"><strong>${nvEscape(String(row.edition?.start || '').slice(0, 4))}</strong> · ${nvEscape(nvStatus(row.status, lang))}</li>`).join('');
  const legend = `<div class="nv-legend"><span class="nv-legend-item"><i class="nv-key nv-positive" aria-hidden="true"></i>${nvText(lang, 'Above normal', 'أعلى من المعتاد')}</span><span class="nv-legend-item"><i class="nv-key nv-negative" aria-hidden="true"></i>${nvText(lang, 'Below normal', 'أقل من المعتاد')}</span></div>`;
  const measure = label + (metric === 'extra_nights' ? '' : ' (%)');
  return `<section class="nv-panel nv-past" ${nvLang(lang)}><h2 class="nv-heading">${nvEscape(name)}</h2><p class="nv-measure"><strong>${nvEscape(measure)}</strong></p><p class="nv-caption">${caption}</p>${chart ? legend + chart : nvEmpty(lang, 'No measured value is available for this metric.', 'لا تتوفر قيمة مقاسة لهذا المؤشر.')}${statuses ? `<ul class="nv-status-list">${statuses}</ul>` : ''}</section>`;
}

export function newsMetricControl(metric = 'international_pct', lang = 'en') {
  metric = nvMetric(metric);
  return `<label class="nv-metric-control" ${nvLang(lang)}><span>${nvText(lang, 'Compare past editions by', 'مقارنة الدورات السابقة حسب')}</span><select data-news-metric aria-label="${nvText(lang, 'Past event comparison metric', 'مؤشر مقارنة الفعاليات السابقة')}">${Object.entries(nvMetrics).map(([value, names]) => `<option value="${value}"${metric === value ? ' selected' : ''}>${nvEscape(names[lang === 'ar' ? 1 : 0])}${value === 'extra_nights' ? '' : ' (%)'}</option>`).join('')}</select></label>`;
}
