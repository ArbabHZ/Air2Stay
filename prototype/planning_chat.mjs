import { assistantReply, parseScenarioPrompt, sensitivity } from './engine.mjs';

// Local answers use the same result object as the screen. This module never
// changes the plan; the controller validates and applies an explicit command.
const pcNumber = (value, digits = 0) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
const pcPercent = (value) => pcNumber(Number(value) * 100, 6) + '%';
const pcSigned = (value) => (Number(value) >= 0 ? '+' : '−') + pcNumber(Math.abs(Number(value)));
const pcAnswer = (text) => ({ type: 'answer', text });
const pcRouteAliases = { USA: 'UNITED STATES OF AMERICA', US: 'UNITED STATES OF AMERICA', 'UNITED STATES': 'UNITED STATES OF AMERICA', AMERICA: 'UNITED STATES OF AMERICA', UK: 'UNITED KINGDOM', BRITAIN: 'UNITED KINGDOM', RUSSIA: 'RUSSIAN FEDERATION', KOREA: 'SOUTH KOREA' };
const pcEscapePattern = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pcQuestion(text) {
  return /^(?:please\s+)?(?:why|how|what|which|who|where|when|is|are|does|do|will|would|should|could|can)\b/i.test(text) || /\?$/.test(text);
}

function pcExplicitCommand(text) {
  return /^(?:(?:please|now|and|then)\s+)*(?:(?:can|could|would)\s+you\s+)?(?:please\s+)?(?:set|change|update|switch|use|try|add|remove|cancel|reduce|increase|decrease|make|assume|move|reset|start over)\b/i.test(text);
}

function pcCanonicalCommand(prompt) {
  let text = String(prompt).trim()
    .replace(/(^|[^\w.])(-?)\.(\d+)/g, (_match, before, sign, digits) => `${before}${sign}0.${digits}`)
    .replace(/\bminus\s+(\d+(?:\.\d+)?)/gi, '-$1');
  // Clear everyday names retain the unit before entering the existing parser.
  text = text.replace(/(?:flight\s+(?:fullness|occupancy)|how\s+full\s+(?:the\s+)?flights\s+are|flight\s+load)/gi, 'load factor');
  text = text.replace(/(?:hotel\s+(?:use|usage|share)|share\s+(?:checking\s+into|staying\s+in)\s+(?:a\s+)?hotels?)/gi, 'hotel conversion');
  text = text.replace(/(?:passengers?\s+ending\s+(?:their\s+)?trip(?:\s+in\s+Abu\s+Dhabi)?|(?:trip[- ]ending|local\s+visitor)\s+share)/gi, 'p2p');
  text = text.replace(/(?:extra\s+hotel\s+demand|event\s+boost|seasonal\s+boost)/gi, 'event uplift');
  text = text.replace(/(?:seats\s+(?:on\s+each|per)\s+flight|seat\s+count)\s*(?:to|at|of|is|=|:)?\s*(-?\d+(?:\.\d+)?)/gi, '$1 seats');
  text = text.replace(/(?:extra\s+flights(?:\s+(?:each|per)\s+week)?|weekly\s+flights)\s*(?:to|at|of|is|=|:)?\s*(-?\d+(?:\.\d+)?)/gi, '$1 flights');
  text = text.replace(/(?:average\s+(?:nights(?:\s+per\s+(?:hotel\s+)?stay)?|stay(?:\s+length)?)|stay\s+length)\s*(?:to|at|of|is|=|:)?\s*(-?\d+(?:\.\d+)?)(?:\s*nights?)?/gi, 'stay $1 nights');
  text = text.replace(/(-?\d+(?:\.\d+)?)\s*(?:%|percent)\s*(?:of\s+)?(?:passengers?|visitors?)\s+(?:use|stay(?:ing)?\s+in|choose)\s+hotels?/gi, 'hotel conversion $1%');
  text = text.replace(/(?:flights?(?:\s+(?:are|to\s+be))?\s*)(-?\d+(?:\.\d+)?)\s*(?:%|percent)\s*full/gi, 'load factor $1%');
  text = text.replace(/(-?\d+(?:\.\d+)?)\s*(?:%|percent)\s*full(?:ness)?/gi, 'load factor $1%');
  return text;
}

function pcCommandReply(data, prompt, current) {
  const lower = prompt.toLowerCase();
  if (/\b(?:or|between)\b/.test(lower) || /\b(?:by|another|more|less|fewer)\s*-?\d/.test(lower) || /\d\s*(?:more|fewer|less)\s+flights?/.test(lower)) {
    return pcAnswer('Please give the final value you want, so I don’t guess. For example: “Set extra flights to 5” or “Set flight occupancy to 80%.” The plan has not changed.');
  }
  if (/\b(?:not|don't|do not|without|except|leave|keep)\b/.test(lower)) return pcAnswer('Please list only the values you want to change, using a final number for each. I will leave the other values alone. Nothing has changed.');
  if (/\bhotel\s+occupancy\b/.test(lower)) return pcAnswer('Hotel occupancy means how full hotels are. This planner does not have that control. You can change flight occupancy or the share of visitors using hotels; please name which one. The plan has not changed.');
  if (/\b(?:route purpose|visitor (?:mix|type)|holiday|business|family visits|mixed visitors)\b/.test(lower)) return pcAnswer('Use the route-purpose or Visitor mix controls for that change. I can change the flight and hotel assumptions once you give their values. Nothing has changed.');
  const canonical = pcCanonicalCommand(prompt);
  const parsed = parseScenarioPrompt(data, canonical, current);
  // Scope removal language to the flight clause. A request to reduce hotel
  // use must not turn a separate request to add flights into a flight removal.
  const flightMatch = canonical.match(/(-?\d+(?:\.\d+)?)\s*(?:extra|additional|more|fewer|less)?\s*(?:weekly\s*)?flights?/i);
  if (flightMatch) {
    const beforeFlight = canonical.slice(0, flightMatch.index).split(/\b(?:and|then)\b|[;,]/i).at(-1);
    const explicitTarget = /(?:extra\s+flights|flights(?:\s+(?:each|per)\s+week)?)\s+to\s+-?\d/i.test(prompt);
    const remove = !explicitTarget && /\b(?:remove|cancel|reduce)\b/i.test(beforeFlight);
    parsed.changes.extraFlights = remove ? -Math.abs(Number(flightMatch[1])) : Number(flightMatch[1]);
    parsed.inputs.extraFlights = parsed.changes.extraFlights;
  }
  // The older parser does not accept signed stays, seats or trip-ending share.
  // Preserve negative values for the controller to reject instead of accepting
  // their positive magnitude or silently applying only the route part.
  const signedFields = [
    ['seatsPerFlight', /(-\d+(?:\.\d+)?)\s*seats?/i, 1],
    ['averageStay', /(?:stay|length of stay)[^\d-]{0,12}(-\d+(?:\.\d+)?)\s*(?:days?|nights?)/i, 1],
    ['p2pShare', /p2p[^\d-]{0,12}(-?\d+(?:\.\d+)?)\s*(?:%|percent)/i, 0.01],
  ];
  for (const [key, pattern, scale] of signedFields) {
    const match = canonical.match(pattern);
    if (match) { parsed.changes[key] = Number(match[1]) * scale; parsed.inputs[key] = parsed.changes[key]; parsed.understood = true; }
  }
  const fields = [
    ['extraFlights', /\bflights?\b/], ['seatsPerFlight', /\bseats?\b/],
    ['loadFactor', /\b(?:load factor|occupancy|filled)\b/],
    ['conversionRate', /\b(?:hotel conversion|hotel capture)\b/],
    ['p2pShare', /\bp2p\b/], ['averageStay', /\b(?:stay|nights?)\b/],
    ['eventUplift', /\b(?:event|seasonal|demand)\s+(?:uplift|increase)\b/],
  ];
  // 'Flight occupancy' is a single field, not a request for a flight count.
  const fieldText = canonical.replace(/flight\s+occupancy/g, 'occupancy');
  const missing = fields.filter(([key, pattern]) => pattern.test(fieldText) && parsed.changes[key] === undefined);
  const numbers = canonical.replace(/p2p/gi, 'trip share').match(/-?\d+(?:\.\d+)?/g) || [];
  const numericChanges = Object.keys(parsed.changes).filter((key) => !['originKey', 'month'].includes(key));
  if (missing.length || numbers.length !== numericChanges.length) {
    return pcAnswer('I couldn’t match every requested change to a clear value. Use digits and units, for example: “Set hotel use to 40% and average stay to 4 nights.” Nothing has changed.');
  }
  const monthMatches = data.months.filter((name) => new RegExp('\\b' + pcEscapePattern(name) + '\\b', 'i').test(prompt));
  const routeCandidates = [...new Map(data.routes.map(route => [route.origin, route.originKey])).entries(), ...Object.entries(pcRouteAliases)];
  const namedRoutes = [...new Set(routeCandidates.filter(([name]) => new RegExp('\\b' + pcEscapePattern(name) + '\\b', 'i').test(prompt)).map(([, key]) => key))];
  if (monthMatches.length > 1 || namedRoutes.length > 1) return pcAnswer('Choose one departure country and one month for this change. Use Compare to examine alternatives. The plan has not changed.');
  const fromText = canonical.match(/\b(?:from|(?:switch|move|change)\s+to|(?:country|route|destination)\s+to|to(?=\s+[a-z]))\s+(.+?)(?=\s+in\s+|\s+with\s+|\s+and\s+|[,.;!?]|$)/i)?.[1]?.trim();
  if (fromText && !data.months.some((name) => name.toLowerCase() === fromText.toLowerCase()) && !parsed.changes.originKey && fromText.toUpperCase() !== current.originKey && !/^(?:this|the current)(?: route| country)?$/i.test(fromText)) {
    return pcAnswer('I couldn’t match that departure country to a route in the supplied records. Choose “+ New route” in the country control and confirm the country first; I can then help change its assumptions. Nothing has changed.');
  }
  if (!parsed.understood) return pcAnswer('Please name the value to change. I can set the route, month, extra flights, seats, flight occupancy, trip-ending share, hotel use, average stay, or event uplift. Use the country picker to create a new route.');
  // Do not let an unknown route request silently turn into a numeric-only edit.
  if (/\b(?:switch|move|change)\s+(?:the\s+)?(?:country|route|destination)?\s*to\s+/i.test(prompt) && !parsed.changes.originKey && !parsed.changes.month && numericChanges.length === 0) {
    return pcAnswer('Choose that country in the departure control, using “+ New route” if needed. The plan has not changed.');
  }
  return { type: 'apply', parsed, text: parsed.summary };
}

function pcNextAction(data, current, result, proposalSummary) {
  const next = proposalSummary?.nextAction || proposalSummary?.recommendedAction || proposalSummary?.recommended;
  if (next && typeof next === 'object') {
    const title = next.title || next.label || next.action;
    const reason = next.reason || next.why;
    const owner = next.owner || next.ownerRole || next.suggestedOwner;
    if (title) return pcAnswer(`Check this first: ${title}.\n\n${reason ? '- Why: ' + reason + '\n' : ''}${owner ? '- Who can help: ' + owner + '.\n' : ''}- Keep the response with this proposal so the next person can see what was checked.`);
  }
  if (proposalSummary?.checks?.length && proposalSummary.checks.every(check => check.status === 'green')) return pcAnswer('All listed checks have user-recorded evidence for these assumptions.\n\n- Review the sources with the proposal owner before deciding.\n- Green means a check was recorded; it is not route approval or a guarantee of the estimate.\n- If the assumptions change, check whether the earlier evidence still applies.');
  const top = sensitivity(data, current)[0];
  const owner = /flight|seat|passengers/i.test(top?.label || '') ? 'an airline planner' : 'the hotel or tourism team';
  const missing = !result.route.knownMarket ? 'This new route has no matching flight history. Ask an airline planner about expected bookings and the proposed schedule first.' : `Check ${String(top?.label || 'the hotel assumptions').toLowerCase()} with ${owner}.`;
  return pcAnswer(`${missing}\n\n- Why: ${!result.route.knownMarket ? 'Comparison countries only provide starting assumptions; they do not prove demand for this route.' : 'It has the largest guest-night spread in the one-at-a-time trials shown in Details. The trial sizes differ.'}\n- Ask hotels about available capacity for ${data.months[current.month - 1]} and typical stay length. Guest nights count people’s nights, not rooms.\n- Record the source, owner and response in Proposal before making a decision.`);
}

export function planningChatReply(data, prompt, current, result, proposalSummary = null) {
  const text = String(prompt || '').trim();
  const lower = text.toLowerCase();
  if (!text) return pcAnswer('Ask about the current plan, or name a value you want to change.');
  if (/^(?:please\s+)?(?:reset(?:\s+(?:(?:the|my|this)\s+)?(?:plan|scenario))?|start over)[.!]?$/i.test(text)) return assistantReply(data, 'reset', current, result);
  if (/\b(?:what if|would happen if)\b/.test(lower)) return pcAnswer('I can try that as a scenario. To apply it, give a direct instruction such as “Set flight occupancy to 80%.” Your current plan has not changed.');
  const explicit = pcExplicitCommand(text);
  const directValue = /^(?:now\s+|and\s+)?(?:-?\d|load factor|flight occupancy|hotel (?:use|conversion)|average stay|stay\s+-?\d|event uplift|p2p)/i.test(text);
  const onlyMonth = data.months.some((name) => new RegExp('^(?:(?:and|now|in)\\s+)*' + pcEscapePattern(name) + '[.!]?$', 'i').test(text));
  const onlyRoute = data.routes.some((route) => new RegExp('^(?:(?:and|now)\\s+)*' + pcEscapePattern(route.origin) + '[.!]?$', 'i').test(text));
  if (explicit || (!pcQuestion(text) && (directValue || onlyMonth || onlyRoute))) return pcCommandReply(data, text, current);
  if (/\b(?:rag|red|amber|green)\b/.test(lower)) {
    const colour = lower.match(/\b(red|amber|green)\b/)?.[1];
    const matching = proposalSummary?.checks?.filter(check => !colour || check.status === colour) || [];
    const explanation = 'The colours track recorded checks, not forecast accuracy or permission to launch.\n\n- Red: an unresolved check is overdue.\n- Amber: information is missing, a response is pending, or earlier evidence needs rechecking.\n- Green: a user recorded evidence for the current assumptions.';
    return pcAnswer(explanation + (matching.length ? '\n\nCurrent example: ' + matching[0].title + ' — ' + matching[0].reason : ''));
  }
  if (/\b(?:next steps?|next action|check next|check first|what should .*(?:check|do)|what .*investigate|who (?:can|should)|priorit(?:y|ies)|pending|overdue|red|amber|green)\b/.test(lower)) return pcNextAction(data, current, result, proposalSummary);
  if (/\b(?:what (?:can|should) i ask|what can you|help me|how (?:do|can) i use|capabilit|what do you do)\b/.test(lower)) return pcAnswer('I can explain this proposal and help change its assumptions.\n\n- Ask “How were hotel nights calculated?” or “What should I check first?”\n- Try “Set flight occupancy to 80%” or “Add 5 flights from France in December.”\n- Use Proposal for checks, comments and stakeholder drafts. Open-ended AI answers use your current plan and recent chat; the app’s calculation engine supplies the numbers.');
  if (/\b(?:assumptions?|inputs?|starting values)\b/.test(lower) && !/\b(?:why|comparison|peer|country)\b/.test(lower)) return pcAnswer(`The current proposal is ${result.route.origin} in ${data.months[current.month - 1]}.\n\n- Flights: ${pcNumber(current.extraFlights, 6)} extra each week, ${pcNumber(current.seatsPerFlight, 6)} seats per flight, ${pcPercent(current.loadFactor)} full.\n- Visitors: ${pcPercent(current.p2pShare)} end their trip here; ${pcPercent(current.conversionRate)} of those use hotels.\n- Stay: ${pcNumber(current.averageStay, 6)} nights on average; event uplift ${pcPercent(current.eventUplift || 0)}. These are planning assumptions. See Details for the calculation and source records.`);
  if (/\b(?:hotel|guest)\s+nights?\b|\bnights?\s+per\s+(?:hotel\s+)?stay\b/.test(lower)) {
    return pcAnswer(`Hotel nights are estimated hotel arrivals multiplied by average nights per stay.\n\n- This plan: about ${pcNumber(result.scenario.hotelCheckins)} hotel arrivals × ${pcNumber(current.averageStay, 6)} nights = ${pcNumber(result.scenario.guestNights)} guest nights. Displayed values are rounded.\n- That is ${pcSigned(result.delta.guestNights)} guest nights compared with the baseline estimate based on past flight records.${!result.route.knownMarket ? ' The new route starts from zero.' : ''}\n- Guest nights count nights spent by people, not hotel rooms.${result.eventUplift ? ' The arrivals and nights already include your ' + pcPercent(result.eventUplift) + ' event assumption.' : ''}`);
  }
  if (/\b(?:baseline|past results|historical results)\b/.test(lower)) return pcAnswer(result.route.knownMarket
    ? `The baseline is an estimate from past flight records for ${result.route.origin} in ${data.months[current.month - 1]}, combined with hotel-use and stay-length assumptions.\n\n- It is not an observed count of hotel stays from this route.\n- Editing your proposal or visitor mix does not rewrite that baseline.\n- The current plan is compared with it to show the change.`
    : 'This new route has no matching flight records in the supplied data, so its baseline starts at zero. Comparison countries supply starting assumptions only; they do not prove demand or confirmed hotel bookings.');
  if (/\b(?:comparison countr|peer|borrow|starting country)\b/.test(lower)) return pcAnswer(current.peerProfile
    ? `This new route starts with a weighted blend of ${current.peerProfile.peers.map((peer) => peer.origin + ' (' + pcPercent(peer.weight) + ')').join(', ')}.\n\n- These countries supply starting assumptions, not measured demand for your new route.\n- Review their reasons and limits in Details, then replace assumptions with route-specific airline and hotel evidence when available.`
    : result.route.knownMarket ? 'This route has matching past flight records, so it uses its own flight starting values. Hotel use and stay length are still estimates; the baseline is not a directly observed route-level hotel total.' : 'The selected comparison country is only a starting point. It is not proof of demand on this route. Review the starting assumptions in Details and check them with an airline planner and hotel team.');
  if (/\b(?:accuracy|accurate|error score|6\.9|reliable|trust)\b/.test(lower)) return pcAnswer('The accuracy test checks monthly hotel-arrival totals across the included markets—not this individual route or a new route.\n\n- Open Check past results to see the held-out months, scores and test limits.\n- Matching flight records show available history, not forecast certainty.\n- Check the proposal’s occupancy, hotel use and stay assumptions before relying on the result.');
  // Questions mentioning a country, month, number, or 'reset' must never fall
  // through to the legacy parser as a command. Only local answer types survive.
  const fallback = assistantReply(data, text, current, result);
  if (fallback.type === 'answer') return fallback;
  return { type: 'apply', parsed: { inputs: { ...current }, changes: {}, understood: false, summary: '' }, text: 'Ask about this plan or give a specific instruction to change it.' };
}
