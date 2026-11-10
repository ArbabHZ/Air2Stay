import { assistantReply, parseScenarioPrompt, sensitivity, runScenario, validateScenarioInputs } from './engine.mjs';
import { planningMetrics } from './decision_tools.mjs';

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

// Arabic questions are mapped to the English phrasing the local engine already
// understands. Returns the input unchanged when it contains no Arabic letters.
const AR_MONTHS = ['يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو', 'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر'];
const AR_COUNTRIES = [
  ['المملكه العربيه السعوديه', 'Saudi Arabia'], ['السعوديه', 'Saudi Arabia'], ['المملكه المتحده', 'United Kingdom'], ['بريطانيا', 'United Kingdom'],
  ['الولايات المتحده', 'United States Of America'], ['امريكا', 'United States Of America'], ['كوريا الجنوبيه', 'South Korea'], ['كوريا', 'South Korea'],
  ['الهند', 'India'], ['فرنسا', 'France'], ['المانيا', 'Germany'], ['الصين', 'China'], ['روسيا', 'Russian Federation'], ['اليابان', 'Japan'],
  ['مصر', 'Egypt'], ['الكويت', 'Kuwait'], ['قطر', 'Qatar'], ['عمان', 'Oman'], ['البحرين', 'Bahrain'], ['الاردن', 'Jordan'], ['لبنان', 'Lebanon'],
  ['تركيا', 'Turkey'], ['ايطاليا', 'Italy'], ['اسبانيا', 'Spain'], ['هولندا', 'Netherlands'], ['بلجيكا', 'Belgium'], ['سويسرا', 'Switzerland'],
  ['النمسا', 'Austria'], ['بولندا', 'Poland'], ['ايرلندا', 'Ireland'], ['كندا', 'Canada'], ['الفلبين', 'Philippines'], ['كازاخستان', 'Kazakhstan'],
  ['اوزبكستان', 'Uzbekistan'], ['اذربيجان', 'Azerbaijan'], ['ارمينيا', 'Armenia'], ['اسرائيل', 'Israel'],
];

function pcArabicNormalize(text) {
  return String(text)
    .replace(/[ً-ْـ]/g, '')
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
    .replace(/٬/g, ',').replace(/٫/g, '.').replace(/٪/g, '%').replace(/؟/g, '?').replace(/،/g, ',')
    .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/\s+/g, ' ').trim();
}

export function arabicPromptToEnglish(data, prompt) {
  const raw = String(prompt || '');
  if (!/[؀-ۿ]/.test(raw)) return raw;
  const text = pcArabicNormalize(raw);
  const monthIndex = AR_MONTHS.findIndex((name) => text.includes(name));
  const month = monthIndex >= 0 ? data.months[monthIndex] : '';
  const country = AR_COUNTRIES.find(([name]) => new RegExp('(^|\\s|ل|من|في|ب)' + name + '($|\\s|[?.,!])').test(text))?.[1]
    || data.routes.map((route) => route.origin).find((name) => new RegExp('\\b' + pcEscapePattern(name) + '\\b', 'i').test(text)) || '';
  const where = (country ? ` from ${country}` : '') + (month ? ` in ${month}` : '');
  const numberAfter = (pattern) => {
    const found = text.match(pattern);
    if (!found) return null;
    const after = text.slice(found.index + found[0].length).match(/-?\d+(?:\.\d+)?/);
    return after ? after[0] : null;
  };

  // Polite openers ("أريد", "من فضلك", "هل يمكنك") and verbal nouns
  // ("إضافة", "ضبط") are reduced to the command verb for the command rules.
  const body = text.replace(/^((اريد|نريد|اود|ابغي|ابي|من فضلك|لو سمحت|ممكن|هل يمكنك|هل تستطيع|رجاء|رجاءا)\s+(ان\s+)?)+/, '')
    .replace(/^ضبط\s/, 'اضبط ').replace(/^تغيير\s/, 'غير ').replace(/^تعيين\s/, 'عين ').replace(/^حذف\s/, 'احذف ').replace(/^اضافه\s(?=\d)/, 'اضف ');
  const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:%|بالمئه|بالمائه|في المئه|في المائه)/);

  if (/^(مرحبا|اهلا|هلا|هاي|السلام عليكم|صباح الخير|مساء الخير)/.test(text)) return 'Hello';
  if (/^(شكرا|مشكور|يعطيك العافيه|ممتاز|تمام|جميل)/.test(text)) return 'Thanks';
  if (/(اعد|اعاده|ارجع) (ضبط|تعيين)|ابدا من جديد/.test(text)) return 'Reset the plan';
  // "Where/how do I write an email…", then "where is …" for controls and pages.
  if (PC_AR_DRAFT_INTENT.test(text) && /(بريد|رساله|رسائل|ايميل|مسوده|خطاب|طلب)/.test(text)) {
    return 'Where do I draft an email' + (/(فندق|فنادق|الفنادق|غرف|الغرف|السعه)/.test(text) ? ' about hotel rooms?' : /(طيران|الطيران|رحلات|الرحلات|المطار|حجوزات)/.test(text) ? ' about flights?' : '?');
  }
  if (/(^|\s)(اين|مكان|موقع)(\s|$)|كيف (اجد|اصل|افتح)|لا اجد/.test(text)) {
    const places = [
      [/(بلد|دوله) المغادره|المغادره|بلد الانطلاق/, 'Where is the departure country?'],
      [/مسار جديد|المسار الجديد/, 'Where is new route?'],
      [/الافتراضات الاوليه|افتراضات البدايه/, 'Where are starting assumptions?'],
      [/(الرحلات الاضافيه|عدد الرحلات|الرحلات الاسبوعيه)/, 'Where are extra flights?'],
      [/(المقاعد|مقاعد)/, 'Where are seats per flight?'],
      [/(اشغال|امتلاء)/, 'Where is flight occupancy?'],
      [/(الفعاليات|فعاليات)/, 'Where are the upcoming events?'],
      [/(الفعاليه|الموسم)/, 'Where is the event control?'],
      [/(الغرض من السفر|غرض السفر|الغرض)/, 'Where is travel purpose?'],
      [/(تنتهي رحلتهم|الركاب الذين)/, 'Where is passengers ending their trip?'],
      [/(التسجيل في الفنادق|استخدام الفنادق|نسبه الفنادق)/, 'Where is hotel use?'],
      [/(متوسط الليالي|مده الاقامه|متوسط الاقامه)/, 'Where is average stay?'],
      [/تعديل الخطه/, 'Where is Adjust plan?'],
      [/(اضافه مهمه|اضف مهمه)/, 'Where is Add task?'],
      [/تسجيل القرار/, 'Where is Log decision?'],
      [/(اضافه ملاحظه|اضف ملاحظه)/, 'Where is Add note?'],
      [/مذكره القرار/, 'Where is the decision note?'],
      [/الخطوات التاليه/, 'Where is next steps?'],
      [/الاجراءات/, 'Where is Actions?'],
      [/(التصدير|تصدير|التنزيل|تنزيل)/, 'Where is export?'],
      [/(اللغه|العربيه|الانجليزيه)/, 'Where is the language?'],
      [/ارشدني/, 'Where is Guide me?'],
      [/البحث/, 'Where is search?'],
      [/(الاشعارات|الجرس)/, 'Where are notifications?'],
      [/المهام/, 'Where are tasks?'],
      [/(الاحصاءات|الاحصائيات)/, 'Where is statistics?'],
      [/تعديل التوزيع/, 'Where is edit mix?'],
      [/(الشهر|شهر)/, 'Where is the month control?'],
      [/(^|\s)(ملخص|الملخص)($|\s|[?؟])/, 'Where is Focus?'],
      [/المقارنه/, 'Where is Compare?'],
      [/التفاصيل/, 'Where is Details?'],
      [/المتابعات/, 'Where are follow-ups?'],
      [/توزيع الزوار/, 'Where is visitor mix?'],
      [/النتائج السابقه/, 'Where is check past results?'],
      [/دليل المصطلحات/, 'Where is the term guide?'],
      [/تخطيط المسار/, 'Where is plan a route?'],
    ].find(([pattern]) => pattern.test(text));
    if (places) return places[1];
  }
  // "قارن بالنتيجة السابقة", "ماذا تغير؟": compare with an earlier result.
  if (/(^|\s)(ماذا|ما الذي|ما اللذي|شو) (تغير|تغيرت)/.test(text)) return 'What changed?';
  if (/(قارن|قارنها|قارنه|قارني|مقارنه|بالمقارنه)/.test(text) && /(السابق|السابقه|قبل|الماضي|الماضيه|الاولي|الاول|البدايه|الاصليه|الان|مجددا)/.test(text)) {
    return /(الاولي|الاول|البدايه|الاصليه)/.test(text) ? 'Compare with my first result' : 'Compare with the previous result';
  }
  // Events and news: "ما توقع الفورمولا 1؟", "أخبار عن الهند", "ما الفعاليات القادمة؟".
  const eventName = /(الفورمولا|فورمولا|جائزه ابوظبي الكبري|الجائزه الكبري|حلبه مرسي ياس)/.test(text) ? 'F1'
    : /(اديبك|معرض ومؤتمر ابوظبي الدولي للبترول)/.test(text) ? 'ADIPEC'
    : /(ايدكس|نافدكس|معرض الدفاع)/.test(text) ? 'IDEX'
    : /(معرض ابوظبي الدولي للكتاب|معرض الكتاب)/.test(text) ? 'the book fair' : null;
  if (/(^|\s)(اخبار|الاخبار|خبر|مقالات|المقالات)(\s|$|[?.,!])/.test(text)) {
    const about = eventName || country
      || (/(رحلات|الرحلات|طيران|الطيران)/.test(text) ? 'flights' : /(سياحه|السياحه|فنادق|الفنادق|زوار|الزوار)/.test(text) ? 'tourism' : null);
    return about ? `Any news about ${about}?` : 'Any news?';
  }
  if (eventName) {
    const past = /(العام الماضي|السابقه|السابق|الماضيه|كيف اثر|كيف اثرت|ماذا حدث)/.test(text) && !/(توقع|التوقع|القادم|القادمه|المقبل|المقبله|سياتي)/.test(text);
    return past ? `How did ${eventName} affect hotels last year?` : `What is the forecast for ${eventName}?`;
  }
  if (/(الفعاليات|فعاليات|المعارض)/.test(text) && /(القادمه|القادم|المقبله|قريبا|(^|\s)ما(\s|$)|ماهي|ما هي|(^|\s)اي(\s|$)|(^|\s)في(\s|$))/.test(text)) {
    return `What events are coming up${month ? ' in ' + month : ''}?`;
  }
  // "ماذا لو …": a what-if on the open plan.
  if (/(ماذا لو|ماذا سيحدث|ما الذي سيحدث|ماذا يحدث|ماذا يصير|لو افترضنا|افترض ان)/.test(text)) {
    const flightCount = text.match(/(\d+)\s*(رحله|رحلات)/)?.[1] || (/رحلتين|رحلتان/.test(text) ? '2' : /رحله واحده/.test(text) ? '1' : null);
    if (flightCount != null && /(اضفنا|اضافه|نضيف|اضيف|زدنا|زياده|اكثر|اخري|اضافيه|ارتفع|ارتفعت|زادت)/.test(text) && !/(قللنا|نقص|اقل|خفضنا|حذفنا|الغينا)/.test(text)) return `What if we add ${flightCount} more flights?`;
    if (flightCount != null && /(قللنا|نقص|اقل|خفضنا|حذفنا|الغينا|انخفضت)/.test(text)) return `What if there are ${flightCount} fewer flights?`;
    // "زاد بنسبة 5%" is a relative change: the English reply asks for the final value.
    if (percentMatch && /(بنسبه|بمقدار)/.test(text) && /(زاد|زادت|ارتفع|ارتفعت|انخفض|انخفضت|نقص|نقصت|قل|قلت|زياده|انخفاض)/.test(text)) return `What if it changes by ${percentMatch[1]}%?`;
    if (percentMatch && /(اشغال|امتلاء)/.test(text)) return `What if flight occupancy is ${percentMatch[1]}%?`;
    if (percentMatch && /(التسجيل في الفنادق|استخدام الفنادق|نسبه الفنادق)/.test(text)) return `What if hotel use is ${percentMatch[1]}%?`;
    const stay = numberAfter(/(متوسط الليالي|مده الاقامه|متوسط الاقامه)/);
    if (stay != null) return `What if average stay is ${stay} nights?`;
  }
  if (/^(اضبط|عين|غير|اجعل|حدد|ضع)/.test(body)) {
    const fields = [
      [/(الرحلات الاضافيه|رحلات اضافيه|عدد الرحلات)/, (n) => `extra flights to ${n}`],
      [/(اشغال|امتلاء)/, (n) => `flight occupancy to ${n}%`],
      [/(الاقامه الفندقيه|استخدام الفنادق|نسبه الفنادق|التسجيل في الفنادق)/, (n) => `hotel use to ${n}%`],
      [/(مده الاقامه|متوسط الاقامه|متوسط الليالي|ليالي الاقامه)/, (n) => `average stay to ${n} nights`],
      [/(المقاعد|مقعد)/, (n) => `seats per flight to ${n}`],
    ].map(([pattern, phrase]) => { const n = numberAfter(pattern); return n == null ? null : phrase(n); }).filter(Boolean);
    if (fields.length) return `Set ${fields.join(' and ')}${where}`;
  }
  const flights = body.match(/^(اضف|زد|احذف|الغ|قلل)\s*(\d+)\s*(رحله|رحلات)/);
  if (flights) return `${/^(احذف|الغ|قلل)/.test(flights[1]) ? 'Remove' : 'Add'} ${flights[2]} flights${where}`;
  if (/(الرسم|الرسوم|المخطط|المخططات|البياني|البيانيه)/.test(text)) {
    const named = [[/(الاحصاءات|الاحصائيات)/, ' in Statistics'], [/توزيع الزوار/, ' in Visitor mix'], [/النتائج السابقه/, ' in Check past results'], [/المقارنه/, ' in Compare'], [/التفاصيل/, ' in Details']].find(([pattern]) => pattern.test(text));
    return 'Explain the charts' + (named ? named[1] : '');
  }
  if (/(ينقصني|ناقص|الناقصه|المتبقي|المتبقيه|لم انجز|لم اكمل|لم اتحقق|ما الذي بقي)/.test(text)) return 'What steps am I missing?';
  if (/(الخطوه التاليه|الخطوات التاليه|ما التالي|ماذا بعد|ماذا افعل الان|ماذا افعل بعد)/.test(text)) return 'What is the next step?';
  if (/(هذه الصفحه|هذا القسم|هذا التبويب|هذا الجزء|كيف يعمل هذا|كيف تعمل هذه|اين انا)/.test(text)) return 'How does this page work?';
  if (/(ماذا|ما الذي|شو) (يمكنك|تستطيع|تقدر)|^ماذا تفعل\??$|كيف استخدمك|^مساعده\??$/.test(text)) return 'What can you do?';
  if (/(اشرح|لخص|فسر|وضح|ملخص|ماذا تعني|ما معني)( لي)? (النتيجه|النتائج|نتيجتي|الخطه|خطتي|الارقام|هذه الارقام|هذه النتيجه)/.test(text)) return 'Explain the result';
  if (/(ما معني|ماذا يعني|ماذا تعني|ما المقصود|ما هو|ما هي|تعريف|عرف)/.test(text)) {
    const definitions = [
      [/(ليله النزيل|ليالي النزلاء|الليالي الفندقيه|الليله الفندقيه)/, 'What is a guest night?'],
      [/(التسجيل الفندقي|تسجيل فندقي|التسجيلات الفندقيه)/, 'What is a hotel check-in?'],
      [/(النطاق المحتمل|النطاق)/, 'What does the possible range mean?'],
      [/(السجلات المطابقه|السجلات السابقه)/, 'What does matching past records mean?'],
      [/(الاشغال|امتلاء)/, 'What does load factor mean?'],
      [/(تنتهي رحلتهم|الركاب الذين)/, 'What does passengers ending their trip mean?'],
      [/(الاقامه الفندقيه|استخدام الفنادق|التسجيل في الفنادق)/, 'What is hotel use?'],
      [/(الفعاليه|الفعاليات|الموسم)/, 'What is the event or season control?'],
    ];
    const definition = definitions.find(([pattern]) => pattern.test(text));
    if (definition) return definition[1];
  }
  const pages = [
    [/(كيف (استخدم|اتنقل|ابدا)|التنقل|من اين ابدا|ما هو air2stay|ما هذا التطبيق|جوله في التطبيق|نظره عامه|ما (هي )?الصفحات)/i, 'How do I navigate the app?'],
    [/(توزيع الزوار|مزيج الزوار|الجنسيات)/, 'What does Visitor mix show?'],
    [/(تبويب|عرض|صفحه|قسم) الملخص/, 'What does the Focus view show?'],
    [/(المقارنه|(^|\s)قارن)/, 'What does Compare do?'],
    [/(تبويب|عرض|صفحه|قسم) التفاصيل/, 'What does Details show?'],
    [/(المتابعات|المتابعه)/, 'What are Follow-ups?'],
    [/(النتائج السابقه|التحقق من النتائج)/, 'What does Check past results show?'],
    [/(دليل المصطلحات|المصطلحات)/, 'What is the Term guide?'],
    [/(الاحصاءات|الاحصائيات|الاحصائات)/, 'What does Statistics show?'],
    [/الرسائل/, 'What does Messages do?'],
    [/(^|\s)(تصدير|اصدر|صدر|تنزيل|احفظ التقرير|حفظ التقرير|اكسل|excel|pdf|csv)($|\s|[?.,!])/i, 'How do I export my plan?'],
    [/((ال)?مسار (ال)?جديد|(ال)?بلد (ال)?جديد|(ال)?دوله (ال)?جديده)/, 'How do I create a new route?'],
    [/(اللغه|العربيه|الانجليزيه|الانكليزيه)/, 'How do I change the language?'],
    [/(^|\s)(البحث|ابحث)($|\s|[?.,!])/, 'How do I search?'],
    [/(ارشدني|دليل الاستخدام|المساعده والتعلم|الجولات)/, 'What does Guide me do?'],
    [/(تعديل الخطه|ادوات التحكم|الاعدادات|تخطيط المسار)/, 'What does Adjust plan do?'],
    [/(المهام|الاشعارات|الشريط الجانبي|الاختصارات|الجرس)/, 'What are the shortcuts on the right?'],
  ];
  const page = pages.find(([pattern]) => pattern.test(text));
  if (page) return page[1];
  if (/(اشغال|امتلاء|ممتلئه)/.test(text)) return 'Explain how full the flights are';
  if (/(التقدير المرجعي|خط الاساس)/.test(text)) return 'Where does the baseline come from?';
  if (/الافتراضات/.test(text)) return 'What are the current assumptions?';
  if (/(دقه|دقيق|موثوق)/.test(text)) return 'How accurate is this?';
  if (/(اتحقق|نتحقق|التحقق|اراجع|الخطوه التاليه|الخطوات التاليه)/.test(text)) return 'What should I check next?';
  if (/(كيف|اشرح|وضح|لماذا).*(ليالي|الليالي|النتيجه|الخطه)/.test(text)) return 'How were hotel nights calculated?';
  return raw;
}

// "I want to set…", "please add…", "can you change…" → the command itself.
// Questions such as "can you explain…" are left unchanged.
function pcNormalizePrompt(text) {
  const stripped = text.replace(/^(?:(?:hey|hi|ok|okay|so)[,!.\s]+)?(?:(?:i\s+(?:want|would like|'d like|wanna|need|wish)\s+(?:you\s+)?(?:to\s+)?|please\s+|kindly\s+|can you\s+|could you\s+|would you\s+|will you\s+|let'?s\s+|let us\s+))+/i, '');
  return stripped !== text && /^(?:set|change|update|switch|use|try|add|remove|cancel|reduce|increase|decrease|make|assume|move|reset|double|triple|grow|raise|boost)\b/i.test(stripped) ? stripped : text;
}

// App guide: every line below describes what the app actually shows. Each
// English line has a matching Arabic entry in the app's dictionary.
const PC_GUIDE = [
  ['adjust', /adjust plan|plan controls|the controls|controls panel|settings|plan a route/, [
    'Plan a route is where you build a plan.',
    'Open Adjust plan to change it. The controls are in four groups:',
    '- Market: the departure country and month. Choose + New route for a country without past flights.',
    '- Flights: extra flights each week, seats on each flight and how full flights are.',
    '- Event or disruption: extra hotel demand for an event or season, from 0% to 50%.',
    '- Hotel visitors: travel purpose, passengers ending their trip in Abu Dhabi, the share checking into a hotel and average nights per stay.',
    'The results update as you change any value. Reset puts the starting values back.']],
  ['focus', /focus (?:tab|view|page)|focus(?= (?:show|shows|do|does|mean)\b)/, [
    'Focus shows the outcome of your plan:',
    '- Four result cards: extra hotel check-ins, extra guest nights, total guest nights and the possible range.',
    '- A chart of how your plan flows from seats to guest nights.',
    '- Next steps to check before relying on the result.']],
  ['compare', /compare(?: (?:tab|view|page|tools?))?/, [
    'Compare helps you decide which route option to investigate. Each option is compared with zero extra flights under the same assumptions.',
    '- Current proposal versus an existing route.',
    '- Three launch sizes: cautious, standard and expanded.',
    '- Compare months: the same plan across the year.',
    '- What if fewer visitors stay in hotels? Tests with lower assumptions.',
    '- The planning decision: a note you can save as a PDF or download as text.',
    'These are planning comparisons, not airline profitability or booking forecasts.']],
  ['details', /details (?:tab|view|page)|details(?= (?:show|shows|do|does|mean)\b)/, [
    'Details traces the assumptions, calculations, flight history and limits behind your plan, in four levels:',
    '- How the result is calculated.',
    '- What moves the result most.',
    '- Where the starting numbers come from.',
    '- Checks on the method.']],
  ['followups', /follow[- ]?ups?/, [
    'Follow-ups helps you check a plan before acting on it. It is saved in this browser.',
    '- What needs checking: flight demand, hotel capacity and visitor mix.',
    '- Tasks with an owner or team and a due date.',
    '- Notes, and a draft email to review and copy into your email app.',
    '- A decision log: Investigate, Hold or Ready for review.',
    'Assigning an owner does not send a notification.']],
  ['mix', /vis[a-z]{0,5} mix|nationalit(?:y|ies)|country bridge/, [
    'Visitor mix estimates which nationalities may make up the hotel guests on this route.',
    'It uses past patterns, not a list of confirmed guests.',
    'Flight records show where a trip started; hotel records show a guest’s nationality. Air2Stay uses both.',
    'It splits the same hotel estimate across nationalities, so the total does not change.',
    'Choose Edit mix to change the shares, then Update visitor mix. Reset to estimate puts the original shares back.']],
  ['validation', /check past results|past results(?: page)?|validation(?: page| results)?|accuracy (?:page|test|score)/, (data) => {
    const metrics = data.metrics || {};
    const share = Number.isFinite(metrics.liveChainWmape) ? (metrics.liveChainWmape * 100).toFixed(2) + '%' : null;
    return ['Check past results shows how close Air2Stay’s estimates were to real hotel arrivals.',
      ...(Number.isFinite(metrics.trainingMonths) && Number.isFinite(metrics.validationMonths) && metrics.validationPeriod
        ? [`It learned from ${metrics.trainingMonths} months of older records, then estimated ${metrics.validationMonths} later months it had not used (${String(metrics.validationPeriod).replace(' to ', ' – ')}) and compared them with the actual totals.`] : []),
      ...(share ? [`The overall weighted error was ${share} of recorded hotel arrivals. Lower is better.`] : []),
      'The page also shows a longer test and a month-by-month chart.'];
  }],
  ['terms', /term guide|glossary|terms page/, [
    'Term guide explains the words and numbers in Air2Stay in plain language.',
    'You can search for a term, and print or save the guide as a PDF.',
    'It also lists what the records don’t tell us, and how privacy and sharing work.']],
  ['stats', /statistics|stats(?: page)?/, [
    'Statistics puts your plan in context with charts:',
    '- Guest nights through the year: your plan against each month’s baseline estimate.',
    '- Largest departure markets in the selected month.',
    '- Total seats by month across the included markets.',
    '- The share of guests outside the 5 largest nationality groups.']],
  ['messages', /messages(?: page| tab)?|messaging|inbox|ai assist/, [
    'Messages lets you write, prioritise and keep track of messages to your team and partners.',
    'Messages are saved in this browser and not emailed.',
    'Use Inbox, Sent and Drafts, filter by priority, or search.',
    'When writing, AI Assist is a built-in drafting aid. No external AI service is called; review the text before sending.']],
  ['export', /export|download(?:ing)?(?: (?:the|my))? (?:plan|report|results|data)|excel|pdf|csv|save (?:the |my )?(?:plan|report|results)/, [
    'Export, on Plan a route, saves your plan as:',
    '- An Excel report: dashboard, results, visitors, months and scenarios.',
    '- A PDF report with charts, ready to print or share.',
    '- A model-ready CSV: inputs and simulated targets for this route across 12 months.',
    'In Compare, the planning decision note can be saved as a PDF or downloaded as text.']],
  ['newRoute', /new route|new country|new market|add a country|country without (?:past )?flights/, [
    'To plan a country without past flights, open Adjust plan, choose + New route under Departure country, then choose and confirm the country.',
    'A new route starts from zero. Comparison countries supply starting assumptions only; they do not prove demand.']],
  ['language', /language|arabic|english|translat/, [
    'Use the English and العربية buttons at the top to switch the page language.',
    'I reply in the language you write in, whatever the page language is.']],
  ['search', /search|guide me|help panel|help (?:&|and) learning|tours?\b/, [
    'Search at the top finds pages, plan views, controls, countries, months and terms. Press / to jump to it.',
    'Guide me, the book icon, opens Help & learning with short guides and plain-language answers.']],
  ['rail', /shortcuts?|side rail|right(?:-hand)? (?:edge|side)|tasks|notifications?|bell/, [
    'The shortcuts on the right edge open Tasks, Messages, Notifications and Statistics. Drag the dotted handle to move them up or down.',
    'The bell at the top shows notifications and checks that need attention.']],
];
const PC_OVERVIEW = [
  'Air2Stay estimates how changes to flights into Abu Dhabi could change hotel check-ins and guest nights.',
  'The pages along the top:',
  '- Plan a route: build and test a plan for one departure country and month.',
  '- Visitor mix: see which nationalities may make up the hotel guests.',
  '- Check past results: see how close past estimates were to real hotel arrivals.',
  '- Term guide: plain-language definitions of the words and numbers.',
  '- Statistics: charts that put your plan in context.',
  '- Messages: write and keep track of messages to your team.',
  'To start, open Adjust plan on Plan a route, choose a country and month, and change the flights.',
  'Ask me about any page or view, for example “What does Compare do?”',
];
const PC_DEFINITIONS = [
  ['guest nights?|hotel nights?', () => ['A guest night is one guest staying for one night. One guest staying three nights counts as three guest nights.', 'Guest nights count people, not hotel rooms.']],
  ['hotel check-?ins?|check-?ins?', () => ['A hotel check-in is a guest arriving to begin a stay at a hotel.']],
  ['possible range|range|p10|p90', (current, result) => ['The possible range gives lower and higher guides around the main estimate. Read it as a planning guide, not a guaranteed outcome.', `For your plan it is ${pcNumber(result.p10)} – ${pcNumber(result.p90)}.`]],
  ['matching past records|past records|data support', () => ['Matching past records shows how much flight history exists for this country and month.', '- Several records: three or more.', '- A few records: one or two.', '- No route records: a new route that starts from fallback assumptions.', 'It describes the data available, not forecast accuracy.']],
  ['load factor|flight occupancy|occupancy|how full (?:a |the )?flights? (?:is|are)', (current) => ['How full a flight is: if 160 of 200 seats are filled, the flight is 80% full.', `Your plan uses ${pcNumber(current.loadFactor * 100, 1)}%.`]],
  ['passengers ending their trip(?: in abu dhabi)?|p2p(?: share| passengers?)?|point[- ]to[- ]point(?: passengers?)?|trip[- ]ending share', (current) => ['Passengers ending their trip in Abu Dhabi arrive here and do not continue to another destination. A traveller staying here is included; one changing planes is not.', `Your plan uses ${pcNumber(current.p2pShare * 100, 1)}%.`]],
  ['hotel use|hotel conversion|conversion rate|share checking into a hotel', (current) => ['Hotel use is the share of passengers ending their trip in Abu Dhabi who check into a hotel.', `Your plan uses ${pcNumber(current.conversionRate * 100, 1)}%.`]],
  ['event or season|event uplift|event adjustment|seasonal uplift|event demand|event', () => ['The event or season control adds extra hotel demand from 0% to 50%. It is your planning assumption, not measured from past events.']],
];

function pcResultSummary(data, current, result) {
  const month = data.months[current.month - 1];
  const records = { Low: 'No route records', Medium: 'A few records', High: 'Several records' }[result.confidence?.label] || 'No route records';
  const signed = (value) => (Number(value) >= 0 ? '+' : '−') + pcNumber(Math.abs(Number(value)));
  const lines = [
    `Here is your current result for ${result.route.origin} in ${month}.`,
    '',
    `- Extra hotel check-ins: ${signed(result.delta.hotelCheckins)} compared with a usual ${month}.`,
    `- Extra guest nights: ${signed(result.delta.guestNights)} compared with a usual ${month}.`,
    `- Total guest nights: ${pcNumber(result.scenario.guestNights)} (usual: ${pcNumber(result.baseline.guestNights)}).`,
    `- Possible range: ${pcNumber(result.p10)} – ${pcNumber(result.p90)}. This is a history-based guide, not a guarantee.`,
    `- Matching past records: ${records}.`,
    '',
    `Your settings: ${pcNumber(current.extraFlights, 2)} extra flights a week, about ${pcNumber(current.seatsPerFlight)} seats per flight and ${pcNumber(current.loadFactor * 100, 1)}% of seats filled.`,
    `Visitors: ${pcNumber(current.p2pShare * 100, 1)}% end their trip in Abu Dhabi, ${pcNumber(current.conversionRate * 100, 1)}% of those use a hotel, staying ${pcNumber(current.averageStay, 2)} nights on average.`,
  ];
  if (result.eventUplift) lines.push(`It also includes a +${pcNumber(result.eventUplift * 100, 1)}% increase for an event or season, which you chose.`);
  if (!result.route.knownMarket) lines.push('This is a new route, so the usual month starts at zero.');
  lines.push('Ask “How were hotel nights calculated?” for the formula, or open Details for every step.');
  return lines.join('\n');
}

function pcGuideReply(data, text, current, result) {
  if (pcExplicitCommand(text)) return null;
  const lower = text.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  const asking = /\b(?:what(?:'s| is| are| does| do)|how (?:do|does|can|should|to) (?:i |we )?(?:use|open|find|get|change|switch|create|make|add|export|save|download|start|search)?|(?:can|could) (?:i|we)|is there|do you have|explain|tell me about|describe|summari[sz]e|guide me through|show me|where (?:is|are|can i find|do i find)|what can i do (?:in|with|on)|help me with)\b/;
  const plain = lower.replace(/[?.!]+$/, '');
  if (/\b(?:navigate|navigation|get around|where (?:do|should|can) i (?:start|begin)|getting started|get started|overview|tour of the app|what (?:is|does) (?:air2stay|this app|this tool|the app)(?: do)?|what can (?:this app|the app|air2stay) do|which pages|what pages|main (?:pages|features|sections)|walk me through the app)\b/.test(lower)
      || /^how (?:do|can|should) (?:i|we) (?:use|start|begin)(?: (?:the|this) (?:app|tool|site|website)| air2stay| it)?$/.test(plain)) return PC_OVERVIEW.join('\n');
  for (const [term, linesFor] of PC_DEFINITIONS) {
    const definition = new RegExp(`^(?:what(?:'s| is| are)|define|meaning of|explain the term)\\s+(?:a |an |the )?(?:${term})s?(?: control)?$|^what (?:does|do) (?:a |an |the )?(?:${term})s? mean$`);
    if (definition.test(plain)) return linesFor(current, result).join('\n');
  }
  // Pages and views first, so "What does Check past results show?" is not
  // mistaken for a request to explain the current result.
  for (const [, pattern, lines] of PC_GUIDE) {
    const exact = new RegExp(`^(?:the )?(?:${pattern.source})(?: (?:tab|view|page))?$`);
    if (exact.test(plain) || (asking.test(lower) && new RegExp(`\\b(?:${pattern.source})`).test(lower))) {
      return (typeof lines === 'function' ? lines(data) : lines).join('\n');
    }
  }
  if ((/\b(?:explain|summari[sz]e|summary|interpret|break down|walk me through|tell me about|what (?:does|do))\b/.test(lower) && /\b(?:result|results|outcome|numbers|cards|estimate|my plan|this plan|the plan)\b/.test(lower)
      && !/\b(?:assumptions?|baseline|range|records?|calculat\w*|formula|accura\w*|nights?|flights?|visitor|mix|compare|target|export)\b/.test(lower))
      || /^(?:explain|summari[sz]e)(?: it| this)?$/.test(plain) || /^what am i looking at$/.test(plain)) {
    return pcResultSummary(data, current, result);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Assistant extras: next steps, missing checks, this page, charts and messages.
// Every sentence is one line so the app dictionary can translate it.

// Which guide topic belongs to the page and view the user has open.
function pcPageKey(where = {}) {
  if (where.view === 'scenarioView' || !where.view) {
    return { focus: 'focus', decisions: 'compare', details: 'details', proposal: 'followups', chat: 'focus' }[where.mode] || 'focus';
  }
  return { bridgeView: 'mix', validationView: 'validation', glossaryView: 'terms', statsView: 'stats', messagesView: 'messages' }[where.view] || 'focus';
}

const PC_PAGE_NAMES = Object.freeze({ focus: 'Focus', compare: 'Compare', details: 'Details', followups: 'Follow-ups',
  mix: 'Visitor mix', validation: 'Check past results', terms: 'Term guide', stats: 'Statistics', messages: 'Messages' });

// Each line describes what the chart on that page actually draws.
const PC_CHARTS = Object.freeze({
  focus: [
    'The four cards show extra hotel check-ins, extra guest nights, total guest nights and the possible range.',
    'The small line in the first three cards shows that measure for every month of the year.',
    'The possible range card shows the lower and higher guides as a bar.',
    'From seats to guest nights: each bar is one step, from flight seats to passengers, passengers ending their trip in Abu Dhabi, hotel check-ins and guest nights.',
    'In that chart, gold shows the usual month, the rose cap marks your plan and the badge shows the change.',
  ],
  compare: [
    'Three launch sizes: cards for cautious, standard and expanded weekly flights, with the extra check-ins and guest nights each would add.',
    'Compare months: the extra guest nights from the same flights in each month of the year.',
    'What if fewer visitors stay in hotels?: how much the extra guest nights fall under each lower-assumption trial, compared with your plan.',
    'Explore monthly metrics to compare exact values. The stress chart still has a Show the numbers table.',
  ],
  details: [
    'Estimated hotel nights by nationality: the estimated change in hotel nights for each visitor group.',
    'One-at-a-time sensitivity: how far guest nights move when one assumption is nudged up or down on its own; the nudge sizes differ, so treat it as a guide.',
    'Route map: a schematic line from the country’s reference point to Abu Dhabi city, not airport locations.',
    'Seats by month: average monthly flight seats for this route from the supplied records; bars start at zero and k means thousand.',
  ],
  mix: [
    'Global Visitor Origins: an illustrative map of visitor nationalities; locations are country reference points, not airports or flight paths.',
    'The cards list the largest nationality groups with their share, hotel check-ins and guest nights.',
  ],
  validation: [
    'Monthly hotel arrivals: the recorded hotel arrivals for each test month, compared with Air2Stay’s live calculation and the hybrid comparison model.',
    'The shaded band shows plus or minus the overall weighted error around the live estimate; it is a visual guide, not a guaranteed range.',
  ],
  stats: [
    'Guest nights through the year: your plan against each month’s baseline estimate.',
    'Largest departure markets in the selected month.',
    'Total seats by month across the included markets.',
    'The share of guests outside the 5 largest nationality groups.',
  ],
});

function pcNamedPage(lower) {
  const named = [
    ['stats', /\bstatistics\b|\bstats\b/], ['mix', /\bvis[a-z]{0,5} mix\b|\bnationalit/], ['validation', /\bpast results\b|\bvalidation\b|\baccuracy\b/],
    ['compare', /\bcompare\b/], ['details', /\bdetails\b/], ['focus', /\bfocus\b|\bresult cards\b|\bplan a route\b/],
    ['followups', /\bfollow[- ]?ups?\b/], ['messages', /\bmessages\b/], ['terms', /\bterm guide\b|\bglossary\b/],
  ].find(([, pattern]) => pattern.test(lower));
  return named ? named[0] : null;
}

function pcChartsReply(lower, where) {
  const key = pcNamedPage(lower) || pcPageKey(where);
  const lines = PC_CHARTS[key] || [];
  if (!lines.length) return 'This page has no charts. Plan a route (Focus, Compare and Details), Visitor mix, Check past results and Statistics have charts.';
  return [`Here is what the charts on ${PC_PAGE_NAMES[key]} show:`, ...lines.map((line) => `- ${line}`)].join('\n');
}

function pcPageReply(where, data) {
  const key = pcPageKey(where);
  const entry = PC_GUIDE.find(([name]) => name === key);
  const lines = entry ? (typeof entry[2] === 'function' ? entry[2](data) : entry[2]) : [];
  const body = lines.length ? lines : [`You are on ${PC_PAGE_NAMES[key]}.`];
  return [...body, ...(PC_CHARTS[key]?.length ? ['', 'Ask “Explain the charts” to read the graphs on this page.'] : [])].join('\n');
}

function pcNextStepsReply(next) {
  const { readiness, steps } = next;
  const lines = [`Decision readiness: ${readiness.verified} of ${readiness.total} checks have recorded evidence.`, ''];
  if (!steps.length) {
    lines.push('All checks have recorded evidence for these exact assumptions.', 'You can finish with a planning decision in Compare.');
    return lines.join('\n');
  }
  steps.forEach((step, index) => {
    lines.push(`Step ${index + 1}: ${step.title}.`);
    if (step.status === 'red') lines.push('This check is overdue.');
    lines.push(step.why);
    if (step.impact) lines.push(step.impact);
    lines.push(step.ask, '');
  });
  lines.push('Use Add task in the Next steps box on Focus to track each check.', 'When these are done, finish with a planning decision in Compare.');
  return lines.join('\n');
}

function pcMissingReply(missing) {
  const checks = (missing.checks || []).filter((check) => check.status !== 'green');
  const builtIn = checks.filter((check) => !String(check.id).startsWith('task:'));
  const lines = [];
  if (builtIn.length) lines.push(`You still have ${builtIn.length} of ${missing.total} checks without recorded evidence:`);
  else lines.push('Every check has recorded evidence for these exact assumptions.');
  for (const check of checks) lines.push(`- ${check.title} · ${check.status === 'red' ? 'overdue' : 'no recorded evidence yet'}`);
  if (!missing.decisionLogged) lines.push('', 'No planning decision is logged yet; use Log decision in Follow-ups when the checks are done.');
  if (!checks.length && missing.decisionLogged) return 'Nothing is missing: every check has recorded evidence for these exact assumptions, and a decision is logged.';
  if (checks.length) lines.push('', 'Ask “What is the next step?” for the order to work through them.');
  return lines.join('\n');
}

// Messages and approval requests: "where is the message about …?"
const PC_MESSAGE_STOP = new Set(['where', 'what', 'which', 'the', 'message', 'messages', 'email', 'emails', 'mail', 'from', 'about', 'regarding', 'find', 'inbox', 'sent', 'drafts', 'draft', 'folder', 'located', 'location', 'are', 'my', 'the', 'that', 'this', 'with', 'for', 'can', 'you', 'show', 'list', 'any', 'have', 'there', 'how', 'many', 'unread', 'request', 'requests', 'approval', 'approvals', 'look', 'search', 'titled', 'called', 'subject', 'did', 'get', 'got', 'received', 'receive', 'does', 'and', 'was', 'were', 'one', 'please', 'tell', 'kept', 'stored', 'saved', 'put', 'went', 'gone', 'into', 'waiting', 'pending', 'open', 'still', 'status', 'new', 'box',
  'اين', 'الرساله', 'رساله', 'الرسائل', 'رسائل', 'البريد', 'الوارد', 'المسودات', 'المسوده', 'مسوده', 'المرسله', 'التي', 'الذي', 'ابحث', 'اجد', 'اعثر', 'موقع', 'طلب', 'الطلب', 'طلبات', 'الطلبات', 'موافقه', 'الموافقه', 'لدي', 'عندي', 'حول', 'بخصوص', 'غير', 'مقروءه', 'المقروءه', 'يوجد', 'توجد', 'هناك', 'قيد', 'انتظار', 'الانتظار', 'صندوق', 'مجلد']);

export function pcMessagesQuery(prompt) {
  const raw = String(prompt || '').trim().slice(0, 600);
  if (!raw) return null;
  const arabic = /[؀-ۿ]/.test(raw);
  const text = arabic ? pcArabicNormalize(raw) : raw.toLowerCase();
  const topic = arabic ? /(رساله|رسائل|البريد|الوارد|المسودات|مسوده|المرسله|طلب|طلبات|موافقه)/ : /\b(?:messages?|e-?mails?|mail|inbox|drafts?|unread|requests?|approvals?)\b/;
  const asking = arabic ? /(^|\s)(اين|ابحث|اجد|اعثر|كم|عدد|هل|موقع|في اي)(\s|$)/ : /\b(?:where|find|which folder|located|location|how many|any|do i have|is there|are there|look for|search for|show me|list)\b/;
  if (!topic.test(text) || !asking.test(text)) return null;
  // "Where should I draft an email…?" asks where to write one: the guide answers it.
  if (arabic ? PC_AR_DRAFT_INTENT.test(text) : PC_DRAFT_INTENT.test(text)) return null;
  const requests = arabic ? /(طلب|طلبات|موافقه)/.test(text) : /\b(?:requests?|approvals?)\b/.test(text);
  const folder = arabic ? (/(المسودات|مسوده)/.test(text) ? 'drafts' : /المرسله/.test(text) ? 'sent' : /الوارد/.test(text) ? 'inbox' : null)
    : (/\bdrafts?\b/.test(text) ? 'drafts' : /\bsent\b/.test(text) ? 'sent' : /\binbox\b/.test(text) ? 'inbox' : null);
  const count = arabic ? /(^|\s)(كم|عدد)(\s|$)/.test(text) : /\bhow many\b/.test(text);
  const unread = arabic ? /غير مقروء/.test(text) : /\bunread\b/.test(text);
  const terms = [...new Set(text.replace(/[?؟!.,:;"“”'’()«»]/g, ' ').split(/\s+/)
    // Arabic words are also checked without a leading "al-", "wa-", "bi-", "li-" or "min".
    .filter((word) => !PC_MESSAGE_STOP.has(word))
    .map((word) => arabic ? word.replace(/^(ال|و|ب|ل|من)(?=..)/, '') : word)
    .filter((word) => word.length >= 3 && !PC_MESSAGE_STOP.has(word) && !(arabic && PC_MESSAGE_STOP.has('ال' + word))))];
  return { arabic, requests, folder, count, unread, terms };
}

function pcMatchScore(terms, fields, arabic) {
  const haystack = fields.map((field) => arabic ? pcArabicNormalize(String(field || '')) : String(field || '').toLowerCase());
  return terms.reduce((score, term) => score + haystack.reduce((sum, field, index) => sum + (field.includes(term) ? (index === haystack.length - 1 ? 1 : 2) : 0), 0), 0);
}

export function pcMessagesReply(query, team) {
  const messages = Array.isArray(team?.messages) ? team.messages : [];
  const requests = Array.isArray(team?.requests) ? team.requests : [];
  const folderName = { inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts' };
  const counts = { inbox: 0, sent: 0, drafts: 0 };
  for (const message of messages) if (Object.hasOwn(counts, message.folder)) counts[message.folder] += 1;
  const unread = messages.filter((message) => message.folder === 'inbox' && message.unread).length;
  const summary = `Messages: Inbox ${counts.inbox} (${unread} unread), Sent ${counts.sent}, Drafts ${counts.drafts}.`;
  if (query.requests) {
    const scored = requests.map((request) => ({ request, score: pcMatchScore(query.terms, query.arabic ? [request.titleAr, request.fromAr] : [request.title, request.from], query.arabic) }));
    const best = Math.max(0, ...scored.map((row) => row.score));
    const waiting = requests.filter((request) => request.status === 'Waiting').length;
    if (query.count || !query.terms.length || best === 0) {
      return ['Approval requests are in Tasks, in the shortcuts on the right edge.', `Requests: ${requests.length}, waiting: ${waiting}.`,
        ...(query.terms.length && !query.count ? ['I couldn’t find a request that matches those words.'] : [])].join('\n');
    }
    const found = scored.filter((row) => row.score === best).slice(0, 3).map((row) => row.request);
    return [...found.map((request) => `The request “${request.title}” from ${request.from} is in Tasks, marked ${request.status}.`),
      'Open Tasks from the shortcuts on the right edge to see it.'].join('\n');
  }
  if (query.count || query.unread || !query.terms.length) {
    if (query.folder && !query.count && !query.unread) {
      return [`${folderName[query.folder]} is in Messages in the side shortcuts (messages: ${counts[query.folder]}).`, 'Open Messages in the side shortcuts to see them.'].join('\n');
    }
    return [summary, 'Open Messages in the side shortcuts to see them.'].join('\n');
  }
  const pool = messages.filter((message) => !query.folder || message.folder === query.folder);
  const scored = pool.map((message) => ({ message, score: pcMatchScore(query.terms,
    query.arabic ? [message.subjectAr, message.fromAr, message.toAr, message.body] : [message.subject, message.from, message.to, message.body], query.arabic) }));
  const best = Math.max(0, ...scored.map((row) => row.score));
  if (best === 0) return ['I couldn’t find a message that matches those words.', summary, 'Try a word from the subject or the sender’s name.'].join('\n');
  const found = scored.filter((row) => row.score === best).map((row) => row.message);
  if (found.length > 1) {
    return ['I found these messages:', ...found.slice(0, 5).map((message) => `- “${message.subject}” · ${folderName[message.folder] || message.folder}`), 'Open Messages in the side shortcuts, choose the folder, then select the message.'].join('\n');
  }
  const [message] = found;
  const place = folderName[message.folder] || message.folder;
  const lines = [message.folder === 'drafts' ? `Your draft “${message.subject}” is in ${place}.`
    : message.folder === 'sent' ? `The message “${message.subject}” to ${message.to} is in ${place}.`
    : `The message “${message.subject}” from ${message.from} is in ${place}.`];
  if (message.folder === 'inbox' && message.unread) lines.push('It is unread.');
  lines.push(`Open Messages in the side shortcuts, choose ${place}, then select it.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// What-if: works out a change on the open plan without applying it.
const PC_WHATIF_FIELDS = [
  ['extraFlights', 'Extra flights each week', (value) => pcNumber(value)],
  ['seatsPerFlight', 'Seats on each flight', (value) => pcNumber(value)],
  ['loadFactor', 'How full flights are', (value) => (Number(value) * 100).toFixed(1) + '%'],
  ['p2pShare', 'Passengers ending their trip in Abu Dhabi', (value) => (Number(value) * 100).toFixed(1) + '%'],
  ['conversionRate', 'Share checking into a hotel', (value) => (Number(value) * 100).toFixed(1) + '%'],
  ['averageStay', 'Average nights per hotel stay', (value) => Number(value).toFixed(2)],
  ['eventUplift', 'Extra hotel demand for an event or season', (value) => (Number(value) * 100).toFixed(1) + '%'],
];
const PC_WHATIF_INTENT = /\b(?:what (?:will|would|could) happen if|what happens if|what if|suppose|imagine if|what would (?:the |my )?(?:result|results|plan|nights?|numbers?) (?:be|look like) if)\b/;

// "2 more flights", "increase by 2", "another 2 flights": a change from the
// current number. Returns the signed change, or null.
function pcFlightStep(lower) {
  const up = lower.match(/\b(\d+)\s+(?:more|additional)\s+(?:weekly\s+|extra\s+)?flights?\b|\b(?:another|an additional)\s+(\d+)\s+flights?\b|\bflights?\b[^.?!]{0,40}?\b(?:increase[sd]?|rise[sn]?|rose|grow[sn]?|go(?:es)? up|went up)\s+by\s+(\d+)\b|\b(?:increase|raise|grow)\s+(?:the\s+)?(?:extra\s+|weekly\s+)?flights?\s+by\s+(\d+)\b|\b(?:add|adding|added)\s+(\d+)\s+(?:more\s+|extra\s+|weekly\s+)?flights?\b/);
  if (up) return Number(up.slice(1).find(Boolean));
  const down = lower.match(/\b(\d+)\s+(?:fewer|less)\s+(?:weekly\s+|extra\s+)?flights?\b|\bflights?\b[^.?!]{0,40}?\b(?:decrease[sd]?|drop(?:s|ped)?|fall[s]?|fell|go(?:es)? down|went down|reduce[sd]?|cut)\s+by\s+(\d+)\b|\b(?:decrease|reduce|cut|lower)\s+(?:the\s+)?(?:extra\s+|weekly\s+)?flights?\s+by\s+(\d+)\b|\b(?:remove|removing|removed|cancel|cancelling|cancelled)\s+(\d+)\s+(?:weekly\s+|extra\s+)?flights?\b/);
  if (down) return -Number(down.slice(1).find(Boolean));
  return null;
}

function pcWhatIfCommand(key, value) {
  if (key === 'extraFlights') return `Set extra flights to ${value}`;
  if (key === 'loadFactor') return `Set flight occupancy to ${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
  if (key === 'conversionRate') return `Set hotel use to ${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
  if (key === 'averageStay') return `Set average stay to ${Number(value.toFixed(2))} nights`;
  if (key === 'seatsPerFlight') return `Set seats per flight to ${Math.round(value)}`;
  return null;
}

function pcWhatIfReply(data, text, lower, current) {
  if (!PC_WHATIF_INTENT.test(lower)) return null;
  const rest = text.replace(/^.*?\b(?:what (?:will|would|could) happen if|what happens if|what if|suppose|imagine if|what would (?:the |my )?(?:result|results|plan|nights?|numbers?) (?:be|look like) if)\b/i, '').trim();
  const step = pcFlightStep(lower);
  let parsed = null;
  // "by 5%" is a relative change the planner cannot read without guessing.
  if (/\bby\s+-?\d+(?:\.\d+)?\s*(?:%|percent|percentage points?|points?)/.test(lower)) return null;
  const phrase = pcCanonicalCommand((rest || text).replace(/\b(?:is|are|was|were|becomes?|became|goes to|went to|(?:drops?|rises?|falls?|changes?|moves?) to)\b/gi, ' '));
  try { parsed = parseScenarioPrompt(data, phrase, current); } catch { parsed = null; }
  const changes = { ...(parsed?.understood ? parsed.changes : {}) };
  if (step != null) changes.extraFlights = Number(current.extraFlights) + step;
  const route = changes.originKey && changes.originKey !== current.originKey ? data.routes.find((row) => row.originKey === changes.originKey)?.origin || changes.originKey : null;
  const month = changes.month && Number(changes.month) !== Number(current.month) ? data.months[changes.month - 1] : null;
  if (route || month) {
    return ['This what-if works on the plan you have open.',
      ...(route ? [`Switch the departure country to ${route} first, then ask again.`] : []),
      ...(month ? [`Switch the month to ${month} first, then ask again.`] : [])].join('\n');
  }
  const keys = PC_WHATIF_FIELDS.map(([key]) => key).filter((key) => changes[key] != null && Number(changes[key]) !== Number(current[key]));
  if (!keys.length) return null;
  const next = { ...current };
  for (const key of keys) next[key] = Number(changes[key]);
  if (validateScenarioInputs(next)) {
    if (keys.includes('extraFlights') && (next.extraFlights < -20 || next.extraFlights > 20)) return 'Extra flights must stay between −20 and 20 a week, so I can’t work that out.\nYour plan has not changed.';
    return 'That value is outside what the planner allows, so I can’t work that out.\nYour plan has not changed.';
  }
  const before = planningMetrics(data, current);
  const after = planningMetrics(data, next);
  const totalBefore = runScenario(data, current).scenario.guestNights;
  const totalAfter = runScenario(data, next).scenario.guestNights;
  const lines = ['Here is how this change would affect your plan, without applying it:'];
  for (const [key, label, format] of PC_WHATIF_FIELDS) if (keys.includes(key)) lines.push(`- ${label}: ${format(current[key])} → ${format(next[key])}`);
  lines.push(`- Extra hotel check-ins: ${pcNumber(before.incremental.hotelCheckins)} → ${pcNumber(after.incremental.hotelCheckins)}`,
    `- Extra guest nights: ${pcNumber(before.incremental.guestNights)} → ${pcNumber(after.incremental.guestNights)}`,
    `- Total guest nights: ${pcNumber(totalBefore)} → ${pcNumber(totalAfter)}`, '');
  const difference = Math.round(totalAfter - totalBefore);
  lines.push(difference > 0 ? `That is about ${pcNumber(difference)} more guest nights than your plan.`
    : difference < 0 ? `That is about ${pcNumber(-difference)} fewer guest nights than your plan.` : 'Guest nights would stay about the same.');
  const commands = keys.map((key) => pcWhatIfCommand(key, next[key]));
  lines.push(keys.length === 1 && commands[0] ? `Your plan has not changed; to apply it, say “${commands[0]}”.`
    : 'Your plan has not changed; to apply it, give each change as a command, such as “Set extra flights to 5”.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Where things are: "where is the departure country?", "where do I draft an email?"
const PC_WHERE_INTENT = /\bwhere(?:'s| is| are| do| does| can| could| should| would| to| i| will)\b|\blocat(?:e|ed|ion)\b|\b(?:how|where) (?:do|can|could|should) i (?:find|get to|open|reach)\b|\bcan(?:'t|not) find\b|\bfind the\b/;
// Asking how or where to write one, not where an existing message is.
const PC_DRAFT_INTENT = /\b(?:should|can|could|do|would|to|how (?:do|can|to)|want to|need to|like to)\s+(?:i\s+|we\s+|you\s+)?(?:draft|write|compose|send|prepare|create|start)\b[^.?!]{0,50}\b(?:e-?mails?|messages?|letters?|requests?|drafts?)\b|^(?:please\s+)?(?:draft|write|compose)\s+(?:an?\s+|the\s+|my\s+)?(?:e-?mail|message|letter)\b/;
const PC_AR_DRAFT_INTENT = /(^|\s)(اكتب|كتابه|اصيغ|صياغه|انشئ|انشاء|ارسل|ارسال|احرر|تحرير)(\s|$)/;
const PC_CONTROLS = [
  [/\b(?:departure(?: country)?|country of departure|origin(?: country)?|(?:choose|change|pick|select|switch) (?:a |the )?(?:country|route)|country (?:control|selector|menu|list|dropdown|box))\b/, 'Departure country', '01 Market'],
  [/\bstarting assumptions\b/, 'Starting assumptions', '01 Market'],
  [/\b(?:month (?:control|selector|picker|menu|dropdown|box)|(?:choose|change|pick|select|set) (?:a |the )?month)\b|^(?:where (?:is|are) )?(?:the )?months?\??$/, 'Month', '01 Market'],
  [/\b(?:extra flights|flights each week|weekly flights|number of flights|flight count)\b/, 'Extra flights each week', '02 Flights'],
  [/\b(?:seats?(?: per| on each)? flight|seats|aircraft size)\b/, 'Seats on each flight', '02 Flights'],
  [/\b(?:load factor|flight occupancy|how full (?:the )?flights)\b/, 'How full flights are', '02 Flights'],
  [/\b(?:event|season|disruption|uplift)\b/, 'Extra hotel demand for an event or season', '03 Event or disruption'],
  [/\b(?:travel purpose|route purpose|purpose)\b/, 'Expected travel purpose', '04 Hotel visitors'],
  [/\b(?:p2p|passengers ending|trip[- ]ending|ending their trip)\b/, 'Passengers ending their trip in Abu Dhabi', '04 Hotel visitors'],
  [/\b(?:hotel use|hotel conversion|conversion rate|checking into a hotel|hotel share)\b/, 'Share checking into a hotel', '04 Hotel visitors'],
  [/\b(?:average stay|nights per (?:hotel )?stay|length of stay|stay length)\b/, 'Average nights per hotel stay', '04 Hotel visitors'],
];
const PC_PLACES = [
  [/\bnew route\b/, ['+ New route is the last choice in Departure country, under Adjust plan.']],
  [/\badjust plan\b|\b(?:plan )?controls\b|\bsettings\b/, ['Adjust plan is the button at the top left of Plan a route.', 'It opens the plan controls in four sections: 01 Market, 02 Flights, 03 Event or disruption and 04 Hotel visitors.']],
  [/\badd (?:a )?task\b|\bnew task\b/, ['Add task is on each check in Follow-ups, and in the Next steps box on Focus.']],
  [/\blog (?:a |the |my )?decision\b|\brecord (?:a |the |my )?decision\b/, ['Log decision is in Follow-ups, further down the page.']],
  [/\badd (?:a )?note\b/, ['Add note is in Follow-ups, below Your tasks.']],
  [/\bdecision note\b/, ['The decision note is on Compare, with Save as PDF and a text download.']],
  [/\bnext steps?(?: box)?\b/, ['Next steps is on Focus, below your result.']],
  [/\bactions?(?: button| panel)?\b|\bpriority actions\b/, ['Actions is the button at the top right of Plan a route; its number shows the checks that need attention.']],
  [/\bexport|\bdownload\b/, ['Export is the button under Your current plan on Focus.', 'It saves the plan as Excel, a PDF report or CSV, in English or Arabic.']],
  [/\blanguage\b|\barabic\b|\benglish\b/, ['The language buttons, EN and عربي, are at the top right of the page.']],
  [/\bguide me\b/, ['Guide me is the button next to Search at the top right.']],
  [/\bsearch\b/, ['Search is at the top right of the page.']],
  [/\bnotifications?\b|\bbell\b/, ['Notifications is the bell at the top right, and it is also in the shortcuts on the right edge.']],
  [/\btasks?\b/, ['Tasks is in the shortcuts on the right edge.']],
  [/\bstatistics\b|\bstats\b/, ['Statistics is in the menu at the top of the page and in the shortcuts on the right edge.']],
  [/\bedit mix\b/, ['Edit mix is on the Visitor mix page.']],
  [/\bfocus\b/, ['“Focus” is a tab at the top of Plan a route.']],
  [/\bcompare\b/, ['“Compare” is a tab at the top of Plan a route.']],
  [/\bdetails\b/, ['“Details” is a tab at the top of Plan a route.']],
  [/\bfollow[- ]?ups?\b/, ['“Follow-ups” is a tab at the top of Plan a route.']],
  [/\bvisitor mix\b/, ['“Visitor mix” is in the menu at the top of the page.']],
  [/\b(?:check )?past results\b|\bvalidation\b/, ['“Check past results” is in the menu at the top of the page.']],
  [/\bterm guide\b|\bglossary\b/, ['“Term guide” is in the menu at the top of the page.']],
  [/\bplan a route\b/, ['“Plan a route” is in the menu at the top of the page.']],
];

function pcPlaceReply(lower) {
  const draft = PC_DRAFT_INTENT.test(lower);
  if (!draft && !PC_WHERE_INTENT.test(lower)) return null;
  if (draft) {
    const lines = ['To draft an email, open Follow-ups, then open Draft email.', 'Choose who it is for under Message for, then choose Prepare draft.'];
    if (/\b(?:hotels?|rooms?|capacity|accommodation)\b/.test(lower)) lines.push('For hotel rooms or capacity, choose Hotel team.');
    else if (/\b(?:airlines?|airports?|flights?|seats?|bookings?)\b/.test(lower)) lines.push('For flights or bookings, choose Airline or airport planner.');
    lines.push('Draft email in the Next steps box on Focus opens the same form.');
    return lines.join('\n');
  }
  const control = PC_CONTROLS.find(([pattern]) => pattern.test(lower));
  if (control) {
    const lines = [`You set “${control[1]}” under Adjust plan, in section ${control[2]}.`, 'Adjust plan is the button at the top left of Plan a route.'];
    if (control[1] === 'Starting assumptions') lines.push('It appears when you choose + New route in Departure country.');
    return lines.join('\n');
  }
  const place = PC_PLACES.find(([pattern]) => pattern.test(lower));
  return place ? place[1].join('\n') : null;
}

// ---------------------------------------------------------------------------
// Typing slips: when a message is not understood, the controller can retry
// once with close misspellings of known words corrected ("chsnge" → "change").
const PC_TYPO_WORDS = ['change', 'switch', 'update', 'increase', 'decrease', 'reduce', 'remove', 'explain', 'compare', 'located', 'location',
  'where', 'message', 'messages', 'email', 'emails', 'draft', 'drafts', 'flight', 'flights', 'previous', 'result', 'results', 'visitor', 'visitors',
  'hotel', 'hotels', 'night', 'nights', 'check', 'checks', 'chart', 'charts', 'graph', 'graphs', 'missing', 'departure', 'country', 'month',
  'occupancy', 'factor', 'average', 'conversion', 'calculate', 'calculated', 'summary', 'export', 'download', 'language', 'arabic', 'english', 'inbox',
  'request', 'requests', 'season', 'event', 'uplift', 'seats', 'passengers', 'baseline', 'statistics', 'validation', 'glossary', 'decision', 'assumption',
  'assumptions', 'happen', 'extra', 'weekly', 'guest', 'guests', 'record', 'records', 'details', 'follow', 'steps', 'unread', 'search', 'notifications'];

function pcOneEditApart(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diff = [...a].map((char, index) => char !== b[index] ? index : -1).filter((index) => index >= 0);
    return diff.length === 1 || (diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]]);
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  for (let index = 0; index < long.length; index += 1) if (long.slice(0, index) + long.slice(index + 1) === short) return true;
  return false;
}

/** English only: corrected text and the corrections made, or null when nothing changed. */
export function pcFixTypos(data, text) {
  const raw = String(text || '');
  if (/[؀-ۿ]/.test(raw)) return null;
  const known = new Set([...PC_TYPO_WORDS, ...data.routes.map((route) => route.origin.toLowerCase()).filter((name) => !/\s/.test(name)), ...data.months.map((name) => name.toLowerCase())]);
  const fixes = [];
  const fixed = raw.replace(/[A-Za-z]{5,}/g, (word) => {
    const lower = word.toLowerCase();
    if (known.has(lower)) return word;
    const matches = [...known].filter((candidate) => candidate[0] === lower[0] && candidate.length >= 4 && pcOneEditApart(lower, candidate));
    if (matches.length !== 1) return word;
    fixes.push([word, matches[0]]);
    return matches[0];
  });
  return fixes.length ? { text: fixed, fixes } : null;
}

// ---------------------------------------------------------------------------
// Compare the open plan with an earlier result from this session.
const PC_COMPARE_INTENT = /\b(?:compare|comparison|compared|versus|vs)\b[^.?!]*\b(?:previous|last|earlier|before|prior|old|original|first|start(?:ed|ing)?|beginning)\b|\b(?:previous|earlier|prior|old) (?:result|results|plan|one|version|numbers?)\b|\bwhat (?:has |have )?changed\b|\bwhat did (?:that|this|it|the change) (?:do|change)\b|^(?:(?:can|could|would) you |please )*compare (?:it|this|them|that|now|again)\b/;
const PC_COMPARE_FIRST = /\b(?:first|original|start(?:ed|ing)?|beginning)\b/;

function pcPlanNumbers(data, inputs) {
  const run = runScenario(data, inputs);
  const metrics = planningMetrics(data, inputs);
  return { origin: run.route.origin, month: Number(inputs.month), checkins: metrics.incremental.hotelCheckins, added: metrics.incremental.guestNights, total: run.scenario.guestNights };
}

/** Exported for tests: compares the open plan with history.previous or history.first. */
export function pcCompareReply(data, lower, current, history) {
  const first = PC_COMPARE_FIRST.test(lower);
  const before = first ? history?.first : history?.previous;
  if (!before) return ['There is no earlier result to compare with yet.', 'Change the plan, then ask again; I compare with the result just before the change.'].join('\n');
  let then, now;
  try { then = pcPlanNumbers(data, before); now = pcPlanNumbers(data, current); }
  catch { return 'There is no earlier result to compare with yet.'; }
  const lines = [first ? 'Compared with your first result in this session:' : 'Compared with your previous result:'];
  if (then.origin !== now.origin) lines.push(`- Departure country: ${then.origin} → ${now.origin}`);
  if (then.month !== now.month) lines.push(`- Month: ${data.months[then.month - 1]} → ${data.months[now.month - 1]}`);
  for (const [key, label, format] of PC_WHATIF_FIELDS) {
    if (Number.isFinite(Number(before[key])) && Number.isFinite(Number(current[key])) && format(before[key]) !== format(current[key])) lines.push(`- ${label}: ${format(before[key])} → ${format(current[key])}`);
  }
  lines.push(`- Extra hotel check-ins: ${pcNumber(then.checkins)} → ${pcNumber(now.checkins)}`,
    `- Extra guest nights: ${pcNumber(then.added)} → ${pcNumber(now.added)}`,
    `- Total guest nights: ${pcNumber(then.total)} → ${pcNumber(now.total)}`, '');
  const difference = Math.round(now.total - then.total);
  lines.push(difference > 0 ? `That is about ${pcNumber(difference)} more guest nights than the earlier result.`
    : difference < 0 ? `That is about ${pcNumber(-difference)} fewer guest nights than the earlier result.` : 'Guest nights are about the same as the earlier result.');
  if (!first && history.first && Number(history.count) > 2) lines.push('Ask “Compare with my first result” to compare with where you started.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// News and events: upcoming events, forecasts, measured past editions and news.
// The controller passes plain data (extras.events); every line is one sentence.
const PC_EVENT_NAMES = [
  ['f1', /\b(?:f1|formula ?(?:1|one)|grand prix|yas marina)\b/],
  ['adipec', /\badipec\b/],
  ['idex', /\b(?:idex|navdex|defen[cs]e exhibition)\b/],
  ['adibf', /\b(?:book fair|adibf)\b/],
];
const PC_EVENT_CONTROL = /\bevent (?:uplift|control|increase|demand|slider|setting)\b|\bevent or season\b/;
const PC_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function pcEventLines(item) {
  const lines = [];
  if (!item.upcoming) {
    lines.push(`Next edition of ${item.name}: dates not announced yet.`);
    if (item.effect) {
      lines.push(`Usual effect: ${item.effect.mean} international guest nights on event nights.`);
      lines.push(`Past editions ranged from ${item.effect.low} to ${item.effect.high}.`);
      lines.push(`Based on ${item.effect.years.length} past editions: ${item.effect.years.join(', ')}.`);
    }
    return lines;
  }
  lines.push(`Next edition of ${item.name}: ${item.upcoming.dates}.`);
  const f = item.forecast;
  if (!f) {
    lines.push(item.effect ? 'The normal level for these dates is not in the supplied guest-night data, so no forecast is shown.'
      : `There are not enough measured past editions to forecast this event yet (at least ${item.minEditions} are needed).`);
    return lines;
  }
  lines.push(f.perNight >= 0 ? `About ${pcNumber(f.perNight)} more international hotel guests each night` : `About ${pcNumber(-f.perNight)} fewer international hotel guests each night`);
  lines.push(f.extraNights >= 0 ? `About ${pcNumber(f.extraNights)} extra guest nights over ${f.nights} nights.` : `About ${pcNumber(-f.extraNights)} fewer guest nights over ${f.nights} nights.`);
  lines.push(`Past editions ranged from ${f.low} to ${f.high} guests a night.`);
  lines.push(`Based on ${item.effect.years.length} past editions: ${item.effect.years.join(', ')}.`);
  if (item.effect.domestic) {
    lines.push(item.effect.domesticFell ? `UAE-resident hotel guests usually fell during this event (${item.effect.domestic} on average).`
      : `UAE-resident hotel guests also rose during this event (${item.effect.domestic} on average).`);
  }
  if (f.applyPercent >= 1) lines.push('Use Apply to plan on the event in News and events to add it to your plan.');
  return lines;
}

function pcEventPastLines(item) {
  const lines = [`Measured past editions of ${item.name}:`];
  for (const row of item.rows.filter((entry) => entry.status !== 'upcoming')) {
    lines.push(row.pct ? `- ${row.year}: ${row.pct} international guest nights on event nights` : `- ${row.year}: not measured`);
  }
  if (item.effect?.domestic) {
    lines.push(item.effect.domesticFell ? `UAE-resident hotel guests usually fell during this event (${item.effect.domestic} on average).`
      : `UAE-resident hotel guests also rose during this event (${item.effect.domestic} on average).`);
  }
  lines.push('Open News and events, then Past events, for the details.');
  return lines;
}

/** Exported for tests: replies about events and news, or null when the question is about something else. */
export function pcEventsReply(lower, events) {
  if (!events || PC_EVENT_CONTROL.test(lower)) return null;
  const named = PC_EVENT_NAMES.find(([, pattern]) => pattern.test(lower))?.[0];
  const item = named ? events.items.find((entry) => entry.id === named) : null;
  if (/\b(?:news|articles?|headlines?|announcements?|press)\b/.test(lower)) {
    const mentions = (name) => new RegExp(`\\b${pcEscapePattern(name.toLowerCase())}\\b`).test(lower);
    const country = events.countries.find(mentions);
    // A country with no news in the list gets a clear answer, not the whole list.
    const other = !country && !item ? (events.knownCountries || []).find(mentions) : null;
    if (other) return `I found no news about ${other} in the team’s list.`;
    const topic = /\b(?:flights?|airlines?|routes?|etihad|aviation)\b/.test(lower) ? 'flights'
      : /\b(?:tourism|tourists?|visitors?|hotels?)\b/.test(lower) ? 'tourism' : null;
    const label = item ? item.name : country || (topic === 'flights' ? 'Flights' : topic === 'tourism' ? 'Tourism' : null);
    const found = events.news.filter((news) => (!item || news.eventId === item.id) && (!country || news.affects.includes(country))
      && (!topic || item || country || news.topic === topic)).slice(0, 4);
    if (!found.length) return label ? `I found no news about ${label} in the team’s list.` : 'I found no news in the team’s list.';
    const lines = [label ? `Latest news about ${label}:` : 'Latest news:'];
    for (const news of found) lines.push(`- ${news.headline} — ${news.source}, ${news.date}`, news.summary);
    lines.push('Open News and events in the shortcuts to read the full articles.');
    return lines.join('\n');
  }
  if (item) {
    const past = /\b(?:last (?:year|time|edition)|past|previous|history|before|did|affected|impacted|was|were)\b/.test(lower)
      && !/\b(?:forecast|predict|expect|next|upcoming|will|coming)\b/.test(lower);
    return (past ? pcEventPastLines(item) : pcEventLines(item)).join('\n');
  }
  const monthIndex = PC_MONTHS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(lower));
  const asksEvents = /\b(?:events?|exhibitions?|festivals?|conferences?|concerts?)\b/.test(lower)
    && (monthIndex >= 0 || /\b(?:upcoming|coming|next|future|planned|scheduled|soon|calendar|what|which|any|list|show)\b/.test(lower));
  if (!asksEvents) return null;
  const upcoming = events.items.filter((entry) => entry.upcoming && (monthIndex < 0 || entry.upcoming.months.includes(monthIndex + 1)))
    .sort((a, b) => a.upcoming.start.localeCompare(b.upcoming.start));
  const month = monthIndex >= 0 ? PC_MONTHS[monthIndex][0].toUpperCase() + PC_MONTHS[monthIndex].slice(1) : null;
  if (!upcoming.length) {
    return month ? `No upcoming events with announced dates are in the list for ${month}.` : 'No upcoming events with announced dates are in the list.';
  }
  const lines = [month ? `Upcoming events in ${month}:` : 'Upcoming events in Abu Dhabi:'];
  for (const entry of upcoming) lines.push(`- ${entry.name} — ${entry.upcoming.dates}`);
  const unscheduled = events.items.filter((entry) => !entry.upcoming);
  if (!month && unscheduled.length) for (const entry of unscheduled) lines.push(`Next edition of ${entry.name}: dates not announced yet.`);
  lines.push('Ask about one of them, such as “What is the forecast for F1?”, or open News and events in the shortcuts.');
  return lines.join('\n');
}

function pcExtrasReply(text, lower, extras, data, current, result) {
  if (!extras) return null;
  if (extras.history && PC_COMPARE_INTENT.test(lower)) return pcCompareReply(data, lower, current, extras.history);
  if (extras.events) {
    const eventReply = pcEventsReply(lower, extras.events);
    if (eventReply) return eventReply;
  }
  const plain = lower.replace(/[?.!]+$/, '').trim();
  if (/\b(?:graph|graphs|chart|charts|plot|plots|diagram|diagrams|visuals?)\b/.test(lower) && !pcExplicitCommand(text)) return pcChartsReply(lower, extras.where);
  if (extras.missing && /\b(?:missing|left to do|still (?:need|to do|have to)|not (?:done|finished|checked)|haven'?t (?:done|checked|finished)|remaining|incomplete|what else (?:is|do i|should|needs?))\b/.test(lower)) return pcMissingReply(extras.missing);
  if (extras.nextSteps && /\b(?:next steps?|what(?:'s| is) next|what (?:should|do|shall|must) i (?:do|check|verify)(?: next| now| first)?|what to (?:check|do) (?:next|first)|check (?:next|first)|after this|then what|what now|where do i go from here|what comes next|next action)\b/.test(lower)) return pcNextStepsReply(extras.nextSteps);
  if (extras.where && (/\bthis (?:page|tab|view|screen|section|bit|part)\b|\bhow (?:does|do) (?:this|it|that) work\b|\bwhere am i\b/.test(lower)
      || (plain === 'what am i looking at' && pcPageKey(extras.where) !== 'focus'))) return pcPageReply(extras.where, data);
  return null;
}

export function planningChatReply(data, prompt, current, result, proposalSummary = null, extras = null) {
  const text = pcNormalizePrompt(String(prompt || '').trim());
  const lower = text.toLowerCase();
  if (!text) return pcAnswer('Ask about the current plan, or name a value you want to change.');
  if (text.length > 600) return pcAnswer('That message is too long. Please ask one short question at a time.');
  const extra = pcExtrasReply(text, lower, extras, data, current, result);
  if (extra) return pcAnswer(extra);
  const whatIf = pcWhatIfReply(data, text, lower, current);
  if (whatIf) return pcAnswer(whatIf);
  const place = pcPlaceReply(lower);
  if (place) return pcAnswer(place);
  const guide = pcGuideReply(data, text, current, result);
  if (guide) return pcAnswer(guide);
  if (/^(?:please\s+)?(?:reset(?:\s+(?:(?:the|my|this)\s+)?(?:plan|scenario))?|start over)[.!]?$/i.test(text)) return assistantReply(data, 'reset', current, result);
  if (PC_WHATIF_INTENT.test(lower)) return pcAnswer('Tell me the final value to try, such as “What if flight occupancy is 80%?”, and I will work it out without changing your plan.');
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
  if (/\b(?:assumptions?|inputs?|starting values)\b/.test(lower) && !/\b(?:why|comparison|peer|country)\b/.test(lower)) return pcAnswer(`The current proposal is ${result.route.origin} in ${data.months[current.month - 1]}.\n\n- Flights: ${pcNumber(current.extraFlights, 2)} extra each week, about ${pcNumber(current.seatsPerFlight)} seats per flight, ${pcNumber(current.loadFactor * 100, 1)}% full.\n- Visitors: ${pcNumber(current.p2pShare * 100, 1)}% end their trip here; ${pcNumber(current.conversionRate * 100, 1)}% of those use hotels.\n- Stay: ${pcNumber(current.averageStay, 2)} nights on average; event uplift ${pcNumber((current.eventUplift || 0) * 100, 1)}%. These are planning assumptions. See Details for the calculation and source records.`);
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
