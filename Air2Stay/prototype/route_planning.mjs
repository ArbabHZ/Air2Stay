// Comparison markets provide adjustable starting assumptions, not a prediction
// of demand on a country with no route history. This module uses supplied
// country centroids and flight aggregates only; it has no external lookups.

function peerCountryKey(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function peerLocationIndex(source) {
  const records = Array.isArray(source) ? source
    : source?.countries || Object.values(source || {});
  const unique = [...new Map(records.filter((row) => row && typeof row.name === "string")
    .map((row) => [row.name, row])).values()];
  const index = {};
  // Canonical names win over territory aliases (for example Finland / Åland).
  for (const row of unique) index[peerCountryKey(row.name)] = row;
  for (const row of unique) {
    for (const alias of row.aliases || []) {
      const key = peerCountryKey(alias);
      if (key && !index[key]) index[key] = row;
    }
  }
  return index;
}

function peerCoordinates(location) {
  return Array.isArray(location?.coordinates) && location.coordinates.length === 2
    && location.coordinates.every(Number.isFinite)
    && Math.abs(location.coordinates[0]) <= 180
    && Math.abs(location.coordinates[1]) <= 90;
}

function peerGreatCircle(first, second) {
  const rad = Math.PI / 180;
  const latitude = (second[1] - first[1]) * rad;
  const longitude = (second[0] - first[0]) * rad;
  const half = Math.sin(latitude / 2) ** 2
    + Math.cos(first[1] * rad) * Math.cos(second[1] * rad) * Math.sin(longitude / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, half))));
}

function peerNormalizedBridge(rows) {
  const positive = (rows || []).filter((row) => row && typeof row.nationality === "string")
    .map((row) => ({ ...row, weight: Math.max(0, Number(row.weight) || 0) }));
  const total = positive.reduce((sum, row) => sum + row.weight, 0);
  return total > 0 ? positive.map((row) => ({ ...row, weight: row.weight / total })) : [];
}

function peerBlendBridge(data, peers, month) {
  const combined = new Map();
  for (const peer of peers) {
    const source = data.bridge?.[peer.originKey]?.[String(month)]
      || data.fallbackBridge?.[String(month)] || [];
    for (const row of peerNormalizedBridge(source)) {
      const share = peer.weight * row.weight;
      const stay = Number(row.averageStay) > 0 ? Number(row.averageStay) : Number(data.defaults?.averageStay || 3.6);
      const key = row.nationalityKey || peerCountryKey(row.nationality);
      const item = combined.get(key) || { nationality: row.nationality,
        nationalityKey: row.nationalityKey || row.nationality.toUpperCase(), weight: 0, stayWeight: 0 };
      item.weight += share;
      item.stayWeight += share * stay;
      combined.set(key, item);
    }
  }
  return peerNormalizedBridge([...combined.values()].map((row) => ({
    nationality: row.nationality, nationalityKey: row.nationalityKey,
    weight: row.weight, averageStay: row.weight ? row.stayWeight / row.weight : Number(data.defaults?.averageStay || 3.6),
    relationship: "blended comparison assumptions",
  }))).sort((first, second) => second.weight - first.weight || first.nationality.localeCompare(second.nationality));
}

/**
 * A reproducible, geographic heuristic for unsupported departure markets.
 * - Match the selected month, excluding the target market entirely.
 * - Rank supplied markets by centroid distance plus half their route-length gap.
 * - Combine up to three with weights proportional to 1 / (500 + scoreKm).
 * The 500 km floor prevents a single neighbouring centroid dominating the mix.
 * The design constants were chosen as assumptions, not fitted to hotel outcomes.
 */
export function buildPeerProfile(data, locations, country, month) {
  const selectedMonth = Number(month);
  if (!Number.isInteger(selectedMonth) || selectedMonth < 1 || selectedMonth > 12) {
    throw new RangeError("Choose a month from 1 to 12.");
  }
  const index = peerLocationIndex(locations);
  const target = index[peerCountryKey(country)];
  const limitations = [
    "Geographic proximity and approximate route length do not establish similar demand, income, travel purpose or visa conditions.",
    "Locations are country centroids, not airport coordinates; route lengths are approximate.",
    "Visitor shares and stay lengths are estimated allocations, not observed hotel outcomes for the proposed route.",
    "The overall hotel-conversion rate is a shared assumption; it is not learned separately for each comparison country.",
  ];
  const unavailable = (reason) => ({ available: false, country: target?.name || String(country || ""),
    month: selectedMonth, peers: [], bridge: [], assumptions: null, primaryPeerOriginKey: "",
    method: "Three-market geographic starting profile", reason, limitations });
  if (!peerCoordinates(target)) return unavailable("No valid country location is available; choose a country from the reference list.");
  const abuDhabi = [54.3773, 24.4539];
  const targetLength = peerGreatCircle(target.coordinates, abuDhabi);
  const candidates = (data.routes || []).filter((route) => Number(route.month) === selectedMonth)
    .filter((route) => peerCountryKey(route.originKey) !== peerCountryKey(country)
      && peerCountryKey(route.origin) !== peerCountryKey(target.name))
    .map((route) => {
      const location = index[peerCountryKey(route.origin)] || index[peerCountryKey(route.originKey)];
      if (!peerCoordinates(location)) return null;
      if (![route.seatsPerFlight, route.loadFactor, route.p2pShare].every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) return null;
      const distanceKm = peerGreatCircle(target.coordinates, location.coordinates);
      const routeLengthGapKm = Math.abs(targetLength - peerGreatCircle(location.coordinates, abuDhabi));
      return { originKey: route.originKey, origin: route.origin, name: route.origin, distanceKm,
        routeLengthGapKm, yearsObserved: Number(route.yearsObserved) || 0,
        scoreKm: distanceKm + 0.5 * routeLengthGapKm, route };
    }).filter(Boolean);
  // A malformed export containing duplicate market-month rows should not give
  // that market several votes. Ordinary exported data has one row per pair.
  const unique = [...new Map(candidates.map((peer) => [peer.originKey, peer])).values()];
  unique.sort((first, second) => first.scoreKm - second.scoreKm || first.originKey.localeCompare(second.originKey));
  const selected = unique.slice(0, 3);
  if (!selected.length) return unavailable("No comparison markets with flight records and coordinates are available for this month.");
  const weightSum = selected.reduce((sum, peer) => sum + 1 / (500 + peer.scoreKm), 0);
  const peers = selected.map((peer) => ({ ...peer, weight: (1 / (500 + peer.scoreKm)) / weightSum }));
  const weighted = (field, cap = Infinity) => peers.reduce((sum, peer) => sum + peer.weight * Math.min(cap, Number(peer.route[field])), 0);
  const bridge = peerBlendBridge(data, peers, selectedMonth);
  const averageStay = bridge.length ? bridge.reduce((sum, row) => sum + row.weight * row.averageStay, 0)
    : Number(data.defaults?.averageStay || 3.6);
  const nearest = [...unique].sort((first, second) => first.distanceKm - second.distanceKm || first.originKey.localeCompare(second.originKey))[0];
  return {
    available: true, country: target.name, month: selectedMonth,
    primaryPeerOriginKey: peers[0].originKey,
    peers: peers.map(({ route, ...peer }) => peer),
    nearestPeerOriginKey: nearest.originKey,
    assumptions: { seatsPerFlight: Math.round(weighted("seatsPerFlight")), loadFactor: weighted("loadFactor", 1),
      p2pShare: weighted("p2pShare", 1), conversionRate: Number(data.defaults?.captureRate || 0), averageStay },
    bridge, approximateRouteKm: targetLength,
    method: "Up to three markets in the same month; weighted by country-centroid proximity and approximate route-length similarity.",
    weightingRule: "scoreKm = centroid distance + 0.5 × route-length gap; weight ∝ 1 / (500 + scoreKm)",
    limitations,
  };
}

/**
 * Hide one known market at a time and reconstruct available flight assumptions.
 * This is a spatial reconstruction check on already aggregated historical data,
 * not a future holdout or a test of new-route hotel arrivals / guest nights.
 */
export function validatePeerMethod(data, locations) {
  const rows = [];
  for (const target of data.routes || []) {
    const profile = buildPeerProfile(data, locations, target.origin, target.month);
    if (!profile.available) continue;
    const nearest = data.routes.find((route) => route.originKey === profile.nearestPeerOriginKey && route.month === target.month);
    if (!nearest) continue;
    const actual = { seatsPerFlight: Number(target.seatsPerFlight),
      loadFactor: Math.min(1, Number(target.loadFactor)), p2pShare: Math.min(1, Number(target.p2pShare)) };
    if (!Object.values(actual).every(Number.isFinite)) continue;
    rows.push({ originKey: target.originKey, origin: target.origin, month: target.month,
      peerKeys: profile.peers.map((peer) => peer.originKey), actual,
      blended: { seatsPerFlight: profile.assumptions.seatsPerFlight, loadFactor: profile.assumptions.loadFactor, p2pShare: profile.assumptions.p2pShare },
      nearest: { seatsPerFlight: Number(nearest.seatsPerFlight), loadFactor: Math.min(1, Number(nearest.loadFactor)), p2pShare: Math.min(1, Number(nearest.p2pShare)) } });
  }
  const definitions = {
    seatsPerFlight: { label: "Seats per flight", unit: "seats", scale: 1 },
    loadFactor: { label: "How full flights are", unit: "percentage points", scale: 100 },
    p2pShare: { label: "Passengers ending their trip here", unit: "percentage points", scale: 100 },
  };
  const metrics = {};
  for (const [field, definition] of Object.entries(definitions)) {
    const mae = (method) => rows.length ? rows.reduce((sum, row) => sum + Math.abs(row[method][field] - row.actual[field]), 0) / rows.length * definition.scale : null;
    const blendedMae = mae("blended"), nearestMae = mae("nearest");
    metrics[field] = { label: definition.label, unit: definition.unit, blendedMae, nearestMae,
      lowerErrorMethod: !rows.length ? "unavailable" : Math.abs(blendedMae - nearestMae) < 1e-10 ? "tie" : blendedMae < nearestMae ? "blended" : "nearest" };
  }
  return { caseCount: rows.length, marketCount: new Set(rows.map((row) => row.originKey)).size,
    metrics, rows,
    scope: "Leave-one-market-out reconstruction of supplied historical flight assumptions, matching month. The target market is excluded from all comparison peers.",
    limitations: [
      "This checks seats per flight, flight occupancy and the share ending their trip in Abu Dhabi only.",
      "It does not validate new-route demand, hotel conversion, visitor nationality shares, hotel arrivals or guest nights.",
      "The supplied export contains market-month aggregates. This is not an independent future-period back-test, and may share years with its comparison records.",
      "Three-market estimates can perform worse than the nearest single country. Each measured error is reported alongside that baseline.",
      "The heuristic and weights are fixed design choices. There is no economic, travel-purpose or airport-specific similarity model.",
    ] };
}
