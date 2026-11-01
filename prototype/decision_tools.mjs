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

export function decisionNote(data, inputs, options = []) {
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
    ['Seats per flight', String(inputs.seatsPerFlight)], ['Flight occupancy', pct(inputs.loadFactor)],
    ['Passengers ending in Abu Dhabi', pct(inputs.p2pShare)], ['Hotel use', pct(inputs.conversionRate)],
    ['Nights per hotel stay', Number(inputs.averageStay).toFixed(2)], ['Extra event demand', pct(inputs.eventUplift || 0)],
  ].map(([label, value]) => ({ label, value }));
  const lowerCase = stress.trials.find((trial) => trial.id === 'combined');
  const comparisonDetails = reversals ? reversals.base.options.map((row) => [
    row.label + ' · ' + data.months[row.inputs.month - 1],
    `Flights/week: ${row.inputs.extraFlights}; seats/flight: ${row.inputs.seatsPerFlight}; fullness: ${pct(row.inputs.loadFactor)}; ending-trip share: ${pct(row.inputs.p2pShare)}; hotel use: ${pct(row.inputs.conversionRate)}; nights/stay: ${Number(row.inputs.averageStay).toFixed(4)}; event assumption: ${pct(row.inputs.eventUplift || 0)}.`,
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
  return { title: 'Air2Stay planning decision note', summary, metrics, assumptions, stressSummary, driverSummary, comparisonSummary, nextSteps, limitations, reversals, workplaceDecision,
    comparisonDetails,
    text: ['Air2Stay planning decision note', summary, '', 'The planning decision', workplaceDecision.question, workplaceDecision.hotelNightsText, workplaceDecision.lowerTrialText, workplaceDecision.driverText, workplaceDecision.priorityCheck, workplaceDecision.caution, ...(comparisonSummary ? ['', comparisonSummary] : []), '', 'Assumptions used', ...assumptions.map((row) => `${row.label}: ${row.value}`), ...(comparisonDetails.length ? ['', 'Compared options (each versus zero extra flights)', ...comparisonDetails] : []), '', stressSummary, driverSummary, '', 'Next checks', ...nextSteps.map((line) => `- ${line}`), '', 'Limits', ...limitations.map((line) => `- ${line}`)].join('\n') };
}
