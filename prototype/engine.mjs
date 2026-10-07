 const MONTH_DAYS = [31, 28.25, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  
 export function weeksInMonth(monthNumber) {
   return MONTH_DAYS[Math.max(1, Math.min(12, monthNumber)) - 1] / 7;
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
  
   const origins = [...new Set(data.routes.map((route) => route.origin))].sort((a, b) => b.length - a.length);
   const origin = origins.find((name) => lower.includes(name.toLowerCase()));
   if (origin) {
     changes.originKey = origin.toUpperCase();
     found.push(`origin ${origin}`);
   }
  
   const monthIndex = data.months.findIndex((name) => lower.includes(name.toLowerCase()));
   if (monthIndex >= 0) {
     changes.month = monthIndex + 1;
     found.push(`month ${data.months[monthIndex]}`);
   }
  
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
  
   const loadMatch = lower.match(/(?:load factor|filled|occupancy)[^\d]{0,12}(\d{1,3}(?:\.\d+)?)\s*%/)
     || lower.match(/(\d{1,3}(?:\.\d+)?)\s*%[^,.]{0,12}(?:load factor|filled|occupancy)/);
   if (loadMatch) {
     changes.loadFactor = Number(loadMatch[1]) / 100;
     found.push(`${loadMatch[1]}% load factor`);
   }
  
   const p2pMatch = lower.match(/p2p[^\d]{0,12}(\d{1,3}(?:\.\d+)?)\s*%/);
   if (p2pMatch) {
     changes.p2pShare = Number(p2pMatch[1]) / 100;
     found.push(`${p2pMatch[1]}% P2P share`);
   }
  
   const conversionMatch = lower.match(/(?:conversion|hotel capture)[^\d]{0,12}(\d{1,3}(?:\.\d+)?)\s*%/);
   if (conversionMatch) {
     changes.conversionRate = Number(conversionMatch[1]) / 100;
     found.push(`${conversionMatch[1]}% hotel conversion`);
   }
  
   const stayMatch = lower.match(/(?:stay|length of stay)[^\d]{0,12}(\d+(?:\.\d+)?)\s*(?:days?|nights?)/);
   if (stayMatch) {
     changes.averageStay = Number(stayMatch[1]);
     found.push(`${stayMatch[1]}-day average stay`);
   }
  
   const next = { ...current, ...changes };
   return {
     inputs: next,
     understood: found.length > 0,
     summary: found.length
       ? `I understood: ${found.join(", ")}. I applied these values to the same audited scenario engine.`
       : "I could not find a route, month or number to change. Try: Add 3 weekly flights from France in December with 220 seats and an 84% load factor.",
   };
 }
