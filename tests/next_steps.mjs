import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getBridge, runScenario } from '../prototype/engine.mjs';
import { nextStepPlan, nextStepLines, decisionNote, planningMetrics } from '../prototype/decision_tools.mjs';
import { planningChatReply, arabicPromptToEnglish, pcMessagesQuery, pcMessagesReply, pcFixTypos } from '../prototype/planning_chat.mjs';
import { priorityActions } from '../prototype/proposal_workspace.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const routeOf = (key, month) => data.routes.find((route) => route.originKey === key && route.month === month);
const inputsFor = (route, extra = {}) => {
  const bridge = getBridge(data, route.originKey, route.month);
  return { originKey: route.originKey, month: route.month, extraFlights: 3, seatsPerFlight: route.seatsPerFlight,
    loadFactor: Math.min(1, route.loadFactor), p2pShare: route.p2pShare, conversionRate: data.defaults.captureRate,
    averageStay: bridge.reduce((sum, row) => sum + row.weight * row.averageStay, 0), eventUplift: 0, ...extra };
};
const close = (a, b, message) => assert.ok(Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9), `${message}: ${a} vs ${b}`);

// 1. Known route with several records: hotel use (one app-wide rate) comes first.
const india = routeOf('INDIA', 12);
const base = inputsFor(india);
const result = runScenario(data, base);
const plan = nextStepPlan(data, base, result, { starting: base });
assert.deepEqual(plan.order, ['hotels', 'demand', 'visitors']);
assert.equal(plan.checks.hotels.lead.key, 'conversionRate');
assert.equal(plan.checks.hotels.lead.evidence, 'appWide');
assert.equal(plan.checks.demand.lead.evidence, 'routeRecords');
assert.deepEqual(plan.readiness, { verified: 0, total: 3 });
assert.deepEqual(plan.steps.map((step) => step.id), ['hotels', 'demand', 'visitors']);
// The same 10% error moves the added nights by exactly 10%: the chain is multiplicative.
const added = planningMetrics(data, base).incremental.guestNights;
close(plan.checks.hotels.lead.impact.before, added, 'impact basis is the added nights');
close(plan.checks.hotels.lead.impact.after, added * 0.9, 'hotel use 10% lower');
close(plan.checks.demand.assumptions[0].impact.after, added * 0.9, 'flight fullness 10% lower');
const lines = nextStepLines(plan.steps[0], result);
assert.equal(lines.title, 'Check hotel use and capacity');
assert.equal(lines.why, `Share checking into a hotel: ${(data.defaults.captureRate * 100).toFixed(1)}%, one app-wide rate, not measured for this route.`);
assert.ok(lines.impact.startsWith('If it is 10% lower ('), lines.impact);
assert.ok(lines.impact.includes(`instead of ${Math.round(added).toLocaleString('en-US')}.`), lines.impact);
assert.equal(lines.ask, 'Ask: Hotel or tourism team.');
assert.equal(nextStepLines(plan.checks.visitors, result).why, 'The visitor mix is an estimated split by nationality: it changes who is expected, not the total.');
assert.equal(nextStepLines(plan.checks.visitors, result).impact, '');

// 2. A value the planner typed in comes before evidence-backed values.
const edited = { ...base, loadFactor: 0.8 };
const editedPlan = nextStepPlan(data, edited, runScenario(data, edited), { starting: base });
assert.equal(editedPlan.order[0], 'demand');
assert.equal(editedPlan.checks.demand.lead.key, 'loadFactor');
assert.ok(nextStepLines(editedPlan.checks.demand, runScenario(data, edited)).why.endsWith('a value you entered, so record where it came from.'));
// Typing back the displayed starting value is not a new value.
const retyped = { ...base, loadFactor: Number((base.loadFactor * 100).toFixed(1)) / 100 };
assert.notEqual(retyped.loadFactor, base.loadFactor);
assert.equal(nextStepPlan(data, retyped, runScenario(data, retyped), { starting: base }).checks.demand.lead.evidence, 'routeRecords');
// The training-season hotel rate is still one rate for all routes, not the user's value.
const seasonal = { ...base, conversionRate: 0.38, seasonalConversion: true };
assert.equal(nextStepPlan(data, seasonal, runScenario(data, seasonal), { starting: base }).checks.hotels.lead.evidence, 'appWide');

// 3. An event increase is a pure assumption, so it is checked first.
const event = { ...base, eventUplift: 0.2 };
const eventPlan = nextStepPlan(data, event, runScenario(data, event), { starting: base });
assert.deepEqual(eventPlan.order, ['event', 'hotels', 'demand', 'visitors']);
assert.deepEqual(eventPlan.steps.map((step) => step.id), ['event', 'hotels', 'demand']);
assert.equal(eventPlan.readiness.total, 4);

// 4. Follow-ups statuses: verified checks drop out, overdue ones jump to the front.
const statusPlan = nextStepPlan(data, base, result, { starting: base, statuses: { hotels: 'green', demand: 'amber', visitors: 'red' } });
assert.deepEqual(statusPlan.steps.map((step) => step.id), ['visitors', 'demand']);
assert.deepEqual(statusPlan.readiness, { verified: 1, total: 3 });
assert.equal(nextStepLines(statusPlan.steps[0], result).overdue, 'This check is overdue.');
assert.equal(nextStepLines(statusPlan.steps[1], result).overdue, '');
assert.ok(decisionNote(data, base, [], statusPlan).text.includes('First check: Check who is travelling.\nThis check is overdue.\n'));
const done = nextStepPlan(data, base, result, { starting: base, statuses: { hotels: 'green', demand: 'green', visitors: 'green' } });
assert.deepEqual(done.steps, []);
assert.deepEqual(done.readiness, { verified: 3, total: 3 });

// 5. New route: flight assumptions are borrowed from comparison countries.
const newRoute = { ...result, route: { ...result.route, knownMarket: false } };
const newPlan = nextStepPlan(data, base, newRoute, { starting: base });
assert.equal(newPlan.order[0], 'demand');
assert.equal(newPlan.checks.demand.lead.evidence, 'borrowed');
assert.equal(newPlan.checks.hotels.lead.evidence, 'borrowed');
assert.ok(nextStepLines(newPlan.checks.demand, newRoute).why.endsWith('borrowed from comparison countries because this route has no flight history.'));

// 6. Few records: singular and plural sentences.
const oneRecord = { ...result, route: { ...result.route, yearsObserved: 1 } };
const twoRecords = { ...result, route: { ...result.route, yearsObserved: 2 } };
assert.ok(nextStepLines(nextStepPlan(data, base, oneRecord, { starting: base }).checks.demand, oneRecord).why.endsWith('from only 1 past flight record for this route and month.'));
assert.ok(nextStepLines(nextStepPlan(data, base, twoRecords, { starting: base }).checks.demand, twoRecords).why.endsWith('from only two past flight records for this route and month.'));

// 7. No added flights: the impact is measured on the plan total; values at the floor say so.
const none = { ...base, extraFlights: 0 };
const nonePlan = nextStepPlan(data, none, runScenario(data, none), { starting: none });
assert.equal(nonePlan.checks.hotels.lead.impact.basis, 'total');
assert.ok(nextStepLines(nonePlan.checks.hotels, runScenario(data, none)).impact.includes('the plan gives about'));
const floor = { ...base, loadFactor: 0.3, p2pShare: 0.05 };
const floorPlan = nextStepPlan(data, floor, runScenario(data, floor), { starting: base });
assert.equal(floorPlan.checks.demand.lead.impact.atMinimum, true);
assert.equal(nextStepLines(floorPlan.checks.demand, runScenario(data, floor)).impact, 'It is already at the lowest value the planner allows.');
// Every route and month produces a valid plan and finite impacts.
for (const route of data.routes) {
  const inputs = inputsFor(route);
  const routePlan = nextStepPlan(data, inputs, runScenario(data, inputs), { starting: inputs });
  assert.equal(routePlan.order.length, 3);
  for (const check of Object.values(routePlan.checks)) for (const assumption of check.assumptions) {
    assert.ok(Number.isFinite(assumption.impact.after) && Number.isFinite(assumption.impact.before), route.origin + ' ' + route.month);
  }
}

// 8. The decision note names the same first check when given the plan, and is unchanged otherwise.
const plainNote = decisionNote(data, base);
assert.ok(plainNote.text.includes(plainNote.workplaceDecision.priorityCheck));
const sharedNote = decisionNote(data, base, [], plan);
assert.ok(sharedNote.text.includes('First check: Check hotel use and capacity.'));
assert.ok(sharedNote.text.includes(lines.why));
assert.ok(!sharedNote.text.includes(plainNote.workplaceDecision.priorityCheck));
assert.equal(sharedNote.workplaceDecision.firstCheck.id, 'hotels');
assert.ok(decisionNote(data, base, [], done).text.includes('All checks have recorded evidence for these exact assumptions.'));

// 9. Follow-ups "Start here" follows the shared order; overdue work still comes first.
const context = { inputs: base, result, decision: plainNote, nextStepOrder: plan.order, nextStepReasons: { hotels: 'Shared reason.' } };
const empty = { versions: [], comments: [], tasks: [], decisions: [], discussions: [] };
assert.equal(priorityActions(context, empty).recommended.id, 'hotels');
assert.equal(priorityActions(context, empty).recommended.why, 'Shared reason.');
const overdueProposal = { ...empty, tasks: [{ id: 't1', check: 'demand', title: 'Ask airline', owner: 'Airline', dueDate: '2000-01-01', status: 'open', evidence: '', updates: [] }] };
assert.equal(priorityActions(context, overdueProposal).recommended.id, 'demand');
assert.equal(priorityActions(context, overdueProposal).recommended.why, 'Start here because this check is overdue.');

// 10. The assistant: next steps, missing checks, this page and charts.
const stepsOf = (p) => p.steps.map((step) => ({ id: step.id, draft: step.draft, ...nextStepLines(step, result), status: step.status }));
const steps = stepsOf(plan);
const extras = (where = { view: 'scenarioView', mode: 'focus' }, extra = {}) => ({
  nextSteps: { readiness: plan.readiness, steps },
  missing: { checks: [{ id: 'demand', title: 'Confirm the flight demand', status: 'amber' }, { id: 'hotels', title: 'Check hotel use and capacity', status: 'red' }, { id: 'visitors', title: 'Check who is travelling', status: 'green' }], decisionLogged: false, total: 3 },
  where, ...extra });
const ask = (text, where, extra) => planningChatReply(data, text, base, result, null, extras(where, extra)).text;
for (const question of ['What is the next step?', 'What should I check next?', 'what do I do now', 'what comes next after this?']) {
  const reply = ask(question);
  assert.ok(reply.startsWith('Decision readiness: 0 of 3 checks have recorded evidence.'), question + ' => ' + reply.slice(0, 80));
  assert.ok(reply.includes('Step 1: Check hotel use and capacity.'), question);
}
const overdueReply = planningChatReply(data, 'What is the next step?', base, result, null, { ...extras(), nextSteps: { readiness: statusPlan.readiness, steps: stepsOf(statusPlan) } }).text;
assert.ok(overdueReply.startsWith('Decision readiness: 1 of 3 checks have recorded evidence.'), overdueReply);
assert.ok(overdueReply.includes('Step 1: Check who is travelling.\nThis check is overdue.\n'), overdueReply);
assert.ok(overdueReply.includes('Step 2: Confirm the flight demand.\nHow full flights are:'), overdueReply);
assert.ok(!overdueReply.includes('Check hotel use and capacity'), 'verified checks are not listed');
const missingReply = ask('What steps am I missing?');
assert.ok(missingReply.startsWith('You still have 2 of 3 checks without recorded evidence:'), missingReply);
assert.ok(missingReply.includes('- Confirm the flight demand · no recorded evidence yet'));
assert.ok(missingReply.includes('- Check hotel use and capacity · overdue'));
assert.ok(!missingReply.includes('Check who is travelling'));
assert.ok(missingReply.includes('No planning decision is logged yet'));
const allDone = { checks: [{ id: 'demand', title: 'Confirm the flight demand', status: 'green' }], decisionLogged: true, total: 1 };
assert.equal(ask('what am I missing', undefined, { missing: allDone }), 'Nothing is missing: every check has recorded evidence for these exact assumptions, and a decision is logged.');
assert.ok(ask('Explain the charts', { view: 'scenarioView', mode: 'details' }).startsWith('Here is what the charts on Details show:'));
assert.ok(ask('explain the graphs in statistics').startsWith('Here is what the charts on Statistics show:'));
assert.ok(ask('How does this page work?', { view: 'bridgeView' }).startsWith('Visitor mix estimates'));
assert.ok(ask('how does this work', { view: 'scenarioView', mode: 'decisions' }).startsWith('Compare helps you decide'));
assert.ok(ask('what am I looking at', { view: 'validationView' }).startsWith('Check past results shows'));
assert.ok(ask('what am I looking at').startsWith('Here is your current result'), 'Focus keeps the result summary');
// Earlier answers keep working, and plan changes are not taken over.
assert.ok(ask('How were hotel nights calculated?').startsWith('Hotel nights are estimated'));
assert.equal(planningChatReply(data, 'Set extra flights to 5', base, result, null, extras()).type, 'apply');
assert.ok(ask('What else can you do?') !== missingReply, '"what else can you do" is not a missing-steps question');

// 11. Messages and requests.
const team = {
  messages: [
    { folder: 'inbox', subject: 'December room availability: we need your forecast', subjectAr: 'توفر الغرف في ديسمبر: نحتاج إلى توقعاتك', from: 'Hotel partnerships', fromAr: 'شراكات الفنادق', to: 'You', toAr: 'أنت', unread: true, body: 'Several hotels are planning December room blocks.' },
    { folder: 'inbox', subject: 'Load factor for the new frequencies', subjectAr: 'نسبة الإشغال للرحلات الجديدة', from: 'Airline route planning', fromAr: 'تخطيط مسارات الطيران', to: 'You', toAr: 'أنت', unread: false, body: 'Early booking data.' },
    { folder: 'sent', subject: 'Forecast for hotels', subjectAr: 'Forecast for hotels', from: 'Planning team', fromAr: 'فريق التخطيط', to: 'Hotel partnerships', toAr: 'شراكات الفنادق', unread: false, body: '' },
    { folder: 'drafts', subject: 'Untitled draft', subjectAr: 'Untitled draft', from: 'Planning team', fromAr: 'فريق التخطيط', to: 'No recipient yet', toAr: 'No recipient yet', unread: false, body: 'Notes for the airline' },
  ],
  requests: [{ title: 'Sign off the hotel capacity check for December', titleAr: 'اعتماد التحقق من السعة الفندقية لشهر ديسمبر', from: 'Hotel partnerships', fromAr: 'شراكات الفنادق', recipient: 'Tourism strategy lead', status: 'Waiting' }],
};
const findMessage = (text) => { const query = pcMessagesQuery(text); assert.ok(query, text); return pcMessagesReply(query, team); };
assert.equal(findMessage('Where is the message about room availability?'), 'The message “December room availability: we need your forecast” from Hotel partnerships is in Inbox.\nIt is unread.\nOpen Messages in the side shortcuts, choose Inbox, then select it.');
assert.ok(findMessage('where is the email from Airline route planning').startsWith('The message “Load factor for the new frequencies” from Airline route planning is in Inbox.'));
assert.ok(findMessage('where is the message I sent about the forecast for hotels').startsWith('The message “Forecast for hotels” to Hotel partnerships is in Sent.'));
assert.ok(findMessage('find my draft notes for the airline').startsWith('Your draft “Untitled draft” is in Drafts.'));
assert.ok(findMessage('where are my drafts?').startsWith('Drafts is in Messages in the side shortcuts (messages: 1).\nOpen Messages in the side shortcuts to see them.'));
assert.ok(findMessage('how many unread messages do I have?').startsWith('Messages: Inbox 2 (1 unread), Sent 1, Drafts 1.'));
assert.equal(findMessage('how many requests are waiting?'), 'Approval requests are in Tasks, in the shortcuts on the right edge.\nRequests: 1, waiting: 1.');
assert.ok(findMessage('أين المسودات؟').startsWith('Drafts is in Messages in the side shortcuts (messages: 1).'));
assert.ok(findMessage('أين الرسائل المرسلة؟').startsWith('Sent is in Messages in the side shortcuts (messages: 1).'));
assert.ok(findMessage('أين صندوق الوارد؟').startsWith('Inbox is in Messages in the side shortcuts (messages: 2).'));
assert.equal(findMessage('كم عدد الطلبات قيد الانتظار؟'), 'Approval requests are in Tasks, in the shortcuts on the right edge.\nRequests: 1, waiting: 1.');
assert.ok(findMessage('where is the message about camels?').startsWith('I couldn’t find a message that matches those words.'));
assert.ok(findMessage('where is the approval request about hotel capacity?').startsWith('The request “Sign off the hotel capacity check for December” from Hotel partnerships is in Tasks, marked Waiting.'));
assert.ok(findMessage('أين الرسالة عن توفر الغرف؟').startsWith('The message “December room availability: we need your forecast”'), 'Arabic search uses the Arabic subject');
assert.ok(findMessage('كم عدد الرسائل غير المقروءة؟').startsWith('Messages: Inbox 2 (1 unread)'));
// Not message questions.
for (const text of ['What does Messages do?', 'How do I draft an email to hotels?', 'where am I', 'How many flights for 10,000 more nights?', 'Set extra flights to 5']) {
  assert.equal(pcMessagesQuery(text), null, text);
}
assert.ok(pcMessagesReply({ arabic: false, requests: false, folder: null, count: true, unread: false, terms: [] }, null).startsWith('Messages: Inbox 0 (0 unread), Sent 0, Drafts 0.'), 'missing team data is handled');

// 12. Arabic phrasings map onto the same answers.
const ar = (text) => arabicPromptToEnglish(data, text);
assert.equal(ar('ما الخطوة التالية؟'), 'What is the next step?');
assert.equal(ar('ما الذي ينقصني؟'), 'What steps am I missing?');
assert.equal(ar('اشرح الرسوم البيانية في الإحصاءات'), 'Explain the charts in Statistics');
assert.equal(ar('اشرح الرسوم البيانية'), 'Explain the charts');
assert.equal(ar('كيف تعمل هذه الصفحة؟'), 'How does this page work?');
assert.ok(ask(ar('ما الخطوة التالية؟')).startsWith('Decision readiness:'));

// 13. What-if: worked out on the open plan, never applied.
const plain = (text) => planningChatReply(data, text, base, result, null, { where: { view: 'scenarioView', mode: 'focus' } });
const whatIf = (text) => { const reply = plain(text); assert.equal(reply.type, 'answer', text); return reply.text; };
const fmt = (value) => Math.round(value).toLocaleString('en-US');
const plusTwo = { ...base, extraFlights: base.extraFlights + 2 };
const expectedPlusTwo = ['Here is how this change would affect your plan, without applying it:',
  `- Extra flights each week: 3 → 5`,
  `- Extra hotel check-ins: ${fmt(planningMetrics(data, base).incremental.hotelCheckins)} → ${fmt(planningMetrics(data, plusTwo).incremental.hotelCheckins)}`,
  `- Extra guest nights: ${fmt(planningMetrics(data, base).incremental.guestNights)} → ${fmt(planningMetrics(data, plusTwo).incremental.guestNights)}`,
  `- Total guest nights: ${fmt(result.scenario.guestNights)} → ${fmt(runScenario(data, plusTwo).scenario.guestNights)}`, '',
  `That is about ${fmt(runScenario(data, plusTwo).scenario.guestNights - result.scenario.guestNights)} more guest nights than your plan.`,
  'Your plan has not changed; to apply it, say “Set extra flights to 5”.'].join('\n');
for (const question of ['can you explain what will happen if the flight from India increases by 2 more flights', 'What if I add 2 flights?', 'what if we add another 2 flights', 'What would happen if flights increase by 2?']) {
  assert.equal(whatIf(question), expectedPlusTwo, question);
}
assert.ok(whatIf('what if there are 2 fewer flights').includes('- Extra flights each week: 3 → 1\n'));
assert.ok(whatIf('what if there are 2 fewer flights').includes('fewer guest nights than your plan.'));
assert.ok(whatIf('what if flight occupancy is 70%?').includes(`- How full flights are: ${(base.loadFactor * 100).toFixed(1)}% → 70.0%\n`));
assert.ok(whatIf('what if flight occupancy is 70%?').endsWith('say “Set flight occupancy to 70%”.'));
assert.ok(whatIf('what if hotel use is 40%').includes('- Share checking into a hotel: 42.0% → 40.0%\n'));
assert.ok(whatIf('What if average stay is 4 nights?').endsWith('say “Set average stay to 4 nights”.'));
assert.equal(whatIf('what if we add 30 more flights'), 'Extra flights must stay between −20 and 20 a week, so I can’t work that out.\nYour plan has not changed.');
assert.equal(whatIf('what if the flights come from France'), 'This what-if works on the plan you have open.\nSwitch the departure country to France first, then ask again.');
assert.equal(whatIf('What if load factor increases by 5%?'), 'Tell me the final value to try, such as “What if flight occupancy is 80%?”, and I will work it out without changing your plan.');
assert.equal(plain('Set extra flights to 5').type, 'apply', 'commands still apply');

// 14. Where things are, and where to write an email.
const draftReply = 'To draft an email, open Follow-ups, then open Draft email.\nChoose who it is for under Message for, then choose Prepare draft.\nFor hotel rooms or capacity, choose Hotel team.\nDraft email in the Next steps box on Focus opens the same form.';
assert.equal(whatIf('Where should I draft the email form to inquire about available hotel rooms?'), draftReply);
assert.equal(whatIf('How do I draft an email to hotels?'), draftReply);
assert.ok(whatIf('where can I write a message to the airline?').includes('For flights or bookings, choose Airline or airport planner.'));
const departure = 'You set “Departure country” under Adjust plan, in section 01 Market.\nAdjust plan is the button at the top left of Plan a route.';
assert.equal(whatIf('where is the country departure located'), departure);
assert.equal(whatIf('where is the country departure locsted'), departure);
assert.ok(whatIf('Where can I change the month?').startsWith('You set “Month” under Adjust plan, in section 01 Market.'));
assert.ok(whatIf('where is the hotel use setting?').startsWith('You set “Share checking into a hotel” under Adjust plan, in section 04 Hotel visitors.'));
assert.ok(whatIf('where are starting assumptions').includes('It appears when you choose + New route in Departure country.'));
assert.ok(whatIf('where is the export button').startsWith('Export is the button under Your current plan on Focus.'));
assert.equal(whatIf('where is log decision'), 'Log decision is in Follow-ups, further down the page.');
assert.equal(whatIf('where is the compare tab'), '“Compare” is a tab at the top of Plan a route.');
assert.equal(whatIf('where is the term guide?'), '“Term guide” is in the menu at the top of the page.');
assert.ok(whatIf('Where does the baseline come from?').startsWith('The baseline is an estimate'), 'not a place question');
assert.ok(!whatIf('where do I start?').startsWith('You set'), 'the overview still answers this');
// Writing a message is not a search; an existing draft still is.
for (const text of ['Where should I draft the email form to inquire about available hotel rooms?', 'How do I write an email to the airline?', 'أين أكتب بريدًا للفنادق؟']) assert.equal(pcMessagesQuery(text), null, text);
assert.ok(findMessage('where is the draft notes for the airline?').startsWith('Your draft “Untitled draft” is in Drafts.'));

// 15. Typing slips are corrected only for known words, and only in English.
assert.deepEqual(pcFixTypos(data, 'chsnge to india'), { text: 'change to india', fixes: [['chsnge', 'change']] });
assert.deepEqual(pcFixTypos(data, 'where is the country departure locsted').fixes, [['locsted', 'located']]);
assert.equal(pcFixTypos(data, 'Set extra flights to 5'), null);
assert.equal(pcFixTypos(data, 'Who is Affan'), null);
assert.equal(pcFixTypos(data, 'ما الخطوة التالية؟'), null);
assert.equal(pcFixTypos(data, 'add 2 flights from Inida').text, 'add 2 flights from india');

// 16. Arabic forms of the new questions.
assert.equal(ar('أين أكتب بريدًا للفنادق عن الغرف المتاحة؟'), 'Where do I draft an email about hotel rooms?');
assert.equal(ar('أين بلد المغادرة؟'), 'Where is the departure country?');
assert.equal(ar('أين زر التصدير؟'), 'Where is export?');
assert.equal(ar('أين تبويب المقارنة؟'), 'Where is Compare?');
assert.equal(ar('ماذا لو أضفنا رحلتين؟'), 'What if we add 2 more flights?');
assert.equal(ar('ماذا لو قللنا 3 رحلات؟'), 'What if there are 3 fewer flights?');
assert.equal(ar('ماذا لو كان الإشغال 70%؟'), 'What if flight occupancy is 70%?');
assert.equal(ar('ماذا لو كانت نسبة التسجيل في الفنادق 40%؟'), 'What if hotel use is 40%?');
assert.equal(ar('ماذا لو زاد الإشغال بنسبة 5%؟'), 'What if it changes by 5%?');
assert.ok(whatIf(ar('ماذا لو زاد الإشغال بنسبة 5%؟')).startsWith('Tell me the final value to try'));
for (const text of ['أين بلد المغادرة؟', 'ماذا لو أضفنا رحلتين؟', 'ماذا لو كان الإشغال 70%؟', 'ماذا لو كانت نسبة التسجيل في الفنادق 40%؟', 'أين أكتب بريدًا للفنادق؟']) {
  assert.ok(!whatIf(ar(text)).startsWith('Tell me the final value'), text);
}

// 17. Compare with an earlier result from this session.
const compareAsk = (text, history, now = base) => planningChatReply(data, text, now, runScenario(data, now), null, { where: { view: 'scenarioView', mode: 'focus' }, history }).text;
const fiveFlights = { ...base, extraFlights: 5 };
const history = { previous: base, first: base, count: 2 };
const expectedCompare = ['Compared with your previous result:',
  '- Extra flights each week: 3 → 5',
  `- Extra hotel check-ins: ${fmt(planningMetrics(data, base).incremental.hotelCheckins)} → ${fmt(planningMetrics(data, fiveFlights).incremental.hotelCheckins)}`,
  `- Extra guest nights: ${fmt(planningMetrics(data, base).incremental.guestNights)} → ${fmt(planningMetrics(data, fiveFlights).incremental.guestNights)}`,
  `- Total guest nights: ${fmt(result.scenario.guestNights)} → ${fmt(runScenario(data, fiveFlights).scenario.guestNights)}`, '',
  `That is about ${fmt(runScenario(data, fiveFlights).scenario.guestNights - result.scenario.guestNights)} more guest nights than the earlier result.`].join('\n');
for (const question of ['can you compare the current and the previous results', 'can you compare it now?', 'What changed?', 'compare with the previous result', 'How does this compare to before?']) {
  assert.equal(compareAsk(question, history, fiveFlights), expectedCompare, question);
}
assert.ok(compareAsk('compare with my first result', { previous: fiveFlights, first: base, count: 3 }, { ...base, extraFlights: 7 }).startsWith('Compared with your first result in this session:\n- Extra flights each week: 3 → 7\n'));
assert.ok(compareAsk('compare it with the previous one', { previous: fiveFlights, first: base, count: 3 }, { ...base, extraFlights: 7 }).endsWith('Ask “Compare with my first result” to compare with where you started.'));
assert.equal(compareAsk('What changed?', { previous: null, first: null, count: 1 }), 'There is no earlier result to compare with yet.\nChange the plan, then ask again; I compare with the result just before the change.');
const france = inputsFor(routeOf('FRANCE', 5));
const crossRoute = compareAsk('compare with the previous result', { previous: france, first: france, count: 2 });
assert.ok(crossRoute.startsWith('Compared with your previous result:\n- Departure country: France → India\n- Month: May → December\n'), crossRoute);
const lower = { ...fiveFlights, loadFactor: 0.7 };
assert.ok(compareAsk('what changed', { previous: fiveFlights, first: base, count: 3 }, lower).includes('fewer guest nights than the earlier result.'));
// Not compare questions: the Compare tab and route comparisons keep their answers.
for (const text of ['What does Compare do?', 'How does this page work?', 'Explain the charts in Compare']) {
  assert.ok(!compareAsk(text, history).startsWith('Compared with'), text);
}
assert.equal(ar('قارن بالنتيجة السابقة'), 'Compare with the previous result');
assert.equal(ar('هل يمكنك المقارنة الآن؟'), 'Compare with the previous result');
assert.equal(ar('قارن بنتيجتي الأولى'), 'Compare with my first result');
assert.equal(ar('ماذا تغير؟'), 'What changed?');
assert.equal(ar('ما الذي تغير؟'), 'What changed?');
assert.equal(ar('ما هي المقارنة؟'), 'What does Compare do?');

console.log('next steps tests passed');
