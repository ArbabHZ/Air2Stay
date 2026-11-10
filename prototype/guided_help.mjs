/** Local learning, feedback and opt-in usage counts. No network requests. */
const ghStorageKey = "air2stay.guided-help.v1";
const ghMaxFeedback = 100;
const ghMonths = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ghEvents = Object.freeze({
  view_focus: "Focus opened", view_details: "Details opened", view_chat: "Chat opened", view_compare: "Compare opened", view_actions: "Proposal actions opened",
  scenario_change: "Plan adjusted", assistant_question: "Chat question sent", export_csv: "Spreadsheet exported", export_json: "Full plan exported", export_decision: "Decision note exported",
  proposal_save: "Proposal saved", proposal_comment: "Proposal comment added", proposal_task: "Proposal action updated", proposal_draft: "Stakeholder update drafted", proposal_restore: "Proposal version restored",
  "view:focus": "Focus opened", "view:decisions": "Compare opened", "view:details": "Details opened", "view:chat": "Chat opened",
  "view:scenarioView": "Plan a route opened", "view:bridgeView": "Visitor mix opened", "view:validationView": "Past results opened", "view:glossaryView": "Term guide opened", "view:helpView": "Help opened", "view:proposalView": "Proposal workspace opened",
  "chat:send": "Chat question sent", "scenario:change": "Plan adjusted", "scenario:new-route": "New country confirmed", "export:plan": "Plan exported", "export:decision": "Decision note exported",
  "help:search": "Help searched", "help:answer": "Help answer opened", "help:resource": "Reference document opened", "feedback:submitted": "Feedback submitted",
  "guide:first-plan:start": "First plan guide started", "guide:first-plan:complete": "First plan guide completed", "guide:first-plan:exit": "First plan guide exited early",
  "guide:new-route:start": "New route guide started", "guide:new-route:complete": "New route guide completed", "guide:new-route:exit": "New route guide exited early",
  "guide:results:start": "Results guide started", "guide:results:complete": "Results guide completed", "guide:results:exit": "Results guide exited early",
  "guide:compare:start": "Comparison guide started", "guide:compare:complete": "Comparison guide completed", "guide:compare:exit": "Comparison guide exited early",
  "guide:actions:start": "Proposal actions guide started", "guide:actions:complete": "Proposal actions guide completed", "guide:actions:exit": "Proposal actions guide exited early",
});

const ghAnswers = [
  ["How do I create a new route?", "Choose + New route under Departure country, then choose and confirm the country.", "new country confirm comparison market", false, "market"],
  ["What does the baseline mean?", "", "historical original zero impact", false, "baseline"],
  ["What is a guest night?", "", "hotel nights room capacity stay", false, "terms"],
  ["How are hotel nights worked out?", "", "formula calculation conversion load factor p2p", false, "calculation"],
  ["Why these comparison countries?", "", "peer blend new route starting proxy", false, "peers"],
  ["What does Matching past records mean?", "", "confidence several low high support", false, "baseline"],
  ["What does the possible range mean?", "", "p10 p50 p90 uncertainty cautious", false, "range"],
  ["What did the accuracy score test?", "", "validation weighted error wape holdout measured", false, "validation"],
  ["What does Compare help me decide?", "", "launch stress target capacity decision", false, "compare"],
  ["What are the event and travel-purpose controls?", "", "seasonal uplift holidays family business mixed", false, "events"],
  ["What does Visitor mix show?", "", "nationality bridge shares passengers", false, "mix"],
  ["What should I verify before acting?", "", "next steps priority hotel capacity airline planner evidence", false, "followups"],
  ["What can I ask Air2Stay?", "Ask how the current estimate was calculated, what changed, or what to check next. You can also request a country, month or flight change, such as “Add 3 flights from France in December”. Check the values the app actually applied; use the controls for other assumptions.", "ai chat assistant smart question change", true],
  ["Where can I keep or share a result?", "", "export csv json communication comments followup", false, "export"],
  ["What do red, amber and green mean?", "", "rag priority actions traffic lights risk checks", false, "followups"],
  ["Will assigning an action notify my teammate?", "", "communication followups owner pending notifications", false, "privacy"],
];

const ghStep = (title, text, selector, mode = "focus", extra = {}) => ({ title, text, selector, view: "scenarioView", mode, ...extra });
const ghReferences = {
  market: ghStep("Open market controls →", "", "#origin", "focus", { controls: true }),
  baseline: ghStep("See the baseline and record coverage →", "", "#dataNote"),
  terms: { title: "Open Term Guide →", view: "glossaryView", selector: "#glossarySearch" },
  calculation: ghStep("Open the calculation →", "", "#calculationExplanation", "details"),
  peers: ghStep("See the comparison countries in Details →", "", "#peerEvidenceBlock", "details", { fallback: "#calculationExplanation" }),
  range: ghStep("See how the range is estimated →", "", "#calculationExplanation", "details"),
  validation: { title: "Open historical validation results →", view: "validationView", selector: "#validationScope" },
  compare: ghStep("Open Compare →", "", "#planningDecision", "decisions"),
  events: ghStep("Open event controls →", "", "#eventImpactGroup", "focus", { controls: true }),
  mix: { title: "Open Visitor Mix →", view: "bridgeView", selector: "#bridgeMethod > summary" },
  followups: ghStep("Open follow-ups →", "", "#pwChecksHeading", "proposal"),
  export: ghStep("Open Export →", "", ".export-menu > summary"),
  privacy: { title: "Read the privacy and sharing guidance →", view: "glossaryView", selector: "#privacyLimits" },
};
const ghGuides = [
  { id: "first-plan", title: "Create your first plan", description: "Choose a market, change capacity and read the effect.", steps: [
    ghStep("Choose the departure market", "Choose the country your flights would leave from. This guide points out the controls; it will not change your plan for you.", "#origin", "focus", { controls: true }),
    ghStep("Choose the month", "Choose the month you want to investigate. The starting values use the available records for that country and month.", "#month", "focus", { controls: true }),
    ghStep("Set the extra flights", "Add or remove weekly flights. Check seats per flight and flight fullness too. Zero extra flights does not mean zero impact if you have changed other assumptions.", "#extraFlights", "focus", { controls: true }),
    ghStep("Read the result", "Read the cards, then adjust one control to see how the estimate responds.", "#kpis"),
    ghStep("Decide what to check", "Review the estimated extra hotel nights, the assumption that matters most and the airline or hotel checks to complete before acting.", "#planningDecision", "decisions"),
  ] },
  { id: "new-route", title: "Explore a new country", description: "Understand confirmation and comparison-country assumptions.", steps: [
    ghStep("Choose + New route", "Open Departure country and choose + New route. This reveals the new-country field. The guide does not select a country for you.", "#origin", "focus", { controls: true }),
    ghStep("Choose and confirm a country", "Type or choose a country from the list, then press Confirm country. Suggestions are starting assumptions, not evidence of demand. If the field is not visible, choose + New route first.", "#newMarketCountry", "focus", { controls: true, fallback: "#origin" }),
    ghStep("Set a proposed schedule", "Choose the flights and seats you want to test. A new route starts from zero recorded seats; comparison countries supply adjustable assumptions.", "#extraFlights", "focus", { controls: true }),
    ghStep("Inspect the comparison countries", "Details explains which countries were used and why. Check the weights and limitations. If you kept an existing route, this section may not be shown.", "#peerEvidenceBlock", "details", { fallback: "#calculationExplanation" }),
    ghStep("Compare an alternative", "Compare the proposal with adding flights on an existing route. Check that both options use assumptions you can justify before preferring one.", "#alternativeOrigin", "decisions"),
  ] },
  { id: "results", title: "Understand the numbers", description: "Trace estimates, evidence and uncertainty.", steps: [
    ghStep("Read the baseline label", "Read the baseline note before interpreting the changes below.", "#dataNote"),
    ghStep("Open the calculation", "Expand the calculation sections to see the starting values and each multiplication. Displayed values may be rounded; the calculation retains the underlying precision.", "#calculationExplanation", "details"),
    ghStep("Test what matters", "Use the longest bar to find the input to investigate first.", "#sensitivityBars", "details"),
    ghStep("Understand the accuracy test", "Open the method notes for the training and test periods.", "#validationSummary", "focus", { view: "validationView" }),
  ] },
  { id: "compare", title: "Prepare a planning decision", description: "Compare routes, test a weaker outcome and export a note.", steps: [
    ghStep("Choose an alternative route", "Select the existing route to compare. Read which assumptions are shared. Identical inputs can produce identical added-seat effects; that is expected.", "#alternativeOrigin", "decisions"),
    ghStep("Compare launch sizes", "These options vary the number of weekly flights. Cautious, standard and expanded describe capacity, not the likelihood of demand.", "#launchOptions", "decisions"),
    ghStep("Test a weaker outcome", "Lower flight fullness, hotel use and stay length to see how the estimate changes. These are hypothetical stress trials.", "#stressChart", "decisions"),
    ghStep("Work backwards from a target", "Enter a hotel-night target to see the capacity implied by your assumptions. It does not prove enough passengers will book.", "#targetGuestNights", "decisions"),
    ghStep("Review and export the note", "Keep the estimated impact, key assumptions and next checks together. Review the note before sharing it with an airline, hotel or colleague.", "#planningDecision", "decisions"),
  ] },
  { id: "actions", title: "Follow up a proposal", description: "Record checks, evidence, discussion and stakeholder drafts.", steps: [
    ghStep("Read the priority checks", "Choose a check to see what needs to be confirmed.", "#proposalWorkspace .pw-priorities", "proposal", { fallback: "#proposalWorkspace" }),
    ghStep("Add a task", "Use Add task on the check you want to follow up.", "#proposalWorkspace .pw-priorities", "proposal"),
    ghStep("Assign and track the check", "Give the action a clear question, owner and due date. Update its status as responses arrive. Record the source, date and what was confirmed before marking it verified.", '#proposalWorkspace [data-pw-form="task"]', "proposal"),
    ghStep("Keep a proposal version", "Save the assumptions and result when you reach a useful milestone. Comments and decisions remain with this country and month. Download local history before clearing your browser.", '#proposalWorkspace [data-pw-form="version"]', "proposal"),
    ghStep("Review a stakeholder draft", "Prepare an airline inquiry, hotel request or team summary from the proposal. Edit and review it before copying or downloading. Nothing is sent automatically.", "#proposalWorkspace .pw-drafts", "proposal"),
  ] },
];

const ghEscapeHtml = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const ghNormalize = value => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const ghCleanId = value => String(value || "general").replace(/[^a-zA-Z0-9_:-]/g, "").slice(0, 80) || "general";
const ghSafeUrl = value => {
  // The wrapper supplies only reviewed local files as base64 downloads.
  if (/^data:(?:text\/html|application\/pdf|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
  try {
    const base = window.location.protocol === "about:" ? window.parent.location.href : window.location.href;
    const url = new URL(value, base);
    return ["http:", "https:"].includes(url.protocol) && url.origin === new URL(base).origin ? url.href : null;
  } catch { return null; }
};

export function createGuidedHelp({ mount, getContext = () => ({}), navigate, chatEnabled = false } = {}) {
  if (typeof mount === "string") mount = document.querySelector(mount);
  if (!mount) throw new Error("Guided help needs a mount element.");
  let storageAvailable = true;
  let context = getContext() || {};
  let state = { version: 1, optedIn: false, counts: {}, feedback: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(ghStorageKey) || "null");
    if (raw?.version === 1) {
      state.optedIn = raw.optedIn === true;
      for (const [key, value] of Object.entries(raw.counts || {})) if (Object.hasOwn(ghEvents, key) && Number.isSafeInteger(value) && value >= 0) state.counts[key] = value;
      state.feedback = Array.isArray(raw.feedback) ? raw.feedback.filter(item => item && ["helpful", "not-helpful", "problem"].includes(item.rating) && typeof item.subject === "string" && typeof item.createdAt === "string").slice(-ghMaxFeedback).map(item => ({ id: ghCleanId(item.id), subject: item.subject.slice(0, 150), rating: item.rating, message: String(item.message || "").slice(0, 1500), createdAt: item.createdAt })) : [];
    }
  } catch { storageAvailable = false; }
  let activeGuide = null;
  let guideIndex = 0;
  let highlighted = null;
  let guideTrigger = null;
  let guideRenderToken = 0;
  let feedbackReturnFocus = null;
  let feedbackSubject = { id: "general", label: "Air2Stay" };
  let renderedAssetSource;
  let destroyed = false;
  const tooltipElements = [];
  for (const [selector, description] of [
    ["#loadFactor", "Flight fullness: the percentage of seats expected to have a passenger. This is an assumption you can adjust."],
    ["#p2pShare", "Trip-ending share: passengers ending their air journey in Abu Dhabi, rather than connecting to another flight."],
    ["#conversionRate", "Hotel use: the assumed share of trip-ending passengers who check into a hotel. It is not directly measured for each proposed route."],
    ["#averageStay", "Average nights per hotel guest. Guest nights are different from occupied rooms because people may share a room."],
    ["#eventUplift", "A demand increase you assume for an event or season. It is not a measured effect from event data."],
    ["#routePurpose", "Choosing a purpose labels the proposal; it does not change results until separate assumptions are applied."],
    ["#sameComparisonAssumptions", "Use the same inputs to isolate the effect of added capacity. Identical inputs may give identical added-seat effects."],
    ["#allowAi", "Optional online AI. Enabling it sends your question, recent chat and selected proposal context to Gemini."],
  ]) {
    const element = document.querySelector(selector);
    if (element && !element.hasAttribute("title")) {
      element.title = description;
      const hadDescription = element.hasAttribute("aria-description");
      if (!hadDescription) element.setAttribute("aria-description", description);
      tooltipElements.push({ element, description, hadDescription });
    }
  }
  const root = document.createElement("div");
  root.className = "gh-hub";
  root.innerHTML = `
    <div class="gh-close-row"><span>Air2Stay · Help & learning</span><button type="button" data-gh-close>Close help</button></div>
    <header class="gh-intro"><p class="gh-eyebrow">Help & learning</p><h1 id="gh-help-title">Plan with confidence in what the numbers mean</h1><p>Short guides, plain-language answers and the evidence behind your proposal.</p><p class="gh-context" data-gh-context></p></header>
    <p class="gh-storage-warning" data-gh-storage role="status" hidden></p>
    <section class="gh-section" aria-label="Search help"><label class="gh-search-label">Find an answer<input type="search" data-gh-search placeholder="Try: new route, hotel nights or accuracy" autocomplete="off"></label><p data-gh-count class="gh-small" role="status"></p><div data-gh-answers class="gh-answers"></div></section>
    <section class="gh-section"><h2>Guide me</h2><p>Follow the real controls. Guides move between pages and highlight the next step, without changing your numbers.</p><div class="gh-guide-grid">${ghGuides.map(guide => `<article class="gh-guide-card"><h3>${ghEscapeHtml(guide.title)}</h3><p>${ghEscapeHtml(guide.description)}</p><button type="button" data-gh-guide="${guide.id}">Start guide <span class="gh-small">· ${guide.steps.length} steps</span></button></article>`).join("")}</div></section>
    ${chatEnabled ? `<section class="gh-section gh-ai"><p class="gh-eyebrow">AI in Air2Stay</p><h2>A guide to your plan, with limits</h2><div class="gh-two-column"><div><h3>What it can help with</h3><p>In Chat, ask about the current proposal, request a supported change or ask what to investigate next. Answers should explain the assumptions and the values the app actually applied.</p><button type="button" data-gh-chat>Open Chat</button></div><div><h3>What supports an answer</h3><p>The current plan, the app’s calculations, supplied records and documented assumptions. The calculation engine works out the numbers. AI wording is not new evidence, a booking forecast or approval to act.</p></div></div><details><summary>What is sent, and what should I check?</summary><p>Online AI is off at the start of each session. If you allow it in Chat, Gemini receives your question, recent chat, proposal assumptions and action statuses. Proposal comments and supporting evidence notes are not included. Built-in help and calculations do not need online AI.</p><p>Avoid adding API keys, passenger details or confidential business information to a question. Read the current values after a requested change. Verify important claims against Details and the supplied records. If the AI service is unavailable, use the controls and built-in explanations.</p></details></section>` : ''}
    <section class="gh-section"><h2>Reference documents & usage guidance</h2><div data-gh-assets class="gh-assets"></div><div class="gh-two-column"><div><h3>Use the result responsibly</h3><p>Use Compare to prepare a decision note.</p><button type="button" data-gh-terms>Open term guide</button></div><div><h3>Local data & privacy</h3><p>Feedback and optional usage counts on this page stay in this browser. They are not shared with a team or sent to an analytics service. Browser clearing can erase them. This is usage guidance, not an organisation’s formal policy.</p></div></div></section>
    <section class="gh-section"><h2>Help improve Air2Stay</h2><p>Mark an answer or recommendation as helpful, or record a problem. The latest 100 feedback entries stay on this browser only; they are not support tickets.</p><button type="button" data-gh-report>Report a problem</button><details class="gh-feedback-history"><summary>Feedback saved in this browser <span data-gh-feedback-count></span></summary><div data-gh-feedback-list></div><button type="button" data-gh-clear-feedback class="gh-quiet">Clear local feedback</button></details></section>
    <section class="gh-section"><h2>Usage insights</h2><p>See which features and guides are used on this browser. Counts cannot represent all users or explain why someone stopped a guide.</p><label class="gh-checkbox"><input type="checkbox" data-gh-optin><span>Allow local feature counts on this browser</span></label><p class="gh-small">Off by default. When enabled, only fixed feature names and counts are saved. Search words, questions, answers, proposal values and identities are not recorded here. Turning it off stops new counts; clearing removes existing counts.</p><div data-gh-insights></div><button type="button" data-gh-clear-counts class="gh-quiet">Clear usage counts</button><p data-gh-insight-status class="gh-small" role="status"></p></section>`;
  const helpDialog = document.createElement("dialog");
  helpDialog.className = "gh-shell";
  helpDialog.setAttribute("aria-labelledby", "gh-help-title");
  helpDialog.append(root); mount.append(helpDialog);
  let helpReturnFocus = null;
  const $ = selector => root.querySelector(selector);
  const guidePanel = document.createElement("section");
  guidePanel.className = "gh-tour"; guidePanel.hidden = true;
  guidePanel.setAttribute("role", "dialog"); guidePanel.setAttribute("aria-label", "Air2Stay guided walkthrough"); guidePanel.setAttribute("aria-modal", "false");
  document.body.append(guidePanel);
  const spotlight = document.createElement("div");
  spotlight.className = "gh-spotlight"; spotlight.hidden = true;
  spotlight.setAttribute("aria-hidden", "true");
  document.body.append(spotlight);
  function positionSpotlight() {
    if (!activeGuide || !highlighted) { spotlight.hidden = true; return; }
    if (!highlighted.isConnected) {
      highlighted = document.querySelector(activeGuide.steps[guideIndex].selector);
      highlighted?.classList.add("gh-highlight");
    }
    if (!highlighted || !highlighted.getClientRects().length) { spotlight.hidden = true; return; }
    const rect = highlighted.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = window.innerHeight;
    // Place the explanation in the nearest space outside the highlighted item.
    const margin = 12, gap = 18;
    const roomRight = width - rect.right - gap - margin;
    const roomLeft = rect.left - gap - margin;
    const roomBelow = height - rect.bottom - gap - margin;
    const roomAbove = rect.top - gap - margin;
    const side = roomRight >= 280 ? "right" : roomLeft >= 280 ? "left"
      : roomBelow >= roomAbove ? "below" : "above";
    const beside = side === "right" || side === "left";
    const panelWidth = Math.min(360, beside ? (side === "right" ? roomRight : roomLeft) : width - margin * 2);
    const availableHeight = beside ? height - margin * 2 : Math.max(150, side === "below" ? roomBelow : roomAbove);
    guidePanel.style.width = `${panelWidth}px`;
    guidePanel.style.maxHeight = `${Math.min(availableHeight, height - margin * 2)}px`;
    const panelHeight = guidePanel.getBoundingClientRect().height;
    const x = side === "right" ? rect.right + gap : side === "left" ? rect.left - gap - panelWidth
      : rect.left + rect.width / 2 - panelWidth / 2;
    const y = side === "below" ? rect.bottom + gap : side === "above" ? rect.top - gap - panelHeight
      : rect.top + rect.height / 2 - panelHeight / 2;
    guidePanel.style.left = `${Math.max(margin, Math.min(width - panelWidth - margin, x))}px`;
    guidePanel.style.top = `${Math.max(margin, Math.min(height - panelHeight - margin, y))}px`;
    guidePanel.style.right = "auto";
    guidePanel.style.bottom = "auto";
    const left = Math.max(0, rect.left - 8), top = Math.max(0, rect.top - 8);
    const right = Math.min(width, rect.right + 8), bottom = Math.min(height, rect.bottom + 8);
    spotlight.style.clipPath = right > left && bottom > top
      ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${left}px ${bottom}px, ${right}px ${bottom}px, ${right}px ${top}px, ${left}px ${top}px)`
      : "none";
    spotlight.hidden = false;
  }
  document.addEventListener("scroll", positionSpotlight, true);
  window.addEventListener?.("resize", positionSpotlight);
  const feedbackDialog = document.createElement("dialog");
  feedbackDialog.className = "gh-feedback-dialog";
  feedbackDialog.innerHTML = `<form method="dialog" class="gh-feedback-form"><h2>Report a problem</h2><p data-gh-subject></p><label>What happened?<textarea data-gh-message rows="5" maxlength="1500" required placeholder="Describe what you expected and what happened. Avoid personal or confidential details."></textarea></label><p class="gh-small">Saved in this browser only. No message is sent to anyone.</p><p data-gh-feedback-status role="status"></p><div class="gh-dialog-actions"><button type="button" data-gh-cancel>Cancel</button><button type="submit">Save feedback</button></div></form>`;
  document.body.append(feedbackDialog);

  function showStorageWarning() {
    const notice = $("[data-gh-storage]");
    notice.hidden = storageAvailable;
    notice.textContent = "Browser storage is unavailable. Feedback and counts can be shown for this visit, but may be lost when the page closes. Export your important proposal notes separately.";
  }
  function save() {
    try { localStorage.setItem(ghStorageKey, JSON.stringify(state)); storageAvailable = true; }
    catch { storageAvailable = false; }
    showStorageWarning();
    return storageAvailable;
  }
  function track(name) {
    if (destroyed || !state.optedIn || !Object.hasOwn(ghEvents, name)) return;
    state.counts[name] = Math.min(Number.MAX_SAFE_INTEGER, (state.counts[name] || 0) + 1);
    save(); renderInsights();
  }
  function renderInsights() {
    const rows = Object.entries(state.counts).filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]);
    $("[data-gh-optin]").checked = state.optedIn;
    $("[data-gh-insights]").innerHTML = rows.length ? `<ul class="gh-count-list">${rows.map(([name, count]) => `<li><span>${ghEscapeHtml(ghEvents[name])}</span><strong>${count.toLocaleString()}</strong></li>`).join("")}</ul>` : `<p class="gh-empty">${state.optedIn ? "No feature counts yet. Use a guide or another feature to begin." : "Feature counting is off. Nothing is tracked by this panel until you turn it on."}</p>`;
  }
  function renderAnswers(query = "") {
    const words = ghNormalize(query).split(/\s+/).filter(Boolean);
    const matches = ghAnswers.filter(([title, answer, tags, requiresChat]) =>
      (!requiresChat || chatEnabled) && words.every(word => ghNormalize(`${title} ${answer} ${tags}`).includes(word)));
    $("[data-gh-count]").textContent = `${matches.length} ${matches.length === 1 ? "answer" : "answers"}${query.trim() ? " found" : " available"}`;
    $("[data-gh-answers]").innerHTML = matches.length ? matches.map(([title, answer, , , reference]) => `<details${words.length ? " open" : ""}><summary>${ghEscapeHtml(title)}</summary>${answer ? `<p>${ghEscapeHtml(answer)}</p>` : ""}${reference ? `<button type="button" class="text-action" data-gh-reference="${reference}">${ghReferences[reference].title}</button>` : ""}</details>`).join("") : `<p class="gh-empty">No matching answer. Try a shorter term, such as “route”, “nights” or “accuracy”.</p>`;
    $("[data-gh-answers]").querySelectorAll("[data-gh-reference]").forEach(button =>
      button.addEventListener("click", () => openReference(ghReferences[button.dataset.ghReference])));
    $("[data-gh-answers]").querySelectorAll("summary").forEach(item => item.addEventListener("click", () => { if (!item.parentElement.open) track("help:answer"); }));
  }
  function renderAssets() {
    const source = window.__AIR2STAY_HELP_ASSETS__ || null;
    if (renderedAssetSource === source) return;
    renderedAssetSource = source;
    const assets = Array.isArray(source) ? source : [];
    const valid = assets.map(asset => ({ name: String(asset?.name || "Reference document"), filename: String(asset?.filename || "reference-document").replace(/[/\\]/g, "_").slice(0, 150), url: typeof asset?.url === "string" ? ghSafeUrl(asset.url) : null })).filter(asset => asset.url);
    $("[data-gh-assets]").innerHTML = valid.length ? valid.map(asset => `<a class="gh-resource" href="${ghEscapeHtml(asset.url)}" ${asset.url.startsWith("data:") ? `download="${ghEscapeHtml(asset.filename)}"` : 'target="_blank" rel="noopener noreferrer"'}>${ghEscapeHtml(asset.name)} <span aria-hidden="true">${asset.url.startsWith("data:") ? "↓" : "↗"}</span><span class="gh-sr-only"> (${asset.url.startsWith("data:") ? "download" : "opens in a new tab"})</span></a>`).join("") : `<p class="gh-empty">Reference document downloads are unavailable in this copy.</p>`;
    $("[data-gh-assets]").querySelectorAll("a").forEach(link => link.addEventListener("click", () => track("help:resource")));
  }
  function renderFeedback() {
    $("[data-gh-feedback-count]").textContent = `(${state.feedback.length})`;
    $("[data-gh-feedback-list]").innerHTML = state.feedback.length ? `<ul class="gh-feedback-list">${state.feedback.slice().reverse().map(item => `<li><strong>${ghEscapeHtml(item.subject)}</strong><span>${item.rating === "helpful" ? "Helpful" : item.rating === "not-helpful" ? "Not helpful" : "Problem reported"} · ${ghEscapeHtml(item.createdAt.slice(0, 10))}</span>${item.message ? `<p>${ghEscapeHtml(item.message)}</p>` : ""}</li>`).join("")}</ul>` : `<p class="gh-empty">No feedback saved yet.</p>`;
  }
  function recordFeedback(subject, rating, message = "") {
    const id = ghCleanId(subject.id);
    if (rating !== "problem") {
      const previous = state.feedback.find(item => item.id === id && item.rating !== "problem");
      if (previous?.rating === rating) return storageAvailable;
      state.feedback = state.feedback.filter(item => item.id !== id || item.rating === "problem");
    }
    state.feedback.push({ id, subject: String(subject.label || "Air2Stay").slice(0, 150), rating, message: message.slice(0, 1500), createdAt: new Date().toISOString() });
    state.feedback = state.feedback.slice(-ghMaxFeedback);
    const persisted = save(); renderFeedback(); track("feedback:submitted");
    return persisted;
  }
  function openFeedback(subject = { id: "general", label: "Air2Stay" }) {
    feedbackSubject = subject; feedbackReturnFocus = document.activeElement;
    feedbackDialog.querySelector("[data-gh-subject]").textContent = `About: ${subject.label || "Air2Stay"}`;
    feedbackDialog.querySelector("[data-gh-message]").value = "";
    feedbackDialog.querySelector("[data-gh-feedback-status]").textContent = "";
    feedbackDialog.querySelector("[data-gh-cancel]").textContent = "Cancel";
    if (!feedbackDialog.open) feedbackDialog.showModal();
    feedbackDialog.querySelector("textarea").focus();
  }
  function closeFeedback() { feedbackDialog.close(); if (feedbackReturnFocus?.isConnected) feedbackReturnFocus.focus({ preventScroll: true }); }
  function addFeedback(target) {
    if (typeof target === "string") { openFeedback({ id: ghCleanId(target), label: target }); return null; }
    const config = target instanceof Element ? { element: target, id: target.dataset.feedbackId || "answer", label: "Air2Stay answer" } : target || {};
    const element = typeof config.element === "string" ? document.querySelector(config.element) : config.element;
    if (!element) return null;
    if (element.querySelector(":scope > .gh-inline-feedback")) return element.querySelector(":scope > .gh-inline-feedback");
    const subject = { id: ghCleanId(config.id), label: String(config.label || "Air2Stay answer").slice(0, 150) };
    const bar = document.createElement("div"); bar.className = "gh-inline-feedback";
    bar.setAttribute("role", "group"); bar.setAttribute("aria-label", `Feedback on ${subject.label}`);
    bar.innerHTML = `<span>Was this useful?</span><button type="button" data-gh-rating="helpful" aria-pressed="false">Helpful</button><button type="button" data-gh-rating="not-helpful" aria-pressed="false">Not helpful</button><button type="button" data-gh-problem>Report problem</button><small role="status" data-gh-vote-status></small>`;
    const savedVote = state.feedback.slice().reverse().find(item => item.id === subject.id && item.rating !== "problem");
    if (savedVote) {
      bar.querySelectorAll("[data-gh-rating]").forEach(button => { button.disabled = true; button.setAttribute("aria-pressed", String(button.dataset.ghRating === savedVote.rating)); });
      bar.querySelector("[data-gh-vote-status]").textContent = storageAvailable ? "Your feedback is saved on this browser." : "Your feedback is recorded for this visit only; browser storage is unavailable.";
    }
    bar.querySelectorAll("[data-gh-rating]").forEach(button => button.addEventListener("click", () => {
      if (button.disabled) return;
      const persisted = recordFeedback(subject, button.dataset.ghRating);
      bar.querySelectorAll("[data-gh-rating]").forEach(other => { other.disabled = true; other.setAttribute("aria-pressed", String(other === button)); });
      bar.querySelector("[data-gh-vote-status]").textContent = persisted ? "Saved on this browser only." : "Recorded for this visit only. Browser storage failed; this feedback may be lost when you close the page.";
    }));
    bar.querySelector("[data-gh-problem]").addEventListener("click", () => openFeedback(subject));
    element.append(bar); return bar;
  }
  async function go(destination) {
    close(false);
    if (navigate) await navigate(destination);
    else {
      document.querySelector(`.nav-tab[data-view="${destination.view}"]`)?.click();
      if (destination.view === "scenarioView") document.querySelector(`.view-mode[data-mode="${destination.mode || "focus"}"]`)?.click();
    }
    const controls = document.querySelector("#adjustControls");
    if (controls && document.body.classList.contains("controls-open") !== Boolean(destination.controls)) controls.click();
  }
  async function openReference(destination) {
    await go(destination);
    let target = document.querySelector(destination.selector);
    if (!target || target.closest("[hidden]")) target = destination.fallback ? document.querySelector(destination.fallback) : null;
    if (!target) return;
    for (let details = target.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
    if (!target.matches("a, button, summary, input, select")) target.tabIndex = -1;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "start" });
  }
  function clearHighlight() { if (highlighted) highlighted.classList.remove("gh-highlight"); highlighted = null; spotlight.hidden = true; }
  async function showGuideStep() {
    const token = ++guideRenderToken;
    const current = activeGuide.steps[guideIndex];
    clearHighlight();
    guidePanel.hidden = false;
    guidePanel.innerHTML = `<div class="gh-tour-heading"><span>${ghEscapeHtml(activeGuide.title)} · ${guideIndex + 1} of ${activeGuide.steps.length}</span><button type="button" data-gh-exit aria-label="Exit guide">Exit</button></div><h2 tabindex="-1">${ghEscapeHtml(current.title)}</h2><p>${ghEscapeHtml(current.text)}</p><p data-gh-target-status class="gh-small" role="status"></p><div class="gh-tour-actions"><button type="button" data-gh-back${guideIndex === 0 ? " disabled" : ""}>Back</button><button type="button" data-gh-next>${guideIndex === activeGuide.steps.length - 1 ? "Finish" : "Next"}</button></div>`;
    guidePanel.querySelector("[data-gh-exit]").addEventListener("click", () => endGuide(false));
    guidePanel.querySelector("[data-gh-back]").addEventListener("click", () => { guideIndex--; showGuideStep(); });
    guidePanel.querySelector("[data-gh-next]").addEventListener("click", () => { if (guideIndex === activeGuide.steps.length - 1) endGuide(true); else { guideIndex++; showGuideStep(); } });
    try { await go(current); }
    catch {
      if (token !== guideRenderToken || !activeGuide) return;
      guidePanel.querySelector("[data-gh-target-status]").textContent = "This page could not be opened. Exit the guide and use the page tabs, then try again.";
      guidePanel.querySelector("h2").focus({ preventScroll: true });
      return;
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (token !== guideRenderToken || !activeGuide || destroyed) return;
    let target = document.querySelector(current.selector);
    for (let details = target?.closest("details"); details; details = details.parentElement?.closest("details")) details.open = true;
    if (!target || target.closest("[hidden]") || target.getClientRects().length === 0) target = current.fallback ? document.querySelector(current.fallback) : null;
    if (target && target.getClientRects().length > 0) {
      highlighted = target; target.classList.add("gh-highlight");
      // Keep visible controls where they are: centring every step makes the
      // target and guide look stationary even though the page has moved.
      const bounds = target.getBoundingClientRect();
      if (bounds.top < 120 || bounds.bottom > window.innerHeight - 24 || bounds.left < 8 || bounds.right > document.documentElement.clientWidth - 8) {
        target.scrollIntoView({ behavior: "auto", block: "nearest", inline: "nearest" });
      }
      positionSpotlight();
    } else guidePanel.querySelector("[data-gh-target-status]").textContent = "This control is not visible in the current plan. You can return to the previous step or continue reading the guide.";
    guidePanel.querySelector("h2").focus({ preventScroll: true });
  }
  function endGuide(completed) {
    if (!activeGuide) return;
    track(`guide:${activeGuide.id}:${completed ? "complete" : "exit"}`);
    activeGuide = null; guideRenderToken++; clearHighlight(); guidePanel.hidden = true;
    if (guideTrigger?.isConnected && guideTrigger.getClientRects().length) guideTrigger.focus({ preventScroll: true });
    else document.querySelector("#openGuide")?.focus({ preventScroll: true });
  }
  function update(nextContext) {
    context = nextContext || getContext() || {};
    const inputs = context.inputs || context.state || {};
    const route = context.result?.route;
    const country = route?.origin || inputs.originKey;
    const month = ghMonths[Number(inputs.month) - 1];
    $("[data-gh-context]").textContent = country ? `Help for your current plan: ${String(country).replaceAll("_", " ")}${month ? `, ${month}` : ""}.` : "Guides use your current plan. Your assumptions stay unchanged.";
    renderAssets();
    positionSpotlight();
  }
  function open() {
    if (destroyed) return;
    if (activeGuide) endGuide(false);
    helpReturnFocus = document.activeElement;
    update(getContext());
    if (!helpDialog.open) helpDialog.showModal();
    $("[data-gh-search]").focus();
    track("view:helpView");
  }
  function close(restoreFocus = true) {
    if (helpDialog.open) helpDialog.close();
    if (restoreFocus && helpReturnFocus?.isConnected) helpReturnFocus.focus({ preventScroll: true });
  }
  $("[data-gh-close]").addEventListener("click", () => close());
  helpDialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  let searchCounted = false;
  $("[data-gh-search]").addEventListener("input", event => { renderAnswers(event.target.value); if (event.target.value.trim() && !searchCounted) { track("help:search"); searchCounted = true; } if (!event.target.value.trim()) searchCounted = false; });
  root.querySelectorAll("[data-gh-guide]").forEach(button => button.addEventListener("click", () => {
    if (activeGuide) endGuide(false);
    activeGuide = ghGuides.find(guide => guide.id === button.dataset.ghGuide); guideIndex = 0; guideTrigger = button;
    track(`guide:${activeGuide.id}:start`); showGuideStep();
  }));
  $("[data-gh-chat]")?.addEventListener("click", () => go({ view: "scenarioView", mode: "chat", controls: false }));
  $("[data-gh-terms]").addEventListener("click", () => go({ view: "glossaryView", controls: false }));
  $("[data-gh-report]").addEventListener("click", () => openFeedback());
  $("[data-gh-optin]").addEventListener("change", event => { state.optedIn = event.target.checked; const persisted = save(); renderInsights(); $("[data-gh-insight-status]").textContent = persisted ? `Local feature counts are ${state.optedIn ? "on" : "off"}.` : "Preference applies to this visit only because browser storage is unavailable."; });
  $("[data-gh-clear-counts]").addEventListener("click", () => { state.counts = {}; const persisted = save(); renderInsights(); $("[data-gh-insight-status]").textContent = persisted ? "Usage counts cleared." : "Counts cleared for this visit. Stored counts could not be updated."; });
  $("[data-gh-clear-feedback]").addEventListener("click", () => { state.feedback = []; save(); renderFeedback(); });
  feedbackDialog.querySelector("[data-gh-cancel]").addEventListener("click", closeFeedback);
  feedbackDialog.addEventListener("cancel", event => { event.preventDefault(); closeFeedback(); });
  feedbackDialog.querySelector("form").addEventListener("submit", event => {
    event.preventDefault(); const input = feedbackDialog.querySelector("textarea"); const message = input.value.trim();
    if (!message) { input.setCustomValidity("Describe the problem before saving."); input.reportValidity(); return; }
    const persisted = recordFeedback(feedbackSubject, "problem", message);
    input.value = "";
    feedbackDialog.querySelector("[data-gh-feedback-status]").textContent = persisted ? "Feedback saved on this browser only. It has not been sent to anyone." : "Feedback is recorded for this visit only. Browser storage failed; it may be lost when the page closes.";
    feedbackDialog.querySelector("[data-gh-cancel]").textContent = "Close";
  });
  feedbackDialog.querySelector("textarea").addEventListener("input", event => event.target.setCustomValidity(""));
  const onEscape = event => { if (event.key === "Escape" && activeGuide && !feedbackDialog.open) { event.preventDefault(); endGuide(false); } };
  document.addEventListener("keydown", onEscape);
  renderAnswers(); renderFeedback(); renderInsights(); showStorageWarning(); update(context);
  return {
    track, addFeedback, update, open, close,
    startGuide(id) { const guide = ghGuides.find(item => item.id === id); if (!guide) return false; if (activeGuide) endGuide(false); guideTrigger = document.activeElement; activeGuide = guide; guideIndex = 0; track(`guide:${id}:start`); showGuideStep(); return true; },
    destroy() {
      endGuide(false); destroyed = true; document.removeEventListener("keydown", onEscape);
      document.removeEventListener("scroll", positionSpotlight, true);
      window.removeEventListener?.("resize", positionSpotlight);
      for (const { element, description, hadDescription } of tooltipElements) {
        if (element.title === description) element.removeAttribute("title");
        if (!hadDescription && element.getAttribute("aria-description") === description) element.removeAttribute("aria-description");
      }
      helpDialog.remove(); guidePanel.remove(); spotlight.remove(); feedbackDialog.remove();
    },
  };
}
