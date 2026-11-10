import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as engine from '../prototype/engine.mjs';
import * as decisions from '../prototype/decision_tools.mjs';
import * as routes from '../prototype/route_planning.mjs';
import * as eventForecast from '../prototype/event_forecast.mjs';
import { NEWS_EVENTS } from '../prototype/news_events.mjs';
import { EVENT_EVIDENCE } from '../prototype/event_evidence.mjs';
import { EV_MIN_EDITIONS, EV_MAX_UPLIFT, evEventSummary, evForecast, evLeaveOneOut, evNormalPerNight, evNewsList, evUnseenCount, evChatData,
  evDate, evDateRange, evSignedNumber, evSignedPercent, evNightsOf, evIsoDay } from '../prototype/event_forecast.mjs';
import { pcEventsReply, arabicPromptToEnglish, planningChatReply } from '../prototype/planning_chat.mjs';
import { runScenario, getBridge } from '../prototype/engine.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const iso = /^\d{4}-\d{2}-\d{2}$/;
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const close = (a, b, message) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${message}: ${a} vs ${b}`);
const TODAY = '2026-11-11';

// 1. The team's calendar: valid dates, a source for every date, unique ids, known routes.
const ids = new Set();
for (const event of NEWS_EVENTS.events) {
  assert.ok(event.id && event.name && event.nameAr && event.venue && event.venueAr, event.id);
  assert.ok(/[؀-ۿ]/.test(event.nameAr) && /[؀-ۿ]/.test(event.venueAr), `${event.id} Arabic`);
  for (const edition of event.editions) {
    assert.ok(!ids.has(edition.id), edition.id); ids.add(edition.id);
    assert.ok(edition.id.startsWith(event.id + '-'), edition.id);
    assert.match(edition.start, iso); assert.match(edition.end, iso);
    assert.ok(edition.start <= edition.end, edition.id);
    assert.ok(new Date(edition.start + 'T00:00:00Z').toISOString().startsWith(edition.start), `${edition.id} real date`);
    assert.match(edition.source, /^https:\/\//, edition.id);
  }
}
for (const holiday of NEWS_EVENTS.holidays) {
  assert.match(holiday.start, iso); assert.match(holiday.end, iso);
  assert.ok(holiday.start <= holiday.end, holiday.id);
  assert.ok(holiday.source === '' ? /method choice/.test(holiday.name) : /^https:\/\//.test(holiday.source), holiday.id);
}
const originKeys = new Set(data.routes.map((route) => route.originKey));
const newsIds = new Set();
for (const item of NEWS_EVENTS.news) {
  assert.ok(!newsIds.has(item.id)); newsIds.add(item.id);
  assert.match(item.date, iso);
  assert.ok(['published', 'updated'].includes(item.dateKind), item.id);
  assert.ok(['Khaleej Times', 'Gulf News'].includes(item.source), item.id);
  assert.match(item.url, /^https:\/\/(www\.)?(khaleejtimes\.com|gulfnews\.com)\//, item.id);
  assert.ok(['flights', 'tourism', 'events'].includes(item.topic), item.id);
  assert.ok(item.headline && item.summary && /[؀-ۿ]/.test(item.summaryAr), item.id);
  for (const key of item.affects) assert.ok(originKeys.has(key), `${item.id} affects ${key}`);
  if (item.eventId) assert.ok(NEWS_EVENTS.events.some((event) => event.id === item.eventId), item.id);
}

// Every card names a picture that exists in the images folder, with a safe file name.
const imageName = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:svg|png|jpe?g|webp)$/i;
for (const card of [...NEWS_EVENTS.events, ...NEWS_EVENTS.news]) {
  assert.match(card.image, imageName, card.id);
  assert.ok(fs.existsSync(new URL(`../prototype/images/news-events/${card.image}`, import.meta.url)), `${card.id}: missing ${card.image}`);
}
assert.ok(fs.existsSync(new URL('../prototype/images/news-events/news-events.jpg', import.meta.url)), 'fallback picture');
// Credits: every credited file exists, and each credit names an author, a licence and the original.
for (const [file, credit] of Object.entries(NEWS_EVENTS.imageCredits || {})) {
  assert.ok(fs.existsSync(new URL(`../prototype/images/news-events/${file}`, import.meta.url)), `credit for missing ${file}`);
  assert.ok(credit.author && credit.licence && credit.site, file);
  assert.match(credit.source, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/, file);
  assert.ok(/^(CC BY(-SA)? \d\.\d|CC0|Public domain)$/.test(credit.licence), `${file}: reusable licence`);
  if (/^CC BY/.test(credit.licence)) assert.match(credit.licenceUrl, /^https:\/\/creativecommons\.org\/licenses\//, file);
}
// 2. The measured evidence was built from this exact calendar.
for (const event of NEWS_EVENTS.events) {
  assert.deepEqual(EVENT_EVIDENCE.calendar[event.id], event.editions.map((edition) => [edition.id, edition.start, edition.end]), `${event.id} evidence is out of date`);
}
assert.deepEqual(EVENT_EVIDENCE.holidays, NEWS_EVENTS.holidays.map((holiday) => [holiday.start, holiday.end]));
assert.equal(EVENT_EVIDENCE.dataPeriod.end, '2026-02-28');
assert.equal(EVENT_EVIDENCE.guestsPeriod.end, '2025-07-31');
const holidayDays = new Set(NEWS_EVENTS.holidays.flatMap((holiday) => evNightsOf(holiday)));
for (const [id, row] of Object.entries(EVENT_EVIDENCE.editions)) {
  const edition = NEWS_EVENTS.events.flatMap((event) => event.editions).find((item) => item.id === id);
  assert.ok(edition, id);
  if (edition.start > EVENT_EVIDENCE.dataPeriod.end) assert.equal(row.status, 'after_data', id);
  if (row.status !== 'measured') continue;
  assert.ok(edition.end <= EVENT_EVIDENCE.guestsPeriod.end, `${id} measured on guest nights only inside the Guests period`);
  for (const [segment, value] of Object.entries(row.nights)) {
    close(value.extra, Math.round((value.actual - value.normal) * 100) / 100, `${id} ${segment} extra`);
    close(value.pct, (value.actual - value.normal) / value.normal, `${id} ${segment} pct`);
    for (const day of value.days) {
      assert.ok(day >= edition.start && day <= edition.end, `${id} night ${day}`);
      assert.ok(!holidayDays.has(day), `${id} holiday night ${day}`);
    }
  }
  close(Object.values(row.nights.international.extraByMonth).reduce((sum, value) => sum + value, 0), row.nights.international.extra, `${id} months add up`);
}

// 3. Today's summaries: what is upcoming, what is measured, what is not.
const summaries = Object.fromEntries(NEWS_EVENTS.events.map((event) => [event.id, evEventSummary(event, EVENT_EVIDENCE, TODAY)]));
assert.equal(summaries.f1.upcoming.id, 'f1-2026');
assert.equal(summaries.idex.upcoming.id, 'idex-2027');
assert.equal(summaries.adibf.upcoming.id, 'adibf-2027');
assert.equal(summaries.adipec.upcoming, null, 'ADIPEC 2027 dates are not announced');
assert.deepEqual(summaries.f1.rows.map((row) => row.status), ['measured', 'measured', 'measured', 'no_guest_nights', 'upcoming']);
assert.deepEqual(summaries.adipec.rows.map((row) => row.status), ['measured', 'measured', 'measured', 'no_guest_nights', 'after_data']);
assert.deepEqual(summaries.adibf.rows.map((row) => row.status), ['measured', 'measured', 'measured', 'measured', 'after_data', 'upcoming']);
assert.deepEqual(summaries.f1.effect.years, ['2022', '2023', '2024']);

// 4. The forecast, recomputed by hand from the evidence.
for (const [id, summary] of Object.entries(summaries)) {
  const pcts = summary.rows.filter((row) => row.status === 'measured').map((row) => row.evidence.nights.international.pct);
  if (pcts.length < EV_MIN_EDITIONS) { assert.equal(summary.effect, null, id); continue; }
  close(summary.effect.mean, mean(pcts), `${id} mean`);
  assert.equal(summary.effect.low, Math.min(...pcts)); assert.equal(summary.effect.high, Math.max(...pcts));
  if (!summary.upcoming) { assert.equal(summary.forecast, null); continue; }
  const reference = EVENT_EVIDENCE.editions[summary.upcoming.id].referenceNormal;
  const nights = evNightsOf(summary.upcoming).length;
  close(summary.forecast.perNight.mid, reference.perNight * mean(pcts), `${id} per night`);
  close(summary.forecast.extraNights.mid, reference.perNight * mean(pcts) * nights, `${id} extra nights`);
  close(summary.forecast.perNight.low, reference.perNight * Math.min(...pcts), `${id} low`);
  assert.equal(summary.forecast.nights, nights);
  // The plan month and its share: extra nights in that month over the month's normal nights.
  const byMonth = {};
  for (const day of evNightsOf(summary.upcoming)) byMonth[day.slice(0, 7)] = (byMonth[day.slice(0, 7)] || 0) + 1;
  const [month, count] = Object.entries(byMonth).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  assert.equal(summary.forecast.planMonth, Number(month.slice(5)));
  const normal = evNormalPerNight(EVENT_EVIDENCE, Number(month.slice(5)));
  const days = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate();
  const share = reference.perNight * mean(pcts) * count / (normal.perNight * days);
  close(summary.forecast.uplift, Math.min(EV_MAX_UPLIFT, share), `${id} uplift`);
}
// The F1 2026 reference is the clean weeks around F1 2024 (same weekdays, 104 weeks earlier).
assert.equal(EVENT_EVIDENCE.editions['f1-2026'].referenceNormal.shiftedWeeks, 104);
assert.ok(EVENT_EVIDENCE.editions['f1-2026'].referenceNormal.days.every((day) => day >= '2024-12-04' && day <= '2024-12-06'));
// The month's normal level has that year's measured event extras removed.
const december = EVENT_EVIDENCE.monthlyNights['2024-12'].international;
close(evNormalPerNight(EVENT_EVIDENCE, 12).perNight, (december - EVENT_EVIDENCE.editions['f1-2024'].nights.international.extraByMonth['2024-12']) / 31, 'December normal');
assert.equal(Math.round(summaries.f1.forecast.uplift * 100), 3);
assert.equal(Math.round(summaries.adibf.forecast.uplift * 100), 3);
assert.equal(Math.round(summaries.idex.forecast.uplift * 100), 0, 'IDEX is too small to set on the whole-percent control');

// 5. Leave-one-out check: each edition predicted from the others.
assert.equal(evLeaveOneOut([0.1, 0.2]), null);
close(evLeaveOneOut([0.1, 0.2, 0.3]), mean([Math.abs(0.25 - 0.1), Math.abs(0.2 - 0.2), Math.abs(0.15 - 0.3)]) * 100, 'leave one out');

// 6. Dates move on: after the F1 race the next F1 is not announced, and nothing is invented.
const afterRace = evEventSummary(NEWS_EVENTS.events.find((event) => event.id === 'f1'), EVENT_EVIDENCE, '2026-12-07');
assert.equal(afterRace.upcoming, null);
assert.equal(afterRace.rows.at(-1).status, 'after_data');
assert.equal(afterRace.forecast, null);
const onRaceDay = evEventSummary(NEWS_EVENTS.events.find((event) => event.id === 'f1'), EVENT_EVIDENCE, '2026-12-06');
assert.equal(onRaceDay.upcoming.id, 'f1-2026', 'an edition stays upcoming until its last day');

// 7. A calendar edit without a new measurement is flagged, never used.
const edited = structuredClone(NEWS_EVENTS.events.find((event) => event.id === 'adibf'));
edited.editions[0].start = '2022-05-24';
const stale = evEventSummary(edited, EVENT_EVIDENCE, TODAY);
assert.equal(stale.rows[0].status, 'stale');
assert.deepEqual(stale.effect.years, ['2023', '2024', '2025']);
// Fewer than two measured editions: no effect, no forecast.
const single = structuredClone(NEWS_EVENTS.events.find((event) => event.id === 'idex'));
single.editions = single.editions.filter((edition) => edition.id !== 'idex-2023');
const singleSummary = evEventSummary(single, EVENT_EVIDENCE, TODAY);
assert.equal(singleSummary.effect, null);
assert.equal(singleSummary.forecast, null);
// No reference normal for an edition: no forecast.
assert.equal(evForecast(summaries.f1.effect, { id: 'f1-2099', start: '2099-12-01', end: '2099-12-03' }, EVENT_EVIDENCE), null);

// 8. News order, topics and the unread badge.
assert.deepEqual(evNewsList(NEWS_EVENTS.news).map((item) => item.date), [...NEWS_EVENTS.news.map((item) => item.date)].sort().reverse());
assert.ok(evNewsList(NEWS_EVENTS.news, 'flights').every((item) => item.topic === 'flights'));
const all = Object.values(summaries);
assert.equal(evUnseenCount(NEWS_EVENTS.news, all, {}, TODAY), NEWS_EVENTS.news.length + 1, 'all news plus F1 within 30 days');
assert.equal(evUnseenCount(NEWS_EVENTS.news, all, { news: NEWS_EVENTS.news.map((item) => item.id), events: ['f1-2026'] }, TODAY), 0);
assert.equal(evUnseenCount(NEWS_EVENTS.news, all, { news: NEWS_EVENTS.news.map((item) => item.id) }, '2026-10-01'), 0, 'F1 is more than 30 days away');
assert.equal(evUnseenCount(NEWS_EVENTS.news, all, { news: 'broken' }, TODAY), NEWS_EVENTS.news.length + 1, 'bad stored data is ignored');

// 9. Formatting.
assert.equal(evDateRange('2026-12-03', '2026-12-06'), '3–6 Dec 2026');
assert.equal(evDateRange('2027-04-24', '2027-05-03'), '24 Apr – 3 May 2027');
assert.equal(evDateRange('2026-12-30', '2027-01-02'), '30 Dec 2026 – 2 Jan 2027');
assert.equal(evDateRange('2026-12-03', '2026-12-06', 'ar'), '3–6 ديسمبر 2026');
assert.equal(evDate('2026-06-09'), '9 June 2026');
assert.equal(evDate('2026-06-09', 'ar'), '9 يونيو 2026');
assert.equal(evSignedNumber(-1234.4), '−1,234');
assert.equal(evSignedPercent(0.1234), '+12.3%');
assert.equal(evSignedPercent(-0.003), '−0.3%');
assert.match(evIsoDay(new Date(2026, 0, 5)), /^2026-01-05$/);

// 10. The assistant: events, forecasts, past editions and news.
const names = Object.fromEntries(data.routes.map((route) => [route.originKey, route.origin]));
const events = evChatData(NEWS_EVENTS, EVENT_EVIDENCE, TODAY, (key) => names[key] || key, data.routes.map((route) => route.origin));
const ask = (text) => pcEventsReply(text.toLowerCase(), events);
const upcomingReply = ask('What events are coming up?');
assert.ok(upcomingReply.startsWith('Upcoming events in Abu Dhabi:\n- Formula 1 Abu Dhabi Grand Prix — 3–6 Dec 2026\n- IDEX and NAVDEX — 21–25 Jan 2027\n- Abu Dhabi International Book Fair — 24 Apr – 3 May 2027\nNext edition of ADIPEC: dates not announced yet.'), upcomingReply);
assert.equal(ask('what events are in December?'), 'Upcoming events in December:\n- Formula 1 Abu Dhabi Grand Prix — 3–6 Dec 2026\nAsk about one of them, such as “What is the forecast for F1?”, or open News and events in the shortcuts.');
assert.equal(ask('any events in March?'), 'No upcoming events with announced dates are in the list for March.');
const f1 = summaries.f1.forecast;
const f1Reply = ask('What is the forecast for F1?');
assert.ok(f1Reply.startsWith(`Next edition of Formula 1 Abu Dhabi Grand Prix: 3–6 Dec 2026.\nAbout ${(Math.round(f1.perNight.mid / 10) * 10).toLocaleString('en-US')} more international hotel guests each night\nAbout ${(Math.round(f1.extraNights.mid / 100) * 100).toLocaleString('en-US')} extra guest nights over 4 nights.`), f1Reply);
assert.ok(f1Reply.includes('Based on 3 past editions: 2022, 2023, 2024.'));
assert.ok(f1Reply.endsWith('Use Apply to plan on the event in News and events to add it to your plan.'));
assert.equal(ask('How many tourists will come for the Grand Prix?'), f1Reply);
assert.ok(!ask('IDEX forecast').includes('Apply to plan'), 'no apply hint when the change is under 1%');
assert.ok(ask('How did F1 affect hotels last year?').startsWith('Measured past editions of Formula 1 Abu Dhabi Grand Prix:\n- 2022: +40.4% international guest nights on event nights'));
assert.ok(ask('How did F1 affect hotels last year?').includes('- 2025: not measured'));
assert.ok(ask('what about ADIPEC?').startsWith('Next edition of ADIPEC: dates not announced yet.\nUsual effect: '));
assert.ok(ask('any news about India?').startsWith('Latest news about India:\n- Abu Dhabi tourism surges to record high as Indian visitor numbers jump — Khaleej Times, 6 April 2026\n'));
assert.ok(ask('news about flights').startsWith('Latest news about Flights:'));
assert.ok(ask('news about F1').startsWith('Latest news about Formula 1 Abu Dhabi Grand Prix:'));
assert.equal(ask('news about Germany'), 'I found no news about Germany in the team’s list.');
assert.ok(ask('Any news?').startsWith('Latest news:\n'));
for (const text of ['What is the event uplift?', 'Where is the event control?', 'How were hotel nights calculated?', 'What should I check next?', 'Set extra flights to 5']) {
  assert.equal(ask(text), null, text);
}
// Through the full reply chain: events answer, plan commands still apply.
const route = data.routes.find((row) => row.originKey === 'INDIA' && row.month === 12);
const bridge = getBridge(data, 'INDIA', 12);
const inputs = { originKey: 'INDIA', month: 12, extraFlights: 3, seatsPerFlight: route.seatsPerFlight, loadFactor: Math.min(1, route.loadFactor), p2pShare: route.p2pShare,
  conversionRate: data.defaults.captureRate, averageStay: bridge.reduce((sum, row) => sum + row.weight * row.averageStay, 0), eventUplift: 0 };
const result = runScenario(data, inputs);
const chain = (text) => planningChatReply(data, text, inputs, result, null, { where: { view: 'scenarioView', mode: 'focus' }, events });
assert.equal(chain('What is the forecast for F1?').text, f1Reply);
assert.equal(chain('Set event uplift to 10%').type, 'apply');
assert.ok(!chain('What is the event uplift?').text.startsWith('Upcoming'));

// 11. Arabic questions map onto the same answers.
const ar = (text) => arabicPromptToEnglish(data, text);
assert.equal(ar('ما الفعاليات القادمة؟'), 'What events are coming up?');
assert.equal(ar('ما الفعاليات في ديسمبر؟'), 'What events are coming up in December?');
assert.equal(ar('ما توقع الفورمولا 1؟'), 'What is the forecast for F1?');
assert.equal(ar('كيف أثرت الفورمولا 1 على الفنادق العام الماضي؟'), 'How did F1 affect hotels last year?');
assert.equal(ar('توقع معرض الكتاب'), 'What is the forecast for the book fair?');
assert.equal(ar('كم زائرًا سيأتي إلى أديبك؟'), 'What is the forecast for ADIPEC?');
assert.equal(ar('أخبار عن الهند'), 'Any news about India?');
assert.equal(ar('أخبار الطيران'), 'Any news about flights?');
assert.equal(ar('أين الفعاليات القادمة؟'), 'Where are the upcoming events?');
assert.equal(ar('ما هي الفعالية في الخطة؟'), 'What is the event or season control?', 'the plan control keeps its answer');
for (const text of ['ما الفعاليات القادمة؟', 'ما توقع الفورمولا 1؟', 'كيف أثرت الفورمولا 1 على الفنادق العام الماضي؟', 'أخبار عن الهند', 'أين الفعاليات القادمة؟']) {
  assert.ok(ask(ar(text)), text);
}

// 12. Exercise the actual News click handler. Applying an event changes only its
// month/uplift; edited assumptions, visitor mix and imported provenance survive.
const locations = JSON.parse(fs.readFileSync(new URL('../prototype/data/country_locations.json', import.meta.url)));
const appSource = fs.readFileSync(new URL('../prototype/app.mjs', import.meta.url), 'utf8')
  .replace(/^\s*import[^;]+;/gm, '').replace(/\binit\(\);\s*$/, '');
const nodes = new Map();
function testNode() {
  let value = '';
  return { get value() { return value; }, set value(next) { value = String(next); },
    hidden: true, checked: false, dataset: {}, textContent: '', innerHTML: '', handlers: new Map(),
    addEventListener(type, handler) { this.handlers.set(type, handler); }, querySelectorAll() { return []; },
    querySelector() { return null; }, click() {},
  };
}
const ctx = vm.createContext({ ...engine, ...decisions, ...routes, ...eventForecast, NEWS_EVENTS, EVENT_EVIDENCE,
  inputData: data, inputLocations: locations, setTimeout: () => 0, clearTimeout() {},
  localStorage: { getItem() { return null; }, setItem() {} },
  document: { addEventListener() {}, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, testNode()); return nodes.get(selector); } },
});
vm.runInContext(appSource + '\ndata=inputData;countryLocationLookup=buildCountryLocationLookup(inputLocations);newsToday=()=>"2026-11-11";renderAll=()=>{};setupNewsEvents();', ctx);
const applyClick = () => nodes.get('#newsView').handlers.get('click')({ target: { closest: selector => selector === '[data-news-apply]' ? { dataset: { newsApply: 'f1-2026' } } : null } });
const readState = () => JSON.parse(vm.runInContext('JSON.stringify(state)', ctx));
const preservedKeys = ['originKey', 'extraFlights', 'seatsPerFlight', 'loadFactor', 'p2pShare', 'conversionRate', 'averageStay', 'routePurpose', 'purposeAssumptionsApplied', 'seasonalConversion', 'importedSource', 'bridgeOverride'];
for (const origin of ['INDIA', 'GREECE']) {
  ctx.origin = origin;
  vm.runInContext('state=defaultState(origin,6,origin==="GREECE"?"__PEERS__":"");Object.assign(state,{extraFlights:8,seatsPerFlight:321.123456789,loadFactor:.8123456789,p2pShare:.42,conversionRate:.333333333,averageStay:6.4321,routePurpose:"holiday",purposeAssumptionsApplied:true,seasonalConversion:true,importedSource:{filename:"reviewed-plan.xlsx",location:"Assumptions, row 4"}});bridgeOverride=(state.peerProfile?.bridge||getBridge(data,state.originKey,6)).map((row,index)=>({...row,weight:index===0?1:0}));state.bridgeOverride=bridgeOverride;confirmedNewMarketKey=origin==="GREECE"?origin:"";', ctx);
  const before = readState();
  applyClick();
  const applied = readState();
  assert.equal(applied.month, 12, origin);
  assert.equal(applied.eventUplift, Math.round(summaries.f1.forecast.uplift * 100) / 100);
  for (const key of preservedKeys) assert.deepEqual(applied[key], before[key], `${origin}: preserve ${key}`);
  assert.equal(nodes.get('#month').value, '12');
  assert.equal(nodes.get('#extraFlights').value, '8');
  assert.equal(nodes.get('#seatsPerFlight').dataset.exact, '321.123456789');
  if (origin === 'GREECE') {
    assert.equal(applied.peerProfile.month, 12, 'Refresh month-specific comparison references without replacing user inputs');
    assert.equal(applied.proxyOriginKey, applied.peerProfile.primaryPeerOriginKey);
  }
  assert.equal(applied.eventSource.editionId, 'f1-2026');
  assert.equal(applied.eventSource.source, summaries.f1.upcoming.source);
  assert.deepEqual(applied.eventSource.years, ['2022', '2023', '2024']);
  const reportNotes = vm.runInContext('buildPlanReport(state,"","").notes.join("\\n")', ctx);
  assert.match(reportNotes, /reviewed-plan\.xlsx/);
  assert.match(reportNotes, /Event assumption: Formula 1 Abu Dhabi Grand Prix/);
  assert.ok(reportNotes.includes(summaries.f1.upcoming.source));
  assert.ok(!vm.runInContext('buildPlanReport({...state,eventUplift:.1},"","").notes.join("\\n")', ctx).includes('Event assumption:'), 'Changed event assumptions must not claim the old evidence');
  applyClick();
  assert.deepEqual(readState(), applied, 'Reapplying the same event preserves the plan');
}
const unchanged = vm.runInContext('JSON.stringify(state)', ctx);
nodes.get('#inputError').hidden = false;
applyClick();
assert.equal(vm.runInContext('JSON.stringify(state)', ctx), unchanged, 'A highlighted invalid input blocks the News action');
nodes.get('#inputError').hidden = true;
ctx.invalidSummary = { ...summaries.f1, forecast: { ...summaries.f1.forecast, planMonth: 13 } };
assert.throws(() => vm.runInContext('applyNewsEventPlan(invalidSummary)', ctx));
assert.equal(vm.runInContext('JSON.stringify(state)', ctx), unchanged, 'An invalid forecast cannot partially replace the plan');

// Explicit chat month changes intentionally keep their original default-reset behavior.
vm.runInContext('state=defaultState("INDIA",6);state.extraFlights=8;state.averageStay=6.4321;bridgeOverride=null;applyAssistantPlan({inputs:{...state,month:1},changes:{month:1},understood:true});', ctx);
assert.equal(readState().extraFlights, vm.runInContext('defaultState("INDIA",1).extraFlights', ctx));
assert.equal(readState().averageStay, vm.runInContext('defaultState("INDIA",1).averageStay', ctx));
console.log('news and events tests passed: forecast evidence, bilingual replies, News application preserves reviewed inputs and provenance, and chat month behavior is unchanged');
