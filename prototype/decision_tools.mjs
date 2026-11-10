import { runScenario, validateScenarioInputs } from './engine.mjs';

// These helpers compare the extra capacity being proposed. They never alter the
// historical baseline or treat an assumed hotel outcome as an observed one.
export const ROUTE_PURPOSES = Object.freeze([
  { key: 'mixed', label: 'Mixed visitors', check: 'Check the mix of hotel stays, family visits and other trips.' },
  { key: 'holiday', label: 'Holiday visitors', check: 'Check hotel use and stay length with tourism and hotel records.' },
  { key: 'business', label: 'Business visitors', check: 'Check business travel patterns and typical stay length.' },
  { key: 'family', label: 'Family visits', check: 'Check how many visitors stay with family rather than in hotels.' },
]);

const LIMITS = Object.freeze({ loadFactor: [0.3, 1], conversionRate: [0.05, 0.9], averageStay: [1, 10] });
const clamp = (value, [min, max]) => Math.max(min, Math.min(max, value));
const zeroTiny = (value) => Math.abs(value) < 1e-7 ? 0 : value;
const copy = (inputs) => ({ ...inputs });

function checkedInputs(inputs) {
  if (!inputs || typeof inputs !== 'object') throw new TypeError('A complete plan is required.');
  const error = validateScenarioInputs(inputs);
  if (error) throw new RangeError(error);
  return copy(inputs);
}

/** Purpose is a planner label. It changes numbers only through explicit inputs. */
export function applyRoutePurpose(inputs, purpose = 'mixed', assumptions = {}) {
  if (!ROUTE_PURPOSES.some((item) => item.key === purpose)) throw new RangeError('Choose a supported route purpose.');
  const result = { ...checkedInputs(inputs), routePurpose: purpose };
  for (const key of ['p2pShare', 'conversionRate', 'averageStay']) {
    if (assumptions[key] !== undefined) result[key] = assumptions[key];
  }
  return checkedInputs(result);
}

/** Compare the plan with zero added flights, holding its other assumptions fixed. */
export function planningMetrics(data, inputs) {
  const plan = checkedInputs(inputs);
  const result = runScenario(data, plan);
  const noAddedFlights = runScenario(data, { ...plan, extraFlights: 0 });
  const incremental = Object.fromEntries(['seats', 'passengers', 'p2p', 'hotelCheckins', 'guestNights']
    .map((key) => [key, zeroTiny(result.scenario[key] - noAddedFlights.scenario[key])]));
  const addedSeats = incremental.seats;
  return {
    inputs: plan, result, noAddedFlights, addedSeats, incremental,
    historicalChange: { ...result.delta },
    per1000AddedSeats: addedSeats > 0 ? incremental.guestNights / addedSeats * 1000 : null,
    comparisonBasis: 'Extra flights compared with zero added flights, using the same passenger and hotel assumptions.',
  };
}

/** No route-specific default is silently substituted into a comparison option. */
export function compareOptions(data, options, { rankBy = 'per1000AddedSeats' } = {}) {
  if (!Array.isArray(options) || options.length < 1) throw new RangeError('Add at least one option to compare.');
  if (!['per1000AddedSeats', 'incrementalGuestNights'].includes(rankBy)) throw new RangeError('Unsupported comparison measure.');
  const ids = new Set();
  const rows = options.map((option, index) => {
    const id = String(option.id ?? index);
    if (ids.has(id)) throw new RangeError('Comparison option identifiers must be unique.');
    ids.add(id);
    const metrics = planningMetrics(data, option.inputs);
    return { id, label: String(option.label || metrics.result.route.origin), ...metrics };
  });
  const score = (row) => rankBy === 'per1000AddedSeats' ? row.per1000AddedSeats : row.incremental.guestNights;
  const eligible = rows.filter((row) => row.addedSeats > 0 && Number.isFinite(score(row)));
  const bestScore = eligible.length ? Math.max(...eligible.map(score)) : null;
  const winnerIds = bestScore == null ? [] : eligible.filter((row) => Math.abs(score(row) - bestScore) <= Math.max(1e-7, Math.abs(bestScore) * 1e-9)).map((row) => row.id);
  return { options: rows, winnerId: winnerIds[0] ?? null, winnerIds, rankingMetric: rankBy, bestScore,
    interpretation: 'A comparison of the supplied assumptions, not a commercial route recommendation or independent passenger-demand forecast.' };
}

/** Optional resolver lets the UI explicitly apply a documented monthly profile. */
export function compareMonths(data, inputs, months = Array.from({ length: 12 }, (_, index) => index + 1), resolveInputs = null) {
  if (!Array.isArray(months) || !months.length) throw new RangeError('Choose at least one month.');
  return [...new Set(months)].map((month) => {
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('Months must be integers from 1 to 12.');
    const resolved = resolveInputs ? resolveInputs(month, copy(inputs)) : copy(inputs);
    return { month, monthName: data.months[month - 1], ...planningMetrics(data, { ...resolved, month }),
      assumptionsMode: resolveInputs ? 'Uses the explicitly resolved assumptions for this month.' : 'Holds flight and hotel assumptions fixed; the month length and historical comparison change.' };
  });
}

/** Flight schedules are illustrative planning choices, not probability bands. */
export function launchOptions(data, inputs, { frequencies } = {}) {
  const current = Math.max(1, Math.round(Number(inputs.extraFlights) > 0 ? Number(inputs.extraFlights) : 3));
  const selected = frequencies || [Math.max(1, current - 2), current, Math.min(20, current + 2)];
  if (!Array.isArray(selected) || selected.length !== 3 || selected.some((value) => !Number.isInteger(value) || value < 1 || value > 20)) throw new RangeError('Choose three whole flight counts between 1 and 20.');
  return selected.map((flights, index) => ({
    id: ['cautious', 'standard', 'expanded'][index],
    label: ['Cautious launch', 'Standard launch', 'Expanded launch'][index],
    extraFlights: flights,
    duplicateSchedule: selected.indexOf(flights) !== index,
    assumption: 'Illustrative weekly flight schedule; not a measured demand level or probability.',
    ...planningMetrics(data, { ...inputs, extraFlights: flights }),
  }));
}

export const STRESS_TRIALS = Object.freeze([
  { id: 'lowerLoad', label: 'Flights 10 percentage points less full', changes: { loadFactor: -0.10 } },
  { id: 'lowerHotelUse', label: 'Hotel use 5 percentage points lower', changes: { conversionRate: -0.05 } },
  { id: 'shorterStay', label: 'Hotel stays 0.5 nights shorter', changes: { averageStay: -0.5 } },
  { id: 'combined', label: 'All three lower assumptions together', changes: { loadFactor: -0.10, conversionRate: -0.05, averageStay: -0.5 } },
]);

function stressInputs(inputs, changes) {
  const result = checkedInputs(inputs);
  for (const [key, change] of Object.entries(changes)) result[key] = clamp(Number(result[key]) + change, LIMITS[key]);
  return result;
}

export function stressTest(data, inputs) {
  const base = planningMetrics(data, inputs);
  const trials = STRESS_TRIALS.map((trial) => {
    const stressed = stressInputs(inputs, trial.changes);
    const metrics = planningMetrics(data, stressed);
    return { ...trial, ...metrics,
      actualChanges: Object.fromEntries(Object.keys(trial.changes).map((key) => [key, stressed[key] - inputs[key]])),
      differenceFromPlan: zeroTiny(metrics.incremental.guestNights - base.incremental.guestNights),
    };
  });
  return { base, trials, interpretation: 'One-at-a-time and combined lower-assumption trials within the control limits. They are not probabilities or tested confidence bounds.' };
}

/** Minimum whole weekly flights to meet an incremental hotel-night target. */
export function solveCapacityTarget(data, inputs, targetGuestNights, { maxWeeklyFlights = 20 } = {}) {
  checkedInputs(inputs);
  if (!Number.isFinite(targetGuestNights) || targetGuestNights < 0) throw new RangeError('Enter a hotel-night target of zero or more.');
  if (!Number.isInteger(maxWeeklyFlights) || maxWeeklyFlights < 1 || maxWeeklyFlights > 20) throw new RangeError('The weekly-flight limit must be between 1 and 20.');
  const tolerance = Math.max(1e-7, targetGuestNights * 1e-9);
  let metrics = planningMetrics(data, { ...inputs, extraFlights: 0 });
  for (let flights = 0; flights <= maxWeeklyFlights; flights++) {
    metrics = planningMetrics(data, { ...inputs, extraFlights: flights });
    if (metrics.incremental.guestNights + tolerance >= targetGuestNights) {
      return { targetGuestNights, met: true, requiredWeeklyFlights: flights, evaluatedWeeklyFlights: flights,
        maxWeeklyFlights, metrics, shortfall: 0,
        interpretation: 'Capacity required under these assumptions; not proof of passenger demand, available slots or route profitability.' };
    }
  }
  return { targetGuestNights, met: false, requiredWeeklyFlights: null, evaluatedWeeklyFlights: maxWeeklyFlights,
    maxWeeklyFlights, metrics, shortfall: Math.max(0, targetGuestNights - metrics.incremental.guestNights),
    interpretation: 'The target is not reached within the weekly-flight limit. Revise the target or investigate the assumptions; no result beyond the supported controls is claimed.' };
}

export const TARGET_FLIGHT_CONTROL_LIMIT = 20;

/**
 * Work a hotel-night target backwards through the same chain the plan uses:
 * nights -> hotel check-ins -> visitors ending their trip here -> passengers
 * -> seats -> weekly flights. The chain is linear in added flights, so each
 * stage is the exact one-flight increment scaled by the flights needed.
 * basis 'extra': nights on top of the plan with zero added flights.
 * basis 'total': total nights for the month, including existing flights.
 */
export function reverseTargetPlan(data, inputs, target, { basis = 'extra' } = {}) {
  const plan = checkedInputs(inputs);
  if (!['extra', 'total'].includes(basis)) throw new RangeError('Choose an extra or total hotel-night target.');
  if (typeof target !== 'number' || !Number.isFinite(target) || target < 0) throw new RangeError('Enter a hotel-night target of zero or more.');
  const zero = runScenario(data, { ...plan, extraFlights: 0 });
  const one = runScenario(data, { ...plan, extraFlights: 1 });
  const startingNights = zero.scenario.guestNights;
  const neededNights = basis === 'total' ? Math.max(0, target - startingNights) : target;
  const perFlight = Object.fromEntries(['seats', 'passengers', 'p2p', 'hotelCheckins', 'guestNights']
    .map((key) => [key, one.scenario[key] - zero.scenario[key]]));
  if (!(perFlight.guestNights > 0)) throw new RangeError('These assumptions add no hotel nights per flight, so no flight count can reach the target.');
  const tolerance = Math.max(1e-7, neededNights * 1e-9);
  const exactWeeklyFlights = neededNights <= tolerance ? 0 : neededNights / perFlight.guestNights;
  const requiredWeeklyFlights = exactWeeklyFlights === 0 ? 0 : Math.ceil(exactWeeklyFlights - 1e-9);
  const at = (key) => perFlight[key] * exactWeeklyFlights;
  const weeks = perFlight.seats / Number(plan.seatsPerFlight);
  const uplift = Number(plan.eventUplift || 0);
  const steps = [
    { key: 'guestNights', label: 'Hotel nights needed', value: neededNights, operation: '' },
    { key: 'hotelCheckins', label: 'Hotel check-ins', value: at('hotelCheckins'), operation: `÷ ${Number(plan.averageStay).toFixed(2)} nights per stay` },
    { key: 'p2p', label: 'Visitors ending their trip in Abu Dhabi', value: at('p2p'),
      operation: `÷ ${(Number(plan.conversionRate) * 100).toFixed(1)}% who use a hotel` + (uplift ? ` and +${(uplift * 100).toFixed(0)}% for an event or season` : '') },
    { key: 'passengers', label: 'Passengers', value: at('passengers'), operation: `÷ ${(Number(plan.p2pShare) * 100).toFixed(1)}% whose trip ends here` },
    { key: 'seats', label: 'Seats in the month', value: at('seats'), operation: `÷ ${(Number(plan.loadFactor) * 100).toFixed(1)}% of seats filled` },
    { key: 'weeklyFlights', label: 'Extra flights each week', value: exactWeeklyFlights, operation: `÷ ${Math.round(Number(plan.seatsPerFlight))} seats per flight ÷ ${weeks.toFixed(2)} weeks` },
  ];
  const route = zero.route;
  const existingWeeklyFlights = route.knownMarket ? Number(route.weeklyFrequency) || 0 : 0;
  const increase = existingWeeklyFlights > 0 ? requiredWeeklyFlights / existingWeeklyFlights : null;
  const realism = requiredWeeklyFlights === 0 ? { level: 'none', text: 'No extra flights are needed under these assumptions.' }
    : !route.knownMarket || existingWeeklyFlights <= 0 ? { level: 'new-route', text: 'This is a new route with no current flights to compare against. Ask an airline whether this schedule is realistic.' }
    : increase <= 0.1 ? { level: 'small', text: `A small addition: about ${Math.round(increase * 100)}% more than the roughly ${Math.round(existingWeeklyFlights)} flights a week this route usually has in this month.` }
    : increase <= 0.5 ? { level: 'moderate', text: `A noticeable addition: about ${Math.round(increase * 100)}% more than the roughly ${Math.round(existingWeeklyFlights)} flights a week this route usually has. Check airline capacity and airport slots.` }
    : increase <= 1 ? { level: 'large', text: `A large addition: about ${Math.round(increase * 100)}% more than the roughly ${Math.round(existingWeeklyFlights)} flights a week this route usually has. New flights may not fill as well as existing ones.` }
    : { level: 'very-large', text: `More than doubles the route: about ${(1 + increase).toFixed(1)} times the roughly ${Math.round(existingWeeklyFlights)} flights a week it usually has. Treat this as unlikely without strong airline evidence.` };
  const levers = [
    { key: 'averageStay', label: 'Average nights per hotel stay', limit: LIMITS.averageStay[1], unit: 'nights' },
    { key: 'conversionRate', label: 'Share of visitors using a hotel', limit: LIMITS.conversionRate[1], unit: 'share' },
    { key: 'loadFactor', label: 'How full flights are', limit: LIMITS.loadFactor[1], unit: 'share' },
  ];
  const factor = startingNights > 0 ? (startingNights + neededNights) / startingNights : null;
  const alternatives = factor == null || neededNights <= tolerance ? [] : levers.map((lever) => {
    const from = Number(plan[lever.key]);
    const to = from * factor;
    return { ...lever, from, to, withinLimits: to <= lever.limit };
  });
  return {
    basis, target, startingNights, neededNights, targetTotalNights: startingNights + neededNights,
    alreadyMet: neededNights <= tolerance, exactWeeklyFlights, requiredWeeklyFlights,
    extraFlightsPerMonth: requiredWeeklyFlights * weeks, nightsPerWeeklyFlight: perFlight.guestNights,
    withinControlLimit: requiredWeeklyFlights <= TARGET_FLIGHT_CONTROL_LIMIT,
    steps, route, existingWeeklyFlights, increaseOnExisting: increase, realism, alternatives,
    interpretation: 'Capacity needed under these assumptions if every extra flight fills like the plan says. Not proof of passenger demand, airport slots, hotel rooms or route profitability.',
  };
}

/** Show whether applying identical trial rules changes the assumed ranking. */
export function rankingReversals(data, options, settings = {}) {
  const base = compareOptions(data, options, settings);
  const trials = STRESS_TRIALS.map((trial) => {
    const comparison = compareOptions(data, options.map((option) => ({ ...option, inputs: stressInputs(option.inputs, trial.changes) })), settings);
    const originalWinnerStillBest = base.winnerIds.some((id) => comparison.winnerIds.includes(id));
    return { id: trial.id, label: trial.label, winnerId: comparison.winnerId, winnerIds: comparison.winnerIds,
      rankingChanged: Boolean(base.winnerId && comparison.winnerId && !originalWinnerStillBest), comparison };
  });
  return { base, trials, stableAcrossTestedTrials: trials.every((trial) => !trial.rankingChanged),
    interpretation: 'A ranking is conditional on the selected measure and trial sizes. Stability in these trials does not establish a real-world best route.' };
}

export function decisionNote(data, inputs, options = [], plan = null) {
  const metrics = planningMetrics(data, inputs);
  const stress = stressTest(data, inputs);
  const purpose = ROUTE_PURPOSES.find((item) => item.key === inputs.routePurpose) || ROUTE_PURPOSES[0];
  const reversals = options.length ? rankingReversals(data, options) : null;
  const fmt = (value) => Math.round(value).toLocaleString('en-US');
  const pct = (value) => (Number(value) * 100).toFixed(1) + '%';
  const summary = `${metrics.result.route.origin} in ${data.months[Number(inputs.month) - 1]}: ${inputs.extraFlights} extra weekly flights produce an estimated ${fmt(metrics.incremental.hotelCheckins)} additional hotel check-ins and ${fmt(metrics.incremental.guestNights)} additional guest nights, compared with zero extra flights using the same assumptions.`;
  const nextSteps = [
    'With the airline or airport, confirm weekly flights, aircraft seats, expected bookings and flight occupancy; check how many arrivals will finish their journey in Abu Dhabi and how many will be residents returning home.',
    purpose.check,
    'With hotels, check expected hotel use, typical stay length and available capacity in the selected month. Confirm guests per occupied room before translating guest nights into rooms or staffing.',
  ];
  const limitations = [
    'These are scenario estimates, not observed route-level hotel outcomes or an independent forecast of passenger demand.',
    'A new route starts from zero. Comparison markets provide starting assumptions only.',
    'The event increase and route purpose are planner assumptions. Purpose has no automatic numerical preset.',
    'Lower-assumption trials are illustrative tests, not statistical probabilities or commercial break-even tests.',
  ];
  const assumptions = [
    ['Route purpose', purpose.label], ['Extra flights per week', String(inputs.extraFlights)],
    ['Seats per flight', String(Math.round(Number(inputs.seatsPerFlight)))], ['Flight occupancy', pct(inputs.loadFactor)],
    ['Passengers ending in Abu Dhabi', pct(inputs.p2pShare)], ['Hotel use', pct(inputs.conversionRate)],
    ['Nights per hotel stay', Number(inputs.averageStay).toFixed(2)], ['Extra event demand', pct(inputs.eventUplift || 0)],
  ].map(([label, value]) => ({ label, value }));
  const lowerCase = stress.trials.find((trial) => trial.id === 'combined');
  const comparisonDetails = reversals ? reversals.base.options.map((row) => [
    row.label + ' · ' + data.months[row.inputs.month - 1],
    `Flights/week: ${row.inputs.extraFlights}; seats/flight: ${Math.round(Number(row.inputs.seatsPerFlight))}; fullness: ${pct(row.inputs.loadFactor)}; ending-trip share: ${pct(row.inputs.p2pShare)}; hotel use: ${pct(row.inputs.conversionRate)}; nights/stay: ${Number(row.inputs.averageStay).toFixed(4)}; event assumption: ${pct(row.inputs.eventUplift || 0)}.`,
    `Additional check-ins: ${fmt(row.incremental.hotelCheckins)}; additional guest nights: ${fmt(row.incremental.guestNights)}; guest nights/1,000 added seats: ${row.per1000AddedSeats == null ? 'not applicable' : fmt(row.per1000AddedSeats)}.`,
    row.inputs.peerProfile ? 'Starting comparison weights: ' + row.inputs.peerProfile.peers.map((peer) => `${peer.origin} ${pct(peer.weight)}`).join('; ') + '. Geographic assumptions only.' : 'Existing-market or explicitly selected single-market starting assumptions.',
    'Exact inputs and results: ' + JSON.stringify({originKey:row.inputs.originKey,month:row.inputs.month,extraFlights:row.inputs.extraFlights,seatsPerFlight:row.inputs.seatsPerFlight,loadFactor:row.inputs.loadFactor,p2pShare:row.inputs.p2pShare,conversionRate:row.inputs.conversionRate,averageStay:row.inputs.averageStay,eventUplift:row.inputs.eventUplift,incremental:row.incremental,per1000AddedSeats:row.per1000AddedSeats}),
  ].join('\n')) : [];
  const stressSummary = `With flights 10 percentage points less full, hotel use 5 points lower and stays 0.5 nights shorter, within the allowed controls, the capacity effect becomes ${fmt(lowerCase.incremental.guestNights)} extra guest nights.`;
  const largestTrial = stress.trials.filter((trial) => trial.id !== 'combined')
    .reduce((largest, trial) => !largest || Math.abs(trial.differenceFromPlan) > Math.abs(largest.differenceFromPlan) ? trial : largest, null);
  const driverImpact = Math.abs(largestTrial.differenceFromPlan);
  const hasDriver = driverImpact > 1e-7;
  const driverSummary = hasDriver
    ? `Of the individual trials tested, “${largestTrial.label}” changes the capacity effect most, by ${fmt(driverImpact)} guest nights. Trial sizes differ; this is a reason to check that assumption, not a ranking of real-world certainty.`
    : 'The individual lower-assumption trials do not change the added-flight result at this setting. There is no leading assumption to report from these trials.';
  const driverLabels = {lowerLoad:'How full the flights are', lowerHotelUse:'Share of passengers ending their trip in Abu Dhabi who use a hotel', shorterStay:'Average nights per hotel stay'};
  const driverChecks = {
    lowerLoad:'Ask the airline for expected bookings and flight occupancy for the proposed schedule.',
    lowerHotelUse:'Check with tourism and hotel teams how many visitors are likely to choose hotels rather than other accommodation.',
    shorterStay:'Check the assumed stay length with hotels and comparable visitor records for the selected month.',
  };
  const extraNights = metrics.incremental.guestNights;
  const workplaceDecision = {
    question:'If we add this route, how many extra hotel nights might we need to plan for, what assumption matters most, and what should we verify with airlines or hotels before acting?',
    hotelNights:extraNights,
    hotelNightsText:extraNights > 1e-7 ? `Plan for about ${fmt(extraNights)} extra guest nights in ${data.months[Number(inputs.month)-1]} under the selected assumptions.`
      : extraNights < -1e-7 ? `The flight reduction implies about ${fmt(Math.abs(extraNights))} fewer guest nights in ${data.months[Number(inputs.month)-1]} under the selected assumptions.`
      : 'No added guest nights are estimated because this plan adds no flight capacity.',
    lowerTrialHotelNights:lowerCase.incremental.guestNights,
    lowerTrialText:`The combined lower-assumption trial gives ${fmt(lowerCase.incremental.guestNights)} guest nights from the flight change. This is an illustrative check, not a probability bound.`,
    driver:hasDriver ? {id:largestTrial.id,label:driverLabels[largestTrial.id],trial:largestTrial.label,guestNightChange:largestTrial.differenceFromPlan,actualChanges:{...largestTrial.actualChanges}} : null,
    driverText:hasDriver ? `${driverLabels[largestTrial.id]} has the largest effect in the individual lower-assumption trials tested: about ${fmt(driverImpact)} guest nights. The trial sizes differ.` : driverSummary,
    priorityCheck:hasDriver ? driverChecks[largestTrial.id] : metrics.addedSeats <= 0 ? 'Choose a positive added-flight schedule before comparing which visitor assumption changes its result most.' : 'The assumptions are at the trial limits; review the selected values with airlines and hotels before acting.',
    verification:nextSteps.slice(),
    caution:'Guest nights count nights spent by people, not rooms. Confirm passenger demand and hotel capacity before committing to the proposal.',
  };
  let comparisonSummary = '';
  if (reversals) {
    if (!reversals.base.winnerId) comparisonSummary = 'No option has positive added seats, so there is no added-seat yield ranking.';
    else if (reversals.base.winnerIds.length > 1) comparisonSummary = 'The leading options tie on guest nights per 1,000 added seats under the supplied assumptions.';
    else {
      const winner = reversals.base.options.find((row) => row.id === reversals.base.winnerId);
      const changed = reversals.trials.filter((trial) => trial.rankingChanged);
      comparisonSummary = `${winner.label} has the highest assumed guest nights per 1,000 added seats. ` + (changed.length
        ? `The ranking changes in these trials: ${changed.map((trial) => trial.label).join('; ')}. Check the assumptions behind those reversals before advancing an option.`
        : 'Its lead holds across the lower-assumption trials tested; this does not establish which route will perform best in practice.');
    }
  }
  // With a next-step plan, the note names the same first check as the rest of the app.
  const firstStep = plan?.steps?.[0] || null;
  const firstLines = firstStep ? nextStepLines(firstStep, metrics.result) : null;
  if (plan) workplaceDecision.firstCheck = firstStep ? { id: firstStep.id, ...firstLines } : null;
  const firstCheckLines = !plan ? [workplaceDecision.driverText, workplaceDecision.priorityCheck]
    : firstLines ? [`First check: ${firstLines.title}.`, ...(firstLines.overdue ? [firstLines.overdue] : []), firstLines.why, ...(firstLines.impact ? [firstLines.impact] : []), firstLines.ask]
    : ['All checks have recorded evidence for these exact assumptions.'];
  return { title: 'Air2Stay planning decision note', summary, metrics, assumptions, stressSummary, driverSummary, comparisonSummary, nextSteps, limitations, reversals, workplaceDecision,
    comparisonDetails,
    text: ['Air2Stay planning decision note', summary, '', 'The planning decision', workplaceDecision.question, workplaceDecision.hotelNightsText, workplaceDecision.lowerTrialText, ...firstCheckLines, workplaceDecision.caution, ...(comparisonSummary ? ['', comparisonSummary] : []), '', 'Assumptions used', ...assumptions.map((row) => `${row.label}: ${row.value}`), ...(comparisonDetails.length ? ['', 'Compared options (each versus zero extra flights)', ...comparisonDetails] : []), '', stressSummary, driverSummary, '', 'Next checks', ...nextSteps.map((line) => `- ${line}`), '', 'Limits', ...limitations.map((line) => `- ${line}`)].join('\n') };
}

// ---------------------------------------------------------------------------
// Next steps: which checks to complete before acting on a plan.
// Ranks each Follow-ups check by how weakly its assumptions are supported, then
// by the effect of the same 10% error, measured by re-running the calculation.
// Every sentence is one line so the app dictionary can translate it.
export const NEXT_STEP_CHECKS = Object.freeze({
  demand: Object.freeze({ title: 'Confirm the flight demand', owner: 'Airline or airport planner', draft: 'airline', assumptions: Object.freeze(['loadFactor', 'p2pShare']) }),
  hotels: Object.freeze({ title: 'Check hotel use and capacity', owner: 'Hotel or tourism team', draft: 'hotel', assumptions: Object.freeze(['conversionRate', 'averageStay']) }),
  event: Object.freeze({ title: 'Validate the event increase', owner: 'Event or tourism team', draft: 'team', assumptions: Object.freeze(['eventUplift']) }),
  visitors: Object.freeze({ title: 'Check who is travelling', owner: 'Tourism research team', draft: 'team', assumptions: Object.freeze([]) }),
});
const NEXT_STEP_LABELS = Object.freeze({
  loadFactor: 'How full flights are', p2pShare: 'Passengers ending their trip in Abu Dhabi', conversionRate: 'Share checking into a hotel',
  averageStay: 'Average nights per hotel stay', eventUplift: 'Extra hotel demand for an event or season',
});
const NEXT_STEP_MINIMUM = Object.freeze({ loadFactor: 0.3, p2pShare: 0.05, conversionRate: 0.05, averageStay: 1, eventUplift: 0 });
// Higher means less direct evidence for this route.
export const NEXT_STEP_EVIDENCE_WEIGHT = Object.freeze({ borrowed: 5, yours: 4, appWide: 3, fewRecords: 2, estimated: 2, routeRecords: 1 });

function nextStepEvidence(key, inputs, result, starting) {
  if (key === 'eventUplift') return 'yours';
  // The optional training-season rate is still one rate for all routes.
  if (key === 'conversionRate' && inputs.seasonalConversion) return 'appWide';
  const start = starting ? Number(starting[key]) : NaN;
  // Compared as displayed, so typing back the shown starting value does not count as a new value.
  if (Number.isFinite(start) && nsValue(key, inputs[key]) !== nsValue(key, start)) return 'yours';
  if (key === 'conversionRate') return 'appWide';
  if (!result.route.knownMarket) return 'borrowed';
  if (key === 'averageStay') return 'estimated';
  return Number(result.route.yearsObserved) >= 3 ? 'routeRecords' : 'fewRecords';
}

function nextStepImpact(data, inputs, key) {
  // With added flights, measure the nights those flights add; otherwise the plan total.
  const basis = Number(inputs.extraFlights) > 0 ? 'added' : 'total';
  const measure = (plan) => basis === 'added' ? planningMetrics(data, plan).incremental.guestNights : runScenario(data, plan).scenario.guestNights;
  const from = Number(inputs[key]);
  const before = measure(inputs);
  const to = Math.max(NEXT_STEP_MINIMUM[key], from * 0.9);
  if (!(to < from - 1e-12)) return { basis, from, to: from, before, after: before, difference: 0, atMinimum: true };
  const after = measure({ ...inputs, [key]: to });
  return { basis, from, to, before, after, difference: after - before, atMinimum: false };
}

// Larger effect first; effects within half a night count as equal, so rounding never decides the order.
function nsImpactGap(a, b) {
  const gap = Math.abs(b?.impact.difference || 0) - Math.abs(a?.impact.difference || 0);
  return Math.abs(gap) < 0.5 ? 0 : gap;
}

export function nextStepPlan(data, inputs, result = runScenario(data, inputs), { starting = null, statuses = {} } = {}) {
  checkedInputs(inputs);
  const ids = ['demand', 'hotels', ...(Number(inputs.eventUplift) > 0 ? ['event'] : []), 'visitors'];
  const checks = ids.map((id, position) => {
    const { title, owner, draft, assumptions: keys } = NEXT_STEP_CHECKS[id];
    const assumptions = keys.map((key) => {
      const evidence = nextStepEvidence(key, inputs, result, starting);
      return { key, label: NEXT_STEP_LABELS[key], value: Number(inputs[key]), evidence, weight: NEXT_STEP_EVIDENCE_WEIGHT[evidence], impact: nextStepImpact(data, inputs, key) };
    });
    const lead = assumptions.slice().sort((a, b) => b.weight - a.weight || nsImpactGap(a, b))[0] || null;
    const status = ['red', 'amber', 'green'].includes(statuses[id]) ? statuses[id] : 'amber';
    // The visitor mix changes who is expected, not the total, so it comes last.
    return { id, title, owner, draft, position, status, assumptions, lead, weight: lead ? lead.weight : 0.5 };
  });
  const order = checks.slice().sort((a, b) => b.weight - a.weight || nsImpactGap(a.lead, b.lead) || a.position - b.position);
  const open = order.filter((check) => check.status !== 'green');
  const steps = [...open.filter((check) => check.status === 'red'), ...open.filter((check) => check.status !== 'red')].slice(0, 3);
  return {
    order: order.map((check) => check.id), checks: Object.fromEntries(checks.map((check) => [check.id, check])), steps,
    readiness: { verified: checks.filter((check) => check.status === 'green').length, total: checks.length },
  };
}

const nsNumber = (value) => Math.round(Number(value)).toLocaleString('en-US');
const nsValue = (key, value) => key === 'averageStay' ? Number(value).toFixed(2) : (Number(value) * 100).toFixed(1) + '%';

/** English sentences for one step: title, why, impact and who to ask. */
export function nextStepLines(step, result) {
  const lead = step.lead;
  let why;
  if (!lead) why = 'The visitor mix is an estimated split by nationality: it changes who is expected, not the total.';
  else {
    const said = `${lead.label}: ${nsValue(lead.key, lead.value)}`;
    const records = Math.round(Number(result.route.yearsObserved) || 0);
    why = lead.evidence === 'borrowed' ? `${said}, borrowed from comparison countries because this route has no flight history.`
      : lead.evidence === 'yours' ? `${said}, a value you entered, so record where it came from.`
      : lead.evidence === 'appWide' ? `${said}, one app-wide rate, not measured for this route.`
      : lead.evidence === 'estimated' ? `${said}, estimated from hotel records by nationality.`
      : lead.evidence === 'fewRecords' ? (records === 1 ? `${said}, from only 1 past flight record for this route and month.` : records === 2 ? `${said}, from only two past flight records for this route and month.` : `${said}, from only ${records} past flight records for this route and month.`)
      : `${said}, from ${records} past flight records for this route and month.`;
  }
  let impact = '';
  if (lead) {
    const i = lead.impact;
    impact = i.atMinimum ? 'It is already at the lowest value the planner allows.'
      : i.basis === 'added' ? `If it is 10% lower (${nsValue(lead.key, i.to)}), your extra flights add about ${nsNumber(i.after)} nights instead of ${nsNumber(i.before)}.`
      : `If it is 10% lower (${nsValue(lead.key, i.to)}), the plan gives about ${nsNumber(i.after)} guest nights instead of ${nsNumber(i.before)}.`;
  }
  const overdue = step.status === 'red' ? 'This check is overdue.' : '';
  return { title: step.title, why, impact, ask: `Ask: ${step.owner}.`, overdue };
}
