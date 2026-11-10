import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { findRoute, getBridge, weeksInMonth, runScenario } from '../prototype/engine.mjs';

// Execute the actual display functions without starting the browser controller.
const source = fs.readFileSync(new URL('../prototype/app.mjs', import.meta.url), 'utf8')
  .replace(/^\s*import[^;]+;/gm, '').replace(/\binit\(\);\s*$/, '');
const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const nodes = new Map();
const context = vm.createContext({
  document: { querySelector(selector) {
    if (!nodes.has(selector)) nodes.set(selector, { innerHTML: '' });
    return nodes.get(selector);
  } },
  findRoute, getBridge, weeksInMonth, runScenario, inputData: data,
});
vm.runInContext(source + '\ndata = inputData;', context);

let cases = 0;
for (const route of data.routes) {
  const base = getBridge(data, route.originKey, route.month);
  const inputs = {
    originKey: route.originKey, month: route.month, extraFlights: 0,
    seatsPerFlight: Math.round(route.seatsPerFlight),
    loadFactor: Math.min(1, route.loadFactor), p2pShare: route.p2pShare,
    conversionRate: data.defaults.captureRate,
    averageStay: base.reduce((sum, row) => sum + row.weight * row.averageStay, 0),
    eventUplift: 0,
  };
  for (const extraFlights of [-3, 0, 3]) {
    context.inputs = { ...inputs, extraFlights, eventUplift: extraFlights === 3 ? 0.2 : 0 };
    context.result = runScenario(data, context.inputs);
    vm.runInContext('state = inputs; renderCalculationExplanation(result); renderSideBySideComparison(result);', context);
    const html = nodes.get('#calculationExplanation').innerHTML;
    for (const key of ['seats', 'passengers', 'p2p', 'hotelCheckins', 'guestNights']) {
      assert.ok(html.includes(`= ${context.result.scenario[key]}</span>`), `${route.originKey}: ${key}`);
    }
    assert.ok(html.includes('estimate based on past flight records'));
    assert.ok(!/undefined|NaN|Infinity/.test(html));
    cases++;
  }
}
context.inputs = { ...context.inputs, originKey: 'GREECE', proxyOriginKey: 'ITALY', extraFlights: 3 };
context.result = runScenario(data, context.inputs);
vm.runInContext('state = inputs; renderCalculationExplanation(result); renderSideBySideComparison(result); renderValidation();', context);
assert.match(nodes.get('#calculationExplanation').innerHTML, /ITALY supplies starting assumptions only/);
assert.match(nodes.get('#sideBySideComparison').innerHTML, /headline changes above compare the proposed route with zero/);
const sum = data.validation.reduce((s,r)=>s+Math.abs(r.actual-r.transparent),0);
assert.ok(nodes.get('#validationScope').innerHTML.includes(Math.round(sum).toLocaleString('en-US') + ' ÷ 1,550,679'));
const verifiedScores = nodes.get('#validationKpis').innerHTML;
assert.match(verifiedScores, /Live default chain: weighted error/);
const actual = data.validation.reduce((total, row) => total + row.actual, 0);
for (const field of ['transparent', 'seasonal', 'predicted']) {
  const errors = data.validation.reduce((total, row) => total + Math.abs(row.actual - row[field]), 0);
  assert.ok(verifiedScores.includes((100 * errors / actual).toFixed(2) + '%'), field);
}
const reportedScores = nodes.get('#validationModelComparison').innerHTML;
assert.match(reportedScores, /Reported scores without bundled records/);
for (const score of ['10.42%', '13.93%', '11.3%']) {
  assert.ok(reportedScores.includes(score));
  assert.ok(!verifiedScores.includes(score));
}
assert.match(nodes.get('#validationScope').innerHTML, /Seasonal comparison/);
assert.match(nodes.get('#validationScope').innerHTML, /does not test future flight schedules/);
console.log(`PASS: ${cases} live explanation renderings, new-route context, and reproducible validation scores.`);
