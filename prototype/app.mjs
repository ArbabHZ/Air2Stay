 import { findRoute, parseScenarioPrompt, runScenario, sensitivity } from "./engine.mjs";
  
 const $ = (selector) => document.querySelector(selector);
 const $$ = (selector) => [...document.querySelectorAll(selector)];
 const formatNumber = (value) => Math.round(value || 0).toLocaleString("en-US");
 const formatSigned = (value) => `${value >= 0 ? "+" : "−"}${formatNumber(Math.abs(value))}`;
 const formatPercent = (value, digits = 0) => `${(Number(value) * 100).toFixed(digits)}%`;
  
 let data;
 let state;
 let bridgeOverride = null;
  
 async function loadData() {
   const response = await fetch("./data/scenario_data.json");
   if (!response.ok) throw new Error("Could not load the model data.");
   data = await response.json();
 }
  
 function knownOrigins() {
   return [...new Map(data.routes.map((route) => [route.originKey, route.origin])).entries()]
     .map(([key, name]) => ({ key, name }))
     .sort((a, b) => a.name.localeCompare(b.name));
 }
  
 function defaultState(originKey = "INDIA", month = 12) {
   const route = findRoute(data, originKey, month);
   const bridge = data.bridge?.[route.originKey]?.[String(month)] || data.fallbackBridge[String(month)];
   const averageStay = bridge.reduce((sum, row) => sum + row.weight * row.averageStay, 0) /
     bridge.reduce((sum, row) => sum + row.weight, 0);
   return {
     originKey: route.originKey,
     month,
     extraFlights: 3,
     seatsPerFlight: Math.round(route.seatsPerFlight || 220),
     loadFactor: Math.min(1, route.loadFactor || 0.82),
     p2pShare: route.p2pShare || 0.51,
     conversionRate: data.defaults.captureRate,
     averageStay,
   };
 }
  
 function setFormFromState() {
   $("#origin").value = state.originKey;
   $("#month").value = String(state.month);
   $("#extraFlights").value = state.extraFlights;
   $("#seatsPerFlight").value = state.seatsPerFlight;
   $("#loadFactor").value = (state.loadFactor * 100).toFixed(1);
   $("#p2pShare").value = (state.p2pShare * 100).toFixed(1);
   $("#conversionRate").value = (state.conversionRate * 100).toFixed(1);
   $("#averageStay").value = Number(state.averageStay).toFixed(2);
   updateRangeLabels();
 }
  
 function updateRangeLabels() {
   $("#extraFlightsValue").textContent = `${Number($("#extraFlights").value) >= 0 ? "+" : ""}${$("#extraFlights").value}`;
   $("#loadFactorValue").textContent = `${Number($("#loadFactor").value).toFixed(1)}%`;
   $("#p2pShareValue").textContent = `${Number($("#p2pShare").value).toFixed(1)}%`;
   $("#conversionRateValue").textContent = `${Number($("#conversionRate").value).toFixed(1)}%`;
 }
  
 function readForm() {
   state = {
     ...state,
     originKey: $("#origin").value.trim().toUpperCase(),
     month: Number($("#month").value),
     extraFlights: Number($("#extraFlights").value),
     seatsPerFlight: Number($("#seatsPerFlight").value),
     loadFactor: Number($("#loadFactor").value) / 100,
     p2pShare: Number($("#p2pShare").value) / 100,
     conversionRate: Number($("#conversionRate").value) / 100,
     averageStay: Number($("#averageStay").value),
     bridgeOverride,
   };
   updateRangeLabels();
 }
  
 function kpiCard(label, value, note, tone = "neutral") {
   return `<article class="kpi ${tone}"><p>${label}</p><strong>${value}</strong><small>${note}</small></article>`;
 }
  
 function renderKpis(result) {
   const direction = result.delta.guestNights >= 0 ? "positive" : "negative";
   $("#kpis").innerHTML = [
     kpiCard("Change in hotel check-ins", formatSigned(result.delta.hotelCheckins), "People checking into hotels", direction),
     kpiCard("Change in guest nights", formatSigned(result.delta.guestNights), "Hotel demand created or lost", direction),
     kpiCard("Central estimate (P50)", formatNumber(result.p50), "The formula result — not a 50/50 chance"),
     kpiCard("History-based range", `${formatNumber(result.p10)} to ${formatNumber(result.p90)}`, "P10-style cautious to P90-style high"),
   ].join("");
 }

 function renderRouteMap(result) {
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
   };
   const destinationBounds = [51.5, 22.6, 56.5, 26.3];
   const key = result.route.originKey.replace(/[^A-Z]/g, "");
   const project = ([longitude, latitude]) => projectMapPoint(longitude, latitude);
   const originCoordinates = coordinates[key] || coordinates.INDIA;
   const destinationLocation = {
     name: "Abu Dhabi",
     coordinates: [54.37, 24.45],
   };
   const [originX, originY] = project(originCoordinates);
   const destination = projectMapPointInFrame(
     destinationLocation.coordinates[0],
     destinationLocation.coordinates[1],
     75,
     -60,
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
       ...featureBounds(countryBounds[key] || countryBounds.INDIA),
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
           <stop offset="0" stop-color="#ff9d62"/>
           <stop offset="1" stop-color="#20d5bd"/>
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
       <span class="overlay-kicker">AIR CORRIDOR</span>
       <strong>${result.route.origin} <i>→</i> Abu Dhabi</strong>
       <small>Live scenario projection</small>
     </div>
     <div class="route-map-footer">
       <div><span class="map-legend-dot origin"></span><strong>${result.route.origin}</strong><small>Departure market</small></div>
       <div class="map-route-stat"><strong>${formatNumber(result.scenario.p2p)}</strong><small>Projected P2P arrivals</small></div>
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
   return [
     (longitude + 180) / 360 * 1000,
     (90 - latitude) / 180 * 500,
   ];
 }

 function projectMapPointInFrame(longitude, latitude, north, south) {
   return [
     (longitude + 180) / 360 * 1000,
     (north - latitude) / (north - south) * 500,
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
  
 function renderChain(result) {
   const stages = [
     ["Scheduled seats", result.scenario.seats, "Aircraft capacity"],
     ["Passengers", result.scenario.passengers, `${formatPercent(state.loadFactor)} seats filled`],
     ["P2P arrivals", result.scenario.p2p, `${formatPercent(state.p2pShare)} end in Abu Dhabi`],
     ["Hotel check-ins", result.scenario.hotelCheckins, `${formatPercent(state.conversionRate)} combined conversion`],
     ["Guest nights", result.scenario.guestNights, `${state.averageStay.toFixed(1)} nights per check-in`],
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
     ["Scheduled seats", result.baseline.seats, result.scenario.seats],
     ["Passengers", result.baseline.passengers, result.scenario.passengers],
     ["P2P arrivals", result.baseline.p2p, result.scenario.p2p],
     ["Hotel check-ins", result.baseline.hotelCheckins, result.scenario.hotelCheckins],
     ["Guest nights", result.baseline.guestNights, result.scenario.guestNights],
   ];
   $("#comparisonChart").innerHTML = rows.map(([label, baseline, scenario]) => {
     const max = Math.max(baseline, scenario, 1);
     return `<div class="comparison-row">
       <div class="comparison-label"><strong>${label}</strong><span>${formatSigned(scenario - baseline)}</span></div>
       <div class="comparison-line"><small>Baseline ${formatNumber(baseline)}</small><div><i class="baseline-bar" style="width:${baseline / max * 100}%"></i></div></div>
       <div class="comparison-line"><small>Scenario ${formatNumber(scenario)}</small><div><i class="scenario-bar" style="width:${scenario / max * 100}%"></i></div></div>
     </div>`;
   }).join("");
 }
  
 function renderSeasonProfile(result) {
   const routes = data.routes
     .filter((route) => route.originKey === result.route.originKey)
     .sort((a, b) => a.month - b.month);
   const max = Math.max(...routes.map((route) => route.baselineSeats), 1);
   $("#seasonProfile").innerHTML = routes.map((route) => `
     <div class="season-column ${route.month === state.month ? "active" : ""}">
       <span>${formatNumber(route.baselineSeats)}</span>
       <div><i style="height:${Math.max(4, route.baselineSeats / max * 100)}%"></i></div>
       <small>${data.months[route.month - 1].slice(0, 3)}</small>
     </div>`).join("");
 }
  
 function renderRouteAudit(result) {
   const capture = data.defaults.captureRate;
   $("#routeAudit").innerHTML = `<table>
     <thead><tr><th>Starting value</th><th>Selected route and month</th><th>Where it comes from</th></tr></thead>
     <tbody>
       <tr><td>Baseline seats</td><td>${formatNumber(result.route.baselineSeats)}</td><td>Mean Total Seats for ${result.route.origin} in ${data.months[state.month - 1]} across the supplied flight history.</td></tr>
       <tr><td>Weekly flights</td><td>${Number(result.route.weeklyFrequency).toFixed(1)}</td><td>Mean supplied Average Weekly Frequency. Where unavailable, seats and seats per flight provide a fallback.</td></tr>
       <tr><td>Seats per flight</td><td>${formatNumber(result.route.seatsPerFlight)}</td><td>Median Total Seats divided by weekly frequency and weeks in the month.</td></tr>
       <tr><td>Load factor</td><td>${formatPercent(result.route.loadFactor, 1)}</td><td>Total PAX divided by Total Seats for this route and month.</td></tr>
       <tr><td>P2P share</td><td>${formatPercent(result.route.p2pShare, 1)}</td><td>Total P2P divided by Total PAX. P2P means the airport journey ends in Abu Dhabi.</td></tr>
       <tr><td>Hotel conversion</td><td>${formatPercent(capture, 1)}</td><td>International hotel New Arrivals divided by total P2P passengers across common historical months.</td></tr>
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
  
 function renderBridge(result) {
   const rows = result.bridge.slice(0, 10);
   $("#bridgeTitle").textContent = `${result.route.origin} departures to hotel nationalities`;
   $("#bridgeExplanation").textContent = result.route.knownMarket
     ? "The percentages are estimated from historical movement and seasonality. Direct nationality matches receive extra weight, but they never receive an automatic 100%."
     : "This origin has no flight history. The app uses the overall seasonal nationality mix and marks confidence as low.";
   $("#bridgeTableBody").innerHTML = rows.map((row, index) => `
     <tr>
       <td>${row.nationality}</td>
       <td>${row.relationship}</td>
       <td><input class="bridge-input" data-index="${index}" type="number" min="0" max="100" step="0.1" value="${(row.weight * 100).toFixed(1)}"></td>
       <td>${row.averageStay.toFixed(1)} nights</td>
     </tr>`).join("");
   $("#confidenceLabel").textContent = result.confidence.label;
   $("#confidenceLabelCopy").textContent = result.confidence.label;
   $("#confidenceReason").textContent = result.confidence.reason;
   $("#confidenceBadge").className = `confidence ${result.confidence.label.toLowerCase()}`;
   $("#confidenceBadgeCopy").className = `confidence ${result.confidence.label.toLowerCase()}`;
 }
  
 function renderValidation() {
   const metrics = data.metrics;
   $("#validationKpis").innerHTML = [
     kpiCard("Transparent-chain WMAPE", formatPercent(metrics.transparentChainWmape, 1), "Monthly check-ins; lower is better", "positive"),
     kpiCard("Hybrid benchmark WMAPE", formatPercent(metrics.flightToCheckinsWmape, 1), "Monthly check-ins; lower is better", "positive"),
     kpiCard("Daily hotel-stay WMAPE", formatPercent(metrics.stayModelWmape, 1), "Daily Guests by nationality", "neutral"),
   ].join("");
  
   const maxRaw = Math.max(...data.validation.flatMap((row) => [row.actual, row.predicted, row.transparent]));
   const max = Math.ceil(maxRaw / 50000) * 50000;
   const width = 760;
   const height = 300;
   const pad = { left: 78, right: 24, top: 18, bottom: 48 };
   const x = (index) => pad.left + index * ((width - pad.left - pad.right) / Math.max(1, data.validation.length - 1));
   const y = (value) => height - pad.bottom - value / max * (height - pad.top - pad.bottom);
   const path = (field) => data.validation.map((row, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(row[field]).toFixed(1)}`).join(" ");
   const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => ({ value: max * share, y: y(max * share) }));
   $("#validationChart").innerHTML = `
     <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Actual hotel check-ins compared with transparent-chain and hybrid predictions">
       ${ticks.map((tick) => `<line x1="${pad.left}" y1="${tick.y}" x2="${width - pad.right}" y2="${tick.y}" class="grid-line"/><text x="${pad.left - 10}" y="${tick.y + 4}" text-anchor="end">${Math.round(tick.value / 1000)}k</text>`).join("")}
       <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" class="axis"/>
       <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" class="axis"/>
       <path d="${path("actual")}" class="actual-line"/>
       <path d="${path("transparent")}" class="transparent-line"/>
       <path d="${path("predicted")}" class="predicted-line"/>
       ${data.validation.map((row, index) => `<text x="${x(index)}" y="${height - 22}" text-anchor="middle">${row.month}</text>`).join("")}
     </svg>`;
  
   $("#validationTable").innerHTML = `<table>
     <thead><tr><th>Exam month</th><th>Actual check-ins</th><th>Transparent prediction</th><th>Absolute error</th><th>Hybrid prediction</th><th>Absolute error</th></tr></thead>
     <tbody>${data.validation.map((row) => `<tr><td>${row.month}</td><td>${formatNumber(row.actual)}</td><td>${formatNumber(row.transparent)}</td><td>${formatNumber(Math.abs(row.actual - row.transparent))}</td><td>${formatNumber(row.predicted)}</td><td>${formatNumber(Math.abs(row.actual - row.predicted))}</td></tr>`).join("")}</tbody>
   </table>
   <p>Transparent WMAPE = ${formatNumber(metrics.transparentAbsoluteErrorSum)} total absolute error ÷ ${formatNumber(metrics.validationActualSum)} total actual check-ins = ${formatPercent(metrics.transparentChainWmape, 1)}. Hybrid WMAPE uses the same denominator.</p>`;
 }
  
 function renderRecommendation(result) {
   const change = result.delta.guestNights;
   const top = result.contributions[0];
   let action;
   if (change > 10000) action = "The scenario creates a large demand increase. Review hotel capacity and align marketing with the highest-impact nationalities.";
   else if (change > 0) action = "The scenario adds hotel demand. Compare the expected guest-night gain with the cost of supporting the route.";
   else if (change < -10000) action = "The scenario removes substantial demand. Review seasonal campaigns and alternative airline capacity for the affected markets.";
   else action = "The citywide impact is limited. Keep the scenario for comparison, but prioritize routes with a larger verified effect.";
   $("#recommendationText").textContent = `${action} The largest modeled nationality effect is ${top?.nationality || "not available"} at ${formatSigned(top?.deltaGuestNights || 0)} guest nights.`;
 }
  
 function renderAll() {
   readForm();
   const result = runScenario(data, state);
   renderKpis(result);
   renderRouteMap(result);
   renderComparison(result);
   renderSeasonProfile(result);
   renderRouteAudit(result);
   renderChain(result);
   renderContributions(result);
   renderSensitivity();
   renderBridge(result);
   renderRecommendation(result);
   $("#scenarioName").textContent = `${result.route.origin}, ${data.months[state.month - 1]}`;
   $("#dataNote").textContent = result.route.knownMarket
     ? `Historical market. ${result.route.yearsObserved} periods inform this month's starting values.`
     : "New market. The app uses comparable-market starting values and low confidence.";
 }
  
 function setupControls() {
   $("#origin").innerHTML = knownOrigins().map((origin) => `<option value="${origin.key}">${origin.name}</option>`).join("");
   $("#month").innerHTML = data.months.map((month, index) => `<option value="${index + 1}">${month}</option>`).join("");
   setFormFromState();
  
   $$("#scenarioForm input, #scenarioForm select").forEach((input) => input.addEventListener("input", () => {
     if (input.id === "origin" || input.id === "month") {
       readForm();
       const refreshed = defaultState(state.originKey, state.month);
       state = { ...refreshed, extraFlights: state.extraFlights };
       bridgeOverride = null;
       setFormFromState();
     }
     renderAll();
   }));
  
   $("#resetScenario").addEventListener("click", () => {
     state = defaultState("INDIA", 12);
     bridgeOverride = null;
     setFormFromState();
     renderAll();
   });
  
   $("#applyPrompt").addEventListener("click", () => {
     const parsed = parseScenarioPrompt(data, $("#smartPrompt").value, state);
     state = parsed.inputs;
     bridgeOverride = null;
     setFormFromState();
     $("#assistantReply").textContent = parsed.summary;
     $("#assistantReply").classList.toggle("warning", !parsed.understood);
     renderAll();
   });
  
   $("#applyBridge").addEventListener("click", () => {
     const baseResult = runScenario(data, { ...state, bridgeOverride: null });
     const topRows = baseResult.bridge.slice(0, 10).map((row, index) => ({
       ...row,
       weight: Number($(`.bridge-input[data-index="${index}"]`).value) / 100,
     }));
     const remaining = baseResult.bridge.slice(10);
     bridgeOverride = [...topRows, ...remaining];
     $("#bridgeStatus").textContent = "Planner override applied. The percentages were normalized to 100%.";
     renderAll();
   });
 }
  
 function setupTabs() {
   $$(".nav-tab").forEach((button) => button.addEventListener("click", () => {
     $$(".nav-tab").forEach((item) => item.classList.remove("active"));
     $$(".view").forEach((view) => view.classList.remove("active"));
     button.classList.add("active");
     $(`#${button.dataset.view}`).classList.add("active");
   }));
  
   const requested = new URLSearchParams(window.location.search).get("view");
   const requestedButton = $(`.nav-tab[data-view="${requested}"]`);
   if (requestedButton) requestedButton.click();
 }
  
 function renderGlossary() {
   $("#glossaryGrid").innerHTML = Object.entries(data.glossary).map(([term, meaning]) => `
     <article class="definition"><h3>${term}</h3><p>${meaning}</p></article>`).join("");
 }
  
 async function init() {
   try {
     await loadData();
     state = defaultState();
     setupTabs();
     setupControls();
     renderValidation();
     renderGlossary();
     renderAll();
   } catch (error) {
     document.body.innerHTML = `<main class="fatal"><h1>Air2Stay could not start</h1><p>${error.message}</p><p>Run the supplied run_prototype.ps1 file, then open http://localhost:8765.</p></main>`;
   }
 }
  
 init();
