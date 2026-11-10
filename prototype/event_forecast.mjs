// Event forecasts from measured past editions (event_evidence.mjs) and the
// team calendar (news_events.mjs). Pure functions: no page access.
//
// Forecast for an upcoming edition, international hotel guests:
//   effect = average change in guest nights on event nights across measured
//            past editions (range: lowest to highest edition);
//   normal = guests per night in the same calendar month of the latest year
//            with guest-night data, with measured event extras removed;
//   extra guests per night = effect x normal; extra guest nights = that per
//   night, summed over the event nights.
// At least EV_MIN_EDITIONS measured editions are needed; nothing is invented.

export const EV_MIN_EDITIONS = 2;
export const EV_MAX_UPLIFT = 0.5;

const evPad = (value) => String(value).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function evIsoDay(date = new Date()) {
  return `${date.getFullYear()}-${evPad(date.getMonth() + 1)}-${evPad(date.getDate())}`;
}

function evDays(start, end) {
  const days = [];
  const day = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (day <= last) {
    days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

/** Every night of an edition, as YYYY-MM-DD. */
export function evNightsOf(edition) {
  return evDays(edition.start, edition.end);
}

function evDaysInMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}

const evMean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Evidence for an edition, or a reason it cannot be used. Dates must match the calendar. */
export function evEditionEvidence(evidence, eventId, edition) {
  const row = evidence?.editions?.[edition.id];
  if (!row || row.eventId !== eventId) return { status: 'not_measured' };
  if (row.start !== edition.start || row.end !== edition.end) return { status: 'stale' };
  return row;
}

/** Normal international guests per night for a calendar month (MM), from the latest year with data. */
export function evNormalPerNight(evidence, monthNumber) {
  const months = Object.keys(evidence?.monthlyNights || {}).filter((month) => month.endsWith(`-${evPad(monthNumber)}`)).sort();
  const month = months.at(-1);
  if (!month) return null;
  const nights = evidence.monthlyNights[month].international;
  let eventExtra = 0;
  for (const row of Object.values(evidence.editions || {})) {
    if (row.status === 'measured') eventExtra += row.nights?.international?.extraByMonth?.[month] || 0;
  }
  return { month, perNight: (nights - eventExtra) / evDaysInMonth(month) };
}

/** Average absolute miss (percentage points) when each edition is predicted from the others. */
export function evLeaveOneOut(pcts) {
  if (pcts.length < 3) return null;
  const misses = pcts.map((pct, index) => Math.abs(evMean(pcts.filter((_, other) => other !== index)) - pct));
  return evMean(misses) * 100;
}

/** Everything the page and the assistant need about one event. */
export function evEventSummary(event, evidence, today = evIsoDay()) {
  const editions = [...event.editions].sort((a, b) => a.start.localeCompare(b.start));
  const rows = editions.map((edition) => {
    const found = evEditionEvidence(evidence, event.id, edition);
    const status = edition.end >= today ? 'upcoming' : found.status;
    return { edition, status, evidence: found };
  });
  const measured = rows.filter((row) => row.status === 'measured' && Number.isFinite(row.evidence.nights?.international?.pct));
  const pcts = measured.map((row) => row.evidence.nights.international.pct);
  const domestic = measured.map((row) => row.evidence.nights.domestic?.pct).filter(Number.isFinite);
  const upcoming = rows.find((row) => row.status === 'upcoming')?.edition || null;
  const effect = pcts.length >= EV_MIN_EDITIONS ? {
    editions: measured.map((row) => row.edition.id),
    years: measured.map((row) => row.edition.start.slice(0, 4)),
    mean: evMean(pcts), low: Math.min(...pcts), high: Math.max(...pcts),
    domesticMean: domestic.length ? evMean(domestic) : null,
    checkPoints: evLeaveOneOut(pcts),
  } : null;
  const nationalityTotals = new Map();
  for (const row of measured) {
    for (const item of row.evidence.topNationalities || []) nationalityTotals.set(item.country, (nationalityTotals.get(item.country) || 0) + item.extra);
  }
  const nationalities = [...nationalityTotals].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([country]) => country);
  return { event, rows, upcoming, effect, nationalities, forecast: upcoming && effect ? evForecast(effect, upcoming, evidence) : null };
}

/** Forecast for one upcoming edition from a measured effect. */
export function evForecast(effect, edition, evidence) {
  // Normal level for these dates in the latest year with guest-night data (measured by
  // src/build_event_evidence.py with the same matched weeks as past editions).
  const row = evEditionEvidence(evidence, evidence?.editions?.[edition.id]?.eventId, edition);
  const reference = row.referenceNormal;
  if (!reference || !(reference.perNight > 0)) return null;
  const nights = evDays(edition.start, edition.end);
  const byMonth = new Map();
  for (const day of nights) byMonth.set(day.slice(0, 7), (byMonth.get(day.slice(0, 7)) || 0) + 1);
  // The plan's event control raises one whole month: use the month with the most event
  // nights and express the extra nights in it as a share of that month's normal nights.
  const [planMonth, planNights] = [...byMonth].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const monthNormal = evNormalPerNight(evidence, Number(planMonth.slice(5)));
  const perNight = (pct) => reference.perNight * pct;
  const rawUplift = monthNormal ? perNight(effect.mean) * planNights / (monthNormal.perNight * evDaysInMonth(planMonth)) : null;
  return {
    nights: nights.length,
    normalPerNight: reference.perNight,
    basedOn: reference.days[0].slice(0, 4),
    perNight: { mid: perNight(effect.mean), low: perNight(effect.low), high: perNight(effect.high) },
    extraNights: { mid: perNight(effect.mean) * nights.length, low: perNight(effect.low) * nights.length, high: perNight(effect.high) * nights.length },
    planMonth: Number(planMonth.slice(5)),
    uplift: rawUplift > 0 ? Math.min(EV_MAX_UPLIFT, rawUplift) : null,
    upliftCapped: rawUplift > EV_MAX_UPLIFT,
  };
}

/** News newest first; optional topic filter. */
export function evNewsList(news, topic = 'all') {
  return [...(news || [])]
    .filter((item) => topic === 'all' || item.topic === topic)
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

// Dates and numbers as the page and the assistant show them.
export const EV_MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const EV_MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];

export function evDate(day, lang = 'en') {
  const [year, month, date] = day.split('-').map(Number);
  return `${date} ${(lang === 'ar' ? EV_MONTHS_AR : EV_MONTHS_EN)[month - 1]} ${year}`;
}

export function evDateRange(start, end, lang = 'en') {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const month = (number) => lang === 'ar' ? EV_MONTHS_AR[number - 1] : EV_MONTHS_EN[number - 1].slice(0, 3);
  if (start === end) return `${sd} ${month(sm)} ${sy}`;
  if (sy === ey && sm === em) return `${sd}–${ed} ${month(sm)} ${sy}`;
  if (sy === ey) return `${sd} ${month(sm)} – ${ed} ${month(em)} ${sy}`;
  return `${sd} ${month(sm)} ${sy} – ${ed} ${month(em)} ${ey}`;
}

export const evSignedNumber = (value) => (value < 0 ? '−' : '+') + Math.round(Math.abs(value)).toLocaleString('en-US');
export const evSignedPercent = (value) => (value < 0 ? '−' : '+') + Math.abs(value * 100).toFixed(1) + '%';
export const evAbout = (value, step) => Math.round(value / step) * step;

/** Plain English data for the assistant, which translates its reply lines. */
export function evChatData(calendar, evidence, today = evIsoDay(), countryName = (key) => key, knownCountries = []) {
  const items = calendar.events.map((event) => {
    const { upcoming, effect, forecast, rows } = evEventSummary(event, evidence, today);
    return {
      id: event.id, name: event.name, minEditions: EV_MIN_EDITIONS,
      upcoming: upcoming ? {
        id: upcoming.id, start: upcoming.start, dates: evDateRange(upcoming.start, upcoming.end, 'en'),
        months: [...new Set(evNightsOf(upcoming).map((day) => Number(day.slice(5, 7))))],
      } : null,
      effect: effect ? {
        mean: evSignedPercent(effect.mean), low: evSignedPercent(effect.low), high: evSignedPercent(effect.high), years: effect.years,
        domestic: effect.domesticMean == null ? null : evSignedPercent(effect.domesticMean), domesticFell: effect.domesticMean < 0,
      } : null,
      forecast: forecast ? {
        perNight: evAbout(forecast.perNight.mid, 10), extraNights: evAbout(forecast.extraNights.mid, 100), nights: forecast.nights,
        low: evSignedNumber(evAbout(forecast.perNight.low, 10)), high: evSignedNumber(evAbout(forecast.perNight.high, 10)),
        applyPercent: forecast.uplift == null ? 0 : Math.round(forecast.uplift * 100),
      } : null,
      rows: rows.map(({ edition, status, evidence: found }) => ({
        year: edition.start.slice(0, 4), status,
        pct: status === 'measured' ? evSignedPercent(found.nights.international.pct) : null,
      })),
    };
  });
  const news = evNewsList(calendar.news).map((item) => ({
    headline: item.headline, source: item.source, date: evDate(item.date, 'en'), summary: item.summary,
    topic: item.topic, eventId: item.eventId, affects: (item.affects || []).map(countryName),
  }));
  // knownCountries lets the assistant say "no news about Germany" instead of listing everything.
  return { items, news, countries: [...new Set(news.flatMap((item) => item.affects))], knownCountries: [...new Set(knownCountries)] };
}

/** Count of items the viewer has not seen: news added after the last visit, plus events starting within 30 days. */
export function evUnseenCount(news, summaries, seen = {}, today = evIsoDay()) {
  const seenNews = new Set(Array.isArray(seen.news) ? seen.news : []);
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 30);
  const limit = soon.toISOString().slice(0, 10);
  const seenEvents = new Set(Array.isArray(seen.events) ? seen.events : []);
  const newNews = (news || []).filter((item) => !seenNews.has(item.id)).length;
  const nearEvents = summaries.filter((summary) => summary.upcoming && summary.upcoming.start <= limit && !seenEvents.has(summary.upcoming.id)).length;
  return newNews + nearEvents;
}
