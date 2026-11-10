 import { assistantReply, appliedPlanConfirmation, findRoute, getBridge, weeksInMonth, parseScenarioPrompt, runScenario, sensitivity, validateScenarioInputs } from "./engine.mjs";
import { buildPeerProfile, validatePeerMethod } from "./route_planning.mjs";
import { ROUTE_PURPOSES, applyRoutePurpose, planningMetrics, compareOptions, compareMonths, launchOptions, stressTest, solveCapacityTarget, rankingReversals, decisionNote } from "./decision_tools.mjs";
import { CONVERSION_EVIDENCE } from "./conversion_evidence.mjs";
import { createProposalWorkspace } from "./proposal_workspace.mjs";
import { createGuidedHelp } from "./guided_help.mjs";
import { planningChatReply } from "./planning_chat.mjs";
  
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
     if (selectedCountry) $("#newMarketCountry").value = selectedCountry.name;
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
      <strong class="comparison-step-label">${key === "hotelCheckins" ? "Hotel <span>check-ins</span>" : label}</strong>
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
   $("#validationScope").innerHTML = `
     <p>Weighted error measures the size of the gap relative to recorded arrivals.</p>
     <p>Training: ${metrics.flightTrainingPeriod} (${metrics.trainingMonths} months). Check period: ${metrics.validationPeriod} (${data.validation.length} months). The test used recorded flights from the check period.</p>
     <p><strong>Live default calculation:</strong> seats × flight occupancy × share ending in Abu Dhabi × a single hotel-use rate learned only from ${metrics.flightTrainingPeriod}. The check runs this chain on each held-out country-month’s recorded flights, then sums the estimates across countries. It does not test future flight schedules, occupancy forecasts, edited assumptions, visitor shares, or guest nights. Historical route baselines and visitor profiles are descriptive summaries, not independently held-out forecasts.</p>
     <p><strong>Seasonal comparison:</strong> recorded passengers ending here × (70% training month-specific hotel-use rate + 30% overall training rate). This is the optional seasonal assumption in Details, not the default.</p>
     <p><strong>Hybrid comparison:</strong> 55% regression estimate + 45% seasonal flight estimate. The route planner does not run this aggregate regression.</p>
     <p><strong>Reproduce the scores:</strong> add the absolute monthly mistakes and divide by recorded hotel arrivals (WMAPE). Live default: ${formatNumber(errorTotal("transparent"))} ÷ ${formatNumber(actualTotal)} × 100. Hybrid comparison: ${formatNumber(errorTotal("predicted"))} ÷ ${formatNumber(actualTotal)} × 100. Scores use full-precision predictions; the table and totals round only for readability.</p>
     <p><strong>Daily hotel guests:</strong> a separate check over ${metrics.stayValidationPeriod}, with ${formatNumber(metrics.stayValidationRows)} held-out daily records. It tested daily hotel guest counts using hotel-arrival information, not route guest-night changes. Its underlying daily rows are not shown in this monthly table.</p>
     <p id="validationRangeEvidence">Range multipliers use the live default chain’s residuals on the same check months. The range has no separate coverage test and is not a guaranteed probability range.</p>`;
   $("#validationKpis").innerHTML = [
     kpiCard("Live default chain: weighted error", formatPercent(metrics.liveChainWmape, 2), "", "positive"),
     kpiCard("Seasonal comparison: weighted error", formatPercent(metrics.seasonalChainWmape, 2), "", "neutral"),
     kpiCard("Hybrid comparison: weighted error", formatPercent(metrics.flightToCheckinsWmape, 2), "", "positive"),
     kpiCard("Daily hotel guests: total weighted error", formatPercent(metrics.stayModelWmape, 1), "", "neutral"),
   ].join("");
  
   const maxRaw = Math.max(...data.validation.flatMap((row) => [row.actual, row.predicted, row.transparent, row.seasonal]));
   const max = Math.ceil(maxRaw / 50000) * 50000;
   const width = 760;
   const height = 300;
   const pad = { left: 78, right: 24, top: 18, bottom: 48 };
   const x = (index) => pad.left + index * ((width - pad.left - pad.right) / Math.max(1, data.validation.length - 1));
   const y = (value) => height - pad.bottom - value / max * (height - pad.top - pad.bottom);
   const path = (field) => data.validation.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(row[field]).toFixed(1)}`).join(" ");
   const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => ({ value: max * share, y: y(max * share) }));
   $("#validationChart").innerHTML = `
     <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded hotel arrivals compared with Air2Stay estimates">
       ${ticks.map((tick) => `<line x1="${pad.left}" y1="${tick.y}" x2="${width - pad.right}" y2="${tick.y}" class="grid-line"/><text x="${pad.left - 10}" y="${tick.y + 4}" text-anchor="end">${Math.round(tick.value / 1000)}k</text>`).join("")}
       <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" class="axis"/>
       <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" class="axis"/>
       <path d="${path("actual")}" class="actual-line"/>
       <path d="${path("transparent")}" class="transparent-line"/>
       <path d="${path("predicted")}" class="predicted-line"/>
       <path d="${path("seasonal")}" class="seasonal-line"/>
       ${data.validation.map((row, index) => `<circle cx="${x(index)}" cy="${y(row.transparent)}" r="5" tabindex="0" fill="#c9a84c"><title>${row.month}: recorded ${formatNumber(row.actual)}, live default estimate ${formatNumber(row.transparent)}, hybrid ${formatNumber(row.predicted)}, seasonal ${formatNumber(row.seasonal)}</title></circle><text x="${x(index)}" y="${height - 22}" text-anchor="middle">${row.month}</text>`).join("")}
     </svg>`;
  
   $("#validationTable").innerHTML = `<table>
     <thead><tr><th>Month checked</th><th>Recorded hotel arrivals</th><th>Live default estimate</th><th>Error</th><th>Hybrid comparison</th><th>Error</th><th>Seasonal comparison</th></tr></thead>
     <tbody>${data.validation.map((row) => `<tr><td>${row.month}</td><td>${formatNumber(row.actual)}</td><td>${formatNumber(row.transparent)}</td><td class="${Math.abs(row.actual-row.transparent)/row.actual > .1 ? "error-large" : "error-small"}">${formatPercent(Math.abs(row.actual-row.transparent)/row.actual,1)}</td><td>${formatNumber(row.predicted)}</td><td class="${Math.abs(row.actual-row.predicted)/row.actual > .1 ? "error-large" : "error-small"}">${formatPercent(Math.abs(row.actual-row.predicted)/row.actual,1)}</td><td>${formatNumber(row.seasonal)}</td></tr>`).join("")}</tbody>
   </table>`;
 }
  
 function renderRecommendation() {
   const [lead] = sensitivity(data, { ...state, bridgeOverride });
   $("#recommendationText").textContent = lead?.span > 0
     ? `Start by checking ${lead.label.toLowerCase()}. It had the largest effect in these trials.`
     : "Review the checks for this plan before making a decision.";
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
    <article><h3>Check this assumption first</h3><p>${planningEscape(ending.driverText)}</p><button type="button" class="text-action" data-evidence="stress">See the lower-assumption trials →</button></article></div>
    <details><summary>Questions for airlines and hotels</summary>
      <ul><li>Ask the airline how many of the arrivals will be residents returning home.</li>
      <li>Ask hotels about guests per occupied room before using guest nights to plan rooms or staffing.</li>
      <li>${planningEscape(ending.verification[1])}</li></ul>
    </details>
    <button type="button" class="text-action" data-evidence="followups">Open follow-ups →</button>`;
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

function decisionNoteText() {
  const note = decisionNote(data,state,decisionOptions());
  const peerText=state.peerProfile ? "\n\nComparison-country starting weights\n"+state.peerProfile.peers.map((peer)=>peer.origin+": "+formatPercent(peer.weight,1)).join("\n")+"\nGeographic assumptions only; not measured route demand." : "";
  const targetText = targetSolution ? "\n\nCapacity target check\n" + englishUiText($("#targetResult")) : "";
  return note.text + peerText + targetText;
}

function printDecisionNote() {
  if (!$("#inputError").hidden) return;
  const sheet = document.createElement("section");
  sheet.id = "decisionPrintSheet";
  const body = document.createElement("pre");
  body.textContent = decisionNoteText();
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
    downloadPlan(new Blob([decisionNoteText()],{type:"text/plain;charset=utf-8"}),"Air2Stay-decision-note.txt");
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
   if (invalid) {
     currentProposalContext = null;
     refreshPackStatistics(null);
     proposalWorkspace?.update(null);
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
   renderRecommendation();
   renderDecisionWorkspace();
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
   const nextContext = {inputs:JSON.parse(JSON.stringify({...state,bridgeOverride})),result,decision:decisionNote(data,state)};
   const changed = currentProposalContext && JSON.stringify(currentProposalContext.inputs) !== JSON.stringify(nextContext.inputs);
   currentProposalContext = nextContext;
   refreshPackStatistics(nextContext);
   proposalWorkspace?.update(nextContext);
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
  proposalWorkspace = createProposalWorkspace({mount:$("#proposalWorkspace"),chatEnabled,rail:$("#proposalRail"),launcher:$("#toggleProposalPanel"),onOpenWorkspace:()=>{ if ($("#proposalWorkspace").hidden) $(".view-mode[data-mode='proposal']").click(); },getContext:()=>currentProposalContext,track:name=>guidedHelp.track(name),onRecommendation:(element,{context,recommended,fingerprint})=>{
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
     .map((country) => `<option value="${country.name}">${country.name}</option>`)
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
       const market = $("#newMarketCountry").value.trim() || "NEW MARKET";
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
    const selectedCountry = countryLocationLookup[normalizeCountryName($("#newMarketCountry").value)];
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
     const proposal = mode === "proposal";
     document.body.classList.toggle("focus-mode", focus);
     document.body.classList.toggle("details-mode", mode === "details");
     document.body.classList.toggle("chat-mode", chat);
     document.body.classList.toggle("decisions-mode", decisions);
     document.body.classList.toggle("proposal-mode", proposal);
     $("#assistantPanel").hidden = !chat;
     $("#decisionWorkspace").hidden = !decisions;
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
       : chat ? "Describe a change or ask a question. The current result stays beside your conversation."
       : "Trace the assumptions, calculations, flight history, and limits behind this plan.";
     if (decisions && state && $("#inputError").hidden) renderDecisionWorkspace();
     guidedHelp?.track(({focus:"view_focus",details:"view_details",chat:"view_chat",decisions:"view_compare",proposal:"view_actions"})[mode]);
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
const reportStyles = {
  plain: [0, 0], header: [1, 2], title: [2, 0], accent: [1, 3], card: [3, 3],
};

function reportCellStyles() {
  const formats = Object.values(reportFormats);
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

function reportWorksheet({ rows, widths, freeze = 3, merges = [], bars = [], scales = [], filter = "" }) {
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
    '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="' + freeze + '" topLeftCell="A' + (freeze + 1) +
    '" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A' + (freeze + 1) + '" sqref="A' + (freeze + 1) + '"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="20"/><cols>' + cols + '</cols><sheetData>' + sheetData + '</sheetData>' +
    (filter ? '<autoFilter ref="' + filter + '"/>' : '') +
    (merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map(ref => '<mergeCell ref="' + ref + '"/>').join("") + '</mergeCells>' : '') +
    dataBars.join("") + colorScales.join("") + '</worksheet>';
}

function buildPlanWorkbook(report) {
  const { title, subtitle, result, steps, assumptions, annual, visitors, launch, trials, comparedMonths, notes } = report;
  const number = value => [value, "integer"];
  const change = value => [value, "change"];
  const row = (values, style = "plain", height = 22) => ({ values, style, height });
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
  const parts = sheets.map((sheet, i) => ["xl/worksheets/sheet" + (i + 1) + ".xml", reportWorksheet(sheet)]);
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
        '<sheet name="' + reportXml(sheet.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + '</sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", reportXmlHeader + '<Relationships xmlns="' + packageNs + '">' +
      parts.map(([path], i) => relation("rId" + (i + 1), "worksheet", path.slice(3))).join("") +
      relation("rId" + (parts.length + 1), "styles", "styles.xml") + '</Relationships>'],
    ["xl/styles.xml", reportCellStyles()],
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

function printPlanReport(report) {
  const sheet = $("#planPrintSheet");
  sheet.innerHTML = planReportMarkup(report);
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



function buildModelCsv(inputs) {
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
        "simulation", label, Number(variant === 0 && month === inputs.month), result.route.origin, Number(result.route.knownMarket),
        ...features, result.scenario.hotelCheckins, result.scenario.guestNights,
      ]];
    });
  });
  const csvValue = value => typeof value === "string" && /[",\r\n]/.test(value)
    ? '"' + value.replaceAll('"', '""') + '"'
    : value;
  return [header, ...rows].map(row => row.map(csvValue).join(",")).join("\r\n") + "\r\n";
}



function setupPlanActions() {
  const exportMenu = $(".export-menu");
  document.addEventListener("click", (event) => {
    if (!exportMenu.contains(event.target) || event.target.closest(".export-menu button")) exportMenu.open = false;
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
    downloadPlan(buildPlanWorkbook(report), report.filename + ".xlsx");
    $("#planActionStatus").textContent = "Excel report ready.";
  }));
  $("#exportReportPdf").addEventListener("click", () => exportReport(report => {
    printPlanReport(report);
    $("#planActionStatus").textContent = "Choose Save as PDF in the print window.";
  }));
  $("#exportCsv").addEventListener("click", () => {
    if (!ready()) return;
    downloadPlan(new Blob([buildModelCsv(state)], { type: "text/csv;charset=utf-8" }), "Air2Stay-simulated-training-data.csv");
    guidedHelp?.track("export_csv");
    $("#planActionStatus").textContent = "Model-ready CSV with simulated outcomes is ready.";
  });
}

function downloadPlan(blob, name) {
  if (lastExportUrl) URL.revokeObjectURL(lastExportUrl);
  lastExportUrl = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = lastExportUrl; link.download = name; link.textContent = "Download " + name;
  const ready = $("#exportReady"); ready.hidden = false;
  ready.replaceChildren(document.createTextNode("Your file is ready. If the download did not begin, choose: "),link);
  link.click();
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
   const letters = [...new Set(terms.map(([term]) => term[0]))];
   $("#glossaryLetters").innerHTML = letters.map((letter) => `<a href="#term-${terms.findIndex(([term]) => term[0] === letter)}">${letter}</a>`).join("");
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
   $("#printGuide").addEventListener("click", () => window.print());
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
      label: option.value, type: "New departure country", open: () => {
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
      label: message.subject, keywords: message.body, type: "Message", open: () => openMessage(message.id)
    }));
    const requests = getRequests().map(request => ({
      label: request.title, type: "Approval request", open: () => openRequest(request.id)
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
      const key = ["Message", "Approval request"].includes(entry.type) ? null : labelKeys.get(entry.label);
      const localized = key ? comparableText(t(key)) : "";
      const terms = [label, localized, comparableText(entry.type), comparableText(entry.keywords)].join(" ");
      const score = label === query || localized === query ? 4 : label.startsWith(query) || localized.startsWith(query) ? 3 : label.includes(query) || localized.includes(query) ? 2 : words.every(word => terms.includes(word)) ? 1 : 0;
      return {entry, score};
    }).filter(item => item.score).sort((a, b) => b.score - a.score).slice(0, 12).map(item => item.entry);
    list.innerHTML = matches.map((entry, index) => `<li id="appSearchOption-${index}" role="option" aria-selected="false" data-app-search-index="${index}"><span${["Message", "Approval request"].includes(entry.type) ? " data-i18n-ignore" : ""}>${planningEscape(entry.label)}</span><small>${planningEscape(entry.type)}</small></li>`).join("");
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
      <h3 data-i18n-ignore dir="auto">${esc(item.title)}</h3>
      ${item.note ? `<p class="request-note" data-i18n-ignore dir="auto">${esc(item.note)}</p>` : ""}
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
      return [item.subject, item.body, item.from, from, to].join(" ").toLowerCase().includes(search);
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
        <span class="message-preview-subject"><strong class="message-ellipsis" data-i18n-ignore dir="auto">${esc(item.subject)}</strong>${item.attachments?.length ? `<span title="Has attachments">${paperclipIcon}</span>` : ""}</span>
        <span class="message-ellipsis message-snippet" data-i18n-ignore dir="auto">${esc((item.body || "").replace(/\s+/g, " ").trim())}</span>
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
      <h2 data-i18n-ignore dir="auto">${esc(item.subject)}</h2>
      <p class="message-parties"><bdi>${esc(from)}</bdi><span class="i18n-arrow" aria-hidden="true">→</span><bdi>${esc(to)}</bdi>${Number.isFinite(timestamp) ? " · " + esc(fullDate.format(timestamp)) : ""}</p>
      <p class="message-body" data-i18n-ignore dir="auto">${esc(item.body || "")}</p>
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
    if (action === "reply") openCompose({subject:"Re: " + item.subject, recipients:item.folder === "inbox" ? [item.from] : item.recipients, priority:item.priority});
    if (action === "forward") openCompose({subject:"Fwd: " + item.subject, body:item.body, attachments:item.attachments, priority:item.priority});
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
    open_term_guide: ["Open Term Guide →", "فتح دليل المصطلحات ←"],
    open_calculation: ["Open the calculation →", "عرض طريقة الحساب ←"],
    see_comparison_countries: ["See the comparison countries in Details →", "عرض البلدان المقارنة في التفاصيل ←"],
    see_range_estimate: ["See how the range is estimated →", "عرض طريقة تقدير النطاق ←"],
    open_compare: ["Open Compare →", "فتح المقارنة ←"],
    open_event_controls: ["Open event controls →", "فتح أدوات التحكم بالفعاليات ←"],
    open_export: ["Open Export →", "فتح خيارات التصدير ←"],
    read_privacy_guidance: ["Read the privacy and sharing guidance →", "قراءة إرشادات الخصوصية والمشاركة ←"],
    validation_summary_scope: ["This test compares monthly hotel arrivals across the included markets. Lower weighted error means a closer estimate.", "يقارن هذا الاختبار أعداد نزلاء الفنادق الشهرية عبر الأسواق المشمولة. وكلما انخفض الخطأ المرجّح، كان التقدير أقرب إلى الأعداد المسجلة."],
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
  };
  return {
    en: Object.fromEntries(Object.entries(labels).map(([key, [english]]) => [key, english])),
    ar: Object.fromEntries(Object.entries(labels).map(([key, [, arabic]]) => [key, arabic])),
  };
})();

// Keep the language switch separate from the simulator's inputs and renders.
let uiLanguage = "en";
const labelKeys = new Map();
const labelTemplates = [];
const labelTokens = /\{(\w+)\}/g;
const escapeLabelPattern = (text) => text.replace(/[.*+?^\${}()|[\]\\]/g, "\\$&");
for (const [key, text] of Object.entries(I18N.en)) {
  const parts = text.split(labelTokens);
  if (parts.length === 1) {
    labelKeys.set(text, key);
  } else {
    const names = parts.filter((_, index) => index % 2);
    const numbers = /^(value|count|low|high|target|estimate|shortfall|uplift|share)$/;
    const pattern = parts.map((part, index) => {
      if (index % 2 === 0) return escapeLabelPattern(part);
      return numbers.test(part) ? "([+−-]?[0-9][0-9,.%]*)" : "(.+?)";
    }).join("");
    labelTemplates.push([new RegExp("^" + pattern + "$"), key, names]);
  }
}

function t(key, values = {}) {
  const text = I18N[uiLanguage][key] ?? I18N.en[key];
  return text.replace(labelTokens, (placeholder, name) => {
    if (!Object.hasOwn(values, name)) return placeholder;
    const value = values[name];
    const nestedKey = labelKeys.get(value) ?? labelKeys.get(String(value).toLowerCase());
    return uiLanguage === "ar" ? "\u2068" + (I18N.ar[nestedKey] ?? value) + "\u2069" : value;
  });
}

const originalUiText = new WeakMap();
function englishUiText(element) {
  const node = element.firstChild;
  const previous = originalUiText.get(node);
  return previous && previous.localized === node.data ? previous.source : element.textContent;
}

function setupLanguage() {
  const originalAttributes = new WeakMap();
  const attrs = ["aria-label", "aria-valuetext", "placeholder", "title"];
  const skip = 'script, style, textarea, [data-i18n-ignore], .pw-history p, .pw-task h4, .pw-item-heading strong';
  const root = document.documentElement;

  function translate(source, hint) {
    const text = source.trim();
    if (!text || uiLanguage === "en") return source;
    const key = I18N.en[hint] === text ? hint : labelKeys.get(text);
    if (key) return source.replace(text, () => t(key));
    // Dynamic labels use placeholders so figures and names keep their original spelling.
    for (const [pattern, template, names] of labelTemplates) {
      const match = pattern.exec(text);
      if (match) {
        return source.replace(text, () => t(template, Object.fromEntries(names.map((name, index) => [name, match[index + 1]]))));
      }
    }
    return source;
  }

  function localizeText(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(skip)) return;
    const previous = originalUiText.get(node);
    const source = previous?.localized === node.data ? previous.source : node.data;
    const localized = translate(source, parent.dataset.i18n);
    if (node.data === localized) return;
    // Some legacy options use their English label as the form value.
    if (parent.localName === "option" && !parent.hasAttribute("value")) parent.value = parent.textContent.trim();
    originalUiText.set(node, {source, localized});
    node.data = localized;
  }

  function localizeAttributes(element) {
    if (element.closest(skip)) return;
    const previous = originalAttributes.get(element) || {};
    for (const name of attrs) {
      const current = element.getAttribute(name);
      if (current === null) continue;
      const source = previous[name]?.localized === current ? previous[name].source : current;
      const localized = translate(source, element.getAttribute("data-i18n-" + name));
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

  function setLanguage(language) {
    uiLanguage = language === "ar" ? "ar" : "en";
    root.lang = uiLanguage;
    root.dir = uiLanguage === "ar" ? "rtl" : "ltr";
    $$("[data-lang]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lang === uiLanguage)));
    localizeSubtree(root);
  }

  let stored;
  try { stored = localStorage.getItem("air2stay:lang"); } catch { /* Browser storage is optional. */ }
  setLanguage(stored);
  document.addEventListener("click", (event) => {
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

 async function init() {
   try {
     setupLanguage();
     await loadData();
     state = defaultState();
     setupTabs();
     setupViewMode();
     $("#aircraftControls").open = window.matchMedia("(min-width: 1051px)").matches;
     setupControls();
     setupDecisionTools();
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
