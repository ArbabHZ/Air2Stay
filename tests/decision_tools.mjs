import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getBridge, runScenario, weeksInMonth } from '../prototype/engine.mjs';
import {
  applyRoutePurpose, planningMetrics, compareOptions, compareMonths, launchOptions,
  stressTest, solveCapacityTarget, rankingReversals, decisionNote,
} from '../prototype/decision_tools.mjs';

const data = JSON.parse(fs.readFileSync(new URL('../prototype/data/scenario_data.json', import.meta.url)));
const inputsFor = (route) => {
  const bridge = getBridge(data, route.originKey, route.month);
  return { originKey: route.originKey, month: route.month, extraFlights: 3,
    seatsPerFlight: Math.round(route.seatsPerFlight), loadFactor: Math.min(1, route.loadFactor),
    p2pShare: route.p2pShare, conversionRate: data.defaults.captureRate,
    averageStay: bridge.reduce((sum, row) => sum + row.weight * row.averageStay, 0), eventUplift: 0 };
};
const approximately = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < Math.max(1e-7, Math.abs(expected) * 1e-10), message + ': ' + actual + ' vs ' + expected);

let routeCases = 0;
for (const route of data.routes) {
  const inputs = inputsFor(route);
  const original = JSON.stringify(inputs);
  const metrics = planningMetrics(data, inputs);
  const seats = inputs.extraFlights * inputs.seatsPerFlight * weeksInMonth(inputs.month);
  approximately(metrics.addedSeats, seats);
  approximately(metrics.incremental.guestNights, seats * inputs.loadFactor * inputs.p2pShare * inputs.conversionRate * inputs.averageStay);
  approximately(metrics.per1000AddedSeats, inputs.loadFactor * inputs.p2pShare * inputs.conversionRate * inputs.averageStay * 1000);
  assert.deepEqual(metrics.result.baseline, runScenario(data, inputs).baseline);
  const noFlights = planningMetrics(data, { ...inputs, extraFlights: 0, conversionRate: 0.1 });
  assert.equal(noFlights.incremental.guestNights, 0);
  assert.equal(noFlights.per1000AddedSeats, null);
  // Editing hotel use affects the historical comparison but cannot be counted
  // as a gain from adding flights when no flights were added.
  assert.ok(noFlights.historicalChange.guestNights < 0);
  const purpose = applyRoutePurpose(inputs, 'holiday');
  assert.deepEqual(runScenario(data, purpose), runScenario(data, inputs));
  const stress = stressTest(data, inputs);
  for (const trial of stress.trials) {
    assert.ok(trial.incremental.guestNights <= metrics.incremental.guestNights + 1e-7);
    assert.deepEqual(trial.result.baseline, metrics.result.baseline);
    assert.ok(trial.inputs.loadFactor >= 0.3 && trial.inputs.conversionRate >= 0.05 && trial.inputs.averageStay >= 1);
  }
  const one = planningMetrics(data, { ...inputs, extraFlights: 1 }).incremental.guestNights;
  assert.equal(solveCapacityTarget(data, inputs, one * 2).requiredWeeklyFlights, 2);
  assert.equal(solveCapacityTarget(data, inputs, one * 2 + one * 0.01).requiredWeeklyFlights, 3);
  assert.equal(solveCapacityTarget(data, inputs, 0).requiredWeeklyFlights, 0);
  const unmet = solveCapacityTarget(data, inputs, one * 21);
  assert.equal(unmet.met, false);
  assert.equal(unmet.requiredWeeklyFlights, null);
  assert.ok(unmet.shortfall > 0);
  assert.equal(JSON.stringify(inputs), original);
  routeCases++;
}

const inputs = inputsFor(data.routes.find((route) => route.originKey === 'INDIA' && route.month === 12));
const newRoute = { ...inputs, originKey: 'GREECE', proxyOriginKey: 'ITALY' };
const metrics = planningMetrics(data, newRoute);
assert.equal(metrics.result.baseline.guestNights, 0);
approximately(metrics.incremental.guestNights, metrics.result.delta.guestNights);
assert.ok(metrics.addedSeats > 0);
const negative = planningMetrics(data, { ...inputs, extraFlights: -2 });
assert.ok(negative.incremental.guestNights < 0);
assert.equal(negative.per1000AddedSeats, null);

const launch = launchOptions(data, newRoute, { frequencies: [1, 3, 5] });
assert.deepEqual(launch.map((row) => row.extraFlights), [1, 3, 5]);
approximately(launch[2].incremental.guestNights, launch[0].incremental.guestNights * 5);
assert.ok(launch.every((row) => row.assumption.includes('not a measured')));
const capped = launchOptions(data, { ...inputs, extraFlights: 20 });
assert.equal(capped[2].duplicateSchedule, true);

const months = compareMonths(data, newRoute, [1, 2, 12]);
assert.equal(months.length, 3);
months.forEach((row) => approximately(row.per1000AddedSeats, metrics.per1000AddedSeats));
assert.ok(months[1].addedSeats < months[0].addedSeats);
const resolvedMonths = compareMonths(data, inputs, [1, 2], (month, original) => ({ ...original, conversionRate: month === 1 ? 0.4 : 0.5 }));
assert.ok(resolvedMonths[1].per1000AddedSeats > resolvedMonths[0].per1000AddedSeats);

const options = [
  { id: 'a', label: 'Option A', inputs: { ...inputs, loadFactor: 0.9, p2pShare: 0.6, conversionRate: 0.1, averageStay: 3 } },
  { id: 'b', label: 'Option B', inputs: { ...newRoute, loadFactor: 0.6, p2pShare: 0.6, conversionRate: 0.13, averageStay: 3 } },
];
const ranked = compareOptions(data, options);
assert.equal(ranked.winnerId, 'a');
const reversals = rankingReversals(data, options);
assert.equal(reversals.trials.find((row) => row.id === 'lowerHotelUse').winnerId, 'b');
assert.equal(reversals.stableAcrossTestedTrials, false);
const tied = compareOptions(data, [{ id: 'a', inputs }, { id: 'b', inputs: { ...inputs, extraFlights: 5 } }]);
assert.deepEqual(tied.winnerIds, ['a', 'b']);

const purpose = applyRoutePurpose(inputs, 'family', { conversionRate: 0.2, averageStay: 2 });
assert.equal(purpose.conversionRate, 0.2);
assert.equal(purpose.averageStay, 2);
assert.equal(purpose.routePurpose, 'family');
assert.throws(() => applyRoutePurpose(inputs, 'made-up'));
assert.throws(() => applyRoutePurpose(inputs, 'holiday', { conversionRate: 2 }));
for (const target of [-1, NaN, Infinity, '500']) assert.throws(() => solveCapacityTarget(data, inputs, target));
assert.throws(() => solveCapacityTarget(data, inputs, 500, { maxWeeklyFlights: 21 }));
assert.throws(() => compareMonths(data, inputs, [0]));
assert.throws(() => compareOptions(data, []));
assert.throws(() => compareOptions(data, [{ id: 'a', inputs }, { id: 'a', inputs }]));
assert.throws(() => launchOptions(data, inputs, { frequencies: [0, 3, 5] }));
const note = decisionNote(data, newRoute, options);
assert.ok(note.text.includes('not observed route-level hotel outcomes'));
assert.ok(note.text.includes('zero extra flights using the same assumptions'));
assert.ok(note.assumptions.some((row) => row.label === 'Route purpose'));
assert.ok(note.comparisonSummary.includes('ranking changes'));
assert.ok(note.driverSummary.includes('Trial sizes differ'));
assert.ok(!/undefined|NaN|Infinity/.test(note.text));
assert.equal(note.comparisonDetails.length, options.length);
assert.ok(note.text.includes('Compared options (each versus zero extra flights)'));
for (const [index, option] of options.entries()) {
  const detail = note.comparisonDetails[index];
  assert.ok(detail.includes(option.label));
  assert.ok(detail.includes('Flights/week: ' + option.inputs.extraFlights));
  assert.ok(detail.includes('seats/flight: ' + option.inputs.seatsPerFlight));
  assert.ok(note.text.includes(detail));
  const exactLine = detail.split('\n').find((line) => line.startsWith('Exact inputs and results: '));
  const exact = JSON.parse(exactLine.slice('Exact inputs and results: '.length));
  for (const key of ['originKey', 'month', 'extraFlights', 'seatsPerFlight', 'loadFactor', 'p2pShare', 'conversionRate', 'averageStay', 'eventUplift']) {
    assert.equal(exact[key], option.inputs[key], option.label + ': exported ' + key);
  }
  const reproduced = planningMetrics(data, { ...option.inputs, ...exact });
  assert.deepEqual(exact.incremental, reproduced.incremental);
  approximately(exact.per1000AddedSeats, reproduced.per1000AddedSeats);
}
const tieNote = decisionNote(data, inputs, [{ id: 'a', label: 'First', inputs }, { id: 'b', label: 'Second', inputs: { ...inputs, extraFlights: 5 } }]);
assert.ok(tieNote.comparisonSummary.includes('tie'));
assert.equal(tieNote.comparisonDetails.length, 2);
const noCapacityNote = decisionNote(data, { ...inputs, extraFlights: 0 }, [{ id: 'none', inputs: { ...inputs, extraFlights: 0 } }]);
assert.ok(noCapacityNote.comparisonSummary.includes('No option has positive added seats'));
assert.ok(noCapacityNote.comparisonDetails[0].includes('not applicable'));
assert.ok(!/undefined|NaN|Infinity/.test(noCapacityNote.text));

// The demo ending must reconcile to the flight-capacity calculation and name
// the actual leading individual trial, including its applied bounded change.
const workplace=note.workplaceDecision;
approximately(workplace.hotelNights,note.metrics.incremental.guestNights);
approximately(workplace.lowerTrialHotelNights,stressTest(data,newRoute).trials.find((row)=>row.id==='combined').incremental.guestNights);
const leadingTrial=stressTest(data,newRoute).trials.filter((row)=>row.id!=='combined')
  .sort((a,b)=>Math.abs(b.differenceFromPlan)-Math.abs(a.differenceFromPlan))[0];
assert.equal(workplace.driver.id,leadingTrial.id);
assert.equal(workplace.driver.guestNightChange,leadingTrial.differenceFromPlan);
assert.deepEqual(workplace.driver.actualChanges,leadingTrial.actualChanges);
assert.ok(workplace.verification.some((line)=>line.includes('airline') && line.includes('residents returning home')));
assert.ok(workplace.verification.some((line)=>line.includes('hotels') && line.includes('guests per occupied room')));
assert.ok(note.text.includes(workplace.question));
assert.ok(note.text.includes(workplace.hotelNightsText));
assert.ok(note.text.includes(workplace.priorityCheck));
assert.equal(noCapacityNote.workplaceDecision.hotelNights,0);
assert.equal(noCapacityNote.workplaceDecision.driver,null);
assert.ok(noCapacityNote.workplaceDecision.driverText.includes('no leading assumption'));
const atLimits=decisionNote(data,{...newRoute,loadFactor:0.3,conversionRate:0.05,averageStay:1});
assert.equal(atLimits.workplaceDecision.driver,null);
assert.ok(atLimits.workplaceDecision.priorityCheck.includes('trial limits'));
assert.ok(!atLimits.workplaceDecision.priorityCheck.includes('Choose a positive'));
const reductionNote=decisionNote(data,{...inputs,extraFlights:-2});
assert.ok(reductionNote.workplaceDecision.hotelNightsText.includes('fewer guest nights'));

console.log(`PASS: ${routeCases} routes preserve historical baselines and isolate flight effects; launch/month comparisons, bounded stress trials, target solving, ranking reversals, purpose labels and decision notes verified.`);
