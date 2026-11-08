 import { assistantReply, appliedPlanConfirmation, findRoute, getBridge, weeksInMonth, parseScenarioPrompt, runScenario, sensitivity, validateScenarioInputs } from "./engine.mjs";
import { buildPeerProfile, validatePeerMethod } from "./route_planning.mjs";
import { applyRoutePurpose, planningMetrics, compareOptions, compareMonths, launchOptions, stressTest, solveCapacityTarget, rankingReversals, decisionNote } from "./decision_tools.mjs";
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
 const formatEventPercent = (value) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(Number(value) * 100).toLocaleString("en-US", {maximumFractionDigits: 2})}%`;
 const EVENT_IMPACTS = [
   {key:"none", label:"No event", uplift:0, tone:"neutral"},
   {key:"expo", label:"🎉 Major expo or conference", uplift:0.15, tone:"positive"},
   {key:"sport", label:"🏆 Sporting event", uplift:0.20, tone:"positive"},
   {key:"holiday", label:"🎆 Holiday period", uplift:0.10, tone:"positive"},
   {key:"airline", label:"✈️ Airline disruption", uplift:-0.20, tone:"negative"},
   {key:"geopolitical", label:"🌍 Geopolitical tension", uplift:-0.30, tone:"negative"},
   {key:"health", label:"🦠 Health advisory", uplift:-0.25, tone:"negative"},
 ];
  
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
let eventControlsReady = false;
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
   // Keep the original numbers while displaying readable rounded controls.
   for (const [id, value] of Object.entries({extraFlights: state.extraFlights, seatsPerFlight: state.seatsPerFlight, loadFactor: state.loadFactor * 100, p2pShare: state.p2pShare * 100, conversionRate: state.conversionRate * 100, averageStay: state.averageStay, eventUplift: state.eventUplift * 100})) {
     const field = $(`#${id}`);
     field.dataset.displayed = field.value;
     field.dataset.exact = String(value);
   }
   updateRangeLabels();
 }
  
 function updateRangeLabels() {
   const flights = Number($("#extraFlights").value);
   const direction = flights > 0 ? "more" : flights < 0 ? "fewer" : "same";
   const amount = Math.abs(flights);
   const flightControl = $("#weeklyFlightControl");
   flightControl.dataset.direction = direction;
   flightControl.style?.setProperty("--flight-position", `${50 + flights * 2.5}%`);
   $("#extraFlightsValue").textContent = flights ? formatSigned(flights) : "0";
   $("#weeklyFlightSummary").textContent = flights
     ? `${amount} ${direction} ${amount === 1 ? "flight" : "flights"} per week than usual`
     : "No change to the weekly schedule";
   for (const button of $$("[data-flight-step]")) {
     const field = $(`#${button.dataset.flightControl}`);
     const value = Number(field.value);
     button.disabled = !field.value || !Number.isFinite(value) || value < Number(field.min) || value > Number(field.max)
       || (Number(button.dataset.flightStep) < 0 ? value <= Number(field.min) : value >= Number(field.max));
   }
   $("#loadFactorValue").textContent = `${Number($("#loadFactor").value).toFixed(1)}%`;
   $("#p2pShareValue").textContent = `${Number($("#p2pShare").value).toFixed(1)}%`;
   $("#conversionRateValue").textContent = `${Number($("#conversionRate").value).toFixed(1)}%`;
   $("#eventUpliftValue").textContent = formatEventPercent(eventControlUplift());
   updateEventControls();
 }

 function setupEventControls() {
   const input = $("#eventUplift");
   const customLabel = input.closest("label");
   const hotelGroup = $("#routePurpose").closest("details.control-group");
   const section = document.createElement("details");
   section.id = "eventImpactGroup";
   section.className = "control-group";
   section.open = true;
   section.innerHTML = `<summary><span>02.5</span> Event or disruption</summary>
     <div class="control-group-body">
       <div class="event-impact-chips" role="group" aria-label="Event or disruption assumption">
         ${EVENT_IMPACTS.map((item) => `<button type="button" class="event-impact-chip ${item.tone}" data-event-impact="${item.key}" aria-pressed="false"><span>${item.label}</span><strong>${formatEventPercent(item.uplift)}</strong></button>`).join("")}
       </div>
       <p id="eventImpactStatus" role="status" aria-live="polite"></p>
       <small class="event-impact-note">Illustrative scenario assumptions, not measured event effects. Applies to hotel demand across the whole proposed plan; flight and passenger totals stay the same.</small>
       <details class="event-custom"><summary>Custom impact</summary></details>
     </div>`;
   hotelGroup.before(section);
   input.min = "-50";
   customLabel.querySelector(".control-label").textContent = "Hotel demand adjustment";
   customLabel.querySelector("small").textContent = "Try a decrease or increase from −50% to +50%. This is your planning assumption.";
   section.querySelector(".event-custom").append(customLabel);
   const style = document.createElement("style");
   style.textContent = `
     #eventImpactGroup .event-impact-chips { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
     #eventImpactGroup .event-impact-chip { display:flex; flex-direction:column; align-items:flex-start; justify-content:space-between; gap:7px; padding:11px; min-width:0; min-height:68px; border:1px solid #47516c; border-radius:10px; background:#1b233b; color:#d5dae4; font:inherit; font-size:12px; line-height:1.4; text-align:left; cursor:pointer; box-shadow:none; }
     #eventImpactGroup .event-impact-chip.neutral { grid-column:1/-1; min-height:42px; flex-direction:row; align-items:center; }
     #eventImpactGroup .event-impact-chip strong { font-size:13px; font-variant-numeric:tabular-nums; }
     #eventImpactGroup .event-impact-chip.positive strong { color:#f2d58a; }
     #eventImpactGroup .event-impact-chip.negative strong { color:#ffb3ab; }
     #eventImpactGroup .event-impact-chip:hover { border-color:#929bb0; background:#242e49; }
     #eventImpactGroup .event-impact-chip[aria-pressed="true"] { border-color:#a7afc0; background:#323c53; color:#fff; box-shadow:inset 0 0 0 1px #a7afc0; }
     #eventImpactGroup .event-impact-chip.positive[aria-pressed="true"] { border-color:#c9a84c; background:#39321e; color:#fff1c6; box-shadow:inset 0 0 0 1px #c9a84c; }
     #eventImpactGroup .event-impact-chip.negative[aria-pressed="true"] { border-color:#e48077; background:#3b242e; color:#ffe1dd; box-shadow:inset 0 0 0 1px #e48077; }
     #eventImpactGroup .event-impact-chip:focus-visible { outline:2px solid #f2d58a; outline-offset:3px; }
     #eventImpactGroup #eventImpactStatus { margin:0; color:#f5efe3; font-size:12px; line-height:1.6; }
     #eventImpactGroup .event-impact-note { color:#bdc5d4; font-size:11px; line-height:1.6; }
     #eventImpactGroup .event-custom > summary { padding:0; font-size:12px; color:#f2d58a; }
     #eventImpactGroup .event-custom > label { margin-top:14px; }
     @media (min-width:600px) and (max-width:1050px) { #eventImpactGroup .event-impact-chips { grid-template-columns:repeat(3,minmax(0,1fr)); } }
   `;
   document.head.append(style);
   eventControlsReady = true;
   section.querySelectorAll("[data-event-impact]").forEach((button) => button.addEventListener("click", () => {
     const preset = EVENT_IMPACTS.find((item) => item.key === button.dataset.eventImpact);
     input.value = String(preset.uplift * 100);
     input.dataset.displayed = input.value;
     input.dataset.exact = input.value;
     // Use the same input path as the other controls, preserving untouched precision.
     input.dispatchEvent(new Event("input", {bubbles:true}));
   }));
 }

 function eventControlUplift() {
   const input = $("#eventUplift");
   return Number(input.value === input.dataset.displayed ? input.dataset.exact : input.value) / 100;
 }

 function updateEventControls() {
   if (!eventControlsReady) return;
   const uplift = eventControlUplift();
   $$("[data-event-impact]").forEach((button) => {
     const preset = EVENT_IMPACTS.find((item) => item.key === button.dataset.eventImpact);
     button.setAttribute("aria-pressed", String(Math.abs(preset.uplift - uplift) < 1e-10));
   });
   const status = $("#eventImpactStatus");
   if (status) status.textContent = uplift === 0 ? "No event adjustment applied to hotel conversion."
     : `Applying ${formatEventPercent(uplift)} ${uplift > 0 ? "event uplift" : "disruption adjustment"} to hotel conversion.`;
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
   return `<div class="result-spark" data-shape="${shape}"><svg viewBox="0 0 120 34" preserveAspectRatio="none" role="img" aria-label="${planningEscape(summary)}">${zeroLine}${paths}${hits.join("")}</svg>${dot}</div>`;
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
     if (!chart.dataset.shape || chart.dataset.shape !== nextChart.dataset.shape) {
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
   return `<div class="result-range" role="img" tabindex="0" title="${description}" aria-label="${description}">
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
     return tile(label, formatSigned(value), note, chart, tone);
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

function renderSideBySideComparison(result) {
  const isNewRoute = !result.route.knownMarket;
  const baseline = result.baseline;
  const routeScenario = result.scenario;
  const scenario = routeScenario;
  const baselineRoute = result.route;
  const label = isNewRoute
    ? `Baseline estimate · ${baselineRoute.origin}`
    : `Baseline estimate · ${result.route.origin}`;
  const scenarioLabel = isNewRoute
    ? `Proposed route · ${result.route.origin}`
    : `Your plan · ${result.route.origin}`;
  const context = isNewRoute
    ? `The proposed ${result.route.origin} route has no historical baseline. Comparison countries supply starting assumptions only. The headline changes above compare the proposed route with zero. Use Compare to assess adding the same capacity to an existing route.`
    : "Compare the estimated starting totals with your plan. The headline cards above show the changes; expand the assumptions to see what each side uses.";
  const baselineAssumptions = isNewRoute ? [["Historical route capacity", "No records · starts at zero"], ["Observed route hotel demand", "Not available"]] : [
    ["Past seats this month", formatNumber(baseline.seats)],
    ["Flights each week", Number(baselineRoute.weeklyFrequency || 0).toFixed(1)],
    ["Flights expected to be full", formatPercent(baselineRoute.loadFactor, 1)],
    ["Passengers ending in Abu Dhabi", formatPercent(baselineRoute.p2pShare, 1)],
    ["Share estimated to stay in a hotel", formatPercent(data.defaults.captureRate, 1)],
    ["Average hotel stay", `${(baseline.hotelCheckins ? baseline.guestNights / baseline.hotelCheckins : 0).toFixed(1)} nights`],
  ];
  const scenarioAssumptions = [
    ["Seats in your plan", formatNumber(scenario.seats)],
    ["Flights added each week", `${state.extraFlights >= 0 ? "+" : ""}${state.extraFlights}`],
    ["Seats on each flight", formatNumber(state.seatsPerFlight)],
    ["Flights expected to be full", formatPercent(state.loadFactor, 1)],
    ["Passengers ending in Abu Dhabi", formatPercent(state.p2pShare, 1)],
    ["Share checking into a hotel", formatPercent(state.conversionRate, 1)],
    ["Average nights per stay", `${state.averageStay.toFixed(1)} nights`],
    ["Event or disruption impact", `${formatEventPercent(state.eventUplift || 0)} your estimate`],
  ];
  const assumptionList = (items) => items.map(([name, value]) =>
    `<div class="compare-assumption"><span>${name}</span><strong>${value}</strong></div>`,
  ).join("");
  const metric = (name, value) => `
    <div class="compare-metric">
      <span>${name}</span>
      <strong>${formatNumber(value)}</strong>
    </div>`;

  $("#sideBySideComparison").innerHTML = `
    <div class="section-heading">
      <div><p>Side-by-side comparison</p><h2>Baseline estimate and your plan</h2></div>
      <small>${data.months[state.month - 1]} estimate</small>
    </div>
    <p class="comparison-context">${context}</p>
    <div class="side-by-side-grid">
      <article class="compare-card baseline-card">
        <span class="compare-kicker">${isNewRoute ? "NO HISTORICAL ROUTE · ZERO BASELINE" : "ESTIMATE BASED ON PAST FLIGHT RECORDS"}</span>
        <h3>${label}</h3>
        <div class="compare-metrics">
          ${metric("Hotel check-ins", baseline.hotelCheckins)}
          ${metric("Guest nights", baseline.guestNights)}
        </div>
        <details class="compare-assumptions"><summary>Baseline assumptions</summary>${assumptionList(baselineAssumptions)}</details>
      </article>
      <article class="compare-card scenario-card">
        <span class="compare-kicker">YOUR PLAN</span>
        <h3>${scenarioLabel}</h3>
        <div class="compare-metrics">
          ${metric("Hotel check-ins", scenario.hotelCheckins)}
          ${metric("Guest nights", scenario.guestNights)}
        </div>
        <details class="compare-assumptions"><summary>Plan assumptions</summary>${assumptionList(scenarioAssumptions)}</details>
      </article>
    </div>`;
}

 function renderRouteMap(result) {
   // Moving a dial (load factor, P2P share, etc.) changes the numbers but not
   // the route itself. Re-running the label-layout search and the 700ms
   // view-box animation on every slider tick is what made dragging feel
   // laggy. When the route hasn't changed, just refresh the P2P stat text.
   const routeKey = `${result.route.originKey}-${result.route.proxyOriginKey || ""}-${state.month}`;
   if (routeKey === lastRenderedRouteKey && $("#routeMap .map-route-stat strong")) {
     $("#routeMap .map-route-stat strong").textContent = formatNumber(result.scenario.p2p);
     return;
   }
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
     <div class="route-map-overlay">
       <span class="overlay-kicker">FLIGHT ROUTE</span>
       <strong>${result.route.origin} <i>→</i> Abu Dhabi</strong>
       <small>Country reference point → Abu Dhabi city; schematic route, not airport locations${enteredMarketRecord?.name === "Antarctica" ? ". Antarctic outline is unavailable in the supplied map" : ""}</small>
     </div>
     <div class="route-map-footer">
       <div><span class="map-legend-dot origin"></span><strong>${result.route.origin}</strong><small>Departure market</small></div>
       <div class="map-route-stat"><strong>${formatNumber(result.scenario.p2p)}</strong><small>Passengers ending in Abu Dhabi</small></div>
       <div><span class="map-legend-dot destination"></span><strong>Abu Dhabi</strong><small>Destination hub</small></div>
     </div>`;
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
     <p>${route.knownMarket ? "Baseline: an estimate based on past flight records, with estimated hotel use and length of stay. It is not an observed route-level hotel total." : `New route: no flight history is available. ${state.peerProfile ? "The weighted comparison-country blend supplies" : (route.proxyOriginKey || "The available markets") + " supplies"} starting assumptions only. Similar location does not establish similar demand, visitor mix or hotel use. The new route baseline is zero.`}</p>
     <p>The steps below show the values used in this calculation. Percentages are written as fractions (0.8 means 80%). Cards and controls round their display; the calculation keeps the underlying precision. Tiny computer rounding differences below 0.0000001 count as zero change.</p>
     <details><summary>Baseline assumptions and calculation</summary><ol class="calculation-steps">
       ${equation("Passengers", `${exact(route.baselineSeats)} past seats × ${exact(route.loadFactor)} flight fullness`, baseline.passengers)}
       ${equation("Passengers ending their trip here", `${exact(baseline.passengers)} × ${exact(route.p2pShare)} ending-trip share`, baseline.p2p)}
       ${equation("Hotel check-ins", `${exact(baseline.p2p)} × ${exact(data.defaults.captureRate)} hotel-use assumption`, baseline.hotelCheckins)}
       ${equation("Guest nights", `${exact(baseline.hotelCheckins)} × ${exact(historicalStay)} weighted nights per stay`, baseline.guestNights)}
     </ol><p>The baseline uses the original visitor mix to calculate the weighted average stay. Editing your plan does not rewrite this baseline. Flight fullness is capped at 100% when a recorded ratio exceeds capacity.</p></details>
     <details><summary>Your plan: calculation with current assumptions</summary><ol class="calculation-steps">
       ${equation("Seats", `max(0, ${exact(route.baselineSeats)} + ${exact(state.extraFlights)} flights/week × ${exact(state.seatsPerFlight)} seats/flight × ${exact(weeks)} weeks)`, scenario.seats)}
       ${equation("Passengers", `${exact(scenario.seats)} × ${exact(state.loadFactor)} flight fullness`, scenario.passengers)}
       ${equation("Passengers ending their trip here", `${exact(scenario.passengers)} × ${exact(state.p2pShare)} ending-trip share`, scenario.p2p)}
       ${equation("Hotel check-ins", `${exact(scenario.p2p)} × ${exact(state.conversionRate)} hotel-use assumption × (1 ${result.eventUplift < 0 ? "−" : "+"} ${exact(Math.abs(result.eventUplift))} event/disruption adjustment)`, scenario.hotelCheckins)}
       ${equation("Guest nights", `${exact(scenario.hotelCheckins)} × ${exact(state.averageStay)} nights per stay`, scenario.guestNights)}
       ${equation("Change in check-ins", `${exact(scenario.hotelCheckins)} − ${exact(baseline.hotelCheckins)}`, result.delta.hotelCheckins)}
       ${equation("Change in guest nights", `${exact(scenario.guestNights)} − ${exact(baseline.guestNights)}`, result.delta.guestNights)}
     </ol><p>Weeks = days in the selected month ÷ 7; February uses 28.25 days. ${rawSeats < 0 ? "Your flight reduction exceeds the available seats, so seats are limited to zero." : "Seats cannot fall below zero."} The event or disruption adjustment is your assumption and is applied once to hotel check-ins; guest nights then use those check-ins.</p></details>
     <details><summary>Range, visitor groups and evidence</summary>
       <p>Lower guide = ${exact(result.p50)} × ${exact(data.defaults.uncertaintyLow || 0.9)} = ${exact(result.p10)} nights. Upper guide = ${exact(result.p50)} × ${exact(data.defaults.uncertaintyHigh || 1.1)} = ${exact(result.p90)} nights. These multipliers came from seven months of aggregate hotel-arrival errors for the past-pattern comparison model. Applying them to route guest nights is a planning assumption, not a tested route-level probability range.</p>
       <p>Visitor-group check-ins = plan check-ins × that group's normalized share. Nights also use that group's relative stay length, adjusted to match your selected overall average stay. ${bridgeOverride ? "Your edited visitor shares are in use." : "The estimated visitor shares are in use."} Group contributions add up to the headline change; they are not measured nationality-level effects.</p>
       <p>The matching-records badge describes available flight history, not accuracy. The error scores in “Check past results” tested monthly totals, not this route, your changes, the visitor mix, or event effects.</p>
     </details>`;
 }

 function renderChain(result) {
   const stages = [
     ["Seats on flights", result.scenario.seats, "Available places on the planes"],
     ["Passengers", result.scenario.passengers, `${formatPercent(state.loadFactor)} of seats are expected to be filled`],
     ["Passengers ending in Abu Dhabi", result.scenario.p2p, `${formatPercent(state.p2pShare)} are expected to finish their trip here`],
     ["Hotel check-ins", result.scenario.hotelCheckins, result.eventUplift ? `${formatPercent(state.conversionRate)} estimated to stay in a hotel, with your chosen ${formatEventPercent(result.eventUplift)} event or disruption adjustment` : `${formatPercent(state.conversionRate)} estimated to stay in a hotel`],
     ["Nights spent in hotels", result.scenario.guestNights, `${state.averageStay.toFixed(2)} nights per stay, using the hotel check-ins above`],
   ];
   $("#chain").innerHTML = stages.map(([label, value, note], index) => `
     <div class="chain-stage">
       <span>${index + 1}</span>
       <p>${label}</p>
       <strong>${formatNumber(value)}</strong>
       <small>${note}</small>
     </div>`).join("");
 }
  
 function renderComparison(result) {
   const rows = [
     ["Seats on flights", result.baseline.seats, result.scenario.seats],
     ["Passengers", result.baseline.passengers, result.scenario.passengers],
     ["Passengers ending in Abu Dhabi", result.baseline.p2p, result.scenario.p2p],
     ["Hotel check-ins", result.baseline.hotelCheckins, result.scenario.hotelCheckins],
     ["Guest nights", result.baseline.guestNights, result.scenario.guestNights],
   ];
   $("#comparisonChart").innerHTML = rows.map(([label, baseline, scenario]) => {
     const max = Math.max(baseline, scenario, 1);
     return `<div class="comparison-row">
       <div class="comparison-label"><strong>${label}</strong><span>${formatSigned(scenario - baseline)}</span></div>
       <div class="comparison-line"><small>Baseline ${formatNumber(baseline)}</small><div><i class="baseline-bar" style="width:${baseline / max * 100}%"></i></div></div>
       <div class="comparison-line"><small>Your plan ${formatNumber(scenario)}</small><div><i class="scenario-bar" style="width:${scenario / max * 100}%"></i></div></div>
     </div>`;
   }).join("");
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
   const selected = routes.find((route) => route.month === state.month);
   const busiest = routes.reduce((best, route) => !best || route.baselineSeats > best.baselineSeats ? route : best, null);
   $("#seasonSummary").innerHTML = routes.length ? `
     <div><span><i class="season-selected-dot"></i>Selected month · ${data.months[state.month - 1]}</span><strong>${formatNumber(selected?.baselineSeats || 0)} <small>seats</small></strong></div>
     <div><span>Highest monthly average · ${data.months[busiest.month - 1]}</span><strong>${formatNumber(busiest.baselineSeats)} <small>seats</small></strong></div>
     <p>Based on past flight records for ${result.route.origin}. These are starting seat estimates, not future bookings. Focus or hover on a bar for its exact value.</p>` : "";
 }
  
 function renderRouteAudit(result) {
   const capture = data.defaults.captureRate;
   const startingSource = state.peerProfile ? "a weighted blend of " + state.peerProfile.peers.map((peer)=>peer.origin).join(", ") : (result.route.proxyOriginKey || "the selected comparison country");
   $("#routeAudit").innerHTML = `<table>
     <thead><tr><th>Number used</th><th>For this route and month</th><th>Where it comes from</th></tr></thead>
     <tbody>
       <tr><td>Past flight seats</td><td>${formatNumber(result.route.baselineSeats)}</td><td>${result.route.knownMarket ? `Average number of seats from ${result.route.origin} in ${data.months[state.month - 1]} in the supplied records.` : "No past flight seats for this route. Starting assumptions use " + startingSource + "."}</td></tr>
       <tr><td>Reference flights each week</td><td>${Number(result.route.weeklyFrequency).toFixed(1)}</td><td>${result.route.knownMarket ? "Average weekly flights recorded for this country and month." : state.peerProfile ? "No historical schedule for this new route. Use the proposed extra flights above; the comparison blend does not borrow a schedule." : `Reference schedule for ${result.route.proxyOriginKey || "the comparison country"} only; not a schedule for the proposed route.`}</td></tr>
       <tr><td>Flights added or removed each week</td><td>${state.extraFlights}</td><td>Your scenario assumption; multiplied by seats per flight and weeks in the month.</td></tr>
       <tr><td>Seats on each flight</td><td>${formatNumber(state.seatsPerFlight)}</td><td>${result.route.knownMarket ? "Based on past flights. You can change it." : `Starts from ${startingSource}. You can change it.`}</td></tr>
       <tr><td>Flights expected to be full</td><td>${formatPercent(state.loadFactor, 1)}</td><td>${result.route.knownMarket ? "Based on how full past flights were. You can change it." : `Starts from ${startingSource}. There are no past records for this route.`}</td></tr>
       <tr><td>Passengers ending in Abu Dhabi</td><td>${formatPercent(state.p2pShare, 1)}</td><td>${result.route.knownMarket ? "Past share of passengers whose journey ended in Abu Dhabi. You can change it." : `Starts from ${startingSource}. There are no past records for this route.`}</td></tr>
       <tr><td>Share expected to stay in hotels</td><td>${formatPercent(state.conversionRate, 1)}</td><td>Estimated share of passengers ending their trip here who check into hotels. You can change it.</td></tr>
       <tr><td>Event or disruption impact</td><td>${formatEventPercent(state.eventUplift)}</td><td>Your chosen adjustment to hotel arrivals and nights across the proposed plan. It is not measured from past event results.</td></tr>
       <tr><td>Average nights per hotel stay</td><td>${String(state.averageStay)}</td><td>Your plan uses this overall average stay. The baseline keeps its original weighted average from the historical visitor mix.</td></tr>
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
   const changes = {"Average nights per hotel stay":"±0.5 nights", "Share checking into a hotel":"±5 percentage points", "Passengers ending in Abu Dhabi":"±5 percentage points", "How full flights are":"±5 percentage points", "Extra flights each week":"±1 flight/week", "Seats on each flight":"±30 seats", "Event or disruption impact":"±10 percentage points"};
   $("#focusDrivers").innerHTML = rows.slice(0, 3).map((row, index) => `<article class="focus-driver"><span class="driver-rank">0${index + 1}</span><div><strong>${row.label}</strong><small>${changes[row.label] || "Change one assumption"}, within control limits</small></div><b>${formatNumber(row.span)}<small>night spread</small></b></article>`).join("") + '<p class="driver-note">Spread between the lower and higher trial results, changing one assumption at a time. These trial sizes differ, so this is not a ranking of certainty or real-world effects.</p>';
   const max = Math.max(...rows.map((row) => row.span), 1);
   $("#sensitivityBars").innerHTML = rows.map((row) => {
     const width = Math.max(4, row.span / max * 100);
     return `<div class="sensitivity-row">
       <span>${row.label}</span>
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

function visitorOriginMap(rows, colors, flag, escape) {
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
    const label = `${flag(location)} ${row.nationality} ${formatPercent(row.weight, 1)}`;
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
      label: `<g class="vm-map-label" tabindex="0" role="img" aria-label="${escape(label)}"><title>${escape(row.nationality)}: ${formatPercent(row.weight, 1)} · country reference point</title><path d="M ${x} ${y} L ${anchorX} ${anchorY}" stroke="${color}" opacity=".45"/><rect x="${best.x}" y="${best.y}" width="${width}" height="29" rx="6"/><text x="${best.x + 11}" y="${best.y + 19}" fill="${color}">${escape(label)}</text></g>` };
  });
  const viewTop = Math.max(0, Math.min(85, ...occupied.map(label => label.y - 12), ...routes.map(route => route.arcTop - 12)));
  const viewBottom = Math.max(520, ...occupied.map(label => label.y + label.height + 12));
  return `<header class="vm-map-header"><span><i></i> GEOGRAPHIC ORIGIN MAP</span><h3>Global Visitor Origins</h3></header><svg class="vm-origin-svg" viewBox="0 ${viewTop} 1000 ${viewBottom - viewTop}" preserveAspectRatio="none" role="group" aria-label="Estimated nationality origins connected to Abu Dhabi; illustrative country-centroid arcs"><image class="vm-world-outline" href="./data/admin0-countries.svg?v=20260922-admin0" x="0" y="85" width="1000" height="500" preserveAspectRatio="none"/>${routes.map(r => r.arc).join("")}${routes.map(r => r.label).join("")}<circle class="vm-hub-halo" cx="${hub[0]}" cy="${hub[1]}" r="20"/><circle class="vm-hub" cx="${hub[0]}" cy="${hub[1]}" r="6"/><g class="vm-hub-label" transform="translate(${hub[0] - 6} ${hub[1] + 23})"><text>ABU DHABI</text><text y="19" class="vm-hub-subtitle">Destination hub</text></g></svg><footer class="vm-map-footer"><span class="vm-map-key"><i></i> Top nationality groups → Abu Dhabi</span><p>Illustrative nationality origins, not verified departure airports or flight paths. Locations use country reference points. Other nationalities are included in the cards.</p>${located.length < activeRows.length ? '<p>Some nationality locations are unavailable and are not plotted.</p>' : ''}</footer>`;
}

 function renderBridge(result) {
   bridgeDraft = result.bridge;
   const rows = result.bridge.slice(0, 10);
   let editButton = $("#editBridgeMix");
   if (!editButton) {
     editButton = document.createElement("button");
     editButton.id = "editBridgeMix";
     editButton.type = "button";
     editButton.addEventListener("click", () => {
       bridgeEditing = !bridgeEditing;
       renderBridge(runScenario(data, { ...state, bridgeOverride }));
       $("#bridgeStatus").textContent = bridgeEditing
         ? "Set a final share. Other shares adjust automatically. Check-ins, guest nights and the map update when you apply."
         : "Editing cancelled. The applied visitor mix is unchanged.";
       if (bridgeEditing) $(".bridge-input")?.focus();
     });
     $("#resetBridge").before(editButton);
     $("#bridgeView .section-heading p").textContent = "Visitor mix";
     $("#bridgeView .section-heading h2").textContent = "Largest nationality groups";
     const tablePanel = $("#bridgeView .visitor-workspace .table-scroll");
     tablePanel.insertAdjacentHTML("beforebegin", '<div class="visitor-nationality-cards" id="visitorNationalityCards"></div>');
     $("#visitorNationalityCards").setAttribute("tabindex", "0");
     $("#visitorNationalityCards").setAttribute("role", "region");
     $("#visitorNationalityCards").setAttribute("aria-label", "Nationality cards, scroll to view more countries");
     tablePanel.hidden = true;
     $("#bridgeView .visitor-workspace").classList.add("visitor-atlas-workspace");
     $("#bridgeShareChart").parentElement.classList.add("visitor-origin-map");
     $("#bridgeShareChart").parentElement.querySelector("h3").hidden = true;
     $("#bridgeShareChart").nextElementSibling.hidden = true;
   }
   editButton.textContent = bridgeEditing ? "Cancel editing" : "Edit mix";
   editButton.setAttribute("aria-pressed", String(bridgeEditing));
   $("#applyBridge").disabled = !bridgeEditing;
   $("#bridgeView").classList.toggle("mix-editing", bridgeEditing);
   $("#bridgeTitle").textContent = `Estimated visitors from ${result.route.origin}`;
   $("#bridgeExplanation").textContent = result.route.knownMarket
     ? "These percentages estimate which nationalities may make up hotel guests on this route. They are based on past patterns, not a list of confirmed guests."
     : `There are no past flight records for ${result.route.origin}. The visitor estimate starts from ${state.peerProfile ? "the weighted comparison-country blend" : result.route.proxyOriginKey || "overall past patterns"}, so use it as a rough guide.`;
   $("#visitorNationalityCards").innerHTML = "";
   $("#bridgeTableBody").innerHTML = rows.map((row, index) => `
     <tr>
       <td>${row.nationality}</td>
       <td>${row.relationship === "direct and inferred" ? "Flight and hotel records" : "Based on past patterns"}</td>
       <td><input id="mixShare-${index}" aria-label="${row.nationality} share percent" class="bridge-input" ${bridgeEditing ? "" : "disabled"} data-index="${index}" data-displayed="${(row.weight * 100).toFixed(1)}" type="range" min="0" max="100" step="0.1" value="${(row.weight * 100).toFixed(1)}"></td>
       <td class="mix-number">${formatNumber(result.scenario.hotelCheckins * row.weight)}</td>
       <td class="mix-number">${formatNumber(result.contributions.find((item) => item.nationality === row.nationality)?.scenarioGuestNights)}</td>
     </tr>`).join("");
   const remaining = result.bridge.slice(10);
   const others = remaining.reduce((sum, row) => sum + row.weight, 0);
   const otherNights = result.contributions.filter((item) => remaining.some((row) => row.nationality === item.nationality)).reduce((sum, row) => sum + row.scenarioGuestNights, 0);
   $("#bridgeTableBody").insertAdjacentHTML("beforeend", `<tr class="other-nationalities"><td>Other ${remaining.length} nationalities</td><td>Included in the total</td><td data-bridge-other>${formatPercent(others,1)}</td><td>${formatNumber(result.scenario.hotelCheckins * others)}</td><td>${formatNumber(otherNights)}</td></tr>`);
   const escapeLabel = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
   const flag = (location) => {
     const code = location?.aliases?.find(alias => /^[A-Z]{2}$/.test(alias)) || ({ France: "FR", Norway: "NO" })[location?.name];
     return code ? [...code].map(letter => String.fromCodePoint(127397 + letter.charCodeAt(0))).join("") : "◈";
   };
   const palette = ["#e5c365", "#e0757e", "#79a5ed", "#a891d5", "#76b8d1", "#91b897", "#e1b78b", "#91a4c4", "#b3bd7e", "#bc91ab"];
   const card = ({ row, index }, rank) => {
     const nationality = escapeLabel(row.nationality);
     const location = countryLocationLookup[normalizeCountryName(row.nationalityKey || row.nationality)];
     const nights = result.contributions.find(item => item.nationality === row.nationality)?.scenarioGuestNights;
     const featured = rank === 0;
     const ring = featured ? `<div class="vm-feature-ring" data-mix-ring="${index}"><svg viewBox="0 0 120 120" aria-label="${nationality}: ${formatPercent(row.weight, 1)}"><circle cx="60" cy="60" r="49" class="vm-ring-track"/><circle cx="60" cy="60" r="49" class="vm-ring-value" pathLength="100" stroke-dasharray="${row.weight * 100} ${100 - row.weight * 100}" transform="rotate(-90 60 60)"/></svg><strong>${formatPercent(row.weight, 1)}</strong></div>` : '';
     return `<article class="vm-nationality-card${featured ? ' vm-featured-card' : ''}" style="--nationality-color:${palette[index]}"><span class="vm-card-rank">#${String(rank + 1).padStart(2, '0')}</span>${ring}<div class="vm-card-country"><span class="vm-country-flag" aria-hidden="true">${flag(location)}</span><h3>${nationality}</h3>${featured ? '<small>Largest nationality group</small>' : ''}</div><div class="vm-card-share"><span class="vm-share-value">${formatPercent(row.weight, 1)}</span><span class="vm-share-editor" data-mix-slot="${index}"></span><small>Share of check-ins</small></div><div class="vm-card-counts"><div><strong>${formatNumber(result.scenario.hotelCheckins * row.weight)}</strong><span>Stays / check-ins</span></div><div><strong>${formatNumber(nights)}</strong><span>Guest nights</span></div></div></article>`;
   };
   $("#visitorNationalityCards").innerHTML = rows.map((row, index) => ({ row, index })).sort((a, b) => b.row.weight - a.row.weight).map(card).join("") + `<article class="vm-nationality-card vm-other-card" style="--nationality-color:#61708b"><div class="vm-card-country"><h3>Other nationalities</h3><small>${remaining.length} groups combined</small></div><div class="vm-card-share"><span class="vm-share-value" data-bridge-other>${formatPercent(others, 1)}</span></div><div class="vm-card-counts"><div><strong>${formatNumber(result.scenario.hotelCheckins * others)}</strong><span>Stays / check-ins</span></div><div><strong>${formatNumber(otherNights)}</strong><span>Guest nights</span></div></div></article>`;
   rows.forEach((row, index) => {
     const field = $(`#bridgeTableBody .bridge-input[data-index="${index}"]`);
     field.addEventListener("input", changeVisitorShare);
     const slot = $(`[data-mix-slot="${index}"]`);
     slot.append(field);
     slot.insertAdjacentHTML("beforeend", `<span class="vm-slider-readout"><output class="vm-slider-badge" for="mixShare-${index}">${Number(field.value).toFixed(1)}</output><span>%</span></span>`);
   });
   updateBridgeDraftTotal();
   $("#bridgeShareChart").innerHTML = visitorOriginMap(rows, palette, flag, escapeLabel);
   if ($("#bridgeStatus").textContent.startsWith("All 45 groups") || $("#bridgeStatus").textContent.includes("table is read-only")) $("#bridgeStatus").textContent = "All nationalities are included. Choose Edit mix to adjust the card shares, then Update visitor mix to apply them.";
   const supportLabels = { Low: "No route records", Medium: "A few records", High: "Several records" };
   const supportLabel = supportLabels[result.confidence.label] || "Past records";
   $("#confidenceLabel").textContent = supportLabel;
   $("#confidenceLabelCopy").textContent = supportLabel;
   $("#confidenceReason").textContent = result.confidence.reason;
   $("#confidenceBadge").className = `confidence ${result.confidence.label.toLowerCase()}`;
   $("#confidenceBadgeCopy").className = `confidence ${result.confidence.label.toLowerCase()}`;
 }
  
 function renderValidation() {
   const metrics = data.metrics;
   const actualTotal = data.validation.reduce((sum, row) => sum + row.actual, 0);
   const errorTotal = (field) => data.validation.reduce((sum, row) => sum + Math.abs(row.actual - row[field]), 0);
   const liveError = errorTotal("transparent") / actualTotal;
   const periodLabel = (period) => `${data.months[Number(period.slice(5, 7)) - 1].slice(0, 3)} ${period.slice(0, 4)}`;
   const checkedPeriod = `${periodLabel(data.validation[0].month)}–${periodLabel(data.validation[data.validation.length - 1].month)}`;
   $("#validationSummary").textContent = `Air2Stay was tested on ${data.validation.length} months kept out of conversion calibration (${checkedPeriod}). Its overall weighted error was ${formatPercent(liveError, 2)} of recorded hotel arrivals. The chart below compares estimates with actual arrivals month by month. This checks monthly totals using recorded flight inputs.`;
   let validationWindows = $("#validationWindows");
   if (!validationWindows) {
     $("#validationSummary").insertAdjacentHTML("afterend", '<section id="validationWindows" aria-label="Validation windows"></section>');
     validationWindows = $("#validationWindows");
   }
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
       <div class="validation-window-progression"><span>fuller test →</span></div>
       <article class="validation-window-card validation-window-secondary" aria-labelledby="extendedWindowLabel">
         <span class="validation-window-metric">10.42%</span>
         <h2 id="extendedWindowLabel">Extended validation window</h2>
         <p>Jan 2025–Feb 2026 · 14 months</p>
         <small>13.93% on Aug 2025–Feb 2026 alone</small>
       </article>
     </div>
     <p class="validation-window-context">Error increases on more recent data — expected as the model was trained on 2022–2024. A production system would retrain quarterly.</p>
     <p class="validation-window-source">Extended-window figures are supplied results; their monthly records are not included in this build. Quarterly retraining is a proposed production practice.</p>`;
   $("#validationScope").innerHTML = `
     <p>These are error scores, not “percent accurate” scores. Lower means a smaller gap from recorded hotel arrivals.</p>
     <p>Training: ${metrics.flightTrainingPeriod} (${metrics.trainingMonths} months). Check period: ${metrics.validationPeriod} (${data.validation.length} months). The test used recorded flight totals for those same months to estimate total hotel arrivals across all included departure markets, then compared them with recorded monthly hotel totals. It did not forecast future flight demand.</p>
     <p><strong>Live default calculation:</strong> seats × flight occupancy × share ending in Abu Dhabi × a single hotel-use rate learned only from ${metrics.flightTrainingPeriod}. The check runs this chain on each held-out country-month’s recorded flights, then sums the estimates across countries. It uses the same formula and conversion default as the live planner. It does not test future flight schedules, occupancy forecasts, edited assumptions, visitor shares, or guest nights. Historical route baselines and visitor profiles are descriptive summaries, not independently held-out forecasts.</p>
     <p><strong>Seasonal comparison:</strong> recorded passengers ending here × (70% training month-specific hotel-use rate + 30% overall training rate). Its separate weighted error is ${formatPercent(metrics.seasonalChainWmape, 2)}. This is the optional seasonal assumption in Details, not the default.</p>
     <p><strong>Hybrid comparison:</strong> 55% regression estimate + 45% seasonal flight estimate. It has its own error score; the route planner does not run this aggregate regression.</p>
     <p><strong>Reproduce the scores:</strong> add the absolute monthly mistakes and divide by recorded hotel arrivals (WMAPE). Live default: ${formatNumber(errorTotal("transparent"))} ÷ ${formatNumber(actualTotal)} × 100 = ${formatPercent(errorTotal("transparent") / actualTotal, 2)}. Hybrid comparison: ${formatNumber(errorTotal("predicted"))} ÷ ${formatNumber(actualTotal)} × 100 = ${formatPercent(errorTotal("predicted") / actualTotal, 2)}. Scores use full-precision predictions; the table and totals round only for readability.</p>
     <p><strong>Daily hotel guests:</strong> a separate check over ${metrics.stayValidationPeriod}, with ${formatNumber(metrics.stayValidationRows)} held-out daily records. It tested daily hotel guest counts using hotel-arrival information, not route guest-night changes. Its underlying daily rows are not shown in this monthly table.</p>
     <p>None of these tests establishes accuracy for a specific route, a new country, an added flight, an event uplift, nationality shares, or route-level guest nights. The matching-records badge measures history coverage only. Range multipliers use the live default chain’s residuals on the same seven check months and have no separate coverage test.</p>`;
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
   <p class="validation-table-caption">Lower % = closer estimate. Overall weighted average: <strong>${formatPercent(liveError, 2)}</strong> (live default).</p>`;

   let modelComparison = $("#validationModelComparison");
   if (!modelComparison) {
     $("#validationView").insertAdjacentHTML("beforeend", '<section id="validationModelComparison" class="content-block" aria-labelledby="modelComparisonTitle"></section>');
     modelComparison = $("#validationModelComparison");
   }
   modelComparison.innerHTML = `
     <div class="section-heading"><div><p>Compare the approaches</p><h2 id="modelComparisonTitle">Model comparison</h2></div></div>
     <p class="model-comparison-periods">Training: 2022–2024. Test scores read left to right: Jan–Jul 2025 → Aug 2025–Feb 2026. Lower weighted error (WMAPE) means a closer estimate.</p>
     <div class="model-comparison-scroll" tabindex="0" role="region" aria-label="Model comparison scores; scroll horizontally on narrow screens">
       <table>
         <thead><tr><th scope="col">Model</th><th scope="col">Train WMAPE</th><th scope="col">Test WMAPE</th><th scope="col">Verdict</th></tr></thead>
         <tbody>
           <tr class="model-comparison-live"><th scope="row">Live chain</th><td>9.67%</td><td>${formatPercent(liveError, 2)} <span class="model-score-arrow">→</span> 13.93%</td><td>Underfit: constant rate can't follow seasonality</td></tr>
           <tr><th scope="row">Seasonal chain</th><td>4.90%</td><td>${formatPercent(metrics.seasonalChainWmape, 2)} <span class="model-score-arrow">→</span> 8.72%</td><td>Fine, but drifts low</td></tr>
           <tr><th scope="row">Ridge alone</th><td>5.53%</td><td>8.56% <span class="model-score-arrow">→</span> 11.88%</td><td>Mild overfit</td></tr>
         </tbody>
       </table>
     </div>
     <p class="model-comparison-source">The primary live and seasonal test scores match saved results. Training, Ridge-only and later-window scores are supplied figures; verdicts are supplied interpretations, not verified diagnoses.</p>`;
 }
  
 function renderRecommendation(result) {
   const drivers = sensitivity(data, { ...state, bridgeOverride });
   const topDrivers = drivers.slice(0, 3);
   const lead = topDrivers[0];
   const leadText = lead
     ? `Validate ${lead.label.toLowerCase()} first; it has the largest spread in the trials above.`
     : "There isn’t enough information to show which change matters most.";
   $("#recommendationText").textContent = `${leadText} This is only a possible result, not a promise. Check the details below before making a decision.`;

   const route = result.route.origin;
   const month = data.months[state.month - 1];
   const steps = [
     ["Route demand", `For ${route} in ${month}, ask the airline or airport how many seats are planned, how quickly they are being booked, and how many passengers arrive. For a new route, use numbers for that route when you can get them instead of the nearby country’s numbers.`],
     ["Hotel capacity", `Compare the guest-night change shown above with available rooms, expected hotel occupancy, and typical stay length in ${month}.`],
     ["Visitor mix", "Check these visitor groups and arrival numbers against official visitor and hotel records before using them for marketing plans."],
   ];
   const container = $("#plannerSteps");
   container.replaceChildren();
   for (const [title, description] of steps) {
     const article = document.createElement("article");
     article.className = "planner-step";
     const heading = document.createElement("h3");
     heading.textContent = title;
     const copy = document.createElement("p");
     copy.textContent = description;
     article.append(heading, copy);
     container.append(article);
   }
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
  $("#monthOptions").innerHTML = planningTable(["Month","Extra guest nights","Nights / 1,000 added seats","Flights full","Hotel use","Nights / stay"],monthly.map((row)=>[row.monthName,formatNumber(row.incremental.guestNights),row.per1000AddedSeats == null ? "—" : formatNumber(row.per1000AddedSeats),formatPercent(row.inputs.loadFactor,1),formatPercent(row.inputs.conversionRate,1),row.inputs.averageStay.toFixed(2)]));
  const stress = stressTest(data,state);
  $("#stressOptions").innerHTML = planningTable(["Trial","Extra guest nights","Change from selected assumptions"],[["Selected assumptions",formatNumber(stress.base.incremental.guestNights),"—"],...stress.trials.map((row)=>[row.label,formatNumber(row.incremental.guestNights),formatSigned(row.differenceFromPlan)])]);
  const note = decisionNote(data,state,options);
  const ending = note.workplaceDecision;
  $("#decisionNote").innerHTML = `<p class="decision-question">${planningEscape(ending.question)}</p>
    <div class="decision-answers"><article><h3>Hotel nights to plan for</h3><p>${planningEscape(ending.hotelNightsText)}</p><small>${planningEscape(ending.lowerTrialText)}</small></article>
    <article><h3>Check this assumption first</h3><p>${planningEscape(ending.driverText)}</p><small>${planningEscape(ending.priorityCheck)}</small></article></div>
    <h3>Verify before acting</h3><ol>${ending.verification.map((line)=>'<li>'+planningEscape(line)+'</li>').join('')}</ol>
    <p class="planning-note">${planningEscape(ending.caution)}</p><details><summary>How the route alternatives compare</summary><p>${planningEscape(note.comparisonSummary)}</p></details>`;
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
  $("#conversionEvidence").innerHTML = `<p>Country-specific hotel-use rates cannot be reliably identified: flight countries are departure markets, while hotel countries are passport nationalities.</p><p>For ${planningEscape(data.months[state.month-1])}, the optional training-season aggregate rate is <strong>${formatPercent(rate,2)}</strong>. It uses three observations of that calendar month from ${evidence.trainingPeriod}. It is not a measured probability for this route.</p><p>The seven checked months had ${formatPercent(evidence.validation.wmape,2)} error using seasonal rates and ${formatPercent(evidence.validation.constantTrainingGlobalWmape,2)} using the training-only constant rate. Lower is better; seasonality did not improve this check. August–December have no matching held-out month in this test.</p><details><summary>Method and monthly starting rates</summary><p>${planningEscape(evidence.method)}</p><div class="table-scroll">${planningTable(["Month","Optional hotel-use assumption"],Object.entries(evidence.monthlyRates).map(([month,value])=>[data.months[Number(month)-1],formatPercent(value,2)]))}</div></details>`;
  if (!peerValidationResult) peerValidationResult = validatePeerMethod(data,countryLocationLookup);
  const validation=peerValidationResult;
  $("#peerValidation").innerHTML = `<p>We hid one known market at a time and reconstructed its flight assumptions from other markets in the same month: ${validation.caseCount} market-month checks across ${validation.marketCount} markets.</p><div class="table-scroll">${planningTable(["Assumption","Three-market average error","Nearest-country average error"],Object.values(validation.metrics).map((row)=>[row.label,row.blendedMae.toFixed(2)+" "+row.unit,row.nearestMae.toFixed(2)+" "+row.unit]))}</div><ul>${validation.limitations.map((line)=>'<li>'+planningEscape(line)+'</li>').join('')}</ul>`;
}

function setupDecisionTools() {
  ["alternativeOrigin","sameComparisonAssumptions","refreshMonthAssumptions"].forEach((id)=>$("#"+id).addEventListener("input",()=>{if(id==="alternativeOrigin") $("#alternativeOrigin").dataset.userSelected="true";renderDecisionWorkspace();}));
  $("#refreshMonthAssumptions").addEventListener("input", () => {
    if (currentProposalContext) renderKpis(currentProposalContext.result);
  });
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
    const note=decisionNote(data,state,decisionOptions());
    const peerText=state.peerProfile ? "\n\nComparison-country starting weights\n"+state.peerProfile.peers.map((peer)=>peer.origin+": "+formatPercent(peer.weight,1)).join("\n")+"\nGeographic assumptions only; not measured route demand." : "";
    const targetText = targetSolution ? "\n\nCapacity target check\n" + $("#targetResult").textContent : "";
    downloadPlan(new Blob([note.text+peerText+targetText],{type:"text/plain;charset=utf-8"}),"Air2Stay-decision-note.txt");
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
     proposalWorkspace?.update(null);
     $("#inputError").textContent = pendingCountry ? "Choose and confirm a departure country to calculate a new route." : `Please enter ${invalid.id === "averageStay" ? "average nights per stay" : invalid.id === "seatsPerFlight" ? "seats per flight" : "a value"} between ${invalid.min} and ${invalid.max} to see the results.`;
     return;
   }
   readForm();
   const result = runScenario(data, state);
   renderKpis(result);
   renderCalculationExplanation(result);
   renderSideBySideComparison(result);
   renderRouteMap(result);
   renderComparison(result);
   renderSeasonProfile(result);
   renderRouteAudit(result);
   renderChain(result);
   renderContributions(result);
   renderSensitivity();
   renderBridge(result);
   renderRecommendation(result);
   renderDecisionWorkspace();
   renderPlanningEvidence(result);
   $("#scenarioName").textContent = `${result.route.origin}, ${data.months[state.month - 1]}`;
   $("#headerScenario").textContent = `${result.route.origin} · ${data.months[state.month - 1]}`;
   updateStartingMarkers();
   $("#dataNote").textContent = result.route.knownMarket
     ? `Baseline: an estimate based on past flight records (${result.route.yearsObserved} matching records), with assumed hotel use and length of stay. Hotel totals for this route were not directly observed.`
     : `No past flight records for this route. ${state.peerProfile ? "A weighted blend of comparison countries supplies starting assumptions" : (result.route.proxyOriginKey || "The comparison country") + " is only a starting point"}, not evidence of demand. The proposed route starts from zero.`;
   if (result.eventUplift) {
     $("#dataNote").textContent += ` Includes your chosen ${formatEventPercent(result.eventUplift)} event or disruption adjustment; this is not based on measured event results.`;
   }
   const nextContext = {inputs:JSON.parse(JSON.stringify({...state,bridgeOverride})),result,decision:decisionNote(data,state)};
   const changed = currentProposalContext && JSON.stringify(currentProposalContext.inputs) !== JSON.stringify(nextContext.inputs);
   currentProposalContext = nextContext;
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
    eventUplift:"Event or disruption impact must be between −50% and +50%.",
    extraFlights:"Use between 20 fewer and 20 extra flights each week.",
    seatsPerFlight:"Use between 30 and 600 seats per flight.",
  };
  return labels[String(error.message).split(" ")[0]] || error.message;
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

   for (const button of $$("[data-flight-step]")) {
     button.addEventListener("click", () => {
       const field = $(`#${button.dataset.flightControl}`);
       if (Number(button.dataset.flightStep) < 0) field.stepDown();
       else field.stepUp();
       field.dispatchEvent(new Event("input", { bubbles: true }));
     });
   }
  
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

  
   $("#resetBridge").addEventListener("click", () => { bridgeOverride = null; bridgeEditing = false; renderAll(); $("#bridgeStatus").textContent = "Original estimated visitor mix restored. Your flight and hotel assumptions are unchanged."; });
   $("#applyBridge").addEventListener("click", () => {
     if (!bridgeEditing) return;
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
     if (open) $("#origin").focus({preventScroll:true});
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
   $("#showDetails").addEventListener("click", () => {
     setMode("details");
     $(".workspace-toolbar").scrollIntoView({block: "start"});
     $('.view-mode[data-mode="details"]').focus();
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
  for (const field of $$('#scenarioForm input[type="range"]:not(#extraFlights)')) {
    let shell = field.parentElement;
    if (!shell.classList.contains("range-shell")) {
      shell = document.createElement("div"); shell.className = "range-shell";
      field.before(shell); shell.append(field);
      const tick = document.createElement("span"); tick.className = "starting-tick"; shell.append(tick);
    }
    const value = starting[field.id] * (["loadFactor", "p2pShare", "conversionRate", "eventUplift"].includes(field.id) ? 100 : 1);
    const position = Math.max(0, Math.min(100, (value - Number(field.min)) / (Number(field.max) - Number(field.min)) * 100));
    shell.style.setProperty("--start", position + "%");
    shell.querySelector(".starting-tick").title = "Starting value: " + value.toFixed(1);
    shell.closest("label").classList.toggle("changed", Math.abs(Number(state[field.id]) - starting[field.id]) > 1e-7);
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
  $("#exportScenario").addEventListener("click", () => {
    if (!ready()) return;
    const result = runScenario(data, state);
    const payload = { ...planSnapshot(), app: "Air2Stay", baseline: result.baseline, scenario: result.scenario, change: result.delta,
      notes: ["Baseline is estimated from past flight records, not observed route hotel totals.", "New-route comparison countries supply starting assumptions only.", "Event uplift is a user assumption. Range guides are not guaranteed probabilities."], comparisonCountry: state.proxyOriginKey || null,
      planningContext: {purpose:state.routePurpose || "mixed",purposeAssumptionsApplied:Boolean(state.purposeAssumptionsApplied),startingMethod:state.peerProfile?.method || "Single market / historical route",hotelUseSource:state.seasonalConversion ? "Training-only aggregate seasonal assumption; not a demonstrated accuracy improvement" : "Selected scenario assumption",capacityEffect:planningMetrics(data,state).incremental} };
    downloadPlan(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}), "Air2Stay-plan.json");
    guidedHelp?.track("export_json");
    $("#planActionStatus").textContent = "Plan exported with assumptions and results.";
  });
  $("#exportCsv").addEventListener("click", () => {
    if (!ready()) return;
    const result = runScenario(data, state);
    const resultLabels = {seats:"Flight seats",passengers:"Passengers",p2p:"Passengers ending in Abu Dhabi",hotelCheckins:"Hotel check-ins",guestNights:"Guest nights"};
    const assumptionLabels = {extraFlights:"Extra flights per week",seatsPerFlight:"Seats per flight",loadFactor:"How full flights are",p2pShare:"Passengers ending in Abu Dhabi",conversionRate:"Share checking into a hotel",averageStay:"Nights per hotel stay",eventUplift:"Event or disruption impact"};
    const rows = [["Section","Item","Unit","Baseline","Plan","Change","Note"],
      ["Context","Departure country","","",result.route.origin,"",""],
      ["Context","Month","","",data.months[state.month-1],"",""],
      ["Context","Travel purpose","","",state.routePurpose || "mixed","","User label; no measured purpose-specific preset"],
      ["Context","Starting countries","","",state.peerProfile ? state.peerProfile.peers.map((peer)=>peer.origin+" "+formatPercent(peer.weight,1)).join("; ") : (state.proxyOriginKey || result.route.origin),"","Comparison-market assumptions are not evidence of demand"],
      ["Context","Comparison country","","",state.proxyOriginKey || "Not needed for existing route","","Starting assumptions only for new routes"],
      ...["seats","passengers","p2p","hotelCheckins","guestNights"].map((key) => ["Result",resultLabels[key],"count",result.baseline[key],result.scenario[key],result.delta[key],"Baseline estimated from past flight records; hotel totals not directly observed"]),
      ...Object.entries(assumptionLabels).map(([key,label]) => { const percent = ["loadFactor","p2pShare","conversionRate","eventUplift"].includes(key); return ["Assumption",label,percent ? "percent" : "number","",state[key] * (percent ? 100 : 1),"",key === "eventUplift" ? "User assumption; not measured event impact" : ""]; }),
      ...result.contributions.map((row) => ["Visitor estimate",row.nationality,"guest nights",row.baselineGuestNights,row.scenarioGuestNights,row.deltaGuestNights,"Estimated group allocation"])
    ];
    const csv = rows.map((row) => row.map((value) => '"' + String(value).replaceAll('"','""') + '"').join(",")).join("\r\n");
    downloadPlan(new Blob(["\ufeff" + csv],{type:"text/csv;charset=utf-8"}), "Air2Stay-plan.csv");
    guidedHelp?.track("export_csv");
    $("#planActionStatus").textContent = "Spreadsheet exported with assumptions and results.";
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
     $$("#glossaryGrid .definition").forEach((card) => { card.hidden = !card.dataset.search.includes(value); if (!card.hidden) matches++; });
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
  
 async function init() {
   try {
     await loadData();
     state = defaultState();
     setupEventControls();
     setupTabs();
     setupViewMode();
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
   } catch (error) {
     document.body.innerHTML = `<main class="fatal"><h1>Air2Stay could not start</h1><p>${planningEscape(error.message)}</p><p>From the project folder, run <code>python run_local.py --check</code> to find missing files or packages. Follow the Quick Start in README.md, then open http://localhost:8765.</p></main>`;
   }
 }
  
 init();
