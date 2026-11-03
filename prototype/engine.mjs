 const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  
 export function weeksInMonth(monthNumber) {
   return MONTH_DAYS[Math.max(1, Math.min(12, monthNumber)) - 1] / 7;
 }

 export function assistantReply(data, prompt, current, result) {
   const lower = String(prompt || "").toLowerCase();
   const whole = Math.max(0, Number(result.scenario.seats));
   const passengers = Math.max(0, Number(result.scenario.passengers));
   const loadFactor = whole ? passengers / whole : 0;
   const p2pShare = whole ? passengers ? result.scenario.p2p / passengers : 0 : 0;
   const conversion = result.scenario.p2p ? result.scenario.hotelCheckins / result.scenario.p2p : 0;
   const signedNights = `${result.delta.guestNights >= 0 ? "+" : "−"}${Math.round(Math.abs(result.delta.guestNights)).toLocaleString()}`;
   const upliftNote = result.eventUplift ? ` The estimate includes your chosen +${Math.round(result.eventUplift * 100)}% increase for an event or season. This was not measured from past events.` : "";
   const plainResult = `The plan estimates ${Math.round(result.scenario.hotelCheckins).toLocaleString()} hotel arrivals and ${Math.round(result.scenario.guestNights).toLocaleString()} hotel nights (${signedNights} nights compared with the original plan).${upliftNote}`;
   if (/\b(reset|clear|start over)\b/.test(lower)) {
     return { type: "reset", text: "I’ve reset the plan to India in December. You can change the country, month, and numbers on the left." };
   }
   if (/\b(what changed|what did you change|summary|status)\b/.test(lower)) {
     return {
       type: "answer",
       text: `Your current plan is ${result.route.origin} in ${data.months[result.route.month - 1]}. ${plainResult}`,
     };
   }
   if (/\b(why|explain|how did|where does)\b/.test(lower)) {
     let detail = `The plan has ${Math.round(whole).toLocaleString()} seats. At ${(loadFactor * 100).toFixed(1)}% full, about ${Math.round(passengers).toLocaleString()} passengers are expected. ${(p2pShare * 100).toFixed(1)}% are expected to finish their trip in Abu Dhabi, and ${(conversion * 100).toFixed(1)}% of those may check into a hotel. Their average stay gives the estimated hotel nights.${upliftNote}`;
     if (/\b(flight|flights|seat|seats|capacity)\b/.test(lower)) {
       detail = `More flights add seats. This plan has ${Math.round(whole).toLocaleString()} seats, so changing flights can change the number of passengers and hotel stays. ${plainResult}`;
     } else if (/\b(load|full|occupancy)\b/.test(lower)) {
       detail = `Flights are expected to be ${(loadFactor * 100).toFixed(1)}% full, or about ${Math.round(passengers).toLocaleString()} passengers out of ${Math.round(whole).toLocaleString()} seats. ${plainResult}`;
     } else if (/\b(p2p|point.to.point|arrival)\b/.test(lower)) {
       detail = `About ${(p2pShare * 100).toFixed(1)}% of passengers, or ${Math.round(result.scenario.p2p).toLocaleString()} people, are expected to finish their flight journey in Abu Dhabi. ${plainResult}`;
     } else if (/\b(conversion|hotel|check.in)\b/.test(lower)) {
       detail = `About ${(conversion * 100).toFixed(1)}% of passengers ending their trip here are estimated to check into a hotel. That is about ${Math.round(result.scenario.hotelCheckins).toLocaleString()} hotel arrivals.`;
     } else if (/\b(stay|night|nights)\b/.test(lower)) {
       detail = `Average stay is how many nights each hotel guest stays. Longer stays increase hotel nights, but don’t change the number of hotel arrivals. ${plainResult}`;
     }
     return {
       type: "answer",
       text: detail,
     };
   }
   const parsed = parseScenarioPrompt(data, prompt, current);
   return {
     type: "apply",
     parsed,
     text: parsed.understood
       ? parsed.summary
       : "I didn’t catch a change. Try: “Add 3 flights from France in December,” or ask how an estimate was worked out.",
   };
 }
  
 export function normalizeBridge(rows) {
   const positive = rows.map((row) => ({ ...row, weight: Math.max(0, Number(row.weight) || 0) }));
   const total = positive.reduce((sum, row) => sum + row.weight, 0);
   if (!total) return positive.map((row) => ({ ...row, weight: 1 / positive.length }));
   return positive.map((row) => ({ ...row, weight: row.weight / total }));
 }
  
export function findRoute(data, originKey, month, proxyOriginKey = "", peerProfile = null) {
   const key = String(originKey || "").trim().toUpperCase();
   const exact = data.routes.find((route) => route.originKey === key && route.month === Number(month));
   if (exact) return { ...exact, loadFactor: Math.min(1, exact.loadFactor), knownMarket: true };
  if (peerProfile?.available) {
    if (peerProfile.month !== Number(month) || peerProfile.country.toUpperCase() !== key) throw new RangeError("The comparison profile must match this country and month.");
    const assumptions = peerProfile.assumptions;
    const invalid = validateScenarioInputs({seatsPerFlight:assumptions.seatsPerFlight,loadFactor:assumptions.loadFactor,p2pShare:assumptions.p2pShare,averageStay:assumptions.averageStay});
    if (invalid) throw new RangeError(invalid);
    return {origin:peerProfile.country,originKey:key,month:Number(month),baselineSeats:0,weeklyFrequency:0,seatsPerFlight:assumptions.seatsPerFlight,loadFactor:assumptions.loadFactor,p2pShare:assumptions.p2pShare,yearsObserved:0,knownMarket:false,proxyOriginKey:peerProfile.primaryPeerOriginKey,peerProfile};
  }
  
  const proxy = data.routes.find((route) => route.originKey === String(proxyOriginKey).toUpperCase() && route.month === Number(month));
  const sameMonth = data.routes.filter((route) => route.month === Number(month));
   const average = (field, fallback) => {
     const values = sameMonth.map((route) => Number(route[field])).filter(Number.isFinite);
     return values.length ? values.reduce((a, b) => a + b, 0) / values.length : fallback;
   };
   return {
     origin: key ? key.replace(/\b\w/g, (letter) => letter.toUpperCase()).toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) : "New market",
     originKey: key || "NEW MARKET",
     month: Number(month),
     baselineSeats: 0,
     weeklyFrequency: 0,
    seatsPerFlight: proxy?.seatsPerFlight ?? average("seatsPerFlight", 220),
    // Aggregate fallbacks are exported from the training period at full precision.
    loadFactor: Math.min(1, proxy?.loadFactor ?? average("loadFactor", data.defaults.loadFactor)),
    p2pShare: proxy?.p2pShare ?? average("p2pShare", data.defaults.p2pShare),
    weeklyFrequency: proxy?.weeklyFrequency ?? 0,
    yearsObserved: 0,
    proxyOriginKey: proxy?.originKey || "",
     knownMarket: false,
   };
 }
  
 export function getBridge(data, originKey, month, overrideRows = null) {
   if (overrideRows?.length) return normalizeBridge(overrideRows);
   const key = String(originKey || "").trim().toUpperCase();
   const source = data.bridge?.[key]?.[String(month)] || data.fallbackBridge?.[String(month)] || [];
   return normalizeBridge(source);
 }
  
 function weightedStay(bridge, fallback = 3.6) {
   if (!bridge.length) return fallback;
   return bridge.reduce((sum, row) => sum + row.weight * (Number(row.averageStay) || fallback), 0);
 }
  
 function chain(seats, loadFactor, p2pShare, conversionRate, averageStay) {
   const passengers = Math.max(0, seats) * Math.max(0, loadFactor);
   const p2p = passengers * Math.max(0, p2pShare);
   const hotelCheckins = p2p * Math.max(0, conversionRate);
   const guestNights = hotelCheckins * Math.max(0, averageStay);
   return { seats, passengers, p2p, hotelCheckins, guestNights };
 }
  
 export function validateScenarioInputs(inputs) {
   const limits = {month:[1,12], extraFlights:[-20,20], seatsPerFlight:[30,600], loadFactor:[0.3,1], p2pShare:[0.05,1], conversionRate:[0.05,0.9], averageStay:[1,10], eventUplift:[0,0.5]};
   for (const [key, [min,max]] of Object.entries(limits)) {
     if (inputs[key] == null) continue;
     const value = inputs[key];
     if (value === "" || !Number.isFinite(Number(value)) || Number(value)<min || Number(value)>max || (key === "month" && !Number.isInteger(Number(value)))) return `${key} must be between ${min} and ${max}.`;
   }
   return "";
 }
 export function runScenario(data, inputs) {
   const error = validateScenarioInputs(inputs);
   if (error) throw new RangeError(error);
   const month = Number(inputs.month || 1);
  const route = findRoute(data, inputs.originKey, month, inputs.proxyOriginKey, inputs.peerProfile);
  const bridgeOrigin = route.knownMarket ? route.originKey : (route.proxyOriginKey || route.originKey);
  const historicalBridge = route.peerProfile ? normalizeBridge(route.peerProfile.bridge) : getBridge(data, bridgeOrigin, month);
  const bridge = inputs.bridgeOverride?.length ? normalizeBridge(inputs.bridgeOverride) : historicalBridge;
   const baseStay = weightedStay(bridge, data.defaults.averageStay);
   const historicalStay = weightedStay(historicalBridge, data.defaults.averageStay);
   const baselineConversion = Number(data.defaults.captureRate);
   const baseline = chain(
     route.baselineSeats,
     route.loadFactor,
     route.p2pShare,
     baselineConversion,
     historicalStay,
   );
  
   const extraFlights = Number(inputs.extraFlights || 0);
   const seatsPerFlight = Math.max(30, Number(inputs.seatsPerFlight || route.seatsPerFlight || 220));
   const scenarioSeats = Math.max(0, route.baselineSeats + extraFlights * seatsPerFlight * weeksInMonth(month));
   const modeledScenario = chain(
     scenarioSeats,
     Number(inputs.loadFactor ?? route.loadFactor),
     Number(inputs.p2pShare ?? route.p2pShare),
     Number(inputs.conversionRate ?? baselineConversion),
     Number(inputs.averageStay ?? baseStay),
   );
   // The optional event/seasonal uplift is an explicit planning assumption.
   // It affects hotel demand only; it does not claim additional flights or
   // passengers, and it is not calibrated from event data.
   const eventUplift = Math.min(0.5, Math.max(0, Number(inputs.eventUplift) || 0));
   const scenario = {
     ...modeledScenario,
     hotelCheckins: modeledScenario.hotelCheckins * (1 + eventUplift),
     guestNights: modeledScenario.guestNights * (1 + eventUplift),
   };
  
   // Preserve each nationality's relative stay pattern while reconciling the
   // nationality allocation to the scenario's selected overall average stay.
   // This makes the contribution rows add back exactly to the headline change.
   const scenarioStayScale = baseStay > 0 ? scenario.guestNights / Math.max(scenario.hotelCheckins * baseStay, 1e-9) : 1;
   const contributions = bridge.map((row) => {
     const stay = Number(row.averageStay || baseStay);
     const historicalRow = historicalBridge.find((item) => item.nationality === row.nationality);
     const baselineNights = baseline.hotelCheckins * (historicalRow?.weight || 0) * Number(historicalRow?.averageStay || historicalStay);
     const scenarioNights = scenario.hotelCheckins * row.weight * stay * scenarioStayScale;
     return {
       ...row,
       baselineGuestNights: baselineNights,
       scenarioGuestNights: scenarioNights,
       deltaGuestNights: scenarioNights - baselineNights,
       deltaCheckins: scenario.hotelCheckins * row.weight - baseline.hotelCheckins * (historicalRow?.weight || 0),
     };
   }).sort((a, b) => Math.abs(b.deltaGuestNights) - Math.abs(a.deltaGuestNights));
  
   const p50 = scenario.guestNights;
   const p10 = p50 * Number(data.defaults.uncertaintyLow || 0.9);
   const p90 = p50 * Number(data.defaults.uncertaintyHigh || 1.1);
   const delta = {
     seats: scenario.seats - baseline.seats,
     passengers: scenario.passengers - baseline.passengers,
     p2p: scenario.p2p - baseline.p2p,
     hotelCheckins: scenario.hotelCheckins - baseline.hotelCheckins,
     guestNights: scenario.guestNights - baseline.guestNights,
   };
   for (const key of Object.keys(delta)) if (Math.abs(delta[key]) < 1e-7) delta[key] = 0;
  
   const confidence = !route.knownMarket
       ? { label: "Low", reason: route.peerProfile ? "There are no past flight records for this country and month. Starting assumptions blend comparison markets; they do not establish demand on the new route." : "There are no past flight records for this country and month, so this estimate starts from another nearby market. Treat it as a rough guide." }
     : route.yearsObserved >= 3
     ? { label: "High", reason: `There are ${route.yearsObserved} past records for this country and month. More matching history is available, but this does not guarantee an accurate estimate.` }
       : { label: "Medium", reason: `There ${route.yearsObserved === 1 ? "is" : "are"} only ${route.yearsObserved} past record${route.yearsObserved === 1 ? "" : "s"} for this country and month, so there is little past information to compare against.` };
  
   return { route, bridge, baseline, scenario, delta, contributions, p10, p50, p90, confidence, eventUplift };
 }
  
 export function sensitivity(data, inputs) {
   const base = runScenario(data, inputs);
   const settings = [
     ["Extra flights each week", "extraFlights", 1],
     ["Seats on each flight", "seatsPerFlight", 30],
     ["How full flights are", "loadFactor", 0.05],
     ["Passengers ending in Abu Dhabi", "p2pShare", 0.05],
     ["Share checking into a hotel", "conversionRate", 0.05],
     ["Average nights per hotel stay", "averageStay", 0.5],
     ["Extra hotel demand for an event or season", "eventUplift", 0.1],
   ];
   return settings.map(([label, key, step]) => {
     const original = Number(inputs[key]);
     const limits = {extraFlights:[-20,20],seatsPerFlight:[30,600],loadFactor:[0.3,1],p2pShare:[0.05,1],conversionRate:[0.05,0.9],averageStay:[1,10],eventUplift:[0,0.5]};
     const low = runScenario(data, { ...inputs, [key]: Math.max(limits[key][0], original - step) }).scenario.guestNights;
     const high = runScenario(data, { ...inputs, [key]: Math.min(limits[key][1], original + step) }).scenario.guestNights;
     return {
       label,
       lowDelta: low - base.scenario.guestNights,
       highDelta: high - base.scenario.guestNights,
       span: Math.abs(high - low),
     };
   }).sort((a, b) => b.span - a.span);
 }
  
 export function parseScenarioPrompt(data, prompt, current) {
   const text = String(prompt || "").trim();
   const lower = text.toLowerCase();
   const changes = {};
   const found = [];
  
   const aliases = {
     USA: "UNITED STATES OF AMERICA",
     US: "UNITED STATES OF AMERICA",
     "UNITED STATES": "UNITED STATES OF AMERICA",
     AMERICA: "UNITED STATES OF AMERICA",
     UK: "UNITED KINGDOM",
     BRITAIN: "UNITED KINGDOM",
     RUSSIA: "RUSSIAN FEDERATION",
     KOREA: "SOUTH KOREA",
   };
   const origins = [...new Map(
     data.routes.map((route) => [route.originKey, route.origin]),
   ).entries()];
   const originCandidates = origins.flatMap(([key, name]) => [
     [key, name],
     ...Object.entries(aliases)
       .filter(([, canonical]) => canonical === key)
       .map(([alias]) => [key, alias]),
   ]).sort(([, first], [, second]) => second.length - first.length);
   const destinationText = lower.match(/\bto\s+(.+)$/)?.[1] || lower;
   const origin = originCandidates.find(([, name]) =>
     new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(destinationText),
   ) || originCandidates.find(([, name]) =>
     new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower),
   );
   if (origin) {
     changes.originKey = origin[0];
     found.push(`origin ${origins.find(([key]) => key === origin[0])?.[1] || origin[1]}`);
   }
  
   const monthIndex = data.months.findIndex((name) => lower.includes(name.toLowerCase()));
   if (monthIndex >= 0) {
     changes.month = monthIndex + 1;
     found.push(`month ${data.months[monthIndex]}`);
   }

   const targetOriginKey = changes.originKey || current.originKey;
   const targetMonth = changes.month || current.month;
   const routeChanged = targetOriginKey !== current.originKey || targetMonth !== current.month;
   const targetRoute = findRoute(data, targetOriginKey, targetMonth);
   const targetBridge = getBridge(data, targetRoute.originKey, targetMonth);
   const targetAverageStay = weightedStay(targetBridge, data.defaults.averageStay);
   const routeDefaults = routeChanged
     ? {
       extraFlights: 3,
       eventUplift: 0,
       conversionRate: data.defaults.captureRate,
       proxyOriginKey: "",
       peerProfile: null,
       referenceMode: "single",
       routePurpose: "mixed",
       purposeAssumptionsApplied: false,
       seasonalConversion: false,
       seatsPerFlight: targetRoute.seatsPerFlight || 220,
       loadFactor: targetRoute.loadFactor,
       p2pShare: targetRoute.p2pShare,
       averageStay: targetAverageStay,
     }
     : {};
  
   const flightMatch = lower.match(/(-?\d+(?:\.\d+)?)\s*(?:extra|additional|more|fewer|less)?\s*(?:weekly\s*)?flights?/);
   if (flightMatch) {
     let value = Number(flightMatch[1]);
     if (/fewer|less|reduce|remove|cancel/.test(lower)) value = -Math.abs(value);
     changes.extraFlights = value;
     found.push(`${value >= 0 ? "+" : ""}${value} flights each week`);
   }

   const eventUpliftMatch = lower.match(/(?:event|seasonal|demand)\s+(?:period\s+)?(?:uplift|increase)(?:\s+of|\s+to|\s+at)?\s*(-?\d+(?:\.\d+)?)\s*(?:%|percent)/);
   if (eventUpliftMatch) {
     const value = Number(eventUpliftMatch[1]);
     changes.eventUplift = value / 100;
     found.push(`${value}% extra hotel demand for an event or season`);
   }
  
   const seatsMatch = lower.match(/\b(\d+(?:\.\d+)?)\s*seats?/);
   if (seatsMatch) {
     changes.seatsPerFlight = Number(seatsMatch[1]);
     found.push(`${seatsMatch[1]} seats per flight`);
   }



  // Load factor: only match numbers associated with load factor,
  // occupancy, or filled.
  const loadMatch =
    lower.match(/(-?\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:load factor|occupancy|filled)/) ||
    lower.match(/(?:load factor|occupancy|filled)[^\d-]{0,12}(-?\d+(?:\.\d+)?)\s*(?:%|percent)?/);

  if (loadMatch) {
    const value = Number(loadMatch[1]);
    changes.loadFactor = value / 100;
    found.push(`${value}% of flight seats expected to be filled`);
  }

  // Hotel conversion: only match numbers associated with conversion
  // or hotel capture, never load factor or occupancy.
  const conversionMatch =
    lower.match(/(?:hotel\s+conversion(?:\s+rate)?|conversion(?:\s+rate)?|hotel\s+capture)[^\d-]{0,25}(-?\d+(?:\.\d+)?)\s*(?:%|percent)?/) ||
    lower.match(/(-?\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:hotel\s+conversion(?:\s+rate)?|conversion(?:\s+rate)?|hotel\s+capture)/);

  if (conversionMatch) {
    const value = Number(conversionMatch[1]);
    changes.conversionRate = value / 100;
    found.push(`${value}% estimated to stay in a hotel`);
  }



   const p2pMatch = lower.match(/p2p[^\d]{0,12}(\d{1,3}(?:\.\d+)?)\s*%/);
   if (p2pMatch) {
     changes.p2pShare = Number(p2pMatch[1]) / 100;
     found.push(`${p2pMatch[1]}% of passengers ending their trip in Abu Dhabi`);
   }


  
   const stayMatch = lower.match(/(?:stay|length of stay)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:days?|nights?)/);
   if (stayMatch) {
     changes.averageStay = Number(stayMatch[1]);
     found.push(`${stayMatch[1]} nights per hotel stay`);
   }
  
   const next = { ...current, ...routeDefaults, ...changes };
   return {
     inputs: next,
     changes: { ...changes },
     understood: found.length > 0,
     summary: found.length
       ? `I updated the plan using: ${found.join(", ")}.`
       : "I didn’t catch a change. Try: “Add 3 flights from France in December,” or ask how an estimate was worked out.",
   };
 }

// Confirm from the state read back from the controls, after applying the plan.
export function appliedPlanConfirmation(data, applied, changes = {}) {
  const error = validateScenarioInputs(applied);
  if (error) throw new RangeError(error);
  const route = findRoute(data, applied.originKey, applied.month, applied.proxyOriginKey, applied.peerProfile);
  const number = (value) => Number(Number(value).toFixed(6)).toLocaleString("en-US", {maximumFractionDigits:6});
  const labels = {
    extraFlights: () => `${number(applied.extraFlights)} extra flights each week`,
    seatsPerFlight: () => `${number(applied.seatsPerFlight)} seats per flight`,
    loadFactor: () => `${number(applied.loadFactor * 100)}% flight occupancy`,
    p2pShare: () => `${number(applied.p2pShare * 100)}% finishing their trip in Abu Dhabi`,
    conversionRate: () => `${number(applied.conversionRate * 100)}% hotel use`,
    averageStay: () => `${number(applied.averageStay)} nights per hotel stay`,
    eventUplift: () => `${number(applied.eventUplift * 100)}% extra event or seasonal demand`,
  };
  const values = Object.keys(labels).filter((key) => changes[key] !== undefined).map((key) => labels[key]());
  return `Applied to ${route.origin} in ${data.months[applied.month - 1]}: ${values.length ? values.join(", ") : "the starting assumptions shown in the controls"}.`;
}
