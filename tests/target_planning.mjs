import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getBridge, runScenario, parseScenarioPrompt } from '../prototype/engine.mjs';
import { reverseTargetPlan, planningMetrics, TARGET_FLIGHT_CONTROL_LIMIT } from '../prototype/decision_tools.mjs';
import { planningChatReply, arabicPromptToEnglish } from '../prototype/planning_chat.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const inputsFor = (route, extra = {}) => {
  const bridge = getBridge(data, route.originKey, route.month);
  return { originKey: route.originKey, month: route.month, extraFlights: 3,
    seatsPerFlight: Math.round(route.seatsPerFlight), loadFactor: Math.min(1, route.loadFactor),
    p2pShare: route.p2pShare, conversionRate: data.defaults.captureRate,
    averageStay: bridge.reduce((sum, row) => sum + row.weight * row.averageStay, 0), eventUplift: 0, ...extra };
};
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-9), `${message}: ${actual} vs ${expected}`);

// Every route: the backwards answer must agree with running the plan forwards.
let checked = 0;
for (const route of data.routes) {
  for (const eventUplift of [0, 0.2, 0.45]) {
    const inputs = inputsFor(route, { eventUplift });
    const original = JSON.stringify(inputs);
    const one = planningMetrics(data, { ...inputs, extraFlights: 1 }).incremental.guestNights;
    const target = one * 7.4;
    const answer = reverseTargetPlan(data, inputs, target);
    assert.equal(JSON.stringify(inputs), original, 'inputs are not mutated');
    close(answer.exactWeeklyFlights, 7.4, `${route.origin} ${route.month} exact flights`);
    assert.equal(answer.requiredWeeklyFlights, 8);
    // Rounded-up flights reach the target; one fewer does not.
    assert.ok(planningMetrics(data, { ...inputs, extraFlights: 8 }).incremental.guestNights >= target);
    assert.ok(planningMetrics(data, { ...inputs, extraFlights: 7 }).incremental.guestNights < target);
    // Each step of the chain matches the forward model at the exact flight count.
    const forward = planningMetrics(data, { ...inputs, extraFlights: 1 }).incremental;
    for (const key of ['hotelCheckins', 'p2p', 'passengers', 'seats']) close(answer.steps.find((step) => step.key === key).value, forward[key] * 7.4, `${key} step`);
    close(answer.steps[0].value, target, 'first step is the target');
    // A whole-flight target lands exactly, without rounding up an extra flight.
    assert.equal(reverseTargetPlan(data, inputs, one * 2).requiredWeeklyFlights, 2);
    assert.equal(reverseTargetPlan(data, inputs, 0).requiredWeeklyFlights, 0);
    // Total basis subtracts what the plan already gives with zero extra flights.
    const starting = runScenario(data, { ...inputs, extraFlights: 0 }).scenario.guestNights;
    const total = reverseTargetPlan(data, inputs, starting + one * 3, { basis: 'total' });
    close(total.neededNights, one * 3, 'total basis needed nights');
    assert.equal(total.requiredWeeklyFlights, 3);
    const below = reverseTargetPlan(data, inputs, starting * 0.5, { basis: 'total' });
    assert.equal(below.alreadyMet, true);
    assert.equal(below.requiredWeeklyFlights, 0);
    // Alternatives scale one assumption so the zero-flight plan meets the target.
    for (const lever of answer.alternatives.filter((item) => item.withinLimits)) {
      const altered = runScenario(data, { ...inputs, extraFlights: 0, [lever.key]: lever.to }).scenario.guestNights;
      close(altered, starting + target, `${lever.key} alternative`);
    }
    assert.equal(answer.withinControlLimit, answer.requiredWeeklyFlights <= TARGET_FLIGHT_CONTROL_LIMIT);
    checked++;
  }
}
assert.equal(checked, data.routes.length * 3);

// Realism compares against the route's usual weekly flights.
const india = data.routes.find((route) => route.originKey === 'INDIA' && route.month === 12);
const indiaAnswer = reverseTargetPlan(data, inputsFor(india), 10000);
assert.equal(indiaAnswer.requiredWeeklyFlights, 15);
assert.equal(indiaAnswer.realism.level, 'small');
const smallRoute = [...data.routes].sort((a, b) => a.weeklyFrequency - b.weeklyFrequency).find((route) => route.weeklyFrequency > 1);
const bigAsk = reverseTargetPlan(data, inputsFor(smallRoute), 1e6);
assert.equal(bigAsk.realism.level, 'very-large');
assert.equal(bigAsk.withinControlLimit, false);

for (const bad of [-1, NaN, Infinity, '500']) assert.throws(() => reverseTargetPlan(data, inputsFor(india), bad));
assert.throws(() => reverseTargetPlan(data, inputsFor(india), 100, { basis: 'rooms' }));

const current = inputsFor(india);
const result = runScenario(data, current);
const ask = (text) => planningChatReply(data, text, current, result);
assert.equal(ask('Add 5 flights from France in December').type, 'apply');
const removedTarget = ask('How many flights do we need for 10,000 more nights?');
assert.notEqual(removedTarget.parsed?.understood, true);
assert.doesNotMatch(removedTarget.text, /extra flights a week/);
assert.doesNotMatch(ask('Where is Target?').text, /is a tab at the top/);

// Arabic questions map to the English phrasing the local engine understands.
const ar = (text) => arabicPromptToEnglish(data, text);
assert.equal(ar('How were hotel nights calculated?'), 'How were hotel nights calculated?', 'English passes through');
assert.equal(ar('مرحباً'), 'Hello');
assert.equal(ar('شكراً'), 'Thanks');
assert.equal(ar('كيف حُسبت الليالي الفندقية؟'), 'How were hotel nights calculated?');
assert.equal(ar('اضبط الرحلات الإضافية على 5'), 'Set extra flights to 5');
assert.equal(ar('اضبط نسبة إشغال الرحلات على 80%'), 'Set flight occupancy to 80%');
assert.equal(ar('اضبط الإقامة الفندقية على 45% ومتوسط الإقامة على 4 ليال'), 'Set hotel use to 45% and average stay to 4 nights');
assert.equal(ar('أضف 4 رحلات من ألمانيا في يوليو'), 'Add 4 flights from Germany in July');
assert.equal(ar('ما الذي يجب أن أتحقق منه بعد ذلك؟'), 'What should I check next?');
assert.equal(ar('ما مدى دقة هذا؟'), 'How accurate is this?');
assert.equal(ar('أعد ضبط الخطة'), 'Reset the plan');
assert.equal(ar('احكِ لي نكتة'), 'احكِ لي نكتة', 'unknown Arabic is left as typed');
for (const text of ['اضبط الرحلات الإضافية على 5', 'أضف 4 رحلات من ألمانيا في يوليو']) {
  assert.notEqual(planningChatReply(data, ar(text), current, result).text.slice(0, 20), 'I didn’t catch a cha', text);
}

// Explicit plan changes work with polite phrasing.
assert.equal(ask('Set average stay to 4 nights').type, 'apply');
assert.equal(ask('Set hotel use to 45% and average stay to 4 nights').type, 'apply');
const polite = ask('I want to set flight occupancy to 80%');
assert.equal(polite.type, 'apply'); assert.equal(polite.parsed.inputs.loadFactor, 0.8);
assert.equal(ask('Please add 5 flights from France in December').type, 'apply');

// App guide and result summary.
assert.match(ask('What does Visitor mix do?').text, /^Visitor mix estimates/);
assert.match(ask('what does the vistio mix do').text, /^Visitor mix estimates/);
assert.match(ask('How do I navigate the app?').text, /The pages along the top:/);
assert.match(ask('What does Compare do?').text, /^Compare helps you decide/);
assert.match(ask('What are Follow-ups?').text, /^Follow-ups helps you check/);
assert.match(ask('How do I export my plan?').text, /^Export, on Plan a route/);
assert.match(ask('What does Check past results show?').text, /weighted error was 6\.56%/);
assert.match(ask('What is a guest night?').text, /^A guest night is one guest/);
assert.ok(ask('What does the possible range mean?').text.includes(Math.round(result.p10).toLocaleString('en-US')));
const summary = ask('Explain the result').text;
assert.match(summary, /^Here is your current result for India in December\./);
assert.ok(summary.includes(`Total guest nights: ${Math.round(result.scenario.guestNights).toLocaleString('en-US')}`), summary);
assert.equal(ask('can you explain the result').text, summary);
// Existing answers are not taken over by the guide.
assert.match(ask('How were hotel nights calculated?').text, /^Hotel nights are estimated hotel arrivals/);
assert.match(ask('How accurate is this?').text, /^The accuracy test checks/);
assert.match(ask('Where does the baseline come from?').text, /^The baseline is an estimate/);
assert.match(ask('What should I check next?').text, /^Check /);

// Abuse and odd input never crash and never change the plan silently.
assert.match(ask('x'.repeat(700)).text, /too long/);
for (const odd of ['<img src=x onerror=alert(1)>', '"; DROP TABLE plans; --', '{{constructor.constructor("alert(1)")()}}', '‮', '9'.repeat(400) + ' nights', 'nights '.repeat(80), '%%%% nights by %']) {
  const r = ask(odd);
  assert.ok(['answer', 'apply'].includes(r.type), odd);
  if (r.type === 'apply') assert.equal(r.parsed.understood, false, odd);
}

assert.match(ask('how do I use this app?').text, /^Air2Stay estimates/);
assert.match(ask('can I download a PDF report?').text, /^Export, on Plan a route/);
assert.match(ask('Explain how full the flights are').text, /^Flights are expected to be/);

// Arabic versions of the new questions.
assert.equal(ar('ما هو المسار الجديد؟'), 'How do I create a new route?');
assert.equal(ar('ماذا تفعل المتابعات؟'), 'What are Follow-ups?');
assert.equal(ar('ماذا تفعل؟'), 'What can you do?');
assert.equal(ar('اشرح النتيجة'), 'Explain the result');
assert.equal(ar('ماذا يفعل توزيع الزوار؟'), 'What does Visitor mix show?');
assert.equal(ar('ما معنى النطاق المحتمل؟'), 'What does the possible range mean?');
assert.equal(ar('كيف أستخدم التطبيق؟'), 'How do I navigate the app?');
assert.equal(ar('أريد ضبط الرحلات الإضافية على 5'), 'Set extra flights to 5');
assert.equal(ar('من فضلك أضف 4 رحلات من ألمانيا في يوليو'), 'Add 4 flights from Germany in July');

console.log(`target planning tests passed (${checked} route-month cases)`);
