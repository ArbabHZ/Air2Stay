 import { assistantReply, appliedPlanConfirmation, findRoute, getBridge, weeksInMonth, parseScenarioPrompt, runScenario, sensitivity, validateScenarioInputs } from "./engine.mjs";
import { buildPeerProfile, validatePeerMethod } from "./route_planning.mjs";
import { ROUTE_PURPOSES, applyRoutePurpose, planningMetrics, compareOptions, compareMonths, launchOptions, stressTest, solveCapacityTarget, reverseTargetPlan, rankingReversals, decisionNote, nextStepPlan, nextStepLines } from "./decision_tools.mjs";
import { CONVERSION_EVIDENCE } from "./conversion_evidence.mjs";
import { createProposalWorkspace } from "./proposal_workspace.mjs";
import { createGuidedHelp } from "./guided_help.mjs";
import { planningChatReply, parseTargetQuestion, arabicPromptToEnglish, pcMessagesQuery, pcMessagesReply, pcFixTypos } from "./planning_chat.mjs";
  
 const chatEnabled = globalThis.__AIR2STAY_CHAT_ENABLED__ === true;
 const $ = (selector) => document.querySelector(selector);
 const $$ = (selector) => [...document.querySelectorAll(selector)];
 const formatNumber = (value) => Math.round(value || 0).toLocaleString("en-US");
 const formatSigned = (value) => `${value >= 0 ? "+" : "−"}${formatNumber(Math.abs(value))}`;
 const formatPercent = (value, digits = 0) => `${(Number(value) * 100).toFixed(digits)}%`;
  
 let data;
let countryLocationLookup = {};
 let state;
 let bridgeOverride = null;
 let bridgeDraft = [];
 let bridgeEditing = false;
 let lastRenderedRouteKey = null;
 let renderQueued = false;
 let assistantPromptDirty = false;
let confirmedNewMarketKey = "";
let assistantBusy = false;
 let proposalWorkspace = null;
 let guidedHelp = null;
 let currentProposalContext = null;
 let assistantProposalKey = "";
 let assistantSequence = 0;
 let assistantGeneration = 0;
let lastExportUrl = "";
let peerValidationResult = null;
let targetSolution = null;
let targetAnswer = null;
let teamSnapshot = () => null;
 let assistantMessages = [
   { role: "bot", text: "Hi! Ask what changed, ask how a number was worked out, or tell me what you’d like to change." },
 ];
  
 async function loadData() {
  if (window.__AIR2STAY_SCENARIO_DATA__) {
    data = window.__AIR2STAY_SCENARIO_DATA__;
    countryLocationLookup = buildCountryLocationLookup(window.__AIR2STAY_COUNTRY_LOCATIONS__);
    return;
  }
  const [scenarioResponse, locationsResponse] = await Promise.all([
    fetch("./data/scenario_data.json"),
    fetch("./data/country_locations.json"),
  ]);
  if (!scenarioResponse.ok || !locationsResponse.ok) throw new Error("Could not load the model or country-location data.");
  data = await scenarioResponse.json();
  countryLocationLookup = buildCountryLocationLookup(await locationsResponse.json());
 }

function normalizeCountryName(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function buildCountryLocationLookup(source) {
  const lookup = {};
  // Register canonical country names before aliases. Some territories list
  // their parent state as an alias (for example Åland lists Finland), and
  // that alias must never replace the actual country's own map record.
  for (const country of source?.countries || []) {
    const key = normalizeCountryName(country.name);
    if (key) lookup[key] = country;
  }
  for (const country of source?.countries || []) {
    for (const alias of country.aliases || []) {
      const key = normalizeCountryName(alias);
      if (key && !lookup[key]) lookup[key] = country;
    }
  }
  return lookup;
}
  
 function knownOrigins() {
   return [...new Map(data.routes.map((route) => [route.originKey, route.origin])).entries()]
     .map(([key, name]) => ({ key, name }))
     .sort((a, b) => a.name.localeCompare(b.name));
 }

function recommendProxy(country, month) {
  const key = normalizeCountryName(country);
  const newLocation = countryLocationLookup[key];
  const routeMarkets = [...new Map(
    data.routes.filter((route) => route.month === Number(month))
      .map((route) => [route.originKey, route.origin]),
  ).entries()];
  const distanceKm = (a, b) => {
    const radians = (degrees) => degrees * Math.PI / 180;
    const [lon1, lat1] = a;
    const [lon2, lat2] = b;
    const dLat = radians(lat2 - lat1);
    const dLon = radians(lon2 - lon1);
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  };
  const proxy = newLocation
    ? routeMarkets.map(([originKey, origin]) => {
      const location = countryLocationLookup[normalizeCountryName(origin)]
        || countryLocationLookup[normalizeCountryName(originKey)];
      return location ? { originKey, origin, distance: distanceKm(newLocation.coordinates, location.coordinates) } : null;
    }).filter(Boolean).sort((a, b) => a.distance - b.distance)[0]?.originKey
    : "SAUDI ARABIA";
  const selectedProxy = proxy || routeMarkets.find(([originKey]) => originKey === "SAUDI ARABIA")?.[0] || routeMarkets[0]?.[0] || "SAUDI ARABIA";
  const proxyName = routeMarkets.find(([originKey]) => originKey === selectedProxy)?.[1] || selectedProxy;
  return {
    proxy: selectedProxy,
    reason: newLocation
      ? `${proxyName} is the closest place with past flight records. We’ll use its numbers as a rough starting point; it may not behave like ${country}.`
      : `${proxyName} is used as a rough starting point because we don’t have a location record for this place.`,
  };
}
  
function defaultState(originKey = "INDIA", month = 12, proxyOriginKey = "INDIA") {
  const referenceMode = proxyOriginKey === "__PEERS__" ? "peers" : "single";
  const known = data.routes.some((item) => item.originKey === String(originKey).toUpperCase() && item.month === Number(month));
  const peerProfile = referenceMode === "peers" && !known ? buildPeerProfile(data, countryLocationLookup, originKey, month) : null;
  const route = findRoute(data, originKey, month, peerProfile?.primaryPeerOriginKey || proxyOriginKey, peerProfile?.available ? peerProfile : null);
  const bridgeKey = route.knownMarket ? route.originKey : (route.proxyOriginKey || route.originKey);
  const bridge = peerProfile?.available ? peerProfile.bridge : (data.bridge?.[bridgeKey]?.[String(month)] || data.fallbackBridge[String(month)]);
   const averageStay = bridge.reduce((sum, row) => sum + row.weight * row.averageStay, 0) /
     bridge.reduce((sum, row) => sum + row.weight, 0);
   return {
     originKey: route.originKey,
     referenceMode: known ? "single" : referenceMode, peerProfile: peerProfile?.available ? peerProfile : null,
     routePurpose: "mixed", purposeAssumptionsApplied: false, seasonalConversion: false,
    proxyOriginKey: route.knownMarket ? "" : (route.proxyOriginKey || proxyOriginKey),
     month,
     extraFlights: 3,
     seatsPerFlight: route.seatsPerFlight || 220,
     loadFactor: Math.min(1, route.loadFactor || 0.82),
     p2pShare: route.p2pShare || 0.51,
     conversionRate: data.defaults.captureRate,
     averageStay,
     eventUplift: 0,
   };
 }

function populatePurposeInputs() {
  for (const [id,value,digits] of [["purposeHotelShare",state.conversionRate*100,1],["purposeStay",state.averageStay,2]]) {
    const field=$("#"+id); field.value=value.toFixed(digits); field.dataset.displayed=field.value; field.dataset.exact=String(value);
  }
}
  
 function setFormFromState() {
   const known = knownOrigins().some((origin) => origin.key === state.originKey);
   $("#origin").value = known ? state.originKey : "__NEW_ROUTE__";
   $("#newMarketField").hidden = known;
   const hasNewCountry = !known && Boolean(confirmedNewMarketKey && confirmedNewMarketKey === state.originKey);
   $("#proxyMarketField").hidden = !hasNewCountry;
   $("#confirmNewMarket").hidden = known;
   $("#newMarketStatus").hidden = known || hasNewCountry;
   if (hasNewCountry) {
     $("#proxyMarket").value = state.referenceMode === "peers" ? "__PEERS__" : state.proxyOriginKey;
     const selectedCountry = countryLocationLookup[normalizeCountryName(state.originKey)];
     if (selectedCountry) $("#newMarketCountry").value = localizedName(selectedCountry.name);
     const recommendation = recommendProxy(state.originKey, state.month);
     $("#proxyMarketReason").textContent = state.peerProfile
       ? state.peerProfile.peers.map((peer) => peer.origin + " " + formatPercent(peer.weight,1)).join(" · ") + ". Geography and approximate route length supply starting assumptions only."
       : `${state.proxyOriginKey} is your chosen starting country. This is an assumption, not evidence of demand on the proposed route.`;
   }
   $("#month").value = String(state.month);
   $("#routePurpose").value = state.routePurpose || "mixed";
   $("#purposeAssumptions").hidden = $("#routePurpose").value === "mixed";
   populatePurposeInputs();
   $("#extraFlights").value = state.extraFlights;
   $("#seatsPerFlight").value = Math.round(state.seatsPerFlight);
   $("#loadFactor").value = (state.loadFactor * 100).toFixed(1);
   $("#p2pShare").value = (state.p2pShare * 100).toFixed(1);
   $("#conversionRate").value = (state.conversionRate * 100).toFixed(1);
   $("#averageStay").value = Number(state.averageStay).toFixed(2);
   $("#eventUplift").value = Math.round((state.eventUplift || 0) * 100);
   updateRangeLabels();
   // Keep the original numbers while displaying readable rounded controls.
   for (const [id, value] of Object.entries({extraFlights: state.extraFlights, seatsPerFlight: state.seatsPerFlight, loadFactor: state.loadFactor * 100, p2pShare: state.p2pShare * 100, conversionRate: state.conversionRate * 100, averageStay: state.averageStay, eventUplift: state.eventUplift * 100})) {
     const field = $(`#${id}`);
     field.dataset.displayed = field.value;
     field.dataset.exact = String(value);
   }
 }
  
 function updateRangeLabels() {
   $("#extraFlightsValue").textContent = `${Number($("#extraFlights").value) >= 0 ? "+" : ""}${$("#extraFlights").value}`;
   $("#loadFactorValue").textContent = `${Number($("#loadFactor").value).toFixed(1)}%`;
   $("#p2pShareValue").textContent = `${Number($("#p2pShare").value).toFixed(1)}%`;
   $("#conversionRateValue").textContent = `${Number($("#conversionRate").value).toFixed(1)}%`;
   $("#eventUpliftValue").textContent = `+${Number($("#eventUplift").value)}%`;
 }

 function clearAssistantPrompt() {
   $("#smartPrompt").value = "";
   assistantPromptDirty = false;
 }

 function renderAssistantChat() {
   const messages = assistantMessages.map((message) => {
     const element = document.createElement("div");
     element.className = `assistant-message ${message.role}`;
     if (message.matchesCurrentPlan === false) {
       const contextLabel = document.createElement("small");
       contextLabel.className="answer-source previous-plan";
       contextLabel.textContent="Earlier assumptions · this message may describe different numbers";
       element.append(contextLabel);
     }
     if (message.role === "user") {
       element.append(document.createTextNode(message.text));
     } else {
       let list = null;
       let paragraph = null;
       for (const raw of message.text.split(/\r?\n/)) {
         const line = raw.trim();
         if (!line) { list = null; paragraph = null; continue; }
         const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
         let target;
         if (bullet) {
           paragraph = null;
           if (!list) { list = document.createElement("ul"); element.append(list); }
           target = document.createElement("li");
           list.append(target);
         } else {
           list = null;
           if (!paragraph) { paragraph = document.createElement("p"); element.append(paragraph); }
           else paragraph.append(document.createTextNode(" "));
           target = paragraph;
         }
         const text = bullet ? bullet[1] : line;
         for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
           if (part.startsWith("**") && part.endsWith("**")) {
             const strong = document.createElement("strong");
             strong.textContent = part.slice(2, -2);
             target.append(strong);
           } else target.append(document.createTextNode(part));
         }
       }
     }
     if (message.role === "bot" && message.text !== "Thinking…" && message.source) {
       const source = document.createElement("small");
       source.className = "answer-source";
       source.textContent = message.source === "ai" ? "AI explanation · check against Details" : message.matchesCurrentPlan === false ? "Saved explanation for the earlier plan" : "From this plan and its recorded checks";
       element.append(source);
       message.id ||= `answer-${Date.now()}-${++assistantSequence}`;
       guidedHelp?.addFeedback({element, id:message.id, label:"Assistant answer"});
     }
     return element;
   });
   $("#assistantChat").replaceChildren(...messages);
   $("#assistantChat").scrollTop = $("#assistantChat").scrollHeight;
 }

 function clearAssistantChat() {
   assistantGeneration++;
   proposalWorkspace?.clearDiscussion();
   assistantMessages = [
     { role: "bot", text: "Hi! Ask what changed, ask how a number was worked out, or tell me what you’d like to change." },
   ];
   renderAssistantChat();
   setAssistantExpanded(false);
   $("#smartPrompt").value = "";
   assistantPromptDirty = false;
 }

 function setAssistantExpanded(expanded) {
   $(".smart-box").classList.toggle("assistant-collapsed", !expanded);
 }
  
 function readForm() {
   const number = (id) => {
     const field = $(`#${id}`);
     return field.value === field.dataset.displayed ? Number(field.dataset.exact) : Number(field.value);
   };
   state = {
     ...state,
     originKey: $("#origin").value === "__NEW_ROUTE__"
       ? (confirmedNewMarketKey || state.originKey)
       : $("#origin").value.trim().toUpperCase(),
     proxyOriginKey: $("#origin").value === "__NEW_ROUTE__" && confirmedNewMarketKey ? ($("#proxyMarket").value === "__PEERS__" ? state.peerProfile?.primaryPeerOriginKey || "" : $("#proxyMarket").value) : "",
     routePurpose: $("#routePurpose").value,
     month: Number($("#month").value),
     extraFlights: number("extraFlights"),
     seatsPerFlight: number("seatsPerFlight"),
     loadFactor: number("loadFactor") / 100,
     p2pShare: number("p2pShare") / 100,
     conversionRate: number("conversionRate") / 100,
     averageStay: number("averageStay"),
     eventUplift: number("eventUplift") / 100,
     bridgeOverride,
   };
   updateRangeLabels();
 }
  
 function kpiCard(label, value, note, tone = "neutral") {
   return `<article class="kpi ${tone}"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`;
 }
  
 function sparklineSvg(values, selectedIndex, { label, format }) {
   const valid = values.filter(Number.isFinite);
   const min = Math.min(...valid);
   const max = Math.max(...valid);
   const spread = max - min;
   const x = (index) => 5 + index * 10;
   const y = (value) => spread ? 34 - 34 * ((value - min) / spread + 0.1) / 1.2 : 17;
   const segments = [];
   let segment = [];
   const hits = values.map((value, index) => {
     if (!Number.isFinite(value)) {
       segment = [];
       return "";
     }
     if (!segment.length) segments.push(segment);
     segment.push([x(index), y(value)]);
     return `<rect x="${x(index) - 5}" width="10" height="34" fill="transparent"><title>${data.months[index].slice(0, 3)}: ${format(value)}</title></rect>`;
   });
   const paths = segments.map((points) => {
     // Ease through the month values without overshooting local peaks or dips.
     const steps = points.slice(1).map((point, index) => point[1] - points[index][1]);
     const tangents = points.map((_, index) => {
       const before = steps[index - 1];
       const after = steps[index];
       if (before === undefined || after === undefined) return before ?? after ?? 0;
       return before * after > 0 ? 2 * before * after / (before + after) : 0;
     });
     const curves = points.slice(1).map(([endX, endY], index) => {
       const [startX, startY] = points[index];
       const third = (endX - startX) / 3;
       return `C${startX + third},${startY + tangents[index] / 3} ${endX - third},${endY - tangents[index + 1] / 3} ${endX},${endY}`;
     });
     const line = `M${points[0].join(",")} ${curves.join(" ")}`;
     return `<path class="result-spark-area" d="${line} L${points.at(-1)[0]},34 H${points[0][0]} Z"/><path class="result-spark-line" d="${line}" vector-effect="non-scaling-stroke"/>`;
   }).join("");
   const zeroLine = min < 0 && max > 0
     ? `<path class="result-spark-zero" d="M0,${y(0)} H120" vector-effect="non-scaling-stroke"/>` : "";
   const dot = Number.isFinite(values[selectedIndex])
     ? `<span class="result-spark-dot" style="left:${x(selectedIndex) / 1.2}%;top:${y(values[selectedIndex])}px" aria-hidden="true"></span>` : "";
   const summary = valid.length
     ? `${label} by month, highest in ${data.months[values.indexOf(max)]} at ${format(max)}, lowest in ${data.months[values.indexOf(min)]} at ${format(min)}.`
     : `${label} by month. No monthly estimates available.`;
   const shape = values.map((value) => Number(Number.isFinite(value))).join("") + Number(Boolean(zeroLine)) + Number(Boolean(dot));
   return `<div class="result-spark" dir="ltr" data-shape="${shape}"><svg viewBox="0 0 120 34" preserveAspectRatio="none" role="img" aria-label="${planningEscape(summary)}">${zeroLine}${paths}${hits.join("")}</svg>${dot}</div>`;
 }

 function updateKpiTiles(markup) {
   const container = $("#kpis");
   const template = document.createElement("template");
   template.innerHTML = markup;
   [...template.content.children].forEach((next, index) => {
     const tile = container.children[index];
     if (!tile) {
       container.append(next);
       return;
     }
     const chart = tile.lastElementChild;
     const nextChart = next.lastElementChild;
     if (tile.className !== next.className || !chart.dataset.shape || chart.dataset.shape !== nextChart.dataset.shape) {
       tile.replaceWith(next);
       return;
     }
     [...next.children].slice(0, -1).forEach((element, i) => {
       tile.children[i].className = element.className;
       tile.children[i].textContent = element.textContent;
     });
     // Keep matching chart elements mounted so changes in geometry can transition.
     const svg = chart.firstElementChild;
     const nextSvg = nextChart.firstElementChild;
     svg.setAttribute("aria-label", nextSvg.getAttribute("aria-label"));
     [...nextSvg.children].forEach((element, i) => {
       const current = svg.children[i];
       if (element.localName === "path") current.setAttribute("d", element.getAttribute("d"));
       else current.firstElementChild.textContent = element.firstElementChild.textContent;
     });
     const dot = chart.querySelector(".result-spark-dot");
     if (dot) dot.style.cssText = nextChart.lastElementChild.style.cssText;
   });
 }

 function resultRange(result) {
   const { p10, p50, p90, baseline } = result;
   const min = Math.min(p10, baseline.guestNights);
   const max = Math.max(p90, baseline.guestNights);
   const padding = (max - min) * 0.08 || 1;
   const x = (value) => 120 * (value - min + padding) / (max - min + 2 * padding);
   const estimate = Math.min(120, Math.max(0, x(p50)));
   const description = `Possible range ${formatNumber(p10)} to ${formatNumber(p90)}; estimate ${formatNumber(p50)}. History-based planning guide, not a guaranteed probability range.`;
   return `<div class="result-range" dir="ltr" role="img" tabindex="0" title="${description}" aria-label="${description}">
     <svg viewBox="0 0 120 34" preserveAspectRatio="none" aria-hidden="true">
       <rect class="result-range-track" y="10" width="120" height="14" rx="6"/>
       <rect class="result-range-band" x="${x(p10)}" y="10" width="${x(p90) - x(p10)}" height="14" rx="6"/>
       <path class="result-range-marker" d="M${estimate},8 V26" vector-effect="non-scaling-stroke"/>
     </svg><span class="result-range-tooltip" aria-hidden="true">${description}</span>
   </div>`;
 }

 function renderKpis(result) {
   const selectedIndex = state.month - 1;
   const monthName = data.months[selectedIndex];
   const isNewRoute = !result.route.knownMarket;
   const source = { ...state, bridgeOverride };
   const monthly = data.months.map((_, index) => {
     if (index === selectedIndex) return result;
     const month = index + 1;
     try {
       return runScenario(data, { ...resolvedMonthInputs(month, source), month });
     } catch {
       return null;
     }
   });
   const tile = (label, value, note, chart, tone = "neutral", kind = "") =>
     `<article class="result-tile ${kind}"><p class="result-tile-label">${label}</p><strong class="result-tile-value">${value}</strong><small class="result-tile-note ${tone}">${note}</small>${chart}</article>`;
   const deltaTile = (key, unit) => {
     const value = result.delta[key];
     const label = value < 0 ? `Change in ${unit}` : `Extra ${unit}`;
     const tone = isNewRoute || Math.round(Math.abs(value)) === 0 ? "neutral" : value > 0 ? "positive" : "negative";
     const direction = { positive: "↑", negative: "↓", neutral: "No change" }[tone];
     const note = isNewRoute ? "New route · all of this is extra" : `${direction} vs a usual ${monthName}`;
     const chart = sparklineSvg(monthly.map((item) => item?.delta[key]), selectedIndex, { label, format: formatSigned });
     return tile(label, formatSigned(value), note, chart, tone, key === "guestNights" ? "result-tile-guest" : "result-tile-checkins");
   };
   const compact = (value, precision = 0) => value >= 1e6 ? `${+(value / 1e6).toFixed(Math.max(1, precision))}M`
     : value >= 1e3 ? `${+(value / 1e3).toFixed(precision)}k` : formatNumber(value);
   const rangePrecision = compact(result.p10) === compact(result.p90) ? 1 : 0;
   updateKpiTiles([
     deltaTile("hotelCheckins", "hotel check-ins"),
     deltaTile("guestNights", "guest nights"),
     tile("Total guest nights", formatNumber(result.p50), isNewRoute ? "Usual: 0 (new route)" : `Usual: ${formatNumber(result.baseline.guestNights)}`,
       sparklineSvg(monthly.map((item) => item?.scenario.guestNights), selectedIndex, { label: "Total guest nights", format: formatNumber })),
     tile("Possible range", `${compact(result.p10, rangePrecision)} – ${compact(result.p90, rangePrecision)}`, "History-based guide", resultRange(result), "neutral", "result-tile-range"),
   ].join(""));
 }

function renderSideBySideComparison(result, previousResult) {
  const { baseline, scenario, route, delta } = result;
  const isNewRoute = !route.knownMarket;
  const month = planningEscape(data.months[state.month - 1]);
  const context = isNewRoute
    ? `The proposed ${planningEscape(route.origin)} route has no historical baseline. Comparison countries supply starting assumptions only. The headline changes above compare the proposed route with zero. Use Compare to assess adding the same capacity to an existing route.`
    : `Gray shows the baseline estimate for ${month}. The colored cap marks your plan level. The cards above give the hotel totals and changes.`;
  const steps = [
    ["seats", "Seats", state.extraFlights ? `${formatSigned(state.extraFlights)} flights a week` : "usual schedule"],
    ["passengers", "Passengers", `${formatPercent(state.loadFactor)} filled`],
    ["p2p", "End trip here", `${formatPercent(state.p2pShare)} not connecting`],
    ["hotelCheckins", "Hotel check-ins", `${formatPercent(state.conversionRate)} stay in a hotel${result.eventUplift ? " · event uplift applied" : ""}`],
    ["guestNights", "Guest nights", `× ${state.averageStay.toFixed(1)} nights each`],
  ];
  const chartMaximum = ({ baseline, scenario }) =>
    Math.max(1, ...steps.flatMap(([key]) => [baseline[key], scenario[key]]));
  const maximum = chartMaximum(result);
  const sameRouteAndMonth = previousResult?.route.originKey === route.originKey
    && previousResult.route.month === route.month;
  const previous = sameRouteAndMonth ? previousResult : result;
  const previousMaximum = chartMaximum(previous);
  const height = (value, scale) => (150 * value / scale).toFixed(2);
  const compact = (value) => value >= 1000
    ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k`
    : formatNumber(value);
  const shown = isNewRoute ? scenario : baseline;
  const previousShown = isNewRoute ? previous.scenario : previous.baseline;
  const columns = steps.map(([key, label, caption], index) => {
    const barHeight = height(shown[key], maximum);
    const planHeight = height(scenario[key], maximum);
    const showNumbers = index < 3;
    const rounded = Math.round(Math.abs(delta[key]));
    const badge = isNewRoute ? `New ${formatSigned(delta[key])}` : rounded ? formatSigned(delta[key]) : "No change";
    const tone = !isNewRoute && !rounded ? "unchanged" : delta[key] < 0 ? "lower" : "higher";
    const exact = isNewRoute ? `${label}: ${formatNumber(shown[key])} for your new route`
      : `${label}: ${formatNumber(shown[key])} usual, ${formatNumber(scenario[key])} in your plan (${badge})`;
    let connector = "";
    if (index < 3) {
      const nextHeight = Number(height(shown[steps[index + 1][0]], maximum));
      const drop = Number(barHeight) - nextHeight;
      connector = `<svg class="comparison-step-link" viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"
        style="bottom:${Math.min(nextHeight, Number(barHeight)) - (drop === 0 ? .5 : 0)}px;height:${Math.max(1, Math.abs(drop))}px">
        <line x1="0" y1="${drop === 0 ? 50 : drop < 0 ? 100 : 0}" x2="100" y2="${drop === 0 ? 50 : drop < 0 ? 0 : 100}" vector-effect="non-scaling-stroke"/>
      </svg>`;
    }
    return `<div class="comparison-step ${tone}">
      <div class="comparison-step-plot" title="${planningEscape(exact)}" style="--usual-height:${barHeight}px;--plan-height:${planHeight}px">
        ${connector}
        <div class="comparison-step-bar${Number(barHeight) < 27 ? " short" : ""}"
          style="--previous-height:${height(previousShown[key], previousMaximum)}px">
          ${showNumbers ? `<span class="comparison-step-value">${compact(shown[key])}</span><span class="comparison-step-badge">${badge}</span>` : ""}
        </div>
        ${!isNewRoute && rounded ? `<div class="comparison-step-plan" style="--previous-height:${height(previous.scenario[key], previousMaximum)}px"></div>` : ""}
      </div>
      <strong class="comparison-step-label">${label}</strong>
      <small>${caption}</small>
    </div>`;
  }).join("");
  const chartLabel = steps.map(([key, label]) => {
    if (isNewRoute) return `${label}: ${formatNumber(shown[key])} for your new route.`;
    const difference = Math.round(Math.abs(delta[key]));
    const change = difference ? `${delta[key] < 0 ? "minus" : "plus"} ${formatNumber(difference)} with your plan` : "no change";
    return `${label}: ${formatNumber(shown[key])} for a usual ${data.months[state.month - 1]}, ${change}.`;
  }).join(" ");

  $("#sideBySideComparison").innerHTML = `
    <div class="section-heading">
      <div><p>From seats to guest nights</p><h2>How your plan flows through to hotels</h2></div>
      <small>${month} estimate</small>
    </div>
    <p class="comparison-context">${context}</p>
    <div role="img" aria-label="${planningEscape(chartLabel + " Guest nights measure nights spent in hotels.")}">
      <div class="comparison-steps" dir="ltr" aria-hidden="true">${columns}</div>
    </div>
    <div class="comparison-step-legend">
      <span><i aria-hidden="true"></i>${isNewRoute ? "Your new route" : `Usual ${month}`}</span>
      <span><i aria-hidden="true"></i>${isNewRoute ? "Added by your plan" : "Change from usual"}</span>
      ${isNewRoute ? "" : '<span class="comparison-plan-key"><i aria-hidden="true"></i>Plan level</span>'}
    </div>
    <button type="button" class="text-action" data-evidence="calculation">See exact assumptions and calculation →</button>`;
}

 function renderRouteMap(result) {
   const routeKey = `${result.route.originKey}-${result.route.proxyOriginKey || ""}`;
   if (routeKey === lastRenderedRouteKey) return;
   lastRenderedRouteKey = routeKey;
   const coordinates = {
     ARMENIA: [44.9, 40.2], AUSTRIA: [14.6, 47.5], AZERBAIJAN: [47.7, 40.1],
     BAHRAIN: [50.6, 26.1], BELGIUM: [4.5, 50.8], CANADA: [-106.3, 56.1],
     CHINA: [104.2, 35.9], EGYPT: [30.8, 26.8], FRANCE: [2.2, 46.2],
     GERMANY: [10.4, 51.2], INDIA: [78.96, 20.59], IRELAND: [-8.2, 53.4],
     ISRAEL: [35.0, 31.0], ITALY: [12.6, 42.8], JAPAN: [138.3, 36.2],
     JORDAN: [36.2, 31.2], KAZAKHSTAN: [67.3, 48.0], KUWAIT: [47.5, 29.3],
     LEBANON: [35.9, 33.9], NETHERLANDS: [5.3, 52.1], OMAN: [57.0, 21.5],
     PHILIPPINES: [122.9, 12.9], POLAND: [19.1, 52.1], QATAR: [51.2, 25.4],
     RUSSIANFEDERATION: [90.0, 60.0], SAUDIARABIA: [44.5, 24.0],
     SOUTHKOREA: [127.8, 36.5], SPAIN: [-3.7, 40.4], SWITZERLAND: [8.2, 46.8],
     TURKEY: [35.2, 39.0], UNITEDKINGDOM: [-3.4, 55.4],
     UNITEDSTATESOFAMERICA: [-100.0, 38.0], UZBEKISTAN: [64.6, 41.4],
     IRAN: [53.688, 32.4279], SINGAPORE: [103.8198, 1.3521],
     MALAYSIA: [102.0, 4.2], THAILAND: [101.0, 15.0], INDONESIA: [117.0, -2.0],
     VIETNAM: [108.3, 14.1], BANGLADESH: [90.4, 23.7], NEPAL: [84.1, 28.3],
     SRILANKA: [80.7, 7.9], IRAQ: [43.7, 33.2], GEORGIA: [43.4, 42.3],
     AFGHANISTAN: [66.0, 33.9], GREECE: [22.9, 39.1], PORTUGAL: [-8.0, 39.6],
     AUSTRALIA: [134.5, -25.7], NEWZEALAND: [172.8, -41.3], NIGERIA: [8.7, 9.1],
     KENYA: [37.9, 0.2], ARGENTINA: [-63.6, -38.4],
   };
   const countryBounds = {
     ARMENIA: [43.4, 40.1, 46.6, 41.3], AUSTRIA: [9.5, 46.4, 17.2, 49.1],
     AZERBAIJAN: [44.8, 38.4, 50.4, 41.9], BAHRAIN: [50.3, 25.8, 50.8, 26.3],
     BELGIUM: [2.5, 49.5, 6.4, 51.5], CANADA: [-141, 42, -52.6, 83],
     CHINA: [73.5, 18.2, 134.8, 53.6], EGYPT: [24.7, 22, 36.9, 31.7],
     FRANCE: [-5.2, 41.3, 9.6, 51.1], GERMANY: [5.8, 47.2, 15.1, 55.1],
     INDIA: [68.1, 6.7, 97.4, 35.7], IRELAND: [-10.7, 51.4, -6, 55.4],
     ISRAEL: [34.2, 29.5, 35.9, 33.4], ITALY: [6.6, 36.6, 18.5, 47.1],
     JAPAN: [129.4, 31, 145.8, 45.6], JORDAN: [34.9, 29.2, 39.3, 33.4],
     KAZAKHSTAN: [46.5, 40.6, 87.3, 55.4], KUWAIT: [46.5, 28.5, 48.4, 30.1],
     LEBANON: [35.1, 33, 36.6, 34.7], NETHERLANDS: [3.3, 50.7, 7.3, 53.6],
     OMAN: [52, 16.6, 59.8, 26.4], PHILIPPINES: [116.9, 4.6, 126.6, 21.2],
     POLAND: [14.1, 49, 24.2, 54.8], QATAR: [50.7, 24.5, 51.7, 26.2],
     RUSSIANFEDERATION: [27.2, 41.2, 180, 81.9], SAUDIARABIA: [34.6, 16.3, 55.7, 32.2],
     SOUTHKOREA: [126, 33.1, 129.6, 38.6], SPAIN: [-9.3, 36, 3.3, 43.8],
     SWITZERLAND: [5.9, 45.8, 10.5, 47.9], TURKEY: [26, 35.8, 44.8, 42.1],
     UNITEDKINGDOM: [-8.2, 49.8, 1.8, 58.7], UNITEDSTATESOFAMERICA: [-124.8, 24.4, -66.9, 49.4],
     UZBEKISTAN: [55.9, 37.2, 73.2, 45.6],
     IRAN: [44.0, 25.0, 63.5, 39.8], SINGAPORE: [103.6, 1.1, 104.1, 1.5],
     MALAYSIA: [99.6, 0.8, 119.3, 7.4], THAILAND: [97.3, 5.6, 105.7, 20.5],
     INDONESIA: [95.0, -11.0, 141.0, 6.0], VIETNAM: [102.1, 8.5, 109.5, 23.4],
     BANGLADESH: [88.0, 20.6, 92.7, 26.7], NEPAL: [80.0, 26.3, 88.2, 30.5],
     SRILANKA: [79.5, 5.8, 82.1, 9.9], IRAQ: [38.8, 29.0, 48.6, 37.4],
     GEORGIA: [40.0, 41.0, 46.8, 43.6], AFGHANISTAN: [60.5, 29.3, 74.9, 38.5],
     GREECE: [19.3, 34.8, 29.7, 41.8], PORTUGAL: [-9.6, 36.8, -6.2, 42.2],
     AUSTRALIA: [112.9, -43.8, 153.6, -10.7], NEWZEALAND: [166.0, -47.4, 178.6, -34.0],
     NIGERIA: [2.7, 4.2, 14.7, 13.9], KENYA: [33.9, -4.7, 41.9, 5.1],
     ARGENTINA: [-73.6, -55.1, -53.6, -21.8],
   };
   const destinationBounds = [51.5, 22.6, 56.5, 26.3];
   const enteredMarketKey = normalizeCountryName(result.route.originKey);
   const enteredMarketRecord = countryLocationLookup[enteredMarketKey];
   const enteredMarketHasLocation = Boolean(coordinates[enteredMarketKey] || enteredMarketRecord);
   if (!enteredMarketHasLocation) {
     $("#routeMap").innerHTML = '<p class="control-note">No verified country location is available for this route. Choose a country from the departure list to display its map.</p>';
     return;
   }
   const project = ([longitude, latitude]) => projectMapPoint(longitude, latitude);
   const originCoordinates = enteredMarketRecord?.coordinates || coordinates[enteredMarketKey];
   const originBounds = countryBounds[enteredMarketKey] || enteredMarketRecord?.bounds;
   const destinationLocation = {
     name: "Abu Dhabi",
     coordinates: [54.37, 24.45],
   };
   const [originX, originY] = project(originCoordinates);
   const destination = projectMapPoint(
     destinationLocation.coordinates[0],
     destinationLocation.coordinates[1],
   );
   const controlX = (originX + destination[0]) / 2;
   const controlY = Math.min(originY, destination[1]) - 85;
   const originLabelText = result.route.origin.toUpperCase();
   const destinationLabelText = destinationLocation.name.toUpperCase();
   const originLabelWidth = Math.max(104, originLabelText.length * 7 + 34);
   const destinationLabelWidth = 112;
   const labelLayout = positionRouteLabels(
     [originX, originY],
     [destination[0], destination[1]],
     originLabelWidth,
     destinationLabelWidth,
     { control: [controlX, controlY] },
   );
   const { originLabelX, originLabelY, destinationLabelX, destinationLabelY } = labelLayout;
   const currentMap = $("#routeMap .route-map-svg");
   const previousViewBox = currentMap?.getAttribute("viewBox") || "0 0 1000 500";
   const mapViewBox = fitRouteViewBox(
     [
       ...featureBounds(originBounds),
       ...featureBounds(destinationBounds),
       [originX, originY], [controlX, controlY], destination,
       [originLabelX, originLabelY], [originLabelX + originLabelWidth, originLabelY + 27],
       [destinationLabelX, destinationLabelY], [destinationLabelX + 112, destinationLabelY + 27],
     ],
     1000 / 500,
     Math.hypot(originX - destination[0], originY - destination[1]) < 140,
   );
   const routeLabel = `${result.route.origin} → ${destinationLocation.name}`;
   const map = `
     <div class="world-map-canvas">
       <svg class="route-map-svg" viewBox="${previousViewBox}" role="img" aria-label="${routeLabel}">
       <defs>
         <linearGradient id="routeGlow" x1="0" x2="1">
           <stop offset="0" stop-color="#ff7a3d"/>
           <stop offset="1" stop-color="#ff7a3d"/>
         </linearGradient>
         <filter id="glow"><feGaussianBlur stdDeviation="5" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
       </defs>
       <image class="geographic-map" href="./data/admin0-countries.svg?v=20260922-admin0" x="0" y="0" width="1000" height="500" preserveAspectRatio="none"/>
       <path class="route-shadow fixed-stroke" d="M${originX} ${originY} Q ${controlX} ${controlY} ${destination[0]} ${destination[1]}"/>
       <path class="route-line fixed-stroke" d="M${originX} ${originY} Q ${controlX} ${controlY} ${destination[0]} ${destination[1]}"/>
       <g class="fixed-marker" data-x="${originX}" data-y="${originY}">
         <circle class="origin-pulse" cx="${originX}" cy="${originY}" r="9"/>
         <circle class="origin-dot" cx="${originX}" cy="${originY}" r="5"/>
       </g>
       <g class="fixed-marker" data-x="${destination[0]}" data-y="${destination[1]}">
         <circle class="destination-pulse" cx="${destination[0]}" cy="${destination[1]}" r="10"/>
         <circle class="destination-dot" cx="${destination[0]}" cy="${destination[1]}" r="5"/>
       </g>
       <g class="map-label origin-label fixed-label" data-x="${originLabelX}" data-y="${originLabelY}" data-anchor-x="${originX}" data-anchor-y="${originY}" transform="translate(${originLabelX} ${originLabelY})">
         <rect width="${originLabelWidth}" height="27" rx="4"/>
         <text x="11" y="18">${originLabelText}</text>
       </g>
       <g class="map-label destination-label fixed-label" data-x="${destinationLabelX}" data-y="${destinationLabelY}" data-anchor-x="${destination[0]}" data-anchor-y="${destination[1]}" transform="translate(${destinationLabelX} ${destinationLabelY})">
         <rect width="112" height="27" rx="4"/><text x="11" y="18">${destinationLabelText}</text>
       </g>
       </svg>
     </div>
     <p class="map-source-note">Country reference point to Abu Dhabi city. Schematic route, not airport locations${enteredMarketRecord?.name === "Antarctica" ? ". Antarctic outline is unavailable in the supplied map." : "."}</p>`;
   $("#routeMap").innerHTML = map;
   const routeMapSvg = $("#routeMap .route-map-svg");
   applyOverlayScale(routeMapSvg, previousViewBox);
   animateMapViewBox(routeMapSvg, previousViewBox, mapViewBox);
 }

 function applyOverlayScale(svg, viewBox) {
   if (!svg) return;
   const [, , width] = viewBox.split(/\s+/).map(Number);
   // The viewBox zooms in as its width shrinks. Overlay geometry needs the
   // reciprocal scale so labels and markers stay at their original size.
   const inverseZoom = Math.min(1, width / 1000);
   svg.querySelectorAll(".fixed-marker").forEach((marker) => {
     const x = Number(marker.dataset.x);
     const y = Number(marker.dataset.y);
     marker.setAttribute("transform", `translate(${x} ${y}) scale(${inverseZoom}) translate(${-x} ${-y})`);
   });
   svg.querySelectorAll(".fixed-label").forEach((label) => {
     const x = Number(label.dataset.x);
     const y = Number(label.dataset.y);
     const anchorX = Number(label.dataset.anchorX);
     const anchorY = Number(label.dataset.anchorY);
     label.setAttribute(
       "transform",
       `translate(${anchorX} ${anchorY}) scale(${inverseZoom}) translate(${-anchorX} ${-anchorY}) translate(${x} ${y})`,
     );
   });
 }

 function fitRouteViewBox(points, aspectRatio, isCloseRoute = false) {
   const xs = points.map(([x]) => x);
   const ys = points.map(([, y]) => y);
   const minX = Math.min(...xs);
   const maxX = Math.max(...xs);
   const minY = Math.min(...ys);
   const maxY = Math.max(...ys);
   const padding = isCloseRoute ? 0.01 : 0.015;
   let width = Math.max(maxX - minX, isCloseRoute ? 150 : 300);
   let height = Math.max(maxY - minY, isCloseRoute ? 78 : 170);
   width += isCloseRoute ? 12 : 20;
   height += isCloseRoute ? 12 : 20;
   width *= 1 + padding * 2;
   height *= 1 + padding * 2;

   if (width / height < aspectRatio) width = height * aspectRatio;
   if (width / height > aspectRatio) height = width / aspectRatio;

   let x = (minX + maxX) / 2 - width / 2;
   let y = (minY + maxY) / 2 - height / 2;
   x = Math.max(0, Math.min(x, 1000 - width));
   y = Math.max(0, Math.min(y, 500 - height));
   width = Math.min(width, 1000);
   height = Math.min(height, 500);
   return [x, y, width, height].map((value) => Number(value.toFixed(2))).join(" ");
 }

 function featureBounds(bounds) {
   const [west, south, east, north] = bounds;
   return [
     projectMapPoint(west, south), projectMapPoint(west, north),
     projectMapPoint(east, south), projectMapPoint(east, north),
   ];
 }

 function projectMapPoint(longitude, latitude) {
   // The SVG viewBox is reframed to this same full-world latitude range.
   // Every origin, bounds corner and Abu Dhabi must use this one projection.
   return [
     (longitude + 180) / 360 * 1000,
     (90 - latitude) / 180 * 500,
   ];
 }

 function positionRouteLabels(origin, destination, originWidth, destinationWidth, route = {}) {
   const gap = 14;
   const height = 27;
   const mapPadding = 12;
   const bounds = { left: mapPadding, top: mapPadding, right: 1000 - mapPadding, bottom: 500 - mapPadding };
   const protectedPoints = [
     { point: origin, radius: 20 },
     { point: destination, radius: 9 },
   ];
   const routeSamples = route.control
     ? Array.from({ length: 17 }, (_, index) => {
       const t = index / 16;
       const oneMinusT = 1 - t;
       return [
         oneMinusT * oneMinusT * origin[0] +
           2 * oneMinusT * t * route.control[0] +
           t * t * destination[0],
         oneMinusT * oneMinusT * origin[1] +
           2 * oneMinusT * t * route.control[1] +
           t * t * destination[1],
       ];
     })
     : [];
   const pointToRectDistance = (point, rect) => Math.hypot(
     Math.max(rect.x - point[0], 0, point[0] - (rect.x + rect.width)),
     Math.max(rect.y - point[1], 0, point[1] - (rect.y + rect.height)),
   );
   const overlapsProtectedPoint = (rect) => protectedPoints.some(({ point, radius }) =>
     pointToRectDistance(point, rect) <= radius,
   );
   const crossesRoute = (rect) => routeSamples.some((point) => pointToRectDistance(point, rect) < 8);
   const candidates = (point, width, preferred) => {
     const [x, y] = point;
     const placements = {
       right: [x + gap, y - height / 2],
       left: [x - width - gap, y - height / 2],
       above: [x - width / 2, y - height - gap],
       below: [x - width / 2, y + gap],
     };
     return [preferred, "right", "left", "above", "below"]
       .filter((placement, index, list) => list.indexOf(placement) === index)
       .map((placement) => {
         const [rawX, rawY] = placements[placement];
         const xPosition = Math.max(bounds.left, Math.min(rawX, bounds.right - width));
         const yPosition = Math.max(bounds.top, Math.min(rawY, bounds.bottom - height));
         const rect = { x: xPosition, y: yPosition, width, height };
         return {
           x: xPosition,
           y: yPosition,
           placement,
           protectedOverlap: overlapsProtectedPoint(rect),
           routeCrossing: crossesRoute(rect),
         };
       });
   };
   const originIsLeft = origin[0] <= destination[0];
   const verticallyStacked = Math.abs(origin[0] - destination[0]) < 70;
   const originPreferred = verticallyStacked
     ? (origin[1] <= destination[1] ? "above" : "below")
     : (originIsLeft ? "left" : "right");
   const destinationPreferred = verticallyStacked
     ? (origin[1] <= destination[1] ? "below" : "above")
     : (originIsLeft ? "right" : "left");
   const originCandidates = candidates(origin, originWidth, originPreferred);
   const destinationCandidates = candidates(destination, destinationWidth, destinationPreferred);
   let best;
   for (const originLabel of originCandidates) {
     for (const destinationLabel of destinationCandidates) {
       const intersects = originLabel.x < destinationLabel.x + destinationWidth &&
         originLabel.x + originWidth > destinationLabel.x &&
         originLabel.y < destinationLabel.y + height &&
         originLabel.y + height > destinationLabel.y;
       const obstaclePenalty =
         (originLabel.protectedOverlap ? 1000000 : 0) +
         (destinationLabel.protectedOverlap ? 1000000 : 0) +
         (originLabel.routeCrossing ? 500 : 0) +
         (destinationLabel.routeCrossing ? 500 : 0);
       const distancePenalty = Math.hypot(
         originLabel.x - origin[0],
         originLabel.y - origin[1],
       ) + Math.hypot(
         destinationLabel.x - destination[0],
         destinationLabel.y - destination[1],
       );
       const preferencePenalty = (originLabel.placement === originPreferred ? 0 : 18) +
         (destinationLabel.placement === destinationPreferred ? 0 : 18);
       const score = (intersects ? 100000 : 0) + obstaclePenalty + distancePenalty + preferencePenalty;
       if (!best || score < best.score) best = { originLabel, destinationLabel, score };
     }
   }
   return {
     originLabelX: best.originLabel.x,
     originLabelY: best.originLabel.y,
     destinationLabelX: best.destinationLabel.x,
     destinationLabelY: best.destinationLabel.y,
   };
 }

 function animateMapViewBox(svg, fromValue, toValue) {
   if (!svg || fromValue === toValue) {
     svg?.setAttribute("viewBox", toValue);
     return;
   }
   const from = fromValue.split(/\s+/).map(Number);
   const to = toValue.split(/\s+/).map(Number);
   if (from.length !== 4 || from.some((value) => !Number.isFinite(value))) {
     svg.setAttribute("viewBox", toValue);
     return;
   }
   const start = performance.now();
   const duration = 700;
   const ease = (value) => 1 - Math.pow(1 - value, 3);
   const step = (now) => {
     const progress = Math.min(1, (now - start) / duration);
     const eased = ease(progress);
     const viewBox = from.map((value, index) =>
       value + (to[index] - value) * eased);
     svg.setAttribute("viewBox", viewBox.map((value) => value.toFixed(2)).join(" "));
     applyOverlayScale(svg, viewBox.join(" "));
     if (progress < 1) requestAnimationFrame(step);
   };
   requestAnimationFrame(step);
 }
  
 function renderCalculationExplanation(result) {
   const exact = (value) => String(Number(value));
   const equation = (label, expression, value) => `<li><strong>${label}</strong><span>${expression} = ${exact(value)}</span></li>`;
   const route = result.route;
   const historical = state.peerProfile?.bridge || getBridge(data, route.knownMarket ? route.originKey : route.proxyOriginKey || route.originKey, state.month);
   const historicalStay = historical.length ? historical.reduce((sum, row) => sum + row.weight * (Number(row.averageStay) || data.defaults.averageStay), 0) : data.defaults.averageStay;
   const baseline = result.baseline;
   const scenario = result.scenario;
   const weeks = weeksInMonth(state.month);
   const rawSeats = route.baselineSeats + state.extraFlights * state.seatsPerFlight * weeks;
   $("#calculationExplanation").innerHTML = `
     ${route.knownMarket ? "" : `<p>${state.peerProfile ? "The weighted comparison-country blend supplies" : (route.proxyOriginKey || "The available markets") + " supplies"} starting assumptions only. <button type="button" class="text-action" data-evidence="sources">See the starting evidence →</button></p>`}
     <p>The steps below show the values used in this calculation. Percentages are written as fractions (0.8 means 80%). Cards and controls round their display; the calculation keeps the underlying precision. Tiny computer rounding differences below 0.0000001 count as zero change.</p>
     <details><summary>Baseline assumptions and calculation</summary><p>The steps below reproduce the estimate based on past flight records.</p><ol class="calculation-steps">
       ${equation("Passengers", `${exact(route.baselineSeats)} past seats × ${exact(route.loadFactor)} flight fullness`, baseline.passengers)}
       ${equation("Passengers ending their trip here", `${exact(baseline.passengers)} × ${exact(route.p2pShare)} ending-trip share`, baseline.p2p)}
       ${equation("Hotel check-ins", `${exact(baseline.p2p)} × ${exact(data.defaults.captureRate)} hotel-use assumption`, baseline.hotelCheckins)}
       ${equation("Guest nights", `${exact(baseline.hotelCheckins)} × ${exact(historicalStay)} weighted nights per stay`, baseline.guestNights)}
     </ol><p>The baseline uses the original visitor mix to calculate the weighted average stay. Editing your plan does not rewrite this baseline. Flight fullness is capped at 100% when a recorded ratio exceeds capacity.</p></details>
     <details><summary>Your plan: calculation with current assumptions</summary><ol class="calculation-steps">
       ${equation("Seats", `max(0, ${exact(route.baselineSeats)} + ${exact(state.extraFlights)} flights/week × ${exact(state.seatsPerFlight)} seats/flight × ${exact(weeks)} weeks)`, scenario.seats)}
       ${equation("Passengers", `${exact(scenario.seats)} × ${exact(state.loadFactor)} flight fullness`, scenario.passengers)}
       ${equation("Passengers ending their trip here", `${exact(scenario.passengers)} × ${exact(state.p2pShare)} ending-trip share`, scenario.p2p)}
       ${equation("Hotel check-ins", `${exact(scenario.p2p)} × ${exact(state.conversionRate)} hotel-use assumption × (1 + ${exact(result.eventUplift)} event uplift)`, scenario.hotelCheckins)}
       ${equation("Guest nights", `${exact(scenario.hotelCheckins)} × ${exact(state.averageStay)} nights per stay`, scenario.guestNights)}
       ${equation("Change in check-ins", `${exact(scenario.hotelCheckins)} − ${exact(baseline.hotelCheckins)}`, result.delta.hotelCheckins)}
       ${equation("Change in guest nights", `${exact(scenario.guestNights)} − ${exact(baseline.guestNights)}`, result.delta.guestNights)}
     </ol><p>Weeks = days in the selected month ÷ 7; February uses 28.25 days. ${rawSeats < 0 ? "Your flight reduction exceeds the available seats, so seats are limited to zero." : "Seats cannot fall below zero."} The event uplift is your assumption and is applied once to hotel check-ins; guest nights then use those check-ins.</p></details>
     <details><summary>Range, visitor groups and evidence</summary>
       <p>Lower guide = ${exact(result.p50)} × ${exact(data.defaults.uncertaintyLow || 0.9)} = ${exact(result.p10)} nights. Upper guide = ${exact(result.p50)} × ${exact(data.defaults.uncertaintyHigh || 1.1)} = ${exact(result.p90)} nights. <button type="button" class="text-action" data-evidence="validation-method">See the range evidence →</button></p>
       <p>Visitor-group check-ins = plan check-ins × that group's normalized share. Nights also use that group's relative stay length, adjusted to match your selected overall average stay. ${bridgeOverride ? "Your edited visitor shares are in use." : "The estimated visitor shares are in use."} Group contributions add up to the headline change; they are not measured nationality-level effects.</p>
     </details>`;
 }

 function renderSeasonProfile(result) {
   const routes = data.routes
     .filter((route) => route.originKey === result.route.originKey)
     .sort((a, b) => a.month - b.month);
   const max = Math.max(...routes.map((route) => route.baselineSeats), 1);
   $("#seasonProfile").classList.toggle("empty-state", routes.length === 0);
   $("#seasonProfile").innerHTML = routes.length ? routes.map((route) => `
     <div class="season-column ${route.month === state.month ? "active" : ""}" tabindex="0" aria-label="${data.months[route.month - 1]}: ${formatNumber(route.baselineSeats)} average seats${route.month === state.month ? ", selected month" : ""}" title="${data.months[route.month - 1]}: ${formatNumber(route.baselineSeats)} average seats">
       <span>${route.baselineSeats >= 1000 ? `${(route.baselineSeats / 1000).toFixed(0)}k` : formatNumber(route.baselineSeats)}</span>
       <div><i style="height:${Math.max(4, route.baselineSeats / max * 100)}%"></i></div>
       <small>${data.months[route.month - 1].slice(0, 3)}</small>
     </div>`).join("") : `
       <div class="season-empty">
         <strong>No past flight records for this route</strong>
         <span>There are no monthly flight totals to show yet. The estimate uses the comparison-country assumptions shown in Details.</span>
       </div>`;
   const busiest = routes.reduce((best, route) => !best || route.baselineSeats > best.baselineSeats ? route : best, null);
   $("#seasonSummary").innerHTML = routes.length ? `
     <div><span>Highest monthly average · ${data.months[busiest.month - 1]}</span></div>
     <p>Based on past flight records for ${result.route.origin}. These are starting seat estimates, not future bookings. Focus or hover on a bar for its exact value.</p>` : "";
 }
  
 function renderRouteAudit(result) {
   const startingSource = state.peerProfile ? "a weighted blend of " + state.peerProfile.peers.map((peer)=>peer.origin).join(", ") : (result.route.proxyOriginKey || "the selected comparison country");
   $("#routeAudit").innerHTML = `<table>
     <thead><tr><th>Number used</th><th>Where it comes from</th></tr></thead>
     <tbody>
       <tr><td>Past flight seats</td><td>${result.route.knownMarket ? `Average number of seats from ${result.route.origin} in ${data.months[state.month - 1]} in the supplied records.` : "No past flight seats for this route. Starting assumptions use " + startingSource + "."}</td></tr>
       <tr><td>Reference flights each week · ${Number(result.route.weeklyFrequency).toFixed(1)}</td><td>${result.route.knownMarket ? "Average weekly flights recorded for this country and month." : state.peerProfile ? "No historical schedule for this new route. Use the proposed extra flights above; the comparison blend does not borrow a schedule." : `Reference schedule for ${result.route.proxyOriginKey || "the comparison country"} only; not a schedule for the proposed route.`}</td></tr>
       <tr><td>Flights added or removed each week</td><td>Your scenario assumption; multiplied by seats per flight and weeks in the month.</td></tr>
       <tr><td>Seats on each flight</td><td>${result.route.knownMarket ? "Based on past flights. You can change it." : `Starts from ${startingSource}. You can change it.`}</td></tr>
       <tr><td>Flights expected to be full</td><td>${result.route.knownMarket ? "Based on how full past flights were. You can change it." : `Starts from ${startingSource}. There are no past records for this route.`}</td></tr>
       <tr><td>Passengers ending in Abu Dhabi</td><td>${result.route.knownMarket ? "Past share of passengers whose journey ended in Abu Dhabi. You can change it." : `Starts from ${startingSource}. There are no past records for this route.`}</td></tr>
       <tr><td>Share expected to stay in hotels</td><td>Estimated share of passengers ending their trip here who check into hotels. You can change it.</td></tr>
       <tr><td>Extra demand for an event or season</td><td>Your chosen increase for hotel arrivals and nights. It is not measured from past event results.</td></tr>
       <tr><td>Average nights per hotel stay</td><td>Your plan uses this overall average stay. The baseline keeps its original weighted average from the historical visitor mix.</td></tr>
     </tbody>
   </table>`;
 }
  
 function renderContributions(result) {
   const rows = result.contributions.slice(0, 8);
   const max = Math.max(...rows.map((row) => Math.abs(row.deltaGuestNights)), 1);
   $("#marketBars").innerHTML = rows.map((row) => {
     const width = Math.max(2, Math.abs(row.deltaGuestNights) / max * 100);
     const cls = row.deltaGuestNights >= 0 ? "bar-positive" : "bar-negative";
     return `<div class="bar-row">
       <div class="bar-label"><span>${row.nationality}</span><b>${formatSigned(row.deltaGuestNights)}</b></div>
       <div class="bar-track"><div class="bar-fill ${cls}" style="width:${width}%"></div></div>
     </div>`;
   }).join("");
 }
  
 function renderSensitivity() {
   const rows = sensitivity(data, { ...state, bridgeOverride });
   const changes = {"Average nights per hotel stay":"±0.5 nights", "Share checking into a hotel":"±5 percentage points", "Passengers ending in Abu Dhabi":"±5 percentage points", "How full flights are":"±5 percentage points", "Extra flights each week":"±1 flight/week", "Seats on each flight":"±30 seats", "Extra hotel demand for an event or season":"±10 percentage points"};
   const max = Math.max(...rows.map((row) => row.span), 1);
   $("#sensitivityBars").innerHTML = rows.map((row) => {
     const width = Math.max(4, row.span / max * 100);
     return `<div class="sensitivity-row">
       <span>${row.label}<small>${changes[row.label] || "Change one assumption"}, within control limits</small></span>
       <div class="sensitivity-track"><div style="width:${width}%"></div></div>
       <b>${formatNumber(row.span)}</b>
     </div>`;
   }).join("");
 }
  
// Keep the chosen percentage exact and divide the remainder among all other groups.
function rebalanceVisitorShares(rows, index, target, reference = []) {
  if (rows.length < 2) return rows;
  const remaining = 1 - target;
  const sum = rows.reduce((total, row, position) => total + (position === index ? 0 : row.weight), 0);
  const referenceWeights = sum === 0 ? new Map(reference.map(row => [row.nationality, row.weight])) : null;
  const weights = rows.map((row, position) => position === index ? 0
    : referenceWeights ? referenceWeights.get(row.nationality) || 0 : row.weight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return rows.map((row, position) => ({
    ...row,
    weight: position === index ? target : remaining * (total > 0 ? weights[position] / total : 1 / (rows.length - 1)),
  }));
}

function validVisitorShare(field) {
  return field.value.trim() !== "" && Number.isFinite(Number(field.value)) && Number(field.value) >= 0 && Number(field.value) <= 100;
}

function updateBridgeDraftTotal() {
  const total = bridgeDraft.reduce((sum, row) => sum + row.weight, 0);
  const other = bridgeDraft.slice(10).reduce((sum, row) => sum + row.weight, 0);
  $("#bridgeRunningTotal").textContent = `Visitor shares total ${formatPercent(total, 1)}.`;
  $$("[data-bridge-other]").forEach(element => { element.textContent = formatPercent(other, 1); });
  $$(".bridge-input").forEach(field => {
    const row = bridgeDraft[Number(field.dataset.index)];
    if (!row) return;
    const display = (row.weight * 100).toFixed(1);
    field.value = display;
    field.classList.toggle("changed", display !== field.dataset.displayed);
    field.style.setProperty("--mix-fill", `${display}%`);
    field.setAttribute("aria-valuetext", `${display} percent`);
    const badge = field.closest(".vm-share-editor")?.querySelector(".vm-slider-badge");
    if (badge) badge.textContent = display;
    const ring = $(`[data-mix-ring="${field.dataset.index}"]`);
    if (ring) {
      ring.querySelector("strong").textContent = `${display}%`;
      ring.querySelector("svg").setAttribute("aria-label", `${row.nationality}: ${display}%`);
      ring.querySelector(".vm-ring-value").setAttribute("stroke-dasharray", `${row.weight * 100} ${100 - row.weight * 100}`);
    }
  });
}

function changeVisitorShare(event) {
  const field = event.target;
  if (!field.classList.contains("bridge-input")) return;
  if (!validVisitorShare(field)) {
    $("#bridgeStatus").textContent = "Enter a share from 0% to 100%.";
    return;
  }
  const index = Number(field.dataset.index);
  const target = Number(field.value) / 100;
  if (!bridgeDraft[index]) return;
  const needsReference = target < 1 && bridgeDraft.every((row, position) => position === index || row.weight === 0);
  const reference = needsReference ? runScenario(data, { ...state, bridgeOverride: null }).bridge : [];
  bridgeDraft = rebalanceVisitorShares(bridgeDraft, index, target, reference);
  updateBridgeDraftTotal();
  $("#bridgeStatus").textContent = "Other shares adjust automatically. Check-ins, guest nights and the map update when you apply.";
}

function visitorOriginMap(rows, colors, flag) {
  const point = projectMapPoint(54.3773, 24.4539);
  const hub = [point[0], point[1] + 85];
  const occupied = [{ x: hub[0] - 10, y: hub[1] + 10, width: 130, height: 35 }];
  const activeRows = rows.map((row, index) => ({ row, color: colors[index] })).filter(({ row }) => row.weight > 0);
  const located = activeRows.map(item => ({ ...item, location: countryLocationLookup[normalizeCountryName(item.row.nationalityKey || item.row.nationality)] }))
    .filter(({ location }) => location?.coordinates?.length === 2 && location.coordinates.every(Number.isFinite));
  const routes = located.map(({ row, color, location }, index) => {
    const projected = projectMapPoint(...location.coordinates);
    const [x, y] = [projected[0], projected[1] + 85];
    const controlX = (x + hub[0]) / 2;
    const controlY = Math.max(25, Math.min(y, hub[1]) - Math.max(45, Math.abs(x - hub[0]) * .22));
    const turningPoint = (y - controlY) / (y - 2 * controlY + hub[1]);
    const arcTop = turningPoint > 0 && turningPoint < 1
      ? (1 - turningPoint) ** 2 * y + 2 * (1 - turningPoint) * turningPoint * controlY + turningPoint ** 2 * hub[1]
      : Math.min(y, hub[1]);
    const path = `M ${x} ${y} Q ${controlX} ${controlY} ${hub[0]} ${hub[1]}`;
    const label = `${flag(location)} ${row.nationality}`;
    const width = Math.min(350, 28 + [...label].length * 8.2);
    let best = null;
    for (const dy of [-42, 14, -78, 50, -114, 86, -150, 122]) for (const dx of [14, -width - 14, -width / 2, 45, -width - 45]) {
      const candidate = { x: Math.max(12, Math.min(988 - width, x + dx)), y: Math.max(25, Math.min(575, y + dy)), width, height: 29 };
      const collisions = occupied.filter(r => candidate.x < r.x + r.width + 8 && candidate.x + width + 8 > r.x && candidate.y < r.y + r.height + 7 && candidate.y + 36 > r.y).length;
      const score = collisions * 10000 + Math.hypot(candidate.x + width / 2 - x, candidate.y + 14 - y);
      if (!best || score < best.score) best = { ...candidate, score };
    }
    occupied.push(best);
    const anchorX = Math.max(best.x, Math.min(best.x + width, x));
    const anchorY = Math.max(best.y, Math.min(best.y + 29, y));
    return { arcTop, arc: `<path d="${path}" stroke="${color}" class="vm-arc-glow"/><path d="${path}" stroke="${color}" class="vm-arc"/><path d="${path}" stroke="${color}" class="vm-arc-flow" style="animation-delay:-${index}s"/><circle cx="${x}" cy="${y}" r="4" fill="${color}"/>`,
      label: `<g class="vm-map-label" tabindex="0" role="img" aria-label="${planningEscape(label)}: ${formatPercent(row.weight, 1)}"><title>${planningEscape(row.nationality)}: ${formatPercent(row.weight, 1)} · country reference point</title><path d="M ${x} ${y} L ${anchorX} ${anchorY}" stroke="${color}" opacity=".45"/><rect x="${best.x}" y="${best.y}" width="${width}" height="29" rx="6"/><text x="${best.x + 11}" y="${best.y + 19}" fill="${color}">${planningEscape(label)}</text></g>` };
  });
  const viewTop = Math.max(0, Math.min(85, ...occupied.map(label => label.y - 12), ...routes.map(route => route.arcTop - 12)));
  const viewBottom = Math.max(520, ...occupied.map(label => label.y + label.height + 12));
  return `<header class="vm-map-header"><span><i></i> GEOGRAPHIC ORIGIN MAP</span><h3>Global Visitor Origins</h3></header><svg class="vm-origin-svg" dir="ltr" viewBox="0 ${viewTop} 1000 ${viewBottom - viewTop}" preserveAspectRatio="none" role="group" aria-label="Estimated nationality origins connected to Abu Dhabi; illustrative country-centroid arcs"><image class="vm-world-outline" href="./data/admin0-countries.svg?v=20260922-admin0" x="0" y="85" width="1000" height="500" preserveAspectRatio="none"/>${routes.map(r => r.arc).join("")}${routes.map(r => r.label).join("")}<circle class="vm-hub-halo" cx="${hub[0]}" cy="${hub[1]}" r="20"/><circle class="vm-hub" cx="${hub[0]}" cy="${hub[1]}" r="6"/><g class="vm-hub-label" transform="translate(${hub[0] - 6} ${hub[1] + 23})"><text>ABU DHABI</text><text y="19" class="vm-hub-subtitle">Destination hub</text></g></svg><footer class="vm-map-footer"><span class="vm-map-key"><i></i> Top nationality groups → Abu Dhabi</span><p>Illustrative nationality origins, not verified departure airports or flight paths. Locations use country reference points. Other nationalities are included in the cards.</p>${located.length < activeRows.length ? '<p>Some nationality locations are unavailable and are not plotted.</p>' : ''}</footer>`;
}

 function renderBridge(result) {
   bridgeDraft = result.bridge;
   const rows = result.bridge.slice(0, 10);
   const remaining = result.bridge.slice(10);
   const otherShare = remaining.reduce((sum, row) => sum + row.weight, 0);
   const nightsByNationality = new Map(result.contributions.map((row) => [row.nationality, row.scenarioGuestNights]));
   const otherNights = remaining.reduce((sum, row) => sum + (nightsByNationality.get(row.nationality) || 0), 0);
   const palette = ["#e5c365", "#e0757e", "#79a5ed", "#a891d5", "#76b8d1", "#91b897", "#e1b78b", "#91a4c4", "#b3bd7e", "#bc91ab"];
   const flag = (location) => {
     const code = location?.aliases?.find((alias) => /^[A-Z]{2}$/.test(alias)) || ({ France: "FR", Norway: "NO" })[location?.name];
     return code ? [...code].map((letter) => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("") : "◈";
   };
   const counts = (share, nights) => `<div class="vm-card-counts">
     <div><strong>${formatNumber(result.scenario.hotelCheckins * share)}</strong><span>Hotel check-ins</span></div>
     <div><strong>${formatNumber(nights)}</strong><span>Guest nights</span></div>
   </div>`;
   const card = ({ row, index }, rank) => {
     const name = planningEscape(row.nationality);
     const location = countryLocationLookup[normalizeCountryName(row.nationalityKey || row.nationality)];
     const featured = rank === 0;
     const share = (row.weight * 100).toFixed(1);
     const ring = featured ? `<div class="vm-feature-ring" data-mix-ring="${index}"><svg viewBox="0 0 120 120" role="img" aria-label="${name}: ${share}%"><circle cx="60" cy="60" r="49" class="vm-ring-track"/><circle cx="60" cy="60" r="49" class="vm-ring-value" pathLength="100" stroke-dasharray="${row.weight * 100} ${100 - row.weight * 100}" transform="rotate(-90 60 60)"/></svg><strong aria-hidden="true">${share}%</strong></div>` : "";
     const editor = bridgeEditing ? `<span class="vm-share-editor">
       <input id="mixShare-${index}" lang="en" dir="ltr" aria-label="${name} share percent" class="bridge-input" data-index="${index}" data-displayed="${share}" type="range" min="0" max="100" step="0.1" value="${share}">
       <span class="vm-slider-readout"><output class="vm-slider-badge" for="mixShare-${index}">${share}</output><span>%</span></span>
     </span>` : "";
     return `<article class="vm-nationality-card${featured ? " vm-featured-card" : ""}" style="--nationality-color:${palette[index]}">
       <span class="vm-card-rank">#${String(rank + 1).padStart(2, "0")}</span>${ring}
       <div class="vm-card-country"><span class="vm-country-flag" aria-hidden="true">${flag(location)}</span><h3>${name}</h3>${featured ? "<small>Largest nationality group</small>" : ""}</div>
       <div class="vm-card-share"><span class="vm-share-value">${share}%</span>${editor}</div>
       ${counts(row.weight, nightsByNationality.get(row.nationality))}
     </article>`;
   };
   const editButton = $("#editBridgeMix");
   editButton.textContent = bridgeEditing ? "Cancel editing" : "Edit mix";
   editButton.setAttribute("aria-pressed", String(bridgeEditing));
   $("#applyBridge").disabled = !bridgeEditing;
   $("#bridgeView").classList.toggle("mix-editing", bridgeEditing);
   $("#bridgeTitle").textContent = `Estimated visitors from ${result.route.origin}`;
   $("#bridgeExplanation").textContent = result.route.knownMarket
     ? "These percentages estimate which nationalities may make up hotel guests on this route. They are based on past patterns, not a list of confirmed guests."
     : `There are no past flight records for ${result.route.origin}. The visitor estimate starts from ${state.peerProfile ? "the weighted comparison-country blend" : result.route.proxyOriginKey || "overall past patterns"}, so use it as a rough guide.`;
   $("#visitorNationalityCards").innerHTML = rows.map((row, index) => ({ row, index }))
     .sort((a, b) => b.row.weight - a.row.weight).map(card).join("") + `<article class="vm-nationality-card vm-other-card" style="--nationality-color:#61708b">
       <div class="vm-card-country"><h3>Other nationalities</h3><small>${remaining.length} groups combined</small></div>
       <div class="vm-card-share"><span class="vm-share-value" data-bridge-other>${formatPercent(otherShare, 1)}</span></div>
       ${counts(otherShare, otherNights)}
     </article>`;
   updateBridgeDraftTotal();
   $("#bridgeShareChart").innerHTML = visitorOriginMap(rows, palette, flag);
   const supportLabels = { Low: "No route records", Medium: "A few records", High: "Several records" };
   const supportLabel = supportLabels[result.confidence.label] || "Past records";
   $("#confidenceLabel").textContent = supportLabel;
   $("#confidenceBadge").className = `confidence ${result.confidence.label.toLowerCase()}`;
 }
  
 function renderValidation() {
   const metrics = data.metrics;
   const actualTotal = data.validation.reduce((sum, row) => sum + row.actual, 0);
   const errorTotal = (field) => data.validation.reduce((sum, row) => sum + Math.abs(row.actual - row[field]), 0);
   const liveError = errorTotal("transparent") / actualTotal;
   const periodLabel = (period) => `${data.months[Number(period.slice(5, 7)) - 1].slice(0, 3)} ${period.slice(0, 4)}`;
   const checkedPeriod = `${periodLabel(data.validation[0].month)}–${periodLabel(data.validation[data.validation.length - 1].month)}`;
   $("#validationSummary").textContent = `Air2Stay was tested on ${data.validation.length} months kept out of conversion calibration (${checkedPeriod}). Its overall weighted error was ${formatPercent(liveError, 2)} of recorded hotel arrivals. The chart below compares estimates with actual arrivals month by month. This checks monthly totals using recorded flight inputs.`;
   const validationWindows = $("#validationWindows");
   const firstPeriod = data.validation[0].month;
   const lastPeriod = data.validation[data.validation.length - 1].month;
   const primaryPeriod = firstPeriod.slice(0, 4) === lastPeriod.slice(0, 4)
     ? `${periodLabel(firstPeriod).split(" ")[0]}–${periodLabel(lastPeriod)}` : checkedPeriod;
   // Extended scores are supplied presentation figures, not additional rows in data.validation.
   validationWindows.innerHTML = `
     <div class="validation-windows-grid">
       <article class="validation-window-card validation-window-primary" aria-labelledby="primaryWindowLabel">
         <span class="validation-window-metric">${formatPercent(liveError, 2)}</span>
         <h2 id="primaryWindowLabel">Primary validation window</h2>
         <p>${primaryPeriod} · ${data.validation.length} months · ${(actualTotal / 1000000).toFixed(2)}M actual arrivals</p>
         <small>Weighted error · reproduced from the saved monthly records</small>
       </article>
       <div class="validation-window-progression"><span>Fuller test →</span></div>
       <article class="validation-window-card validation-window-secondary" aria-labelledby="extendedWindowLabel">
         <span class="validation-window-metric">10.42%</span>
         <h2 id="extendedWindowLabel">Extended validation window</h2>
         <p>Jan 2025–Feb 2026 · 14 months</p>
         <small>13.93% on Aug 2025–Feb 2026 alone</small>
       </article>
     </div>
     <p class="validation-window-context">Reported error was higher in the later months. Quarterly retraining was proposed for a production system.</p>
     <p class="validation-window-source">The extended figures are supplied results. The chart and monthly table cover the primary window only.</p>`;
   $("#validationScope").innerHTML = `
     <p>Weighted error measures the size of the gap relative to recorded arrivals.</p>
     <p>Training: ${metrics.flightTrainingPeriod} (${metrics.trainingMonths} months). Check period: ${metrics.validationPeriod} (${data.validation.length} months). The test used recorded flights from the check period.</p>
     <p><strong>Live default calculation:</strong> seats × flight occupancy × share ending in Abu Dhabi × a single hotel-use rate learned only from ${metrics.flightTrainingPeriod}. The check runs this chain on each held-out country-month’s recorded flights, then sums the estimates across countries. It does not test future flight schedules, occupancy forecasts, edited assumptions, visitor shares, or guest nights. Historical route baselines and visitor profiles are descriptive summaries, not independently held-out forecasts.</p>
     <p><strong>Seasonal comparison:</strong> recorded passengers ending here × (70% training month-specific hotel-use rate + 30% overall training rate). Its weighted error is ${formatPercent(metrics.seasonalChainWmape, 2)}. This is the optional seasonal assumption in Details, not the default.</p>
     <p><strong>Hybrid comparison:</strong> 55% regression estimate + 45% seasonal flight estimate. The route planner does not run this aggregate regression.</p>
     <p><strong>Reproduce the scores:</strong> add the absolute monthly mistakes and divide by recorded hotel arrivals (WMAPE). Live default: ${formatNumber(errorTotal("transparent"))} ÷ ${formatNumber(actualTotal)} × 100. Hybrid comparison: ${formatNumber(errorTotal("predicted"))} ÷ ${formatNumber(actualTotal)} × 100. Scores use full-precision predictions; the table and totals round only for readability.</p>
     <p><strong>Daily hotel guests:</strong> a separate check over ${metrics.stayValidationPeriod}, with ${formatNumber(metrics.stayValidationRows)} held-out daily records. It tested daily hotel guest counts using hotel-arrival information, not route guest-night changes. Its underlying daily rows are not shown in this monthly table.</p>
     <p id="validationRangeEvidence">Range multipliers use the live default chain’s residuals on the same check months. The range has no separate coverage test and is not a guaranteed probability range.</p>`;
   $("#validationKpis").innerHTML = [
     kpiCard("Live default chain: weighted error", formatPercent(metrics.liveChainWmape, 2), "Tested monthly hotel arrivals across all included markets", "positive"),
     kpiCard("Hybrid comparison: weighted error", formatPercent(metrics.flightToCheckinsWmape, 2), "Tested the comparison model on the same monthly totals", "positive"),
     kpiCard("Daily hotel guests: total weighted error", formatPercent(metrics.stayModelWmape, 1), "Separate daily hotel-guest test; not route guest-night accuracy", "neutral"),
   ].join("");

   const maxRaw = Math.max(...data.validation.flatMap((row) => [row.actual, row.predicted, row.transparent * (1 + liveError)]));
   const max = Math.ceil(maxRaw / 50000) * 50000;
   const width = 760;
   const height = 300;
   const pad = { left: 78, right: 24, top: 18, bottom: 48 };
   const x = (index) => pad.left + index * ((width - pad.left - pad.right) / Math.max(1, data.validation.length - 1));
   const y = (value) => height - pad.bottom - value / max * (height - pad.top - pad.bottom);
   const path = (field) => data.validation.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(row[field]).toFixed(1)}`).join(" ");
   const upperBand = data.validation.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(row.transparent * (1 + liveError)).toFixed(1)}`).join(" ");
   const lowerBand = data.validation.map((row, index) => `L${x(index).toFixed(1)},${y(row.transparent * (1 - liveError)).toFixed(1)}`).reverse().join(" ");
   const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => ({ value: max * share, y: y(max * share) }));
   $("#validationChart").innerHTML = `
     <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded hotel arrivals compared with Air2Stay estimates">
       ${ticks.map((tick) => `<line x1="${pad.left}" y1="${tick.y}" x2="${width - pad.right}" y2="${tick.y}" class="grid-line"/><text x="${pad.left - 10}" y="${tick.y + 4}" text-anchor="end">${Math.round(tick.value / 1000)}k</text>`).join("")}
       <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" class="axis"/>
       <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" class="axis"/>
       <path d="${upperBand} ${lowerBand} Z" class="validation-error-band"><title>Visual guide: plus or minus ${formatPercent(liveError, 2)} of each live estimate. This is not a tested prediction interval.</title></path>
       <path d="${path("actual")}" class="actual-line"/>
       <path d="${path("transparent")}" class="transparent-line"/>
       <path d="${path("predicted")}" class="predicted-line"/>
       ${data.validation.map((row, index) => `<circle cx="${x(index)}" cy="${y(row.transparent)}" r="5" tabindex="0" fill="#c9a84c"><title>${row.month}: recorded ${formatNumber(row.actual)}, live default estimate ${formatNumber(row.transparent)}, comparison ${formatNumber(row.predicted)}</title></circle><text x="${x(index)}" y="${height - 22}" text-anchor="middle">${row.month}</text>`).join("")}
     </svg><p class="validation-band-caption"><span aria-hidden="true"></span>Shaded band: ±${formatPercent(liveError, 2)} around the live default estimate. A visual guide based on overall weighted error, not a guaranteed range.</p>`;

   const errorCell = (row, field) => {
     const error = Math.abs(row.actual - row[field]) / row.actual;
     const level = error < .05 ? "low" : error > .1 ? "high" : "medium";
     const explanation = level === "low" ? "Below 5% error" : level === "high" ? "Above 10% error" : "5–10% error";
     return `<td class="validation-error-${level}" title="${explanation}">${formatPercent(error, 1)}</td>`;
   };

   $("#validationTable").innerHTML = `<table>
     <thead><tr><th>Month checked</th><th>Recorded hotel arrivals</th><th>Live default estimate</th><th>Live error</th><th>Hybrid comparison</th><th>Hybrid error</th></tr></thead>
     <tbody>${data.validation.map((row) => `<tr><td>${row.month}</td><td>${formatNumber(row.actual)}</td><td>${formatNumber(row.transparent)}</td>${errorCell(row, "transparent")}<td>${formatNumber(row.predicted)}</td>${errorCell(row, "predicted")}</tr>`).join("")}</tbody>
   </table>
   <p class="validation-table-caption">Lower % means a closer estimate. Live default weighted error: ${formatPercent(liveError, 2)}.</p>`;

   const modelComparison = $("#validationModelComparison");
   modelComparison.innerHTML = `
     <div class="section-heading"><div><p>Compare the approaches</p><h2 id="modelComparisonTitle">Model comparison</h2></div></div>
     <p class="model-comparison-periods">Training: 2022–2024. Test scores read left to right: Jan–Jul 2025 → Aug 2025–Feb 2026. Lower weighted error (WMAPE) means a closer estimate.</p>
     <div class="model-comparison-scroll" tabindex="0" role="region" aria-label="Model comparison scores; scroll horizontally on narrow screens">
       <table>
         <thead><tr><th scope="col">Model</th><th scope="col">Train WMAPE</th><th scope="col">Test WMAPE</th><th scope="col">Verdict</th></tr></thead>
         <tbody>
           <tr class="model-comparison-live"><th scope="row">Live chain</th><td>9.67%</td><td dir="ltr">${formatPercent(liveError, 2)} <span class="model-score-arrow">→</span> 13.93%</td><td>Underfit: constant rate can't follow seasonality</td></tr>
           <tr><th scope="row">Seasonal chain</th><td>4.90%</td><td dir="ltr">${formatPercent(metrics.seasonalChainWmape, 2)} <span class="model-score-arrow">→</span> 8.72%</td><td>Fine, but drifts low</td></tr>
           <tr><th scope="row">Ridge alone</th><td>5.53%</td><td dir="ltr">8.56% <span class="model-score-arrow">→</span> 11.88%</td><td>Mild overfit</td></tr>
         </tbody>
       </table>
     </div>
     <p class="model-comparison-source">The primary live and seasonal test scores match saved results. Training, Ridge-only and later-window scores are supplied figures; verdicts are supplied interpretations, not verified diagnoses.</p>`;
 }

  
 function scheduleRender() {
   if (renderQueued) return;
   renderQueued = true;
   requestAnimationFrame(() => {
     renderQueued = false;
     renderAll();
   });
 }

const planningEscape = (value) => String(value).replace(/[&<>"']/g, (letter) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[letter]);
function planningTable(headers, rows) {
  return '<table class="planning-table"><thead><tr>' + headers.map((value) => '<th>' + planningEscape(value) + '</th>').join('') + '</tr></thead><tbody>' + rows.map((row) => '<tr>' + row.map((value) => '<td>' + planningEscape(value) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}

function decisionOptions() {
  const field = $("#alternativeOrigin");
  if (field.value === state.originKey && !field.dataset.userSelected) field.value = knownOrigins().find((item) => item.key !== state.originKey)?.key || field.value;
  let alternative = defaultState(field.value, state.month);
  alternative = { ...alternative, extraFlights:state.extraFlights, seatsPerFlight:state.seatsPerFlight, conversionRate:state.conversionRate, eventUplift:state.eventUplift };
  if ($("#sameComparisonAssumptions").checked) alternative = {...alternative,loadFactor:state.loadFactor,p2pShare:state.p2pShare,averageStay:state.averageStay,routePurpose:state.routePurpose};
  return [{id:"proposal",label:"Current proposal · " + findRoute(data,state.originKey,state.month,state.proxyOriginKey,state.peerProfile).origin,inputs:{...state,bridgeOverride}},
    {id:"existing",label:"Extra flights · " + findRoute(data,alternative.originKey,state.month).origin,inputs:alternative}];
}

function resolvedMonthInputs(month, source) {
  if (!$("#refreshMonthAssumptions").checked) return { ...source, month, peerProfile:source.referenceMode === "peers" ? buildPeerProfile(data,countryLocationLookup,source.originKey,month) : null };
  const refreshed = defaultState(source.originKey,month,source.referenceMode === "peers" ? "__PEERS__" : source.proxyOriginKey);
  return {...refreshed,extraFlights:source.extraFlights,seatsPerFlight:source.seatsPerFlight,eventUplift:source.eventUplift,
    conversionRate:source.seasonalConversion ? CONVERSION_EVIDENCE.monthlyRates[month] : source.conversionRate,
    ...(source.purposeAssumptionsApplied ? {averageStay:source.averageStay} : {}),
    routePurpose:source.routePurpose,purposeAssumptionsApplied:source.purposeAssumptionsApplied,seasonalConversion:source.seasonalConversion};
}

function renderMonthComparisonChart(monthly) {
  const values = monthly.map((row) => row.incremental.guestNights);
  const top = Math.max(0, ...values);
  const bottom = Math.min(0, ...values);
  const span = top - bottom || 1;
  const zero = top / span * 100;
  const highest = values.indexOf(Math.max(...values));
  $("#monthChart").innerHTML = `<p class="compare-chart-key"><span class="month-key-selected">Selected month</span><span class="month-key-highest">Highest month</span></p>
    <div class="month-comparison-bars" role="img" aria-label="Extra guest nights by month. ${planningEscape(monthly.map((row, index) => row.monthName + ": " + formatSigned(values[index])).join("; "))}">
    ${monthly.map((row, index) => `<div class="month-comparison-column${row.month === state.month ? " selected" : ""}${index === highest ? " highest" : ""}" title="${planningEscape(row.monthName)}: ${formatSigned(values[index])} guest nights">
      <div class="month-comparison-plot" style="--zero:${zero}%"><i class="${values[index] < 0 ? "negative" : ""}" style="--bar-size:${Math.abs(values[index]) / span * 100}%"></i></div><small>${planningEscape(row.monthName.slice(0, 3))}</small></div>`).join("")}
    </div>`;
}

function renderStressComparisonChart(stress) {
  const scale = Math.max(1, ...stress.trials.map((row) => Math.abs(row.differenceFromPlan)));
  $("#stressChart").innerHTML = `<p class="compare-chart-key">Difference in extra guest nights from the selected plan</p><ul class="stress-comparison-bars">
    ${stress.trials.map(({label, differenceFromPlan}) => `<li><span>${planningEscape(label)}</span><div class="stress-comparison-track" aria-hidden="true"><i class="${differenceFromPlan < 0 ? "negative" : ""}" style="--bar-size:${Math.abs(differenceFromPlan) / scale * 50}%"></i></div><strong>${formatSigned(differenceFromPlan)}</strong></li>`).join("")}
  </ul>`;
}

function renderDecisionWorkspace() {
  if ($("#decisionWorkspace").hidden || !$("#inputError").hidden) return;
  const options = decisionOptions();
  const comparison = compareOptions(data,options);
  $("#routeOptions").innerHTML = planningTable(["Option","Extra check-ins","Extra nights","Nights / 1,000 added seats","Flights full","Trip ends here","Hotel use","Nights / stay"], comparison.options.map((row) => [row.label,formatNumber(row.incremental.hotelCheckins),formatNumber(row.incremental.guestNights),row.per1000AddedSeats == null ? "No added capacity" : formatNumber(row.per1000AddedSeats),formatPercent(row.inputs.loadFactor,1),formatPercent(row.inputs.p2pShare,1),formatPercent(row.inputs.conversionRate,1),row.inputs.averageStay.toFixed(2)]));
  const reversals = rankingReversals(data,options);
  const changedTrials = reversals.trials.filter((trial) => trial.rankingChanged).map((trial) => trial.label);
  $("#rankingConclusion").textContent = !comparison.winnerId ? "Add positive flight capacity to compare hotel-night yield." : comparison.winnerIds.length > 1
    ? "Both options have the same estimated yield per added seat. Identical passenger and hotel assumptions produce a tie; country names alone do not create demand."
    : comparison.options.find((row) => row.id === comparison.winnerId).label + " has the higher estimated yield per added seat under these assumptions. " + (changedTrials.length ? "The preference reverses under: " + changedTrials.join("; ") + ". Check those assumptions before choosing." : "The same option stays ahead in the four lower-assumption trials. This does not establish a real-world best route.");
  $("#launchOptions").innerHTML = launchOptions(data,state).map((row) => `<article class="launch-card"><h3>${planningEscape(row.label)}</h3><strong>${row.extraFlights} ${row.extraFlights === 1 ? "flight" : "flights"} / week</strong><p>${formatNumber(row.incremental.hotelCheckins)} extra check-ins</p><p>${formatNumber(row.incremental.guestNights)} extra guest nights</p>${row.duplicateSchedule ? '<small>Same schedule as another option at the control limit.</small>' : ''}</article>`).join("");
  const monthly = compareMonths(data,state,Array.from({length:12},(_,index)=>index+1),resolvedMonthInputs);
  $("#monthComparisonNote").textContent = $("#refreshMonthAssumptions").checked
    ? "Each month refreshes market flight fullness, trip-ending share and starting stay estimates; flight count and aircraft seats stay fixed. Hotel use stays at your chosen rate unless you applied the training-season option. Any visitor-purpose stay assumption is retained. These are seasonal planning estimates, not future bookings."
    : "All selected flight and hotel assumptions stay fixed. Differences mainly reflect days in each month, not a learned seasonal demand effect.";
  renderMonthComparisonChart(monthly);
  $("#monthOptions").innerHTML = planningTable(["Month","Extra guest nights","Nights / 1,000 added seats","Flights full","Hotel use","Nights / stay"],monthly.map((row)=>[row.monthName,formatNumber(row.incremental.guestNights),row.per1000AddedSeats == null ? "—" : formatNumber(row.per1000AddedSeats),formatPercent(row.inputs.loadFactor,1),formatPercent(row.inputs.conversionRate,1),row.inputs.averageStay.toFixed(2)]));
  const stress = stressTest(data,state);
  renderStressComparisonChart(stress);
  $("#stressOptions").innerHTML = planningTable(["Trial","Extra guest nights","Change from selected assumptions"],[["Selected assumptions",formatNumber(stress.base.incremental.guestNights),"—"],...stress.trials.map((row)=>[row.label,formatNumber(row.incremental.guestNights),formatSigned(row.differenceFromPlan)])]);
  const note = decisionNote(data,state,options);
  const ending = note.workplaceDecision;
  $("#decisionNote").innerHTML = `<p class="decision-question">${planningEscape(ending.question)}</p>
    <div class="decision-answers"><article><h3>Hotel nights to plan for</h3><button type="button" class="text-action" data-evidence="routes">See the route comparison →</button></article>
    <article><h3>Check this assumption first</h3><div id="firstCheckText" class="first-check"></div><button type="button" class="text-action" data-evidence="stress">See the lower-assumption trials →</button></article></div>
    <details><summary>Questions for airlines and hotels</summary>
      <ul><li>Ask the airline how many of the arrivals will be residents returning home.</li>
      <li>Ask hotels about guests per occupied room before using guest nights to plan rooms or staffing.</li>
      <li>${planningEscape(ending.verification[1])}</li></ul>
    </details>
    <button type="button" class="text-action" data-evidence="followups">Open follow-ups →</button>`;
  fillFirstCheck();
  if (targetSolution) updateTargetResult();
}

function updateTargetResult() {
  const field = $("#targetGuestNights");
  const value = Number(field.value);
  $("#applyTarget").hidden = true;
  if (!field.value.trim() || !Number.isFinite(value) || value < 0 || value > 100000000) { $("#targetResult").textContent = "Enter a target between 0 and 100,000,000 extra guest nights."; targetSolution=null; return; }
  targetSolution = solveCapacityTarget(data,state,value);
  $("#targetResult").textContent = targetSolution.met
    ? `${targetSolution.requiredWeeklyFlights} extra flights each week would reach at least ${formatNumber(value)} extra guest nights under the selected assumptions (about ${formatNumber(targetSolution.metrics.incremental.guestNights)} nights). This is required capacity, not proof of passenger demand.`
    : `The target is not reached within 20 extra flights per week. At that limit the estimate is ${formatNumber(targetSolution.metrics.incremental.guestNights)} nights, leaving ${formatNumber(targetSolution.shortfall)} nights below the target.`;
  $("#applyTarget").hidden = !targetSolution.met;
}

function renderPlanningEvidence(result) {
  $("#peerEvidenceBlock").hidden = !state.peerProfile;
  if (state.peerProfile) {
    const profile=state.peerProfile;
    $("#peerEvidence").innerHTML = `<p>${planningEscape(profile.method)}</p><div class="table-scroll">${planningTable(["Comparison country","Weight","Centroid distance","Route-length gap"],profile.peers.map((peer)=>[peer.origin,formatPercent(peer.weight,1),formatNumber(peer.distanceKm)+" km",formatNumber(peer.routeLengthGapKm)+" km"]))}</div><p class="planning-note">${planningEscape(profile.weightingRule)}. The design weights were not fitted to hotel outcomes.</p><ul>${profile.limitations.map((line)=>'<li>'+planningEscape(line)+'</li>').join('')}</ul>`;
  }
  const evidence=CONVERSION_EVIDENCE;
  const rate=evidence.monthlyRates[state.month];
  $("#conversionEvidence").innerHTML = `<p>Country-specific hotel-use rates require linking flight and hotel records. <button type="button" class="text-action" data-evidence="mix-method">See why the countries differ →</button></p><p>For ${planningEscape(data.months[state.month-1])}, the optional training-season aggregate rate is <strong>${formatPercent(rate,2)}</strong>. It uses three observations of that calendar month from ${evidence.trainingPeriod}. It is not a measured probability for this route.</p><p>August–December have no matching held-out month in this test. <button type="button" class="text-action" data-evidence="validation">Compare the validation scores →</button></p><details><summary>Method and monthly starting rates</summary><p>${planningEscape(evidence.method)}</p><div class="table-scroll">${planningTable(["Month","Optional hotel-use assumption"],Object.entries(evidence.monthlyRates).map(([month,value])=>[data.months[Number(month)-1],formatPercent(value,2)]))}</div></details>`;
  if (!peerValidationResult) peerValidationResult = validatePeerMethod(data,countryLocationLookup);
  const validation=peerValidationResult;
  $("#peerValidation").innerHTML = `<p>We hid one known market at a time and reconstructed its flight assumptions from other markets in the same month: ${validation.caseCount} market-month checks across ${validation.marketCount} markets.</p><div class="table-scroll">${planningTable(["Assumption","Three-market average error","Nearest-country average error"],Object.values(validation.metrics).map((row)=>[row.label,row.blendedMae.toFixed(2)+" "+row.unit,row.nearestMae.toFixed(2)+" "+row.unit]))}</div><ul>${validation.limitations.map((line)=>'<li>'+planningEscape(line)+'</li>').join('')}</ul>`;
}

const formatPercentPlain = (value) => Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 }) + "%";

function targetAnswerText(answer) {
  if (answer.alreadyMet) return `The plan already reaches ${formatNumber(answer.target)} hotel nights without extra flights.`;
  const goal = answer.basis === "total" ? `reach ${formatNumber(answer.target)} hotel nights in total` : `add ${formatNumber(answer.target)} hotel nights`;
  return `To ${goal}: about ${answer.requiredWeeklyFlights} extra flights a week (${answer.exactWeeklyFlights.toFixed(2)} before rounding up). ${answer.realism.text}`;
}

function renderTargetWorkspace() {
  if ($("#targetWorkspace").hidden || !$("#inputError").hidden || !state) return;
  const field = $("#targetNights");
  const value = Number(field.value);
  const basis = $("#targetBasis").value;
  const month = data.months[state.month - 1];
  if (!field.value.trim() || !Number.isFinite(value) || value < 0 || value > 100000000) {
    targetAnswer = null;
    $("#targetAnswer").innerHTML = '<p class="planning-callout">Enter a number of hotel nights between 0 and 100,000,000.</p>';
    $("#targetSteps").innerHTML = ""; $("#targetAlternatives").innerHTML = "";
    return;
  }
  let answer;
  try { answer = reverseTargetPlan(data, state, value, { basis }); }
  catch (error) { targetAnswer = null; $("#targetAnswer").innerHTML = `<p class="planning-callout">${planningEscape(error.message)}</p>`; return; }
  targetAnswer = answer;
  $("#targetContext").textContent = `${answer.route.origin}, ${month}. Without extra flights this plan gives about ${formatNumber(answer.startingNights)} hotel nights` + (basis === "total" ? `, so the target needs ${formatNumber(answer.neededNights)} more.` : `, so the target total is about ${formatNumber(answer.targetTotalNights)}.`) + " Change the country or month in Adjust plan.";
  const current = Number(state.extraFlights);
  const canApply = !answer.alreadyMet && answer.withinControlLimit && answer.requiredWeeklyFlights !== current;
  const headline = answer.alreadyMet
    ? `<strong class="target-big">No extra flights needed</strong><p>The plan already reaches this many nights with its usual flights.</p>`
    : `<strong class="target-big">${answer.requiredWeeklyFlights} extra flights a week</strong><p>${answer.exactWeeklyFlights.toFixed(2)} before rounding up · about ${formatNumber(answer.extraFlightsPerMonth)} more flights in ${planningEscape(month)} · each one adds about ${formatNumber(answer.nightsPerWeeklyFlight)} hotel nights a month</p>`;
  $("#targetAnswer").innerHTML = `<div class="target-headline"><div>${headline}</div>
    <div class="target-actions">${canApply ? `<button type="button" id="applyTargetPlan" class="feature-primary">Use ${answer.requiredWeeklyFlights} flights in my plan</button>` : ""}<small>${answer.alreadyMet ? "" : !answer.withinControlLimit ? `Above the planner's limit of 20 extra flights a week, so it can't be applied as one route.` : answer.requiredWeeklyFlights === current ? "Your plan already uses this many extra flights." : `Your plan currently has ${formatSigned(current)} a week.`}</small></div></div>
    ${answer.alreadyMet ? "" : `<p class="target-realism target-${answer.realism.level}">${planningEscape(answer.realism.text)}</p>`}`;
  const unit = (key, v) => key === "weeklyFlights" ? v.toFixed(2) : formatNumber(v);
  $("#targetSteps").innerHTML = answer.alreadyMet ? '<li class="target-step"><span>Nothing to work back: the target is already met.</span></li>'
    : answer.steps.map((step) => `<li class="target-step${step.key === "weeklyFlights" ? " target-step-final" : ""}"><span class="target-op">${planningEscape(step.operation || "Start")}</span><span class="target-label">${planningEscape(step.label)}</span><strong>${unit(step.key, step.value)}</strong></li>`).join("");
  $("#targetAlternatives").innerHTML = !answer.alternatives.length
    ? `<p class="planning-note">${answer.alreadyMet ? "Not needed: the target is already met." : "This route has no current flights, so only new flights can add hotel nights here."}</p>`
    : `<div class="launch-grid">${answer.alternatives.map((lever) => {
        const show = (v) => lever.unit === "nights" ? `${v.toFixed(2)} nights` : formatPercent(v, 1);
        return `<article class="launch-card"><h3>${planningEscape(lever.label)}</h3><strong>${show(lever.from)} → ${show(lever.to)}</strong><p>${lever.withinLimits ? "Within the planner's limits." : `Beyond the planner's limit of ${show(lever.limit)}, so not reachable this way alone.`}</p></article>`;
      }).join("")}</div><p class="planning-note">Each card changes one assumption for everyone already flying this route, with no extra flights. They suggest where campaigns could help, for example longer stays or more hotel bookings; they are not measured effects.</p>`;
}

function setupTargetWorkspace() {
  const rerender = () => renderTargetWorkspace();
  $("#targetNights").addEventListener("input", () => { $("#targetAskStatus").textContent = ""; rerender(); });
  $("#targetBasis").addEventListener("input", () => { $("#targetAskStatus").textContent = ""; rerender(); });
  $("#targetAnswer").addEventListener("click", (event) => {
    if (!event.target.closest("#applyTargetPlan") || !targetAnswer?.withinControlLimit || targetAnswer.alreadyMet) return;
    state.extraFlights = targetAnswer.requiredWeeklyFlights;
    setFormFromState(); renderAll();
    $("#targetAskStatus").textContent = `Your plan now has ${targetAnswer.requiredWeeklyFlights} extra flights a week. Open Focus to see the full result.`;
  });
  $("#targetAskForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const status = $("#targetAskStatus");
    if (!$("#inputError").hidden) { status.textContent = "Please fix the highlighted plan input first, then ask again."; return; }
    const question = parseTargetQuestion(data, arabicPromptToEnglish(data, $("#targetAsk").value.slice(0, HELP_CHAT_MAX_INPUT)));
    if (!question) { status.textContent = "I couldn't find a number of hotel nights. Try “How many flights for 10,000 more nights from India in December?”"; return; }
    if (question.decrease) { status.textContent = "I work out the extra flights needed to increase hotel nights. To test fewer flights, set a negative change, like “Set extra flights to -2”."; return; }
    if (question.tooLarge) { status.textContent = "That target is too large for this planner. Use fewer than 1,000,000,000 hotel nights, or an increase of up to 100,000%."; return; }
    const switched = [];
    if (question.originKey && question.originKey !== state.originKey && [...$("#origin").options].some((option) => option.value === question.originKey)) {
      $("#origin").value = question.originKey; $("#origin").dispatchEvent(new Event("input", { bubbles: true })); switched.push("country");
    }
    if (question.month && question.month !== state.month) {
      $("#month").value = String(question.month); $("#month").dispatchEvent(new Event("input", { bubbles: true })); switched.push("month");
    }
    const switchedNote = switched.length ? [" ", `I switched the plan's ${switched.join(" and ")} to match your question.`] : [];
    if (!$("#inputError").hidden) { status.textContent = "Please fix the highlighted plan input first, then ask again."; return; }
    let nights = question.target;
    if (question.percent != null) {
      // A percentage is applied to the nights this plan gives without extra flights.
      const usual = reverseTargetPlan(data, state, 0);
      if (!(usual.startingNights > 0)) {
        status.replaceChildren(`${usual.route.origin} in ${data.months[state.month - 1]} has no hotel nights without extra flights, so a percentage increase cannot be worked out. Give a number of nights instead, like “How many flights for 5,000 more nights?”`, ...switchedNote);
        return;
      }
      nights = Math.round(usual.startingNights * question.percent / 100);
    }
    $("#targetBasis").value = question.percent != null ? "extra" : question.basis;
    $("#targetNights").value = String(Math.round(nights));
    renderTargetWorkspace();
    const route = targetAnswer?.route?.origin || state.originKey;
    const answering = question.percent != null
      ? `Answering for ${route}, ${data.months[state.month - 1]}: a ${formatPercentPlain(question.percent)} increase, about ${formatNumber(nights)} more hotel nights.`
      : `Answering for ${route}, ${data.months[state.month - 1]}: ${question.basis === "total" ? "reach a total of" : "add"} ${formatNumber(nights)} hotel nights.`;
    status.replaceChildren(answering, ...switchedNote);
  });
}

// Floating "Ask Air2Stay" assistant in the bottom-right corner.
// Answers come from the local chat engine only: no network.
const HELP_CHAT_KEY = "air2stay.assistant.v1";
let helpChatMessages = [];
let helpChatOpener = null;

const HELP_CHAT_MAX_INPUT = 400;
const HELP_CHAT_MAX_STORED = 4000;

// Typed text: drop control and direction-override characters that could hide
// or visually reverse what was written.
function helpChatClean(text) {
  return String(text ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, "").trim();
}

function helpChatLanguageOf(text) {
  return /[؀-ۿ]/.test(String(text)) ? "ar" : "en";
}

// Replies are written once, in the language the question was asked in, and
// stored as final text. Switching the page language never rewrites the chat.
function helpChatInLanguage(text, lang) {
  if (lang !== "ar") return text;
  return String(text).split("\n").map((line) => {
    const bullet = line.match(/^(\s*[-*•]\s+)(.+)$/);
    if (bullet) return bullet[1] + helpChatLocalize(bullet[2]);
    return line.trim() ? helpChatLocalize(line) : line;
  }).join("\n");
}

function helpChatGreeting(lang = uiLanguage) {
  const english = "Hi, I’m the Air2Stay assistant. I run on this computer, so no internet is needed.\n\n- Ask how a number was worked out.\n- Ask what it takes to reach a hotel-night target.\n- Tell me a change, like “Set extra flights to 5”.";
  return { role:"bot", lang, text:helpChatInLanguage(english, lang) };
}

function saveHelpChat() {
  try { localStorage.setItem(HELP_CHAT_KEY, JSON.stringify(helpChatMessages.slice(-40))); } catch { /* Storage unavailable: keep this visit only. */ }
}

function helpChatElement(message) {
  const element = document.createElement("div");
  element.className = `help-chat-message ${message.role === "user" ? "user" : "bot"}`;
  // Each message keeps the direction of its own language.
  element.lang = message.lang === "ar" ? "ar" : "en";
  element.dir = message.role === "user" ? "auto" : message.lang === "ar" ? "rtl" : "ltr";
  if (message.role === "user") { element.textContent = message.text; return element; }
  let list = null, paragraph = null;
  for (const raw of String(message.text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { list = null; paragraph = null; continue; }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    let target;
    if (bullet) {
      paragraph = null;
      if (!list) { list = document.createElement("ul"); element.append(list); }
      target = document.createElement("li"); list.append(target);
    } else {
      list = null;
      if (!paragraph) { paragraph = document.createElement("p"); element.append(paragraph); }
      else paragraph.append(document.createTextNode(" "));
      target = paragraph;
    }
    target.append(document.createTextNode(bullet ? bullet[1] : line));
  }
  return element;
}

function renderHelpChat() {
  const log = $("#helpChatLog");
  log.replaceChildren(...helpChatMessages.map(helpChatElement));
  log.scrollTop = log.scrollHeight;
}

function updateHelpChatContext() {
  const label = $("#helpChatContext");
  if (!label || !state) return;
  if (!$("#inputError").hidden) { label.textContent = "Your plan has an input to fix"; return; }
  const origin = currentProposalContext?.result?.route?.origin || $("#origin").selectedOptions[0]?.textContent || state.originKey;
  const flights = Number(state.extraFlights);
  label.textContent = `About your plan: ${origin} · ${data.months[state.month - 1]} · ${flights ? formatSigned(flights) + " flights a week" : "usual flights"}`;
}

const HELP_CHAT_NOT_UNDERSTOOD = "I can’t answer that one on this computer yet. Try one of these:\n\n- “How were hotel nights calculated?”\n- “How many flights for 10,000 more nights?”\n- “Set flight occupancy to 80%”\n- “What should I check next?”";

function helpChatAnswer(prompt, raw = prompt) {
  const plain = prompt.trim().toLowerCase().replace(/[!.?,]+$/g, "");
  if (/^(?:hi|hello|hey|hiya|salam|salaam|assalamu? ?alaikum|marhaba|good (?:morning|afternoon|evening))(?: there| air2stay)?$/.test(plain)) {
    return "Hello! I can explain your plan, work out what it takes to reach a hotel-night target, or change an assumption for you.\n\nTry “How were hotel nights calculated?” or tap one of the suggestions below.";
  }
  if (/^(?:thanks|thank you|thx|shukran|great|perfect|ok(?:ay)?|cool|nice)(?: (?:a lot|so much|very much))?$/.test(plain)) {
    return "You’re welcome. Ask me anything else about this plan whenever you need.";
  }
  if (/^(?:help|what can you do|what can i ask(?: you)?|how (?:do|can) i use you|what are your capabilities)$/.test(plain)) {
    return "I can help with the plan you have open.\n\n- Explain: “How were hotel nights calculated?” or “Where does the baseline come from?”\n- Targets: “How many flights for 10,000 more nights from India in December?”\n- Changes: “Set flight occupancy to 80%” or “Add 5 flights from France in December”.\n- Next steps: “What should I check next?”\n\nI work out numbers with the same calculator as the rest of the app, and I only change your plan when you ask directly.";
  }
  const messageQuery = pcMessagesQuery(raw);
  if (messageQuery) return pcMessagesReply(messageQuery, teamSnapshot());
  if (!$("#inputError").hidden) return "Please fix the highlighted plan input first, then ask again.";
  readForm();
  const result = runScenario(data, state);
  const reply = planningChatReply(data, prompt, state, result, proposalWorkspace?.contextSummary(), helpChatExtras());
  const onPlanPage = $("#scenarioView").classList.contains("active");
  const seeIt = onPlanPage ? "" : "\n\nOpen Plan a route to see the updated result.";
  if (reply.type === "reset") {
    state = defaultState("INDIA", 12); bridgeOverride = null; setFormFromState(); renderAll();
    return reply.text + seeIt;
  }
  if (reply.type === "apply" && reply.parsed.understood) {
    try { const text = applyAssistantPlan(reply.parsed); renderAll(); return helpChatAppliedLines(text) + seeIt; }
    catch (error) { return `The plan was not changed.\n${friendlyPlanError(error)}`; }
  }
  if (reply.type === "apply") return HELP_CHAT_NOT_UNDERSTOOD;
  return reply.text;
}

// Split "Applied to X in Y: a, b." into one line per change for translation.
function helpChatAppliedLines(text) {
  const match = String(text).match(/^(Applied to .+?:) (.+)\.$/);
  return match ? match[1] + "\n" + match[2].split(", ").map((item) => "- " + item).join("\n") : text;
}

// Translate one English line to Arabic from the app's dictionary. Lines with
// no dictionary entry stay in English rather than being guessed.
const helpChatTemplates = [];
const helpChatLowerKeys = new Map();
function helpChatLocalize(text, depth = 0) {
  if (!text) return text;
  if (!helpChatTemplates.length) {
    for (const [pattern, key, names] of helpChatOwnTemplates) helpChatTemplates.push([pattern, key, names]);
    for (const [pattern, key, names] of labelTemplates) if (key.startsWith("tgt_")) helpChatTemplates.push([pattern, key, names]);
    for (const [pattern, key, names] of labelTemplates) if (!key.startsWith("tgt_")) helpChatTemplates.push([pattern, key, names]);
    for (const [english, key] of labelKeys) helpChatLowerKeys.set(english.toLowerCase(), key);
  }
  const trimmed = String(text).trim();
  const key = labelKeys.get(trimmed) ?? helpChatLowerKeys.get(trimmed.toLowerCase());
  if (key) return I18N.ar[key] ?? text;
  // Country and month names use the app's own Arabic name list.
  const name = arNameLookup.get(trimmed.toLowerCase());
  if (name) return name;
  if (depth > 2) return text;
  for (const [pattern, template, names] of helpChatTemplates) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    let out = I18N.ar[template] ?? I18N.en[template];
    names.forEach((name, index) => {
      const value = match[index + 1];
      const localized = /^[+−-]?[0-9][0-9,.%]*$/.test(value) ? value : helpChatLocalize(value, depth + 1);
      out = out.split("{" + name + "}").join("⁨" + localized + "⁩");
    });
    return out;
  }
  return text;
}

function sendHelpChat(prompt, { lang } = {}) {
  const text = helpChatClean(prompt).slice(0, HELP_CHAT_MAX_INPUT);
  if (!text) return;
  // Reply in the language the message is written in. Suggestion buttons have
  // English prompts, so they follow the page language instead.
  const language = lang === "ar" || lang === "en" ? lang : helpChatLanguageOf(text);
  const shown = language === "ar" && helpChatLanguageOf(text) === "en" ? helpChatLocalize(text) : text;
  helpChatMessages.push({ role:"user", lang:language, text:shown });
  let answer;
  try {
    answer = helpChatAnswer(arabicPromptToEnglish(data, text), text);
    // Not understood: retry once with close misspellings corrected, and say so.
    if (answer === HELP_CHAT_NOT_UNDERSTOOD || answer.startsWith("I couldn’t find a message that matches those words.")) {
      const fixed = pcFixTypos(data, text);
      const retry = fixed ? helpChatAnswer(fixed.text, fixed.text) : null;
      if (retry && retry !== HELP_CHAT_NOT_UNDERSTOOD && !retry.startsWith("I couldn’t find a message")) {
        answer = fixed.fixes.map(([from, to]) => `I read “${from}” as “${to}”.`).join("\n") + "\n" + retry;
      }
    }
  }
  catch (error) { answer = "Something went wrong, and your plan was not changed."; }
  helpChatMessages.push({ role:"bot", lang:language, text:helpChatInLanguage(answer, language) });
  if (helpChatMessages.length > 40) helpChatMessages = helpChatMessages.slice(-40);
  saveHelpChat(); renderHelpChat(); updateHelpChatContext();
}

function setHelpChatOpen(open, opener = null) {
  const panel = $("#helpChat");
  panel.hidden = !open;
  document.body.classList.toggle("help-chat-open", open);
  $$("[data-assistant-open]").forEach((button) => button.setAttribute("aria-expanded", String(open)));
  if (open) {
    helpChatOpener = opener || helpChatOpener;
    updateHelpChatContext(); renderHelpChat();
    $("#helpChatInput").focus({ preventScroll:true });
  } else {
    const back = helpChatOpener && helpChatOpener.getClientRects().length ? helpChatOpener : null;
    back?.focus({ preventScroll:true });
  }
}

function setupHelpChatPosition(element, grip, keyboardGrip) {
  const key = "air2stay:" + element.id + ":position";
  let position = null;
  let drag = null;
  let suppressClick = false;

  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) position = saved;
  } catch { /* Positioning works without storage. */ }

  function place({x, y}) {
    const margin = 8;
    const root = document.documentElement;
    const bound = (value, size, limit) => Math.max(margin, Math.min(value, limit - size - margin));
    const left = bound(x, element.offsetWidth, root.clientWidth);
    const top = bound(y, element.offsetHeight, root.clientHeight);
    element.style.inset = `${top}px auto auto ${left}px`;
    return {x:left, y:top};
  }

  function remember() {
    try {
      if (position) localStorage.setItem(key, JSON.stringify(position));
      else localStorage.removeItem(key);
    } catch { /* Keep this visit's position. */ }
  }

  function restore() {
    if (position && element.getClientRects().length) place(position);
  }

  grip.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const button = event.target.closest("button");
    if (button && button !== keyboardGrip) return;
    const rect = element.getBoundingClientRect();
    drag = {id:event.pointerId, x:event.clientX, y:event.clientY, left:rect.left, top:rect.top, moved:false};
    suppressClick = false;
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", (event) => {
    if (drag?.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    grip.classList.add("help-chat-dragging");
    position = place({x:drag.left + dx, y:drag.top + dy});
  });
  const finish = (event) => {
    if (drag?.id !== event.pointerId) return;
    suppressClick = drag.moved;
    drag = null;
    grip.classList.remove("help-chat-dragging");
    if (suppressClick) remember();
  };
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) grip.addEventListener(event, finish);

  if (grip === element) {
    grip.addEventListener("click", (event) => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.stopImmediatePropagation();
    }, {capture:true});
  }

  keyboardGrip.addEventListener("keydown", (event) => {
    const directions = {ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1]};
    if (event.key === "Home") {
      position = null;
      element.style.removeProperty("inset");
    } else if (Object.hasOwn(directions, event.key)) {
      const {left, top} = element.getBoundingClientRect();
      const [x, y] = directions[event.key];
      position = place({x:left + 20 * x, y:top + 20 * y});
    } else {
      return;
    }
    event.preventDefault();
    remember();
  });

  restore();
  window.addEventListener("resize", restore);
  new ResizeObserver(restore).observe(element);
}

function setupHelpChat() {
  // Stored chat is untrusted: keep only well-formed, size-limited messages.
  try {
    const saved = JSON.parse(localStorage.getItem(HELP_CHAT_KEY) || "[]");
    if (Array.isArray(saved)) helpChatMessages = saved
      .filter((item) => item && typeof item === "object" && typeof item.text === "string" && ["user", "bot"].includes(item.role))
      .slice(-40)
      .map((item) => ({ role:item.role, text:(item.role === "user" ? helpChatClean(item.text) : item.text.replace(/[‪-‮]/g, "")).slice(0, HELP_CHAT_MAX_STORED), lang:item.lang === "ar" || item.lang === "en" ? item.lang : helpChatLanguageOf(item.text) }));
  } catch { helpChatMessages = []; }
  if (!helpChatMessages.length) helpChatMessages = [helpChatGreeting()];
  const launcher = $("#helpChatBubble");
  const panel = $("#helpChat");
  setupHelpChatPosition(launcher, launcher, launcher);
  setupHelpChatPosition(panel, panel.querySelector(".help-chat-header"), $("#helpChatMove"));
  $$("[data-assistant-open]").forEach((button) => button.addEventListener("click", () => setHelpChatOpen($("#helpChat").hidden, button)));
  $("#helpChatClose").addEventListener("click", () => setHelpChatOpen(false));
  $("#helpChatClear").addEventListener("click", () => { helpChatMessages = [helpChatGreeting()]; saveHelpChat(); renderHelpChat(); $("#helpChatInput").focus(); });
  $("#helpChatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#helpChatInput");
    sendHelpChat(input.value); input.value = ""; input.focus();
  });
  $$("[data-help-prompt]").forEach((button) => button.addEventListener("click", () => { sendHelpChat(button.dataset.helpPrompt, { lang:uiLanguage }); $("#helpChatInput").focus(); }));
  $("#helpChat").addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setHelpChatOpen(false); } });
}

// Next steps: the Focus box, the Compare card, the decision note and the
// assistant all read one plan, so they always name the same first check.
let latestNextSteps = null;

function nextStepStarting(inputs, route) {
  return defaultState(route.originKey, inputs.month, inputs.referenceMode === "peers" ? "__PEERS__" : route.proxyOriginKey);
}

function followUpStatuses() {
  const summary = proposalWorkspace?.contextSummary?.();
  return Object.fromEntries((summary?.checks || [])
    .filter((check) => !String(check.id).startsWith("task:"))
    .map((check) => [check.id, check.status]));
}

function buildNextSteps() {
  if (!currentProposalContext) return null;
  const { inputs, result, starting } = currentProposalContext;
  const plan = nextStepPlan(data, inputs, result, { starting, statuses: followUpStatuses() });
  return { plan, steps: plan.steps.map((step) => ({ id: step.id, draft: step.draft, ...nextStepLines(step, result), status: step.status })) };
}

function renderNextSteps() {
  const list = $("#nextStepsList");
  const readiness = $("#nextStepsReadiness");
  if (!list || !readiness) return;
  if (!currentProposalContext || !$("#inputError").hidden) {
    latestNextSteps = null;
    readiness.textContent = "";
    list.replaceChildren();
    fillFirstCheck();
    return;
  }
  latestNextSteps = buildNextSteps();
  const { plan, steps } = latestNextSteps;
  readiness.textContent = `Decision readiness: ${plan.readiness.verified} of ${plan.readiness.total} checks have recorded evidence.`;
  list.innerHTML = steps.length ? steps.map((step) => `<li class="next-step next-step-${step.status}">
      <div class="next-step-head"><strong>${planningEscape(step.title)}</strong><span class="next-step-status">${step.status === "red" ? "Overdue" : "No recorded evidence yet"}</span></div>
      <p>${planningEscape(step.why)}</p>${step.impact ? `<p>${planningEscape(step.impact)}</p>` : ""}
      <p class="next-step-ask">${planningEscape(step.ask)}</p>
      <div class="next-step-actions"><button type="button" class="text-action" data-next-task="${planningEscape(step.id)}">Add task</button><button type="button" class="text-action" data-next-draft="${planningEscape(step.draft)}">Draft email</button></div>
    </li>`).join("")
    : '<li class="next-step next-step-done"><p>All checks have recorded evidence for these exact assumptions. You can finish with a planning decision.</p></li>';
  fillFirstCheck();
}

// Compare's "Check this assumption first" card shows the same first step.
function fillFirstCheck() {
  const target = $("#firstCheckText");
  if (!target) return;
  const first = latestNextSteps?.steps[0];
  const lines = !latestNextSteps ? [] : first ? [first.title, first.overdue, first.why, first.impact, first.ask].filter(Boolean)
    : ["All checks have recorded evidence for these exact assumptions."];
  target.innerHTML = lines.map((line, index) => index === 0 && first ? `<p><strong>${planningEscape(line)}</strong></p>` : `<p>${planningEscape(line)}</p>`).join("");
}

function setupNextSteps() {
  $("#nextStepsList").addEventListener("click", (event) => {
    const task = event.target.closest("[data-next-task]");
    const draft = event.target.closest("[data-next-draft]");
    if (!task && !draft) return;
    // The open assistant panel floats over the Follow-ups forms, so close it first.
    if (!$("#helpChat").hidden) setHelpChatOpen(false);
    $('.view-mode[data-mode="proposal"]').click();
    if (task) {
      // Follow-ups opens its task form, filled in with this check's title and owner.
      const button = [...$$('#proposalWorkspace [data-pw-action="add-task"]')].find((item) => item.dataset.check === task.dataset.nextTask);
      button?.click();
      return;
    }
    const select = $("#proposalWorkspace [data-pw-draft-kind]");
    if (select && [...select.options].some((option) => option.value === draft.dataset.nextDraft)) {
      select.value = draft.dataset.nextDraft;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
    const tool = $('#proposalWorkspace details[data-pw-tool="email"]');
    if (tool) {
      tool.open = true;
      tool.scrollIntoView({ block: "start" });
      tool.querySelector('[data-pw-action="draft"]')?.focus({ preventScroll: true });
    }
  });
}

// Settled plan results from this session, for "compare with the previous result".
// A change is kept once it has stayed for a moment, so values passed through
// while typing ("1" on the way to "15") are not treated as results.
let planHistory = [];
let planHistoryPending = null;
let planHistoryTimer = null;
const PLAN_HISTORY_SETTLE_MS = 1200;
const PLAN_HISTORY_LIMIT = 20;

function planHistoryKey(inputs) {
  return JSON.stringify(inputs);
}

function commitPlanHistory(entry) {
  if (!entry || planHistory.at(-1)?.key === entry.key) return;
  planHistory.push(entry);
  // The first result stays, so "compare with my first result" keeps working.
  if (planHistory.length > PLAN_HISTORY_LIMIT) planHistory = [planHistory[0], ...planHistory.slice(-(PLAN_HISTORY_LIMIT - 1))];
}

function recordPlanHistory(inputs) {
  const snapshot = JSON.parse(JSON.stringify(inputs));
  const entry = { key: planHistoryKey(snapshot), inputs: snapshot };
  if (!planHistory.length || typeof setTimeout !== "function") { commitPlanHistory(entry); return; }
  planHistoryPending = entry;
  if (typeof clearTimeout === "function") clearTimeout(planHistoryTimer);
  planHistoryTimer = setTimeout(() => { commitPlanHistory(planHistoryPending); planHistoryPending = null; }, PLAN_HISTORY_SETTLE_MS);
}

function planHistoryForChat() {
  const key = planHistoryKey(JSON.parse(JSON.stringify(state)));
  const earlier = planHistory.filter((entry) => entry.key !== key);
  return { previous: earlier.at(-1)?.inputs || null, first: planHistory[0] && planHistory[0].key !== key ? planHistory[0].inputs : null, count: planHistory.length + (planHistory.at(-1)?.key === key ? 0 : 1) };
}

// What the assistant needs about the plan, the page and the follow-ups.
function helpChatExtras() {
  const summary = proposalWorkspace?.contextSummary?.() || null;
  const next = currentProposalContext && $("#inputError").hidden ? buildNextSteps() : null;
  return {
    nextSteps: next ? { readiness: next.plan.readiness, steps: next.steps } : null,
    missing: summary && next ? { checks: summary.checks || [], decisionLogged: (summary.decisions || []).length > 0, total: next.plan.readiness.total } : null,
    where: { view: $(".nav-tab.active")?.dataset.view || "scenarioView", mode: $(".view-mode.active")?.dataset.mode || "focus" },
    history: planHistoryForChat(),
  };
}

function decisionNoteText() {
  const note = decisionNote(data,state,decisionOptions(),latestNextSteps?.plan || null);
  const peerText=state.peerProfile ? "\n\nComparison-country starting weights\n"+state.peerProfile.peers.map((peer)=>peer.origin+": "+formatPercent(peer.weight,1)).join("\n")+"\nGeographic assumptions only; not measured route demand." : "";
  const targetText = targetSolution ? "\n\nCapacity target check\n" + englishUiText($("#targetResult")) : "";
  return note.text + peerText + targetText;
}

function printDecisionNote() {
  if (!$("#inputError").hidden) return;
  const sheet = document.createElement("section");
  sheet.id = "decisionPrintSheet";
  sheet.setAttribute("data-i18n-ignore", "");
  sheet.lang = exportLanguage;
  sheet.dir = exportLanguage === "ar" ? "rtl" : "ltr";
  const body = document.createElement("pre");
  body.textContent = translateExportText(decisionNoteText(), exportLanguage);
  sheet.append(body);
  document.body.append(sheet);
  document.body.classList.add("printing-decision-note");
  const finish = () => {
    sheet.remove();
    document.body.classList.remove("printing-decision-note");
  };
  window.addEventListener("afterprint", finish, { once: true });
  try { window.print(); }
  catch (error) {
    window.removeEventListener("afterprint", finish);
    finish();
    throw error;
  }
}

function setupDecisionTools() {
  $("#printDecisionNote").addEventListener("click", printDecisionNote);
  ["alternativeOrigin","sameComparisonAssumptions","refreshMonthAssumptions"].forEach((id)=>$("#"+id).addEventListener("input",()=>{if(id==="alternativeOrigin") $("#alternativeOrigin").dataset.userSelected="true";renderDecisionWorkspace();}));
  $("#applyPurpose").addEventListener("click",()=>{
    if (!$("#inputError").hidden) { $("#purposeStatus").textContent="Correct the highlighted plan input before applying visitor assumptions."; return; }
    const shareField=$("#purposeHotelShare"), stayField=$("#purposeStay");
    const share=Number(shareField.value===shareField.dataset.displayed ? shareField.dataset.exact : shareField.value), stay=Number(stayField.value===stayField.dataset.displayed ? stayField.dataset.exact : stayField.value);
    if (!$("#purposeHotelShare").value.trim() || !$("#purposeStay").value.trim() || !Number.isFinite(share) || share<5 || share>90 || !Number.isFinite(stay) || stay<1 || stay>10) { $("#purposeStatus").textContent="Use a hotel share from 5% to 90% and a stay from 1 to 10 nights."; return; }
    state=applyRoutePurpose(state,$("#routePurpose").value,{conversionRate:share/100,averageStay:stay});
    state.purposeAssumptionsApplied=true; state.seasonalConversion=false;
    setFormFromState(); renderAll(); $("#purposeStatus").textContent="Your visitor assumptions are applied. The historical baseline is unchanged.";
  });
  $("#calculateTarget").addEventListener("click",()=>{if($("#inputError").hidden) updateTargetResult();});
  $("#targetGuestNights").addEventListener("input",()=>{targetSolution=null;$("#applyTarget").hidden=true;$("#targetResult").textContent="Choose Calculate capacity to update the result.";});
  $("#applyTarget").addEventListener("click",()=>{if(!targetSolution?.met)return;state.extraFlights=targetSolution.requiredWeeklyFlights;setFormFromState();renderAll();});
  $("#applySeasonalConversion").addEventListener("click",()=>{state.conversionRate=CONVERSION_EVIDENCE.monthlyRates[state.month];state.seasonalConversion=true;setFormFromState();renderAll();$("#conversionStatus").textContent="Optional training-season assumption applied to your plan. The baseline is unchanged; the test did not show an accuracy improvement.";});
  $("#exportDecisionNote").addEventListener("click",()=>{
    if(!$("#inputError").hidden)return;
    downloadPlan(new Blob([translateExportText(decisionNoteText(), exportLanguage)],{type:"text/plain;charset=utf-8"}),exportFileName("Air2Stay-decision-note.txt", exportLanguage));
    guidedHelp?.track("export_decision");
    $("#planActionStatus").textContent="Decision note exported with assumptions, stress trials and next checks.";
  });
}

 function renderAll() {
   $("#exportReady").hidden = true;
   const pendingCountry = $("#origin").value === "__NEW_ROUTE__" && !confirmedNewMarketKey;
   const invalid = pendingCountry || $$("#scenarioForm input[type=number], #scenarioForm input[type=range]").filter((field) => !field.closest("#purposeAssumptions")).find((field) => !field.value.trim() || !Number.isFinite(Number(field.value)) || Number(field.value) < Number(field.min) || Number(field.value) > Number(field.max));
   $("#inputError").hidden = !invalid;
   $("#scenarioResults").hidden = Boolean(invalid);
   $("#chatResults").hidden = Boolean(invalid);
   $("#decisionWorkspace").classList.toggle("invalid-plan", Boolean(invalid));
   $("#targetWorkspace").classList.toggle("invalid-plan", Boolean(invalid));
   if (invalid) {
     currentProposalContext = null;
     refreshPackStatistics(null);
     proposalWorkspace?.update(null);
     renderNextSteps();
     $("#inputError").textContent = pendingCountry ? "Choose and confirm a departure country to calculate a new route." : `Please enter ${invalid.id === "averageStay" ? "average nights per stay" : invalid.id === "seatsPerFlight" ? "seats per flight" : "a value"} between ${invalid.min} and ${invalid.max} to see the results.`;
     return;
   }
   readForm();
   const result = runScenario(data, state);
   renderKpis(result);
   renderCalculationExplanation(result);
   renderSideBySideComparison(result, currentProposalContext?.result);
   renderRouteMap(result);
   renderSeasonProfile(result);
   renderRouteAudit(result);
   renderContributions(result);
   renderSensitivity();
   renderBridge(result);
   renderDecisionWorkspace();
   renderTargetWorkspace();
   updateHelpChatContext();
   renderPlanningEvidence(result);
   $("#scenarioName").textContent = `${result.route.origin}, ${data.months[state.month - 1]}`;
   $("#headerScenario").textContent = `${result.route.origin} · ${data.months[state.month - 1]}`;
   updateStartingMarkers();
   $("#dataNote").textContent = result.route.knownMarket
     ? `Baseline: an estimate based on past flight records (${result.route.yearsObserved} matching records), with assumed hotel use and length of stay. Hotel totals for this route were not directly observed.`
     : `No past flight records for this route. ${state.peerProfile ? "A weighted blend of comparison countries supplies starting assumptions" : (result.route.proxyOriginKey || "The comparison country") + " is only a starting point"}, not evidence of demand. The proposed route starts from zero.`;
   if (result.eventUplift) {
     $("#dataNote").textContent += ` Includes your chosen +${Math.round(result.eventUplift * 100)}% increase for an event or season; this is not based on measured event results.`;
   }
   const contextInputs = JSON.parse(JSON.stringify({...state,bridgeOverride}));
   recordPlanHistory(state);
   const starting = nextStepStarting(state, result.route);
   const orderPlan = nextStepPlan(data, contextInputs, result, { starting });
   const nextStepReasons = Object.fromEntries(orderPlan.order.map((id) => { const lines = nextStepLines(orderPlan.checks[id], result); return [id, [lines.why, lines.impact].filter(Boolean).join(" ")]; }));
   const nextContext = {inputs:contextInputs,result,decision:decisionNote(data,state),starting,nextStepOrder:orderPlan.order,nextStepReasons};
   const changed = currentProposalContext && JSON.stringify(currentProposalContext.inputs) !== JSON.stringify(nextContext.inputs);
   currentProposalContext = nextContext;
   refreshPackStatistics(nextContext);
   proposalWorkspace?.update(nextContext);
   renderNextSteps();
   guidedHelp?.update(nextContext);
   if (changed) guidedHelp?.track("scenario_change");
   if (chatEnabled) syncProposalChat();
 }

function syncProposalChat() {
  if (!proposalWorkspace || !currentProposalContext) return;
  const key = `${state.originKey}|${state.month}`;
  const history = proposalWorkspace.discussion();
  if (key === assistantProposalKey) {
    let changed=false;
    for (const message of assistantMessages) {
      const saved=history.find(item=>item.id===message.id);
      if (saved && saved.matchesCurrentPlan !== message.matchesCurrentPlan) {message.matchesCurrentPlan=saved.matchesCurrentPlan;changed=true;}
    }
    if (changed) renderAssistantChat();
    return;
  }
  assistantProposalKey = key;
  assistantGeneration++;
  assistantMessages = history.length ? history : [{role:"bot",text:`Let’s explore ${currentProposalContext.result.route.origin} in ${data.months[state.month-1]}. Ask about the result, what to check next, or change an assumption.`}];
  renderAssistantChat();
}

function addAssistantMessage(message) {
  assistantMessages.push(message);
  if (assistantMessages.length > 40) assistantMessages = assistantMessages.slice(-40);
  proposalWorkspace?.recordDiscussion(message);
}

function setupProposalTools() {
  guidedHelp = createGuidedHelp({mount:$("#guidedHelp"),chatEnabled,getContext:()=>currentProposalContext,navigate:({view="scenarioView",mode,controls=false})=>{
    $(`.nav-tab[data-view="${view}"]`)?.click();
    if (mode) $(`.view-mode[data-mode="${mode}"]`)?.click();
    if (controls && !document.body.classList.contains("controls-open") && getComputedStyle($("#adjustControls")).display !== "none") $("#adjustControls").click();
  }});
  proposalWorkspace = createProposalWorkspace({mount:$("#proposalWorkspace"),chatEnabled,rail:$("#proposalRail"),launcher:$("#toggleProposalPanel"),onOpenWorkspace:()=>{ if ($("#proposalWorkspace").hidden) $(".view-mode[data-mode='proposal']").click(); },getContext:()=>currentProposalContext,track:name=>{guidedHelp.track(name);if(String(name).startsWith("proposal_"))renderNextSteps();},onRecommendation:(element,{context,recommended,fingerprint})=>{
    const identity = `${fingerprint}|${recommended?.id}|${recommended?.status}`;
    const feedbackKey = [...identity].reduce((hash,letter)=>Math.imul(hash ^ letter.charCodeAt(0),16777619)>>>0,2166136261).toString(36);
    if (recommended) guidedHelp.addFeedback({element,id:`recommendation-${feedbackKey}`,label:`Next action · ${context.result.route.origin} · ${data.months[context.inputs.month-1]}`});
  },onRestore:inputs=>{
    restorePlan({version:1,inputs});
    $("#planActionStatus").textContent="Saved assumptions restored. Checks must match these exact values.";
  }});
  $("#openGuide").addEventListener("click",()=>guidedHelp.open());
  if (!chatEnabled) return;
  $("#chatGuidance").addEventListener("click",()=>guidedHelp.open());
  const configured=Boolean(window.__AIR2STAY_ASSISTANT_TOKEN__);
  $("#allowAi").disabled=!configured;
  $("#assistantSource").textContent=configured ? "Plan explanations and clear change commands work locally. Optional Gemini answers can help with other questions when you enable them below." : "Local planning assistant · explanations and clear change commands work without internet. Gemini is not configured in this copy.";
}
  
function resolveChatPlan(parsed, current) {
  const changedRoute = parsed.inputs.originKey !== current.originKey || parsed.inputs.month !== current.month;
  if (changedRoute) {
    const known = knownOrigins().some((item)=>item.key===parsed.inputs.originKey);
    const refreshed = defaultState(parsed.inputs.originKey,parsed.inputs.month,known ? "" : current.referenceMode === "peers" ? "__PEERS__" : current.proxyOriginKey);
    return {...refreshed,...parsed.changes,bridgeOverride:null};
  }
  return {...parsed.inputs,seasonalConversion:parsed.changes.conversionRate === undefined ? current.seasonalConversion : false};
}

function applyAssistantPlan(parsed) {
  const candidate = resolveChatPlan(parsed, state);
  const error = validateScenarioInputs(candidate);
  if (error) throw new RangeError(error);
  for (const key of ["extraFlights", "seatsPerFlight"]) {
    if (parsed.changes[key] !== undefined && !Number.isInteger(candidate[key])) throw new RangeError("Use a whole number for flights each week and seats per flight.");
  }
  const changedRoute = candidate.originKey !== state.originKey || candidate.month !== state.month;
  state = candidate;
  if (changedRoute) bridgeOverride = null;
  confirmedNewMarketKey = knownOrigins().some((item)=>item.key===state.originKey) ? "" : state.originKey;
  setFormFromState();
  readForm();
  return appliedPlanConfirmation(data, state, parsed.changes);
}

function friendlyPlanError(error) {
  const labels = {
    loadFactor:"Flight occupancy must be between 30% and 100%.",
    p2pShare:"Passengers ending their trip in Abu Dhabi must be between 5% and 100%.",
    conversionRate:"Hotel use must be between 5% and 90%.",
    averageStay:"Average stay must be between 1 and 10 nights.",
    eventUplift:"Extra event demand must be between 0% and 50%.",
    extraFlights:"Use between 20 fewer and 20 extra flights each week.",
    seatsPerFlight:"Use between 30 and 600 seats per flight.",
  };
  return labels[String(error.message).split(" ")[0]] || error.message;
}

function openPlanControl(groupId, field) {
  const group = document.getElementById(groupId);
  if (!group) return;
  setControlsOpen(true);
  group.open = true;
  const target = field || group.querySelector("summary");
  target?.focus({preventScroll:true});
  target?.scrollIntoView({block:"nearest"});
}

 function setupControls() {
   const originOptions = knownOrigins().map((origin) => `<option value="${origin.key}">${origin.name}</option>`).join("");
   $("#origin").innerHTML = `${originOptions}<option value="__NEW_ROUTE__">＋ New route</option>`;
   $("#proxyMarket").innerHTML = '<option value="__PEERS__">Blend three comparison countries</option>' + originOptions;
   $("#alternativeOrigin").innerHTML = originOptions;
   $("#alternativeOrigin").value = "FRANCE";
   const existingMarkets = new Set();
   for (const origin of knownOrigins()) {
     existingMarkets.add(normalizeCountryName(origin.name));
     const record = countryLocationLookup[normalizeCountryName(origin.name)] || countryLocationLookup[normalizeCountryName(origin.key)];
     if (record) existingMarkets.add(normalizeCountryName(record.name));
   }
   const newMarketOptions = [...new Map(Object.values(countryLocationLookup).map((country) => [country.name, country])).values()]
     .filter((country) => !existingMarkets.has(normalizeCountryName(country.name)))
     .sort((first, second) => first.name.localeCompare(second.name))
     .map((country) => `<option value="${planningEscape(country.name)}" data-country-name="${planningEscape(country.name)}">${planningEscape(country.name)}</option>`)
     .join("");
   $("#newMarketCountryList").innerHTML = newMarketOptions;
   $("#month").innerHTML = data.months.map((month, index) => `<option value="${index + 1}">${month}</option>`).join("");
   setFormFromState();
  
   $$("#scenarioForm input, #scenarioForm select").forEach((input) => input.addEventListener("input", () => {
     // An explicit edit owns this value, even if it equals the rounded display.
     // Untouched controls continue to retain their full-precision source value.
     if (input.dataset.exact !== undefined) input.dataset.exact = input.value;
     if (input.id === "origin" && input.value === "__NEW_ROUTE__") {
       bridgeOverride = null;
       confirmedNewMarketKey = "";
       $("#newMarketField").hidden = false;
       state = defaultState("NEW MARKET", state.month, "__PEERS__");
       setFormFromState();
       $("#newMarketCountry").value = "";
       $("#confirmNewMarket").disabled = true;
       $("#newMarketCountry").focus();
       renderAll();
       return;
     }
     if (input.id === "proxyMarket") {
       bridgeOverride = null;
       const market = countryFromInput($("#newMarketCountry").value)?.name || $("#newMarketCountry").value.trim() || "NEW MARKET";
       state = defaultState(market.toUpperCase(), state.month, input.value);
       setFormFromState();
       renderAll();
       return;
     }
     if (input.id === "origin" || input.id === "month") {
       if (input.id === "origin") confirmedNewMarketKey = "";
       readForm();
       const refreshed = defaultState(state.originKey, state.month, state.referenceMode === "peers" ? "__PEERS__" : state.proxyOriginKey);
       state = refreshed;
       bridgeOverride = null;
       setFormFromState();
       // Keep the assistant input ready for a new user-written request.
       clearAssistantPrompt();
       renderAll();
       return;
     }
    if (input.id === "newMarketCountry") {
      confirmedNewMarketKey = "";
      $("#proxyMarketField").hidden = true;
      $("#newMarketStatus").hidden = false;
      $("#confirmNewMarket").disabled = !input.value.trim();
      renderAll();
      return;
    }
    if (["purposeHotelShare", "purposeStay"].includes(input.id)) return;
    if (input.id === "routePurpose") {
      state.routePurpose = input.value;
      state.purposeAssumptionsApplied = false;
      $("#purposeAssumptions").hidden = input.value === "mixed";
      populatePurposeInputs();
      $("#purposeStatus").textContent = "Label selected. Numbers change only when you apply your assumptions.";
    }
    if (input.id === "conversionRate") state.seasonalConversion = false;
     // Range sliders fire "input" on every tiny tick while dragging. Update
     // the on-screen number immediately so it never feels laggy, but
     // coalesce the full, more expensive re-render to once per animation
     // frame so a fast drag doesn't queue up dozens of renders.
     updateRangeLabels();
     scheduleRender();
   }));

  $("#confirmNewMarket").addEventListener("click", () => {
    const selectedCountry = countryFromInput($("#newMarketCountry").value);
    if (!selectedCountry) {
      $("#newMarketStatus").textContent = "Choose a country from the suggestions so the map can find its location.";
      $("#newMarketStatus").hidden = false;
      $("#proxyMarketField").hidden = true;
      return;
    }
    const market = selectedCountry.name;
    bridgeOverride = null;
    const recommendation = recommendProxy(market, state.month);
    confirmedNewMarketKey = market.toUpperCase();
    state = defaultState(confirmedNewMarketKey, state.month, "__PEERS__");
    setFormFromState();
    renderAll();
  });
  
   $("#resetScenario").addEventListener("click", () => {
     state = defaultState("INDIA", 12);
     bridgeOverride = null;
     setFormFromState();
     renderAll();
   });


$("#smartPrompt").addEventListener("input", () => {
  assistantPromptDirty = true;
});

$("#assistantChat").addEventListener("click", () => {
  setAssistantExpanded(true);
});

$("#clearChat").addEventListener("click", clearAssistantChat);

$("#smartPrompt").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#applyPrompt").click();
  }
});

async function askGemini(question, result) {
  if (!chatEnabled || !window.__AIR2STAY_ASSISTANT_TOKEN__) throw new Error("AI chat is not configured in this copy. Add your Gemini key to .env and restart to enable open-ended questions.");
  const recorded = proposalWorkspace?.contextSummary();
  const context = {
    route: result.route.origin,
    month: data.months[result.route.month - 1],
    newRoute: !result.route.knownMarket,
    comparisonMarket: state.proxyOriginKey || null,
    comparisonCountries: state.peerProfile?.peers.map((peer)=>({country:peer.origin,weight:peer.weight})) || null,
    routePurpose: state.routePurpose || "mixed",
    purposeIsUserAssumption: true,
    interpretationNotes: [
      "A comparison country is only a starting point for a new route; an existing route does not need one.",
      "The event uplift is an extra user assumption. Zero means no added event effect, not an absence of historical seasonality.",
      "Clear supported commands are handled locally. This AI response is explanation only: never claim to have applied a change, assigned a task or sent a message.",
    ],
    baselineEstimate: "Estimate based on past flight records; route-level hotel totals are not directly observed.",
    estimatedHotelArrivals: Math.round(result.scenario.hotelCheckins),
    estimatedGuestNights: Math.round(result.scenario.guestNights),
    changeInHotelArrivals: Math.round(result.delta.hotelCheckins),
    changeInGuestNights: Math.round(result.delta.guestNights),
    assumptions: {
      addedFlightsPerWeek: state.extraFlights,
      seatsPerFlight: state.seatsPerFlight,
      loadFactorPercent: Number((state.loadFactor * 100).toFixed(1)),
      passengersEndingTripInAbuDhabiPercent: Number((state.p2pShare * 100).toFixed(1)),
      hotelCheckInPercent: Number((state.conversionRate * 100).toFixed(1)),
      averageStayNights: state.averageStay,
      seasonalUpliftPercent: Number((state.eventUplift * 100).toFixed(1)),
    },
    nextAction: ["demand","hotels","visitors","event"].includes(recorded?.recommended?.id) ? {title:recorded.recommended.title,why:recorded.recommended.why,owner:recorded.recommended.owner} : null,
    checks: recorded?.checks?.filter(check=>["demand","hotels","visitors","event"].includes(check.id)).map(check=>({title:check.title,status:check.status})),
    decision: currentProposalContext?.decision.workplaceDecision,
    recentConversation: assistantMessages.filter(message=>message.text!=="Thinking…").slice(-6).map(message=>({role:message.role,text:message.text.slice(0,1000),earlierAssumptions:message.matchesCurrentPlan===false})),
  };
  const response = await fetch("http://127.0.0.1:8767/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Air2Stay-Token": window.__AIR2STAY_ASSISTANT_TOKEN__ || "" },
    body: JSON.stringify({ question, context }),
    signal: AbortSignal.timeout(45000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Gemini is not available right now.");
  return payload.answer;
}

$("#applyPrompt").addEventListener("click", async () => {
  if (!chatEnabled || assistantBusy) return;
  const prompt = $("#smartPrompt").value.trim();
  if (!prompt) return;
  if (!$("#inputError").hidden) {
    assistantMessages.push({role:"bot",text:"Please correct the highlighted input before asking about or changing this plan."});
    renderAssistantChat();
    return;
  }
  readForm();
  const currentResult = runScenario(data, state);
  const reply = planningChatReply(data, prompt, state, currentResult, proposalWorkspace?.contextSummary());
  const originalKey=assistantProposalKey;
  addAssistantMessage({role:"user",text:prompt});
  guidedHelp?.track("assistant_question");
  clearAssistantPrompt();
  if (reply.type === "reset") {
    state = defaultState("INDIA", 12);
    bridgeOverride = null;
    setFormFromState();
    clearAssistantPrompt();
  } else if (reply.type === "apply" && reply.parsed.understood) {
    try {
      reply.text = applyAssistantPlan(reply.parsed);
    } catch (error) {
      addAssistantMessage({role: "bot", source:"local", text: `The plan was not changed. ${friendlyPlanError(error)}`});
      renderAssistantChat();
      return;
    }
    clearAssistantPrompt();
  }
  renderAll();
  if (assistantProposalKey !== originalKey) addAssistantMessage({role:"user",text:prompt});
  if (reply.type === "apply" && !reply.parsed.understood) {
    if (!$("#allowAi").checked) {
      addAssistantMessage({role:"bot",source:"local",text:"I haven’t changed your plan. Try a specific request such as “Set flight occupancy to 80%”, or ask about hotel nights or the next check. You can enable Gemini below for other questions."});
      renderAssistantChat();
      return;
    }
    const pendingMessage = { role: "bot", text: "Thinking…" };
    assistantMessages.push(pendingMessage);
    renderAssistantChat();
    assistantBusy = true;
    $("#applyPrompt").disabled = true;
    $("#clearChat").disabled = true;
    const generation=assistantGeneration;
    const inputsAtRequest=JSON.stringify(currentProposalContext?.inputs);
    try {
      const answer=await askGemini(prompt, currentResult);
      if (generation === assistantGeneration) {
        pendingMessage.source="ai";
        pendingMessage.text = inputsAtRequest===JSON.stringify(currentProposalContext?.inputs) ? answer : "Your assumptions changed while I was answering. Ask again so the explanation matches the current plan.";
      }
    } catch (error) {
      pendingMessage.text = (error.name === "TimeoutError" ? "The AI answer took too long." : error.message) + " You can still ask about calculations or use the plan controls.";
      pendingMessage.source="local";
    } finally {
      if (generation === assistantGeneration && assistantMessages.includes(pendingMessage)) proposalWorkspace?.recordDiscussion(pendingMessage);
      assistantBusy = false;
      $("#applyPrompt").disabled = false;
      $("#clearChat").disabled = false;
    }
  } else {
    addAssistantMessage({role:"bot",source:"local",text:reply.text});
  }
  setAssistantExpanded(true);
  renderAssistantChat();
  renderAll();
  $("#smartPrompt").focus();
});

  
   $("#visitorNationalityCards").addEventListener("input", changeVisitorShare);
   $("#editBridgeMix").addEventListener("click", () => {
     if (!currentProposalContext) return;
     bridgeEditing = !bridgeEditing;
     renderBridge(currentProposalContext.result);
     $("#bridgeStatus").textContent = bridgeEditing
       ? "Set a final share. Other shares adjust automatically. Check-ins, guest nights and the map update when you apply."
       : "Editing cancelled. The applied visitor mix is unchanged.";
     if (bridgeEditing) $("#visitorNationalityCards .bridge-input")?.focus({preventScroll:true});
   });
   $("#resetBridge").addEventListener("click", () => {
     bridgeOverride = null;
     bridgeEditing = false;
     renderAll();
     $("#bridgeStatus").textContent = "Original estimated visitor mix restored. Your flight and hotel assumptions are unchanged.";
   });
   $("#applyBridge").addEventListener("click", () => {
     if (!bridgeEditing || !currentProposalContext) return;
     if ($$(".bridge-input").some(field => !validVisitorShare(field))) {
       $("#bridgeStatus").textContent = "Enter a share from 0% to 100%.";
       return;
     }
     bridgeOverride = bridgeDraft;
     bridgeEditing = false;
     renderAll();
     $("#bridgeStatus").textContent = "Visitor mix updated.";
   });
 }
  
function setControlsOpen(open) {
  const panel = $("#planControls");
  const button = $("#adjustControls");
  const returnFocus = !open && panel.contains(document.activeElement);
  document.body.classList.toggle("controls-open", open);
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  $("#adjustControlsLabel").textContent = open ? "Hide controls" : "Adjust plan";
  button.title = open ? "Hide plan controls" : "Show plan controls";
  if (returnFocus) button.focus({preventScroll:true});
}

 function setupTabs() {
   $$(".nav-tab").forEach((button) => button.addEventListener("click", () => {
     $$(".nav-tab").forEach((item) => item.classList.remove("active"));
     $$(".view").forEach((view) => view.classList.remove("active"));
     button.classList.add("active");
     guidedHelp?.track(`view:${button.dataset.view}`);
     $(`#${button.dataset.view}`).classList.add("active");
     $$(".nav-tab").forEach((item) => item.setAttribute("aria-current", item === button ? "page" : "false"));
     setControlsOpen(false);
     window.scrollTo({top:0,behavior:"instant"});
   }));
  
   const requested = new URLSearchParams(window.location.search).get("view");
   const requestedButton = $(`.nav-tab[data-view="${requested}"]`);
   if (requestedButton) requestedButton.click();
 }

 function setupViewMode() {
   const chatTab = $('.view-mode[data-mode="chat"]');
   chatTab.hidden = !chatEnabled;
   chatTab.disabled = !chatEnabled;
   $("#assistantPanel").inert = !chatEnabled;
   $("#chatPrivacy").hidden = !chatEnabled;
   const setMode = (mode) => {
     if (!chatEnabled && mode === "chat") return;
     const focus = mode === "focus";
     const chat = mode === "chat";
     const decisions = mode === "decisions";
     const target = mode === "target";
     const proposal = mode === "proposal";
     document.body.classList.toggle("focus-mode", focus);
     document.body.classList.toggle("details-mode", mode === "details");
     document.body.classList.toggle("chat-mode", chat);
     document.body.classList.toggle("decisions-mode", decisions);
     document.body.classList.toggle("target-mode", target);
     document.body.classList.toggle("proposal-mode", proposal);
     $("#assistantPanel").hidden = !chat;
     $("#decisionWorkspace").hidden = !decisions;
     $("#targetWorkspace").hidden = !target;
     $("#proposalWorkspace").hidden = !proposal;
     // Keep one set of results synchronized across all three views.
     if (chat) $("#chatResults").append($("#kpis"));
     else $("#scenarioResults").prepend($("#kpis"));
     $$(".view-mode").forEach((item) => {
       const selected = item.dataset.mode === mode;
       item.classList.toggle("active", selected);
       item.setAttribute("aria-pressed", String(selected));
     });
     $("#viewModeDescription").textContent = focus
       ? "The outcome, the main drivers, and what to check next."
       : proposal ? "Review a check, add a task, and log what you find."
       : decisions ? "Compare added capacity, test the assumptions, and prepare a decision note."
       : target ? "Start from the hotel nights you want and work back to the flights needed."
       : chat ? "Describe a change or ask a question. The current result stays beside your conversation."
       : "Trace the assumptions, calculations, flight history, and limits behind this plan.";
     if (decisions && state && $("#inputError").hidden) renderDecisionWorkspace();
     if (target && state && $("#inputError").hidden) renderTargetWorkspace();
     guidedHelp?.track(({focus:"view_focus",details:"view_details",chat:"view_chat",decisions:"view_compare",target:"view_target",proposal:"view_actions"})[mode]);
   };
   setMode("focus");
   setControlsOpen(window.matchMedia("(min-width: 1051px)").matches);
   $("#adjustControls").addEventListener("click", () => {
     const open = !document.body.classList.contains("controls-open");
     setControlsOpen(open);
     if (open) ($("#scenarioForm > details[open] summary") || $("#marketControls summary")).focus({preventScroll:true});
   });
   document.addEventListener("keydown", (event) => {
     if (event.key === "Escape" && !event.defaultPrevented &&
         !document.querySelector("dialog[open]") &&
         event.target.closest("#planControls, #adjustControls")) {
       setControlsOpen(false);
     }
   });
   $$(".view-mode").forEach((button) => button.addEventListener("click", () => {
     setMode(button.dataset.mode);
   }));
   const evidenceTargets = {
     calculation: ["scenarioView", "details", '.detail-tier[data-tier="1"] > summary'],
     sources: ["scenarioView", "details", '.detail-tier[data-tier="3"] > summary'],
     drivers: ["scenarioView", "details", '.detail-tier[data-tier="2"] > summary'],
     routes: ["scenarioView", "decisions", "#alternativeOrigin"],
     stress: ["scenarioView", "decisions", "#stressChart"],
     followups: ["scenarioView", "proposal", "#pwChecksHeading"],
     mix: ["bridgeView", null, "#bridgeTitle"],
     "mix-method": ["bridgeView", null, "#bridgeMethod > summary"],
     validation: ["validationView", null, "#validationSummary"],
     "validation-method": ["validationView", null, "#validationRangeEvidence"],
     records: ["scenarioView", "focus", "#dataNote"],
   };
   document.addEventListener("click", (event) => {
     const link = event.target.closest("[data-evidence]");
     const destination = link && evidenceTargets[link.dataset.evidence];
     if (!destination) return;
     const [view, mode, selector] = destination;
     if (!$(`#${view}`).classList.contains("active")) $(`.nav-tab[data-view="${view}"]`).click();
     if (mode && !$(`.view-mode[data-mode="${mode}"]`)?.classList.contains("active")) setMode(mode);
     const target = $(selector);
     if (!target) return;
     for (let detail = target.closest("details"); detail; detail = detail.parentElement.closest("details")) detail.open = true;
     if (!target.matches("button, summary, input, select, a")) target.tabIndex = -1;
     target.focus({preventScroll:true});
     target.scrollIntoView({block:"start"});
   });
   $("#showDecision").addEventListener("click", () => {
     setMode("decisions");
     $("#planningDecision").scrollIntoView({block:"start"});
     $("#planningDecisionTitle").focus({preventScroll:true});
   });
   $$(".chat-starters button").forEach((button) => button.addEventListener("click", () => {
     $("#smartPrompt").value = button.dataset.prompt;
     $("#applyPrompt").click();
   }));
 }
  
function updateStartingMarkers() {
  const starting = { ...defaultState(state.originKey, state.month, state.referenceMode === "peers" ? "__PEERS__" : state.proxyOriginKey), extraFlights: 0 };
  for (const field of $$('#scenarioForm input[type="range"], #seatsPerFlight, #averageStay')) {
    const label = field.closest("label");
    if (!label) continue;
    const isPercent = ["loadFactor", "p2pShare", "conversionRate", "eventUplift"].includes(field.id);
    const startingValue = starting[field.id] * (isPercent ? 100 : 1);
    const changed = Math.abs(state[field.id] - starting[field.id]) > 1e-7;
    label.classList.toggle("changed", changed);
    let group = label.parentElement;
    if (!group.classList.contains("control-value-group")) {
      group = document.createElement("div");
      group.className = "control-value-group";
      label.before(group);
      group.append(label);
      const undo = document.createElement("button");
      undo.type = "button";
      undo.className = "undo-control-change text-action";
      undo.textContent = "Undo change";
      undo.setAttribute("aria-label", "Undo change to " + (label.querySelector(".control-label")?.textContent || label.firstChild.textContent.trim()));
      undo.addEventListener("click", () => {
        const original = Number(undo.dataset.start);
        field.value = field.type === "range" ? original.toFixed(Number(field.step) < 1 ? 1 : 0) : (field.id === "seatsPerFlight" ? original.toFixed(0) : original.toFixed(2));
        field.dataset.displayed = field.value;
        field.dataset.exact = String(original);
        if (field.id === "conversionRate") state.seasonalConversion = false;
        field.focus({preventScroll:true});
        renderAll();
      });
      group.append(undo);
    }
    const undo = group.querySelector(".undo-control-change");
    undo.dataset.start = String(startingValue);
    undo.hidden = !changed;
  }
}

function planSnapshot() {
  return { version: 1, savedAt: new Date().toISOString(), inputs: JSON.parse(JSON.stringify({ ...state, bridgeOverride })) };
}

function validatedPlan(raw) {
  if (!raw || raw.version !== 1 || !raw.inputs || typeof raw.inputs !== "object") throw new Error("This plan file has an unsupported format.");
  const source = raw.inputs;
  const keys = ["month", "extraFlights", "seatsPerFlight", "loadFactor", "p2pShare", "conversionRate", "averageStay", "eventUplift"];
  const inputs = {};
  for (const key of keys) {
    if (typeof source[key] !== "number" || !Number.isFinite(source[key])) throw new Error("The shared plan contains an invalid number.");
    inputs[key] = source[key];
  }
  if (!Number.isInteger(inputs.month) || inputs.month < 1 || inputs.month > 12) throw new Error("The plan month is invalid.");
  const error = validateScenarioInputs(inputs);
  if (error) throw new Error(error);
  inputs.originKey = String(source.originKey || "").toUpperCase();
  inputs.proxyOriginKey = String(source.proxyOriginKey || "").toUpperCase();
  const known = knownOrigins().some((origin) => origin.key === inputs.originKey);
  if (!known && !countryLocationLookup[normalizeCountryName(inputs.originKey)]) throw new Error("The plan country is not recognised.");
  if (!known && !knownOrigins().some((origin) => origin.key === inputs.proxyOriginKey)) throw new Error("Choose a supported comparison country.");
  if (known) inputs.proxyOriginKey = "";
  inputs.referenceMode = !known && source.referenceMode === "peers" ? "peers" : "single";
  if (inputs.referenceMode === "peers") {
    inputs.peerProfile = buildPeerProfile(data,countryLocationLookup,inputs.originKey,inputs.month);
    if (!inputs.peerProfile.available) throw new Error("Comparison-country assumptions are unavailable.");
    inputs.proxyOriginKey = inputs.peerProfile.primaryPeerOriginKey;
  } else inputs.peerProfile = null;
  inputs.routePurpose = ["mixed","holiday","business","family"].includes(source.routePurpose) ? source.routePurpose : "mixed";
  inputs.purposeAssumptionsApplied = Boolean(source.purposeAssumptionsApplied);
  inputs.seasonalConversion = Boolean(source.seasonalConversion);
  if (source.bridgeOverride) {
    const base = inputs.peerProfile ? inputs.peerProfile.bridge : getBridge(data, known ? inputs.originKey : inputs.proxyOriginKey, inputs.month);
    if (!Array.isArray(source.bridgeOverride) || source.bridgeOverride.length !== base.length) throw new Error("The plan visitor mix is invalid.");
    inputs.bridgeOverride = base.map((row) => {
      const match = source.bridgeOverride.find((item) => item.nationality === row.nationality);
      if (!match || !Number.isFinite(match.weight) || match.weight < 0 || match.weight > 1) throw new Error("The plan visitor mix is invalid.");
      return { ...row, weight: match.weight };
    });
    if (inputs.bridgeOverride.reduce((sum, row) => sum + row.weight, 0) <= 0) throw new Error("The visitor shares must add up to more than zero.");
  }
  return { version: 1, savedAt: String(raw.savedAt || ""), inputs };
}

function restorePlan(plan) {
  const clean = validatedPlan(plan);
  state = clean.inputs;
  bridgeOverride = state.bridgeOverride || null;
  confirmedNewMarketKey = knownOrigins().some((origin) => origin.key === state.originKey) ? "" : state.originKey;
  setFormFromState(); renderAll();
  $("#planActionStatus").textContent = "Saved inputs restored as written. Reset the plan to use the current training-only defaults.";
}

// Keep the selected inputs across months, resolving each month's comparison countries.
function planInputsForMonth(inputs, month) {
  if (month === inputs.month) return inputs;
  const peerProfile = inputs.referenceMode === "peers"
    ? buildPeerProfile(data, countryLocationLookup, inputs.originKey, month)
    : null;
  return { ...inputs, month, peerProfile };
}

function planResultsByMonth(inputs, result) {
  return data.months.map((_, index) => {
    const month = index + 1;
    return month === inputs.month ? result : runScenario(data, planInputsForMonth(inputs, month));
  });
}

function buildPlanReport(inputs, preparedBy, date) {
  const result = runScenario(data, inputs);
  const { route, baseline, scenario, delta } = result;
  const month = data.months[inputs.month - 1];
  const starting = defaultState(route.originKey, route.month, inputs.referenceMode === "peers" ? "__PEERS__" : route.proxyOriginKey);
  const source = route.knownMarket ? "Past flight records and training-based hotel assumptions"
    : inputs.peerProfile ? "Weighted comparison countries: " + inputs.peerProfile.peers.map(peer => peer.origin).join(", ")
    : "Comparison country: " + (data.routes.find(row => row.originKey === route.proxyOriginKey)?.origin || route.proxyOriginKey || "available markets");
  const purpose = ROUTE_PURPOSES.find(item => item.key === inputs.routePurpose)?.label || "Mixed visitors";
  const schedule = inputs.extraFlights ? formatSigned(inputs.extraFlights) + " flights/week vs usual" : "Usual weekly flight schedule";
  const displayedChange = Math.round(Math.abs(delta.guestNights));
  const plain = displayedChange === 0 ? "The plan shows no change in estimated guest nights for " + month + " at the displayed precision."
    : "The plan estimates " + formatNumber(Math.abs(delta.guestNights)) + (delta.guestNights > 0 ? " more" : " fewer") + " guest nights than usual in " + month + ".";
  const steps = [
    ["seats", "Flight seats"], ["passengers", "Passengers"], ["p2p", "Passengers ending their trip in Abu Dhabi"],
    ["hotelCheckins", "Hotel check-ins"], ["guestNights", "Guest nights"],
  ].map(([key, label]) => ({ label, usual: baseline[key], plan: scenario[key], change: delta[key] }));
  const assumptions = [
    ["extraFlights", "Extra flights per week", "integer", "Relative to the usual schedule."],
    ["seatsPerFlight", "Seats per flight", "integer", "Aircraft capacity used for added or removed flights."],
    ["loadFactor", "Flight fullness", "percent", "Share of aircraft seats occupied."],
    ["p2pShare", "Passengers ending their trip here", "percent", "Share of passengers who finish their flight journey here."],
    ["conversionRate", "Share checking into a hotel", "percent", inputs.seasonalConversion ? "Optional training-season aggregate rate." : "Hotel-use assumption."],
    ["averageStay", "Average hotel stay", "stay", "Nights per hotel guest."],
    ["eventUplift", "Event impact", "percent", "User estimate of the effect on hotel demand."],
  ].map(([key, label, format, note]) => {
    const usual = key === "extraFlights" ? 0 : starting[key];
    const plan = key === "eventUplift" ? result.eventUplift : inputs[key];
    return { label, format, note, usual, plan, changed: Math.abs(plan - usual) > 1e-9 };
  });
  const annual = planResultsByMonth(inputs, result).map((row, index) => ({
    label: data.months[index], selected: index + 1 === inputs.month, usual: row.baseline.guestNights,
    plan: row.scenario.guestNights, change: row.delta.guestNights, checkins: row.delta.hotelCheckins,
  }));
  const visitors = [...result.contributions].sort((a, b) => b.scenarioGuestNights - a.scenarioGuestNights)
    .map(row => ({ label: row.nationality, share: row.weight, usual: row.baselineGuestNights, plan: row.scenarioGuestNights, change: row.deltaGuestNights }));
  const stress = stressTest(data, inputs);
  const trials = [{ label: "Your plan", nights: stress.base.incremental.guestNights, difference: 0 },
    ...stress.trials.map(row => ({ label: row.label, nights: row.incremental.guestNights, difference: row.differenceFromPlan }))];
  const comparedMonths = compareMonths(data, inputs, data.months.map((_, index) => index + 1), resolvedMonthInputs);
  const notes = [
    route.knownMarket ? "Usual values estimate the baseline from past flights and hotel assumptions. Route-level hotel totals were not observed."
      : "The proposed route starts from zero. Comparison countries supply starting assumptions only, with no direct evidence of demand.",
    "Guest nights count people staying overnight. Use guests per room and occupancy to translate guest nights into room needs.",
    "Visitor nationality shares are estimated allocations. Departure country and guest nationality describe different things.",
    "The possible range is a history-based planning guide. It carries no guaranteed probability or route-level coverage.",
    "Travel purpose changes the model only when its assumptions are applied. The scenario does not predict bookings.",
    "Launch and lower-assumption trials illustrate what could happen under chosen inputs. Check demand and capacity before committing.",
  ];
  return {
    title: "Air2Stay plan: " + route.origin + " → Abu Dhabi, " + month,
    filename: "Air2Stay-" + (route.origin + "-" + month).replace(/[^\p{L}\p{N}-]+/gu, "-") + "-report",
    subtitle: [schedule, preparedBy && "Prepared by " + preparedBy, date].filter(Boolean).join(" · "),
    country: route.origin, month, schedule, source, purpose, preparedBy, date, plain, result, steps, assumptions, annual, visitors,
    launch: launchOptions(data, inputs), trials, comparedMonths, notes,
    monthMode: $("#refreshMonthAssumptions").checked ? "Monthly starting assumptions refreshed as in Compare." : "Selected assumptions held fixed as in Compare.",
  };
}



// Store the small Open XML package without compression so no library or network is needed.
function reportZip(entries) {
  const encoder = new TextEncoder();
  const files = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [path, xml] of entries) {
    const name = encoder.encode(path);
    const bytes = encoder.encode(xml);
    let checksum = 0xffffffff;
    for (const byte of bytes) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit++) checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(12, 33, true); // January 1, 1980 in DOS date format.
    local.setUint32(14, checksum, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(14, 33, true);
    central.setUint32(16, checksum, true);
    central.setUint32(20, bytes.length, true);
    central.setUint32(24, bytes.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    files.push(local.buffer, name, bytes);
    directory.push(central.buffer, name);
    offset += local.byteLength + name.length + bytes.length;
    directorySize += central.byteLength + name.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  return new Blob([...files, ...directory, end.buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const reportSpreadsheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const reportRelationshipsNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const reportXmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const reportXml = value => planningEscape(String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ""));
const reportFormats = {
  text: "",
  integer: '#,##0;-#,##0;"–"',
  percent: '0.0%;-0.0%;"–"',
  stay: '0.0" nights"',
  change: '[Color10][>=0.5]"▲ +"#,##0;[Color9][<=-0.5]"▼ −"#,##0;"–"',
  changePercent: '[Color10][>=0.0005]"▲ +"0.0%;[Color9][<=-0.0005]"▼ −"0.0%;"–"',
  low: '#,##0" low"',
  high: '#,##0" high"',
};
// Arabic units inside Excel number formats; same keys and order as reportFormats.
const reportFormatsAr = { ...reportFormats, stay: '0.0" ليلة"', low: '#,##0" (أدنى)"', high: '#,##0" (أعلى)"' };
const reportStyles = {
  plain: [0, 0], header: [1, 2], title: [2, 0], accent: [1, 3], card: [3, 3],
};

function reportCellStyles(lang = "en") {
  const formats = Object.values(lang === "ar" ? reportFormatsAr : reportFormats);
  const font = (size, color, bold = false) =>
    '<font>' + (bold ? '<b/>' : '') + '<sz val="' + size + '"/><color rgb="FF' + color + '"/><name val="Calibri"/></font>';
  const fill = color => '<fill><patternFill patternType="solid"><fgColor rgb="FF' + color + '"/><bgColor indexed="64"/></patternFill></fill>';
  const numberFormats = formats.slice(1).map((code, i) => '<numFmt numFmtId="' + (165 + i) + '" formatCode="' + reportXml(code) + '"/>');
  const cells = Object.values(reportStyles).flatMap(([fontId, fillId]) => formats.map((_, i) =>
    '<xf xfId="0" numFmtId="' + (i ? 164 + i : 0) + '" fontId="' + fontId + '" fillId="' + fillId + '" borderId="0" applyFont="1" applyFill="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>'));
  return reportXmlHeader + '<styleSheet xmlns="' + reportSpreadsheetNs + '"><numFmts count="' + numberFormats.length + '">' + numberFormats.join("") + '</numFmts>' +
    '<fonts count="4">' + font(11, "172238") + font(11, "172238", true) + font(21, "172238", true) + font(16, "172238", true) + '</fonts>' +
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' + fill("E8BF64") + fill("FFF1CB") + '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + cells.length + '">' + cells.join("") + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
}

function reportWorksheet({ rows, widths, freeze = 3, merges = [], bars = [], scales = [], filter = "", rtl = false }) {
  const cellRef = (index, row) => String.fromCharCode(65 + index) + row;
  const formatNames = Object.keys(reportFormats);
  const styleNames = Object.keys(reportStyles);
  const cols = widths.map((width, index) => '<col min="' + (index + 1) + '" max="' + (index + 1) + '" width="' + width + '" customWidth="1"/>').join("");
  const sheetData = rows.map(({ values, style, height }, index) => {
    const row = index + 1;
    const cells = values.map((value, col) => {
      const [content, format = "text"] = Array.isArray(value) ? value : [value];
      const cell = '<c r="' + cellRef(col, row) + '" s="' + (styleNames.indexOf(style) * formatNames.length + formatNames.indexOf(format)) + '"';
      return Number.isFinite(content) ? cell + '><v>' + content + '</v></c>'
        : cell + ' t="inlineStr"><is><t xml:space="preserve">' + reportXml(content ?? "") + '</t></is></c>';
    }).join("");
    return '<row r="' + row + '" ht="' + height + '" customHeight="1">' + cells + '</row>';
  }).join("");
  const dataBars = bars.map(({ range, signed }, i) => '<conditionalFormatting sqref="' + range + '"><cfRule type="dataBar" priority="' + (i + 1) + '">' +
    '<dataBar showValue="0">' + (signed ? '<cfvo type="min"/>' : '<cfvo type="num" val="0"/>') +
    '<cfvo type="max"/><color rgb="FF5088A9"/></dataBar></cfRule></conditionalFormatting>');
  const colorScales = scales.map((range, i) => '<conditionalFormatting sqref="' + range + '"><cfRule type="colorScale" priority="' + (bars.length + i + 1) + '">' +
    '<colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFAEB"/><color rgb="FFDDB151"/></colorScale></cfRule></conditionalFormatting>');
  return reportXmlHeader + '<worksheet xmlns="' + reportSpreadsheetNs + '">' +
    '<sheetViews><sheetView showGridLines="0"' + (rtl ? ' rightToLeft="1"' : '') + ' workbookViewId="0"><pane ySplit="' + freeze + '" topLeftCell="A' + (freeze + 1) +
    '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A' + (freeze + 1) + '" sqref="A' + (freeze + 1) + '"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="20"/><cols>' + cols + '</cols><sheetData>' + sheetData + '</sheetData>' +
    (filter ? '<autoFilter ref="' + filter + '"/>' : '') +
    (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map(ref => '<mergeCell ref="' + ref + '"/>').join("") + '</mergeCells>' : '') +
    dataBars.join("") + colorScales.join("") + '</worksheet>';
}

function buildPlanWorkbook(report, lang = exportLanguage) {
  return withLanguage(lang, () => buildPlanWorkbookContent(report, lang));
}

function buildPlanWorkbookContent(report, lang) {
  const { title, subtitle, result, steps, assumptions, annual, visitors, launch, trials, comparedMonths, notes } = report;
  const number = value => [value, "integer"];
  const change = value => [value, "change"];
  const row = (values, style = "plain", height = 22) => ({ values: values.map(value => typeof value === "string" ? translateUiString(value) : value), style, height });
  const header = (...labels) => row(labels, "header", 28);
  const section = label => row([label], "accent", 24);
  const blank = () => row([], "plain", 10);
  const start = (name, subtitleText) => [row([name], "title", 34), row([subtitleText], "plain", 28)];
  const visitorRows = (rows, dashboard = false) => rows.map(item => row(dashboard
    ? [item.label, [item.share, "percent"], number(item.plan), change(item.change), number(item.plan)]
    : [item.label, [item.share, "percent"], number(item.usual), number(item.plan), change(item.change), [item.share, "percent"]]));
  const dashboard = {
    name: "Dashboard", widths: [43, 20, 20, 19, 19, 20], freeze: 5,
    merges: ["A1:F1", "A2:F2", "D4:E4", "A7:F7", "A15:F15", "A30:F30"],
    bars: [{range:"E9:E13"}, {range:"E17:E28"}, {range:"E32:E39"}], scales: ["C17:C28"],
    rows: [...start(title, subtitle), blank(), header("Extra hotel check-ins", "Extra guest nights", "Total guest nights", "Possible range", ""),
      row([change(result.delta.hotelCheckins), change(result.delta.guestNights), number(result.scenario.guestNights), [result.p10, "low"], [result.p90, "high"]], "card", 36),
      blank(), section("From seats to guest nights"), header("Step", "Usual", "Your plan", "Change", "Plan scale"),
      ...steps.map((item, i) => row([item.label, number(item.usual), number(item.plan), change(item.change), number(item.plan)], i === 4 ? "accent" : "plain", 30)),
      blank(), section("Guest nights through the year"), header("Month", "Usual", "Your plan", "Change", "Plan scale", "Selected month"),
      ...annual.map(item => row([item.label, number(item.usual), number(item.plan), change(item.change), number(item.plan), item.selected ? "◀ your month" : ""], item.selected ? "accent" : "plain")),
      blank(), section("Largest visitor groups"), header("Nationality", "Share of check-ins", "Plan guest nights", "Change", "Plan scale"),
      ...visitorRows(visitors.slice(0, 8), true)],
  };
  const summary = {
    name: "Summary", widths: [43, 24, 22, 20, 19],
    merges: ["A1:E1", "A2:E2", ...[4,5,6,7,8,9].map(n => "B" + n + ":E" + n), "A20:E20", "A21:E21"],
    rows: [...start("Plan summary", title), header("Plan detail", "Selected value"),
      row(["Departure country", report.country + (result.route.knownMarket ? "" : " · New route")]),
      row(["Month", report.month]), row(["Weekly flight schedule", report.schedule]),
      row(["Travel purpose", report.purpose]), row(["Starting values", report.source], "plain", 36),
      row(["Prepared by", report.preparedBy || "Name not supplied"]), blank(),
      header("Result", "Usual", "Your plan", "Change", "Change %"),
      ...steps.map(item => row([item.label, number(item.usual), number(item.plan), change(item.change),
        item.usual ? [item.change / item.usual, "changePercent"] : "–"], "plain", 30)),
      row(["Possible range · Lower guide", "–", number(result.p10)]),
      row(["Possible range · Upper guide", "–", number(result.p90)]),
      blank(), section("In plain words"), row([report.plain], "plain", 30)],
  };
  const visitorLast = 3 + visitors.length;
  const sheets = [dashboard, summary, {
    name: "Assumptions", widths: [40, 19, 19, 15, 64], merges: ["A1:E1", "A2:E2"],
    rows: [...start("Assumptions", "Starting values are the defaults for this route and month."),
      header("Assumption", "Starting value", "Your plan value", "Changed?", "Note"),
      ...assumptions.map(item => row([item.label, [item.usual, item.format], [item.plan, item.format], item.changed ? "Yes" : "No", item.note], item.changed ? "accent" : "plain", 29))],
  }, {
    name: "Visitors", widths: [36, 20, 20, 20, 20, 18], merges: ["A1:F1", "A2:F2"],
    bars: [{range:"F4:F" + visitorLast}], filter: "A3:F" + visitorLast,
    rows: [...start("Visitors", "Nationality groups sorted by planned guest nights."),
      header("Nationality", "Share of check-ins", "Usual nights", "Plan nights", "Change", "Share scale"), ...visitorRows(visitors),
      row(["Total", [1, "percent"], number(result.baseline.guestNights), number(result.scenario.guestNights), change(result.delta.guestNights)], "accent")],
  }, {
    name: "By month", widths: [26, 22, 22, 20, 24], merges: ["A1:E1", "A2:E2"], scales: ["C4:C15"],
    rows: [...start("Guest nights by month", "Uses the current plan inputs with each month's usual baseline, as in Statistics."),
      header("Month", "Usual guest nights", "Plan guest nights", "Change", "Extra hotel check-ins"),
      ...annual.map(item => row([item.label, number(item.usual), number(item.plan), change(item.change), change(item.checkins)], item.selected ? "accent" : "plain"))],
  }, {
    name: "Compare scenarios", widths: [48, 24, 25, 22, 20], merges: ["A1:E1", "A2:E2", "A8:E8", "A16:E16", "A17:E17"],
    bars: [{range:"D19:D30", signed:true}, {range:"E19:E30"}],
    rows: [...start("Compare scenarios", "Flight impact compares each option with zero extra flights at the same assumptions."),
      header("Launch size", "Extra flights / week", "Extra hotel check-ins", "Extra guest nights"),
      ...launch.map(item => row([item.label, number(item.extraFlights), change(item.incremental.hotelCheckins), change(item.incremental.guestNights)])),
      blank(), section("What if fewer visitors stay in hotels?"), header("Trial", "Extra guest nights", "Difference from plan"),
      ...trials.map(item => row([item.label, change(item.nights), change(item.difference)])),
      blank(), section("The same flights in every month"), row([report.monthMode]),
      header("Month", "Extra guest nights", "Nights / 1,000 added seats", "Guest-night scale", "Yield scale"),
      ...comparedMonths.map(item => row([item.monthName, change(item.incremental.guestNights), number(item.per1000AddedSeats ?? "–"),
        number(item.incremental.guestNights), number(item.per1000AddedSeats ?? 0)]))],
  }, {
    name: "Notes", widths: [40, 31, 30, 29], freeze: 2, merges: Array.from({length: notes.length + 2}, (_, i) => "A" + (i + 1) + ":D" + (i + 1)),
    rows: [...start("Notes and limits", "Created by Air2Stay on " + report.date), ...notes.map(note => row([note], "plain", 31))],
  }];
  const typesNs = "http://schemas.openxmlformats.org/package/2006/content-types";
  const packageNs = "http://schemas.openxmlformats.org/package/2006/relationships";
  const parts = sheets.map((sheet, i) => ["xl/worksheets/sheet" + (i + 1) + ".xml", reportWorksheet({ ...sheet, rtl: lang === "ar" })]);
  const officeTypes = "application/vnd.openxmlformats-officedocument.spreadsheetml.";
  const override = (path, type) => '<Override PartName="/' + path + '" ContentType="' + officeTypes + type + '+xml"/>';
  const relation = (id, type, target) => '<Relationship Id="' + id + '" Type="' + reportRelationshipsNs + '/' + type + '" Target="' + target + '"/>';
  return reportZip([
    ["[Content_Types].xml", reportXmlHeader + '<Types xmlns="' + typesNs + '"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      override("xl/workbook.xml", "sheet.main") + override("xl/styles.xml", "styles") +
      parts.map(([path]) => override(path, "worksheet")).join("") + '</Types>'],
    ["_rels/.rels", reportXmlHeader + '<Relationships xmlns="' + packageNs + '">' + relation("rId1", "officeDocument", "xl/workbook.xml") + '</Relationships>'],
    ["xl/workbook.xml", reportXmlHeader + '<workbook xmlns="' + reportSpreadsheetNs + '" xmlns:r="' + reportRelationshipsNs +
      '"><bookViews><workbookView activeTab="0"/></bookViews><sheets>' + sheets.map((sheet, i) =>
        '<sheet name="' + reportXml(exportSheetName(sheet.name)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + '</sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", reportXmlHeader + '<Relationships xmlns="' + packageNs + '">' +
      parts.map(([path], i) => relation("rId" + (i + 1), "worksheet", path.slice(3))).join("") +
      relation("rId" + (parts.length + 1), "styles", "styles.xml") + '</Relationships>'],
    ["xl/styles.xml", reportCellStyles(lang)],
    ...parts,
  ]);
}



function planReportMarkup(report) {
  const { title, subtitle, plain, result, steps, annual, visitors, assumptions, trials, notes } = report;
  const escape = planningEscape;
  const change = value => {
    if (!Math.round(Math.abs(value))) return "–";
    return '<span class="report-' + (value > 0 ? "up" : "down") + '">' + (value > 0 ? "▲ " : "▼ ") + formatSigned(value) + '</span>';
  };
  const table = (headings, rows) => '<table><thead><tr>' + headings.map(text => '<th scope="col">' + escape(text) + '</th>').join("") +
    '</tr></thead><tbody>' + rows.map(({ cells, highlight }) => '<tr' + (highlight ? ' class="report-highlight"' : '') + '>' +
      cells.map((cell, i) => i === 0 ? '<th scope="row">' + cell + '</th>' : '<td>' + cell + '</td>').join("") +
      '</tr>').join("") + '</tbody></table>';
  const bars = rows => {
    const maximum = Math.max(1, ...rows.map(row => row.plan));
    return '<ul class="report-bars">' + rows.map(row => '<li><span>' + escape(row.label) + '</span><span class="report-bar-track" aria-hidden="true">' +
      '<i style="width:' + (row.plan / maximum * 100) + '%"></i></span><strong>' + formatNumber(row.plan) + '</strong>' + '<span>' +
      change(row.change) + '</span></li>').join("") + '</ul>';
  };
  const assumptionValue = (value, format) => format === "percent" ? formatPercent(value, 1)
    : format === "stay" ? value.toFixed(1) + " nights" : formatNumber(value);
  const headline = [
    ["Extra hotel check-ins", change(result.delta.hotelCheckins)], ["Extra guest nights", change(result.delta.guestNights)],
    ["Total guest nights", formatNumber(result.scenario.guestNights)], ["Possible range", formatNumber(result.p10) + " – " + formatNumber(result.p90)],
  ];
  const month = annual.find(row => row.selected);
  const chart = packLineChart(annual.map(row => row.label.slice(0, 3)), [
    { label: "Usual", values: annual.map(row => row.usual) },
    { label: "Your plan", values: annual.map(row => row.plan) },
  ], "Guest nights", annual.indexOf(month));
  return '<header class="report-heading"><p>Air2Stay · Plan report</p><h1>' + escape(title) + '</h1><p>' + escape(subtitle) + '</p></header>' +
    '<div class="report-headlines">' + headline.map(([label, value]) => '<div><span>' + label + '</span><strong>' + value + '</strong></div>').join("") + '</div>' +
    '<p class="report-plain">' + escape(plain) + '</p>' +
    '<section><h2>From seats to guest nights</h2><p class="report-caption">Your plan and its change from usual</p>' + bars(steps) + '</section>' +
    '<section><h2>Guest nights through the year</h2><p class="report-caption">Same plan inputs each month. The dotted line marks ' + escape(month.label) +
    ' (' + formatNumber(month.usual) + ' usual, ' + formatNumber(month.plan) + ' planned).</p>' + chart + '</section>' +
    '<section><h2>Largest visitor groups</h2><p class="report-caption">Plan guest nights and change from usual</p>' + bars(visitors.slice(0, 8)) + '</section>' +
    '<div class="report-next-page"><header class="report-heading report-continuation"><p>' + escape(title) + '</p></header>' +
    '<section><h2>Assumptions</h2>' + table(["Assumption", "Starting value", "Your plan", "Changed?"], assumptions.map(row => ({
      cells: [escape(row.label), assumptionValue(row.usual, row.format), assumptionValue(row.plan, row.format), row.changed ? "Yes" : "–"],
      highlight: row.changed,
    }))) + '<p class="report-caption report-assumptions-note">Event impact is a user estimate of the effect on hotel demand.</p></section>' +
    '<section><h2>What if fewer visitors stay in hotels?</h2><p class="report-caption">Extra guest nights from flight changes at the trial assumptions</p>' +
    table(["Trial", "Extra guest nights", "Difference from plan"], trials.map(row => ({
      cells: [escape(row.label), change(row.nights), change(row.difference)],
    }))) + '</section>' +
    '<section class="report-notes"><h2>Notes and limits</h2><ul>' + notes.map(note => '<li>' + escape(note) + '</li>').join("") +
    '</ul></section></div>';
}

// Exports are built in English, then translated into the chosen export
// language. This is independent of the page language.
let exportLanguage = "en";
let switchingLanguageForPrint = false;

function withLanguage(lang, build) {
  const previous = uiLanguage;
  uiLanguage = lang === "ar" ? "ar" : "en";
  try { return build(); } finally { uiLanguage = previous; }
}

// Translate an exported text block line by line; "- " bullets keep their marker.
function translateExportText(text, lang) {
  if (lang !== "ar") return text;
  return withLanguage("ar", () => String(text).split("\n").map((line) => {
    const bullet = line.match(/^(\s*-\s+)(.+)$/);
    if (bullet) return bullet[1] + translateUiString(bullet[2]);
    return line.trim() ? translateUiString(line) : line;
  }).join("\n"));
}

function exportFileName(name, lang) {
  return lang === "ar" ? name.replace(/(\.[a-z]+)$/, "-ar$1") : name;
}

function exportSheetName(name) {
  return translateUiString(name).replace(/[:\\/?*[\]]/g, " ").slice(0, 31);
}

function printPlanReport(report, lang = exportLanguage) {
  const sheet = $("#planPrintSheet");
  const holder = document.createElement("div");
  holder.innerHTML = planReportMarkup(report);
  if (lang === "ar") withLanguage("ar", () => localizeUi(holder));
  // The page translator must not change the report after it is built.
  sheet.setAttribute("data-i18n-ignore", "");
  sheet.lang = lang;
  sheet.dir = lang === "ar" ? "rtl" : "ltr";
  sheet.replaceChildren(...holder.childNodes);
  document.body.classList.add("printing-plan-report");
  const finish = () => {
    sheet.replaceChildren();
    document.body.classList.remove("printing-plan-report");
  };
  window.addEventListener("afterprint", finish, { once: true });
  try { window.print(); }
  catch (error) {
    window.removeEventListener("afterprint", finish);
    finish();
    throw error;
  }
}

// Print the current page (Term guide) in the chosen language, then switch back.
function printInLanguage(lang) {
  const original = uiLanguage;
  if (lang === original) { window.print(); return; }
  const switchTo = (language) => {
    switchingLanguageForPrint = true;
    try { $(`button[data-lang="${language}"]`)?.click(); } finally { switchingLanguageForPrint = false; }
  };
  let restored = false;
  const restore = () => { if (restored) return; restored = true; switchTo(original); };
  switchTo(lang);
  window.addEventListener("afterprint", restore, { once: true });
  try { window.print(); }
  catch (error) { window.removeEventListener("afterprint", restore); restore(); throw error; }
}

function setupExportLanguage() {
  exportLanguage = uiLanguage;
  const picker = () => {
    const group = document.createElement("div");
    group.className = "export-language";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "Export language");
    group.innerHTML = '<span class="export-language-label">Export language</span>' +
      '<span class="export-language-options">' +
      '<button type="button" data-export-lang="en" lang="en" dir="ltr" data-i18n-ignore>English</button>' +
      '<button type="button" data-export-lang="ar" lang="ar" dir="rtl" data-i18n-ignore>العربية</button></span>';
    return group;
  };
  $(".export-menu .export-choices")?.prepend(picker());
  $("#planningDecision .decision-note-actions")?.prepend(picker());
  $("#printGuide")?.before(picker());
  const sync = () => $$("[data-export-lang]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.exportLang === exportLanguage)));
  document.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-export-lang]");
    if (choice) { exportLanguage = choice.dataset.exportLang === "ar" ? "ar" : "en"; sync(); return; }
    // A new page language becomes the default export language.
    if (event.target.closest("button[data-lang]") && !switchingLanguageForPrint) setTimeout(() => { exportLanguage = uiLanguage; sync(); }, 0);
  });
  sync();
}



function buildModelCsv(inputs, lang = "en") {
  // Column names and codes stay in English so model tools can read them.
  const exportLabel = (text) => lang === "ar" ? withLanguage("ar", () => translateUiString(String(text))) : text;
  const header = [
    "meta_data_kind", "meta_scenario", "meta_is_current_plan", "meta_departure_country", "meta_has_route_history",
    "feature_calendar_month", "feature_weeks_in_month", "feature_usual_monthly_flight_seats",
    "feature_weekly_flight_change", "feature_seats_per_flight", "feature_flight_load_fraction",
    "feature_passengers_ending_trip_fraction", "feature_hotel_checkin_fraction", "feature_nights_per_stay",
    "feature_event_uplift_fraction", "target_simulated_hotel_checkins", "target_simulated_guest_nights",
  ];
  const rows = data.months.flatMap((_, index) => {
    const month = index + 1;
    const monthly = planInputsForMonth(inputs, month);
    const stress = stressTest(data, monthly);
    const variants = [
      { label: "Current plan settings", inputs: monthly, result: stress.base.result },
      { label: "No weekly flight change", inputs: { ...monthly, extraFlights: 0 }, result: stress.base.noAddedFlights },
      ...launchOptions(data, monthly),
      ...stress.trials,
    ];
    const seen = new Set();
    return variants.flatMap(({ label, inputs: plan, result }, variant) => {
      const features = [
        month, weeksInMonth(month), result.route.baselineSeats, plan.extraFlights, plan.seatsPerFlight,
        plan.loadFactor, plan.p2pShare, plan.conversionRate, plan.averageStay, result.eventUplift,
      ];
      const key = features.join(",");
      if (seen.has(key)) return [];
      seen.add(key);
      return [[
        "simulation", exportLabel(label), Number(variant === 0 && month === inputs.month), exportLabel(result.route.origin), Number(result.route.knownMarket),
        ...features, result.scenario.hotelCheckins, result.scenario.guestNights,
      ]];
    });
  });
  const csvValue = value => typeof value === "string" && /[",\r\n]/.test(value)
    ? '"' + value.replaceAll('"', '""') + '"'
    : value;
  return (lang === "ar" ? String.fromCharCode(0xFEFF) : "") + [header, ...rows].map(row => row.map(csvValue).join(",")).join("\r\n") + "\r\n";
}



function setupPlanActions() {
  const exportMenu = $(".export-menu");
  document.addEventListener("click", (event) => {
    if (!exportMenu.contains(event.target) || event.target.closest(".export-menu button:not([data-export-lang])")) exportMenu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && exportMenu.open) {
      exportMenu.open = false;
      exportMenu.querySelector("summary").focus();
    }
  });
  document.addEventListener("focusin", (event) => {
    if (!exportMenu.contains(event.target)) exportMenu.open = false;
  });
  const ready = () => {
    if (!$("#inputError").hidden) { $("#planActionStatus").textContent = "Correct the highlighted input first."; return false; }
    if ($("#origin").value === "__NEW_ROUTE__" && !confirmedNewMarketKey) { $("#planActionStatus").textContent = "Confirm a new departure country first."; return false; }
    readForm(); return true;
  };
  const exportReport = (action) => {
    if (!ready()) return;
    const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(new Date());
    const status = $("#planActionStatus");
    try { action(buildPlanReport(state, "", date)); }
    catch (error) {
      status.textContent = "The report could not be prepared. Check the plan and try again.";
      console.error(error);
    }
  };
  $("#exportWorkbook").addEventListener("click", () => exportReport(report => {
    downloadPlan(buildPlanWorkbook(report, exportLanguage), exportFileName(report.filename + ".xlsx", exportLanguage));
    $("#planActionStatus").textContent = "Excel report ready.";
  }));
  $("#exportReportPdf").addEventListener("click", () => exportReport(report => {
    printPlanReport(report, exportLanguage);
    $("#planActionStatus").textContent = "Choose Save as PDF in the print window.";
  }));
  $("#exportCsv").addEventListener("click", () => {
    if (!ready()) return;
    downloadPlan(new Blob([buildModelCsv(state, exportLanguage)], { type: "text/csv;charset=utf-8" }), exportFileName("Air2Stay-simulated-training-data.csv", exportLanguage));
    guidedHelp?.track("export_csv");
    $("#planActionStatus").textContent = "Model-ready CSV with simulated outcomes is ready.";
  });
}

function downloadPlan(blob, name) {
  if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
  lastExportUrl = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = lastExportUrl; link.download = name; link.className = "export-ready-link";
  // "Download" is translated; the file name is kept exactly as saved.
  const fileName = document.createElement("span"); fileName.setAttribute("data-i18n-ignore", ""); fileName.dir = "ltr"; fileName.textContent = name;
  link.append("Download", " ", fileName);
  const ready = $("#exportReady"); ready.hidden = false;
  ready.replaceChildren(document.createTextNode("Your file is ready. If the download did not begin, choose: "),link);
  link.click();
}

function refreshGlossaryLetters() {
  const letters = new Map();
  for (const card of $$("#glossaryGrid .definition")) {
    const term = card.querySelector("h3");
    const letter = translateUiString(englishUiText(term))[0];
    if (letter && !letters.has(letter)) letters.set(letter, card.id);
  }
  $("#glossaryLetters").innerHTML = [...letters].map(([letter, id]) => `<a href="#${id}">${planningEscape(letter)}</a>`).join("");
}

 function renderGlossary() {
   const plainTerms = {
     "Hotel check-in": "A guest arriving to begin a stay at a hotel.",
     "Guest night": "One guest staying for one night. One guest staying three nights counts as three guest nights.",
     "Passengers ending their trip in Abu Dhabi": "Passengers who arrive here and do not continue their flight to another destination.",
     "How full a flight is": "If 160 of 200 seats are filled, the flight is 80% full.",
     "Possible range": "Lower and higher guides around the main estimate. They are not guarantees.",
     "Estimated visitor mix": "An estimate of the nationalities of hotel guests. It shows groups, not individual people.",
     "Past records": "Older flight and hotel numbers used to help choose starting values. More matching records can help, but cannot guarantee accuracy.",
   };
   const examples = { "Hotel check-in": "One guest beginning a hotel stay = one check-in.", "Guest night": "2 guests × 3 nights = 6 guest nights.", "Passengers ending their trip in Abu Dhabi": "A traveller staying here is included; one changing planes is not.", "How full a flight is": "160 passengers ÷ 200 seats = 80% full.", "Possible range": "Read it as a planning guide, not a guaranteed outcome.", "Estimated visitor mix": "A 20% share means about 20 in every 100 estimated hotel guests.", "Past records": "Four matching records describe the data available, not four successful predictions." };
   const terms = Object.entries(plainTerms).sort(([a],[b]) => a.localeCompare(b));
   $("#glossaryGrid").innerHTML = terms.map(([term, meaning],index) => `<article class="definition" id="term-${index}" data-search="${(term + " " + meaning).toLowerCase()}"><h3>${term}</h3><p>${meaning}</p><p class="term-example">${examples[term]}</p></article>`).join("");
   refreshGlossaryLetters();
   const search = () => {
     const value = $("#glossarySearch").value.trim().toLowerCase();
     let matches = 0;
     $$("#glossaryGrid .definition").forEach((card) => { card.hidden = !card.dataset.search.includes(value) && !card.textContent.toLowerCase().includes(value); if (!card.hidden) matches++; });
     $("#glossaryCount").textContent = matches ? matches + " definitions" : "No matching term. Try a word such as flights, hotel or nights.";
     $("#glossaryLetters").hidden = Boolean(value);
   };
   $("#glossarySearch").addEventListener("input",search); search();
   $("#glossaryLetters").addEventListener("click", (event) => {
     const link = event.target.closest("a"); if (!link) return;
     event.preventDefault(); $(link.getAttribute("href")).scrollIntoView({block:"start"});
   });
   $("#printGuide").addEventListener("click", () => printInLanguage(exportLanguage));
 }
  
function setupTeamDock() {
  const dock = $(".team-rail");
  const handle = $(".team-rail-grip");
  const header = $(".topbar");
  let position = 50;
  let grabOffset = 0;

  const bounds = () => {
    const top = header.getBoundingClientRect().bottom + 8;
    return {top, travel: Math.max(0, window.innerHeight - dock.offsetHeight - top - 8)};
  };
  const move = (value, {top, travel} = bounds()) => {
    position = Math.max(0, Math.min(100, Math.round(value)));
    dock.style.top = (top + (100 - position) / 100 * travel) + "px";
    handle.setAttribute("aria-valuenow", position);
  };

  handle.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    grabOffset = event.clientY - dock.getBoundingClientRect().top;
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    const available = bounds();
    if (available.travel) move(100 * (1 - (event.clientY - grabOffset - available.top) / available.travel), available);
  });
  handle.addEventListener("keydown", (event) => {
    const positions = {ArrowUp:position + 5, ArrowRight:position + 5, ArrowDown:position - 5, ArrowLeft:position - 5, Home:0, End:100};
    if (!Object.hasOwn(positions, event.key)) return;
    event.preventDefault();
    move(positions[event.key]);
  });

  const keepInView = () => move(position);
  keepInView();
  window.addEventListener("resize", keepInView);
  const observer = new ResizeObserver(keepInView);
  observer.observe(header);
  observer.observe(dock);
}

let refreshPackStatistics = () => {};

function packLineChart(labels, series, unit, selected = -1) {
  const peak = Math.max(1, ...series.flatMap(row => row.values));
  const start = 49;
  const end = 539;
  const x = index => start + index * (end - start) / Math.max(1, labels.length - 1);
  const y = value => 140 - value * 113 / peak;
  const axisNumber = new Intl.NumberFormat("en", {notation: "compact", maximumFractionDigits: 1});
  const legend = series.map((row, index) => `<span><i class="pack-series-${index}"></i>${planningEscape(row.label)}</span>`).join("");
  const grid = [0, peak / 2, peak].map(value => `<path class="pack-chart-grid" d="M ${start} ${y(value)} H ${end}"/><text x="43" y="${y(value) + 4}" text-anchor="end">${axisNumber.format(value)}</text>`).join("");
  const guide = selected < 0 ? "" : `<path class="pack-chart-marker" d="M ${x(selected)} 27 V 140"/>`;
  const lines = series.map((row, index) => `
    <polyline class="pack-series-${index}" points="${row.values.map((value, i) => `${x(i)},${y(value)}`).join(" ")}"/>
    ${row.values.map((value, i) => `<circle class="pack-series-${index}" cx="${x(i)}" cy="${y(value)}" r="${i === selected ? 4.3 : 2.8}"><title>${planningEscape(`${labels[i]} · ${row.label}: ${formatNumber(value)}`)}</title></circle>`).join("")}`).join("");
  const names = labels.map((label, index) => `<text x="${x(index)}" y="161" text-anchor="middle">${planningEscape(label)}</text>`).join("");
  const accessible = series.map(row => `${row.label}: ${row.values.map((value, i) => `${labels[i]} ${formatNumber(value)}`).join(", ")}`).join(". ");
  return `<div class="pack-chart-key">${legend}</div>
    <svg class="pack-line-chart" dir="ltr" viewBox="0 0 556 171" role="img" aria-label="${planningEscape(`${unit}. ${accessible}`)}">
      ${grid}${guide}${lines}${names}
    </svg>`;
}

function packBarChart(rows, formatter, maximum = Math.max(1, ...rows.map(row => row.value))) {
  return `<ul class="pack-bar-chart">${rows.map(({label, value}) => `<li>
    <span>${planningEscape(label)}</span><strong>${formatter(value)}</strong>
    <span class="pack-stat-track" aria-hidden="true"><i style="width:${Math.max(0, value) / maximum * 100}%"></i></span>
  </li>`).join("")}</ul>`;
}

function setupPackStatistics() {
  const page = $("#statsView");
  page.innerHTML = '<div class="intro-row"><div><p>Statistics</p><h1>See the numbers in context</h1><span id="statsContext"></span></div></div><div id="statsCharts" class="pack-statistics-grid"></div>';
  const title = $("#statsContext");
  const grid = $("#statsCharts");
  refreshPackStatistics = context => {
    if (!page.classList.contains("active")) return;
    if (!context) {
      title.textContent = "Finish entering a valid plan to see its charts.";
      grid.replaceChildren();
      return;
    }
    const {inputs, result} = context;
    const shortMonths = data.months.map(name => name.slice(0, 3));
    const annual = planResultsByMonth(inputs, result);
    const markets = data.routes.filter(route => route.month === inputs.month)
      .sort((first, second) => second.baselineSeats - first.baselineSeats).slice(0, 6);
    const nationalities = [...result.bridge].sort((first, second) => second.weight - first.weight);
    const outsideTopFive = nationalities.slice(5).reduce((total, row) => total + row.weight, 0);
    const seats = data.months.map((_, index) => data.routes.reduce(
      (total, route) => total + (route.month === index + 1 ? route.baselineSeats : 0), 0
    ));
    const charts = [
      ["Guest nights through the year", "The same plan inputs each month, against each month’s baseline estimate.",
        packLineChart(shortMonths, [
          {label: "Baseline estimate", values: annual.map(row => row.baseline.guestNights)},
          {label: "Your plan", values: annual.map(row => row.scenario.guestNights)},
        ], "Guest nights", inputs.month - 1)],
      ["Largest departure markets", "Average historical flight seats in the selected month.",
        packBarChart(markets.map(route => ({label: route.origin, value: route.baselineSeats})), formatNumber)],
      ["Total seats by month", "Sum of average historical flight seats across included markets.",
        packLineChart(shortMonths, [{label: "Past flight seats", values: seats}], "Flight seats", inputs.month - 1)],
    ];
    title.textContent = `${result.route.origin} → Abu Dhabi · ${data.months[inputs.month - 1]}`;
    grid.innerHTML = charts.map(([heading, note, chart]) => `<section class="content-block pack-statistics-card">
      <h2>${planningEscape(heading)}</h2><p>${planningEscape(note)}</p>${chart}
    </section>`).join("") + `<section class="content-block pack-statistics-card">
      <h2>More data</h2><p>Share outside the 5 largest nationality groups: <strong>${formatPercent(outsideTopFive, 1)}</strong></p>
      <div class="evidence-links"><button type="button" class="text-action" data-evidence="mix">Open Visitor Mix →</button>
        <button type="button" class="text-action" data-evidence="validation">Open historical validation results →</button></div>
    </section>`;
  };
  $('.nav-tab[data-view="statsView"]').addEventListener("click", () => refreshPackStatistics(currentProposalContext));
  refreshPackStatistics(currentProposalContext);
}

function setupPackSearch({getMessages, getRequests, openMessage, openRequest}) {
  const wrapper = document.createElement("div");
  wrapper.className = "app-search";
  wrapper.setAttribute("role", "search");
  wrapper.setAttribute("aria-label", "Search Air2Stay");
  wrapper.innerHTML = `<input id="appSearch" type="search" role="combobox" aria-label="Search Air2Stay"
    aria-controls="appSearchResults" aria-expanded="false" aria-autocomplete="list" autocomplete="off" placeholder="Search">
    <kbd aria-hidden="true">/</kbd>
    <div class="app-search-popover" hidden>
      <ul id="appSearchResults" role="listbox" aria-label="Search results"></ul>
      <p role="status" class="app-search-empty" hidden>No results found.</p>
    </div>`;
  $("#openGuide").before(wrapper);
  const input = $("#appSearch");
  const list = $("#appSearchResults");
  const popover = list.parentElement;
  const empty = wrapper.querySelector(".app-search-empty");
  let matches = [];
  let selected = -1;

  const comparableText = value => String(value || "").normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase();
  const page = id => $(`.nav-tab[data-view="${id}"]`)?.click();
  const planView = mode => {
    page("scenarioView");
    $(`.view-mode[data-mode="${mode}"]`)?.click();
  };
  const reveal = target => {
    if (!target) return;
    for (let element = target; element; element = element.parentElement) {
      if (element.matches("details")) element.open = true;
    }
    const focus = target.matches("input, select, button, a, summary") ? target
      : target.querySelector(":scope > summary") || target;
    if (!focus.matches("input, select, button, a, summary")) focus.tabIndex = -1;
    focus.focus({preventScroll: true});
    target.scrollIntoView({block: "start"});
  };
  const compareTools = [
    ["Compare routes", "#routeOptions", "existing route comparison"],
    ["Three launch sizes", "#launchOptions", "cautious standard expanded"],
    ["Compare months", "#monthChart", "calendar season monthly"],
    ["What if fewer visitors stay in hotels?", "#stressChart", "stress test sensitivity hotel use"],
    ["Work backwards from a hotel-night target", "#targetGuestNights", "goal seek capacity required flights"],
    ["Decision note", "#planningDecision", "print save pdf export"],
  ];
  const controls = [
    ["Departure country", "marketControls", "#origin", "origin route"],
    ["New departure country", "marketControls", "#newMarketCountry", "market route"],
    ["Comparison market", "marketControls", "#proxyMarket", "starting assumptions"],
    ["Month", "marketControls", "#month", "season"],
    ["Extra flights each week", "aircraftControls", "#extraFlights", "weekly flight change"],
    ["Seats on each flight", "aircraftControls", "#seatsPerFlight", "aircraft capacity"],
    ["How full flights are", "aircraftControls", "#loadFactor", "load factor occupancy"],
    ["Hotel demand adjustment", "eventImpactGroup", "#eventUplift", "event disruption"],
    ["Expected travel purpose", "visitorControls", "#routePurpose", "visitor trip purpose"],
    ["Passengers ending their trip in Abu Dhabi", "visitorControls", "#p2pShare", "trip ending share p2p"],
    ["Share checking into a hotel", "visitorControls", "#conversionRate", "hotel use conversion rate"],
    ["Average nights per hotel stay", "visitorControls", "#averageStay", "average stay"],
  ];
  function searchEntries() {
    const pages = $$(".topbar .nav-tab").map(button => ({
      label: (button.querySelector("[data-i18n]") || button).textContent.trim(), type: "Page", open: () => button.click()
    }));
    const views = $$(".view-mode").filter(button => !button.hidden).map(button => ({
      label: button.textContent.trim(), type: "Plan view", open: () => planView(button.dataset.mode)
    }));
    const compare = compareTools.map(([label, selector, keywords]) => ({
      label, keywords, type: "Compare tool", open: () => { planView("decisions"); reveal($(selector)); }
    }));
    const details = $$(".detail-tier").map(section => ({
      label: section.querySelector("summary").textContent.trim(), type: "Details", open: () => { planView("details"); reveal(section); }
    }));
    const fields = controls.map(([label, group, selector, keywords]) => ({
      label, keywords, type: "Control", open: () => {
        planView("focus");
        const field = $(selector);
        const hiddenRegion = field?.closest("[hidden]");
        openPlanControl(group, hiddenRegion && hiddenRegion.id !== "planControls" ? null : field);
      }
    }));
    const choose = (field, value) => {
      if (field.value === value && field.id !== "newMarketCountry") return;
      field.value = value;
      field.dispatchEvent(new Event("input", {bubbles: true}));
    };
    const countries = knownOrigins().map(({key, name}) => ({
      label: name, type: "Departure country", open: () => { planView("focus"); choose($("#origin"), key); }
    }));
    const newCountries = [...$("#newMarketCountryList").options].map(option => ({
      label: option.dataset.countryName, type: "New departure country", open: () => {
        planView("focus");
        choose($("#origin"), "__NEW_ROUTE__");
        choose($("#newMarketCountry"), option.value);
        $("#confirmNewMarket").click();
      }
    }));
    const months = data.months.map((label, index) => ({
      label, type: "Month", open: () => { planView("focus"); choose($("#month"), String(index + 1)); }
    }));
    const glossary = $$("#glossaryGrid .definition").map(card => ({
      label: card.querySelector("h3").textContent, type: "Term guide", open: () => {
        page("glossaryView");
        const field = $("#glossarySearch");
        field.value = "";
        field.dispatchEvent(new Event("input"));
        reveal(card);
      }
    }));
    const messages = getMessages().map(message => ({
      label: message.subject, keywords: message.body, example: message.example, type: "Message", open: () => openMessage(message.id)
    }));
    const requests = getRequests().map(request => ({
      label: request.title, example: request.example, type: "Approval request", open: () => openRequest(request.id)
    }));
    return [...pages, ...views, ...compare, ...details, ...fields, ...countries, ...newCountries, ...months, ...glossary, ...messages, ...requests];
  }

  function close() {
    matches = [];
    selected = -1;
    popover.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  function select(index) {
    selected = index;
    const option = list.children[index];
    [...list.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
    input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({block: "nearest"});
  }
  function chooseResult(index) {
    const entry = matches[index];
    if (!entry) return;
    input.value = "";
    close();
    input.blur();
    entry.open();
  }
  function render() {
    const query = comparableText(input.value.trim());
    if (!query) { close(); return; }
    const words = query.split(/\s+/);
    matches = searchEntries().map(entry => {
      const label = comparableText(entry.label);
      const localized = !entry.example && ["Message", "Approval request"].includes(entry.type) ? "" : comparableText(translateUiString(entry.label));
      const terms = [label, localized, comparableText(entry.type), comparableText(entry.keywords)].join(" ");
      const score = label === query || localized === query ? 4 : label.startsWith(query) || localized.startsWith(query) ? 3 : label.includes(query) || localized.includes(query) ? 2 : words.every(word => terms.includes(word)) ? 1 : 0;
      return {entry, score};
    }).filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, 12).map(item => item.entry);
    list.innerHTML = matches.map((entry, index) => `<li id="appSearchOption-${index}" role="option" aria-selected="false" data-app-search-index="${index}"><span${!entry.example && ["Message", "Approval request"].includes(entry.type) ? " data-i18n-ignore" : ""}>${planningEscape(entry.label)}</span><small>${planningEscape(entry.type)}</small></li>`).join("");
    selected = -1;
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "true");
    popover.hidden = false;
    empty.hidden = Boolean(matches.length);
  }
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (!matches.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const move = event.key === "ArrowDown" ? 1 : -1;
      const index = selected < 0 ? (move > 0 ? 0 : matches.length - 1) : (selected + move + matches.length) % matches.length;
      select(index);
    } else if (event.key === "Enter") {
      event.preventDefault();
      chooseResult(Math.max(0, selected));
    }
  });
  list.addEventListener("pointerdown", event => event.preventDefault());
  list.addEventListener("click", event => {
    const option = event.target.closest("[data-app-search-index]");
    if (option) chooseResult(Number(option.dataset.appSearchIndex));
  });
  document.addEventListener("click", event => { if (!wrapper.contains(event.target)) close(); });
  document.addEventListener("focusin", event => { if (!wrapper.contains(event.target)) close(); });
  document.addEventListener("keydown", event => {
    if (event.key === "/" && !event.altKey && !event.ctrlKey && !event.metaKey &&
        !$("dialog[open]") && !event.target.closest("input, textarea, select, [contenteditable]")) {
      event.preventDefault();
      input.focus();
    }
  });
}



function setupFeaturePack() {
  const storageKey = "air2stay:team-workspace:v2";
  const senderName = "Planning team";
  const directory = [
    {name:senderName, email:"planning@air2stay.example"},
    {name:"Hotel partnerships", email:"hotels@air2stay.example"},
    {name:"Airline route planning", email:"airline@air2stay.example"},
    {name:"Data and insights", email:"data@air2stay.example"},
    {name:"Review team", email:"review@air2stay.example"},
  ];
  const requestStates = {waiting:"Waiting", approved:"Approved", changes:"Changes requested", rejected:"Rejected"};
  const now = Date.now();
  const minutesAgo = (minutes) => new Date(now - minutes * 60000).toISOString();
  const dueIn = (days) => new Date(now + days * 86400000).toISOString().slice(0, 10);
  const previousAccuracyExample = "Hello,\n\nThe live calculation was about 6.6% away from recorded hotel arrivals, measured as weighted error across Jan–Jul 2025. That check covers monthly totals across markets.";
  const accuracyExample = "The validation page has the measured error, test months and monthly arrival totals for this model.";
  const capacityReviewNote = "Review the room-capacity estimate before replying to Hotel partnerships.";
  const examples = [
    {id:"example-mail-hotel", from:directory[1].email, subject:"December room availability: we need your forecast",
      body:"Hello,\n\nSeveral hotels are planning December room blocks this week. Could you share the expected extra guest nights for the proposed India flights?\n\nA rough range is enough for now.\n\nThank you,\nHotel partnerships",
      priority:"High", createdAt:minutesAgo(53), attachments:[{name:"december-room-blocks.xlsx",size:47000}]},
    {id:"example-mail-airline", from:directory[2].email, subject:"Load factor for the new frequencies",
      body:"Hi,\n\nCould you confirm how full you expect the new flights to be and share any early booking data? We'll use it to review the flight occupancy assumption.",
      priority:"Normal", createdAt:minutesAgo(300)},
    {id:"example-mail-data", from:directory[3].email, subject:"Accuracy results for the 2025 test months",
      body:accuracyExample,
      priority:"Low", createdAt:minutesAgo(2880)},
  ];
  const team = {
    seedVersion:1,
    messages:examples.map((item, index) => ({...item, folder:"inbox", example:true, unread:index === 0})),
    requests:[
      {id:"example-approval-forecast", title:examples[0].subject, from:directory[1].name, recipient:"You",
        priority:"High", note:capacityReviewNote, due:dueIn(3), createdAt:examples[0].createdAt},
      {id:"example-approval-india", title:"Approve +3 weekly flights, India → Abu Dhabi, December",
        from:directory[2].name, recipient:"Tourism strategy lead", priority:"High",
        note:"Airline partner wants a go-ahead before filing the winter schedule.", due:dueIn(2), createdAt:minutesAgo(180),
        plan:{version:1, inputs:{...defaultState("INDIA", 12), extraFlights:3}}},
      {id:"example-approval-capacity", title:"Sign off the hotel capacity check for December",
        from:directory[1].name, recipient:"Tourism strategy lead", priority:"Normal",
        note:"Confirm hotels can take the extra guest nights in peak season.", due:dueIn(5), createdAt:minutesAgo(2880)},
    ].map((item) => ({...item, status:"waiting", example:true})),
    notifications:[{id:"example-notification", text:"Example · A sample plan is waiting for review.", unread:true}],
  };
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey));
    const previousExamples = new Set(["example-message", "example-review", "example-airline", "example-hotel"]);
    for (const key of ["requests","messages","notifications"]) {
      if (!Array.isArray(stored?.[key])) continue;
      const records = stored[key].filter((item) => item && typeof item.id === "string");
      team[key] = stored.seedVersion >= team.seedVersion || key === "notifications"
        ? records
        : [...records.filter((item) => !previousExamples.has(item.id)), ...team[key]];
    }
    if (!stored || stored.seedVersion !== team.seedVersion) localStorage.setItem(storageKey, JSON.stringify(team));
  } catch { /* Unavailable or unreadable browser storage. */ }
  for (const item of team.messages) {
    if (item.example && item.id === "example-mail-data" && item.body === previousAccuracyExample) item.body = accuracyExample;
  }
  for (const item of team.requests) {
    if (item.example && item.id === "example-approval-forecast" && item.note === examples[0].body) item.note = capacityReviewNote;
  }

  const esc = planningEscape;
  const makeId = () => globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2);
  const teamDrawer = $("#teamDrawer");
  const drawerBody = $("#teamDrawerBody");
  const compose = $("#composeDialog");
  const messageForm = $("#messageForm");
  let teamTab = "tasks";
  let approvalFilter = "waiting";
  let folder = "inbox";
  let priorityFilter = "";
  let selectedMessageId = "";
  let draftId = "";
  let attachments = [];
  let toastTimer;
  const selectPage = (view) => $$(".nav-tab").find((button)=>button.dataset.view === view)?.click();
  const selectPlanMode = (mode) => {
    selectPage("scenarioView");
    $$(".view-mode").find((button)=>button.dataset.mode === mode)?.click();
  };
  const reveal = (element) => {
    if (!element) return;
    for (let group = element.closest("details"); group; group = group.parentElement?.closest("details")) group.open = true;
    element.scrollIntoView({block:"nearest"});
  };
  const toast = (text) => {
    const element = $("#featureToast");
    element.textContent = text;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { element.hidden = true; }, 4500);
  };
  const persist = (notice) => {
    let saved = true;
    try { localStorage.setItem(storageKey, JSON.stringify(team)); }
    catch { saved = false; }
    renderBadges();
    if (notice || !saved) toast((notice || "") + (saved ? "" : " Browser storage is unavailable. Changes last for this visit only."));
  };
  const addNotification = (text) => {
    team.notifications.unshift({id:makeId(),text,unread:true});
    team.notifications.length = Math.min(team.notifications.length, 100);
  };
  function renderBadges() {
    const unread = team.messages.filter((row) => row.folder === "inbox" && row.unread).length;
    const counts = {
      messageUnread:unread,
      inboxUnread:unread,
      notificationCount:team.notifications.filter((row) => row.unread).length,
    };
    for (const [id,count] of Object.entries(counts)) {
      const badge = $("#"+id);
      badge.textContent = String(count);
      badge.hidden = !count;
    }
    $("#openNotifications").setAttribute("aria-label", counts.notificationCount ? `Notifications (${counts.notificationCount} unread)` : "Notifications");
  }

  teamSnapshot = () => ({
    messages: team.messages.map((item) => {
      const parties = messageParties(item);
      const subject = String(item.subject || "");
      return { folder: item.folder, subject, from: parties.from, to: parties.to, unread: Boolean(item.unread), priority: item.priority,
        body: String(item.body || "").slice(0, 600),
        subjectAr: item.example ? withLanguage("ar", () => translateUiString(subject)) : subject,
        fromAr: withLanguage("ar", () => translateUiString(parties.from)), toAr: withLanguage("ar", () => translateUiString(parties.to)) };
    }),
    requests: team.requests.map((item) => {
      const title = String(item.title || "");
      return { title, from: String(item.from || ""), recipient: item.toProfile ? "You" : String(item.recipient || ""), status: requestStates[item.status] || String(item.status || ""),
        titleAr: item.example ? withLanguage("ar", () => translateUiString(title)) : title, fromAr: withLanguage("ar", () => translateUiString(String(item.from || ""))) };
    }),
  });
  const contactName = (address) => directory.find((contact) => contact.email === address)?.name || address;
  const priorityClass = (priority) => ["High","Normal","Low"].includes(priority) ? "priority-" + priority.toLowerCase() : "priority-normal";
  const shortDate = new Intl.DateTimeFormat("en-GB", {day:"numeric", month:"short"});
  const fullDate = new Intl.DateTimeFormat("en-GB", {day:"numeric", month:"short", hour:"2-digit", minute:"2-digit"});
  const relativeTime = (date) => {
    const timestamp = Date.parse(date);
    if (!Number.isFinite(timestamp)) return "";
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    if (minutes < 1440) return Math.floor(minutes / 60) + " h ago";
    return shortDate.format(timestamp);
  };
  const clipboardIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="5" y="5" width="14" height="16" rx="2"/><path d="M9 5V3h6v2m-7 9 3 3 5-5"/></svg>';
  const paperclipIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M8 13l6-6a2 2 0 0 1 3 3l-7 7a4 4 0 0 1-6-6l8-8a5 5 0 0 1 7 7l-8 8"/></svg>';
  const exampleBadge = '<span class="example-tag">Example</span>';

  function renderApprovalCard(item) {
    const dueDate = Date.parse(item.due + "T12:00:00");
    const due = Number.isFinite(dueDate) ? shortDate.format(dueDate) : "";
    const metadata = [
      (item.from || senderName) + " → " + (item.toProfile ? "You" : item.recipient),
      due ? "due " + due : "",
      relativeTime(item.createdAt),
    ].filter(Boolean).join(" · ");
    return `<article class="feature-card request-card ${priorityClass(item.priority)}" data-request-id="${esc(item.id)}">
      <div class="mail-tags">
        <span class="priority-tag ${priorityClass(item.priority)}">${esc(item.priority)}</span>
        <span class="feature-status status-${esc(item.status)}">${esc(requestStates[item.status] || "Waiting")}</span>
        ${item.example ? exampleBadge : ""}
      </div>
      <h3 ${item.example ? "" : "data-i18n-ignore"} dir="auto">${esc(item.title)}</h3>
      ${item.note ? `<p class="request-note" ${item.example ? "" : "data-i18n-ignore"} dir="auto">${esc(item.note)}</p>` : ""}
      <p class="feature-muted">${esc(metadata)}</p>
      <div class="feature-button-row">${item.status === "waiting"
        ? '<button type="button" data-request-action="approved">Approve</button><button type="button" data-request-action="changes">Ask for changes</button><button type="button" data-request-action="rejected">Reject</button>'
        : '<button type="button" data-request-action="waiting">Reopen</button>'}
      ${item.plan ? '<button type="button" data-request-action="open">Open this plan</button>' : ""}</div>
    </article>`;
  }

  function renderTeamDrawer() {
    $$(".team-tabs [data-team-tab]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.teamTab === teamTab)));
    if (teamTab === "notifications") {
      drawerBody.innerHTML = `<div class="feature-card-title"><h3>Notifications</h3><button type="button" id="readAllNotifications"${team.notifications.some((item)=>item.unread) ? "" : " disabled"}>Mark all as read</button></div>
        <ul class="notification-list">${team.notifications.map((item)=>`<li class="${item.unread ? "unread" : ""}">${esc(item.text)} ${item.unread ? '<small>Unread</small>' : ""}</li>`).join("") || "<li>No notifications yet.</li>"}</ul>`;
      return;
    }
    const count = (status) => team.requests.filter((item) => item.status === status).length;
    drawerBody.innerHTML = `<div class="request-counts">
        <span><strong>${count("waiting")}</strong>waiting</span>
        <span><strong>${count("approved")}</strong>approved</span>
        <span><strong>${count("changes") + count("rejected")}</strong>sent back</span>
      </div>
      <details class="approval-composer" id="requestComposer">
        <summary>${clipboardIcon} Ask for approval of this plan</summary>
        <form id="requestForm" class="feature-form">
          <label>Title<input name="title" required maxlength="140"></label>
          <div class="feature-form-grid"><label>Send to<input name="recipient" required maxlength="100" placeholder="Review team"></label><label>Priority<select name="priority"><option>Normal</option><option>High</option><option>Low</option></select></label></div>
          <label>Due date<input type="date" lang="en" dir="ltr" name="due"></label><label>Note<textarea name="note" rows="3" maxlength="1000"></textarea></label>
          <label class="feature-checkbox"><input type="checkbox" name="attach" ${currentProposalContext ? "checked" : "disabled"}>Attach the current plan</label>
          <p class="feature-muted" id="requestStatus" role="status"></p><button class="feature-primary" type="submit">Create request</button>
        </form>
      </details>
      <div class="approval-filters" role="group" aria-label="Request status">
        ${["Waiting","Done","All"].map((label) => `<button type="button" data-approval-filter="${label.toLowerCase()}">${label}</button>`).join("")}
      </div>
      <div class="feature-stack" id="approvalList"></div>`;
    renderApprovalList();
  }

  function renderApprovalList() {
    $$(".approval-filters button").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.approvalFilter === approvalFilter)));
    const visible = team.requests.filter((item) => approvalFilter === "all" || (item.status === "waiting") === (approvalFilter === "waiting"));
    $("#approvalList").innerHTML = visible.map(renderApprovalCard).join("") || '<p class="feature-muted">No requests in this view.</p>';
  }

  function openTeam(tab) {
    if (tab === "messages" || tab === "stats") {
      selectPage(tab === "messages" ? "messagesView" : "statsView");
      return;
    }
    teamTab = tab;
    renderTeamDrawer();
    if (!teamDrawer.open) teamDrawer.showModal();
  }

  drawerBody.addEventListener("submit", (event)=>{
    if (event.target.id !== "requestForm") return;
    event.preventDefault();
    const fields = new FormData(event.target);
    const title = fields.get("title").trim();
    const recipient = fields.get("recipient").trim();
    if (!title || !recipient) { $("#requestStatus").textContent = "Enter a title and recipient."; return; }
    const attached = fields.has("attach") && currentProposalContext ? planSnapshot() : null;
    team.requests.unshift({id:makeId(), title, recipient, from:senderName, createdAt:new Date().toISOString(), priority:fields.get("priority"), due:fields.get("due"), note:fields.get("note").trim(), plan:attached, status:"waiting"});
    addNotification("Approval requested · " + title);
    persist("Approval request saved.");
    approvalFilter = "waiting";
    renderTeamDrawer();
    $(".approval-filters [aria-pressed=true]").focus();
  });

  drawerBody.addEventListener("click", (event)=>{
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "readAllNotifications") {
      team.notifications.forEach((item)=>{item.unread=false;});
      persist();
      renderTeamDrawer();
      return;
    }
    if (button.dataset.approvalFilter) {
      approvalFilter = button.dataset.approvalFilter;
      renderApprovalList();
      return;
    }
    const item = team.requests.find((row)=>row.id === button.closest("[data-request-id]")?.dataset.requestId);
    const action = button.dataset.requestAction;
    if (!item || !action) return;
    if (action === "open") {
      try {
        restorePlan(item.plan);
        teamDrawer.close();
        selectPlanMode("focus");
        toast("Attached plan opened.");
      } catch (error) {
        const card = button.closest(".request-card");
        let status = card.querySelector("[role=status]");
        if (!status) {
          status = document.createElement("p");
          status.setAttribute("role", "status");
          status.className = "feature-muted";
          card.append(status);
        }
        status.textContent = error.message;
      }
      return;
    }
    item.status = action;
    addNotification(requestStates[action] + " · " + item.title);
    persist("Request updated · " + requestStates[action] + ".");
    renderTeamDrawer();
    const card = $$(".request-card").find((row) => row.dataset.requestId === item.id);
    (card?.querySelector("button") || $(".approval-filters [aria-pressed=true]"))?.focus();
  });

  function messageParties(item) {
    return {
      from:item.folder === "inbox" ? contactName(item.from) || "Unknown sender" : item.from || senderName,
      to:item.folder === "inbox" ? "You" : (item.recipients || []).map(contactName).join(", ") || "No recipient yet",
    };
  }

  function renderMessages() {
    const search = $("#messageSearch").value.trim().toLowerCase();
    const shown = team.messages.filter((item) => {
      if (item.folder !== folder || (priorityFilter && item.priority !== priorityFilter)) return false;
      const {from, to} = messageParties(item);
      const translated = item.example ? [translateUiString(item.subject), translateUiString(item.body || "")] : [];
      return [item.subject, item.body, item.from, from, to, ...translated].join(" ").toLowerCase().includes(search);
    });
    const selected = shown.find((item) => item.id === selectedMessageId) || shown[0];
    selectedMessageId = selected?.id || "";
    $("#messageList").innerHTML = shown.map((item) => {
      const {from, to} = messageParties(item);
      const party = item.folder === "inbox" ? from : to;
      const timestamp = relativeTime(item.createdAt);
      return `<button type="button" class="message-preview${item.unread ? " unread" : ""}" data-message-select="${esc(item.id)}" aria-pressed="${item === selected}">
        <span class="message-preview-top"><span class="mail-dot ${priorityClass(item.priority)}" title="${esc(item.priority)} priority"></span>
          <strong class="message-ellipsis">${esc(party)}</strong>${timestamp ? `<time datetime="${esc(item.createdAt)}">${esc(timestamp)}</time>` : ""}</span>
        <span class="message-preview-subject"><strong class="message-ellipsis" ${item.example ? "" : "data-i18n-ignore"} dir="auto">${esc(item.subject)}</strong>${item.attachments?.length ? `<span title="Has attachments">${paperclipIcon}</span>` : ""}</span>
        <span class="message-ellipsis message-snippet" ${item.example ? "" : "data-i18n-ignore"} dir="auto">${esc(item.example ? (item.body || "") : (item.body || "").replace(/\s+/g, " ").trim())}</span>
        ${item.unread ? '<span class="feature-sr">Unread</span>' : ""}
      </button>`;
    }).join("") || '<p class="feature-muted">No messages match this view.</p>';
    $("#messageReader").innerHTML = selected ? renderMessageReader(selected) : '<p class="feature-muted">Messages you select will appear here.</p>';
  }

  function renderMessageReader(item) {
    const {from, to} = messageParties(item);
    const timestamp = Date.parse(item.createdAt);
    return `<article data-message-id="${esc(item.id)}">
      <div class="mail-tags"><span class="priority-tag ${priorityClass(item.priority)}">${esc(item.priority)} priority</span>${item.example ? exampleBadge : ""}</div>
      <h2 ${item.example ? "" : "data-i18n-ignore"} dir="auto">${esc(item.subject)}</h2>
      <p class="message-parties"><bdi>${esc(from)}</bdi><span class="i18n-arrow" aria-hidden="true">→</span><bdi>${esc(to)}</bdi>${Number.isFinite(timestamp) ? " · " + esc(fullDate.format(timestamp)) : ""}</p>
      <p class="message-body" ${item.example ? "" : "data-i18n-ignore"} dir="auto">${esc(item.body || "")}</p>
      ${item.example && item.id === "example-mail-data" ? '<button type="button" class="text-action" data-evidence="validation">Open historical validation results →</button>' : ""}
      ${item.attachments?.length ? `<ul class="message-attachments" aria-label="Attachments">${item.attachments.map((file) =>
        `<li>${paperclipIcon}<span data-i18n-ignore dir="auto">${esc(file.url || file.name)}</span>${file.url ? "" : `<small>${esc(attachmentSize(file.size))}</small>`}</li>`).join("")}</ul>` : ""}
      <div class="feature-button-row">
        ${item.folder === "drafts" ? '<button class="feature-primary" type="button" data-message-action="edit">Edit draft</button>'
        : '<button class="feature-primary" type="button" data-message-action="reply">Reply</button><button type="button" data-message-action="forward">Forward</button><button type="button" data-message-action="task">Make it a task</button>'}
        <button type="button" data-message-action="delete">Delete</button>
      </div>
    </article>`;
  }

  function markMessageRead(item) {
    selectedMessageId = item.id;
    if (!item.unread) return;
    item.unread = false;
    persist();
  }

  const field = (name) => messageForm.elements.namedItem(name);
  const recipients = () => [...messageForm.querySelectorAll('[name="recipient"]:checked')].map((input)=>input.value);
  const attachmentSize = (bytes) => bytes < 1000 ? bytes + " B" : formatNumber(bytes / 1000) + " KB";
  const attachmentLabel = (attachment) => attachment.url || (attachment.name + " · " + attachmentSize(attachment.size));
  function renderAttachments() {
    $("#attachmentList").innerHTML = attachments.map((file,index)=>`<li>${esc(attachmentLabel(file))} <button type="button" data-attachment-index="${index}" aria-label="Remove ${esc(attachmentLabel(file))}">Remove</button></li>`).join("");
  }

  function openCompose(item = {}, edit = false) {
    draftId = edit ? item.id : "";
    messageForm.reset();
    field("subject").value = item.subject || "";
    field("body").value = item.body || "";
    field("priority").value = item.priority || "Normal";
    field("tone").value = item.tone || "Professional";
    messageForm.querySelectorAll('[name="recipient"]').forEach((input)=>{input.checked = (item.recipients || []).includes(input.value);});
    attachments = [...(item.attachments || [])];
    renderAttachments();
    $("#composeStatus").textContent = "";
    if (teamDrawer.open) teamDrawer.close();
    if (!compose.open) compose.showModal();
    (edit ? field("body") : field("subject")).focus();
  }

  function saveMessage(destination) {
    const subject = field("subject").value.trim();
    const to = recipients();
    if (destination === "sent" && (!subject || !to.length)) {
      $("#composeStatus").textContent = "Choose at least one recipient and enter a subject.";
      return;
    }
    const priorDraft = team.messages.find((row) => row.id === draftId);
    const item = {id:draftId || makeId(), folder:destination, subject:subject || "Untitled draft", recipients:to,
      from:senderName, createdAt:(destination === "drafts" && priorDraft?.createdAt) || new Date().toISOString(),
      priority:field("priority").value, tone:field("tone").value, body:field("body").value.trim(), attachments, unread:false};
    team.messages = [item,...team.messages.filter((row)=>row.id !== item.id)];
    if (destination === "sent") addNotification("Message saved in Sent · " + item.subject);
    persist(destination === "sent" ? "Message saved in Sent on this browser." : "Draft saved.");
    compose.close();
    folder = destination;
    selectedMessageId = item.id;
    priorityFilter = "";
    $("#messageSearch").value = "";
    updateMessageFolder();
  }

  function updateMessageFolder() {
    $$(".mailbox-nav [data-folder]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.folder === folder)));
    $$(".mailbox-nav [data-mail-priority]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mailPriority === priorityFilter)));
    renderMessages();
  }

  $("#recipientChips").innerHTML = directory.map(({name,email})=>`<label title="${esc(email)}"><input type="checkbox" name="recipient" value="${esc(email)}">${esc(name)}</label>`).join("");
  $("#composeMessage").addEventListener("click",()=>openCompose());
  messageForm.addEventListener("submit",(event)=>{event.preventDefault();saveMessage("sent");});
  $("#saveMessageDraft").addEventListener("click",()=>saveMessage("drafts"));
  $("#draftAssist").addEventListener("click",()=>{
    const subject = field("subject").value.trim();
    if (!subject) { $("#composeStatus").textContent = t("draft_subject_required"); field("subject").focus(); return; }
    const context = currentProposalContext;
    const tone = field("tone").value;
    const greeting = t(tone === "Friendly" ? "draft_greeting_friendly" : tone === "Direct" ? "draft_greeting_direct" : "draft_greeting");
    const ask = t(tone === "Friendly" ? "draft_ask_friendly" : tone === "Direct" ? "draft_ask_direct" : "draft_ask");
    const summary = context ? t("draft_plan_summary", {
      country: context.result.route.origin,
      month: data.months[context.inputs.month - 1],
      checkins: formatSigned(context.result.delta.hotelCheckins),
      nights: formatSigned(context.result.delta.guestNights),
    }) : t("draft_plan_unavailable");
    const paragraphs = [greeting, subject, summary, ask];
    if (tone !== "Direct") paragraphs.push(t("draft_signoff"));
    const body = field("body");
    body.value = [body.value.trim(), ...paragraphs].filter(Boolean).join("\n\n").slice(0, 4000);
    $("#composeStatus").textContent = t("draft_ready");
  });

  const gemini = window.__AIR2STAY_LOCAL_GEMINI_DRAFTS__;
  if (gemini) {
    const geminiButton = $("#geminiDraft");
    const status = $("#composeStatus");
    let pending = null;
    geminiButton.hidden = false;
    $("#geminiDraftNote").hidden = false;
    compose.addEventListener("close", () => pending?.abort());
    geminiButton.addEventListener("click", async () => {
      const subjectField = field("subject");
      const subject = subjectField.value.trim();
      if (!subject) {
        status.textContent = t("draft_subject_required");
        subjectField.focus();
        return;
      }
      const body = field("body");
      const startingBody = body.value;
      const request = new AbortController();
      pending = request;
      geminiButton.disabled = true;
      status.textContent = t("drafting_with_gemini");
      try {
        const response = await fetch(gemini.url, {
          method: "POST",
          headers: {"Content-Type": "application/json", "X-Air2Stay-Token": gemini.token},
          body: JSON.stringify({subject, language: uiLanguage}),
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(45000)]),
        });
        const payload = await response.json();
        const draft = payload.answer?.trim();
        if (!response.ok || !draft) throw new Error(payload.error || "Gemini did not return a draft.");
        if (request.signal.aborted || !compose.open) return;
        if (startingBody !== body.value || subjectField.value.trim() !== subject) {
          status.textContent = "Your message changed while Gemini was working. Your edits are still here.";
          return;
        }
        body.value = [startingBody.trim(), draft].filter(Boolean).join("\n\n").slice(0, 4000);
        status.textContent = t("gemini_draft_ready");
        body.focus();
      } catch (error) {
        if (!request.signal.aborted && compose.open) {
          status.textContent = error instanceof TypeError || error.name === "TimeoutError"
            ? "Could not reach Gemini. AI Assist can still draft offline."
            : error.message;
        }
      } finally {
        pending = null;
        geminiButton.disabled = false;
      }
    });
  }

  function addFiles(files) {
    const additions = [...files].map((file)=>({name:file.name.slice(0,200),size:file.size}));
    if (attachments.length + additions.length > 20) $("#composeStatus").textContent = "A message can include up to 20 attachments.";
    attachments = [...attachments,...additions].slice(0,20);
    renderAttachments();
  }
  $("#attachmentFiles").addEventListener("change",(event)=>{addFiles(event.target.files);event.target.value="";});
  const dropZone = $("#attachmentDrop");
  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  dropZone.addEventListener("dragleave", (event) => {
    if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove("is-dragging");
  });
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    addFiles(event.dataTransfer.files);
  });
  $("#addAttachmentUrl").addEventListener("click",()=>{
    const input = $("#attachmentUrl");
    try {
      const url = new URL(input.value);
      if (!["https:","http:"].includes(url.protocol) || attachments.length >= 20 || input.value.length > 400) throw Error();
      if (!attachments.some((attachment) => attachment.url === url.href)) attachments.push({url:url.href});
      input.value = "";
      $("#composeStatus").textContent = "";
      renderAttachments();
    } catch { $("#composeStatus").textContent = "Use a short http or https link. A message can include up to 20 attachments."; }
  });
  $("#attachmentList").addEventListener("click",(event)=>{
    const button = event.target.closest("[data-attachment-index]");
    if (!button) return;
    attachments.splice(Number(button.dataset.attachmentIndex),1);
    renderAttachments();
  });

  $("#messageSearch").addEventListener("input", renderMessages);
  $("#messageList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-message-select]");
    const item = team.messages.find((row) => row.id === button?.dataset.messageSelect);
    if (!item) return;
    markMessageRead(item);
    button.classList.remove("unread");
    button.querySelector(".feature-sr")?.remove();
    $$("#messageList [data-message-select]").forEach((preview) => preview.setAttribute("aria-pressed", String(preview === button)));
    $("#messageReader").innerHTML = renderMessageReader(item);
  });
  $("#messageReader").addEventListener("click",(event)=>{
    const action = event.target.closest("[data-message-action]")?.dataset.messageAction;
    const item = team.messages.find((row)=>row.id === event.target.closest("[data-message-id]")?.dataset.messageId);
    if (!action || !item) return;
    if (action === "edit") openCompose(item,true);
    if (action === "reply") openCompose({subject:t("message_reply_prefix") + (item.example ? translateUiString(item.subject) : item.subject), recipients:item.folder === "inbox" ? [item.from] : item.recipients, priority:item.priority});
    if (action === "forward") openCompose({subject:t("message_forward_prefix") + (item.example ? translateUiString(item.subject) : item.subject), body:item.example ? translateUiString(item.body || "") : item.body, attachments:item.attachments, priority:item.priority});
    if (action === "delete") {
      team.messages = team.messages.filter((row)=>row.id !== item.id);
      persist("Message deleted.");
      renderMessages();
    }
    if (action === "task") {
      team.requests.unshift({id:makeId(), title:item.subject, from:messageParties(item).from, recipient:senderName,
        priority:item.priority, note:item.body, status:"waiting", createdAt:new Date().toISOString()});
      approvalFilter = "waiting";
      addNotification("Task created · " + item.subject);
      persist("Task created from this message.");
      openTeam("tasks");
    }
  });

  document.addEventListener("click",(event)=>{
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.teamOpen === "tasks") approvalFilter = "waiting";
    if (button.dataset.teamOpen || button.dataset.teamTab) openTeam(button.dataset.teamOpen || button.dataset.teamTab);
    if (button.dataset.folder) { folder = button.dataset.folder; updateMessageFolder(); }
    if (button.hasAttribute("data-mail-priority")) { priorityFilter = button.dataset.mailPriority; updateMessageFolder(); }
    if (button.dataset.view === "messagesView") renderMessages();
  });

  function openMessage(id) {
    const item = team.messages.find(row => row.id === id);
    if (!item) return;
    markMessageRead(item);
    folder = item.folder;
    priorityFilter = "";
    $("#messageSearch").value = "";
    selectPage("messagesView");
    updateMessageFolder();
    const preview = $$("#messageList [data-message-select]").find((row) => row.dataset.messageSelect === id);
    reveal(preview);
    preview?.focus({preventScroll:true});
  }

  function openRequest(id) {
    approvalFilter = "all";
    openTeam("tasks");
    const card = $$(".request-card").find((row) => row.dataset.requestId === id);
    reveal(card);
    card?.querySelector("button")?.focus({preventScroll:true});
  }

  setupTeamDock();
  setupPackSearch({getMessages: () => team.messages, getRequests: () => team.requests, openMessage, openRequest});
  setupPackStatistics();
  renderBadges();
}


const I18N = (() => {
  const labels = {
    ar_subject_title_country_month_1: ["Subject: {title} — {country}, {month}", "الموضوع: {title} — {country}، {month}"],
    ar_airline_planning_inquiry_2: ["Airline planning inquiry", "استفسار عن تخطيط الرحلات"],
    ar_hotel_capacity_inquiry_3: ["Hotel capacity inquiry", "استفسار عن السعة الفندقية"],
    ar_team_proposal_update_4: ["Team proposal update", "تحديث المقترح للفريق"],
    ar_we_are_reviewing_the_proposed_route_fr_5: ["We are reviewing the proposed route from {country} to Abu Dhabi for {month}.", "نراجع المسار المقترح من {country} إلى أبوظبي في {month}."],
    ar_the_current_plan_estimates_a_change_of_6: ["The current plan estimates a change of {value} guest nights versus the historical-baseline estimate.", "تقدّر الخطة الحالية تغيّرًا بمقدار {value} ليلة للنزلاء مقارنةً بالتقدير المرجعي التاريخي."],
    ar_this_isolates_the_flight_change_versus_7: ["This isolates the flight change versus zero extra flights using the same visitor assumptions.", "يعزل هذا الحساب أثر تعديل الرحلات مقارنةً بصفر رحلة إضافية مع استخدام افتراضات الزوار نفسها."],
    ar_this_compares_the_current_plan_with_it_8: ["This compares the current plan with its estimated historical baseline.", "تقارن النتيجة الخطة الحالية بتقديرها المرجعي التاريخي."],
    ar_this_is_a_planning_estimate_not_confir_9: ["This is a planning estimate, not confirmed demand.", "هذه نتيجة تقديرية للتخطيط."],
    ar_guest_nights_count_people_staying_over_10: ["Guest nights count people staying overnight, not occupied rooms.", "تحسب ليالي النزلاء الليالي التي يقضيها الأشخاص في الإقامة."],
    ar_please_help_confirm_the_proposed_sched_11: ["Please help confirm the proposed schedule and aircraft capacity, expected bookings and flight occupancy, and the proportion ending their journey in Abu Dhabi.", "نرجو تأكيد الجدول المقترح وسعة الطائرة والحجوزات والإشغال المتوقعين ونسبة من ينهون رحلتهم في أبوظبي."],
    ar_please_distinguish_visitors_from_resid_12: ["Please distinguish visitors from residents returning home, state the source/date, and highlight any constraints.", "يرجى التمييز بين الزوار والمقيمين العائدين، وذكر المصدر والتاريخ وأي قيود."],
    ar_please_help_confirm_expected_hotel_use_13: ["Please help confirm expected hotel use, typical stay length, available hotel capacity and existing occupancy for this month.", "نرجو تأكيد نسبة الإقامة في الفنادق ومدتها المعتادة والسعة المتاحة والإشغال لهذا الشهر."],
    ar_please_include_guests_per_occupied_roo_14: ["Please include guests per occupied room before translating guest nights into room needs, and state the source/date.", "يرجى ذكر عدد النزلاء في الغرفة المشغولة قبل تحويل ليالي النزلاء إلى احتياجات من الغرف، مع ذكر المصدر والتاريخ."],
    ar_please_review_these_assumptions_and_ag_15: ["Please review these assumptions and agree which checks must be completed before advancing the proposal.", "يرجى مراجعة الافتراضات والاتفاق على ما يجب التحقق منه قبل المضي في المقترح."],
    ar_assumptions_to_review_16: ["Assumptions to review", "الافتراضات المطلوب مراجعتها"],
    ar_the_baseline_is_an_estimate_based_on_p_17: ["The baseline is an estimate based on past flight records, not directly observed hotel outcomes for this route.", "التقدير المرجعي مبني على سجلات الرحلات السابقة، ولا يستند إلى نتائج فندقية مرصودة لهذا المسار."],
    ar_there_are_no_past_flight_records_for_t_18: ["There are no past flight records for this route; comparison markets are a starting point only.", "لا توجد سجلات رحلات سابقة لهذا المسار. تُستخدم أسواق المقارنة نقطة انطلاق فقط."],
    ar_check_in_focus_check_19: ["Check in focus: {check}", "بند التحقق الحالي: {check}"],
    ar_suggested_contact_contact_20: ["Suggested contact: {contact}", "جهة الاتصال المقترحة: {contact}"],
    ar_suggested_contact_21: ["Suggested contact", "جهة الاتصال المقترحة"],
    ar_awaiting_response_22: ["Awaiting response", "بانتظار الرد"],
    ar_no_tasks_yet_23: ["No tasks yet.", "لا توجد مهام بعد."],
    ar_no_draft_to_copy_24: ["No draft to copy.", "لا توجد مسودة للنسخ."],
    ar_task_added_25: ["Task added.", "أُضيفت المهمة."],
    ar_task_saved_26: ["Task saved.", "حُفظت المهمة."],
    ar_saved_for_this_plan_27: ["Saved for this plan.", "حُفظت التغييرات لهذه الخطة."],
    ar_that_saved_version_is_unavailable_28: ["That saved version is unavailable.", "هذه النسخة المحفوظة غير متاحة."],
    ar_loading_a_saved_version_is_unavailable_29: ["Loading a saved version is unavailable in this app.", "لا يمكن تحميل نسخة محفوظة في هذا التطبيق."],
    ar_new_country_confirmed_30: ["New country confirmed", "تأكّد بلد المغادرة الجديد"],
    ar_help_searched_31: ["Help searched", "بُحث في المساعدة"],
    ar_help_answer_opened_32: ["Help answer opened", "فُتحت إجابة من المساعدة"],
    ar_reference_document_opened_33: ["Reference document opened", "فُتح مستند مرجعي"],
    ar_feedback_submitted_34: ["Feedback submitted", "أُرسلت الملاحظات"],
    ar_first_plan_guide_started_35: ["First plan guide started", "بدأت جولة الخطة الأولى"],
    ar_first_plan_guide_completed_36: ["First plan guide completed", "اكتملت جولة الخطة الأولى"],
    ar_first_plan_guide_exited_early_37: ["First plan guide exited early", "انتهت جولة الخطة الأولى مبكرًا"],
    ar_new_route_guide_started_38: ["New route guide started", "بدأت جولة المسار الجديد"],
    ar_new_route_guide_completed_39: ["New route guide completed", "اكتملت جولة المسار الجديد"],
    ar_new_route_guide_exited_early_40: ["New route guide exited early", "انتهت جولة المسار الجديد مبكرًا"],
    ar_results_guide_started_41: ["Results guide started", "بدأت جولة النتائج"],
    ar_results_guide_completed_42: ["Results guide completed", "اكتملت جولة النتائج"],
    ar_results_guide_exited_early_43: ["Results guide exited early", "انتهت جولة النتائج مبكرًا"],
    ar_comparison_guide_started_44: ["Comparison guide started", "بدأت جولة المقارنة"],
    ar_comparison_guide_completed_45: ["Comparison guide completed", "اكتملت جولة المقارنة"],
    ar_comparison_guide_exited_early_46: ["Comparison guide exited early", "انتهت جولة المقارنة مبكرًا"],
    ar_proposal_actions_guide_started_47: ["Proposal actions guide started", "بدأت جولة متابعة المقترح"],
    ar_proposal_actions_guide_completed_48: ["Proposal actions guide completed", "اكتملت جولة متابعة المقترح"],
    ar_proposal_actions_guide_exited_early_49: ["Proposal actions guide exited early", "انتهت جولة متابعة المقترح مبكرًا"],
    ar_no_past_flight_records_for_this_route_50: ["No past flight records for this route.", "لا توجد سجلات رحلات سابقة لهذا المسار."],
    ar_the_weighted_comparison_country_blend_51: ["The weighted comparison-country blend", "المتوسط المرجّح لدول المقارنة"],
    ar_weighted_comparison_countries_52: ["weighted comparison countries", "دول المقارنة المرجّحة"],
    ar_no_historical_schedule_for_this_new_ro_53: ["No historical schedule for this new route. Use the proposed extra flights above; the comparison blend does not borrow a schedule.", "لا يوجد جدول تاريخي لهذا المسار الجديد. استخدم الرحلات الإضافية المقترحة أعلاه، فدول المقارنة لا توفّر جدولًا لهذا المسار."],
    ar_flight_occupancy_must_be_between_30_an_54: ["Flight occupancy must be between 30% and 100%.", "يجب أن تكون نسبة إشغال الرحلات بين 30% و100%."],
    ar_passengers_ending_their_trip_in_abu_dh_55: ["Passengers ending their trip in Abu Dhabi must be between 5% and 100%.", "يجب أن تكون نسبة الركاب الذين ينهون رحلتهم في أبوظبي بين 5% و100%."],
    ar_hotel_use_must_be_between_5_and_90_56: ["Hotel use must be between 5% and 90%.", "يجب أن تكون نسبة الإقامة في الفنادق بين 5% و90%."],
    ar_average_stay_must_be_between_1_and_10__57: ["Average stay must be between 1 and 10 nights.", "يجب أن يكون متوسط الإقامة بين 1 و10 ليالٍ."],
    ar_extra_event_demand_must_be_between_0_a_58: ["Extra event demand must be between 0% and 50%.", "يجب أن تكون زيادة الطلب بسبب الفعالية بين 0% و50%."],
    ar_use_between_20_fewer_and_20_extra_flig_59: ["Use between 20 fewer and 20 extra flights each week.", "اختر تغييرًا بين خفض 20 رحلة وإضافة 20 رحلة أسبوعيًا."],
    ar_use_between_30_and_600_seats_per_fligh_60: ["Use between 30 and 600 seats per flight.", "اختر من 30 إلى 600 مقعد لكل رحلة."],
    ar_could_not_load_the_model_or_country_lo_61: ["Could not load the model or country-location data.", "تعذّر تحميل بيانات النموذج أو مواقع البلدان."],
    ar_browser_storage_is_unavailable_changes_62: ["Browser storage is unavailable. Changes last for this visit only.", "تخزين المتصفح غير متاح. تستمر التغييرات خلال هذه الزيارة فقط."],
    message_reply_prefix: ["Re: ", "رد: "],
    message_forward_prefix: ["Fwd: ", "إعادة توجيه: "],
    comparison_shared_inputs_tooltip: ["Use the same inputs to isolate the effect of added capacity. Identical inputs may give identical added-seat effects.", "استخدم المدخلات نفسها لعزل أثر السعة الإضافية. قد تؤدي المدخلات المتطابقة إلى الأثر نفسه لكل مقعد إضافي."],
    guide_progress_count: ["{count} of {total}", "{count} من {total}"],
    guide_feedback_label: ["Feedback on {label}", "ملاحظات حول {label}"],
    guided_walkthrough: ["Air2Stay guided walkthrough", "جولة Air2Stay الإرشادية"],
    confirm_flight_demand: ["Confirm the flight demand", "أكّد الطلب المتوقع على الرحلات"],
    check_hotel_capacity: ["Check hotel use and capacity", "تحقّق من استخدام الفنادق وسعتها"],
    review_visitor_mix: ["Review the visitor mix", "راجع توزيع الزوار"],
    approve_request_status: ["Request updated · {status}.", "حُدّث الطلب · {status}."],
    choose_country_suggestions: ["Choose a country from the suggestions so the map can find its location.", "اختر بلدًا من الاقتراحات حتى تتمكّن الخريطة من تحديد موقعه."],
    invalid_plan_number: ["The shared plan contains an invalid number.", "تحتوي الخطة المشتركة على رقم غير صالح."],
    invalid_plan_country: ["The plan country is not recognised.", "بلد الخطة غير معروف."],
    invalid_plan_month: ["The plan month is invalid.", "شهر الخطة غير صالح."],
    invalid_plan_file: ["This plan file has an unsupported format.", "صيغة ملف الخطة غير مدعومة."],
    invalid_plan_mix: ["The plan visitor mix is invalid.", "توزيع الزوار في الخطة غير صالح."],
    invalid_plan_comparison: ["Choose a supported comparison country.", "اختر بلد مقارنة مدعومًا."],
    missing_comparison_assumptions: ["Comparison-country assumptions are unavailable.", "افتراضات دول المقارنة غير متاحة."],
    invalid_plan_share_total: ["The visitor shares must add up to more than zero.", "يجب أن يكون مجموع حصص الزوار أكبر من صفر."],
    shared_plan_error: ["Could not open the shared plan: {reason}", "تعذّر فتح الخطة المشتركة: {reason}"],
    draft_feedback: ["Email draft ready to review.", "مسودة البريد جاهزة للمراجعة."],
    draft_copied: ["Draft copied. Nothing was sent.", "نُسخت المسودة. لم تُرسل أي رسالة."],
    no_saved_notes: ["No notes yet.", "لا توجد ملاحظات بعد."],
    tour_no_matches: ["No matching help answers.", "لا توجد إجابات مساعدة مطابقة."],
    guide_country_search_hint: ["Try: new route, hotel nights or accuracy", "جرّب: مسار جديد أو ليالي الفنادق أو الدقة"],
    unnamed_country: ["Unspecified country", "بلد غير محدّد"],
    holiday_purpose_check: ["Check hotel use and stay length with tourism and hotel records.", "تحقّق من الإقامة الفندقية ومدتها بالرجوع إلى سجلات السياحة والفنادق."],
    business_purpose_check: ["Check business travel patterns and typical stay length.", "تحقّق من أنماط سفر الأعمال والمدة المعتادة للإقامة."],
    family_purpose_check: ["Check how many visitors stay with family rather than in hotels.", "تحقّق من عدد الزوار الذين يقيمون مع أسرهم بدلًا من الفنادق."],
    export_report_ready: ["Excel report ready.", "تقرير Excel جاهز."],
    export_file_link: ["Your file is ready. If the download did not begin, choose:", "ملفك جاهز. إذا لم يبدأ التنزيل، اختر:"],
    export_failed: ["The report could not be prepared. Check the plan and try again.", "تعذّر إعداد التقرير. تحقّق من الخطة وحاول مجددًا."],
    export_confirm_new_country: ["Confirm a new departure country first.", "أكّد بلد المغادرة الجديد أولًا."],
    export_correct_input: ["Correct the highlighted input first.", "صحّح الحقل المحدّد أولًا."],
    export_save_pdf: ["Choose Save as PDF in the print window.", "اختر «حفظ بصيغة PDF» في نافذة الطباعة."],
    report_brand: ["Air2Stay · Plan report", "Air2Stay · تقرير الخطة"],
    report_title: ["Air2Stay plan: {country} → Abu Dhabi, {month}", "خطة Air2Stay: {country} إلى أبوظبي، {month}"],
    report_overview_caption: ["Your plan and its change from usual", "خطتك والتغيّر عن المعتاد"],
    report_month_chart_caption: ["Same plan inputs each month. The dotted line marks {month} ({usual} usual, {planned} planned).", "تُستخدم مدخلات الخطة نفسها لكل شهر. يشير الخط المنقّط إلى {month} ({usual} في المعتاد، و{planned} في الخطة)."],
    report_visitor_caption: ["Plan guest nights and change from usual", "ليالي النزلاء في الخطة والتغيّر عن المعتاد"],
    report_assumptions_note: ["Event impact is a user estimate of the effect on hotel demand.", "أثر الفعالية تقدير يدخله المستخدم لتأثيرها على الطلب الفندقي."],
    report_trial_caption: ["Extra guest nights from flight changes at the trial assumptions", "ليالي النزلاء الإضافية الناتجة عن تعديل الرحلات وفق افتراضات الاختبار"],
    report_limits: ["Notes and limits", "ملاحظات وحدود التقدير"],
    report_diff: ["Difference from plan", "الفرق عن الخطة"],
    report_changed: ["Changed?", "هل تغيّرت القيمة؟"],
    report_start: ["Starting value", "القيمة الأولية"],
    report_extra_nights_target: ["Plan for about {value} extra guest nights in {month} under the selected assumptions.", "خطّط لنحو {value} ليلة إضافية للنزلاء في {month} وفق الافتراضات المختارة."],
    report_reduced_nights_target: ["The flight reduction implies about {value} fewer guest nights in {month} under the selected assumptions.", "يؤدي خفض الرحلات إلى نحو {value} ليلة أقل للنزلاء في {month} وفق الافتراضات المختارة."],
    report_no_added_nights: ["No added guest nights are estimated because this plan adds no flight capacity.", "لا تُقدّر ليالٍ إضافية للنزلاء لأن الخطة لا تضيف سعة للرحلات."],
    report_lower_trial: ["The combined lower-assumption trial gives {value} guest nights from the flight change. This is an illustrative check, not a probability bound.", "يعطي اختبار الخفض المجمّع {value} ليلة للنزلاء نتيجة تعديل الرحلات. هذا اختبار توضيحي ولا يحدّد نطاقًا احتماليًا."],
    report_nights_caution: ["Guest nights count nights spent by people, not rooms. Confirm passenger demand and hotel capacity before committing to the proposal.", "تقيس ليالي النزلاء الليالي التي يقضيها الأشخاص. تحقّق من الطلب على الرحلات وسعة الفنادق قبل اعتماد المقترح."],
    localized_gray_shows_the_baseline_estimate_for_m: ["Gray shows the baseline estimate for {month}. The colored cap marks your plan level. The cards above give the hotel totals and changes.", "يمثّل الرمادي التقدير المرجعي لشهر {month}. ويبيّن الجزء الملوّن مستوى خطتك. وتعرض البطاقات أعلاه الإجماليات الفندقية والتغيّرات."],
    localized_start_by_checking_label_it_had_the_lar: ["Start by checking {label}. It had the largest effect in these trials.", "ابدأ بالتحقق من {label}، فقد كان له الأثر الأكبر في هذه الاختبارات."],
    localized_check_ins: ["check-ins", "التسجيلات الفندقية"],
    localized_flight_fullness: ["flight fullness", "إشغال الرحلة"],
    localized_average_nights_per_hotel_stay: ["average nights per hotel stay", "متوسط الليالي لكل إقامة فندقية"],
    localized_share_checking_into_a_hotel: ["share checking into a hotel", "نسبة من يسجّلون الوصول إلى الفنادق"],
    localized_passengers_ending_in_abu_dhabi: ["passengers ending in abu dhabi", "الركاب الذين ينهون رحلتهم في أبوظبي"],
    localized_how_full_flights_are: ["how full flights are", "إشغال الرحلات"],
    localized_extra_flights_each_week: ["extra flights each week", "الرحلات الإضافية أسبوعيًا"],
    localized_seats_on_each_flight: ["seats on each flight", "المقاعد في كل رحلة"],
    localized_extra_hotel_demand_for_an_event_or_sea: ["extra hotel demand for an event or season", "الطلب الفندقي الإضافي بسبب فعالية أو موسم"],
    localized_undo_change_to_label: ["Undo change to {label}", "التراجع عن تغيير {label}"],
    localized_flight_fullness_the_percentage_of_seat: ["Flight fullness: the percentage of seats expected to have a passenger. This is an assumption you can adjust.", "إشغال الرحلة هو النسبة المتوقّعة للمقاعد التي يشغلها الركاب. يمكنك تعديل هذا الافتراض."],
    localized_label_count_for_your_new_route: ["{label}: {count} for your new route", "{label}: {count} لمسارك الجديد"],
    localized_label_count_usual_plan_in_your_plan_ba: ["{label}: {count} usual, {plan} in your plan ({badge})", "{label}: {count} في المعتاد، و{plan} في خطتك ({badge})"],
    localized_label_count_for_your_new_route_15: ["{label}: {count} for your new route.", "{label}: {count} لمسارك الجديد."],
    localized_label_count_for_a_usual_month_change: ["{label}: {count} for a usual {month}, {change}.", "{label}: {count} في شهر {month} المعتاد، {change}."],
    localized_plus_count_with_your_plan: ["plus {count} with your plan", "زيادة {count} في خطتك"],
    localized_minus_count_with_your_plan: ["minus {count} with your plan", "انخفاض {count} في خطتك"],
    localized_no_change: ["no change", "دون تغيّر"],
    localized_guest_nights_measure_nights_spent_in_h: ["Guest nights measure nights spent in hotels.", "تقيس ليالي النزلاء عدد الليالي المقضاة في الفنادق."],
    localized_share_stay_in_a_hotel_event_uplift_app: ["{share} stay in a hotel · event uplift applied", "{share} يقيمون في فندق · بعد تعديل أثر الفعالية"],
    localized_a_past_seats_b_flight_fullness_c: ["{a} past seats × {b} flight fullness = {c}", "{a} مقعدًا في السجلات السابقة × {b} نسبة الإشغال = {c}"],
    localized_a_b_flight_fullness_c: ["{a} × {b} flight fullness = {c}", "{a} × {b} نسبة إشغال الرحلات = {c}"],
    localized_a_b_ending_trip_share_c: ["{a} × {b} ending-trip share = {c}", "{a} × {b} نسبة من ينهون رحلتهم هنا = {c}"],
    localized_a_b_hotel_use_assumption_c: ["{a} × {b} hotel-use assumption = {c}", "{a} × {b} النسبة المفترضة للإقامة في الفنادق = {c}"],
    localized_a_b_weighted_nights_per_stay_c: ["{a} × {b} weighted nights per stay = {c}", "{a} × {b} المتوسط المرجّح لليالي لكل إقامة = {c}"],
    localized_max_0_a_b_flights_week_c_seats_flight_: ["max(0, {a} + {b} flights/week × {c} seats/flight × {d} weeks) = {e}", "الحد الأعلى من (0، {a} + {b} رحلة أسبوعيًا × {c} مقعدًا لكل رحلة × {d} أسبوعًا) = {e}"],
    localized_a_b_hotel_use_assumption_1_c_event_upl: ["{a} × {b} hotel-use assumption × (1 + {c} event uplift) = {d}", "{a} × {b} النسبة المفترضة للإقامة في الفنادق × (1 + {c} زيادة الطلب بسبب الفعالية) = {d}"],
    localized_a_b_nights_per_stay_c: ["{a} × {b} nights per stay = {c}", "{a} × {b} ليلة لكل إقامة = {c}"],
    localized_weeks_days_in_the_selected_month_7_feb: ["Weeks = days in the selected month ÷ 7; February uses 28.25 days.", "الأسابيع = أيام الشهر المختار ÷ 7. يُستخدم 28.25 يومًا لشهر فبراير."],
    localized_seats_cannot_fall_below_zero: ["Seats cannot fall below zero.", "لا يمكن أن يقل عدد المقاعد عن الصفر."],
    localized_your_flight_reduction_exceeds_the_avai: ["Your flight reduction exceeds the available seats, so seats are limited to zero.", "يؤدي خفض الرحلات إلى تجاوز المقاعد المتاحة، لذا يُضبط عدد المقاعد على صفر."],
    localized_the_event_uplift_is_your_assumption_an: ["The event uplift is your assumption and is applied once to hotel check-ins; guest nights then use those check-ins.", "زيادة الطلب بسبب الفعالية افتراض تطبّقه مرة واحدة على التسجيلات الفندقية، ثم تُحسب ليالي النزلاء منها."],
    localized_lower_guide_a_b_c_nights: ["Lower guide = {a} × {b} = {c} nights.", "الحد الإرشادي الأدنى = {a} × {b} = {c} ليلة."],
    localized_upper_guide_a_b_c_nights: ["Upper guide = {a} × {b} = {c} nights.", "الحد الإرشادي الأعلى = {a} × {b} = {c} ليلة."],
    localized_visitor_group_check_ins_plan_check_ins: ["Visitor-group check-ins = plan check-ins × that group's normalized share.", "التسجيلات الفندقية لفئة الزوار = التسجيلات في الخطة × حصة الفئة بعد ضبط مجموع الحصص."],
    localized_nights_also_use_that_group_s_relative_: ["Nights also use that group's relative stay length, adjusted to match your selected overall average stay.", "يراعي حساب الليالي مدة إقامة الفئة بعد ضبطها لتتوافق مع متوسط الإقامة العام المختار."],
    localized_the_estimated_visitor_shares_are_in_us: ["The estimated visitor shares are in use.", "يُستخدم التوزيع المقدّر للزوار."],
    localized_your_edited_visitor_shares_are_in_use: ["Your edited visitor shares are in use.", "يُستخدم توزيع الزوار الذي عدّلته."],
    localized_group_contributions_add_up_to_the_head: ["Group contributions add up to the headline change; they are not measured nationality-level effects.", "يبلغ مجموع مساهمات الفئات مقدار التغيّر الرئيسي. وهذه المساهمات تقديرات وليست آثارًا مرصودة حسب الجنسية."],
    localized_the_weighted_comparison_country_blend_: ["The weighted comparison-country blend supplies starting assumptions only.", "يوفّر المتوسط المرجّح لدول المقارنة الافتراضات الأولية فقط."],
    localized_country_supplies_starting_assumptions_: ["{country} supplies starting assumptions only.", "تُستخدم بيانات {country} للافتراضات الأولية فقط."],
    localized_the_available_markets: ["The available markets", "الأسواق المتاحة"],
    localized_country_reference_point_to_abu_dhabi_c: ["Country reference point to Abu Dhabi city.", "من نقطة مرجعية في البلد إلى مدينة أبوظبي."],
    localized_schematic_route_not_airport_locations: ["Schematic route, not airport locations.", "المسار توضيحي ولا يمثّل مواقع المطارات."],
    localized_antarctic_outline_is_unavailable_in_th: ["Antarctic outline is unavailable in the supplied map.", "حدود القارة القطبية الجنوبية غير متاحة في الخريطة المرفقة."],
    localized_no_verified_country_location_is_availa: ["No verified country location is available for this route. Choose a country from the departure list to display its map.", "لا يتوفّر موقع جغرافي مؤكّد لهذا المسار. اختر بلدًا من قائمة المغادرة لعرض الخريطة."],
    localized_based_on_past_flight_records_for_count: ["Based on past flight records for {country}. These are starting seat estimates, not future bookings. Focus or hover on a bar for its exact value.", "تستند التقديرات الأولية للمقاعد إلى سجلات الرحلات السابقة في {country}، ولا تمثّل حجوزات مستقبلية. مرّر المؤشر فوق العمود أو حدّده لعرض القيمة الدقيقة."],
    localized_reference_flights_each_week_count: ["Reference flights each week · {count}", "الرحلات المرجعية أسبوعيًا · {count}"],
    localized_no_past_flight_seats_for_this_route_st: ["No past flight seats for this route. Starting assumptions use {source}.", "لا توجد سجلات سابقة للمقاعد على هذا المسار. تستند الافتراضات الأولية إلى {source}."],
    localized_reference_schedule_for_country_only_no: ["Reference schedule for {country} only; not a schedule for the proposed route.", "هذا الجدول المرجعي يخص {country} فقط، ولا يمثّل جدول المسار المقترح."],
    localized_starts_from_source_you_can_change_it: ["Starts from {source}. You can change it.", "تبدأ القيمة من {source} ويمكنك تعديلها."],
    localized_starts_from_source_there_are_no_past_r: ["Starts from {source}. There are no past records for this route.", "تبدأ القيمة من {source}. لا توجد سجلات سابقة لهذا المسار."],
    localized_a_weighted_blend_of_names: ["a weighted blend of {names}", "متوسط مرجّح من {names}"],
    localized_the_selected_comparison_country: ["the selected comparison country", "بلد المقارنة المختار"],
    localized_the_comparison_country: ["the comparison country", "بلد المقارنة"],
    localized_country_specific_hotel_use_rates_requi: ["Country-specific hotel-use rates require linking flight and hotel records.", "يتطلّب تقدير نسب الإقامة الفندقية حسب البلد ربط سجلات الرحلات بسجلات الفنادق."],
    localized_for_month_the_optional_training_season: ["For {month}, the optional training-season aggregate rate is", "النسبة الموسمية الاختيارية المستخلصة من بيانات التدريب لشهر {month} هي"],
    localized_it_uses_three_observations_of_that_cal: [". It uses three observations of that calendar month from {period}. It is not a measured probability for this route.", ". تستند إلى 3 مشاهدات للشهر نفسه خلال {period}، ولا تمثّل احتمالًا مقاسًا لهذا المسار."],
    localized_august_december_have_no_matching_held_: ["August–December have no matching held-out month in this test.", "لا يشمل هذا الاختبار الأشهر من أغسطس إلى ديسمبر."],
    localized_method_and_monthly_starting_rates: ["Method and monthly starting rates", "المنهجية والنسب الشهرية الأولية"],
    localized_optional_hotel_use_assumption: ["Optional hotel-use assumption", "النسبة الاختيارية للإقامة في الفنادق"],
    localized_seasonal_rate_70_of_the_training_month: ["Seasonal rate = 70% of the training month-of-year aggregate hotel-arrivals / P2P ratio + 30% of the overall training aggregate ratio. Ratios use only common months before 2025-01.", "النسبة الموسمية = 70% من نسبة التسجيلات الفندقية إلى الركاب الذين ينهون رحلتهم هنا في شهر التدريب المقابل + 30% من النسبة الإجمالية في بيانات التدريب. تُحسب النسب من الأشهر المشتركة قبل 2025-01 فقط."],
    localized_we_hid_one_known_market_at_a_time_and_: ["We hid one known market at a time and reconstructed its flight assumptions from other markets in the same month: {count} market-month checks across {value} markets.", "استبعدنا كل سوق معروف على حدة وأعدنا تقدير افتراضات رحلاته من أسواق أخرى في الشهر نفسه. شمل الاختبار {count} حالة شهرية في {value} سوقًا."],
    localized_three_market_average_error: ["Three-market average error", "متوسط خطأ المقارنة بثلاثة أسواق"],
    localized_nearest_country_average_error: ["Nearest-country average error", "متوسط خطأ المقارنة بأقرب بلد"],
    localized_value_percentage_points: ["{value} percentage points", "{value} نقطة مئوية"],
    localized_this_checks_seats_per_flight_flight_oc: ["This checks seats per flight, flight occupancy and the share ending their trip in Abu Dhabi only.", "يفحص هذا الاختبار عدد المقاعد لكل رحلة وإشغال الرحلات ونسبة من ينهون رحلتهم في أبوظبي فقط."],
    localized_it_does_not_validate_new_route_demand_: ["It does not validate new-route demand, hotel conversion, visitor nationality shares, hotel arrivals or guest nights.", "ولا يقيس دقة الطلب على المسارات الجديدة أو نسبة الإقامة الفندقية أو توزيع الجنسيات أو التسجيلات الفندقية أو ليالي النزلاء."],
    localized_the_supplied_export_contains_market_mo: ["The supplied export contains market-month aggregates. This is not an independent future-period back-test, and may share years with its comparison records.", "تتضمن البيانات المرفقة إجماليات شهرية حسب السوق. الاختبار لا يستخدم فترة مستقبلية مستقلة، وقد تتداخل سنواته مع سجلات المقارنة."],
    localized_three_market_estimates_can_perform_wor: ["Three-market estimates can perform worse than the nearest single country. Each measured error is reported alongside that baseline.", "قد يكون تقدير الأسواق الثلاثة أقل دقة من المقارنة بأقرب بلد واحد. ويُعرض كل خطأ مقاس إلى جانب ذلك التقدير المرجعي."],
    localized_the_heuristic_and_weights_are_fixed_de: ["The heuristic and weights are fixed design choices. There is no economic, travel-purpose or airport-specific similarity model.", "أسلوب الاختيار والأوزان محدّدة مسبقًا. ولا يستند التشابه إلى نموذج اقتصادي أو غرض السفر أو خصائص المطارات."],
    localized_geography_and_approximate_route_length: ["Geography and approximate route length supply starting assumptions only.", "يُستخدم الموقع الجغرافي وطول المسار التقريبي لتحديد الافتراضات الأولية فقط."],
    localized_country_is_your_chosen_starting_countr: ["{country} is your chosen starting country. This is an assumption, not evidence of demand on the proposed route.", "اخترت {country} مرجعًا أوليًا. هذا افتراض ولا يثبت الطلب على المسار المقترح."],
    localized_country_is_the_closest_place_with_past: ["{country} is the closest place with past flight records. We’ll use its numbers as a rough starting point; it may not behave like {market}.", "إن {country} أقرب بلد تتوفر له سجلات رحلات. تُستخدم أرقامه نقطة بداية تقريبية وقد يختلف عن {market}."],
    localized_country_is_used_as_a_rough_starting_po: ["{country} is used as a rough starting point because we don’t have a location record for this place.", "تُستخدم بيانات {country} مرجعًا تقريبيًا لعدم توفّر سجل جغرافي لهذا المكان."],
    localized_difference_in_extra_guest_nights_from_: ["Difference in extra guest nights from the selected plan", "الفرق في ليالي النزلاء الإضافية عن الخطة المختارة"],
    localized_extra_guest_nights_by_month: ["Extra guest nights by month.", "ليالي النزلاء الإضافية حسب الشهر."],
    localized_if_we_add_this_route_how_many_extra_ho: ["If we add this route, how many extra hotel nights might we need to plan for, what assumption matters most, and what should we verify with airlines or hotels before acting?", "إذا أضفنا هذا المسار، فكم ليلة فندقية إضافية قد نحتاج إلى التخطيط لها؟ وما الافتراض الأكثر تأثيرًا؟ وما الذي ينبغي التحقق منه مع شركات الطيران أو الفنادق قبل اتخاذ القرار؟"],
    localized_label_has_the_largest_effect_in_the_in: ["{label} has the largest effect in the individual lower-assumption trials tested: about {value} guest nights. The trial sizes differ.", "كان لافتراض {label} أكبر أثر في اختبارات الخفض الفردية، بنحو {value} ليلة للنزلاء. وتختلف درجات الخفض بين الاختبارات."],
    localized_how_full_the_flights_are: ["How full the flights are", "إشغال الرحلات"],
    localized_share_of_passengers_ending_their_trip_: ["Share of passengers ending their trip in Abu Dhabi who use a hotel", "نسبة الركاب الذين ينهون رحلتهم في أبوظبي ويقيمون في فندق"],
    localized_the_individual_lower_assumption_trials: ["The individual lower-assumption trials do not change the added-flight result at this setting. There is no leading assumption to report from these trials.", "في الإعداد الحالي، لا تغيّر اختبارات الخفض الفردية نتيجة الرحلات الإضافية. لذلك لا يبرز افتراض واحد من هذه الاختبارات."],
    localized_ask_the_airline_how_many_of_the_arriva: ["Ask the airline how many of the arrivals will be residents returning home.", "اسأل شركة الطيران عن عدد المقيمين العائدين المتوقع بين القادمين."],
    localized_ask_hotels_about_guests_per_occupied_r: ["Ask hotels about guests per occupied room before using guest nights to plan rooms or staffing.", "تحقّق من عدد النزلاء في الغرفة المشغولة قبل استخدام ليالي النزلاء لتخطيط الغرف أو التوظيف."],
    localized_check_the_mix_of_hotel_stays_family_vi: ["Check the mix of hotel stays, family visits and other trips.", "تحقّق من توزيع الإقامات الفندقية والزيارات العائلية والرحلات الأخرى."],
    ranking_stable: ["{label} has the higher estimated yield per added seat under these assumptions. The same option stays ahead in the four lower-assumption trials. This does not establish a real-world best route.", "يحقّق {label} أعلى عائد تقديري لكل مقعد إضافي وفق هذه الافتراضات. ظل الخيار نفسه متقدمًا في اختبارات الخفض الأربعة، ولا تثبت النتيجة أنه أفضل مسار عمليًا."],
    ranking_reversal: ["{label} has the higher estimated yield per added seat under these assumptions. The preference reverses under: {trials}. Check those assumptions before choosing.", "يحقّق {label} أعلى عائد تقديري لكل مقعد إضافي وفق هذه الافتراضات. تتغيّر الأفضلية في الاختبارات الآتية: {trials}. راجع افتراضاتها قبل الاختيار."],
    localized_count_extra_flights_each_week_would_re: ["{count} extra flights each week would reach at least {target} extra guest nights under the selected assumptions (about {value} nights). This is required capacity, not proof of passenger demand.", "تبلغ {count} رحلة إضافية أسبوعيًا هدفًا لا يقل عن {target} ليلة إضافية وفق الافتراضات المختارة، أي نحو {value} ليلة. هذه السعة المطلوبة ولا تثبت الطلب الفعلي."],
    localized_the_target_is_not_reached_within_20_ex: ["The target is not reached within 20 extra flights per week. At that limit the estimate is {value} nights, leaving {shortfall} nights below the target.", "لا يمكن بلوغ الهدف ضمن حد 20 رحلة إضافية أسبوعيًا. يبلغ التقدير عند هذا الحد {value} ليلة، أي أقل من الهدف بمقدار {shortfall} ليلة."],
    localized_estimated_nationality_origins_connecte: ["Estimated nationality origins connected to Abu Dhabi; illustrative country-centroid arcs", "الجنسيات المقدّرة للزوار المرتبطة بأبوظبي بخطوط توضيحية من نقاط مرجعية للبلدان"],
    localized_country_share_country_reference_point: ["{country}: {share} · country reference point", "{country}: {share} · نقطة مرجعية للبلد"],
    localized_share_outside_the_5_largest_nationalit: ["Share outside the 5 largest nationality groups:", "الحصة خارج أكبر 5 فئات حسب الجنسية:"],
    localized_month_series_value: ["{month} · {series}: {value}", "{month} · {series}: {value}"],
    localized_month_value_guest_nights: ["{month}: {value} guest nights", "{month}: {value} ليلة للنزلاء"],
    localized_weighted_error_measures_the_size_of_th: ["Weighted error measures the size of the gap relative to recorded arrivals.", "يقيس الخطأ المرجّح حجم الفجوة مقارنة بعدد التسجيلات الفندقية الفعلية."],
    localized_training_training_traincount_months_ch: ["Training: {training} ({trainCount} months). Check period: {testing} ({testCount} months). The test used recorded flights from the check period.", "التدريب: {training} ({trainCount} شهرًا). فترة الاختبار: {testing} ({testCount} أشهر). استُخدمت سجلات الرحلات الفعلية من فترة الاختبار."],
    localized_live_default_calculation: ["Live default calculation:", "الحساب الافتراضي المباشر:"],
    localized_seats_flight_occupancy_share_ending_in: ["seats × flight occupancy × share ending in Abu Dhabi × a single hotel-use rate learned only from {period}. The check runs this chain on each held-out country-month’s recorded flights, then sums the estimates across countries. It does not test future flight schedules, occupancy forecasts, edited assumptions, visitor shares, or guest nights. Historical route baselines and visitor profiles are descriptive summaries, not independently held-out forecasts.", "المقاعد × نسبة الإشغال × نسبة من ينهون رحلتهم في أبوظبي × نسبة ثابتة للإقامة الفندقية مستخلصة من {period} فقط. يُطبَّق الحساب على الرحلات الفعلية لكل بلد وشهر مستبعَد من التدريب، ثم تُجمع التقديرات عبر البلدان. ولا يختبر جداول الرحلات المستقبلية أو توقعات الإشغال أو الافتراضات المعدّلة أو توزيع الزوار أو ليالي النزلاء. التقديرات المرجعية للمسارات وتوزيع الزوار ملخّصات تاريخية وليست توقعات اختُبرت على بيانات مستقلة."],
    localized_seasonal_comparison: ["Seasonal comparison:", "المقارنة الموسمية:"],
    localized_recorded_passengers_ending_here_70_tra: ["recorded passengers ending here × (70% training month-specific hotel-use rate + 30% overall training rate). Its weighted error is {value}. This is the optional seasonal assumption in Details, not the default.", "عدد الركاب الذين أنهوا رحلتهم هنا وفق السجلات × (70% من نسبة الإقامة الفندقية للشهر المقابل في بيانات التدريب + 30% من النسبة الإجمالية في بيانات التدريب). الخطأ المرجّح {value}. هذا هو الافتراض الموسمي الاختياري في التفاصيل."],
    localized_hybrid_comparison: ["Hybrid comparison:", "المقارنة بالنموذج الهجين:"],
    localized_55_regression_estimate_45_seasonal_fli: ["55% regression estimate + 45% seasonal flight estimate. The route planner does not run this aggregate regression.", "55% من تقدير الانحدار + 45% من التقدير الموسمي المستند إلى الرحلات. لا يستخدم مخطّط المسارات نموذج الانحدار الإجمالي هذا."],
    localized_reproduce_the_scores: ["Reproduce the scores:", "إعادة حساب الدرجات:"],
    localized_add_the_absolute_monthly_mistakes_and_: ["add the absolute monthly mistakes and divide by recorded hotel arrivals (WMAPE). Live default: {live} ÷ {total} × 100. Hybrid comparison: {hybrid} ÷ {actual} × 100. Scores use full-precision predictions; the table and totals round only for readability.", "اجمع القيم المطلقة للأخطاء الشهرية واقسم المجموع على التسجيلات الفندقية الفعلية (WMAPE). الحساب المباشر: {live} ÷ {total} × 100. النموذج الهجين: {hybrid} ÷ {actual} × 100. تستند الدرجات إلى التقديرات بكامل دقتها، وتُقرّب قيم الجدول والإجماليات لتسهيل القراءة."],
    localized_daily_hotel_guests: ["Daily hotel guests:", "نزلاء الفنادق يوميًا:"],
    localized_a_separate_check_over_period_with_coun: ["a separate check over {period}, with {count} held-out daily records. It tested daily hotel guest counts using hotel-arrival information, not route guest-night changes. Its underlying daily rows are not shown in this monthly table.", "اختبار منفصل خلال {period} باستخدام {count} سجلًا يوميًا مستبعَدًا من التدريب. اختبر أعداد نزلاء الفنادق اليومية باستخدام بيانات التسجيلات، ولا يقيس التغيّر في ليالي النزلاء حسب المسار. ولا تظهر السجلات اليومية في هذا الجدول الشهري."],
    localized_range_multipliers_use_the_live_default: ["Range multipliers use the live default chain’s residuals on the same check months. The range has no separate coverage test and is not a guaranteed probability range.", "تستند معاملات النطاق إلى فروق الحساب المباشر في أشهر الاختبار نفسها. لم تُختبر تغطية النطاق على نحو مستقل ولا يمثّل مجالًا احتماليًا مضمونًا."],
    localized_recorded_hotel_arrivals_compared_with_: ["Recorded hotel arrivals compared with Air2Stay estimates", "التسجيلات الفندقية الفعلية مقارنةً بتقديرات Air2Stay"],
    localized_month_recorded_count_live_default_esti: ["{month}: recorded {count}, live default estimate {estimate}, comparison {value}", "{month}: الفعلي {count}، التقدير المباشر {estimate}، المقارنة {value}"],
    localized_low_to_high: ["{low} to {high}", "من {low} إلى {high}"],
    localized_showing_notes_for_this_country_and_mon: ["Showing notes for this country and month.", "تُعرض ملاحظات هذا البلد والشهر."],
    localized_the_plan_changed_prepare_a_new_draft_w: ["The plan changed. Prepare a new draft with the updated numbers.", "تغيّرت الخطة. جهّز مسودة جديدة بالأرقام المحدّثة."],
    localized_the_plan_changed_earlier_evidence_must: ["The plan changed. Earlier evidence must be checked against these assumptions.", "تغيّرت الخطة. راجع الأدلة السابقة في ضوء الافتراضات الجديدة."],
    localized_due: ["Due", "موعد الاستحقاق"],
    localized_due_date: ["due {date}", "موعد الاستحقاق {date}"],
    localized_matches_the_current_assumptions: ["Matches the current assumptions.", "يتطابق مع الافتراضات الحالية."],
    localized_saved_assumptions_differ_from_the_curr: ["Saved assumptions differ from the current plan.", "تختلف الافتراضات المحفوظة عن الخطة الحالية."],
    localized_estimated_guest_nights_count: ["Estimated guest nights: {count}.", "ليالي النزلاء المقدّرة: {count}."],
    localized_nights_per_hotel_stay: ["Nights per hotel stay", "ليالٍ لكل إقامة فندقية"],
    localized_event_or_seasonal_increase: ["Event or seasonal increase", "زيادة الطلب بسبب فعالية أو موسم"],
    localized_comparison_method: ["Comparison method", "طريقة المقارنة"],
    localized_trip_purpose: ["Trip purpose", "غرض السفر"],
    localized_purpose_assumptions_applied: ["Purpose assumptions applied", "طُبّقت افتراضات غرض السفر"],
    localized_use_seasonal_hotel_estimate: ["Use seasonal hotel estimate", "استخدام التقدير الفندقي الموسمي"],
    localized_the_snapshot_also_retains_the_visitor_: ["The snapshot also retains the visitor mix and comparison-country details for loading this version and downloading history.", "تحتفظ النسخة أيضًا بتوزيع الزوار وتفاصيل دول المقارنة لاستخدامها عند فتحها أو تنزيل السجل."],
    localized_approval_requested: ["Approval requested", "طُلِبت الموافقة"],
    localized_request_updated: ["Request updated", "حُدّث الطلب"],
    localized_task_created: ["Task created", "أُنشئت المهمة"],
    localized_message_saved_in_sent: ["Message saved in Sent", "حُفظت الرسالة في «المرسلة»"],
    localized_attached_plan_opened: ["Attached plan opened.", "فُتحت الخطة المرفقة."],
    localized_a_sample_plan_is_waiting_for_review: ["A sample plan is waiting for review.", "توجد خطة تجريبية بانتظار المراجعة."],
    localized_example_a_sample_plan_is_waiting_for_r: ["Example · A sample plan is waiting for review.", "مثال · توجد خطة تجريبية بانتظار المراجعة."],
    localized_december_room_availability_we_need_you: ["December room availability: we need your forecast", "توفر الغرف في ديسمبر: نحتاج إلى تقديركم"],
    localized_load_factor_for_the_new_frequencies: ["Load factor for the new frequencies", "نسبة إشغال الرحلات الإضافية"],
    localized_accuracy_results_for_the_2025_test_mon: ["Accuracy results for the 2025 test months", "نتائج الدقة لأشهر الاختبار في 2025"],
    localized_hello_n_nseveral_hotels_are_planning_d: ["Hello,\n\nSeveral hotels are planning December room blocks this week. Could you share the expected extra guest nights for the proposed India flights?\n\nA rough range is enough for now.\n\nThank you,\nHotel partnerships", "السلام عليكم،\n\nتخطط عدة فنادق هذا الأسبوع لتخصيص غرف لشهر ديسمبر. هل يمكنكم مشاركة تقدير ليالي النزلاء الإضافية للرحلات المقترحة من الهند؟\n\nيكفي نطاق تقريبي في هذه المرحلة.\n\nمع الشكر،\nفريق الشراكات الفندقية"],
    localized_hi_n_ncould_you_confirm_how_full_you_e: ["Hi,\n\nCould you confirm how full you expect the new flights to be and share any early booking data? We'll use it to review the flight occupancy assumption.", "مرحبًا،\n\nهل يمكنكم تأكيد نسبة الإشغال المتوقّعة للرحلات الجديدة ومشاركة بيانات الحجوزات الأولية؟ سنستخدمها لمراجعة افتراض إشغال الرحلات."],
    localized_the_validation_page_has_the_measured_e: ["The validation page has the measured error, test months and monthly arrival totals for this model.", "تعرض صفحة التحقق الخطأ المقاس وأشهر الاختبار وإجمالي التسجيلات الفندقية لكل شهر لهذا النموذج."],
    localized_review_the_room_capacity_estimate_befo: ["Review the room-capacity estimate before replying to Hotel partnerships.", "راجع تقدير سعة الغرف قبل الردّ على فريق الشراكات الفندقية."],
    localized_approve_3_weekly_flights_india_abu_dha: ["Approve +3 weekly flights, India → Abu Dhabi, December", "الموافقة على +3 رحلات أسبوعيًا من الهند إلى أبوظبي في ديسمبر"],
    localized_airline_partner_wants_a_go_ahead_befor: ["Airline partner wants a go-ahead before filing the winter schedule.", "تطلب شركة الطيران الشريكة الموافقة قبل تقديم جدول الرحلات الشتوي."],
    localized_sign_off_the_hotel_capacity_check_for_: ["Sign off the hotel capacity check for December", "اعتماد التحقق من سعة الفنادق في ديسمبر"],
    localized_confirm_hotels_can_take_the_extra_gues: ["Confirm hotels can take the extra guest nights in peak season.", "تحقّق من قدرة الفنادق على استيعاب ليالي النزلاء الإضافية في موسم الذروة."],
    localized_tourism_strategy_lead: ["Tourism strategy lead", "مسؤول استراتيجية السياحة"],
    localized_untitled_draft: ["Untitled draft", "مسودة بلا عنوان"],
    localized_a_message_can_include_up_to_20_attachm: ["A message can include up to 20 attachments.", "يمكن إرفاق 20 ملفًا على الأكثر بالرسالة."],
    localized_your_message_changed_while_gemini_was_: ["Your message changed while Gemini was working. Your edits are still here.", "تغيّرت الرسالة أثناء إعداد المسودة باستخدام Gemini. بقيت تعديلاتك محفوظة في الحقل."],
    localized_could_not_reach_gemini_ai_assist_can_s: ["Could not reach Gemini. AI Assist can still draft offline.", "تعذّر الاتصال بـ Gemini. يمكن لمساعد الصياغة إعداد مسودة دون اتصال."],
    localized_see_which_features_and_guides_are_used: ["See which features and guides are used on this browser. Counts cannot represent all users or explain why someone stopped a guide.", "اعرض الميزات والجولات المستخدمة في هذا المتصفح. ولا تمثّل الأعداد جميع المستخدمين أو تفسّر أسباب إنهاء جولة مبكرًا."],
    localized_count_steps: ["{count} steps", "{count} خطوات"],
    localized_step_count_of_total: ["Step {count} of {total}", "الخطوة {count} من {total}"],
    localized_choose_the_country_your_flights_would_: ["Choose the country your flights would leave from. This guide points out the controls; it will not change your plan for you.", "اختر بلد مغادرة الرحلات. توضّح الجولة عناصر التحكم وتترك تعديل الخطة لك."],
    localized_choose_the_month_you_want_to_investiga: ["Choose the month you want to investigate. The starting values use the available records for that country and month.", "اختر الشهر الذي تريد دراسته. تستند القيم الأولية إلى السجلات المتاحة لهذا البلد والشهر."],
    localized_add_or_remove_weekly_flights_check_sea: ["Add or remove weekly flights. Check seats per flight and flight fullness too. Zero extra flights does not mean zero impact if you have changed other assumptions.", "أضف رحلات أسبوعية أو خفّضها. راجع أيضًا عدد المقاعد لكل رحلة ونسبة الإشغال. قد تتغيّر النتيجة عند تعديل افتراضات أخرى حتى مع عدم إضافة رحلات."],
    localized_read_the_cards_then_adjust_one_control: ["Read the cards, then adjust one control to see how the estimate responds.", "اقرأ البطاقات، ثم غيّر قيمة واحدة لترى أثرها في التقدير."],
    localized_review_the_estimated_extra_hotel_night: ["Review the estimated extra hotel nights, the assumption that matters most and the airline or hotel checks to complete before acting.", "راجع الليالي الفندقية الإضافية المقدّرة، والافتراض الأكثر تأثيرًا، وما ينبغي التحقق منه مع شركات الطيران أو الفنادق قبل اتخاذ القرار."],
    localized_open_departure_country_and_choose_new_: ["Open Departure country and choose + New route. This reveals the new-country field. The guide does not select a country for you.", "افتح قائمة بلد المغادرة واختر «+ مسار جديد» لإظهار حقل البلد الجديد. اختر البلد بنفسك."],
    localized_type_or_choose_a_country_from_the_list: ["Type or choose a country from the list, then press Confirm country. Suggestions are starting assumptions, not evidence of demand. If the field is not visible, choose + New route first.", "اكتب اسم البلد أو اختره من القائمة، ثم اضغط «تأكيد البلد». الاقتراحات افتراضات أولية ولا تثبت الطلب. إذا لم يظهر الحقل، اختر «+ مسار جديد» أولًا."],
    localized_choose_the_flights_and_seats_you_want_: ["Choose the flights and seats you want to test. A new route starts from zero recorded seats; comparison countries supply adjustable assumptions.", "اختر الرحلات والمقاعد التي تريد اختبارها. يبدأ المسار الجديد من صفر مقعد مسجّل، وتوفّر دول المقارنة افتراضات قابلة للتعديل."],
    localized_details_explains_which_countries_were_: ["Details explains which countries were used and why. Check the weights and limitations. If you kept an existing route, this section may not be shown.", "توضح التفاصيل دول المقارنة وأسباب اختيارها. راجع الأوزان والقيود. قد لا يظهر هذا القسم للمسارات القائمة."],
    localized_compare_the_proposal_with_adding_fligh: ["Compare the proposal with adding flights on an existing route. Check that both options use assumptions you can justify before preferring one.", "قارن المقترح بإضافة رحلات إلى مسار قائم. تأكّد من أن افتراضات الخيارين قابلة للتبرير قبل ترجيح أحدهما."],
    localized_read_the_baseline_note_before_interpre: ["Read the baseline note before interpreting the changes below.", "اقرأ ملاحظة التقدير المرجعي قبل تفسير التغيّرات أدناه."],
    localized_expand_the_calculation_sections_to_see: ["Expand the calculation sections to see the starting values and each multiplication. Displayed values may be rounded; the calculation retains the underlying precision.", "وسّع أقسام الحساب للاطلاع على القيم الأولية وكل عملية ضرب. قد تُقرّب القيم المعروضة بينما يحتفظ الحساب بكامل الدقة."],
    localized_use_the_longest_bar_to_find_the_input_: ["Use the longest bar to find the input to investigate first.", "انظر إلى أطول شريط لمعرفة الافتراض الذي ينبغي التحقق منه أولًا."],
    localized_open_the_method_notes_for_the_training: ["Open the method notes for the training and test periods.", "افتح ملاحظات المنهجية للاطلاع على فترتي التدريب والاختبار."],
    localized_select_the_existing_route_to_compare_r: ["Select the existing route to compare. Read which assumptions are shared. Identical inputs can produce identical added-seat effects; that is expected.", "اختر المسار القائم للمقارنة وراجع الافتراضات المشتركة. قد تؤدي المدخلات المتطابقة إلى الأثر نفسه لكل مقعد إضافي."],
    localized_these_options_vary_the_number_of_weekl: ["These options vary the number of weekly flights. Cautious, standard and expanded describe capacity, not the likelihood of demand.", "تختلف الخيارات في عدد الرحلات الأسبوعية. وتصف الخيارات المتحفّظة والأساسية والموسّعة مستويات السعة."],
    localized_lower_flight_fullness_hotel_use_and_st: ["Lower flight fullness, hotel use and stay length to see how the estimate changes. These are hypothetical stress trials.", "خفّض نسبة إشغال الرحلات والإقامة في الفنادق ومدة الإقامة لترى تغيّر التقدير. هذه اختبارات افتراضية."],
    localized_enter_a_hotel_night_target_to_see_the_: ["Enter a hotel-night target to see the capacity implied by your assumptions. It does not prove enough passengers will book.", "أدخل هدفًا لليالي الفندقية لعرض السعة المطلوبة وفق افتراضاتك. ولا تثبت النتيجة توافر حجوزات كافية."],
    localized_keep_the_estimated_impact_key_assumpti: ["Keep the estimated impact, key assumptions and next checks together. Review the note before sharing it with an airline, hotel or colleague.", "اجمع الأثر المقدّر والافتراضات الرئيسية وخطوات التحقق التالية. راجع المذكرة قبل مشاركتها مع شركة طيران أو فندق أو زميل."],
    localized_choose_a_check_to_see_what_needs_to_be: ["Choose a check to see what needs to be confirmed.", "اختر بند تحقق لمعرفة ما ينبغي تأكيده."],
    localized_use_add_task_on_the_check_you_want_to_: ["Use Add task on the check you want to follow up.", "اختر «إضافة مهمة» للبند الذي تريد متابعته."],
    localized_give_the_action_a_clear_question_owner: ["Give the action a clear question, owner and due date. Update its status as responses arrive. Record the source, date and what was confirmed before marking it verified.", "أضف سؤالًا واضحًا ومسؤولًا وموعد استحقاق للمهمة. حدّث حالتها عند ورود الردود. سجّل المصدر والتاريخ والمعلومة المؤكدة قبل وضع علامة التحقق."],
    localized_save_the_assumptions_and_result_when_y: ["Save the assumptions and result when you reach a useful milestone. Comments and decisions remain with this country and month. Download local history before clearing your browser.", "احفظ الافتراضات والنتيجة عند بلوغ مرحلة مهمّة. تبقى التعليقات والقرارات مرتبطة بهذا البلد والشهر. نزّل السجل المحلي قبل مسح بيانات المتصفح."],
    localized_prepare_an_airline_inquiry_hotel_reque: ["Prepare an airline inquiry, hotel request or team summary from the proposal. Edit and review it before copying or downloading. Nothing is sent automatically.", "جهّز استفسارًا لشركة طيران أو طلبًا لفندق أو ملخّصًا للفريق استنادًا إلى المقترح. حرّر المسودة وراجعها قبل نسخها أو تنزيلها. يتم الإرسال يدويًا."],
    model_ready_csv: ["Model-ready CSV (.csv)", "ملف CSV جاهز للتدريب"],
    simulated_training_csv_description: ["Inputs and simulated targets for this route across 12 months", "مدخلات ونتائج محاكاة لهذا المسار على مدار 12 شهرًا"],
    simulated_training_csv_ready: ["Model-ready CSV with simulated outcomes is ready.", "ملف CSV بنتائج المحاكاة جاهز للتنزيل."],
    excel_report_xlsx: ["Excel report (.xlsx)", "تقرير Excel ‏(.xlsx)"],
    excel_report_contents: ["Dashboard, results, visitors, months and scenarios", "لوحة ملخص ونتائج وزوار وأشهر وسيناريوهات"],
    pdf_report_with_charts: ["PDF report with charts", "تقرير PDF مع رسوم بيانية"],
    ready_to_print_or_share: ["Ready to print or share", "جاهز للطباعة أو المشاركة"],
    excel_report_ready: ["Excel report ready.", "تقرير Excel جاهز."],
    choose_save_pdf: ["Choose Save as PDF in the print window.", "اختر «حفظ كملف PDF» في نافذة الطباعة."],
    report_could_not_be_prepared: ["The report could not be prepared. Check the plan and try again.", "تعذّر إعداد التقرير. تحقق من الخطة وحاول مرة أخرى."],
    see_why_countries_differ: ["See why the countries differ →", "عرض سبب اختلاف البلدان ←"],
    see_flight_record_coverage: ["See matching flight records →", "عرض سجلات الرحلات المطابقة ←"],
    see_range_evidence: ["See the range evidence →", "عرض الأدلة التي يستند إليها النطاق ←"],
    open_market_controls: ["Open market controls →", "فتح أدوات التحكم بالسوق ←"],
    see_baseline_coverage: ["See the baseline and record coverage →", "عرض التقدير المرجعي وتغطية السجلات ←"],
    open_term_guide_arrow: ["Open Term Guide →", "فتح دليل المصطلحات ←"],
    open_calculation: ["Open the calculation →", "عرض طريقة الحساب ←"],
    see_comparison_countries: ["See the comparison countries in Details →", "عرض البلدان المقارنة في التفاصيل ←"],
    see_range_estimate: ["See how the range is estimated →", "عرض طريقة تقدير النطاق ←"],
    open_compare: ["Open Compare →", "فتح المقارنة ←"],
    open_event_controls: ["Open event controls →", "فتح أدوات التحكم بالفعاليات ←"],
    open_export: ["Open Export →", "فتح خيارات التصدير ←"],
    read_privacy_guidance: ["Read the privacy and sharing guidance →", "قراءة إرشادات الخصوصية والمشاركة ←"],
    validation_windows: ["Validation windows", "فترات التحقق"],
    validation_summary_period: ["Air2Stay was tested on {count} months kept out of conversion calibration ({period}). Its overall weighted error was {value} of recorded hotel arrivals. The chart below compares estimates with actual arrivals month by month. This checks monthly totals using recorded flight inputs.", "اختُبرت Air2Stay على {count} أشهر لم تُستخدم لمعايرة معدل التحويل ({period}). وبلغ الخطأ المرجّح الإجمالي {value} من التسجيلات الفندقية الفعلية. يقارن الرسم أدناه التقديرات بالأعداد المسجلة شهريًا باستخدام بيانات الرحلات الفعلية."],
    validation_primary_window: ["Primary validation window", "فترة التحقق الأساسية"],
    validation_primary_period: ["{period} · {count} months · {arrivals}M actual arrivals", "{period} · {count} أشهر · {arrivals} مليون تسجيل فندقي فعلي"],
    validation_primary_source: ["Weighted error · reproduced from the saved monthly records", "الخطأ المرجّح محسوب من السجلات الشهرية المرفقة"],
    validation_fuller_test: ["Fuller test →", "اختبار أوسع ←"],
    validation_extended_window: ["Extended validation window", "فترة التحقق الممتدة"],
    validation_extended_period: ["Jan 2025–Feb 2026 · 14 months", "يناير 2025–فبراير 2026 · 14 شهرًا"],
    validation_later_score: ["13.93% on Aug 2025–Feb 2026 alone", "13.93% خلال أغسطس 2025–فبراير 2026 فقط"],
    validation_retraining_note: ["Reported error was higher in the later months. Quarterly retraining was proposed for a production system.", "كان الخطأ المبلّغ عنه أعلى في الأشهر اللاحقة. واقتُرح إعادة التدريب كل ثلاثة أشهر في النظام التشغيلي."],
    validation_extended_source: ["The extended figures are supplied results. The chart and monthly table cover the primary window only.", "الأرقام الممتدة نتائج مقدّمة. ويغطي الرسم والجدول الشهري فترة التحقق الأساسية فقط."],
    validation_band_tooltip: ["Visual guide: plus or minus {value} of each live estimate. This is not a tested prediction interval.", "دليل بصري بمقدار زائد أو ناقص {value} من كل تقدير مباشر. لم يُختبر هذا النطاق بوصفه مجال تنبؤ."],
    validation_band_caption: ["Shaded band: ±{value} around the live default estimate. A visual guide based on overall weighted error, not a guaranteed range.", "النطاق المظلّل ±{value} حول التقدير الافتراضي المباشر. وهو دليل بصري يستند إلى الخطأ المرجّح الإجمالي، ولا يمثّل نطاقًا مضمونًا."],
    validation_error_low: ["Below 5% error", "الخطأ أقل من 5%"],
    validation_error_medium: ["5–10% error", "الخطأ بين 5% و10%"],
    validation_error_high: ["Above 10% error", "الخطأ أعلى من 10%"],
    validation_live_error: ["Live error", "خطأ التقدير المباشر"],
    validation_hybrid_error: ["Hybrid error", "خطأ النموذج الهجين"],
    validation_table_caption: ["Lower % means a closer estimate. Live default weighted error: {value}.", "النسبة الأقل تعني تقديرًا أقرب. الخطأ المرجّح للتقدير الافتراضي المباشر {value}."],
    validation_compare_approaches: ["Compare the approaches", "مقارنة الأساليب"],
    validation_model_comparison: ["Model comparison", "مقارنة النماذج"],
    validation_model_periods: ["Training: 2022–2024. Test scores read left to right: Jan–Jul 2025 → Aug 2025–Feb 2026. Lower weighted error (WMAPE) means a closer estimate.", "التدريب خلال 2022–2024. تُقرأ درجات الاختبار من اليسار إلى اليمين، من يناير–يوليو 2025 إلى أغسطس 2025–فبراير 2026. الخطأ المرجّح الأقل يعني تقديرًا أقرب."],
    validation_model_scroll: ["Model comparison scores; scroll horizontally on narrow screens", "درجات مقارنة النماذج. مرّر أفقيًا على الشاشات الضيقة"],
    validation_model: ["Model", "النموذج"],
    validation_training_error: ["Train WMAPE", "الخطأ المرجّح في التدريب"],
    validation_test_error: ["Test WMAPE", "الخطأ المرجّح في الاختبار"],
    validation_verdict: ["Verdict", "التقييم"],
    validation_live_chain: ["Live chain", "الحساب المباشر"],
    validation_seasonal_chain: ["Seasonal chain", "الحساب الموسمي"],
    validation_ridge: ["Ridge alone", "انحدار ريدج وحده"],
    validation_live_verdict: ["Underfit: constant rate can't follow seasonality", "ملاءمة ضعيفة لأن المعدل الثابت لا يواكب التغيّرات الموسمية"],
    validation_seasonal_verdict: ["Fine, but drifts low", "أداء مقبول يميل إلى التقليل من الأعداد"],
    validation_ridge_verdict: ["Mild overfit", "ملاءمة زائدة طفيفة"],
    validation_model_source: ["The primary live and seasonal test scores match saved results. Training, Ridge-only and later-window scores are supplied figures; verdicts are supplied interpretations, not verified diagnoses.", "تتطابق نتائج الاختبار الأساسي للحسابين المباشر والموسمي مع النتائج المحفوظة. أما درجات التدريب وانحدار ريدج والفترة اللاحقة فهي أرقام مقدّمة، والتقييمات تفسيرات لم تُتحقّق صحتها."],
    sensitivity_trial_note: ["Each trial changes one assumption within its control limits. Trial sizes differ, so the bars show the effect of these specific changes.", "يغيّر كل اختبار افتراضًا واحدًا ضمن حدوده. وتختلف مقادير التغيير، لذا تُظهر الأشرطة أثر هذه التغييرات المحددة."],
    visitor_edit_help: ["Editing one share adjusts the others to keep the total at 100%.", "عند تعديل حصة واحدة، تتغير الحصص الأخرى ليبقى المجموع 100%."],
    seasonal_comparison: ["Seasonal comparison", "المقارنة الموسمية"],
    privacy_local_proposals: ["Proposal comments, evidence and decisions stay in this browser. Assigning an owner does not send a notification.", "تبقى تعليقات المقترحات وأدلتها وقراراتها في هذا المتصفح. لا يؤدي تعيين مسؤول إلى إرسال إشعار."],
    stress_trials_scope: ["These hypothetical trials use lower assumptions within the control limits.", "تستخدم هذه الاختبارات الافتراضية قيمًا أقل للافتراضات ضمن حدود أدوات التحكم."],
    open_followups: ["Open follow-ups →", "فتح المتابعات ←"],
    see_sensitivity_trials: ["See sensitivity trials →", "عرض اختبارات الحساسية ←"],
    one_at_a_time_sensitivity: ["One-at-a-time sensitivity", "اختبار حساسية كل افتراض على حدة"],
    exact_assumptions_link: ["See exact assumptions and calculation →", "عرض الافتراضات الدقيقة وطريقة الحساب ←"],
    starting_evidence_link: ["See the starting evidence →", "عرض الأدلة على القيم الأولية ←"],
    validation_questions_for_partners: ["Questions for airlines and hotels", "أسئلة لشركات الطيران والفنادق"],
    reproduce_baseline_note: ["The steps below reproduce the estimate based on past flight records.", "توضح الخطوات التالية طريقة احتساب التقدير المستند إلى سجلات الرحلات السابقة."],
    departure_vs_nationality: ["Departure country and visitor nationality →", "بلد المغادرة وجنسية الزائر ←"],
    historical_score_link: ["Compare the validation scores →", "مقارنة نتائج التحقق ←"],
    visitor_mix_link: ["Open Visitor Mix →", "فتح توزيع جنسيات الزوار ←"],
    historical_more_data: ["More data", "بيانات إضافية"],
    decision_routes_link: ["See the route comparison →", "عرض مقارنة المسارات ←"],
    decision_stress_link: ["See the lower-assumption trials →", "عرض اختبارات الافتراضات الأقل ←"],
    seasonal_weighted_error: ["Seasonal comparison: weighted error", "المقارنة الموسمية: الخطأ المرجّح"],
    abu_dhabi_hotel_demand: ["Abu Dhabi hotel demand planner", "أداة تخطيط الطلب الفندقي في أبوظبي"],
    app_pages: ["App pages", "صفحات التطبيق"],
    plan_a_route: ["Plan a route", "تخطيط المسار"],
    visitor_mix: ["Visitor mix", "توزيع الزوار"],
    check_past_results: ["Check past results", "التحقق من النتائج السابقة"],
    term_guide: ["Term guide", "دليل المصطلحات"],
    statistics: ["Statistics", "الإحصاءات"],
    messages: ["Messages", "الرسائل"],
    guide_me: ["Guide me", "جولة إرشادية"],
    notifications: ["Notifications", "الإشعارات"],
    language: ["Language", "اللغة"],
    plan_controls: ["Plan controls", "عناصر التحكم في الخطة"],
    plan_a_route_2: ["PLAN A ROUTE", "تخطيط المسار"],
    change_the_plan: ["Change the plan", "تعديل الخطة"],
    change_the_numbers_to: ["Change the numbers to see what could happen", "عدّل القيم لمعرفة الأثر المحتمل"],
    reset: ["Reset", "إعادة الضبط"],
    market: ["Market", "السوق"],
    departure_country: ["Departure country", "بلد المغادرة"],
    new_departure_country: ["New departure country", "بلد المغادرة الجديد"],
    type_or_choose_a: ["Type or choose a country", "اكتب اسم البلد أو اختره"],
    confirm_country: ["Confirm country", "تأكيد البلد"],
    type_or_choose_a_2: ["Type or choose a country, then confirm to calculate the suggested comparison market.", "اكتب اسم البلد أو اختره ثم أكّده لتحديد سوق المقارنة المقترحة."],
    starting_assumptions: ["Starting assumptions", "الافتراضات الأولية"],
    month: ["Month", "الشهر"],
    flights: ["Flights", "الرحلات الجوية"],
    extra_flights_each_week: ["Extra flights each week", "الرحلات الإضافية أسبوعيًا"],
    add_or_remove_flights: ["Add or remove flights from the usual weekly schedule.", "أضف رحلات إلى الجدول الأسبوعي المعتاد أو احذفها منه."],
    seats_on_each_flight: ["Seats on each flight", "المقاعد لكل رحلة"],
    number_of_passenger_seats: ["Number of passenger seats on each flight.", "عدد مقاعد الركاب في الرحلة الواحدة."],
    how_full_flights_are: ["How full flights are", "نسبة إشغال الرحلات"],
    estimated_share_of_seats: ["Estimated share of seats filled by passengers.", "النسبة التقديرية للمقاعد المشغولة بالركاب."],
    event_or_disruption: ["Event or disruption", "فعالية أو اضطراب"],
    extra_hotel_demand_for: ["Extra hotel demand for an event or season", "زيادة الطلب الفندقي بسبب فعالية أو موسم"],
    hotel_demand_adjustment: ["Hotel demand adjustment", "تعديل الطلب الفندقي"],
    try_a_possible_increase: ["Try a possible increase for a busy period. This is your estimate, not a result measured from past events.", "جرّب زيادة محتملة خلال فترة الذروة. هذه قيمة تقديرية تختارها ولم تُقَس في فعاليات سابقة."],
    hotel_visitors: ["Hotel visitors", "نزلاء الفنادق"],
    expected_travel_purpose: ["Expected travel purpose", "الغرض المتوقع من السفر"],
    mixed_not_specified: ["Mixed / not specified", "متعدد أو غير محدد"],
    holidays: ["Holidays", "العطلات"],
    business: ["Business", "الأعمال"],
    family_visits: ["Family visits", "الزيارات العائلية"],
    a_planning_label_the: ["A planning label. The records do not measure travel purpose, so choosing a label alone does not change the numbers.", "هذا التصنيف لأغراض التخطيط. لا تسجل البيانات الغرض من السفر، لذا لا يؤدي اختيار التصنيف وحده إلى تغيير النتائج."],
    your_assumed_hotel_share: ["Your assumed hotel share (%)", "نسبة الإقامة الفندقية المفترضة (%)"],
    your_assumed_nights_per: ["Your assumed nights per stay", "عدد الليالي المفترض لكل إقامة"],
    apply_visitor_assumptions: ["Apply visitor assumptions", "تطبيق افتراضات الزوار"],
    use_your_own_evidence: ["Use your own evidence or an explicit planning assumption.", "استخدم بياناتك أو حدّد افتراضًا واضحًا للتخطيط."],
    passengers_ending_their_trip: ["Passengers ending their trip in Abu Dhabi", "الركاب الذين تنتهي رحلتهم في أبوظبي"],
    share_of_passengers_who: ["Share of passengers who finish their flight journey here.", "نسبة الركاب الذين تنتهي رحلتهم الجوية هنا."],
    share_checking_into_a: ["Share checking into a hotel", "نسبة التسجيل في الفنادق"],
    estimated_share_of_those: ["Estimated share of those passengers who stay in a hotel.", "النسبة التقديرية للركاب الذين يقيمون في الفنادق."],
    average_nights_per_hotel: ["Average nights per hotel stay", "متوسط الليالي لكل إقامة فندقية"],
    average_number_of_nights: ["Average number of nights each hotel guest stays.", "متوسط عدد الليالي التي يقضيها النزيل في الفندق."],
    orange_number_you_changed: ["Orange number = you changed it · 'Undo change' puts one value back", "الرقم البرتقالي يشير إلى قيمة عدّلتها. يعيد «التراجع عن التغيير» القيمة السابقة."],
    undo_change: ["Undo change", "التراجع عن التغيير"],
    try_a_new_route: ["Try a new route", "جرّب مسارًا جديدًا"],
    choose_new_route_and: ["Choose “＋ New route” and confirm a country. Starting assumptions combine several geographically comparable markets with flight history. Check the reasons and limits in Details.", "اختر «مسار جديد» وأكّد البلد. تستند الافتراضات الأولية إلى بيانات رحلات في أسواق قريبة جغرافيًا. راجع الأسباب والقيود في التفاصيل."],
    about_hotel_stays: ["About hotel stays", "حول الإقامات الفندقية"],
    the_records_don_t: ["The records don’t say why people travelled or which hotel they used. We estimate hotel stays from the totals available.", "لا تحدد السجلات أسباب السفر أو الفنادق المستخدمة. نقدّر الإقامات الفندقية من الإجماليات المتاحة."],
    adjust_plan: ["Adjust plan", "تعديل الخطة"],
    hide_controls: ["Hide controls", "إخفاء عناصر التحكم"],
    show_plan_controls: ["Show plan controls", "إظهار عناصر التحكم في الخطة"],
    hide_plan_controls: ["Hide plan controls", "إخفاء عناصر التحكم في الخطة"],
    planning_view: ["Planning view", "عرض التخطيط"],
    focus: ["Focus", "ملخص"],
    compare: ["Compare", "المقارنة"],
    details: ["Details", "التفاصيل"],
    chat: ["Chat", "المحادثة"],
    follow_ups: ["Follow-ups", "المتابعات"],
    actions: ["Actions", "الإجراءات"],
    open_priority_actions_and: ["Open priority actions and communications", "فتح الإجراءات ذات الأولوية والتواصل"],
    priority_actions_and_communications: ["Priority actions and communications", "الإجراءات ذات الأولوية والتواصل"],
    your_current_plan: ["Your current plan", "خطتك الحالية"],
    live: ["LIVE", "مباشر"],
    matching_past_records: ["Matching past records", "السجلات السابقة المطابقة"],
    some_records: ["Some records", "بعض السجلات"],
    several_records: ["Several records", "عدة سجلات"],
    a_few_records: ["A few records", "سجلات قليلة"],
    no_route_records: ["No route records", "لا توجد سجلات للمسار"],
    past_records: ["Past records", "السجلات السابقة"],
    the_outcome_the_main: ["The outcome, the main drivers, and what to check next.", "النتيجة وأهم العوامل وما ينبغي التحقق منه."],
    review_a_check_add: ["Review a check, add a task, and log what you find.", "راجع بندًا وأضف مهمة وسجّل ما توصلت إليه."],
    compare_added_capacity_test: ["Compare added capacity, test the assumptions, and prepare a decision note.", "قارن السعة المضافة واختبر الافتراضات وأعد مذكرة للقرار."],
    trace_the_assumptions_calculations: ["Trace the assumptions, calculations, flight history, and limits behind this plan.", "تتبّع الافتراضات والحسابات وسجل الرحلات وحدود هذه الخطة."],
    plan_actions: ["Plan actions", "إجراءات الخطة"],
    export: ["Export", "تصدير"],
    spreadsheet_csv: ["Spreadsheet (.csv)", "جدول بيانات (.csv)"],
    full_plan_json: ["Full plan (.json)", "الخطة الكاملة (.json)"],
    proposal_actions_and_history: ["Proposal actions and history", "إجراءات المقترح وسجله"],
    route_decision_tools: ["Route decision tools", "أدوات اتخاذ القرار بشأن المسار"],
    which_route_option_should: ["Which route option should we investigate?", "أي خيار للمسار يستحق الدراسة؟"],
    these_tools_isolate_the: ["These tools isolate the effect of added flights: each option is compared with the same assumptions and zero extra flights. The main headline also includes your other edits to the historical baseline. These are planning comparisons, not airline profitability or booking forecasts.", "تعزل هذه الأدوات أثر الرحلات المضافة. يُقارن كل خيار بخطة تستخدم الافتراضات نفسها دون رحلات إضافية. تتضمن النتيجة الرئيسية أيضًا أثر تعديلاتك الأخرى مقارنة بالتقدير المرجعي. هذه المقارنات للتخطيط وليست توقعات للحجوزات أو الربحية."],
    compare_routes: ["Compare routes", "مقارنة المسارات"],
    current_proposal_versus_an: ["Current proposal versus an existing route", "المقترح الحالي مقارنة بمسار قائم"],
    existing_route_to_compare: ["Existing route to compare", "المسار القائم للمقارنة"],
    use_identical_flight_and: ["Use identical flight and visitor assumptions for both routes", "استخدم افتراضات الرحلات والزوار نفسها للمسارين"],
    both_options_use_the: ["Both options use the same added flights, seats per flight, event assumption and hotel-use rate. By default, the alternative uses its own flight fullness, trip-ending share and average-stay starting estimates.", "يستخدم الخياران عدد الرحلات والمقاعد المضافة نفسه وافتراض الفعالية ونسبة الإقامة الفندقية نفسها. افتراضيًا، يستخدم المسار البديل تقديراته الخاصة للإشغال ونسبة إنهاء الرحلة ومتوسط الإقامة."],
    three_launch_sizes: ["Three launch sizes", "ثلاثة مستويات للتشغيل"],
    cautious_standard_and_expanded: ["Cautious, standard and expanded refer to the number of flights only. They are not probabilities of demand.", "يشير كل مستوى إلى عدد الرحلات فقط، ولا يمثّل احتمالًا للطلب."],
    compare_months: ["Compare months", "مقارنة الأشهر"],
    use_each_month_s: ["Use each month’s market starting estimates", "استخدم التقديرات الأولية للسوق لكل شهر"],
    show_the_numbers: ["Show the numbers", "عرض الأرقام"],
    what_if_fewer_visitors: ["What if fewer visitors stay in hotels?", "ماذا لو أقام عدد أقل من الزوار في الفنادق؟"],
    stress_trials_lower_flight: ["Stress trials lower flight fullness by 10 percentage points, hotel use by 5 points, and stay length by half a night, within the control limits. They are hypothetical tests, not confidence levels.", "تخفّض اختبارات الحساسية إشغال الرحلات 10 نقاط مئوية والإقامة الفندقية 5 نقاط ومدة الإقامة نصف ليلة ضمن حدود الإدخال. هذه اختبارات افتراضية وليست مستويات ثقة."],
    work_backwards_from_a: ["Work backwards from a hotel-night target", "حساب السعة اللازمة لتحقيق هدف الليالي الفندقية"],
    target_extra_guest_nights: ["Target extra guest nights in the selected month", "العدد المستهدف لليالي الإضافية في الشهر المختار"],
    calculate_capacity: ["Calculate capacity", "حساب السعة"],
    apply_changes: ["Apply changes", "تطبيق التغييرات"],
    assumes_every_extra_flight: ["Assumes every extra flight achieves the selected occupancy and visitor assumptions. This does not prove that enough passengers will book or that a route is financially viable.", "يفترض الحساب أن كل رحلة إضافية تحقق الإشغال وافتراضات الزوار المحددة. لا يؤكد ذلك وجود حجوزات كافية أو جدوى مالية للمسار."],
    decision_note: ["Decision note", "مذكرة القرار"],
    the_planning_decision: ["The planning decision", "قرار التخطيط"],
    save_as_pdf: ["Save as PDF", "حفظ بصيغة PDF"],
    or_download_as_text: ["or download as text", "أو تنزيل كنص"],
    what_matters_most: ["What matters most", "العوامل الأهم"],
    assumptions_driving_the_result: ["Assumptions driving the result", "الافتراضات الأكثر تأثيرًا في النتيجة"],
    see_the_evidence_and: ["See the evidence and full calculation →", "اطّلع على الأدلة والحساب الكامل ←"],
    how_the_result_is: ["How the result is calculated", "كيف تُحسَب النتيجة"],
    understand_this_result: ["Understand this result", "فهم النتيجة"],
    assumptions_and_calculation: ["Assumptions and calculation", "الافتراضات والحساب"],
    what_moves_the_result: ["What moves the result most", "ما الأكثر تأثيرًا في النتيجة؟"],
    estimated_hotel_nights_by: ["Estimated hotel nights by nationality", "الليالي الفندقية المقدّرة حسب الجنسية"],
    estimated_change_in_hotel: ["Estimated change in hotel nights for each visitor group", "التغيّر المقدّر في الليالي الفندقية لكل فئة من الزوار"],
    what_changes_the_result: ["What changes the result most", "ما العوامل الأكثر تأثيرًا في النتيجة؟"],
    try_changing_one_thing: ["Try changing one thing at a time", "جرّب تغيير عامل واحد في كل مرة"],
    possible_change_in_guest: ["Possible change in guest nights", "التغيّر المحتمل في ليالي النزلاء"],
    where_the_starting_numbers: ["Where the starting numbers come from", "مصادر القيم الأولية"],
    comparison_countries_and_their: ["Comparison countries and their limits", "دول المقارنة وحدود استخدامها"],
    route_map: ["Route map", "خريطة المسار"],
    flight_route_to_abu: ["Flight route to Abu Dhabi", "مسار الرحلة إلى أبوظبي"],
    selected_departure_country_abu: ["Selected departure country → Abu Dhabi", "بلد المغادرة المختار ← أبوظبي"],
    past_flight_data: ["Past flight data", "بيانات الرحلات السابقة"],
    seats_by_month: ["Seats by month", "المقاعد حسب الشهر"],
    from_the_supplied_records: ["From the supplied records", "من السجلات المقدّمة"],
    average_monthly_seats_bars: ["Average monthly seats · bars start at zero · k = thousand", "متوسط المقاعد شهريًا. تبدأ الأعمدة من الصفر. الرمز k يعني ألفًا."],
    where_the_numbers_come: ["Where the numbers come from", "مصادر الأرقام"],
    why_these_starting_values: ["Why these starting values appear", "سبب اختيار القيم الأولية"],
    values_change_by_country: ["Values change by country and month", "تختلف القيم حسب البلد والشهر"],
    checks_on_the_method: ["Checks on the method", "اختبارات المنهجية"],
    can_hotel_use_vary: ["Can hotel use vary by country and season?", "هل تختلف نسبة الإقامة الفندقية حسب البلد والموسم؟"],
    use_this_month_s: ["Use this month’s training-season hotel-use assumption", "استخدم افتراض الإقامة الفندقية لهذا الشهر من بيانات التدريب"],
    how_well_does_the: ["How well does the comparison-market method reconstruct known flight assumptions?", "ما مدى قدرة طريقة أسواق المقارنة على تقدير قيم الرحلات المعروفة؟"],
    open_historical_validation_results: ["Open historical validation results →", "عرض نتائج التحقق التاريخية ←"],
    next_steps: ["Next steps", "الخطوات التالية"],
    finish_with_a_planning: ["Finish with a planning decision →", "انتقل إلى قرار التخطيط ←"],
    who_may_be_visiting: ["Who may be visiting", "من الزوار المحتملون؟"],
    estimated_visitor_nationalities: ["Estimated visitor nationalities", "الجنسيات المقدّرة للزوار"],
    how_much_past_data: ["How much past data?", "ما حجم البيانات السابقة؟"],
    shown_per_plan: ["Shown per plan", "يظهر لكل خطة"],
    how_the_visitor_estimate: ["How the visitor estimate works", "كيف يُحسَب تقدير الزوار؟"],
    why_the_countries_differ: ["Why the countries differ", "لماذا تختلف البلدان؟"],
    someone_may_fly_from: ["Someone may fly from London but hold an Australian passport. Flight records show where the trip started; hotel records show the guest’s nationality. Air2Stay uses both to estimate who may be visiting.", "قد يسافر شخص من لندن ويحمل جواز سفر أستراليًا. تحدّد سجلات الرحلات بلد المغادرة، وتحدّد سجلات الفنادق جنسية النزيل. تستخدم Air2Stay المصدرين لتقدير توزيع الزوار."],
    one_estimate_shown_two: ["One estimate, shown two ways", "عرض التقدير بطريقتين"],
    first_air2stay_estimates_hotel: ["First, Air2Stay estimates hotel check-ins and nights. Then it splits that same estimate across visitor nationalities. The split does not change the total.", "تقدّر Air2Stay أولًا عدد التسجيلات الفندقية والليالي، ثم توزّع التقدير نفسه حسب جنسية الزائر. يبقى الإجمالي كما هو."],
    share_of_hotel_check: ["Share of hotel check-ins", "الحصة من التسجيلات الفندقية"],
    estimated_part_of_hotel: ["Estimated part of hotel arrivals for each nationality. All 45 groups add up to 100%.", "النسبة المقدّرة من التسجيلات الفندقية لكل جنسية. مجموع الفئات الـ45 يساوي 100%."],
    largest_visitor_groups: ["Largest visitor groups", "أكبر فئات الزوار"],
    the_cards_show_ten: ["The cards show ten nationality groups individually. The other 35 are still included in the estimate.", "تعرض البطاقات 10 فئات من الجنسيات على حدة. ويتضمن التقدير الفئات الـ35 الأخرى."],
    change_the_visitor_mix: ["Change the visitor mix", "تعديل توزيع الزوار"],
    set_the_final_share: ["Set the final share for a nationality. The other groups adjust automatically to keep the total at 100%. Choose Update visitor mix to apply the new shares.", "حدّد الحصة النهائية لجنسية ما. تُعدّل حصص الفئات الأخرى تلقائيًا ليبقى المجموع 100%. اختر «تحديث توزيع الزوار» لتطبيق الحصص الجديدة."],
    largest_nationality_groups: ["Largest nationality groups", "أكبر فئات الجنسيات"],
    largest_nationality_group: ["Largest nationality group", "أكبر فئة من الجنسيات"],
    edit_mix: ["Edit mix", "تعديل التوزيع"],
    cancel_editing: ["Cancel editing", "إلغاء التعديل"],
    reset_to_estimate: ["Reset to estimate", "استعادة التقدير"],
    update_visitor_mix: ["Update visitor mix", "تحديث توزيع الزوار"],
    nationality_cards_scroll_to: ["Nationality cards, scroll to view more countries", "بطاقات الجنسيات. مرّر لعرض المزيد."],
    geographic_origin_map: ["Geographic origin map", "خريطة المنشأ الجغرافي"],
    choose_edit_mix_to: ["Choose Edit mix to adjust the shares, then Update visitor mix to apply them.", "اختر «تعديل التوزيع» لضبط الحصص، ثم «تحديث توزيع الزوار» لتطبيقها."],
    this_label_shows_how: ["This label shows how much past flight information we have. More information can help, but it cannot guarantee the estimate is right.", "يشير هذا التصنيف إلى مقدار بيانات الرحلات السابقة المتاحة. قد تحسّن البيانات الإضافية التقدير، لكنها لا تضمن دقته."],
    check_against_past_records: ["Check against past records", "التحقق بمقارنة السجلات السابقة"],
    how_close_were_the: ["How close were the estimates to real hotel arrivals?", "ما مدى قرب التقديرات من التسجيلات الفندقية الفعلية؟"],
    air2stay_used_earlier_records: ["Air2Stay used earlier records to make estimates for seven later months, then compared them with the actual hotel arrivals for those months.", "استخدمت Air2Stay سجلات سابقة لتقدير التسجيلات الفندقية في 7 أشهر لاحقة، ثم قارنت التقديرات بالتسجيلات الفعلية فيها."],
    step_1_learn: ["1 Learn", "1 التدريب"],
    step_2_set_aside: ["2 Set aside", "2 تخصيص فترة للاختبار"],
    step_3_compare: ["3 Compare", "3 المقارنة"],
    use_36_months_of: ["Use 36 months of older records to learn the usual patterns.", "استخدم سجلات 36 شهرًا سابقة لتعلّم الأنماط المعتادة."],
    keep_the_next_seven: ["Keep the next seven months out of conversion calibration and model fitting.", "استبعد الأشهر الـ7 التالية من ضبط معدل الإقامة الفندقية وتدريب النموذج."],
    estimate_hotel_arrivals_for: ["Estimate hotel arrivals for those seven months and compare with the actual totals.", "قدّر التسجيلات الفندقية للأشهر الـ7 وقارنها بالإجماليات الفعلية."],
    what_these_scores_tested: ["What these scores tested and how they were calculated", "ما الذي اختبرته هذه الدرجات وكيف حُسبت؟"],
    monthly_hotel_arrivals: ["Monthly hotel arrivals", "التسجيلات الفندقية الشهرية"],
    actual_totals_and_air2stay: ["Actual totals and Air2Stay estimates", "الإجماليات الفعلية وتقديرات Air2Stay"],
    recorded_hotel_arrivals: ["Recorded hotel arrivals", "التسجيلات الفندقية الفعلية"],
    live_default_calculation: ["Live default calculation", "الحساب الافتراضي في المخطّط"],
    hybrid_comparison: ["Hybrid comparison", "مقارنة النموذج الهجين"],
    hotel_arrivals: ["Hotel arrivals", "التسجيلات الفندقية"],
    month_checked: ["Month checked", "الشهر المختبَر"],
    how_the_simple_estimate: ["How the simple estimate works", "كيف يعمل التقدير المبسّط؟"],
    how_to_read_the: ["How to read the difference", "كيف تُقرأ الفجوة؟"],
    daily_hotel_guest_check: ["Daily hotel guest check", "التحقق من عدد نزلاء الفنادق يوميًا"],
    these_are_the_hotel: ["These are the hotel arrivals in the supplied files, added together for each month.", "هذه هي التسجيلات الفندقية الواردة في الملفات المقدّمة، مجمّعة لكل شهر."],
    it_starts_with_passengers: ["It starts with passengers whose flight ends in Abu Dhabi, then estimates how many check into hotels.", "يبدأ الحساب بالركاب الذين تنتهي رحلتهم في أبوظبي ثم يقدّر عدد الذين يسجّلون وصولهم في الفنادق."],
    it_shows_how_far: ["It shows how far an estimate was from the recorded total. A smaller difference means a closer estimate. For example, about 7% means roughly seven arrivals of difference for every 100 recorded arrivals.", "يوضح مدى ابتعاد التقدير عن الإجمالي المسجّل. كلما قلّ الفرق، اقترب التقدير من السجل. فمثلًا، 7% تعني فرقًا يقارب 7 تسجيلات لكل 100 تسجيل فعلي."],
    this_compares_estimated_daily: ["This compares estimated daily hotel guests with the recorded number. It checks hotel stays, not how many people fly on each route.", "يقارن هذا الاختبار العدد المقدّر لنزلاء الفنادق يوميًا بالعدد المسجّل. وهو يختبر الإقامات الفندقية، لا عدد المسافرين لكل مسار."],
    what_the_words_mean: ["What the words mean", "معاني المصطلحات"],
    simple_explanations_for_the: ["Simple explanations for the numbers and charts in Air2Stay", "شروحات مبسّطة للأرقام والرسوم في Air2Stay"],
    find_a_term: ["Find a term", "ابحث عن مصطلح"],
    try_nights_flights_or: ["Try: nights, flights or accuracy", "جرّب: الليالي أو الرحلات أو الدقة"],
    print_save_pdf: ["Print / Save PDF", "طباعة أو حفظ بصيغة PDF"],
    jump_to_a_letter: ["Jump to a letter", "الانتقال إلى حرف"],
    what_the_records_don: ["What the records don’t tell us", "معلومات لا تتضمنها السجلات"],
    the_departure_country_is: ["The departure country is where the flight took off, not necessarily where a traveller lives.", "بلد المغادرة هو البلد الذي أقلعت منه الرحلة وقد يختلف عن بلد إقامة المسافر."],
    the_hotel_nationality_is: ["The hotel nationality is based on the guest’s passport, not where the flight started.", "تُسجَّل جنسية نزيل الفندق وفق جواز سفره، بصرف النظر عن بلد المغادرة."],
    the_files_don_t: ["The files don’t show why people travelled, which aircraft they used, how many hotel rooms were available, or which events took place.", "لا توضّح الملفات أسباب السفر أو نوع الطائرة أو عدد الغرف الفندقية المتاحة أو الفعاليات التي أُقيمت."],
    because_the_flight_records: ["Because the flight records cover different time periods, the app compares monthly totals.", "يقارن التطبيق الإجماليات الشهرية لأن سجلات الرحلات تغطّي فترات زمنية مختلفة."],
    about_privacy_and_sharing: ["About privacy and sharing", "الخصوصية والمشاركة"],
    the_planner_runs_locally: ["The planner runs locally.", "يعمل المخطّط محليًا."],
    proposal_comments_evidence_and: ["Proposal comments, evidence and decisions stay in this browser. Assigned owners are not notified and messages are drafts only.", "تبقى التعليقات والأدلة والقرارات في هذا المتصفح. لا يتلقى المسؤولون إشعارات وتبقى الرسائل محفوظة محليًا."],
    it_uses_totals_for: ["It uses totals for groups, not names or details about individual travellers.", "يستخدم التطبيق إجماليات الفئات دون أسماء المسافرين أو بياناتهم الفردية."],
    exported_files_include_your: ["Exported files include your plan assumptions and any edited visitor mix. Proposal-history downloads also include your saved notes.", "تتضمّن الملفات المصدّرة افتراضات الخطة والتعديلات على توزيع الزوار. ويتضمّن سجل المقترح أيضًا ملاحظاتك المحفوظة."],
    guide_me_explains_local: ["Guide me explains local storage, optional usage counts and feedback. Share competition data only with people who are allowed to receive it.", "تشرح الجولة الإرشادية التخزين المحلي وإحصاءات الاستخدام الاختيارية والملاحظات. شارك بيانات المسابقة مع المصرّح لهم فقط."],
    talk_to_your_team: ["Talk to your team and partners", "التواصل مع الفريق والشركاء"],
    write_prioritise_and_keep: ["Write, prioritise and keep track of messages. Messages are saved in this browser and not emailed.", "اكتب الرسائل وحدّد أولويتها وتابعها. تُحفظ الرسائل في هذا المتصفح ولا تُرسل بالبريد الإلكتروني."],
    new_message: ["New message", "رسالة جديدة"],
    message_folder: ["Message folder", "مجلد الرسائل"],
    inbox: ["Inbox", "الوارد"],
    sent: ["Sent", "المرسلة"],
    drafts: ["Drafts", "المسودات"],
    message_priority: ["Message priority", "أولوية الرسالة"],
    priority: ["Priority", "الأولوية"],
    all: ["All", "الكل"],
    high: ["High", "عالية"],
    normal: ["Normal", "عادية"],
    low: ["Low", "منخفضة"],
    message_list: ["Message list", "قائمة الرسائل"],
    search_messages: ["Search messages", "البحث في الرسائل"],
    selected_message: ["Selected message", "الرسالة المختارة"],
    team_shortcuts: ["Team shortcuts", "اختصارات الفريق"],
    vertical_position_of_team: ["Vertical position of team shortcuts", "الموضع العمودي لاختصارات الفريق"],
    drag_up_or_down: ["Drag up or down to move shortcuts", "اسحب لأعلى أو لأسفل لنقل الاختصارات"],
    tasks: ["Tasks", "المهام"],
    name: ["Name", "الاسم"],
    continue: ["Continue", "متابعة"],
    approvals_and_tasks: ["Approvals and tasks", "الموافقات والمهام"],
    close_approvals_drawer: ["Close approvals drawer", "إغلاق لوحة الموافقات"],
    team_views: ["Team views", "عروض الفريق"],
    compose_message: ["Compose message", "إنشاء رسالة"],
    close_compose: ["Close compose", "إغلاق نافذة الإنشاء"],
    recipients: ["Recipients", "المستلمون"],
    tone: ["Tone", "أسلوب الرسالة"],
    professional: ["Professional", "مهني"],
    friendly: ["Friendly", "ودّي"],
    direct: ["Direct", "مباشر"],
    subject: ["Subject", "الموضوع"],
    ai_assist: ["AI Assist", "مساعد الصياغة"],
    draft_with_gemini: ["Draft with Gemini", "صياغة مسودة باستخدام Gemini"],
    ai_assist_builds_a: ["AI Assist builds a draft offline from your subject and current plan.", "ينشئ مساعد الصياغة مسودة محليًا بالاستناد إلى موضوعك وخطتك الحالية."],
    draft_with_gemini_sends: ["Draft with Gemini sends your subject and selected language to Google. Review the reply before using it.", "يرسل هذا الخيار موضوع الرسالة واللغة المختارة إلى Google. راجع المسودة قبل استخدامها."],
    draft_subject_required: ["Enter a subject for the draft first.", "أدخل موضوع الرسالة أولًا."],
    draft_greeting: ["Hello team,", "السلام عليكم،"],
    draft_greeting_friendly: ["Hi team!", "مرحبًا جميعًا،"],
    draft_greeting_direct: ["Team,", "فريق العمل،"],
    draft_ask: ["Please review the plan assumptions and share any feedback.", "يرجى مراجعة افتراضات الخطة ومشاركة ملاحظاتكم."],
    draft_ask_friendly: ["Could you share your thoughts when you get a chance?", "يسعدنا سماع ملاحظاتكم عندما يتسنى لكم ذلك."],
    draft_ask_direct: ["Please review the assumptions and flag any changes.", "يرجى مراجعة الافتراضات والإشارة إلى أي تعديلات مطلوبة."],
    draft_plan_summary: ["The current proposal covers {country} in {month}. Compared with the baseline, it estimates {checkins} hotel check-ins and {nights} guest nights.", "يتعلق المقترح الحالي بسوق المغادرة {country} في شهر {month}. وبالمقارنة مع التقدير المرجعي، يُقدّر المقترح تغيّر تسجيلات الوصول إلى الفنادق بمقدار {checkins}، وتغيّر ليالي النزلاء بمقدار {nights}."],
    draft_plan_unavailable: ["The plan results can be added once its inputs are valid.", "يمكن إضافة نتائج الخطة بعد إدخال قيم صالحة."],
    draft_signoff: ["Thanks,\nAir2Stay planning team", "مع الشكر،\nفريق التخطيط في Air2Stay"],
    draft_ready: ["Draft text added. Review it before sending.", "أُضيفت المسودة. راجعها قبل الإرسال."],
    drafting_with_gemini: ["Drafting with Gemini…", "جارٍ إعداد المسودة باستخدام Gemini…"],
    gemini_draft_ready: ["Gemini draft ready to review.", "مسودة Gemini جاهزة للمراجعة."],
    message: ["Message", "الرسالة"],
    drop_attachments_here_or: ["Drop attachments here or choose files", "أسقط المرفقات هنا أو اختر الملفات"],
    only_file_names_and: ["Only file names and sizes are saved.", "تُحفظ أسماء الملفات وأحجامها فقط."],
    link: ["Link", "الرابط"],
    add_url: ["Add URL", "إضافة رابط"],
    send: ["Send", "إرسال"],
    save_draft: ["Save draft", "حفظ المسودة"],
    extra_hotel_check_ins: ["Extra hotel check-ins", "التسجيلات الفندقية الإضافية"],
    change_in_hotel_check: ["Change in hotel check-ins", "التغيّر في التسجيلات الفندقية"],
    extra_guest_nights: ["Extra guest nights", "ليالي النزلاء الإضافية"],
    change_in_guest_nights: ["Change in guest nights", "التغيّر في ليالي النزلاء"],
    total_guest_nights: ["Total guest nights", "إجمالي ليالي النزلاء"],
    estimated_guest_nights: ["Estimated guest nights", "ليالي النزلاء المقدّرة"],
    possible_range: ["Possible range", "النطاق المحتمل"],
    history_based_guide: ["History-based guide", "دليل يستند إلى السجلات"],
    new_route_all_of: ["New route · all of this is extra", "مسار جديد · يمثّل التقدير كله طلبًا إضافيًا"],
    usual_0_new_route: ["Usual: 0 (new route)", "المعتاد: 0 (مسار جديد)"],
    usual_value: ["Usual: {value}", "المعتاد: {value}"],
    vs_a_usual_month: ["↑ vs a usual {month}", "↑ مقارنة بالمعتاد في {month}"],
    vs_a_usual_month_2: ["↓ vs a usual {month}", "↓ مقارنة بالمعتاد في {month}"],
    no_change_vs_a: ["No change vs a usual {month}", "لا تغيّر مقارنة بالمعتاد في {month}"],
    possible_range_low_to: ["Possible range {low} to {high}; estimate {value}. History-based planning guide, not a guaranteed probability range.", "النطاق المحتمل من {low} إلى {high}، والتقدير {value}. دليل تخطيطي يستند إلى السجلات ولا يمثّل نطاقًا احتماليًا مضمونًا."],
    label_by_month_highest: ["{label} by month, highest in {highestMonth} at {high}, lowest in {lowestMonth} at {low}.", "{label} حسب الشهر. الأعلى في {highestMonth} بقيمة {high}، والأدنى في {lowestMonth} بقيمة {low}."],
    from_seats_to_guest: ["From seats to guest nights", "من المقاعد إلى ليالي النزلاء"],
    how_your_plan_flows: ["How your plan flows through to hotels", "كيف تنعكس خطتك على الفنادق؟"],
    month_estimate: ["{month} estimate", "تقدير شهر {month}"],
    gray_shows_the_baseline: ["Gray shows the baseline estimate for {month}. The colored cap marks your plan level, and the badge shows the change.", "يمثّل الرمادي التقدير المرجعي لشهر {month}، ويبيّن الخط الملوّن مستوى خطتك، وتشير الشارة إلى مقدار التغيّر."],
    the_proposed_country_route: ["The proposed {country} route has no historical baseline. Comparison countries supply starting assumptions only. The headline changes above compare the proposed route with zero. Use Compare to assess adding the same capacity to an existing route.", "لا يوجد تقدير مرجعي تاريخي للمسار المقترح من {country}. توفّر دول المقارنة افتراضات أولية فقط. تقارن النتائج أعلاه المسار المقترح بالصفر. استخدم «المقارنة» لتقييم إضافة السعة نفسها إلى مسار قائم."],
    baseline_an_estimate_based: ["Baseline: an estimate based on past flight records ({count} matching records), with assumed hotel use and length of stay. Hotel totals for this route were not directly observed.", "التقدير المرجعي مبني على سجلات الرحلات السابقة ({count} سجلات مطابقة) وافتراضات الإقامة الفندقية ومدتها. لم تُرصد إجماليات الفنادق لهذا المسار مباشرةً."],
    baseline_an_estimate_based_2: ["Baseline: an estimate based on past flight records, with estimated hotel use and length of stay. It is not an observed route-level hotel total.", "التقدير المرجعي مبني على سجلات الرحلات السابقة وتقديرات الإقامة الفندقية ومدتها. ولا يمثّل إجماليًا فندقيًا مرصودًا لهذا المسار."],
    baseline_estimate: ["Baseline estimate", "التقدير المرجعي"],
    new_route_baseline: ["New route baseline", "مرجع المسار الجديد"],
    your_plan: ["Your plan", "خطتك"],
    seats: ["Seats", "المقاعد"],
    passengers: ["Passengers", "الركاب"],
    end_trip_here: ["End trip here", "تنتهي رحلتهم هنا"],
    hotel_check_ins: ["Hotel check-ins", "التسجيلات الفندقية"],
    guest_nights: ["Guest nights", "ليالي النزلاء"],
    passengers_ending_their_trip_2: ["Passengers ending their trip here", "الركاب الذين تنتهي رحلتهم هنا"],
    change_in_check_ins: ["Change in check-ins", "التغيّر في التسجيلات"],
    no_change: ["No change", "لا تغيّر"],
    new_value: ["New {value}", "جديد {value}"],
    value_flights_a_week: ["{value} flights a week", "{value} رحلة أسبوعيًا"],
    usual_schedule: ["usual schedule", "الجدول المعتاد"],
    value_filled: ["{value} filled", "إشغال {value}"],
    value_not_connecting: ["{value} not connecting", "{value} دون رحلة ربط"],
    value_stay_in_a: ["{value} stay in a hotel", "{value} يقيمون في فندق"],
    value_stay_in_a_2: ["{value} stay in a hotel · event uplift applied", "{value} يقيمون في فندق · طُبّقت زيادة الفعالية"],
    value_nights_each: ["× {value} nights each", "× {value} ليالٍ لكل إقامة"],
    usual_month: ["Usual {month}", "المعتاد في {month}"],
    your_new_route: ["Your new route", "مسارك الجديد"],
    added_by_your_plan: ["Added by your plan", "المضاف ضمن خطتك"],
    change_from_usual: ["Change from usual", "التغيّر عن المعتاد"],
    plan_level: ["Plan level", "مستوى الخطة"],
    assumptions_used: ["Assumptions used", "الافتراضات المستخدمة"],
    past_seats_this_month: ["Past seats this month", "المقاعد السابقة في هذا الشهر"],
    flights_each_week: ["Flights each week", "الرحلات أسبوعيًا"],
    flights_expected_to_be: ["Flights expected to be full", "الإشغال المتوقع للرحلات"],
    passengers_ending_in_abu: ["Passengers ending in Abu Dhabi", "الركاب الذين تنتهي رحلتهم في أبوظبي"],
    share_estimated_to_stay: ["Share estimated to stay in a hotel", "النسبة المقدّرة للإقامة في الفنادق"],
    average_hotel_stay: ["Average hotel stay", "متوسط الإقامة الفندقية"],
    seats_in_your_plan: ["Seats in your plan", "المقاعد في خطتك"],
    flights_added_each_week: ["Flights added each week", "الرحلات المضافة أسبوعيًا"],
    average_nights_per_stay: ["Average nights per stay", "متوسط الليالي لكل إقامة"],
    event_or_disruption_impact: ["Event or disruption impact", "أثر الفعالية أو الاضطراب"],
    baseline_assumptions_and_calculation: ["Baseline assumptions and calculation", "افتراضات التقدير المرجعي وحسابه"],
    your_plan_calculation_with: ["Your plan: calculation with current assumptions", "خطتك: الحساب وفق الافتراضات الحالية"],
    range_visitor_groups_and: ["Range, visitor groups and evidence", "النطاق وفئات الزوار والأدلة"],
    the_steps_below_show: ["The steps below show the values used in this calculation. Percentages are written as fractions (0.8 means 80%). Cards and controls round their display; the calculation keeps the underlying precision. Tiny computer rounding differences below 0.0000001 count as zero change.", "توضح الخطوات أدناه القيم المستخدمة في الحساب. تُكتب النسب بصيغة عشرية (0.8 تعني 80%). تُقرّب القيم المعروضة، بينما يستخدم الحساب كامل الدقة. تُعامل فروق التقريب الأقل من 0.0000001 على أنها صفر."],
    night_spread: ["night spread", "فرق الليالي"],
    assumption_within_control_limits: ["{assumption}, within control limits", "{assumption}، ضمن حدود الإدخال"],
    step_0_5_nights: ["±0.5 nights", "±0.5 ليلة"],
    step_5_percentage_points: ["±5 percentage points", "±5 نقاط مئوية"],
    step_1_flight_week: ["±1 flight/week", "±1 رحلة أسبوعيًا"],
    step_30_seats: ["±30 seats", "±30 مقعدًا"],
    step_10_percentage_points: ["±10 percentage points", "±10 نقاط مئوية"],
    spread_between_the_lower: ["Spread between the lower and higher trial results, changing one assumption at a time. These trial sizes differ, so this is not a ranking of certainty or real-world effects.", "الفرق بين النتيجتين عند خفض افتراض واحد ورفعه. تختلف أحجام الاختبارات، لذا لا يمثّل هذا ترتيبًا لدرجة الثقة أو للآثار الفعلية."],
    validate_assumption_first_it: ["Validate {assumption} first; it has the largest spread in the trials above. This is only a possible result, not a promise. Check the details below before making a decision.", "تحقّق أولًا من {assumption}، إذ نتج عنه أكبر فرق في الاختبارات أعلاه. هذه نتيجة محتملة. راجع التفاصيل قبل اتخاذ القرار."],
    route_demand: ["Route demand", "الطلب على المسار"],
    hotel_capacity: ["Hotel capacity", "السعة الفندقية"],
    for_country_in_month: ["For {country} in {month}, ask the airline or airport how many seats are planned, how quickly they are being booked, and how many passengers arrive. For a new route, use numbers for that route when you can get them instead of the nearby country’s numbers.", "بالنسبة إلى {country} في {month}، اسأل شركة الطيران أو المطار عن المقاعد المخطّط لها وسرعة حجزها وعدد الركاب القادمين. عند دراسة مسار جديد، استخدم بيانات المسار نفسه متى توفّرت."],
    compare_the_guest_night: ["Compare the guest-night change shown above with available rooms, expected hotel occupancy, and typical stay length in {month}.", "قارن التغيّر في ليالي النزلاء أعلاه بالغرف المتاحة والإشغال الفندقي المتوقع ومدة الإقامة المعتادة في {month}."],
    check_these_visitor_groups: ["Check these visitor groups and arrival numbers against official visitor and hotel records before using them for marketing plans.", "تحقّق من فئات الزوار وأعداد القادمين بمقارنتها بسجلات السياحة والفنادق الرسمية قبل استخدامها في التخطيط التسويقي."],
    estimated_visitors_from_country: ["Estimated visitors from {country}", "التقدير لتوزيع الزوار القادمين من {country}"],
    these_percentages_estimate_which: ["These percentages estimate which nationalities may make up hotel guests on this route. They are based on past patterns, not a list of confirmed guests.", "تقدّر هذه النسب توزيع جنسيات نزلاء الفنادق على هذا المسار استنادًا إلى الأنماط السابقة، وليست قائمة مؤكدة بالنزلاء."],
    visitor_shares_total_share: ["Visitor shares total {share}.", "إجمالي حصص الزوار {share}."],
    other_nationalities: ["Other nationalities", "جنسيات أخرى"],
    count_groups_combined: ["{count} groups combined", "{count} فئات مجمّعة"],
    geographic_origin_map_2: ["GEOGRAPHIC ORIGIN MAP", "خريطة المنشأ الجغرافي"],
    global_visitor_origins: ["Global Visitor Origins", "التوزيع الجغرافي للزوار"],
    abu_dhabi: ["ABU DHABI", "أبوظبي"],
    destination_hub: ["Destination hub", "الوجهة"],
    top_nationality_groups_abu: ["Top nationality groups → Abu Dhabi", "أكبر فئات الجنسيات ← أبوظبي"],
    illustrative_nationality_origins_not: ["Illustrative nationality origins, not verified departure airports or flight paths. Locations use country reference points. Other nationalities are included in the cards.", "توضّح الخريطة توزيع الجنسيات بحسب نقاط مرجعية للدول. ولا تمثّل مطارات مغادرة مؤكدة أو مسارات جوية فعلية. تشمل البطاقات الجنسيات الأخرى."],
    some_nationality_locations_are: ["Some nationality locations are unavailable and are not plotted.", "تعذّر عرض مواقع بعض الجنسيات لعدم توفّر إحداثياتها."],
    country_share_percent: ["{country} share percent", "حصة {country} بالمئة"],
    value_percent: ["{value} percent", "{value} بالمئة"],
    other_shares_adjust_automatically: ["Other shares adjust automatically. Check-ins, guest nights and the map update when you apply.", "تُضبط الحصص الأخرى تلقائيًا. تتحدّث التسجيلات والليالي والخريطة عند تطبيق التغييرات."],
    set_a_final_share: ["Set a final share. Other shares adjust automatically. Check-ins, guest nights and the map update when you apply.", "حدّد الحصة النهائية. تُضبط الحصص الأخرى تلقائيًا. تتحدّث التسجيلات والليالي والخريطة عند تطبيق التغييرات."],
    editing_cancelled_the_applied: ["Editing cancelled. The applied visitor mix is unchanged.", "أُلغي التعديل. بقي توزيع الزوار المطبّق كما هو."],
    visitor_mix_updated: ["Visitor mix updated.", "حُدّث توزيع الزوار."],
    original_estimated_visitor_mix: ["Original estimated visitor mix restored. Your flight and hotel assumptions are unchanged.", "استُعيد تقدير توزيع الزوار الأصلي. لم تتغيّر افتراضات الرحلات والفنادق."],
    enter_a_share_from: ["Enter a share from 0% to 100%.", "أدخل حصة من 0% إلى 100%."],
    option: ["Option", "الخيار"],
    extra_check_ins: ["Extra check-ins", "التسجيلات الإضافية"],
    extra_nights: ["Extra nights", "الليالي الإضافية"],
    nights_1_000_added: ["Nights / 1,000 added seats", "الليالي لكل 1,000 مقعد إضافي"],
    flights_full: ["Flights full", "إشغال الرحلات"],
    trip_ends_here: ["Trip ends here", "تنتهي الرحلة هنا"],
    hotel_use: ["Hotel use", "الإقامة الفندقية"],
    nights_stay: ["Nights / stay", "الليالي لكل إقامة"],
    no_added_capacity: ["No added capacity", "لا توجد سعة مضافة"],
    current_proposal_country: ["Current proposal · {country}", "المقترح الحالي · {country}"],
    extra_flights_country: ["Extra flights · {country}", "الرحلات الإضافية · {country}"],
    selected_month: ["Selected month", "الشهر المختار"],
    highest_month: ["Highest month", "الشهر الأعلى"],
    selected_assumptions: ["Selected assumptions", "الافتراضات المختارة"],
    trial: ["Trial", "الاختبار"],
    change_from_selected_assumptions: ["Change from selected assumptions", "التغيّر عن الافتراضات المختارة"],
    value_extra_check_ins: ["{value} extra check-ins", "{value} تسجيلًا إضافيًا"],
    value_extra_guest_nights: ["{value} extra guest nights", "{value} ليلة إضافية للنزلاء"],
    value_flights_week: ["{value} flights / week", "{value} رحلة أسبوعيًا"],
    value_flight_week: ["{value} flight / week", "{value} رحلة أسبوعيًا"],
    hotel_nights_to_plan: ["Hotel nights to plan for", "الليالي الفندقية المطلوب التخطيط لها"],
    check_this_assumption_first: ["Check this assumption first", "تحقّق من هذا الافتراض أولًا"],
    verify_before_acting: ["Verify before acting", "تحقّق قبل التنفيذ"],
    how_the_route_alternatives: ["How the route alternatives compare", "مقارنة المسارات البديلة"],
    enter_a_target_between: ["Enter a target between 0 and 100,000,000 extra guest nights.", "أدخل هدفًا بين 0 و100,000,000 ليلة إضافية للنزلاء."],
    choose_calculate_capacity_to: ["Choose Calculate capacity to update the result.", "اختر «حساب السعة» لتحديث النتيجة."],
    live_default_chain_weighted: ["Live default chain: weighted error", "الخطأ الموزون للحساب الافتراضي"],
    hybrid_comparison_weighted_error: ["Hybrid comparison: weighted error", "الخطأ الموزون للنموذج الهجين"],
    daily_hotel_guests_total: ["Daily hotel guests: total weighted error", "إجمالي الخطأ الموزون لعدد النزلاء يوميًا"],
    tested_monthly_hotel_arrivals: ["Tested monthly hotel arrivals across all included markets", "اختبار التسجيلات الفندقية الشهرية لجميع الأسواق المشمولة"],
    tested_the_comparison_model: ["Tested the comparison model on the same monthly totals", "اختبار النموذج المقارن على الإجماليات الشهرية نفسها"],
    separate_daily_hotel_guest: ["Separate daily hotel-guest test; not route guest-night accuracy", "اختبار مستقل لأعداد النزلاء يوميًا؛ لا يقيس دقة الليالي الفندقية لكل مسار"],
    live_default_estimate: ["Live default estimate", "التقدير الافتراضي"],
    live_error: ["Live error", "خطأ الحساب الافتراضي"],
    hybrid_comparison_estimate: ["Hybrid comparison estimate", "تقدير النموذج الهجين"],
    waiting: ["Waiting", "بانتظار المراجعة"],
    waiting_2: ["waiting", "بانتظار المراجعة"],
    approved: ["Approved", "تمت الموافقة"],
    approved_2: ["approved", "تمت الموافقة"],
    sent_back: ["sent back", "أُعيدت للمراجعة"],
    changes_requested: ["Changes requested", "تعديلات مطلوبة"],
    rejected: ["Rejected", "مرفوض"],
    done: ["Done", "مكتمل"],
    example: ["Example", "مثال"],
    ask_for_approval_of: ["Ask for approval of this plan", "طلب الموافقة على هذه الخطة"],
    approve: ["Approve", "موافقة"],
    ask_for_changes: ["Ask for changes", "طلب تعديلات"],
    reject: ["Reject", "رفض"],
    reopen: ["Reopen", "إعادة الفتح"],
    open_this_plan: ["Open this plan", "فتح هذه الخطة"],
    mark_all_as_read: ["Mark all as read", "تحديد الكل كمقروء"],
    no_notifications_yet: ["No notifications yet.", "لا توجد إشعارات بعد."],
    no_requests_in_this: ["No requests in this view.", "لا توجد طلبات في هذا العرض."],
    unread: ["Unread", "غير مقروء"],
    no_messages_match_this: ["No messages match this view.", "لا توجد رسائل مطابقة في هذا العرض."],
    messages_you_select_will: ["Messages you select will appear here.", "تظهر الرسالة التي تختارها هنا."],
    title: ["Title", "العنوان"],
    send_to: ["Send to", "إرسال إلى"],
    review_team: ["Review team", "فريق المراجعة"],
    planning_team: ["Planning team", "فريق التخطيط"],
    hotel_partnerships: ["Hotel partnerships", "الشراكات الفندقية"],
    airline_route_planning: ["Airline route planning", "تخطيط مسارات الطيران"],
    data_and_insights: ["Data and insights", "البيانات والتحليلات"],
    due_date: ["Due date", "تاريخ الاستحقاق"],
    note: ["Note", "ملاحظة"],
    attach_the_current_plan: ["Attach the current plan", "إرفاق الخطة الحالية"],
    create_request: ["Create request", "إنشاء الطلب"],
    request_status: ["Request status", "حالة الطلب"],
    notifications_count_unread: ["Notifications ({count} unread)", "الإشعارات ({count} غير مقروءة)"],
    high_priority: ["High priority", "أولوية عالية"],
    normal_priority: ["Normal priority", "أولوية عادية"],
    low_priority: ["Low priority", "أولوية منخفضة"],
    has_attachments: ["Has attachments", "تتضمّن مرفقات"],
    attachments: ["Attachments", "المرفقات"],
    reply: ["Reply", "رد"],
    forward: ["Forward", "إعادة توجيه"],
    make_it_a_task: ["Make it a task", "تحويل إلى مهمة"],
    delete: ["Delete", "حذف"],
    edit_draft: ["Edit draft", "تعديل المسودة"],
    no_recipient_yet: ["No recipient yet", "لم يُحدّد مستلم بعد"],
    unknown_sender: ["Unknown sender", "مرسل غير معروف"],
    you: ["You", "أنت"],
    count_min_ago: ["{count} min ago", "قبل {count} دقيقة"],
    count_h_ago: ["{count} h ago", "قبل {count} ساعة"],
    just_now: ["just now", "الآن"],
    search: ["Search", "بحث"],
    search_air2stay: ["Search Air2Stay", "البحث في Air2Stay"],
    search_results: ["Search results", "نتائج البحث"],
    no_results_found: ["No results found.", "لا توجد نتائج."],
    follow_up: ["Follow-up", "متابعة"],
    what_needs_checking: ["What needs checking", "ما الذي يحتاج إلى التحقق؟"],
    your_tasks: ["Your tasks", "مهامك"],
    saved_in_this_browser: ["Saved in this browser", "محفوظ في هذا المتصفح"],
    start_here: ["Start here", "ابدأ هنا"],
    flight_demand: ["Flight demand", "الطلب على الرحلات"],
    to_check: ["To check", "يحتاج إلى التحقق"],
    overdue: ["Overdue", "متأخر"],
    open: ["Open", "مفتوح"],
    review: ["Review", "مراجعة"],
    close_actions_panel: ["Close actions panel", "إغلاق لوحة الإجراءات"],
    add_task: ["Add task", "إضافة مهمة"],
    add_task_for_check: ["Add task for {check}", "إضافة مهمة للتحقق من {check}"],
    new_task: ["New task", "مهمة جديدة"],
    check: ["Check", "بند التحقق"],
    task: ["Task", "المهمة"],
    what_needs_confirming: ["What needs confirming?", "ما الذي يجب تأكيده؟"],
    owner_or_team: ["Owner or team", "المسؤول أو الفريق"],
    for_example_hotel_team: ["For example, hotel team", "مثال: فريق الفنادق"],
    event_demand: ["Event demand", "الطلب المرتبط بفعالية"],
    other_follow_up: ["Other follow-up", "متابعة أخرى"],
    status: ["Status", "الحالة"],
    notes: ["Notes", "الملاحظات"],
    to_mark_done_add: ["To mark Done, add who confirmed what, and when.", "لإكمال المهمة، سجّل من أكّد المعلومات، وما الذي أكّده، ومتى."],
    save: ["Save", "حفظ"],
    plan_changed_review_this: ["Plan changed · Review this again", "تغيّرت الخطة · راجع هذا البند مجددًا"],
    no_tasks_yet_choose: ["No tasks yet. Choose", "لا توجد مهام بعد. اختر"],
    on_a_check_to: ["on a check to get started.", "ضمن أحد بنود التحقق للبدء."],
    more_follow_up_tools: ["More follow-up tools", "أدوات متابعة إضافية"],
    add_note: ["Add note", "إضافة ملاحظة"],
    record_a_question_reply: ["Record a question, reply or useful detail", "سجّل سؤالًا أو ردًا أو معلومة مفيدة"],
    save_note: ["Save note", "حفظ الملاحظة"],
    no_notes_yet: ["No notes yet.", "لا توجد ملاحظات بعد."],
    draft_email: ["Draft email", "مسودة بريد إلكتروني"],
    review_the_draft_then: ["Review the draft, then copy it into your email app to send.", "راجع المسودة ثم انسخها إلى تطبيق البريد الإلكتروني لإرسالها."],
    message_for: ["Message for", "رسالة إلى"],
    airline_or_airport_planner: ["Airline or airport planner", "مسؤول التخطيط في شركة الطيران أو المطار"],
    hotel_team: ["Hotel team", "فريق الفنادق"],
    your_team: ["Your team", "فريقك"],
    prepare_draft: ["Prepare draft", "إعداد المسودة"],
    email_draft: ["Email draft", "مسودة الرسالة"],
    copy_draft: ["Copy draft", "نسخ المسودة"],
    download_draft: ["Download draft", "تنزيل المسودة"],
    log_decision: ["Log decision", "تسجيل القرار"],
    decision: ["Decision", "القرار"],
    investigate: ["Investigate", "قيد الدراسة"],
    hold: ["Hold", "تعليق القرار"],
    ready_for_review: ["Ready for review", "جاهز للمراجعة"],
    reason: ["Reason", "السبب"],
    save_decision: ["Save decision", "حفظ القرار"],
    no_decisions_yet: ["No decisions yet.", "لا توجد قرارات بعد."],
    saved_versions_and_backup: ["Saved versions and backup", "النسخ المحفوظة والنسخ الاحتياطي"],
    version_name: ["Version name", "اسم النسخة"],
    for_example_initial_airline: ["For example, initial airline proposal", "مثال: المقترح الأولي لشركة الطيران"],
    save_version: ["Save version", "حفظ النسخة"],
    no_versions_saved_for: ["No versions saved for this plan yet.", "لم تُحفظ أي نسخ لهذه الخطة بعد."],
    download_local_history: ["Download local history", "تنزيل السجل المحلي"],
    saved_assumptions: ["Saved assumptions", "الافتراضات المحفوظة"],
    load_this_version: ["Load this version", "تحميل هذه النسخة"],
    help_learning: ["Help & learning", "المساعدة والتعلّم"],
    air2stay_help_learning: ["Air2Stay · Help & learning", "Air2Stay · المساعدة والتعلّم"],
    close_help: ["Close help", "إغلاق المساعدة"],
    plan_with_confidence_in: ["Plan with confidence in what the numbers mean", "خطّط بفهم واضح لمعاني الأرقام"],
    short_guides_plain_language: ["Short guides, plain-language answers and the evidence behind your proposal.", "أدلة موجزة وإجابات مبسطة ومصادر تدعم مقترحك."],
    start_guide: ["Start guide", "بدء الجولة"],
    follow_the_real_controls: ["Follow the real controls. Guides move between pages and highlight the next step, without changing your numbers.", "تابع عناصر التحكم الفعلية. تتنقّل الجولات بين الصفحات وتبرز الخطوة التالية دون تغيير أرقامك."],
    open_term_guide: ["Open term guide", "فتح دليل المصطلحات"],
    reference_documents_usage_guidance: ["Reference documents & usage guidance", "المستندات المرجعية وإرشادات الاستخدام"],
    use_the_result_responsibly: ["Use the result responsibly", "الاستخدام المسؤول للنتيجة"],
    local_data_privacy: ["Local data & privacy", "البيانات المحلية والخصوصية"],
    help_improve_air2stay: ["Help improve Air2Stay", "ساهم في تحسين Air2Stay"],
    report_a_problem: ["Report a problem", "الإبلاغ عن مشكلة"],
    usage_insights: ["Usage insights", "إحصاءات الاستخدام"],
    was_this_useful: ["Was this useful?", "هل كان هذا مفيدًا؟"],
    helpful: ["Helpful", "مفيد"],
    not_helpful: ["Not helpful", "غير مفيد"],
    report_problem: ["Report problem", "الإبلاغ عن مشكلة"],
    cancel: ["Cancel", "إلغاء"],
    exit_guide: ["Exit guide", "الخروج من الجولة"],
    exit: ["Exit", "خروج"],
    back: ["Back", "السابق"],
    next: ["Next", "التالي"],
    finish: ["Finish", "إنهاء"],
    priority_actions: ["Priority actions", "الإجراءات ذات الأولوية"],
    actions_count_checks_need: ["Actions · {count} checks need attention", "الإجراءات · {count} بنود تحتاج إلى مراجعة"],
    actions_count_check_needs: ["Actions · {count} check needs attention", "الإجراءات · {count} بند يحتاج إلى مراجعة"],
    actions_unavailable_correct_the: ["Actions unavailable: correct the plan inputs", "الإجراءات غير متاحة. صحّح مدخلات الخطة."],
    review_check: ["Review {check}", "راجع {check}"],
    confirm_expected_bookings_and: ["Confirm expected bookings and how full the proposed flights could be.", "أكّد الحجوزات المتوقعة ونسبة إشغال الرحلات المقترحة."],
    check_whether_hotels_have: ["Check whether hotels have space for the expected guests and length of stay.", "تحقّق من السعة الفندقية اللازمة لاستيعاب النزلاء المتوقعين طوال إقامتهم."],
    check_who_is_likely: ["Check who is likely to travel so the visitor estimates reflect this route.", "تحقّق من فئات المسافرين المتوقعة لكي يعكس التقدير خصائص هذا المسار."],
    check_whether_the_event: ["Check whether the event is likely to bring in the extra visitors assumed in the plan.", "تحقّق مما إذا كانت الفعالية ستجذب الزوار الإضافيين المفترضين في الخطة."],
    confirm_the_flight_demand: ["Confirm the flight demand", "تأكيد الطلب على الرحلات"],
    check_hotel_use_and: ["Check hotel use and capacity", "التحقق من الإقامة الفندقية والسعة"],
    check_who_is_travelling: ["Check who is travelling", "التحقق من فئات المسافرين"],
    hotel_or_tourism_team: ["Hotel or tourism team", "فريق الفنادق أو السياحة"],
    tourism_research_team: ["Tourism research team", "فريق البحوث السياحية"],
    place_due_date_time: ["{place} · due {date} · {time}", "{place} · الاستحقاق {date} · {time}"],
    value_nights: ["{value} nights", "{value} ليلة"],
    value_your_estimate: ["{value}% your estimate", "{value}% وفق تقديرك"],
    historical_route_capacity: ["Historical route capacity", "السعة التاريخية للمسار"],
    no_records_starts_at: ["No records · starts at zero", "لا توجد سجلات · يبدأ من الصفر"],
    observed_route_hotel_demand: ["Observed route hotel demand", "الطلب الفندقي المرصود على المسار"],
    not_available: ["Not available", "غير متاح"],
    what_you_should_check: ["What you should check", "ما ينبغي التحقق منه"],
    the_baseline_uses_the: ["The baseline uses the original visitor mix to calculate the weighted average stay. Editing your plan does not rewrite this baseline. Flight fullness is capped at 100% when a recorded ratio exceeds capacity.", "يستخدم التقدير المرجعي التوزيع الأصلي للزوار لحساب المتوسط الموزون للإقامة. لا تغيّر تعديلات الخطة هذا التقدير. ويُحَدّ إشغال الرحلة عند 100% إذا تجاوزت النسبة المسجّلة السعة."],
    the_matching_records_badge: ["The matching-records badge describes available flight history, not accuracy. The error scores in “Check past results” tested monthly totals, not this route, your changes, the visitor mix, or event effects.", "تشير شارة السجلات المطابقة إلى تاريخ الرحلات المتاح ولا تقيس الدقة. اختبرت درجات الخطأ الإجماليات الشهرية، دون اختبار هذا المسار أو تعديلاتك أو توزيع الزوار أو آثار الفعاليات."],
    count_extra_flights_each: ["{count} extra flights each week would reach at least {target} extra guest nights under the selected assumptions (about {estimate} nights). This is required capacity, not proof of passenger demand.", "وفق الافتراضات المختارة، تحقق إضافة {count} رحلة أسبوعيًا ما لا يقل عن {target} ليلة إضافية للنزلاء (نحو {estimate} ليلة). هذه هي السعة المطلوبة ولا تؤكد وجود الطلب."],
    the_target_is_not: ["The target is not reached within 20 extra flights per week. At that limit the estimate is {estimate} nights, leaving {shortfall} nights below the target.", "لا يتحقق الهدف ضمن حد 20 رحلة إضافية أسبوعيًا. يبلغ التقدير عند هذا الحد {estimate} ليلة، أي أقل من الهدف بـ{shortfall} ليلة."],
    the_live_default_calculation: ["The live default calculation had {value} weighted error across {count} checked months. This tested monthly totals, not individual routes or new-route scenarios.", "بلغ الخطأ الموزون للحساب الافتراضي {value} على مدى {count} أشهر اختبار. اختُبرت الإجماليات الشهرية دون المسارات الفردية أو سيناريوهات المسارات الجديدة."],
    add_positive_flight_capacity: ["Add positive flight capacity to compare hotel-night yield.", "أضف سعة رحلات لمقارنة العائد من الليالي الفندقية."],
    both_options_have_the: ["Both options have the same estimated yield per added seat. Identical passenger and hotel assumptions produce a tie; country names alone do not create demand.", "للخيارين العائد المقدّر نفسه لكل مقعد إضافي. تعطي افتراضات الركاب والفنادق المتطابقة نتيجة متساوية، ولا تكفي أسماء البلدان لتقدير الطلب."],
    each_month_refreshes_market: ["Each month refreshes market flight fullness, trip-ending share and starting stay estimates; flight count and aircraft seats stay fixed. Hotel use stays at your chosen rate unless you applied the training-season option. Any visitor-purpose stay assumption is retained. These are seasonal planning estimates, not future bookings.", "يُحدَّث لكل شهر إشغال الرحلات ونسبة إنهاء الرحلة والتقدير الأولي للإقامة. يبقى عدد الرحلات والمقاعد ثابتًا. تبقى نسبة الإقامة الفندقية كما اخترتها ما لم تطبّق افتراض الموسم من بيانات التدريب. تظل افتراضات الإقامة المتعلقة بغرض الزيارة سارية. هذه تقديرات موسمية للتخطيط وليست حجوزات مستقبلية."],
    all_selected_flight_and: ["All selected flight and hotel assumptions stay fixed. Differences mainly reflect days in each month, not a learned seasonal demand effect.", "تبقى جميع افتراضات الرحلات والفنادق المختارة ثابتة. تعكس الفروق أساسًا عدد أيام الشهر، ولا تمثّل أثرًا موسميًا مستخلصًا من البيانات."],
    same_schedule_as_another: ["Same schedule as another option at the control limit.", "يتطابق الجدول مع خيار آخر عند حد الإدخال."],
    cautious: ["Cautious", "حذر"],
    standard: ["Standard", "قياسي"],
    expanded: ["Expanded", "موسّع"],
    no_matching_answer_try: ["No matching answer. Try a shorter term, such as “route”, “nights” or “accuracy”.", "لا توجد إجابة مطابقة. جرّب مصطلحًا أقصر مثل «المسار» أو «الليالي» أو «الدقة»."],
    no_results: ["No results", "لا توجد نتائج"],
    no_matching_terms: ["No matching terms.", "لا توجد مصطلحات مطابقة."],
    choose_a_valid_plan: ["Choose a valid plan to see its proposal workspace.", "اختر خطة صالحة لعرض مساحة المقترح."],
    correct_the_plan_inputs: ["Correct the plan inputs to see priority actions and communications.", "صحّح مدخلات الخطة لعرض الإجراءات ذات الأولوية والتواصل."],
    choose_and_confirm_a: ["Choose and confirm a departure country to calculate a new route.", "اختر بلد المغادرة وأكّده لحساب المسار الجديد."],
    please_enter_field_between: ["Please enter {field} between {low} and {high} to see the results.", "أدخل {field} بين {low} و{high} لعرض النتائج."],
    average_nights_per_stay_2: ["average nights per stay", "متوسط الليالي لكل إقامة"],
    seats_per_flight: ["seats per flight", "المقاعد لكل رحلة"],
    a_value: ["a value", "قيمة"],
    new_route: ["＋ New route", "＋ مسار جديد"],
    no_past_flight_records: ["No past flight records for this route. {assumption}, not evidence of demand. The proposed route starts from zero.", "لا توجد سجلات رحلات سابقة لهذا المسار. {assumption}، ولا يشكّل ذلك دليلًا على الطلب. يبدأ المسار المقترح من الصفر."],
    a_weighted_blend_of: ["A weighted blend of comparison countries supplies starting assumptions", "يوفّر المتوسط الموزون لدول المقارنة الافتراضات الأولية"],
    country_is_only_a: ["{country} is only a starting point", "تُستخدم {country} نقطة انطلاق فقط"],
    there_are_no_past: ["There are no past flight records for {country}. The visitor estimate starts from {assumption}, so use it as a rough guide.", "لا توجد سجلات رحلات سابقة لبلد {country}. يبدأ تقدير الزوار من {assumption}، لذا استخدمه مؤشرًا تقريبيًا."],
    the_weighted_comparison_country: ["the weighted comparison-country blend", "المتوسط الموزون لدول المقارنة"],
    overall_past_patterns: ["overall past patterns", "الأنماط التاريخية العامة"],
    baseline_an_estimate_based_3: ["Baseline: an estimate based on past flight records ({count} matching records), with assumed hotel use and length of stay. Hotel totals for this route were not directly observed. Includes your chosen +{uplift}% increase for an event or season; this is not based on measured event results.", "التقدير المرجعي مبني على سجلات الرحلات السابقة ({count} سجلات مطابقة) وافتراضات الإقامة الفندقية ومدتها. لم تُرصد إجماليات الفنادق لهذا المسار مباشرةً. يتضمّن التقدير زيادة +{uplift}% اخترتها لفعالية أو موسم، دون قياس سابق لأثر الفعالية."],
    ask_air2stay: ["Ask Air2Stay", "اسأل Air2Stay"],
    talk_through_your_plan: ["Talk through your plan", "ناقش خطتك"],
    clear_chat: ["Clear chat", "مسح المحادثة"],
    conversation: ["Conversation", "المحادثة"],
    ask_about_your_plan: ["Ask about your plan…", "اسأل عن خطتك…"],
    current_result: ["Current result", "النتيجة الحالية"],
    how_this_works: ["How this works", "كيف يعمل؟"],
    close: ["Close", "إغلاق"],
    no_notes_added: ["No notes added.", "لم تُضف ملاحظات."],
    current_plan: ["Current plan", "الخطة الحالية"],
    earlier_plan: ["Earlier plan", "الخطة السابقة"],
    task_history_count: ["Task history ({count})", "سجل المهمة ({count})"],
    no_messages: ["No messages", "لا توجد رسائل"],
    draft_saved: ["Draft saved.", "حُفظت المسودة."],
    message_saved_in_sent: ["Message saved in Sent on this browser.", "حُفظت الرسالة في مجلد المرسلة على هذا المتصفح."],
    message_deleted: ["Message deleted.", "حُذفت الرسالة."],
    task_created_from_this: ["Task created from this message.", "أُنشئت مهمة من هذه الرسالة."],
    choose_at_least_one: ["Choose at least one recipient and enter a subject.", "اختر مستلمًا واحدًا على الأقل وأدخل الموضوع."],
    approval_request_saved: ["Approval request saved.", "حُفظ طلب الموافقة."],
    enter_a_title_and: ["Enter a title and recipient.", "أدخل عنوانًا ومستلمًا."],
    request_updated_status: ["Request updated · {status}.", "حُدّث الطلب · {status}."],
    page: ["Page", "صفحة"],
    plan_view: ["Plan view", "عرض الخطة"],
    compare_tool: ["Compare tool", "أداة المقارنة"],
    control: ["Control", "عنصر تحكم"],
    approval_request: ["Approval request", "طلب موافقة"],
    remove_file: ["Remove {file}", "إزالة {file}"],
    waiting_for_reply: ["Waiting for reply", "بانتظار الرد"],
    copied: ["Copied", "تم النسخ"],
    cautious_launch: ["Cautious launch", "تشغيل محدود"],
    standard_launch: ["Standard launch", "تشغيل قياسي"],
    expanded_launch: ["Expanded launch", "تشغيل موسّع"],
    flights_10_percentage_points: ["Flights 10 percentage points less full", "انخفاض إشغال الرحلات 10 نقاط مئوية"],
    hotel_use_5_percentage: ["Hotel use 5 percentage points lower", "انخفاض الإقامة الفندقية 5 نقاط مئوية"],
    hotel_stays_0_5: ["Hotel stays 0.5 nights shorter", "إقامات فندقية أقصر بـ0.5 ليلة"],
    all_three_lower_assumptions: ["All three lower assumptions together", "خفض الافتراضات الثلاثة معًا"],
    what_this_means: ["What this means", "ماذا يعني ذلك؟"],
    assumptions: ["Assumptions", "الافتراضات"],
    lower_guide: ["Lower guide", "الحد الإرشادي الأدنى"],
    upper_guide: ["Upper guide", "الحد الإرشادي الأعلى"],
    no_historical_flight_records: ["No historical flight records", "لا توجد سجلات رحلات تاريخية"],
    checked: ["Checked", "تم التحقق"],
    value_flights_week_2: ["{value} flights/week", "{value} رحلة أسبوعيًا"],
    see_the_numbers_in: ["See the numbers in context", "الأرقام في سياقها"],
    finish_entering_a_valid: ["Finish entering a valid plan to see its charts.", "أكمل إدخال خطة صالحة لعرض رسومها."],
    guest_nights_through_the: ["Guest nights through the year", "ليالي النزلاء على مدار العام"],
    the_same_plan_inputs: ["The same plan inputs each month, against each month’s baseline estimate.", "مدخلات الخطة نفسها لكل شهر، مقارنة بالتقدير المرجعي لذلك الشهر."],
    largest_departure_markets: ["Largest departure markets", "أكبر أسواق المغادرة"],
    average_historical_flight_seats: ["Average historical flight seats in the selected month.", "متوسط المقاعد التاريخي في الشهر المختار."],
    visitor_nationality_shares: ["Visitor nationality shares", "حصص جنسيات الزوار"],
    estimated_share_of_hotel: ["Estimated share of hotel check-ins for your plan.", "الحصة المقدّرة من التسجيلات الفندقية ضمن خطتك."],
    estimates_vs_real_hotel: ["Estimates vs real hotel arrivals (2025)", "التقديرات مقارنة بالتسجيلات الفندقية الفعلية (2025)"],
    recorded: ["Recorded", "المسجّل"],
    live_estimate: ["Live estimate", "التقدير المباشر"],
    seasonal: ["Seasonal", "موسمي"],
    hybrid: ["Hybrid", "هجين"],
    error_of_each_method: ["Error of each method", "الخطأ حسب طريقة التقدير"],
    weighted_error_across_the: ["Weighted error across the same test months. Lower means closer to recorded arrivals.", "الخطأ الموزون في أشهر الاختبار نفسها. القيمة الأقل أقرب إلى التسجيلات الفعلية."],
    total_seats_by_month: ["Total seats by month", "إجمالي المقاعد حسب الشهر"],
    sum_of_average_historical: ["Sum of average historical flight seats across included markets.", "مجموع متوسطات المقاعد التاريخية في الأسواق المشمولة."],
    flight_seats: ["Flight seats", "مقاعد الرحلات"],
    past_flight_seats: ["Past flight seats", "مقاعد الرحلات السابقة"],
    number_used: ["Number used", "القيمة المستخدمة"],
    for_this_route_and: ["For this route and month", "لهذا المسار والشهر"],
    where_it_comes_from: ["Where it comes from", "مصدرها"],
    reference_flights_each_week: ["Reference flights each week", "الرحلات الأسبوعية المرجعية"],
    flights_added_or_removed: ["Flights added or removed each week", "الرحلات المضافة أو المحذوفة أسبوعيًا"],
    share_expected_to_stay: ["Share expected to stay in hotels", "النسبة المتوقع إقامتها في الفنادق"],
    extra_demand_for_an: ["Extra demand for an event or season", "الطلب الإضافي بسبب فعالية أو موسم"],
    average_number_of_seats: ["Average number of seats from {country} in {month} in the supplied records.", "متوسط المقاعد من {country} في {month} وفق السجلات المقدّمة."],
    average_weekly_flights_recorded: ["Average weekly flights recorded for this country and month.", "متوسط الرحلات الأسبوعية المسجّلة لهذا البلد والشهر."],
    your_scenario_assumption_multiplied: ["Your scenario assumption; multiplied by seats per flight and weeks in the month.", "افتراض تختاره للخطة. يُضرَب في عدد المقاعد لكل رحلة وعدد الأسابيع في الشهر."],
    based_on_past_flights: ["Based on past flights. You can change it.", "يستند إلى الرحلات السابقة. يمكنك تعديله."],
    based_on_how_full: ["Based on how full past flights were. You can change it.", "يستند إلى إشغال الرحلات السابقة. يمكنك تعديله."],
    past_share_of_passengers: ["Past share of passengers whose journey ended in Abu Dhabi. You can change it.", "النسبة التاريخية للركاب الذين انتهت رحلتهم في أبوظبي. يمكنك تعديلها."],
    estimated_share_of_passengers: ["Estimated share of passengers ending their trip here who check into hotels. You can change it.", "النسبة المقدّرة للركاب الذين تنتهي رحلتهم هنا ويسجّلون وصولهم في الفنادق. يمكنك تعديلها."],
    your_chosen_increase_for: ["Your chosen increase for hotel arrivals and nights. It is not measured from past event results.", "الزيادة التي اخترتها للتسجيلات الفندقية والليالي. لم تُقَس من نتائج الفعاليات السابقة."],
    your_plan_uses_this: ["Your plan uses this overall average stay. The baseline keeps its original weighted average from the historical visitor mix.", "تستخدم الخطة هذا المتوسط العام للإقامة. يحتفظ التقدير المرجعي بمتوسطه الموزون من توزيع الزوار التاريخي."],
    no_past_flight_records_2: ["No past flight records for this route", "لا توجد سجلات رحلات سابقة لهذا المسار"],
    there_are_no_monthly: ["There are no monthly flight totals to show yet. The estimate uses the comparison-country assumptions shown in Details.", "لا توجد إجماليات شهرية للرحلات لعرضها. يستخدم التقدير افتراضات دول المقارنة الموضّحة في التفاصيل."],
    month_value_average_seats: ["{month}: {value} average seats", "{month}: متوسط {value} مقعدًا"],
    month_value_average_seats_2: ["{month}: {value} average seats, selected month", "{month}: متوسط {value} مقعدًا، الشهر المختار"],
    selected_month_month: ["Selected month · {month}", "الشهر المختار · {month}"],
    highest_monthly_average_month: ["Highest monthly average · {month}", "أعلى متوسط شهري · {month}"],
    seats_2: ["seats", "مقاعد"],
    hotel_check_in: ["Hotel check-in", "التسجيل في الفندق"],
    a_guest_arriving_to: ["A guest arriving to begin a stay at a hotel.", "وصول نزيل إلى الفندق لبدء إقامته."],
    one_guest_beginning_a: ["One guest beginning a hotel stay = one check-in.", "بدء إقامة نزيل واحد يساوي تسجيلًا فندقيًا واحدًا."],
    guest_night: ["Guest night", "ليلة نزيل"],
    one_guest_staying_for: ["One guest staying for one night. One guest staying three nights counts as three guest nights.", "إقامة نزيل واحد لليلة واحدة. وتُحسب إقامة نزيل واحد لمدة 3 ليالٍ على أنها 3 ليالٍ للنزلاء."],
    step_2_guests_3_nights: ["2 guests × 3 nights = 6 guest nights.", "2 نزيل × 3 ليالٍ = 6 ليالٍ للنزلاء."],
    passengers_who_arrive_here: ["Passengers who arrive here and do not continue their flight to another destination.", "الركاب الذين يصلون إلى أبوظبي ولا يتابعون رحلتهم الجوية إلى وجهة أخرى."],
    a_traveller_staying_here: ["A traveller staying here is included; one changing planes is not.", "يشمل الحساب المسافر الذي يقيم هنا، ويستبعد المسافر الذي يبدّل طائرته فقط."],
    how_full_a_flight: ["How full a flight is", "إشغال الرحلة"],
    if_160_of_200: ["If 160 of 200 seats are filled, the flight is 80% full.", "إذا شُغل 160 مقعدًا من أصل 200، بلغت نسبة إشغال الرحلة 80%."],
    step_160_passengers_200_seats: ["160 passengers ÷ 200 seats = 80% full.", "160 راكبًا ÷ 200 مقعد = إشغال 80%."],
    lower_and_higher_guides: ["Lower and higher guides around the main estimate. They are not guarantees.", "حدود إرشادية أعلى وأدنى من التقدير الرئيسي، دون ضمان تحققها."],
    read_it_as_a: ["Read it as a planning guide, not a guaranteed outcome.", "استخدمه دليلًا للتخطيط، دون اعتباره نتيجة مضمونة."],
    estimated_visitor_mix: ["Estimated visitor mix", "التوزيع المقدّر للزوار"],
    an_estimate_of_the: ["An estimate of the nationalities of hotel guests. It shows groups, not individual people.", "تقدير لجنسيات نزلاء الفنادق على مستوى الفئات، دون بيانات الأفراد."],
    a_20_share_means: ["A 20% share means about 20 in every 100 estimated hotel guests.", "تعني حصة 20% نحو 20 نزيلًا من كل 100 نزيل مقدّر."],
    older_flight_and_hotel: ["Older flight and hotel numbers used to help choose starting values. More matching records can help, but cannot guarantee accuracy.", "أرقام الرحلات والفنادق السابقة المستخدمة لاختيار القيم الأولية. قد تحسّن السجلات المطابقة الإضافية التقدير دون ضمان دقته."],
    four_matching_records_describe: ["Four matching records describe the data available, not four successful predictions.", "تشير 4 سجلات مطابقة إلى البيانات المتاحة ولا تعني وجود 4 توقعات ناجحة."],
    count_definitions: ["{count} definitions", "عدد التعريفات: {count}"],
    no_matching_term_try: ["No matching term. Try a word such as flights, hotel or nights.", "لا يوجد مصطلح مطابق. جرّب كلمة مثل الرحلات أو الفندق أو الليالي."],

    // Target view (work back from a hotel-night target).
    tgt_tab: ["Target", "الهدف"],
    tgt_view_description: ["Start from the hotel nights you want and work back to the flights needed.", "ابدأ بعدد الليالي الفندقية الذي تريده واحسب عكسيًا الرحلات اللازمة."],
    tgt_title: ["What would it take to reach a hotel-night target?", "ما الذي يلزم لتحقيق هدف من الليالي الفندقية؟"],
    tgt_intro: ["Enter the hotel nights you want for this country and month. Air2Stay runs your plan backwards to the passengers, seats and weekly flights needed, using the same assumptions as the rest of the plan.", "أدخل عدد الليالي الفندقية الذي تريده لهذا البلد والشهر. يحسب Air2Stay خطتك عكسيًا للوصول إلى الركاب والمقاعد والرحلات الأسبوعية اللازمة، باستخدام افتراضات الخطة نفسها."],
    tgt_ask_label: ["Ask in your own words", "اسأل بأسلوبك"],
    tgt_ask_placeholder: ["How many flights for 10,000 more nights from India in December?", "كم رحلة نحتاج لإضافة 10,000 ليلة من الهند في ديسمبر؟"],
    tgt_ask_button: ["Ask", "اسأل"],
    tgt_basis_label: ["I want hotel nights to", "أريد أن تكون الليالي الفندقية"],
    tgt_basis_extra: ["increase by", "أعلى بمقدار"],
    tgt_basis_total: ["reach a total of", "بإجمالي"],
    tgt_nights_label: ["Hotel nights in the month", "الليالي الفندقية في الشهر"],
    tgt_working_back: ["Working backwards", "الحساب العكسي"],
    tgt_nights_to_flights: ["From hotel nights to flights", "من الليالي الفندقية إلى الرحلات"],
    tgt_each_step: ["Each step undoes one assumption in your plan", "كل خطوة تعكس افتراضًا واحدًا من خطتك"],
    tgt_other_ways: ["Other ways to get there", "طرق أخرى للوصول"],
    tgt_same_target: ["The same target with no extra flights", "الهدف نفسه دون رحلات إضافية"],
    tgt_one_assumption: ["Changes one assumption across all current travellers", "تغيير افتراض واحد لجميع المسافرين الحاليين"],
    tgt_disclaimer: ["This assumes every extra flight fills like the plan says. In practice, extra flights often fill less well than existing ones. It does not prove passenger demand, airport slots, hotel rooms or route profitability.", "يفترض هذا أن كل رحلة إضافية تمتلئ كما تفترض الخطة. وفي الواقع، كثيرًا ما تمتلئ الرحلات الإضافية بدرجة أقل من الرحلات الحالية. ولا يثبت ذلك وجود طلب من الركاب أو فترات هبوط في المطار أو غرف فندقية أو ربحية المسار."],
    tgt_enter_number: ["Enter a number of hotel nights between 0 and 100,000,000.", "أدخل عددًا من الليالي الفندقية بين 0 و100,000,000."],
    tgt_context_extra: ["{route}, {month}. Without extra flights this plan gives about {estimate} hotel nights, so the target total is about {target}. Change the country or month in Adjust plan.", "{route}، {month}. دون رحلات إضافية تعطي هذه الخطة نحو {estimate} ليلة فندقية، لذا يبلغ إجمالي الهدف نحو {target}. يمكنك تغيير البلد أو الشهر من «تعديل الخطة»."],
    tgt_context_total: ["{route}, {month}. Without extra flights this plan gives about {estimate} hotel nights, so the target needs {shortfall} more. Change the country or month in Adjust plan.", "{route}، {month}. دون رحلات إضافية تعطي هذه الخطة نحو {estimate} ليلة فندقية، لذا يحتاج الهدف إلى {shortfall} ليلة إضافية. يمكنك تغيير البلد أو الشهر من «تعديل الخطة»."],
    tgt_no_flights_needed: ["No extra flights needed", "لا حاجة إلى رحلات إضافية"],
    tgt_already_reaches: ["The plan already reaches this many nights with its usual flights.", "تصل الخطة بالفعل إلى هذا العدد من الليالي برحلاتها المعتادة."],
    tgt_flights_a_week: ["{count} extra flights a week", "{count} رحلة إضافية أسبوعيًا"],
    tgt_headline_detail: ["{value} before rounding up · about {count} more flights in {month} · each one adds about {estimate} hotel nights a month", "{value} قبل التقريب للأعلى · نحو {count} رحلة إضافية في {month} · تضيف كل رحلة أسبوعية نحو {estimate} ليلة فندقية شهريًا"],
    tgt_use_flights: ["Use {count} flights in my plan", "استخدم {count} رحلة في خطتي"],
    tgt_above_limit: ["Above the planner's limit of 20 extra flights a week, so it can't be applied as one route.", "يتجاوز الحد الأقصى في المخطِّط وهو 20 رحلة إضافية أسبوعيًا، لذلك لا يمكن تطبيقه كمسار واحد."],
    tgt_already_uses: ["Your plan already uses this many extra flights.", "تستخدم خطتك هذا العدد من الرحلات الإضافية بالفعل."],
    tgt_currently_has: ["Your plan currently has {value} a week.", "تتضمن خطتك حاليًا {value} أسبوعيًا."],
    tgt_realism_none: ["No extra flights are needed under these assumptions.", "لا حاجة إلى رحلات إضافية وفق هذه الافتراضات."],
    tgt_realism_new: ["This is a new route with no current flights to compare against. Ask an airline whether this schedule is realistic.", "هذا مسار جديد لا توجد له رحلات حالية للمقارنة. اسأل شركة الطيران عمّا إذا كان هذا الجدول واقعيًا."],
    tgt_realism_small: ["A small addition: about {share} more than the roughly {count} flights a week this route usually has in this month.", "إضافة صغيرة: نحو {share} أكثر من قرابة {count} رحلة أسبوعيًا يشهدها هذا المسار عادةً في هذا الشهر."],
    tgt_realism_moderate: ["A noticeable addition: about {share} more than the roughly {count} flights a week this route usually has. Check airline capacity and airport slots.", "إضافة ملحوظة: نحو {share} أكثر من قرابة {count} رحلة أسبوعيًا يشهدها هذا المسار عادةً. تحقّق من سعة شركات الطيران وفترات الهبوط المتاحة في المطار."],
    tgt_realism_large: ["A large addition: about {share} more than the roughly {count} flights a week this route usually has. New flights may not fill as well as existing ones.", "إضافة كبيرة: نحو {share} أكثر من قرابة {count} رحلة أسبوعيًا يشهدها هذا المسار عادةً. قد لا تمتلئ الرحلات الجديدة بقدر الرحلات الحالية."],
    tgt_realism_very_large: ["More than doubles the route: about {value} times the roughly {count} flights a week it usually has. Treat this as unlikely without strong airline evidence.", "أكثر من ضعف المسار: نحو {value} أضعاف قرابة {count} رحلة أسبوعيًا يشهدها عادةً. اعتبر ذلك غير مرجّح دون أدلة قوية من شركات الطيران."],
    tgt_step_start: ["Start", "البداية"],
    tgt_step_nights: ["Hotel nights needed", "الليالي الفندقية المطلوبة"],
    tgt_step_visitors: ["Visitors ending their trip in Abu Dhabi", "الزوار الذين تنتهي رحلتهم في أبوظبي"],
    tgt_step_seats: ["Seats in the month", "المقاعد خلال الشهر"],
    tgt_op_stay: ["÷ {value} nights per stay", "÷ {value} ليلة لكل إقامة"],
    tgt_op_hotel: ["÷ {share} who use a hotel", "÷ {share} يقيمون في فندق"],
    tgt_op_hotel_event: ["÷ {share} who use a hotel and +{uplift} for an event or season", "÷ {share} يقيمون في فندق و+{uplift} لفعالية أو موسم"],
    tgt_op_trip: ["÷ {share} whose trip ends here", "÷ {share} تنتهي رحلتهم هنا"],
    tgt_op_seats: ["÷ {share} of seats filled", "÷ {share} من المقاعد مشغولة"],
    tgt_op_flights: ["÷ {count} seats per flight ÷ {value} weeks", "÷ {count} مقعدًا لكل رحلة ÷ {value} أسابيع"],
    tgt_nothing_to_work_back: ["Nothing to work back: the target is already met.", "لا حاجة إلى الحساب العكسي: الهدف متحقق بالفعل."],
    tgt_lever_hotel: ["Share of visitors using a hotel", "نسبة الزوار المقيمين في الفنادق"],
    tgt_lever_nights: ["{low} nights → {high} nights", "من {low} إلى {high} ليلة"],
    tgt_lever_share: ["{low} → {high}", "من {low} إلى {high}"],
    tgt_within_limits: ["Within the planner's limits.", "ضمن حدود المخطِّط."],
    tgt_beyond_nights: ["Beyond the planner's limit of {value} nights, so not reachable this way alone.", "يتجاوز حد المخطِّط البالغ {value} ليلة، لذلك لا يمكن الوصول إليه بهذه الطريقة وحدها."],
    tgt_beyond_share: ["Beyond the planner's limit of {value}, so not reachable this way alone.", "يتجاوز حد المخطِّط البالغ {value}، لذلك لا يمكن الوصول إليه بهذه الطريقة وحدها."],
    tgt_not_needed: ["Not needed: the target is already met.", "غير مطلوب: الهدف متحقق بالفعل."],
    tgt_no_current_flights: ["This route has no current flights, so only new flights can add hotel nights here.", "لا توجد رحلات حالية على هذا المسار، لذلك لا يمكن إضافة ليالٍ فندقية هنا إلا برحلات جديدة."],
    tgt_cards_note: ["Each card changes one assumption for everyone already flying this route, with no extra flights. They suggest where campaigns could help, for example longer stays or more hotel bookings; they are not measured effects.", "تغيّر كل بطاقة افتراضًا واحدًا لجميع من يسافرون على هذا المسار حاليًا دون رحلات إضافية. وهي تشير إلى المجالات التي قد تفيد فيها الحملات، مثل إطالة الإقامة أو زيادة الحجوزات الفندقية، وليست آثارًا مقيسة."],
    tgt_ask_not_found: ["I couldn't find a number of hotel nights. Try “How many flights for 10,000 more nights from India in December?”", "لم أجد عددًا من الليالي الفندقية. جرّب «كم رحلة نحتاج لإضافة 10,000 ليلة من الهند في ديسمبر؟»"],
    tgt_answering_extra: ["Answering for {route}, {month}: add {target} hotel nights.", "الإجابة عن {route}، {month}: إضافة {target} ليلة فندقية."],
    tgt_answering_total: ["Answering for {route}, {month}: reach a total of {target} hotel nights.", "الإجابة عن {route}، {month}: الوصول إلى إجمالي {target} ليلة فندقية."],
    tgt_answering_percent: ["Answering for {route}, {month}: a {share} increase, about {target} more hotel nights.", "الإجابة عن {route}، {month}: زيادة بنسبة {share}، أي نحو {target} ليلة فندقية إضافية."],
    tgt_switched_country: ["I switched the plan's country to match your question.", "غيّرت بلد الخطة ليتوافق مع سؤالك."],
    tgt_switched_month: ["I switched the plan's month to match your question.", "غيّرت شهر الخطة ليتوافق مع سؤالك."],
    tgt_switched_both: ["I switched the plan's country and month to match your question.", "غيّرت بلد الخطة وشهرها ليتوافقا مع سؤالك."],
    tgt_applied: ["Your plan now has {count} extra flights a week. Open Focus to see the full result.", "أصبحت خطتك تتضمن {count} رحلة إضافية أسبوعيًا. افتح «ملخص» لعرض النتيجة كاملة."],

    // Ask Air2Stay assistant: window and its replies (one sentence per line).
    a2c_open: ["Open the Air2Stay assistant", "فتح مساعد Air2Stay"],
    a2c_move: ["Move the assistant", "حرّك المساعد"],
    a2c_drag: ["Drag to move", "اسحب للتحريك"],
    a2c_drag_launch: ["Ask Air2Stay · Drag to move", "اسأل Air2Stay · اسحب للتحريك"],
    a2c_move_help: ["Drag or use the arrow keys to move. Press Home to reset the position.", "اسحب أو استخدم مفاتيح الأسهم للتحريك. اضغط على مفتاح Home لإعادة الموضع."],
    a2c_title: ["Air2Stay assistant", "مساعد Air2Stay"],
    a2c_ask_about_plan: ["Ask about your plan", "اسأل عن خطتك"],
    a2c_new_conversation_label: ["Start a new conversation", "بدء محادثة جديدة"],
    a2c_new_conversation: ["New conversation", "محادثة جديدة"],
    a2c_close: ["Close the assistant", "إغلاق المساعد"],
    a2c_conversation: ["Conversation with the assistant", "المحادثة مع المساعد"],
    a2c_suggested: ["Suggested questions", "أسئلة مقترحة"],
    a2c_message: ["Message the assistant", "رسالة إلى المساعد"],
    a2c_chip_explain: ["Explain the result", "اشرح النتيجة"],
    a2c_chip_target: ["Reach a target", "تحقيق هدف"],
    a2c_chip_check: ["What to check", "ما الذي يجب التحقق منه"],
    a2c_chip_can_do: ["What can you do?", "ماذا يمكنك أن تفعل؟"],
    a2c_prompt_nights: ["How were hotel nights calculated?", "كيف حُسبت الليالي الفندقية؟"],
    a2c_prompt_target: ["How many flights for 10,000 more nights?", "كم رحلة نحتاج لإضافة 10,000 ليلة؟"],
    a2c_prompt_check: ["What should I check next?", "ما الذي يجب أن أتحقق منه بعد ذلك؟"],
    a2c_note: ["Works offline on this computer. It changes your plan only when you ask directly, like “Set extra flights to 5”.", "يعمل دون إنترنت على هذا الجهاز، ولا يغيّر خطتك إلا عندما تطلب ذلك مباشرةً، مثل «اضبط الرحلات الإضافية على 5»."],
    a2c_context: ["About your plan: {route} · {month} · {value} flights a week", "عن خطتك: {route} · {month} · {value} رحلة أسبوعيًا"],
    a2c_context_usual: ["About your plan: {route} · {month} · usual flights", "عن خطتك: {route} · {month} · الرحلات المعتادة"],
    a2c_context_invalid: ["Your plan has an input to fix", "في خطتك قيمة تحتاج إلى تصحيح"],
    a2c_greeting: ["Hi, I’m the Air2Stay assistant. I run on this computer, so no internet is needed.", "مرحبًا، أنا مساعد Air2Stay. أعمل على هذا الجهاز، لذلك لا حاجة إلى الإنترنت."],
    a2c_greeting_explain: ["Ask how a number was worked out.", "اسأل كيف حُسب أي رقم."],
    a2c_greeting_target: ["Ask what it takes to reach a hotel-night target.", "اسأل عمّا يلزم لتحقيق هدف من الليالي الفندقية."],
    a2c_greeting_change: ["Tell me a change, like “Set extra flights to 5”.", "اطلب تغييرًا، مثل «اضبط الرحلات الإضافية على 5»."],
    a2c_hello: ["Hello! I can explain your plan, work out what it takes to reach a hotel-night target, or change an assumption for you.", "أهلًا! يمكنني شرح خطتك، وحساب ما يلزم لتحقيق هدف من الليالي الفندقية، أو تغيير أحد الافتراضات لك."],
    a2c_hello_try: ["Try “How were hotel nights calculated?” or tap one of the suggestions below.", "جرّب «كيف حُسبت الليالي الفندقية؟» أو اختر أحد الاقتراحات أدناه."],
    a2c_thanks: ["You’re welcome. Ask me anything else about this plan whenever you need.", "على الرحب والسعة. اسألني عن أي شيء آخر في هذه الخطة متى احتجت."],
    a2c_can_help: ["I can help with the plan you have open.", "يمكنني المساعدة في الخطة المفتوحة لديك."],
    a2c_can_explain: ["Explain: “How were hotel nights calculated?” or “Where does the baseline come from?”", "الشرح: «كيف حُسبت الليالي الفندقية؟» أو «من أين يأتي التقدير المرجعي؟»"],
    a2c_can_target: ["Targets: “How many flights for 10,000 more nights from India in December?”", "الأهداف: «كم رحلة نحتاج لإضافة 10,000 ليلة من الهند في ديسمبر؟»"],
    a2c_can_change: ["Changes: “Set flight occupancy to 80%” or “Add 5 flights from France in December”.", "التغييرات: «اضبط نسبة إشغال الرحلات على 80%» أو «أضف 5 رحلات من فرنسا في ديسمبر»."],
    a2c_can_next: ["Next steps: “What should I check next?”", "الخطوات التالية: «ما الذي يجب أن أتحقق منه بعد ذلك؟»"],
    a2c_can_calculator: ["I work out numbers with the same calculator as the rest of the app, and I only change your plan when you ask directly.", "أحسب الأرقام بالحاسبة نفسها المستخدمة في بقية التطبيق، ولا أغيّر خطتك إلا عندما تطلب ذلك مباشرةً."],
    a2c_fix_input: ["Please fix the highlighted plan input first, then ask again.", "يُرجى تصحيح القيمة المظلّلة في الخطة أولًا، ثم اسأل مجددًا."],
    a2c_open_plan: ["Open Plan a route to see the updated result.", "افتح «تخطيط المسار» لعرض النتيجة المحدّثة."],
    a2c_cannot_answer: ["I can’t answer that one on this computer yet. Try one of these:", "لا يمكنني الإجابة عن ذلك على هذا الجهاز بعد. جرّب أحد هذه الأسئلة:"],
    a2c_try_nights: ["“How were hotel nights calculated?”", "«كيف حُسبت الليالي الفندقية؟»"],
    a2c_try_target: ["“How many flights for 10,000 more nights?”", "«كم رحلة نحتاج لإضافة 10,000 ليلة؟»"],
    a2c_try_occupancy: ["“Set flight occupancy to 80%”", "«اضبط نسبة إشغال الرحلات على 80%»"],
    a2c_try_check: ["“What should I check next?”", "«ما الذي يجب أن أتحقق منه بعد ذلك؟»"],
    a2c_not_changed: ["The plan was not changed.", "لم تتغير الخطة."],
    a2c_went_wrong: ["Something went wrong, and your plan was not changed.", "حدث خطأ، ولم تتغير خطتك."],
    a2c_err_whole: ["Use a whole number for flights each week and seats per flight.", "استخدم عددًا صحيحًا للرحلات الأسبوعية وعدد المقاعد لكل رحلة."],
    a2c_applied: ["Applied to {route} in {month}:", "تم التطبيق على {route} في {month}:"],
    a2c_applied_flights: ["{count} extra flights each week", "{count} رحلة إضافية أسبوعيًا"],
    a2c_applied_seats: ["{count} seats per flight", "{count} مقعدًا لكل رحلة"],
    a2c_applied_occupancy: ["{share} flight occupancy", "نسبة إشغال الرحلات {share}"],
    a2c_applied_p2p: ["{share} finishing their trip in Abu Dhabi", "{share} تنتهي رحلتهم في أبوظبي"],
    a2c_applied_hotel: ["{share} hotel use", "الإقامة الفندقية {share}"],
    a2c_applied_stay: ["{value} nights per hotel stay", "{value} ليلة لكل إقامة فندقية"],
    a2c_applied_event: ["{share} extra event or seasonal demand", "{share} طلب إضافي لفعالية أو موسم"],
    a2c_applied_starting: ["the starting assumptions shown in the controls", "الافتراضات الأولية المعروضة في أدوات التحكم"],
    a2c_reset: ["I’ve reset the plan to India in December. You can change the country, month, and numbers on the left.", "أعدت ضبط الخطة إلى الهند في ديسمبر. يمكنك تغيير البلد والشهر والأرقام من لوحة «تعديل الخطة»."],
    a2c_target_open_extra: ["To add {target} hotel nights from {route} in {month}, you would need about {count} extra flights a week ({value} before rounding up).", "لإضافة {target} ليلة فندقية من {route} في {month}، ستحتاج إلى نحو {count} رحلة إضافية أسبوعيًا ({value} قبل التقريب للأعلى)."],
    a2c_target_open_total: ["To reach {target} hotel nights in total from {route} in {month}, you would need about {count} extra flights a week ({value} before rounding up).", "للوصول إلى إجمالي {target} ليلة فندقية من {route} في {month}، ستحتاج إلى نحو {count} رحلة إضافية أسبوعيًا ({value} قبل التقريب للأعلى)."],
    a2c_target_met: ["{route} in {month} already reaches about {estimate} hotel nights without extra flights, so no extra flights are needed.", "تصل خطة {route} في {month} بالفعل إلى نحو {estimate} ليلة فندقية دون رحلات إضافية، لذلك لا حاجة إلى رحلات إضافية."],
    a2c_target_working_back: ["Working back: {target} nights → {low} hotel check-ins → {high} visitors ending their trip here → {estimate} passengers → {value} seats in the month.", "بالحساب العكسي: {target} ليلة ← {low} تسجيلًا فندقيًا ← {high} زائرًا تنتهي رحلتهم هنا ← {estimate} راكبًا ← {value} مقعدًا خلال الشهر."],
    a2c_target_or_stay: ["Or, with no extra flights: average stay {low} → {high} nights.", "أو دون رحلات إضافية: رفع متوسط الإقامة من {low} إلى {high} ليلة."],
    a2c_target_or_hotel: ["Or, with no extra flights: hotel use {low} → {high}.", "أو دون رحلات إضافية: رفع نسبة الإقامة الفندقية من {low} إلى {high}."],
    a2c_target_or_full: ["Or, with no extra flights: flights {low} → {high} full.", "أو دون رحلات إضافية: رفع نسبة إشغال الرحلات من {low} إلى {high}."],
    a2c_target_above_limit: ["That is above the planner's limit of 20 extra flights a week, so it can't be applied to the plan as one route.", "هذا يتجاوز الحد الأقصى في المخطِّط وهو 20 رحلة إضافية أسبوعيًا، لذلك لا يمكن تطبيقه على الخطة كمسار واحد."],
    a2c_target_try_switch: ["Your plan has not changed. To try it, switch to {route} in {month}, then say “Set extra flights to {count}”.", "لم تتغير خطتك. لتجربة ذلك، انتقل إلى {route} في {month} ثم اكتب «اضبط الرحلات الإضافية على {count}»."],
    a2c_target_try: ["To try it, say “Set extra flights to {count}”, or open the Target tab.", "لتجربة ذلك، اكتب «اضبط الرحلات الإضافية على {count}» أو افتح تبويب «الهدف»."],
    a2c_target_assumes: ["This assumes every extra flight fills like the plan says. It does not prove passenger demand or hotel capacity.", "يفترض هذا أن كل رحلة إضافية تمتلئ كما تفترض الخطة، ولا يثبت وجود طلب من الركاب أو سعة فندقية كافية."],
    a2c_nights_formula: ["Hotel nights are estimated hotel arrivals multiplied by average nights per stay.", "الليالي الفندقية = عدد الوافدين المقدّر إلى الفنادق × متوسط الليالي لكل إقامة."],
    a2c_nights_this_plan: ["This plan: about {count} hotel arrivals × {value} nights = {estimate} guest nights. Displayed values are rounded.", "في هذه الخطة: نحو {count} وافدًا إلى الفنادق × {value} ليلة = {estimate} من ليالي النزلاء. القيم المعروضة مقرّبة."],
    a2c_nights_compared: ["That is {value} guest nights compared with the baseline estimate based on past flight records.", "أي {value} من ليالي النزلاء مقارنةً بالتقدير المرجعي المبني على سجلات الرحلات السابقة."],
    a2c_nights_compared_new: ["That is {value} guest nights compared with the baseline estimate based on past flight records. The new route starts from zero.", "أي {value} من ليالي النزلاء مقارنةً بالتقدير المرجعي المبني على سجلات الرحلات السابقة. يبدأ المسار الجديد من الصفر."],
    a2c_nights_people: ["Guest nights count nights spent by people, not hotel rooms.", "تحسب ليالي النزلاء الليالي التي يقضيها الأشخاص، لا الغرف الفندقية."],
    a2c_nights_people_event: ["Guest nights count nights spent by people, not hotel rooms. The arrivals and nights already include your {share} event assumption.", "تحسب ليالي النزلاء الليالي التي يقضيها الأشخاص، لا الغرف الفندقية. ويشمل عدد الوافدين والليالي بالفعل افتراض الفعالية البالغ {share}."],
    a2c_baseline: ["The baseline is an estimate from past flight records for {route} in {month}, combined with hotel-use and stay-length assumptions.", "التقدير المرجعي مبني على سجلات الرحلات السابقة لـ{route} في {month}، مع افتراضات الإقامة الفندقية ومدة الإقامة."],
    a2c_baseline_not_observed: ["It is not an observed count of hotel stays from this route.", "وهو ليس عددًا مرصودًا للإقامات الفندقية من هذا المسار."],
    a2c_baseline_not_rewritten: ["Editing your proposal or visitor mix does not rewrite that baseline.", "تعديل المقترح أو توزيع الزوار لا يغيّر هذا التقدير المرجعي."],
    a2c_baseline_compared: ["The current plan is compared with it to show the change.", "وتُقارن الخطة الحالية به لإظهار التغيّر."],
    a2c_baseline_new: ["This new route has no matching flight records in the supplied data, so its baseline starts at zero. Comparison countries supply starting assumptions only; they do not prove demand or confirmed hotel bookings.", "لا توجد لهذا المسار الجديد سجلات رحلات مطابقة في البيانات المقدّمة، لذلك يبدأ تقديره المرجعي من الصفر. وتوفّر البلدان المقارنة افتراضات أولية فقط، ولا تثبت وجود طلب أو حجوزات فندقية مؤكدة."],
    a2c_fullness: ["Flights are expected to be {share} full, or about {count} passengers out of {value} seats. The plan estimates {estimate} hotel arrivals and {target} hotel nights ({low} nights compared with the original plan).", "يُتوقع أن تبلغ نسبة إشغال الرحلات {share}، أي نحو {count} راكبًا من أصل {value} مقعدًا. وتقدّر الخطة {estimate} وافدًا إلى الفنادق و{target} ليلة فندقية ({low} ليلة مقارنةً بالخطة الأصلية)."],
    a2c_fullness_event: ["Flights are expected to be {share} full, or about {count} passengers out of {value} seats. The plan estimates {estimate} hotel arrivals and {target} hotel nights ({low} nights compared with the original plan). The estimate includes your chosen +{uplift} increase for an event or season. This was not measured from past events.", "يُتوقع أن تبلغ نسبة إشغال الرحلات {share}، أي نحو {count} راكبًا من أصل {value} مقعدًا. وتقدّر الخطة {estimate} وافدًا إلى الفنادق و{target} ليلة فندقية ({low} ليلة مقارنةً بالخطة الأصلية). ويشمل التقدير زيادة +{uplift} اخترتها لفعالية أو موسم، ولم تُقَس من فعاليات سابقة."],
    a2c_more_flights: ["More flights add seats. This plan has {count} seats, so changing flights can change the number of passengers and hotel stays. The plan estimates {estimate} hotel arrivals and {target} hotel nights ({low} nights compared with the original plan).", "تضيف الرحلات الإضافية مقاعد. تتضمن هذه الخطة {count} مقعدًا، لذلك قد يغيّر تعديل الرحلات عدد الركاب والإقامات الفندقية. وتقدّر الخطة {estimate} وافدًا إلى الفنادق و{target} ليلة فندقية ({low} ليلة مقارنةً بالخطة الأصلية)."],
    a2c_assumptions_title: ["The current proposal is {route} in {month}.", "المقترح الحالي: {route} في {month}."],
    a2c_assumptions_flights: ["Flights: {count} extra each week, about {value} seats per flight, {share} full.", "الرحلات: {count} إضافية أسبوعيًا، بنحو {value} مقعدًا لكل رحلة، ونسبة إشغال {share}."],
    a2c_assumptions_visitors: ["Visitors: {low} end their trip here; {high} of those use hotels.", "الزوار: {low} تنتهي رحلتهم هنا، ويقيم {high} منهم في الفنادق."],
    a2c_assumptions_stay: ["Stay: {value} nights on average; event uplift {uplift}. These are planning assumptions. See Details for the calculation and source records.", "الإقامة: {value} ليلة في المتوسط، وزيادة الفعاليات {uplift}. هذه افتراضات تخطيطية؛ راجع «التفاصيل» لمعرفة طريقة الحساب والسجلات المصدرية."],
    a2c_accuracy: ["The accuracy test checks monthly hotel-arrival totals across the included markets—not this individual route or a new route.", "يفحص اختبار الدقة إجماليات الوافدين الشهرية إلى الفنادق عبر الأسواق المشمولة، لا هذا المسار تحديدًا ولا مسارًا جديدًا."],
    a2c_accuracy_open: ["Open Check past results to see the held-out months, scores and test limits.", "افتح «التحقق من النتائج السابقة» لعرض الأشهر المستبعدة من المعايرة والنتائج وحدود الاختبار."],
    a2c_accuracy_records: ["Matching flight records show available history, not forecast certainty.", "تُظهر سجلات الرحلات المطابقة البيانات التاريخية المتاحة، لا يقين التوقع."],
    a2c_accuracy_check: ["Check the proposal’s occupancy, hotel use and stay assumptions before relying on the result.", "راجع افتراضات الإشغال والإقامة الفندقية ومدة الإقامة في المقترح قبل الاعتماد على النتيجة."],
    a2c_check_first: ["Check this first: {item}.", "تحقّق من هذا أولًا: {item}."],
    a2c_why: ["Why: {item}", "السبب: {item}"],
    a2c_who: ["Who can help: {item}.", "من يمكنه المساعدة: {item}."],
    a2c_keep_response: ["Keep the response with this proposal so the next person can see what was checked.", "احفظ الرد مع هذا المقترح ليعرف الشخص التالي ما الذي تم التحقق منه."],
    a2c_check_with: ["Check {item} with {owner}.", "تحقّق من {item} مع {owner}."],
    a2c_reason_driver: ["{item} has the largest effect in the individual lower-assumption trials tested: about {value} guest nights. The trial sizes differ. Checking this assumption first could change the decision.", "{item} له أكبر أثر في التجارب الفردية للافتراضات الأدنى: نحو {value} من ليالي النزلاء. وتختلف أحجام التجارب، وقد يغيّر التحقق من هذا الافتراض أولًا القرار."],
    a2c_reason_overdue: ["Start here because this check is overdue.", "ابدأ من هنا لأن موعد هذا التحقق قد فات."],
    a2c_owner_airline: ["an airline planner", "مخطط في شركة طيران"],
    a2c_owner_hotel: ["the hotel or tourism team", "فريق الفنادق أو السياحة"],
    a2c_spread: ["It has the largest guest-night spread in the one-at-a-time trials shown in Details. The trial sizes differ.", "لهذا الافتراض أكبر أثر في ليالي النزلاء ضمن التجارب الفردية المعروضة في «التفاصيل». وتختلف أحجام التجارب."],
    a2c_ask_hotels: ["Ask hotels about available capacity for {month} and typical stay length. Guest nights count people’s nights, not rooms.", "اسأل الفنادق عن السعة المتاحة في {month} ومدة الإقامة المعتادة. تحسب ليالي النزلاء ليالي الأشخاص، لا الغرف."],
    a2c_record_source: ["Record the source, owner and response in Proposal before making a decision.", "سجّل المصدر والمسؤول والرد في المقترح قبل اتخاذ القرار."],
    a2c_new_route_history: ["This new route has no matching flight history. Ask an airline planner about expected bookings and the proposed schedule first.", "لا يوجد لهذا المسار الجديد سجل رحلات مطابق. اسأل مخططًا في شركة طيران أولًا عن الحجوزات المتوقعة والجدول المقترح."],
    a2c_comparison_only: ["Comparison countries only provide starting assumptions; they do not prove demand for this route.", "توفّر البلدان المقارنة افتراضات أولية فقط، ولا تثبت وجود طلب على هذا المسار."],
    a2c_final_value: ["Please give the final value you want, so I don’t guess. For example: “Set extra flights to 5” or “Set flight occupancy to 80%.” The plan has not changed.", "يُرجى ذكر القيمة النهائية التي تريدها حتى لا أخمّن، مثل «اضبط الرحلات الإضافية على 5» أو «اضبط نسبة إشغال الرحلات على 80%». لم تتغير الخطة."],
    a2c_clear_value: ["I couldn’t match every requested change to a clear value. Use digits and units, for example: “Set hotel use to 40% and average stay to 4 nights.” Nothing has changed.", "لم أتمكن من ربط كل تغيير مطلوب بقيمة واضحة. استخدم الأرقام والوحدات، مثل «اضبط الإقامة الفندقية على 40% ومتوسط الإقامة على 4 ليالٍ». لم يتغير شيء."],
    a2c_what_if: ["Tell me the final value to try, such as “What if flight occupancy is 80%?”, and I will work it out without changing your plan.", "أخبرني بالقيمة النهائية التي تريد تجربتها، مثل «ماذا لو كان الإشغال 80%؟»، وسأحسبها دون تغيير خطتك."],
    a2c_one_route: ["Choose one departure country and one month for this change. Use Compare to examine alternatives. The plan has not changed.", "اختر بلد مغادرة واحدًا وشهرًا واحدًا لهذا التغيير، واستخدم «المقارنة» لدراسة البدائل. لم تتغير الخطة."],
    a2c_name_value: ["Please name the value to change. I can set the route, month, extra flights, seats, flight occupancy, trip-ending share, hotel use, average stay, or event uplift. Use the country picker to create a new route.", "يُرجى تحديد القيمة المراد تغييرها. يمكنني ضبط المسار أو الشهر أو الرحلات الإضافية أو المقاعد أو نسبة إشغال الرحلات أو نسبة من تنتهي رحلتهم هنا أو الإقامة الفندقية أو متوسط الإقامة أو زيادة الفعاليات. استخدم قائمة البلدان لإنشاء مسار جديد."],
    // Percentage and other target replies.
    a2c_decrease: ["I work out the extra flights needed to increase hotel nights. To test fewer flights, set a negative change, like “Set extra flights to -2”.", "أحسب الرحلات الإضافية اللازمة لزيادة الليالي الفندقية. لتجربة رحلات أقل، اضبط تغييرًا سالبًا، مثل «اضبط الرحلات الإضافية على -2»."],
    a2c_too_large: ["That target is too large for this planner. Use fewer than 1,000,000,000 hotel nights, or an increase of up to 100,000%.", "هذا الهدف أكبر مما يستطيع المخطِّط حسابه. استخدم أقل من 1,000,000,000 ليلة فندقية، أو زيادة لا تتجاوز 100,000%."],
    a2c_too_long: ["That message is too long. Please ask one short question at a time.", "هذه الرسالة طويلة جدًا. يُرجى طرح سؤال قصير واحد في كل مرة."],
    a2c_no_percent_base: ["{route} in {month} has no hotel nights without extra flights, so a percentage increase cannot be worked out. Give a number of nights instead, like “How many flights for 5,000 more nights?”", "لا توجد لـ{route} في {month} ليالٍ فندقية دون رحلات إضافية، لذلك لا يمكن حساب زيادة بنسبة مئوية. اذكر عددًا من الليالي بدلًا من ذلك، مثل «كم رحلة نحتاج لإضافة 5,000 ليلة؟»"],
    a2c_percent_intro: ["A {share} increase on the {estimate} hotel nights this plan gives without extra flights ({route}, {month}) is about {target} more nights.", "زيادة بنسبة {share} على {estimate} ليلة فندقية تعطيها هذه الخطة دون رحلات إضافية ({route}، {month}) تعني نحو {target} ليلة إضافية."],

    // Result summary.
    a2c_sum_title: ["Here is your current result for {route} in {month}.", "هذه نتيجتك الحالية لـ{route} في {month}."],
    a2c_sum_checkins: ["Extra hotel check-ins: {value} compared with a usual {month}.", "التسجيلات الفندقية الإضافية: {value} مقارنةً بشهر {month} المعتاد."],
    a2c_sum_nights: ["Extra guest nights: {value} compared with a usual {month}.", "ليالي النزلاء الإضافية: {value} مقارنةً بشهر {month} المعتاد."],
    a2c_sum_total: ["Total guest nights: {estimate} (usual: {target}).", "إجمالي ليالي النزلاء: {estimate} (المعتاد: {target})."],
    a2c_sum_range: ["Possible range: {low} – {high}. This is a history-based guide, not a guarantee.", "النطاق المحتمل: {low} – {high}. وهو دليل مبني على البيانات السابقة، لا ضمان."],
    a2c_sum_records: ["Matching past records: {item}.", "السجلات السابقة المطابقة: {item}."],
    a2c_sum_settings: ["Your settings: {count} extra flights a week, about {value} seats per flight and {share} of seats filled.", "إعداداتك: {count} رحلة إضافية أسبوعيًا، بنحو {value} مقعدًا لكل رحلة، ونسبة إشغال المقاعد {share}."],
    a2c_sum_visitors: ["Visitors: {low} end their trip in Abu Dhabi, {high} of those use a hotel, staying {value} nights on average.", "الزوار: {low} تنتهي رحلتهم في أبوظبي، ويقيم {high} منهم في فندق، لمدة {value} ليلة في المتوسط."],
    a2c_sum_event: ["It also includes a +{uplift} increase for an event or season, which you chose.", "وتشمل أيضًا زيادة +{uplift} لفعالية أو موسم اخترتها."],
    a2c_sum_new_route: ["This is a new route, so the usual month starts at zero.", "هذا مسار جديد، لذلك يبدأ الشهر المعتاد من الصفر."],
    a2c_sum_more: ["Ask “How were hotel nights calculated?” for the formula, or open Details for every step.", "اسأل «كيف حُسبت الليالي الفندقية؟» لمعرفة المعادلة، أو افتح «التفاصيل» لعرض كل خطوة."],

    // App guide: overview.
    a2c_ov_1: ["Air2Stay estimates how changes to flights into Abu Dhabi could change hotel check-ins and guest nights.", "يقدّر Air2Stay كيف يمكن أن تغيّر التعديلات على الرحلات القادمة إلى أبوظبي التسجيلات الفندقية وليالي النزلاء."],
    a2c_ov_2: ["The pages along the top:", "الصفحات في الأعلى:"],
    a2c_ov_plan: ["Plan a route: build and test a plan for one departure country and month.", "تخطيط المسار: إنشاء خطة واختبارها لبلد مغادرة وشهر واحد."],
    a2c_ov_mix: ["Visitor mix: see which nationalities may make up the hotel guests.", "توزيع الزوار: معرفة الجنسيات التي قد يتكوّن منها نزلاء الفنادق."],
    a2c_ov_past: ["Check past results: see how close past estimates were to real hotel arrivals.", "التحقق من النتائج السابقة: معرفة مدى قرب التقديرات السابقة من الوافدين الفعليين إلى الفنادق."],
    a2c_ov_terms: ["Term guide: plain-language definitions of the words and numbers.", "دليل المصطلحات: تعريفات مبسّطة للكلمات والأرقام."],
    a2c_ov_stats: ["Statistics: charts that put your plan in context.", "الإحصاءات: رسوم بيانية تضع خطتك في سياقها."],
    a2c_ov_messages: ["Messages: write and keep track of messages to your team.", "الرسائل: كتابة الرسائل إلى فريقك ومتابعتها."],
    a2c_ov_start: ["To start, open Adjust plan on Plan a route, choose a country and month, and change the flights.", "للبدء، افتح «تعديل الخطة» في «تخطيط المسار»، واختر بلدًا وشهرًا، ثم غيّر الرحلات."],
    a2c_ov_ask: ["Ask me about any page or view, for example “What does Compare do?”", "اسألني عن أي صفحة أو عرض، مثل «ماذا تفعل المقارنة؟»"],

    // App guide: Plan a route controls.
    a2c_gd_adjust_1: ["Plan a route is where you build a plan.", "في «تخطيط المسار» تنشئ خطتك."],
    a2c_gd_adjust_2: ["Open Adjust plan to change it. The controls are in four groups:", "افتح «تعديل الخطة» لتغييرها. أدوات التحكم في أربع مجموعات:"],
    a2c_gd_adjust_market: ["Market: the departure country and month. Choose + New route for a country without past flights.", "السوق: بلد المغادرة والشهر. اختر «+ مسار جديد» لبلد لا توجد له رحلات سابقة."],
    a2c_gd_adjust_flights: ["Flights: extra flights each week, seats on each flight and how full flights are.", "الرحلات: الرحلات الإضافية أسبوعيًا، والمقاعد لكل رحلة، ونسبة إشغال الرحلات."],
    a2c_gd_adjust_event: ["Event or disruption: extra hotel demand for an event or season, from 0% to 50%.", "فعالية أو اضطراب: طلب فندقي إضافي لفعالية أو موسم، من 0% إلى 50%."],
    a2c_gd_adjust_visitors: ["Hotel visitors: travel purpose, passengers ending their trip in Abu Dhabi, the share checking into a hotel and average nights per stay.", "زوار الفنادق: غرض السفر، والركاب الذين تنتهي رحلتهم في أبوظبي، ونسبة التسجيل في الفنادق، ومتوسط الليالي لكل إقامة."],
    a2c_gd_adjust_reset: ["The results update as you change any value. Reset puts the starting values back.", "تتحدّث النتائج عند تغيير أي قيمة، ويعيد زر «إعادة الضبط» القيم الأولية."],
    // Focus.
    a2c_gd_focus_1: ["Focus shows the outcome of your plan:", "يعرض «ملخص» نتيجة خطتك:"],
    a2c_gd_focus_cards: ["Four result cards: extra hotel check-ins, extra guest nights, total guest nights and the possible range.", "أربع بطاقات للنتائج: التسجيلات الفندقية الإضافية، وليالي النزلاء الإضافية، وإجمالي ليالي النزلاء، والنطاق المحتمل."],
    a2c_gd_focus_chart: ["A chart of how your plan flows from seats to guest nights.", "رسم بياني يوضح انتقال خطتك من المقاعد إلى ليالي النزلاء."],
    a2c_gd_focus_next: ["Next steps to check before relying on the result.", "الخطوات التالية التي يجب التحقق منها قبل الاعتماد على النتيجة."],
    // Target.
    a2c_gd_target_1: ["Target works backwards from the hotel nights you want.", "يحسب «الهدف» عكسيًا انطلاقًا من عدد الليالي الفندقية الذي تريده."],
    a2c_gd_target_enter: ["Enter nights to add, or a total to reach, or ask in your own words.", "أدخل عدد الليالي المراد إضافتها، أو الإجمالي المراد الوصول إليه، أو اسأل بأسلوبك."],
    a2c_gd_target_shows: ["It shows the extra weekly flights needed, each step from nights back to seats, and whether that is realistic for the route.", "يعرض الرحلات الأسبوعية الإضافية اللازمة، وكل خطوة من الليالي وصولًا إلى المقاعد، ومدى واقعية ذلك للمسار."],
    a2c_gd_target_other: ["It also shows how the same target could be reached with no extra flights.", "كما يعرض كيف يمكن تحقيق الهدف نفسه دون رحلات إضافية."],
    a2c_gd_target_button: ["A button there puts the flights into your plan.", "ويضيف زر هناك هذه الرحلات إلى خطتك."],
    // Compare.
    a2c_gd_compare_1: ["Compare helps you decide which route option to investigate. Each option is compared with zero extra flights under the same assumptions.", "تساعدك «المقارنة» على اختيار خيار المسار الذي تدرسه. ويُقارن كل خيار بعدم إضافة رحلات وفق الافتراضات نفسها."],
    a2c_gd_compare_route: ["Current proposal versus an existing route.", "المقترح الحالي مقابل مسار قائم."],
    a2c_gd_compare_launch: ["Three launch sizes: cautious, standard and expanded.", "ثلاثة أحجام للإطلاق: حذر وقياسي وموسّع."],
    a2c_gd_compare_months: ["Compare months: the same plan across the year.", "مقارنة الأشهر: الخطة نفسها على مدار العام."],
    a2c_gd_compare_stress: ["What if fewer visitors stay in hotels? Tests with lower assumptions.", "ماذا لو أقام عدد أقل من الزوار في الفنادق؟ اختبارات بافتراضات أدنى."],
    a2c_gd_compare_target: ["Work backwards from a hotel-night target.", "الحساب العكسي من هدف للّيالي الفندقية."],
    a2c_gd_compare_note: ["The planning decision: a note you can save as a PDF or download as text.", "قرار التخطيط: مذكرة يمكنك حفظها بصيغة PDF أو تنزيلها كنص."],
    a2c_gd_compare_limit: ["These are planning comparisons, not airline profitability or booking forecasts.", "هذه مقارنات تخطيطية، وليست توقعات لربحية شركات الطيران أو للحجوزات."],
    // Details.
    a2c_gd_details_1: ["Details traces the assumptions, calculations, flight history and limits behind your plan, in four levels:", "تعرض «التفاصيل» الافتراضات والحسابات وسجل الرحلات والحدود التي تستند إليها خطتك، في أربعة مستويات:"],
    a2c_gd_details_calc: ["How the result is calculated.", "كيف تُحسب النتيجة."],
    a2c_gd_details_moves: ["What moves the result most.", "ما الذي يؤثر في النتيجة أكثر."],
    a2c_gd_details_source: ["Where the starting numbers come from.", "من أين تأتي الأرقام الأولية."],
    a2c_gd_details_checks: ["Checks on the method.", "فحوص المنهجية."],
    // Follow-ups.
    a2c_gd_follow_1: ["Follow-ups helps you check a plan before acting on it. It is saved in this browser.", "تساعدك «المتابعات» على التحقق من الخطة قبل العمل بها، وتُحفظ في هذا المتصفح."],
    a2c_gd_follow_checks: ["What needs checking: flight demand, hotel capacity and visitor mix.", "ما يحتاج إلى تحقق: الطلب على الرحلات، والسعة الفندقية، وتوزيع الزوار."],
    a2c_gd_follow_tasks: ["Tasks with an owner or team and a due date.", "مهام لها مسؤول أو فريق وتاريخ استحقاق."],
    a2c_gd_follow_notes: ["Notes, and a draft email to review and copy into your email app.", "ملاحظات، ومسودة بريد إلكتروني تراجعها وتنسخها إلى تطبيق البريد."],
    a2c_gd_follow_decision: ["A decision log: Investigate, Hold or Ready for review.", "سجل قرارات: دراسة، أو تعليق، أو جاهز للمراجعة."],
    a2c_gd_follow_owner: ["Assigning an owner does not send a notification.", "تعيين مسؤول لا يرسل إشعارًا."],
    // Visitor mix.
    a2c_gd_mix_1: ["Visitor mix estimates which nationalities may make up the hotel guests on this route.", "يقدّر «توزيع الزوار» الجنسيات التي قد يتكوّن منها نزلاء الفنادق على هذا المسار."],
    a2c_gd_mix_2: ["It uses past patterns, not a list of confirmed guests.", "ويعتمد على الأنماط السابقة، لا على قائمة بنزلاء مؤكدين."],
    a2c_gd_mix_3: ["Flight records show where a trip started; hotel records show a guest’s nationality. Air2Stay uses both.", "تُظهر سجلات الرحلات مكان بدء الرحلة، وتُظهر سجلات الفنادق جنسية النزيل، ويستخدم Air2Stay كليهما."],
    a2c_gd_mix_4: ["It splits the same hotel estimate across nationalities, so the total does not change.", "ويوزّع التقدير الفندقي نفسه على الجنسيات، لذلك لا يتغير الإجمالي."],
    a2c_gd_mix_5: ["Choose Edit mix to change the shares, then Update visitor mix. Reset to estimate puts the original shares back.", "اختر «تعديل التوزيع» لتغيير النسب ثم «تحديث توزيع الزوار»، ويعيد «العودة إلى التقدير» النسب الأصلية."],
    // Check past results.
    a2c_gd_past_1: ["Check past results shows how close Air2Stay’s estimates were to real hotel arrivals.", "تعرض «التحقق من النتائج السابقة» مدى قرب تقديرات Air2Stay من الوافدين الفعليين إلى الفنادق."],
    a2c_gd_past_2: ["It learned from {count} months of older records, then estimated {value} later months it had not used ({item}) and compared them with the actual totals.", "تعلّم من {count} شهرًا من السجلات الأقدم، ثم قدّر {value} أشهر لاحقة لم يستخدمها ({item}) وقارنها بالإجماليات الفعلية."],
    a2c_gd_past_3: ["The overall weighted error was {share} of recorded hotel arrivals. Lower is better.", "بلغ الخطأ المرجّح الإجمالي {share} من الوافدين المسجّلين إلى الفنادق، وكلما قلّ كان أفضل."],
    a2c_gd_past_4: ["The page also shows a longer test and a month-by-month chart.", "وتعرض الصفحة أيضًا اختبارًا أطول ورسمًا بيانيًا لكل شهر."],
    // Term guide.
    a2c_gd_terms_1: ["Term guide explains the words and numbers in Air2Stay in plain language.", "يشرح «دليل المصطلحات» كلمات Air2Stay وأرقامه بلغة مبسّطة."],
    a2c_gd_terms_2: ["You can search for a term, and print or save the guide as a PDF.", "يمكنك البحث عن مصطلح، وطباعة الدليل أو حفظه بصيغة PDF."],
    a2c_gd_terms_3: ["It also lists what the records don’t tell us, and how privacy and sharing work.", "ويوضح أيضًا ما لا تخبرنا به السجلات، وكيف تعمل الخصوصية والمشاركة."],
    // Statistics.
    a2c_gd_stats_1: ["Statistics puts your plan in context with charts:", "تضع «الإحصاءات» خطتك في سياقها من خلال رسوم بيانية:"],
    a2c_gd_stats_year: ["Guest nights through the year: your plan against each month’s baseline estimate.", "ليالي النزلاء على مدار العام: خطتك مقابل التقدير المرجعي لكل شهر."],
    a2c_gd_stats_markets: ["Largest departure markets in the selected month.", "أكبر أسواق المغادرة في الشهر المختار."],
    a2c_gd_stats_seats: ["Total seats by month across the included markets.", "إجمالي المقاعد حسب الشهر في الأسواق المشمولة."],
    a2c_gd_stats_share: ["The share of guests outside the 5 largest nationality groups.", "نسبة النزلاء من خارج أكبر 5 فئات للجنسيات."],
    // Messages.
    a2c_gd_msg_1: ["Messages lets you write, prioritise and keep track of messages to your team and partners.", "تتيح لك «الرسائل» كتابة الرسائل إلى فريقك وشركائك وترتيب أولويتها ومتابعتها."],
    a2c_gd_msg_2: ["Messages are saved in this browser and not emailed.", "تُحفظ الرسائل في هذا المتصفح ولا تُرسل بالبريد الإلكتروني."],
    a2c_gd_msg_3: ["Use Inbox, Sent and Drafts, filter by priority, or search.", "استخدم الوارد والمرسل والمسودات، أو صفِّ حسب الأولوية، أو ابحث."],
    a2c_gd_msg_4: ["When writing, AI Assist is a built-in drafting aid. No external AI service is called; review the text before sending.", "أثناء الكتابة، «المساعدة الذكية» أداة صياغة مدمجة لا تستدعي أي خدمة ذكاء اصطناعي خارجية؛ راجع النص قبل الإرسال."],
    // Export.
    a2c_gd_export_1: ["Export, on Plan a route, saves your plan as:", "يحفظ «تصدير» في «تخطيط المسار» خطتك بالصيغ التالية:"],
    a2c_gd_export_xlsx: ["An Excel report: dashboard, results, visitors, months and scenarios.", "تقرير Excel: لوحة ملخص ونتائج وزوار وأشهر وسيناريوهات."],
    a2c_gd_export_pdf: ["A PDF report with charts, ready to print or share.", "تقرير PDF مع رسوم بيانية، جاهز للطباعة أو المشاركة."],
    a2c_gd_export_csv: ["A model-ready CSV: inputs and simulated targets for this route across 12 months.", "ملف CSV جاهز للتدريب: مدخلات ونتائج محاكاة لهذا المسار على مدار 12 شهرًا."],
    a2c_gd_export_note: ["In Compare, the planning decision note can be saved as a PDF or downloaded as text.", "وفي «المقارنة» يمكن حفظ مذكرة قرار التخطيط بصيغة PDF أو تنزيلها كنص."],
    // New route, language, search, shortcuts.
    a2c_gd_new_1: ["To plan a country without past flights, open Adjust plan, choose + New route under Departure country, then choose and confirm the country.", "لتخطيط بلد لا توجد له رحلات سابقة، افتح «تعديل الخطة» واختر «+ مسار جديد» ضمن بلد المغادرة، ثم اختر البلد وأكّده."],
    a2c_gd_new_2: ["A new route starts from zero. Comparison countries supply starting assumptions only; they do not prove demand.", "يبدأ المسار الجديد من الصفر، وتوفّر البلدان المقارنة افتراضات أولية فقط ولا تثبت وجود طلب."],
    a2c_gd_lang_1: ["Use the English and العربية buttons at the top to switch the page language.", "استخدم زرَّي English والعربية في الأعلى لتغيير لغة الصفحة."],
    a2c_gd_lang_2: ["I reply in the language you write in, whatever the page language is.", "أرد باللغة التي تكتب بها، أيًّا كانت لغة الصفحة."],
    a2c_gd_search_1: ["Search at the top finds pages, plan views, controls, countries, months and terms. Press / to jump to it.", "يجد البحث في الأعلى الصفحات وعروض الخطة وأدوات التحكم والبلدان والأشهر والمصطلحات. اضغط / للانتقال إليه."],
    a2c_gd_search_2: ["Guide me, the book icon, opens Help & learning with short guides and plain-language answers.", "يفتح «أرشدني» (أيقونة الكتاب) قسم المساعدة والتعلّم، وفيه أدلة قصيرة وإجابات مبسّطة."],
    a2c_gd_rail_1: ["The shortcuts on the right edge open Tasks, Messages, Notifications and Statistics. Drag the dotted handle to move them up or down.", "تفتح الاختصارات على حافة الشاشة المهام والرسائل والإشعارات والإحصاءات، ويمكنك سحب المقبض المنقّط لتحريكها لأعلى أو لأسفل."],
    a2c_gd_rail_2: ["The bell at the top shows notifications and checks that need attention.", "يعرض الجرس في الأعلى الإشعارات وعمليات التحقق التي تحتاج إلى انتباه."],

    // Definitions.
    a2c_def_guest_1: ["A guest night is one guest staying for one night. One guest staying three nights counts as three guest nights.", "ليلة النزيل تعني نزيلًا واحدًا يقيم ليلة واحدة؛ فالنزيل الذي يقيم ثلاث ليالٍ يُحسب ثلاث ليالٍ."],
    a2c_def_guest_2: ["Guest nights count people, not hotel rooms.", "تُحسب ليالي النزلاء بعدد الأشخاص، لا بعدد الغرف الفندقية."],
    a2c_def_checkin: ["A hotel check-in is a guest arriving to begin a stay at a hotel.", "التسجيل الفندقي هو وصول نزيل لبدء إقامته في فندق."],
    a2c_def_range_1: ["The possible range gives lower and higher guides around the main estimate. Read it as a planning guide, not a guaranteed outcome.", "يعطي النطاق المحتمل حدًّا أدنى وأعلى حول التقدير الرئيسي، فاقرأه كدليل للتخطيط لا كنتيجة مضمونة."],
    a2c_def_range_2: ["For your plan it is {low} – {high}.", "وهو في خطتك {low} – {high}."],
    a2c_def_records_1: ["Matching past records shows how much flight history exists for this country and month.", "تُظهر السجلات السابقة المطابقة حجم سجل الرحلات المتاح لهذا البلد والشهر."],
    a2c_def_records_several: ["Several records: three or more.", "عدة سجلات: ثلاثة أو أكثر."],
    a2c_def_records_few: ["A few records: one or two.", "سجلات قليلة: سجل أو سجلان."],
    a2c_def_records_none: ["No route records: a new route that starts from fallback assumptions.", "لا توجد سجلات للمسار: مسار جديد يبدأ من افتراضات بديلة."],
    a2c_def_records_2: ["It describes the data available, not forecast accuracy.", "وهي تصف البيانات المتاحة، لا دقة التوقع."],
    a2c_def_load_1: ["How full a flight is: if 160 of 200 seats are filled, the flight is 80% full.", "نسبة إشغال الرحلة: إذا شُغل 160 مقعدًا من 200، فالرحلة ممتلئة بنسبة 80%."],
    a2c_def_your_plan: ["Your plan uses {share}.", "تستخدم خطتك {share}."],
    a2c_def_p2p: ["Passengers ending their trip in Abu Dhabi arrive here and do not continue to another destination. A traveller staying here is included; one changing planes is not.", "الركاب الذين تنتهي رحلتهم في أبوظبي يصلون إليها ولا يكملون إلى وجهة أخرى؛ فيُحتسب المسافر المقيم هنا، ولا يُحتسب من يغيّر الطائرة."],
    a2c_def_hotel: ["Hotel use is the share of passengers ending their trip in Abu Dhabi who check into a hotel.", "الإقامة الفندقية هي نسبة الركاب الذين تنتهي رحلتهم في أبوظبي ويسجّلون في فندق."],
    a2c_def_event: ["The event or season control adds extra hotel demand from 0% to 50%. It is your planning assumption, not measured from past events.", "يضيف إعداد الفعالية أو الموسم طلبًا فندقيًا إضافيًا من 0% إلى 50%، وهو افتراض تخطيطي من عندك وليس مقيسًا من فعاليات سابقة."],

    // Exports: plan report, Excel workbook, CSV and decision note.
    exp_export_language: ["Export language", "لغة التصدير"],
    exp_source_records: ["Past flight records and training-based hotel assumptions", "سجلات الرحلات السابقة وافتراضات فندقية مبنية على فترة التدريب"],
    exp_source_weighted: ["Weighted comparison countries: {item}", "بلدان مقارنة مرجّحة: {item}"],
    exp_source_single: ["Comparison country: {item}", "بلد المقارنة: {item}"],
    exp_available_markets: ["available markets", "الأسواق المتاحة"],
    exp_mixed_visitors: ["Mixed visitors", "زوار متنوعون"],
    exp_holiday_visitors: ["Holiday visitors", "زوار لقضاء العطلات"],
    exp_business_visitors: ["Business visitors", "زوار لأغراض العمل"],
    exp_usual_schedule: ["Usual weekly flight schedule", "الجدول الأسبوعي المعتاد للرحلات"],
    exp_schedule_change: ["{value} flights/week vs usual", "{value} رحلة أسبوعيًا مقارنةً بالمعتاد"],
    exp_plain_more: ["The plan estimates {value} more guest nights than usual in {month}.", "تقدّر الخطة {value} ليلة نزلاء أكثر من المعتاد في {month}."],
    exp_plain_fewer: ["The plan estimates {value} fewer guest nights than usual in {month}.", "تقدّر الخطة {value} ليلة نزلاء أقل من المعتاد في {month}."],
    exp_plain_none: ["The plan shows no change in estimated guest nights for {month} at the displayed precision.", "لا تُظهر الخطة أي تغيّر في ليالي النزلاء المقدّرة لشهر {month} بالدقة المعروضة."],
    exp_extra_flights_week: ["Extra flights per week", "الرحلات الإضافية أسبوعيًا"],
    exp_seats_per_flight: ["Seats per flight", "المقاعد لكل رحلة"],
    exp_flight_fullness: ["Flight fullness", "إشغال الرحلة"],
    exp_event_impact: ["Event impact", "أثر الفعالية"],
    exp_note_schedule: ["Relative to the usual schedule.", "مقارنةً بالجدول المعتاد."],
    exp_note_capacity: ["Aircraft capacity used for added or removed flights.", "سعة الطائرة المستخدمة للرحلات المضافة أو المحذوفة."],
    exp_note_occupied: ["Share of aircraft seats occupied.", "نسبة مقاعد الطائرة المشغولة."],
    exp_note_seasonal: ["Optional training-season aggregate rate.", "معدل موسمي إجمالي اختياري من فترة التدريب."],
    exp_note_hotel: ["Hotel-use assumption.", "افتراض الإقامة الفندقية."],
    exp_note_nights: ["Nights per hotel guest.", "الليالي لكل نزيل فندقي."],
    exp_note_event: ["User estimate of the effect on hotel demand.", "تقدير المستخدم لأثرها على الطلب الفندقي."],
    exp_limit_usual: ["Usual values estimate the baseline from past flights and hotel assumptions. Route-level hotel totals were not observed.", "تقدّر القيم المعتادة التقدير المرجعي من الرحلات السابقة وافتراضات الفنادق، ولم تُرصد إجماليات الفنادق على مستوى المسار."],
    exp_limit_new_route: ["The proposed route starts from zero. Comparison countries supply starting assumptions only, with no direct evidence of demand.", "يبدأ المسار المقترح من الصفر. وتوفّر البلدان المقارنة افتراضات أولية فقط، دون دليل مباشر على الطلب."],
    exp_limit_rooms: ["Guest nights count people staying overnight. Use guests per room and occupancy to translate guest nights into room needs.", "تحسب ليالي النزلاء الأشخاص الذين يبيتون ليلتهم. استخدم عدد النزلاء لكل غرفة ونسبة الإشغال لتحويل ليالي النزلاء إلى احتياج من الغرف."],
    exp_limit_nationality: ["Visitor nationality shares are estimated allocations. Departure country and guest nationality describe different things.", "نِسب جنسيات الزوار توزيعات تقديرية، وبلد المغادرة وجنسية النزيل أمران مختلفان."],
    exp_limit_range: ["The possible range is a history-based planning guide. It carries no guaranteed probability or route-level coverage.", "النطاق المحتمل دليل تخطيطي مبني على البيانات السابقة، ولا يحمل احتمالًا مضمونًا أو تغطية على مستوى المسار."],
    exp_limit_purpose: ["Travel purpose changes the model only when its assumptions are applied. The scenario does not predict bookings.", "لا يغيّر غرض السفر النموذج إلا عند تطبيق افتراضاته، والسيناريو لا يتنبأ بالحجوزات."],
    exp_limit_trials: ["Launch and lower-assumption trials illustrate what could happen under chosen inputs. Check demand and capacity before committing.", "توضح اختبارات الإطلاق والافتراضات الأدنى ما قد يحدث وفق المدخلات المختارة. تحقّق من الطلب والسعة قبل الالتزام."],
    exp_month_refreshed: ["Monthly starting assumptions refreshed as in Compare.", "تُحدَّث الافتراضات الأولية لكل شهر كما في «المقارنة»."],
    exp_month_fixed: ["Selected assumptions held fixed as in Compare.", "تبقى الافتراضات المختارة ثابتة كما في «المقارنة»."],
    exp_usual: ["Usual", "المعتاد"],
    exp_assumption: ["Assumption", "الافتراض"],
    exp_yes: ["Yes", "نعم"],
    exp_no: ["No", "لا"],
    exp_step: ["Step", "الخطوة"],
    exp_change: ["Change", "التغيّر"],
    exp_plan_scale: ["Plan scale", "مقياس الخطة"],
    exp_nationality: ["Nationality", "الجنسية"],
    exp_share_checkins: ["Share of check-ins", "نسبة التسجيلات"],
    exp_plan_guest_nights: ["Plan guest nights", "ليالي النزلاء في الخطة"],
    exp_plan_summary: ["Plan summary", "ملخص الخطة"],
    exp_plan_detail: ["Plan detail", "تفاصيل الخطة"],
    exp_selected_value: ["Selected value", "القيمة المختارة"],
    exp_weekly_schedule: ["Weekly flight schedule", "جدول الرحلات الأسبوعي"],
    exp_travel_purpose: ["Travel purpose", "غرض السفر"],
    exp_starting_values: ["Starting values", "القيم الأولية"],
    exp_prepared_by: ["Prepared by", "أعدّه"],
    exp_name_missing: ["Name not supplied", "لم يُذكر الاسم"],
    exp_result: ["Result", "النتيجة"],
    exp_change_percent: ["Change %", "نسبة التغيّر"],
    exp_plain_words: ["In plain words", "بعبارة مبسّطة"],
    exp_starting_defaults: ["Starting values are the defaults for this route and month.", "القيم الأولية هي القيم الافتراضية لهذا المسار والشهر."],
    exp_your_plan_value: ["Your plan value", "قيمة خطتك"],
    exp_visitors: ["Visitors", "الزوار"],
    exp_visitors_sorted: ["Nationality groups sorted by planned guest nights.", "فئات الجنسيات مرتّبة حسب ليالي النزلاء في الخطة."],
    exp_usual_nights: ["Usual nights", "الليالي المعتادة"],
    exp_plan_nights: ["Plan nights", "ليالي الخطة"],
    exp_share_scale: ["Share scale", "مقياس النسبة"],
    exp_total: ["Total", "الإجمالي"],
    exp_by_month_title: ["Guest nights by month", "ليالي النزلاء حسب الشهر"],
    exp_by_month_note: ["Uses the current plan inputs with each month's usual baseline, as in Statistics.", "تستخدم مدخلات الخطة الحالية مع التقدير المرجعي المعتاد لكل شهر، كما في «الإحصاءات»."],
    exp_usual_guest_nights: ["Usual guest nights", "ليالي النزلاء المعتادة"],
    exp_compare_scenarios: ["Compare scenarios", "مقارنة السيناريوهات"],
    exp_flight_impact_note: ["Flight impact compares each option with zero extra flights at the same assumptions.", "يقارن أثر الرحلات كل خيار بعدم إضافة رحلات وفق الافتراضات نفسها."],
    exp_launch_size: ["Launch size", "حجم الإطلاق"],
    exp_flights_week: ["Extra flights / week", "الرحلات الإضافية / أسبوع"],
    exp_same_flights: ["The same flights in every month", "الرحلات نفسها في كل شهر"],
    exp_guest_night_scale: ["Guest-night scale", "مقياس ليالي النزلاء"],
    exp_yield_scale: ["Yield scale", "مقياس العائد"],
    exp_dashboard: ["Dashboard", "لوحة المؤشرات"],
    exp_summary: ["Summary", "الملخص"],
    exp_by_month: ["By month", "حسب الشهر"],
    exp_current_settings: ["Current plan settings", "إعدادات الخطة الحالية"],
    exp_no_flight_change: ["No weekly flight change", "دون تغيير في الرحلات الأسبوعية"],
    exp_current_proposal: ["Current proposal", "المقترح الحالي"],
    exp_extra_flights: ["Extra flights", "رحلات إضافية"],
    exp_current_proposal_country: ["Current proposal · {country}", "المقترح الحالي · {country}"],
    exp_extra_flights_country: ["Extra flights · {country}", "رحلات إضافية · {country}"],
    exp_your_month: ["◀ your month", "▶ شهرك"],
    exp_created_on: ["Created by Air2Stay on {date}", "أنشأه Air2Stay في {date}"],
    // Decision note.
    exp_dn_title: ["Air2Stay planning decision note", "مذكرة قرار التخطيط من Air2Stay"],
    exp_dn_summary: ["{route} in {month}: {count} extra weekly flights produce an estimated {value} additional hotel check-ins and {estimate} additional guest nights, compared with zero extra flights using the same assumptions.", "{route} في {month}: تنتج {count} رحلة أسبوعية إضافية نحو {value} تسجيلًا فندقيًا إضافيًا و{estimate} ليلة نزلاء إضافية، مقارنةً بعدم إضافة رحلات وفق الافتراضات نفسها."],
    exp_dn_plan_for: ["Plan for about {value} extra guest nights in {month} under the selected assumptions.", "خطّط لنحو {value} ليلة نزلاء إضافية في {month} وفق الافتراضات المختارة."],
    exp_dn_reduction: ["The flight reduction implies about {value} fewer guest nights in {month} under the selected assumptions.", "يعني خفض الرحلات نحو {value} ليلة نزلاء أقل في {month} وفق الافتراضات المختارة."],
    exp_dn_no_added: ["No added guest nights are estimated because this plan adds no flight capacity.", "لا تُقدَّر ليالي نزلاء إضافية لأن هذه الخطة لا تضيف سعة رحلات."],
    exp_dn_lower_trial: ["The combined lower-assumption trial gives {value} guest nights from the flight change. This is an illustrative check, not a probability bound.", "يعطي اختبار الافتراضات الأدنى مجتمعةً {value} ليلة نزلاء من تغيير الرحلات. وهذا فحص توضيحي، وليس حدًّا احتماليًا."],
    exp_dn_driver: ["{item} has the largest effect in the individual lower-assumption trials tested: about {value} guest nights. The trial sizes differ.", "{item} له أكبر أثر في التجارب الفردية للافتراضات الأدنى: نحو {value} ليلة نزلاء. وتختلف أحجام التجارب."],
    exp_dn_check_airline: ["Ask the airline for expected bookings and flight occupancy for the proposed schedule.", "اطلب من شركة الطيران الحجوزات المتوقعة ونسبة إشغال الرحلات للجدول المقترح."],
    exp_dn_check_hotels: ["Check with tourism and hotel teams how many visitors are likely to choose hotels rather than other accommodation.", "تحقّق مع فرق السياحة والفنادق من عدد الزوار المرجّح أن يختاروا الفنادق بدلًا من أماكن الإقامة الأخرى."],
    exp_dn_check_stay: ["Check the assumed stay length with hotels and comparable visitor records for the selected month.", "تحقّق من مدة الإقامة المفترضة مع الفنادق وسجلات الزوار المماثلة للشهر المختار."],
    exp_dn_choose_positive: ["Choose a positive added-flight schedule before comparing which visitor assumption changes its result most.", "اختر جدولًا بعدد موجب من الرحلات المضافة قبل مقارنة افتراضات الزوار الأكثر تأثيرًا في النتيجة."],
    exp_dn_at_limits: ["The assumptions are at the trial limits; review the selected values with airlines and hotels before acting.", "الافتراضات عند حدود الاختبار؛ راجع القيم المختارة مع شركات الطيران والفنادق قبل اتخاذ أي إجراء."],
    exp_dn_caution: ["Guest nights count nights spent by people, not rooms. Confirm passenger demand and hotel capacity before committing to the proposal.", "تحسب ليالي النزلاء الليالي التي يقضيها الأشخاص، لا الغرف. تأكّد من طلب الركاب والسعة الفندقية قبل الالتزام بالمقترح."],
    exp_dn_no_option: ["No option has positive added seats, so there is no added-seat yield ranking.", "لا يتضمن أي خيار مقاعد مضافة موجبة، لذلك لا يوجد ترتيب للعائد لكل مقعد مضاف."],
    exp_dn_tie: ["The leading options tie on guest nights per 1,000 added seats under the supplied assumptions.", "تتساوى الخيارات المتصدّرة في ليالي النزلاء لكل 1,000 مقعد مضاف وفق الافتراضات المقدّمة."],
    exp_dn_highest: ["{item} has the highest assumed guest nights per 1,000 added seats.", "يحقق {item} أعلى عدد مفترض من ليالي النزلاء لكل 1,000 مقعد مضاف."],
    exp_dn_lead_holds: ["Its lead holds across the lower-assumption trials tested; this does not establish which route will perform best in practice.", "يبقى متصدّرًا في اختبارات الافتراضات الأدنى؛ ولا يثبت ذلك أي مسار سيحقق أفضل أداء فعليًا."],
    exp_dn_ranking_changes: ["The ranking changes in these trials: {trials}. Check the assumptions behind those reversals before advancing an option.", "يتغيّر الترتيب في هذه الاختبارات: {trials}. تحقّق من الافتراضات وراء هذا التغيّر قبل المضي في أي خيار."],
    exp_dn_route_purpose: ["Route purpose: {item}", "غرض المسار: {item}"],
    exp_dn_extra_flights: ["Extra flights per week: {value}", "الرحلات الإضافية أسبوعيًا: {value}"],
    exp_dn_seats: ["Seats per flight: {value}", "المقاعد لكل رحلة: {value}"],
    exp_dn_occupancy: ["Flight occupancy: {share}", "نسبة إشغال الرحلات: {share}"],
    exp_dn_p2p: ["Passengers ending in Abu Dhabi: {share}", "الركاب الذين تنتهي رحلتهم في أبوظبي: {share}"],
    exp_dn_hotel_use: ["Hotel use: {share}", "الإقامة الفندقية: {share}"],
    exp_dn_stay: ["Nights per hotel stay: {value}", "الليالي لكل إقامة فندقية: {value}"],
    exp_dn_event: ["Extra event demand: {share}", "الطلب الإضافي للفعاليات: {share}"],
    exp_dn_compared: ["Compared options (each versus zero extra flights)", "الخيارات المقارنة (كل منها مقابل عدم إضافة رحلات)"],
    exp_dn_option_inputs: ["Flights/week: {count}; seats/flight: {value}; fullness: {share}; ending-trip share: {low}; hotel use: {high}; nights/stay: {estimate}; event assumption: {uplift}.", "الرحلات/أسبوع: {count}؛ المقاعد/رحلة: {value}؛ الإشغال: {share}؛ نسبة من تنتهي رحلتهم: {low}؛ الإقامة الفندقية: {high}؛ الليالي/إقامة: {estimate}؛ افتراض الفعالية: {uplift}."],
    exp_dn_option_results: ["Additional check-ins: {count}; additional guest nights: {value}; guest nights/1,000 added seats: {estimate}.", "التسجيلات الإضافية: {count}؛ ليالي النزلاء الإضافية: {value}؛ ليالي النزلاء/1,000 مقعد مضاف: {estimate}."],
    exp_dn_option_results_na: ["Additional check-ins: {count}; additional guest nights: {value}; guest nights/1,000 added seats: not applicable.", "التسجيلات الإضافية: {count}؛ ليالي النزلاء الإضافية: {value}؛ ليالي النزلاء/1,000 مقعد مضاف: غير منطبق."],
    exp_dn_peer_weights: ["Starting comparison weights: {item}. Geographic assumptions only.", "الأوزان الأولية للبلدان المقارنة: {item}. افتراضات جغرافية فقط."],
    exp_dn_existing_market: ["Existing-market or explicitly selected single-market starting assumptions.", "افتراضات أولية من سوق قائم أو من سوق واحد محدّد صراحةً."],
    exp_dn_stress: ["With flights 10 percentage points less full, hotel use 5 points lower and stays 0.5 nights shorter, within the allowed controls, the capacity effect becomes {value} extra guest nights.", "مع خفض إشغال الرحلات 10 نقاط مئوية، والإقامة الفندقية 5 نقاط، وتقصير الإقامات 0.5 ليلة، ضمن الحدود المسموح بها، يصبح أثر السعة {value} ليلة نزلاء إضافية."],
    exp_dn_driver_summary: ["Of the individual trials tested, “{item}” changes the capacity effect most, by {value} guest nights. Trial sizes differ; this is a reason to check that assumption, not a ranking of real-world certainty.", "من بين التجارب الفردية، يغيّر «{item}» أثر السعة أكثر من غيره، بمقدار {value} ليلة نزلاء. وتختلف أحجام التجارب؛ وهذا سبب للتحقق من ذلك الافتراض، وليس ترتيبًا ليقين واقعي."],
    exp_dn_no_driver: ["The individual lower-assumption trials do not change the added-flight result at this setting. There is no leading assumption to report from these trials.", "لا تغيّر اختبارات الافتراضات الأدنى الفردية نتيجة الرحلات المضافة عند هذا الإعداد، ولا يوجد افتراض متصدّر يمكن الإبلاغ عنه من هذه الاختبارات."],
    exp_dn_next_checks: ["Next checks", "عمليات التحقق التالية"],
    exp_dn_limits: ["Limits", "الحدود"],
    exp_dn_step_airline: ["With the airline or airport, confirm weekly flights, aircraft seats, expected bookings and flight occupancy; check how many arrivals will finish their journey in Abu Dhabi and how many will be residents returning home.", "مع شركة الطيران أو المطار، أكّد الرحلات الأسبوعية ومقاعد الطائرات والحجوزات المتوقعة ونسبة إشغال الرحلات؛ وتحقّق من عدد الواصلين الذين ستنتهي رحلتهم في أبوظبي وعدد المقيمين العائدين إلى ديارهم."],
    exp_dn_step_hotels: ["With hotels, check expected hotel use, typical stay length and available capacity in the selected month. Confirm guests per occupied room before translating guest nights into rooms or staffing.", "مع الفنادق، تحقّق من الإقامة الفندقية المتوقعة ومدة الإقامة المعتادة والسعة المتاحة في الشهر المختار. وأكّد عدد النزلاء لكل غرفة مشغولة قبل تحويل ليالي النزلاء إلى غرف أو احتياجات توظيف."],
    exp_dn_limit_scenario: ["These are scenario estimates, not observed route-level hotel outcomes or an independent forecast of passenger demand.", "هذه تقديرات سيناريو، وليست نتائج فندقية مرصودة على مستوى المسار ولا توقعًا مستقلًا لطلب الركاب."],
    exp_dn_limit_new_route: ["A new route starts from zero. Comparison markets provide starting assumptions only.", "يبدأ المسار الجديد من الصفر، وتوفّر الأسواق المقارنة افتراضات أولية فقط."],
    exp_dn_limit_assumptions: ["The event increase and route purpose are planner assumptions. Purpose has no automatic numerical preset.", "زيادة الفعالية وغرض المسار افتراضات يضعها المخطِّط، ولا يرتبط الغرض بأي قيم رقمية تلقائية."],
    exp_dn_limit_trials: ["Lower-assumption trials are illustrative tests, not statistical probabilities or commercial break-even tests.", "اختبارات الافتراضات الأدنى اختبارات توضيحية، وليست احتمالات إحصائية ولا اختبارات لنقطة التعادل التجارية."],
    exp_dn_peer_heading: ["Comparison-country starting weights", "الأوزان الأولية للبلدان المقارنة"],
    exp_dn_peer_note: ["Geographic assumptions only; not measured route demand.", "افتراضات جغرافية فقط؛ وليست طلبًا مقاسًا على المسار."],
    exp_dn_capacity_check: ["Capacity target check", "فحص هدف السعة"],
    // Remaining interface text found by the audit.
    ui_reach_target_label: ["Reach a hotel-night target", "تحقيق هدف الليالي الفندقية"],
    ui_search_help: ["Search help", "البحث في المساعدة"],
    ui_next_action: ["Next action", "الإجراء التالي"],
    ui_chart_guest_nights: ["Guest nights.", "ليالي النزلاء."],
    ui_chart_flight_seats: ["Flight seats.", "مقاعد الرحلات."],
    ui_chart_baseline: ["Baseline estimate: {item}", "التقدير المرجعي: {item}"],
    ui_chart_your_plan: ["Your plan: {item}", "خطتك: {item}"],
    ui_chart_past_seats: ["Past flight seats: {item}", "مقاعد الرحلات السابقة: {item}"],
    ui_chart_usual: ["Usual: {item}", "المعتاد: {item}"],
    ui_unit_seats: ["{value} seats", "{value} مقعدًا"],
    ui_period_training: ["2022-01 to 2024-12", "2022-01 إلى 2024-12"],
    ui_period_validation: ["2025-01 to 2025-07", "2025-01 إلى 2025-07"],
    ui_period_daily: ["2025-05-01 to 2025-07-31", "2025-05-01 إلى 2025-07-31"],
    ui_assignment: ["{from} → {to}", "{from} → {to}"],
    ui_download_word: ["Download", "تنزيل"],
    ui_next_action_label: ["Next action · {country} · {month}", "الإجراء التالي · {country} · {month}"],
    ui_tip_p2p: ["Trip-ending share: passengers ending their air journey in Abu Dhabi, rather than connecting to another flight.", "نسبة من تنتهي رحلتهم: الركاب الذين تنتهي رحلتهم الجوية في أبوظبي بدلًا من مواصلة السفر على رحلة أخرى."],
    ui_tip_hotel: ["Hotel use: the assumed share of trip-ending passengers who check into a hotel. It is not directly measured for each proposed route.", "الإقامة الفندقية: النسبة المفترضة من الركاب الذين تنتهي رحلتهم ويسجّلون في فندق، ولا تُقاس مباشرةً لكل مسار مقترح."],
    ui_tip_stay: ["Average nights per hotel guest. Guest nights are different from occupied rooms because people may share a room.", "متوسط الليالي لكل نزيل فندقي. تختلف ليالي النزلاء عن الغرف المشغولة لأن الأشخاص قد يتشاركون الغرفة."],
    ui_tip_event: ["A demand increase you assume for an event or season. It is not a measured effect from event data.", "زيادة في الطلب تفترضها لفعالية أو موسم، وليست أثرًا مقيسًا من بيانات الفعاليات."],
    ui_tip_purpose: ["Choosing a purpose labels the proposal; it does not change results until separate assumptions are applied.", "اختيار الغرض يصنّف المقترح فقط، ولا يغيّر النتائج حتى تُطبَّق افتراضات منفصلة."],

    // Audit fixes: guide panel, comparison-country notes and status messages.
    aud_1: ["Focus opened", "فتح «ملخص»"],
    aud_2: ["Details opened", "فتح «التفاصيل»"],
    aud_3: ["Chat opened", "فتح المحادثة"],
    aud_4: ["Compare opened", "فتح «المقارنة»"],
    aud_5: ["Proposal actions opened", "فتح إجراءات المقترح"],
    aud_6: ["Plan adjusted", "تعديل الخطة"],
    aud_7: ["Chat question sent", "إرسال سؤال في المحادثة"],
    aud_8: ["Spreadsheet exported", "تصدير جدول البيانات"],
    aud_9: ["Full plan exported", "تصدير الخطة كاملة"],
    aud_10: ["Decision note exported", "تصدير مذكرة القرار"],
    aud_11: ["Proposal saved", "حفظ المقترح"],
    aud_12: ["Proposal comment added", "إضافة تعليق على المقترح"],
    aud_13: ["Proposal action updated", "تحديث إجراء في المقترح"],
    aud_14: ["Stakeholder update drafted", "صياغة تحديث لأصحاب المصلحة"],
    aud_15: ["Proposal version restored", "استعادة نسخة من المقترح"],
    aud_16: ["Plan a route opened", "فتح «تخطيط المسار»"],
    aud_17: ["Visitor mix opened", "فتح «توزيع الزوار»"],
    aud_18: ["Past results opened", "فتح «النتائج السابقة»"],
    aud_19: ["Term guide opened", "فتح «دليل المصطلحات»"],
    aud_20: ["Help opened", "فتح المساعدة"],
    aud_21: ["Proposal workspace opened", "فتح مساحة عمل المقترح"],
    aud_22: ["Plan exported", "تصدير الخطة"],
    aud_23: ["How do I create a new route?", "كيف أنشئ مسارًا جديدًا؟"],
    aud_24: ["Choose + New route under Departure country, then choose and confirm the country.", "اختر «+ مسار جديد» ضمن بلد المغادرة، ثم اختر البلد وأكّده."],
    aud_25: ["What does the baseline mean?", "ماذا يعني التقدير المرجعي؟"],
    aud_26: ["What is a guest night?", "ما ليلة النزيل؟"],
    aud_27: ["How are hotel nights worked out?", "كيف تُحسب الليالي الفندقية؟"],
    aud_28: ["Why these comparison countries?", "لماذا هذه البلدان المقارنة؟"],
    aud_29: ["What does Matching past records mean?", "ماذا تعني «السجلات السابقة المطابقة»؟"],
    aud_30: ["What does the possible range mean?", "ماذا يعني النطاق المحتمل؟"],
    aud_31: ["What did the accuracy score test?", "ماذا اختبرت درجة الدقة؟"],
    aud_32: ["What does Compare help me decide?", "بماذا تساعدني «المقارنة» في اتخاذ القرار؟"],
    aud_33: ["What are the event and travel-purpose controls?", "ما إعدادات الفعالية وغرض السفر؟"],
    aud_34: ["What does Visitor mix show?", "ماذا يعرض «توزيع الزوار»؟"],
    aud_35: ["What should I verify before acting?", "ما الذي يجب أن أتحقق منه قبل اتخاذ أي إجراء؟"],
    aud_36: ["What can I ask Air2Stay?", "ماذا يمكنني أن أسأل Air2Stay؟"],
    aud_37: ["Ask how the current estimate was calculated, what changed, or what to check next. You can also request a country, month or flight change, such as “Add 3 flights from France in December”. Check the values the app actually applied; use the controls for other assumptions.", "اسأل كيف حُسب التقدير الحالي، أو ما الذي تغيّر، أو ما الذي يجب التحقق منه بعد ذلك. ويمكنك أيضًا طلب تغيير البلد أو الشهر أو الرحلات، مثل «أضف 3 رحلات من فرنسا في ديسمبر». تحقّق من القيم التي طبّقها التطبيق فعلًا، واستخدم أدوات التحكم للافتراضات الأخرى."],
    aud_38: ["Where can I keep or share a result?", "أين يمكنني حفظ نتيجة أو مشاركتها؟"],
    aud_39: ["What do red, amber and green mean?", "ماذا تعني الألوان الأحمر والأصفر والأخضر؟"],
    aud_40: ["Will assigning an action notify my teammate?", "هل يُرسل تعيين إجراء إشعارًا إلى زميلي؟"],
    aud_41: ["Create your first plan", "أنشئ خطتك الأولى"],
    aud_42: ["Choose a market, change capacity and read the effect.", "اختر سوقًا، وغيّر السعة، واقرأ الأثر."],
    aud_43: ["Choose the departure market", "اختر سوق المغادرة"],
    aud_44: ["Choose the month", "اختر الشهر"],
    aud_45: ["Set the extra flights", "اضبط الرحلات الإضافية"],
    aud_46: ["Read the result", "اقرأ النتيجة"],
    aud_47: ["Decide what to check", "حدّد ما يجب التحقق منه"],
    aud_48: ["Explore a new country", "استكشف بلدًا جديدًا"],
    aud_49: ["Understand confirmation and comparison-country assumptions.", "افهم التأكيد وافتراضات البلدان المقارنة."],
    aud_50: ["Choose + New route", "اختر «+ مسار جديد»"],
    aud_51: ["Choose and confirm a country", "اختر بلدًا وأكّده"],
    aud_52: ["Set a proposed schedule", "اضبط جدولًا مقترحًا"],
    aud_53: ["Inspect the comparison countries", "افحص البلدان المقارنة"],
    aud_54: ["Compare an alternative", "قارن بديلًا"],
    aud_55: ["Understand the numbers", "افهم الأرقام"],
    aud_56: ["Trace estimates, evidence and uncertainty.", "تتبّع التقديرات والأدلة وعدم اليقين."],
    aud_57: ["Read the baseline label", "اقرأ وصف التقدير المرجعي"],
    aud_58: ["Open the calculation", "افتح طريقة الحساب"],
    aud_59: ["Test what matters", "اختبر ما يهم"],
    aud_60: ["Understand the accuracy test", "افهم اختبار الدقة"],
    aud_61: ["Prepare a planning decision", "جهّز قرار تخطيط"],
    aud_62: ["Compare routes, test a weaker outcome and export a note.", "قارن المسارات، واختبر نتيجة أضعف، وصدّر مذكرة."],
    aud_63: ["Choose an alternative route", "اختر مسارًا بديلًا"],
    aud_64: ["Compare launch sizes", "قارن أحجام الإطلاق"],
    aud_65: ["Test a weaker outcome", "اختبر نتيجة أضعف"],
    aud_66: ["Work backwards from a target", "احسب عكسيًا من هدف"],
    aud_67: ["Review and export the note", "راجع المذكرة وصدّرها"],
    aud_68: ["Follow up a proposal", "تابع مقترحًا"],
    aud_69: ["Record checks, evidence, discussion and stakeholder drafts.", "سجّل عمليات التحقق والأدلة والنقاش ومسودات أصحاب المصلحة."],
    aud_70: ["Read the priority checks", "اقرأ عمليات التحقق ذات الأولوية"],
    aud_71: ["Add a task", "أضف مهمة"],
    aud_72: ["Assign and track the check", "عيّن عملية التحقق وتابعها"],
    aud_73: ["Keep a proposal version", "احتفظ بنسخة من المقترح"],
    aud_74: ["Review a stakeholder draft", "راجع مسودة لأصحاب المصلحة"],
    aud_75: ["Optional online AI. Enabling it sends your question, recent chat and selected proposal context to Gemini.", "ذكاء اصطناعي اختياري عبر الإنترنت. تفعيله يرسل سؤالك والمحادثة الأخيرة وسياق المقترح المختار إلى Gemini."],
    aud_76: ["Find an answer", "ابحث عن إجابة"],
    aud_77: ["Use Compare to prepare a decision note.", "استخدم «المقارنة» لإعداد مذكرة قرار."],
    aud_78: ["Feedback and optional usage counts on this page stay in this browser. They are not shared with a team or sent to an analytics service. Browser clearing can erase them. This is usage guidance, not an organisation’s formal policy.", "تبقى الملاحظات وأعداد الاستخدام الاختيارية في هذه الصفحة داخل هذا المتصفح، ولا تُشارك مع فريق ولا تُرسل إلى خدمة تحليلات، وقد يمحوها مسح بيانات المتصفح. هذه إرشادات للاستخدام، وليست سياسة رسمية لأي جهة."],
    aud_79: ["Mark an answer or recommendation as helpful, or record a problem. The latest 100 feedback entries stay on this browser only; they are not support tickets.", "حدّد إجابة أو توصية بأنها مفيدة، أو سجّل مشكلة. تبقى آخر 100 ملاحظة في هذا المتصفح فقط، وليست طلبات دعم."],
    aud_80: ["Feedback saved in this browser", "الملاحظات المحفوظة في هذا المتصفح"],
    aud_81: ["Clear local feedback", "مسح الملاحظات المحلية"],
    aud_82: ["Allow local feature counts on this browser", "السماح بعدّ الميزات محليًا في هذا المتصفح"],
    aud_83: ["Off by default. When enabled, only fixed feature names and counts are saved. Search words, questions, answers, proposal values and identities are not recorded here. Turning it off stops new counts; clearing removes existing counts.", "متوقف افتراضيًا. عند التفعيل تُحفظ أسماء ميزات ثابتة وأعدادها فقط، ولا تُسجَّل كلمات البحث أو الأسئلة أو الإجابات أو قيم المقترح أو الهويات. إيقافه يوقف العدّ الجديد، والمسح يحذف الأعداد الحالية."],
    aud_84: ["Clear usage counts", "مسح أعداد الاستخدام"],
    aud_85: ["No feature counts yet. Use a guide or another feature to begin.", "لا توجد أعداد للميزات بعد. استخدم دليلًا أو ميزة أخرى للبدء."],
    aud_86: ["Feature counting is off. Nothing is tracked by this panel until you turn it on.", "عدّ الميزات متوقف، ولا يتتبّع هذا القسم أي شيء حتى تفعّله."],
    aud_87: ["Local feature counts are on.", "عدّ الميزات المحلي مفعّل."],
    aud_88: ["Local feature counts are off.", "عدّ الميزات المحلي متوقف."],
    aud_89: ["{count} answers available", "{count} إجابة متاحة"],
    aud_90: ["{count} answers found", "{count} إجابة مطابقة"],
    aud_91: ["{count} answer available", "{count} إجابة متاحة"],
    aud_92: ["{count} answer found", "{count} إجابة مطابقة"],
    aud_93: ["· {count} steps", "· {count} خطوات"],
    aud_94: ["About: {item}", "بخصوص: {item}"],
    aud_95: ["Feedback on {item}", "ملاحظات حول {item}"],
    aud_96: ["{item} · {value} of {count}", "{item} · {value} من {count}"],
    aud_97: ["Help for your current plan: {route}, {month}.", "مساعدة لخطتك الحالية: {route}، {month}."],
    aud_98: ["Help for your current plan: {route}.", "مساعدة لخطتك الحالية: {route}."],
    aud_99: ["(download)", "(تنزيل)"],
    aud_100: ["(opens in a new tab)", "(يُفتح في علامة تبويب جديدة)"],
    aud_101: ["What happened?", "ماذا حدث؟"],
    aud_102: ["Save feedback", "حفظ الملاحظات"],
    aud_103: ["Describe what you expected and what happened. Avoid personal or confidential details.", "صِف ما توقعته وما حدث، وتجنّب ذكر تفاصيل شخصية أو سرية."],
    aud_104: ["Reference document downloads are unavailable in this copy.", "تنزيل المستندات المرجعية غير متاح في هذه النسخة."],
    aud_105: ["No feedback saved yet.", "لا توجد ملاحظات محفوظة بعد."],
    aud_106: ["This page could not be opened. Exit the guide and use the page tabs, then try again.", "تعذّر فتح هذه الصفحة. اخرج من الدليل واستخدم علامات تبويب الصفحات، ثم حاول مرة أخرى."],
    aud_107: ["Browser storage is unavailable. Feedback and counts can be shown for this visit, but may be lost when the page closes. Export your important proposal notes separately.", "تخزين المتصفح غير متاح. يمكن عرض الملاحظات والأعداد خلال هذه الزيارة، لكنها قد تُفقد عند إغلاق الصفحة. صدّر ملاحظات المقترح المهمة بشكل منفصل."],
    aud_108: ["Problem reported", "تم الإبلاغ عن مشكلة"],
    aud_109: ["Data dictionary (current app)", "قاموس البيانات (التطبيق الحالي)"],
    aud_110: ["Usage and data-handling guidance", "إرشادات الاستخدام والتعامل مع البيانات"],
    aud_111: ["Geographic proximity and approximate route length do not establish similar demand, income, travel purpose or visa conditions.", "القرب الجغرافي وطول المسار التقريبي لا يثبتان تشابه الطلب أو الدخل أو غرض السفر أو شروط التأشيرة."],
    aud_112: ["Locations are country centroids, not airport coordinates; route lengths are approximate.", "المواقع هي مراكز البلدان وليست إحداثيات المطارات، وأطوال المسارات تقريبية."],
    aud_113: ["Visitor shares and stay lengths are estimated allocations, not observed hotel outcomes for the proposed route.", "نِسب الزوار ومدد الإقامة توزيعات تقديرية، وليست نتائج فندقية مرصودة للمسار المقترح."],
    aud_114: ["The overall hotel-conversion rate is a shared assumption; it is not learned separately for each comparison country.", "معدل التحويل الفندقي الإجمالي افتراض مشترك، ولا يُستخلص لكل بلد مقارنة على حدة."],
    aud_115: ["Three-market geographic starting profile", "ملف أولي جغرافي من ثلاثة أسواق"],
    aud_116: ["No valid country location is available; choose a country from the reference list.", "لا يتوفر موقع صالح للبلد؛ اختر بلدًا من القائمة المرجعية."],
    aud_117: ["No comparison markets with flight records and coordinates are available for this month.", "لا توجد أسواق مقارنة لها سجلات رحلات وإحداثيات في هذا الشهر."],
    aud_118: ["Up to three markets in the same month; weighted by country-centroid proximity and approximate route-length similarity.", "حتى ثلاثة أسواق في الشهر نفسه، مرجّحة حسب قرب مراكز البلدان وتشابه طول المسار التقريبي."],
    aud_119: ["Comparison country", "بلد المقارنة"],
    aud_120: ["Weight", "الوزن"],
    aud_121: ["Centroid distance", "المسافة بين المراكز"],
    aud_122: ["Route-length gap", "فرق طول المسار"],
    aud_123: ["scoreKm = centroid distance + 0.5 × route-length gap; weight ∝ 1 / (500 + scoreKm). The design weights were not fitted to hotel outcomes.", "scoreKm = المسافة بين المراكز + 0.5 × فرق طول المسار؛ الوزن ∝ 1 / (500 + scoreKm). ولم تُضبط أوزان التصميم وفق النتائج الفندقية."],
    aud_124: ["Blend three comparison countries", "مزج ثلاثة بلدان مقارنة"],
    aud_125: ["Correct the highlighted plan input before applying visitor assumptions.", "صحّح قيمة الخطة المظلّلة قبل تطبيق افتراضات الزوار."],
    aud_126: ["Your visitor assumptions are applied. The historical baseline is unchanged.", "طُبّقت افتراضات الزوار التي حددتها، ولم يتغير التقدير المرجعي التاريخي."],
    aud_127: ["Decision note exported with assumptions, stress trials and next checks.", "صُدّرت مذكرة القرار مع الافتراضات واختبارات الضغط وعمليات التحقق التالية."],
    aud_128: ["Saved assumptions restored. Checks must match these exact values.", "استُعيدت الافتراضات المحفوظة. يجب أن تطابق عمليات التحقق هذه القيم بالضبط."],
    aud_129: ["Label selected. Numbers change only when you apply your assumptions.", "تم اختيار التصنيف. لا تتغير الأرقام إلا عند تطبيق افتراضاتك."],
    aud_130: ["Download {name}", "تنزيل {name}"],
    aud_131: ["Could not open the shared plan: {item}", "تعذّر فتح الخطة المشتركة: {item}"],
    aud_132: ["View or copy history JSON", "عرض سجل JSON أو نسخه"],
    aud_133: ["History JSON", "سجل JSON"],
    aud_134: ["Earlier assumptions · this message may describe different numbers", "افتراضات سابقة · قد تصف هذه الرسالة أرقامًا مختلفة"],
    aud_135: ["AI explanation · check against Details", "شرح بالذكاء الاصطناعي · تحقّق منه في «التفاصيل»"],
    aud_136: ["Saved explanation for the earlier plan", "شرح محفوظ للخطة السابقة"],
    aud_137: ["From this plan and its recorded checks", "من هذه الخطة وعمليات التحقق المسجّلة لها"],
    aud_138: ["Plan explanations and clear change commands work locally. Optional Gemini answers can help with other questions when you enable them below.", "تعمل شروح الخطة وأوامر التغيير الواضحة محليًا. ويمكن لإجابات Gemini الاختيارية المساعدة في أسئلة أخرى عند تفعيلها أدناه."],
    aud_139: ["Local planning assistant · explanations and clear change commands work without internet. Gemini is not configured in this copy.", "مساعد تخطيط محلي · تعمل الشروح وأوامر التغيير الواضحة دون إنترنت. لم يُضبط Gemini في هذه النسخة."],
    aud_140: ["Describe a change or ask a question. The current result stays beside your conversation.", "صِف تغييرًا أو اطرح سؤالًا. تبقى النتيجة الحالية بجانب محادثتك."],
    // Audit fixes: guide panel, comparison-country notes and status messages.
    ns_1: ["Decision readiness: {count} of {value} checks have recorded evidence.", "جاهزية القرار: {count} من {value} عمليات تحقق لها أدلة مسجّلة."],
    ns_2: ["No recorded evidence yet", "لا توجد أدلة مسجّلة بعد"],
    ns_3: ["All checks have recorded evidence for these exact assumptions. You can finish with a planning decision.", "جميع عمليات التحقق لها أدلة مسجّلة لهذه الافتراضات بالضبط. يمكنك الآن إنهاء التخطيط بقرار."],
    ns_4: ["All checks have recorded evidence for these exact assumptions.", "جميع عمليات التحقق لها أدلة مسجّلة لهذه الافتراضات بالضبط."],
    ns_5: ["{item}: {value}, borrowed from comparison countries because this route has no flight history.", "قيمة {item} هي {value}، وهي مستعارة من البلدان المقارنة لأن هذا المسار ليس له سجل رحلات."],
    ns_6: ["{item}: {value}, a value you entered, so record where it came from.", "قيمة {item} هي {value}، وهي قيمة أدخلتها، لذا سجّل مصدرها."],
    ns_7: ["{item}: {value}, one app-wide rate, not measured for this route.", "قيمة {item} هي {value}، وهي معدل واحد للتطبيق كله ولم تُقَس لهذا المسار."],
    ns_8: ["{item}: {value}, estimated from hotel records by nationality.", "قيمة {item} هي {value}، وهي مقدّرة من سجلات الفنادق حسب الجنسية."],
    ns_9: ["{item}: {value}, from only 1 past flight record for this route and month.", "قيمة {item} هي {value}، من سجل رحلات سابق واحد فقط لهذا المسار والشهر."],
    ns_10: ["{item}: {value}, from only {count} past flight records for this route and month.", "قيمة {item} هي {value}، من {count} سجلات رحلات سابقة فقط لهذا المسار والشهر."],
    ns_11: ["{item}: {value}, from {count} past flight records for this route and month.", "قيمة {item} هي {value}، من {count} سجلات رحلات سابقة لهذا المسار والشهر."],
    ns_12: ["The visitor mix is an estimated split by nationality: it changes who is expected, not the total.", "توزيع الزوار تقسيم تقديري حسب الجنسية: يغيّر من يُتوقع قدومهم، لا الإجمالي."],
    ns_13: ["It is already at the lowest value the planner allows.", "القيمة عند أدنى حد يسمح به المخطِّط بالفعل."],
    ns_14: ["If it is 10% lower ({value}), your extra flights add about {count} nights instead of {estimate}.", "إذا كانت أقل بنسبة 10% ({value})، فستضيف رحلاتك الإضافية نحو {count} ليلة بدلًا من {estimate}."],
    ns_15: ["If it is 10% lower ({value}), the plan gives about {count} guest nights instead of {estimate}.", "إذا كانت أقل بنسبة 10% ({value})، فستعطي الخطة نحو {count} ليلة نزلاء بدلًا من {estimate}."],
    ns_16: ["Ask: {item}.", "اسأل: {item}."],
    ns_17: ["This check is overdue.", "موعد هذا التحقق قد فات."],
    ns_18: ["First check: {item}.", "التحقق الأول: {item}."],
    ns_19: ["Validate the event increase", "التحقق من زيادة الفعالية"],
    ns_20: ["Event or tourism team", "فريق الفعاليات أو السياحة"],
    ns_21: ["{item}: {value}, from only two past flight records for this route and month.", "قيمة {item} هي {value}، من سجلَّي رحلات سابقَين فقط لهذا المسار والشهر."],
    // Audit fixes: guide panel, comparison-country notes and status messages.
    a2c_ns_1: ["Step {count}: {item}.", "الخطوة {count}: {item}."],
    a2c_ns_2: ["You can finish with a planning decision in Compare.", "يمكنك إنهاء التخطيط بقرار في «المقارنة»."],
    a2c_ns_3: ["Use Add task in the Next steps box on Focus to track each check.", "استخدم «إضافة مهمة» في مربع الخطوات التالية ضمن «ملخص» لمتابعة كل عملية تحقق."],
    a2c_ns_4: ["When these are done, finish with a planning decision in Compare.", "بعد إنجاز ذلك، أنهِ التخطيط بقرار في «المقارنة»."],
    a2c_ns_5: ["You still have {count} of {value} checks without recorded evidence:", "لا يزال لديك {count} من {value} عمليات تحقق دون أدلة مسجّلة:"],
    a2c_ns_6: ["Every check has recorded evidence for these exact assumptions.", "كل عمليات التحقق لها أدلة مسجّلة لهذه الافتراضات بالضبط."],
    a2c_ns_7: ["{item} · overdue", "{item} · فات موعدها"],
    a2c_ns_8: ["{item} · no recorded evidence yet", "{item} · لا توجد أدلة مسجّلة بعد"],
    a2c_ns_9: ["No planning decision is logged yet; use Log decision in Follow-ups when the checks are done.", "لم يُسجَّل قرار تخطيط بعد؛ استخدم «تسجيل القرار» في «المتابعات» بعد إنجاز عمليات التحقق."],
    a2c_ns_10: ["Nothing is missing: every check has recorded evidence for these exact assumptions, and a decision is logged.", "لا ينقص شيء: كل عمليات التحقق لها أدلة مسجّلة لهذه الافتراضات بالضبط، وتم تسجيل قرار."],
    a2c_ns_11: ["Ask “What is the next step?” for the order to work through them.", "اسأل «ما الخطوة التالية؟» لمعرفة ترتيب إنجازها."],
    a2c_ns_12: ["Here is what the charts on {item} show:", "هذا ما تعرضه الرسوم البيانية في {item}:"],
    a2c_ns_13: ["This page has no charts. Plan a route (Focus, Compare and Details), Visitor mix, Check past results and Statistics have charts.", "لا توجد رسوم بيانية في هذه الصفحة. تتضمن «تخطيط المسار» («ملخص» و«المقارنة» و«التفاصيل») و«توزيع الزوار» و«التحقق من النتائج السابقة» و«الإحصاءات» رسومًا بيانية."],
    a2c_ns_14: ["You are on {item}.", "أنت في {item}."],
    a2c_ns_15: ["Ask “Explain the charts” to read the graphs on this page.", "اسأل «اشرح الرسوم البيانية» لقراءة رسوم هذه الصفحة."],
    a2c_ns_16: ["The four cards show extra hotel check-ins, extra guest nights, total guest nights and the possible range.", "تعرض البطاقات الأربع التسجيلات الفندقية الإضافية وليالي النزلاء الإضافية وإجمالي ليالي النزلاء والنطاق المحتمل."],
    a2c_ns_17: ["The small line in the first three cards shows that measure for every month of the year.", "يعرض الخط الصغير في البطاقات الثلاث الأولى هذا المقياس لكل شهر من أشهر السنة."],
    a2c_ns_18: ["The possible range card shows the lower and higher guides as a bar.", "تعرض بطاقة النطاق المحتمل الحدين الأدنى والأعلى في شكل شريط."],
    a2c_ns_19: ["From seats to guest nights: each bar is one step, from flight seats to passengers, passengers ending their trip in Abu Dhabi, hotel check-ins and guest nights.", "من المقاعد إلى ليالي النزلاء: كل عمود خطوة واحدة، من مقاعد الرحلات إلى الركاب، ثم الركاب الذين تنتهي رحلتهم في أبوظبي، ثم التسجيلات الفندقية، ثم ليالي النزلاء."],
    a2c_ns_20: ["In that chart, gray shows the usual month, the coloured cap marks your plan and the badge shows the change.", "في هذا الرسم، يمثّل الرمادي الشهر المعتاد، ويشير الجزء الملوّن في الأعلى إلى خطتك، وتعرض الشارة مقدار التغيّر."],
    a2c_ns_21: ["Three launch sizes: cards for cautious, standard and expanded weekly flights, with the extra check-ins and guest nights each would add.", "ثلاثة أحجام للإطلاق: بطاقات للرحلات الأسبوعية الحذرة والقياسية والموسّعة، مع التسجيلات وليالي النزلاء الإضافية لكل منها."],
    a2c_ns_22: ["Compare months: the extra guest nights from the same flights in each month of the year.", "مقارنة الأشهر: ليالي النزلاء الإضافية من الرحلات نفسها في كل شهر من أشهر السنة."],
    a2c_ns_23: ["What if fewer visitors stay in hotels?: how much the extra guest nights fall under each lower-assumption trial, compared with your plan.", "ماذا لو أقام عدد أقل من الزوار في الفنادق؟: مقدار انخفاض ليالي النزلاء الإضافية في كل اختبار للافتراضات الأدنى مقارنةً بخطتك."],
    a2c_ns_24: ["Show the numbers under each chart opens the table behind it.", "يفتح «عرض الأرقام» أسفل كل رسم الجدول الذي يستند إليه."],
    a2c_ns_25: ["Estimated hotel nights by nationality: the estimated change in hotel nights for each visitor group.", "الليالي الفندقية المقدّرة حسب الجنسية: التغيّر المقدّر في الليالي الفندقية لكل فئة من الزوار."],
    a2c_ns_26: ["One-at-a-time sensitivity: how far guest nights move when one assumption is nudged up or down on its own; the nudge sizes differ, so treat it as a guide.", "الحساسية لكل افتراض على حدة: مقدار تحرّك ليالي النزلاء عند رفع افتراض واحد أو خفضه وحده؛ وتختلف أحجام التغيير، فاعتبرها دليلًا."],
    a2c_ns_27: ["Route map: a schematic line from the country’s reference point to Abu Dhabi city, not airport locations.", "خريطة المسار: خط تخطيطي من النقطة المرجعية للبلد إلى مدينة أبوظبي، لا مواقع المطارات."],
    a2c_ns_28: ["Seats by month: average monthly flight seats for this route from the supplied records; bars start at zero and k means thousand.", "المقاعد حسب الشهر: متوسط مقاعد الرحلات الشهرية لهذا المسار من السجلات المقدّمة؛ تبدأ الأعمدة من الصفر، وk تعني ألفًا."],
    a2c_ns_29: ["Global Visitor Origins: an illustrative map of visitor nationalities; locations are country reference points, not airports or flight paths.", "أصول الزوار عالميًا: خريطة توضيحية لجنسيات الزوار؛ المواقع نقاط مرجعية للبلدان، لا مطارات ولا مسارات رحلات."],
    a2c_ns_30: ["The cards list the largest nationality groups with their share, hotel check-ins and guest nights.", "تعرض البطاقات أكبر فئات الجنسيات مع نسبتها والتسجيلات الفندقية وليالي النزلاء."],
    a2c_ns_31: ["Monthly hotel arrivals: the recorded hotel arrivals for each test month, compared with Air2Stay’s live calculation and the hybrid comparison model.", "الوافدون إلى الفنادق شهريًا: الوافدون المسجّلون في كل شهر اختبار، مقارنةً بالحساب المباشر في Air2Stay ونموذج المقارنة الهجين."],
    a2c_ns_32: ["The shaded band shows plus or minus the overall weighted error around the live estimate; it is a visual guide, not a guaranteed range.", "يُظهر النطاق المظلّل زائد أو ناقص الخطأ المرجّح الإجمالي حول التقدير المباشر؛ وهو دليل بصري، وليس نطاقًا مضمونًا."],
    a2c_ns_33: ["Messages: Inbox {count} ({value} unread), Sent {estimate}, Drafts {low}.", "الرسائل: الوارد {count} (غير المقروءة {value})، والمرسلة {estimate}، والمسودات {low}."],
    a2c_ns_34: ["Approval requests are in Tasks, in the shortcuts on the right edge.", "طلبات الموافقة موجودة في «المهام» ضمن الاختصارات على حافة الشاشة."],
    a2c_ns_35: ["Requests: {count}, waiting: {value}.", "الطلبات: {count}، قيد الانتظار: {value}."],
    a2c_ns_36: ["I couldn’t find a request that matches those words.", "لم أجد طلبًا يطابق هذه الكلمات."],
    a2c_ns_37: ["The request “{item}” from {from} is in Tasks, marked {status}.", "الطلب «{item}» من {from} موجود في «المهام»، وحالته: {status}."],
    a2c_ns_38: ["Open Tasks from the shortcuts on the right edge to see it.", "افتح «المهام» من الاختصارات على حافة الشاشة لعرضه."],
    a2c_ns_39: ["{folder} is in Messages at the top (messages: {count}).", "تجد {folder} في «الرسائل» في الأعلى (عدد الرسائل: {count})."],
    a2c_ns_40: ["Open Messages at the top to see them.", "افتح «الرسائل» في الأعلى لعرضها."],
    a2c_ns_41: ["I couldn’t find a message that matches those words.", "لم أجد رسالة تطابق هذه الكلمات."],
    a2c_ns_42: ["Try a word from the subject or the sender’s name.", "جرّب كلمة من الموضوع أو اسم المرسل."],
    a2c_ns_43: ["I found these messages:", "وجدت هذه الرسائل:"],
    a2c_ns_44: ["“{item}” · {folder}", "«{item}» · {folder}"],
    a2c_ns_45: ["Open Messages at the top, choose the folder, then select the message.", "افتح «الرسائل» في الأعلى، واختر المجلد، ثم اختر الرسالة."],
    a2c_ns_46: ["Your draft “{item}” is in {folder}.", "مسودتك «{item}» موجودة في {folder}."],
    a2c_ns_47: ["The message “{item}” to {to} is in {folder}.", "الرسالة «{item}» إلى {to} موجودة في {folder}."],
    a2c_ns_48: ["The message “{item}” from {from} is in {folder}.", "الرسالة «{item}» من {from} موجودة في {folder}."],
    a2c_ns_49: ["It is unread.", "وهي غير مقروءة."],
    a2c_ns_50: ["Open Messages at the top, choose {folder}, then select it.", "افتح «الرسائل» في الأعلى، واختر {folder}، ثم اختر الرسالة."],
    // Audit fixes: guide panel, comparison-country notes and status messages.
    a2c_wi_1: ["Here is how this change would affect your plan, without applying it:", "هذا تأثير هذا التغيير على خطتك، دون تطبيقه:"],
    a2c_wi_2: ["{item}: {low} → {high}", "{item}: {low} ← {high}"],
    a2c_wi_3: ["That is about {value} more guest nights than your plan.", "أي نحو {value} ليلة نزلاء أكثر من خطتك."],
    a2c_wi_4: ["That is about {value} fewer guest nights than your plan.", "أي نحو {value} ليلة نزلاء أقل من خطتك."],
    a2c_wi_5: ["Guest nights would stay about the same.", "ستبقى ليالي النزلاء تقريبًا كما هي."],
    a2c_wi_6: ["Your plan has not changed; to apply it, say “Set extra flights to {count}”.", "لم تتغير خطتك؛ لتطبيقه، قل «اضبط الرحلات الإضافية على {count}»."],
    a2c_wi_7: ["Your plan has not changed; to apply it, say “Set flight occupancy to {value}”.", "لم تتغير خطتك؛ لتطبيقه، قل «اضبط الإشغال على {value}»."],
    a2c_wi_8: ["Your plan has not changed; to apply it, say “Set hotel use to {value}”.", "لم تتغير خطتك؛ لتطبيقه، قل «اضبط التسجيل في الفنادق على {value}»."],
    a2c_wi_9: ["Your plan has not changed; to apply it, say “Set average stay to {value} nights”.", "لم تتغير خطتك؛ لتطبيقه، قل «اضبط متوسط الليالي على {value}»."],
    a2c_wi_10: ["Your plan has not changed; to apply it, say “Set seats per flight to {count}”.", "لم تتغير خطتك؛ لتطبيقه، قل «اضبط المقاعد على {count}»."],
    a2c_wi_11: ["Your plan has not changed; to apply it, give each change as a command, such as “Set extra flights to 5”.", "لم تتغير خطتك؛ لتطبيقه، اكتب كل تغيير كأمر، مثل «اضبط الرحلات الإضافية على 5»."],
    a2c_wi_12: ["This what-if works on the plan you have open.", "يعمل سؤال «ماذا لو» على الخطة المفتوحة لديك."],
    a2c_wi_13: ["Switch the departure country to {item} first, then ask again.", "غيّر بلد المغادرة إلى {item} أولًا، ثم اسأل مرة أخرى."],
    a2c_wi_14: ["Switch the month to {item} first, then ask again.", "غيّر الشهر إلى {item} أولًا، ثم اسأل مرة أخرى."],
    a2c_wi_15: ["Extra flights must stay between −20 and 20 a week, so I can’t work that out.", "يجب أن تبقى الرحلات الإضافية بين −20 و20 رحلة أسبوعيًا، لذا لا يمكنني حساب ذلك."],
    a2c_wi_16: ["That value is outside what the planner allows, so I can’t work that out.", "هذه القيمة خارج ما يسمح به المخطِّط، لذا لا يمكنني حساب ذلك."],
    a2c_wi_17: ["Your plan has not changed.", "لم تتغير خطتك."],
    a2c_wi_18: ["To draft an email, open Follow-ups, then open Draft email.", "لكتابة مسودة بريد إلكتروني، افتح «المتابعات»، ثم افتح «مسودة بريد إلكتروني»."],
    a2c_wi_19: ["Choose who it is for under Message for, then choose Prepare draft.", "اختر المرسَل إليه من «رسالة إلى»، ثم اختر «إعداد المسودة»."],
    a2c_wi_20: ["For hotel rooms or capacity, choose Hotel team.", "للاستفسار عن الغرف الفندقية أو السعة، اختر «فريق الفنادق»."],
    a2c_wi_21: ["For flights or bookings, choose Airline or airport planner.", "للاستفسار عن الرحلات أو الحجوزات، اختر «مسؤول التخطيط في شركة الطيران أو المطار»."],
    a2c_wi_22: ["Draft email in the Next steps box on Focus opens the same form.", "يفتح زر «مسودة بريد إلكتروني» في مربع «الخطوات التالية» ضمن «ملخص» النموذج نفسه."],
    a2c_wi_23: ["You set “{item}” under Adjust plan, in section {section}.", "تضبط «{item}» من «تعديل الخطة»، في القسم {section}."],
    a2c_wi_24: ["Adjust plan is the button at the top left of Plan a route.", "«تعديل الخطة» هو الزر أعلى يسار «تخطيط المسار»."],
    a2c_wi_25: ["It appears when you choose + New route in Departure country.", "يظهر عند اختيار «＋ مسار جديد» في «بلد المغادرة»."],
    a2c_wi_26: ["+ New route is the last choice in Departure country, under Adjust plan.", "«＋ مسار جديد» هو آخر خيار في «بلد المغادرة»، ضمن «تعديل الخطة»."],
    a2c_wi_27: ["It opens the plan controls in four sections: 01 Market, 02 Flights, 03 Event or disruption and 04 Hotel visitors.", "يفتح أدوات التحكم في الخطة في أربعة أقسام: 01 السوق، و02 الرحلات الجوية، و03 فعالية أو اضطراب، و04 نزلاء الفنادق."],
    a2c_wi_28: ["Add task is on each check in Follow-ups, and in the Next steps box on Focus.", "«إضافة مهمة» موجودة على كل عملية تحقق في «المتابعات»، وفي مربع «الخطوات التالية» ضمن «ملخص»."],
    a2c_wi_29: ["Log decision is in Follow-ups, further down the page.", "«تسجيل القرار» موجود في «المتابعات»، في أسفل الصفحة."],
    a2c_wi_30: ["Add note is in Follow-ups, below Your tasks.", "«إضافة ملاحظة» موجودة في «المتابعات»، أسفل «مهامك»."],
    a2c_wi_31: ["The decision note is on Compare, with Save as PDF and a text download.", "مذكرة القرار موجودة في «المقارنة»، مع زر الحفظ بصيغة PDF وخيار التنزيل كنص."],
    a2c_wi_32: ["Next steps is on Focus, below your result.", "«الخطوات التالية» موجودة في «ملخص»، أسفل نتيجتك."],
    a2c_wi_33: ["Actions is the button at the top right of Plan a route; its number shows the checks that need attention.", "«الإجراءات» هو الزر أعلى يمين «تخطيط المسار»؛ ويُظهر رقمه عمليات التحقق التي تحتاج إلى متابعة."],
    a2c_wi_34: ["Export is the button under Your current plan on Focus.", "«تصدير» هو الزر أسفل «خطتك الحالية» في «ملخص»."],
    a2c_wi_35: ["It saves the plan as Excel, a PDF report or CSV, in English or Arabic.", "يحفظ الخطة بصيغة Excel أو تقرير PDF أو CSV، بالعربية أو الإنجليزية."],
    a2c_wi_36: ["The language buttons, EN and عربي, are at the top right of the page.", "زرّا اللغة، EN وعربي، موجودان أعلى يمين الصفحة."],
    a2c_wi_37: ["Guide me is the button next to Search at the top right.", "«جولة إرشادية» هو الزر المجاور لـ«بحث» أعلى اليمين."],
    a2c_wi_38: ["Search is at the top right of the page.", "«بحث» موجود أعلى يمين الصفحة."],
    a2c_wi_39: ["Notifications is the bell at the top right, and it is also in the shortcuts on the right edge.", "«الإشعارات» هي الجرس أعلى اليمين، وهي موجودة أيضًا ضمن الاختصارات على حافة الشاشة."],
    a2c_wi_40: ["Tasks is in the shortcuts on the right edge.", "«المهام» موجودة ضمن الاختصارات على حافة الشاشة."],
    a2c_wi_41: ["Statistics is in the menu at the top of the page and in the shortcuts on the right edge.", "«الإحصاءات» موجودة في القائمة أعلى الصفحة وضمن الاختصارات على حافة الشاشة."],
    a2c_wi_42: ["Edit mix is on the Visitor mix page.", "«تعديل التوزيع» موجود في صفحة «توزيع الزوار»."],
    a2c_wi_43: ["“{item}” is a tab at the top of Plan a route.", "«{item}» تبويب أعلى «تخطيط المسار»."],
    a2c_wi_44: ["“{item}” is in the menu at the top of the page.", "«{item}» موجود في القائمة أعلى الصفحة."],
    a2c_wi_45: ["01 Market", "01 السوق"],
    a2c_wi_46: ["02 Flights", "02 الرحلات الجوية"],
    a2c_wi_47: ["03 Event or disruption", "03 فعالية أو اضطراب"],
    a2c_wi_48: ["04 Hotel visitors", "04 نزلاء الفنادق"],
    // Audit fixes: guide panel, comparison-country notes and status messages.
    a2c_cmp_1: ["Compared with your previous result:", "مقارنةً بنتيجتك السابقة:"],
    a2c_cmp_2: ["Compared with your first result in this session:", "مقارنةً بنتيجتك الأولى في هذه الجلسة:"],
    a2c_cmp_3: ["{item}: {from} → {to}", "{item}: {from} ← {to}"],
    a2c_cmp_4: ["That is about {value} more guest nights than the earlier result.", "أي نحو {value} ليلة نزلاء أكثر من النتيجة السابقة."],
    a2c_cmp_5: ["That is about {value} fewer guest nights than the earlier result.", "أي نحو {value} ليلة نزلاء أقل من النتيجة السابقة."],
    a2c_cmp_6: ["Guest nights are about the same as the earlier result.", "ليالي النزلاء تقريبًا كما في النتيجة السابقة."],
    a2c_cmp_7: ["Ask “Compare with my first result” to compare with where you started.", "اسأل «قارن بنتيجتي الأولى» للمقارنة بنقطة البداية."],
    a2c_cmp_8: ["There is no earlier result to compare with yet.", "لا توجد نتيجة سابقة للمقارنة بها بعد."],
    a2c_cmp_9: ["Change the plan, then ask again; I compare with the result just before the change.", "غيّر الخطة، ثم اسأل مرة أخرى؛ أقارن بالنتيجة التي سبقت التغيير مباشرةً."],
    a2c_hotel_occupancy: ["Hotel occupancy means how full hotels are. This planner does not have that control. You can change flight occupancy or the share of visitors using hotels; please name which one. The plan has not changed.", "إشغال الفنادق يعني مدى امتلائها، وهذا المخطِّط لا يتضمن هذا الإعداد. يمكنك تغيير نسبة إشغال الرحلات أو نسبة الزوار المقيمين في الفنادق؛ يُرجى تحديد أيهما. لم تتغير الخطة."],
  };
  return {
    en: Object.fromEntries(Object.entries(labels).map(([key, [english]]) => [key, english])),
    ar: Object.fromEntries(Object.entries(labels).map(([key, [, arabic]]) => [key, arabic])),
  };
})();

// Keep the language switch separate from the simulator's inputs and renders.
let uiLanguage = "en";
const AR_NAMES = {
  "Afghanistan": "أفغانستان",
  "Aland": "جزر آلاند",
  "Albania": "ألبانيا",
  "Algeria": "الجزائر",
  "American Samoa": "ساموا الأمريكية",
  "Andorra": "أندورا",
  "Angola": "أنغولا",
  "Anguilla": "أنغويلا",
  "Antarctica": "أنتاركتيكا",
  "Antigua and Barbuda": "أنتيغوا وبربودا",
  "Argentina": "الأرجنتين",
  "Armenia": "أرمينيا",
  "Aruba": "أروبا",
  "Ashmore and Cartier Islands": "جزر أشمور وكارتييه",
  "Australia": "أستراليا",
  "Austria": "النمسا",
  "Azerbaijan": "أذربيجان",
  "Bahrain": "البحرين",
  "Bangladesh": "بنغلاديش",
  "Barbados": "بربادوس",
  "Belarus": "بيلاروس",
  "Belgium": "بلجيكا",
  "Belize": "بليز",
  "Benin": "بنين",
  "Bermuda": "برمودا",
  "Bhutan": "بوتان",
  "Bolivia": "بوليفيا",
  "Bosnia and Herzegovina": "البوسنة والهرسك",
  "Botswana": "بوتسوانا",
  "Brazil": "البرازيل",
  "British Indian Ocean Territory": "الإقليم البريطاني في المحيط الهندي",
  "British Virgin Islands": "جزر فيرجن البريطانية",
  "Brunei": "بروناي",
  "Bulgaria": "بلغاريا",
  "Burkina Faso": "بوركينا فاسو",
  "Burundi": "بوروندي",
  "Cabo Verde": "الرأس الأخضر",
  "Cambodia": "كمبوديا",
  "Cameroon": "الكاميرون",
  "Canada": "كندا",
  "Cayman Islands": "جزر كايمان",
  "Central African Republic": "جمهورية أفريقيا الوسطى",
  "Chad": "تشاد",
  "Chile": "تشيلي",
  "China": "الصين",
  "Colombia": "كولومبيا",
  "Comoros": "جزر القمر",
  "Cook Islands": "جزر كوك",
  "Costa Rica": "كوستاريكا",
  "Croatia": "كرواتيا",
  "Cuba": "كوبا",
  "Curaçao": "كوراساو",
  "Cyprus": "قبرص",
  "Czechia": "التشيك",
  "Democratic Republic of the Congo": "جمهورية الكونغو الديمقراطية",
  "Denmark": "الدانمرك",
  "Djibouti": "جيبوتي",
  "Dominica": "دومينيكا",
  "Dominican Republic": "جمهورية الدومينيكان",
  "East Timor": "تيمور الشرقية",
  "Ecuador": "الإكوادور",
  "Egypt": "مصر",
  "El Salvador": "السلفادور",
  "Equatorial Guinea": "غينيا الاستوائية",
  "Eritrea": "إريتريا",
  "Estonia": "إستونيا",
  "eSwatini": "إسواتيني",
  "Ethiopia": "إثيوبيا",
  "Falkland Islands": "جزر فوكلاند",
  "Faroe Islands": "جزر فارو",
  "Federated States of Micronesia": "ميكرونيزيا",
  "Fiji": "فيجي",
  "Finland": "فنلندا",
  "France": "فرنسا",
  "French Polynesia": "بولينيزيا الفرنسية",
  "French Southern and Antarctic Lands": "الأقاليم الجنوبية الفرنسية",
  "Gabon": "الغابون",
  "Gambia": "غامبيا",
  "Georgia": "جورجيا",
  "Germany": "ألمانيا",
  "Ghana": "غانا",
  "Greece": "اليونان",
  "Greenland": "غرينلاند",
  "Grenada": "غرينادا",
  "Guam": "غوام",
  "Guatemala": "غواتيمالا",
  "Guernsey": "غيرنزي",
  "Guinea": "غينيا",
  "Guinea-Bissau": "غينيا بيساو",
  "Guyana": "غيانا",
  "Haiti": "هايتي",
  "Heard Island and McDonald Islands": "جزيرة هيرد وجزر ماكدونالد",
  "Honduras": "هندوراس",
  "Hong Kong S.A.R.": "هونغ كونغ الصينية (منطقة إدارية خاصة)",
  "Hungary": "هنغاريا",
  "Iceland": "آيسلندا",
  "India": "الهند",
  "Indian Ocean Territories": "أقاليم المحيط الهندي",
  "Indonesia": "إندونيسيا",
  "Iran": "إيران",
  "Iraq": "العراق",
  "Ireland": "أيرلندا",
  "Isle of Man": "جزيرة مان",
  "Israel": "إسرائيل",
  "Italy": "إيطاليا",
  "Ivory Coast": "ساحل العاج",
  "Jamaica": "جامايكا",
  "Japan": "اليابان",
  "Jersey": "جيرسي",
  "Jordan": "الأردن",
  "Kazakhstan": "كازاخستان",
  "Kenya": "كينيا",
  "Kiribati": "كيريباتي",
  "Kosovo": "كوسوفو",
  "Kuwait": "الكويت",
  "Kyrgyzstan": "قيرغيزستان",
  "Laos": "لاوس",
  "Latvia": "لاتفيا",
  "Lebanon": "لبنان",
  "Lesotho": "ليسوتو",
  "Liberia": "ليبيريا",
  "Libya": "ليبيا",
  "Liechtenstein": "ليختنشتاين",
  "Lithuania": "ليتوانيا",
  "Luxembourg": "لوكسمبورغ",
  "Macao S.A.R": "منطقة ماكاو الإدارية الخاصة",
  "Madagascar": "مدغشقر",
  "Malawi": "ملاوي",
  "Malaysia": "ماليزيا",
  "Maldives": "جزر المالديف",
  "Mali": "مالي",
  "Malta": "مالطا",
  "Marshall Islands": "جزر مارشال",
  "Mauritania": "موريتانيا",
  "Mauritius": "موريشيوس",
  "Mexico": "المكسيك",
  "Moldova": "مولدوفا",
  "Monaco": "موناكو",
  "Mongolia": "منغوليا",
  "Montenegro": "الجبل الأسود",
  "Montserrat": "مونتسرات",
  "Morocco": "المغرب",
  "Mozambique": "موزمبيق",
  "Myanmar": "ميانمار (بورما)",
  "Namibia": "ناميبيا",
  "Nauru": "ناورو",
  "Nepal": "نيبال",
  "Netherlands": "هولندا",
  "New Caledonia": "كاليدونيا الجديدة",
  "New Zealand": "نيوزيلندا",
  "Nicaragua": "نيكاراغوا",
  "Niger": "النيجر",
  "Nigeria": "نيجيريا",
  "Niue": "نيوي",
  "Norfolk Island": "جزيرة نورفولك",
  "North Korea": "كوريا الشمالية",
  "North Macedonia": "مقدونيا الشمالية",
  "Northern Cyprus": "شمال قبرص",
  "Northern Mariana Islands": "جزر ماريانا الشمالية",
  "Norway": "النرويج",
  "Oman": "عُمان",
  "Pakistan": "باكستان",
  "Palau": "بالاو",
  "Palestine": "فلسطين",
  "Panama": "بنما",
  "Papua New Guinea": "بابوا غينيا الجديدة",
  "Paraguay": "باراغواي",
  "Peru": "بيرو",
  "Philippines": "الفلبين",
  "Pitcairn Islands": "جزر بيتكيرن",
  "Poland": "بولندا",
  "Portugal": "البرتغال",
  "Puerto Rico": "بورتوريكو",
  "Qatar": "قطر",
  "Republic of Serbia": "صربيا",
  "Republic of the Congo": "جمهورية الكونغو",
  "Romania": "رومانيا",
  "Russia": "روسيا",
  "Russian Federation": "روسيا",
  "Rwanda": "رواندا",
  "Saint Barthelemy": "سان بارتليمي",
  "Saint Helena": "سانت هيلينا",
  "Saint Kitts and Nevis": "سانت كيتس ونيفيس",
  "Saint Lucia": "سانت لوسيا",
  "Saint Martin": "سان مارتن",
  "Saint Pierre and Miquelon": "سان بيير ومكويلون",
  "Saint Vincent and the Grenadines": "سانت فنسنت وجزر غرينادين",
  "Samoa": "ساموا",
  "San Marino": "سان مارينو",
  "São Tomé and Principe": "ساو تومي وبرينسيبي",
  "Saudi Arabia": "السعودية",
  "Senegal": "السنغال",
  "Seychelles": "سيشل",
  "Siachen Glacier": "نهر سياشين الجليدي",
  "Sierra Leone": "سيراليون",
  "Singapore": "سنغافورة",
  "Sint Maarten": "سانت مارتن",
  "Slovakia": "سلوفاكيا",
  "Slovenia": "سلوفينيا",
  "Solomon Islands": "جزر سليمان",
  "Somalia": "الصومال",
  "Somaliland": "أرض الصومال",
  "South Africa": "جنوب أفريقيا",
  "South Georgia and the Islands": "جورجيا الجنوبية وجزر ساندويتش الجنوبية",
  "South Korea": "كوريا الجنوبية",
  "South Sudan": "جنوب السودان",
  "Spain": "إسبانيا",
  "Sri Lanka": "سريلانكا",
  "Sudan": "السودان",
  "Suriname": "سورينام",
  "Sweden": "السويد",
  "Switzerland": "سويسرا",
  "Syria": "سوريا",
  "Taiwan": "تايوان",
  "Tajikistan": "طاجيكستان",
  "Thailand": "تايلاند",
  "The Bahamas": "جزر البهاما",
  "Togo": "توغو",
  "Tonga": "تونغا",
  "Trinidad and Tobago": "ترينيداد وتوباغو",
  "Tunisia": "تونس",
  "Turkey": "تركيا",
  "Turkmenistan": "تركمانستان",
  "Turks and Caicos Islands": "جزر توركس وكايكوس",
  "Tuvalu": "توفالو",
  "Uganda": "أوغندا",
  "Ukraine": "أوكرانيا",
  "United Arab Emirates": "الإمارات العربية المتحدة",
  "United Kingdom": "المملكة المتحدة",
  "United Republic of Tanzania": "تنزانيا",
  "United States of America": "الولايات المتحدة الأمريكية",
  "United States Of America": "الولايات المتحدة الأمريكية",
  "United States Virgin Islands": "جزر فيرجن الأمريكية",
  "Uruguay": "أورغواي",
  "Uzbekistan": "أوزبكستان",
  "Vanuatu": "فانواتو",
  "Vatican": "الفاتيكان",
  "Venezuela": "فنزويلا",
  "Vietnam": "فيتنام",
  "Wallis and Futuna": "جزر والس وفوتونا",
  "Western Sahara": "الصحراء الغربية",
  "Yemen": "اليمن",
  "Zambia": "زامبيا",
  "Zimbabwe": "زيمبابوي",
  "January": "يناير",
  "Jan": "يناير",
  "February": "فبراير",
  "Feb": "فبراير",
  "March": "مارس",
  "Mar": "مارس",
  "April": "أبريل",
  "Apr": "أبريل",
  "May": "مايو",
  "June": "يونيو",
  "Jun": "يونيو",
  "July": "يوليو",
  "Jul": "يوليو",
  "August": "أغسطس",
  "Aug": "أغسطس",
  "September": "سبتمبر",
  "Sep": "سبتمبر",
  "October": "أكتوبر",
  "Oct": "أكتوبر",
  "November": "نوفمبر",
  "Nov": "نوفمبر",
  "December": "ديسمبر",
  "Dec": "ديسمبر",
  "Abu Dhabi": "أبوظبي",
  "New market": "سوق جديد",
  "New route": "مسار جديد",
};

const labelKeys = new Map();
const labelTemplates = [];
const labelTokens = /\{(\w+)\}/g;
const escapeLabelPattern = (text) => text.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
const arNameLookup = new Map(Object.entries(AR_NAMES).map(([name, arabic]) => [name.toLowerCase(), arabic]));
const arNamePattern = new RegExp(
  "(?<![\\p{L}])(?:" + Object.keys(AR_NAMES).sort((a, b) => b.length - a.length).map(escapeLabelPattern).join("|") + ")(?![\\p{L}])",
  "giu",
);

function localizedName(key) {
  return uiLanguage === "ar" ? arNameLookup.get(String(key).toLowerCase()) ?? key : key;
}

function localizedNamesIn(text) {
  return uiLanguage === "ar" ? text.replace(arNamePattern, name => name === "may" ? name : localizedName(name)) : text;
}

function countryFromInput(value) {
  const english = countryLocationLookup[normalizeCountryName(value)];
  if (english) return english;
  const comparable = text => text.trim().normalize("NFKD").replace(/\p{Mark}/gu, "");
  const input = comparable(value);
  return Object.values(countryLocationLookup).find(country => comparable(AR_NAMES[country.name] ?? country.name) === input);
}

for (const [key, text] of Object.entries(I18N.en)) {
  const parts = text.split(labelTokens);
  if (parts.length === 1) {
    labelKeys.set(text, key);
  } else {
    const names = parts.filter((_, index) => index % 2);
    const numbers = /^(value|count|low|high|target|estimate|shortfall|uplift|share|[a-e]|actual|hybrid|live|plan|total)$/;
    const pattern = parts.map((part, index) => {
      if (index % 2 === 0) return escapeLabelPattern(part);
      if (numbers.test(part)) return "([+−-]?[0-9][0-9,.%]*(?:e[+-]?[0-9]+)?)";
      if (part === "change" && text.includes("for a usual")) return "(no change|(?:minus|plus) [0-9,]+ with your plan)";
      return "(.+?)";
    }).join("");
    labelTemplates.push([new RegExp("^" + pattern + "$"), key, names, parts.filter((_, index) => index % 2 === 0).join("").length]);
  }
}

labelTemplates.sort((a, b) => b[3] - a[3]);
// Chat-only reply patterns are used by the assistant only, so their short
// placeholders can never partially translate other text in the app.
const helpChatOwnTemplates = labelTemplates.filter(([, key]) => key.startsWith("a2c_"));
for (let index = labelTemplates.length - 1; index >= 0; index--) if (labelTemplates[index][1].startsWith("a2c_")) labelTemplates.splice(index, 1);

function t(key, values = {}) {
  const text = I18N[uiLanguage][key] ?? I18N.en[key];
  return text.replace(labelTokens, (placeholder, name) => {
    if (!Object.hasOwn(values, name)) return placeholder;
    const value = values[name];
    if (uiLanguage === "en") return value;
    const source = String(value);
    const localized = name === "trials"
      ? source.split("; ").map(trial => translateUiString(trial, undefined, false)).join("؛ ")
      : translateUiString(source, undefined, false);
    return "\u2068" + localized + "\u2069";
  });
}

function translateUiString(source, hint, split = true) {
  const text = source.trim();
  if (!text || uiLanguage === "en" || text.startsWith("Exact inputs and results: ")) return source;
  const key = I18N.en[hint] === text ? hint : (labelKeys.get(text) ?? labelKeys.get(text.toLowerCase()));
  if (key) return source.replace(text, () => t(key));
  for (const [pattern, template, names] of labelTemplates) {
    const match = pattern.exec(text);
    if (!match || match.slice(1).includes(text)) continue;
    if (["{month} estimate", "{month} · {series}: {value}", "Usual {month}", "Current proposal · {country}", "Extra flights · {country}"].includes(I18N.en[template]) && !arNameLookup.has(match[1].toLowerCase())) continue;
    return source.replace(text, () => t(template, Object.fromEntries(names.map((name, index) => [name, match[index + 1]]))));
  }
  if (split) {
    const parts = source.split(/(\n+| · | → |(?<=\.)\s+(?=[A-Z]))/);
    if (parts.length > 1) return parts.map((part, index) => index % 2 ? part : translateUiString(part, undefined, false)).join("");
  }
  return localizedNamesIn(source);
}

const originalUiText = new WeakMap();
let localizeUi = () => {};
function englishUiText(element) {
  const node = element.firstChild;
  const previous = originalUiText.get(node);
  return previous && previous.localized === node.data ? previous.source : element.textContent;
}

function setupLanguage() {
  const originalAttributes = new WeakMap();
  const attrs = ["aria-label", "aria-valuetext", "aria-description", "placeholder", "title"];
  const skip = 'script, style, [download]:not(.gh-resource, .export-ready-link), textarea, [data-i18n-ignore], .pw-item-heading strong';
  const generatedTaskText = new Set(["Confirm the flight demand", "Check hotel use and capacity", "Review the visitor mix", "No notes added."]);
  const root = document.documentElement;

  function localizeText(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(skip)) return;
    const previous = originalUiText.get(node);
    const source = previous?.localized === node.data ? previous.source : node.data;
    const protectedHistory = parent.closest(".pw-history p, .pw-task h4");
    if (protectedHistory && !generatedTaskText.has(source.trim()) && !parent.closest(".pw-history li:has(.pw-assumptions)")) return;
    const localized = translateUiString(source, parent.dataset.i18n);
    if (node.data === localized) return;
    // Some legacy options use their English label as the form value.
    if (parent.localName === "option" && !parent.hasAttribute("value")) parent.value = parent.textContent.trim();
    originalUiText.set(node, {source, localized});
    node.data = localized;
  }

  function localizeAttributes(element) {
    if (element.closest(skip)) return;
    if (element.dataset.countryName) element.value = localizedName(element.dataset.countryName);
    const previous = originalAttributes.get(element) || {};
    for (const name of attrs) {
      const current = element.getAttribute(name);
      if (current === null) continue;
      const source = previous[name]?.localized === current ? previous[name].source : current;
      const localized = translateUiString(source, element.getAttribute("data-i18n-" + name));
      if (current === localized) continue;
      previous[name] = {source, localized};
      originalAttributes.set(element, previous);
      element.setAttribute(name, localized);
    }
  }

  function localizeSubtree(node) {
    if (node.nodeType === 3) {
      localizeText(node);
    } else if (node.nodeType === 1 && !node.closest(skip)) {
      localizeAttributes(node);
      node.childNodes.forEach(localizeSubtree);
    }
  }

  localizeUi = localizeSubtree;

  function setLanguage(language) {
    const market = document.querySelector("#newMarketCountry");
    const confirmed = confirmedNewMarketKey && countryLocationLookup[normalizeCountryName(confirmedNewMarketKey)];
    const syncMarket = confirmed && market?.value === localizedName(confirmed.name);
    uiLanguage = language === "ar" ? "ar" : "en";
    if (syncMarket) market.value = localizedName(confirmed.name);
    root.lang = uiLanguage;
    root.dir = uiLanguage === "ar" ? "rtl" : "ltr";
    $$("[data-lang]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lang === uiLanguage)));
    localizeSubtree(root);
    refreshGlossaryLetters();
    if ($("#glossarySearch").value) $("#glossarySearch").dispatchEvent(new Event("input"));
  }

  let stored;
  try { stored = localStorage.getItem("air2stay:lang"); } catch { /* Browser storage is optional. */ }
  setLanguage(stored);
  document.addEventListener("click", (event) => {
    const draft = event.target.closest('#proposalWorkspace [data-pw-action="draft"]') && $("#proposalWorkspace [data-pw-draft]");
    if (draft && uiLanguage === "ar") {
      draft.value = translateUiString(draft.value);
      draft.dir = "rtl";
    }
    const button = event.target.closest("button[data-lang]");
    if (!button || button.dataset.lang === uiLanguage) return;
    setLanguage(button.dataset.lang);
    try { localStorage.setItem("air2stay:lang", uiLanguage); } catch { /* The choice still applies to this visit. */ }
  });

  // Workspace and guide helpers supply English markup. Translate their updates
  // in place so active tabs, form inputs, drafts and open panels keep their state.
  const observer = new MutationObserver((records) => {
    if (uiLanguage === "en") return;
    for (const record of records) {
      if (record.type === "attributes") localizeAttributes(record.target);
      else if (record.type === "characterData") localizeText(record.target);
      else record.addedNodes.forEach(localizeSubtree);
    }
  });
  observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:attrs});
}

// Inside the Streamlit frame, scrollIntoView also scrolls the host page, which
// pushes the app up and leaves an empty band below it. Scroll only the app.
function keepHostPageInPlace() {
  let frame = null;
  try { frame = window.frameElement; } catch { frame = null; }
  if (!frame || Element.prototype.scrollIntoView.keepsHostPage) return;
  const native = Element.prototype.scrollIntoView;
  const patched = function (...args) {
    const hosts = [];
    for (let node = frame.parentElement; node; node = node.parentElement) hosts.push([node, node.scrollTop, node.scrollLeft]);
    try { return native.apply(this, args); }
    finally { for (const [node, top, left] of hosts) if (node.scrollTop !== top || node.scrollLeft !== left) { node.scrollTop = top; node.scrollLeft = left; } }
  };
  patched.keepsHostPage = true;
  Element.prototype.scrollIntoView = patched;
}

 async function init() {
   try {
     keepHostPageInPlace();
     setupLanguage();
     await loadData();
     state = defaultState();
     setupTabs();
     setupViewMode();
     $("#aircraftControls").open = window.matchMedia("(min-width: 1051px)").matches;
     setupControls();
     setupDecisionTools();
     setupTargetWorkspace();
     setupHelpChat();
     setupExportLanguage();
     setupNextSteps();
     const shared = window.__AIR2STAY_SHARED_PLAN__ || new URLSearchParams(window.location.search).get("plan");
     if (shared) {
       try { restorePlan(typeof shared === "string" ? JSON.parse(shared) : shared); }
       catch (error) { $("#planActionStatus").textContent = "Could not open the shared plan: " + error.message; }
     }
     setupPlanActions();
     setupProposalTools();
     renderValidation();
     renderGlossary();
     if (chatEnabled) renderAssistantChat();
     renderAll();
     setupFeaturePack();
   } catch (error) {
     document.body.innerHTML = `<main class="fatal"><h1>Air2Stay could not start</h1><p>${planningEscape(error.message)}</p><p>From the project folder, run <code>python run_local.py --check</code> to find missing files or packages. Follow the Quick Start in README.md, then open http://localhost:8765.</p></main>`;
   }
 }
  
 init();
