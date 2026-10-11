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
   const plainResult = `This scenario creates ${Math.round(result.scenario.hotelCheckins).toLocaleString()} hotel check-ins and ${Math.round(result.scenario.guestNights).toLocaleString()} guest nights (${signedNights} guest nights versus the baseline).`;
   if (/\b(reset|clear|start over)\b/.test(lower)) {
     return { type: "reset", text: "I reset the scenario to the default India, December starting point." };
   }
   if (/\b(what changed|what did you change|summary|status)\b/.test(lower)) {
     return {
       type: "answer",
       text: `The live scenario is ${result.route.origin} in ${data.months[result.route.month - 1]}. ${plainResult}`,
     };
   }
   if (/\b(why|explain|how did|where does)\b/.test(lower)) {
     let detail = `We start with ${Math.round(whole).toLocaleString()} seats. At ${(loadFactor * 100).toFixed(1)}% full, that gives ${Math.round(passengers).toLocaleString()} passengers. ${(p2pShare * 100).toFixed(1)}% are counted as P2P arrivals, and ${(conversion * 100).toFixed(1)}% of those become hotel check-ins. The average stay then turns check-ins into guest nights.`;
     if (/\b(flight|flights|seat|seats|capacity)\b/.test(lower)) {
       detail = `Flights add capacity. This scenario has ${Math.round(whole).toLocaleString()} seats, so more seats can create more passengers and hotel demand. ${plainResult}`;
     } else if (/\b(load|full|occupancy)\b/.test(lower)) {
       detail = `Load factor means how full the aircraft are. At ${(loadFactor * 100).toFixed(1)}%, about ${Math.round(passengers).toLocaleString()} of ${Math.round(whole).toLocaleString()} seats are filled. ${plainResult}`;
     } else if (/\b(p2p|point.to.point|arrival)\b/.test(lower)) {
       detail = `P2P share is the percentage of passengers whose airport journey ends in Abu Dhabi. Here it is ${(p2pShare * 100).toFixed(1)}%, or about ${Math.round(result.scenario.p2p).toLocaleString()} people. ${plainResult}`;
     } else if (/\b(conversion|hotel|check.in)\b/.test(lower)) {
       detail = `Hotel conversion is the share of P2P passengers estimated to check into a hotel. Here it is ${(conversion * 100).toFixed(1)}%, producing about ${Math.round(result.scenario.hotelCheckins).toLocaleString()} check-ins.`;
     } else if (/\b(stay|night|nights)\b/.test(lower)) {
       detail = `Average stay is the number of nights per hotel check-in. Longer stays increase guest nights without changing the number of check-ins. ${plainResult}`;
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
       : "Ask me a scenario, ask what changed, or ask why the demand moved. For example: “Add 3 weekly flights from India in December.”",
   };
 }
  
 export function normalizeBridge(rows) {
   const positive = rows.map((row) => ({ ...row, weight: Math.max(0, Number(row.weight) || 0) }));
   const total = positive.reduce((sum, row) => sum + row.weight, 0);
   if (!total) return positive.map((row) => ({ ...row, weight: 1 / positive.length }));
   return positive.map((row) => ({ ...row, weight: row.weight / total }));
 }
  
 export function findRoute(data, originKey, month) {
   const key = String(originKey || "").trim().toUpperCase();
   const exact = data.routes.find((route) => route.originKey === key && route.month === Number(month));
   if (exact) return { ...exact, knownMarket: true };
  
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
     seatsPerFlight: Math.round(average("seatsPerFlight", 220)),
     loadFactor: average("loadFactor", 0.824),
     p2pShare: average("p2pShare", 0.509),
     yearsObserved: 0,
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
  
 export function runScenario(data, inputs) {
   const month = Number(inputs.month || 1);
   const route = findRoute(data, inputs.originKey, month);
   const bridge = getBridge(data, route.originKey, month, inputs.bridgeOverride);
   const baseStay = weightedStay(bridge, data.defaults.averageStay);
   const baselineConversion = Number(data.defaults.captureRate);
   const baseline = chain(
     route.baselineSeats,
     route.loadFactor,
     route.p2pShare,
     baselineConversion,
     baseStay,
   );
  
   const extraFlights = Number(inputs.extraFlights || 0);
   const seatsPerFlight = Math.max(30, Number(inputs.seatsPerFlight || route.seatsPerFlight || 220));
   const scenarioSeats = Math.max(0, route.baselineSeats + extraFlights * seatsPerFlight * weeksInMonth(month));
   const scenario = chain(
     scenarioSeats,
     Number(inputs.loadFactor ?? route.loadFactor),
     Number(inputs.p2pShare ?? route.p2pShare),
     Number(inputs.conversionRate ?? baselineConversion),
     Number(inputs.averageStay ?? baseStay),
   );
  
   // Preserve each nationality's relative stay pattern while reconciling the
   // nationality allocation to the scenario's selected overall average stay.
   // This makes the contribution rows add back exactly to the headline change.
   const scenarioStayScale = baseStay > 0 ? scenario.guestNights / Math.max(scenario.hotelCheckins * baseStay, 1e-9) : 1;
   const contributions = bridge.map((row) => {
     const stay = Number(row.averageStay || baseStay);
     const baselineNights = baseline.hotelCheckins * row.weight * stay;
     const scenarioNights = scenario.hotelCheckins * row.weight * stay * scenarioStayScale;
     return {
       ...row,
       baselineGuestNights: baselineNights,
       scenarioGuestNights: scenarioNights,
       deltaGuestNights: scenarioNights - baselineNights,
       deltaCheckins: (scenario.hotelCheckins - baseline.hotelCheckins) * row.weight,
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
  
   const confidence = !route.knownMarket
     ? { label: "Low", reason: "Low data support: there is no matching route history for this departure country and month, so Air2Stay uses seasonal fallback assumptions." }
     : route.yearsObserved >= 3
       ? { label: "High", reason: `High data support: the supplied flight file contains ${route.yearsObserved} historical observations for this departure country and month. This is a coverage rule, not a 95% confidence interval.` }
       : { label: "Medium", reason: `Medium data support: the route exists, but only ${route.yearsObserved} historical observation${route.yearsObserved === 1 ? " is" : "s are"} available for this month.` };
  
   return { route, bridge, baseline, scenario, delta, contributions, p10, p50, p90, confidence };
 }
  
 export function sensitivity(data, inputs) {
   const base = runScenario(data, inputs);
   const settings = [
     ["Extra weekly flights", "extraFlights", 1],
     ["Seats per flight", "seatsPerFlight", 30],
     ["Load factor", "loadFactor", 0.05],
     ["P2P share", "p2pShare", 0.05],
     ["Hotel conversion", "conversionRate", 0.05],
     ["Average stay", "averageStay", 0.5],
   ];
   return settings.map(([label, key, step]) => {
     const original = Number(inputs[key]);
     const low = runScenario(data, { ...inputs, [key]: Math.max(0, original - step) }).scenario.guestNights;
     const high = runScenario(data, { ...inputs, [key]: original + step }).scenario.guestNights;
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
       seatsPerFlight: Math.round(targetRoute.seatsPerFlight || 220),
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
  
   const seatsMatch = lower.match(/(\d{2,3})\s*seats?/);
   if (seatsMatch) {
     changes.seatsPerFlight = Number(seatsMatch[1]);
     found.push(`${seatsMatch[1]} seats per flight`);
   }



  // Load factor: only match numbers associated with load factor,
  // occupancy, or filled.
  const loadMatch =
    lower.match(/(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)\s*(?:load factor|occupancy|filled)/) ||
    lower.match(/(?:load factor|occupancy|filled)\D{0,12}(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)?/);

  if (loadMatch) {
    const value = Number(loadMatch[1]);
    if (value >= 0 && value <= 100) {
      changes.loadFactor = value / 100;
      found.push(`${value}% load factor`);
    }
  }

  // Hotel conversion: only match numbers associated with conversion
  // or hotel capture, never load factor or occupancy.
  const conversionMatch =
    lower.match(/(?:hotel\s+conversion(?:\s+rate)?|conversion(?:\s+rate)?|hotel\s+capture)[^\d]{0,25}(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)?/) ||
    lower.match(/(\d{1,3}(?:\.\d+)?)\s*(?:%|percent)\s*(?:hotel\s+conversion(?:\s+rate)?|conversion(?:\s+rate)?|hotel\s+capture)/);

  if (conversionMatch) {
    const value = Number(conversionMatch[1]);
    if (value >= 0 && value <= 100) {
      changes.conversionRate = value / 100;
      found.push(`${value}% hotel conversion`);
    }
  }



   const p2pMatch = lower.match(/p2p[^\d]{0,12}(\d{1,3}(?:\.\d+)?)\s*%/);
   if (p2pMatch) {
     changes.p2pShare = Number(p2pMatch[1]) / 100;
     found.push(`${p2pMatch[1]}% P2P share`);
   }


  
   const stayMatch = lower.match(/(?:stay|length of stay)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:days?|nights?)/);
   if (stayMatch) {
     changes.averageStay = Number(stayMatch[1]);
     found.push(`${stayMatch[1]}-day average stay`);
   }
  
   const next = { ...current, ...routeDefaults, ...changes };
   return {
     inputs: next,
     understood: found.length > 0,
     summary: found.length
       ? `I understood: ${found.join(", ")}. I applied these values to the same audited scenario engine.`
       : "Ask me a scenario, ask what changed, or ask why the demand moved. For example: “Add 3 weekly flights from France in December.”",
   };
 }
