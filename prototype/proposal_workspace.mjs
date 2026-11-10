// Local proposal collaboration. No data leaves this browser from this module.
// Encapsulation also supports Streamlit's concatenated-module delivery.
const pwInternals = (() => {
const STORAGE_KEY = 'air2stay.proposal-workspace.v1';
const LIMITS = { proposals: 30, versions: 40, comments: 100, tasks: 60, decisions: 60, discussions: 100 };
const CHECKS = [
  { id: 'demand', title: 'Confirm the flight demand', owner: 'Airline or airport planner', ask: 'Check expected bookings, aircraft seats, flight occupancy and passengers ending their journey in Abu Dhabi.' },
  { id: 'hotels', title: 'Check hotel use and capacity', owner: 'Hotel or tourism team', ask: 'Check the share choosing hotels, stay length and available capacity for this month. Guest nights are not room nights.' },
  { id: 'visitors', title: 'Check who is travelling', owner: 'Tourism research team', ask: 'Check the assumed visitor mix, trip purpose and returning-resident share against suitable records.' },
];
const CHECK_DISPLAY = {
  demand: { title: 'Flight demand', why: 'Confirm expected bookings and how full the proposed flights could be.', icon: 'M2 10h16M10 2v16M5 7l5-3 5 3M7 16l3-2 3 2' },
  hotels: { title: 'Hotel capacity', why: 'Check whether hotels have space for the expected guests and length of stay.', icon: 'M3 16V5m0 8h14v3m0-3v-3H9v3M5 9h2' },
  visitors: { title: 'Visitor mix', why: 'Check who is likely to travel so the visitor estimates reflect this route.', icon: 'M12 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3 16v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m0-6a3 3 0 0 1 3 3v2' },
  event: { title: 'Event demand', why: 'Check whether the event is likely to bring in the extra visitors assumed in the plan.', icon: 'M4 5h12v12H4zM4 8h12M7 3v4m6-4v4' },
};
const CHECK_STATUS = { red: 'Overdue', amber: 'To check', green: 'Done' };
const TASK_STATUS = { open: 'Open', waiting: 'Waiting', verified: 'Done' };
const clone = (value) => JSON.parse(JSON.stringify(value));
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fmt = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)).toLocaleString('en-US') : 'Unavailable';
const pct = (value) => `${(Number(value) * 100).toFixed(1)}%`;
const INPUT_LABELS = {
  extraFlights: 'Extra flights each week', seatsPerFlight: 'Seats on each flight', loadFactor: 'How full flights are', p2pShare: 'Passengers ending in Abu Dhabi', conversionRate: 'Share checking into a hotel', averageStay: 'Nights per hotel stay', eventUplift: 'Event or seasonal increase', routePurpose: 'Trip purpose', proxyOriginKey: 'Single comparison country', referenceMode: 'Comparison method', seasonalConversion: 'Use seasonal hotel estimate', purposeAssumptionsApplied: 'Purpose assumptions applied',
};
const monthName = (month) => ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(month) - 1] || 'Unknown month';
const displayDate = (value) => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Date unavailable'; };
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function localDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function proposalKey(inputs) {
  return `${String(inputs.originKey || '').trim().toUpperCase()}::${Number(inputs.month)}`;
}
function proposalFingerprint(context) {
  // Store the canonical exact value, not a short hash which could collide.
  return stable({ inputs: context.inputs, baseline: context.result?.baseline, scenario: context.result?.scenario, route: context.result?.route });
}
const emptyProposal = () => ({ versions: [], comments: [], tasks: [], decisions: [], discussions: [] });

function createProposalStore(storage, clock = () => new Date()) {
  let warning = '';
  let data = { version: 1, proposals: {} };
  let sequence = 0;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!storage) warning = 'Browser storage is unavailable. Your notes will last only while this page stays open.';
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1 || !parsed.proposals || Array.isArray(parsed.proposals) || typeof parsed.proposals !== 'object' || Object.keys(parsed.proposals).length > LIMITS.proposals) throw new Error('Invalid saved proposal data');
      for (const item of Object.values(parsed.proposals)) {
        item.discussions ??= [];
        for (const key of ['versions', 'comments', 'tasks', 'decisions', 'discussions']) {
          if (!Array.isArray(item[key]) || item[key].length > LIMITS[key] || item[key].some((row) => !row || typeof row !== 'object')) throw new Error('Invalid proposal history');
        }
        if (item.versions.some((row) => !row.inputs || !row.fingerprint) || item.tasks.some((row) => !row.id || !row.title || !row.fingerprint || !Array.isArray(row.updates) || row.updates.length > 40 || row.updates.some((update) => !update || typeof update !== 'object')) || item.discussions.some((row) => !['user', 'assistant'].includes(row.role) || typeof row.text !== 'string')) throw new Error('Invalid proposal record');
      }
      data = parsed;
    }
  } catch {
    warning = 'Saved proposal notes could not be read. New notes will be kept in this session; export them before closing the page.';
    storage = null;
  }
  function persist() {
    if (!storage) return;
    try { storage.setItem(STORAGE_KEY, JSON.stringify(data)); warning = ''; }
    catch { warning = 'The browser could not save these notes. They are still here for this session. Download a backup before closing the page.'; }
  }
  function mutate(key, collection, operation) {
    if (!Object.hasOwn(data.proposals, key)) {
      if (Object.keys(data.proposals).length >= LIMITS.proposals) throw new Error('This browser has reached the 30-proposal limit. Download a backup before starting another proposal.');
      data.proposals[key] = emptyProposal();
    }
    const proposal = data.proposals[key];
    if (collection && proposal[collection].length >= LIMITS[collection]) throw new Error(`This proposal has reached its ${collection} limit. Download a backup to retain the history.`);
    const result = operation(proposal);
    persist();
    return clone(result);
  }
  function record(context) {
    return { id: `${clock().getTime()}-${++sequence}-${Math.random().toString(36).slice(2, 8)}`, createdAt: clock().toISOString(), fingerprint: proposalFingerprint(context) };
  }
  function text(value, max, label) {
    const clean = String(value || '').trim();
    if (!clean) throw new Error(`Enter ${label}.`);
    if (clean.length > max) throw new Error(`${label} must be ${max} characters or fewer.`);
    return clean;
  }
  return {
    get warning() { return warning; },
    get(key) { return clone(Object.hasOwn(data.proposals, key) ? data.proposals[key] : emptyProposal()); },
    exportData() { return clone(data); },
    saveVersion(context, name) {
      const snapshot = { ...record(context), name: String(name || '').trim().slice(0, 100) || `Version ${this.get(proposalKey(context.inputs)).versions.length + 1}`, inputs: clone(context.inputs), result: clone(context.result), decisionText: context.decision?.text || '' };
      return mutate(proposalKey(context.inputs), 'versions', (proposal) => { proposal.versions.push(snapshot); return snapshot; });
    },
    addComment(context, value) {
      const entry = { ...record(context), text: text(value, 3000, 'a comment') };
      return mutate(proposalKey(context.inputs), 'comments', (proposal) => { proposal.comments.push(entry); return entry; });
    },
    addDiscussion(context, role, value, source = 'local') {
      if (role === 'bot') role = 'assistant';
      if (!['user', 'assistant'].includes(role)) throw new Error('Unrecognised discussion role.');
      const entry = { ...record(context), role, source: ['local', 'ai'].includes(source) ? source : 'local', text: text(value, 6000, 'a discussion message') };
      return mutate(proposalKey(context.inputs), 'discussions', (proposal) => { proposal.discussions.push(entry); return entry; });
    },
    clearDiscussions(key) {
      if (!Object.hasOwn(data.proposals, key)) return [];
      return mutate(key, null, (proposal) => { proposal.discussions = []; return []; });
    },
    addDecision(context, outcome, value) {
      if (!['Investigate', 'Hold', 'Ready for review'].includes(outcome)) throw new Error('Choose a decision status.');
      const entry = { ...record(context), outcome, text: text(value, 3000, 'the reason for this decision') };
      return mutate(proposalKey(context.inputs), 'decisions', (proposal) => { proposal.decisions.push(entry); return entry; });
    },
    addTask(context, fields) {
      if (![...CHECKS.map((check) => check.id), 'event', 'general'].includes(fields.check)) throw new Error('Choose a valid check.');
      const title = text(fields.title, 300, 'an action');
      const owner = text(fields.owner, 100, 'an owner or team');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.dueDate) || !Number.isFinite(Date.parse(`${fields.dueDate}T12:00:00`)) || new Date(`${fields.dueDate}T12:00:00`).getDate() !== Number(fields.dueDate.slice(-2))) throw new Error('Choose a valid due date.');
      const entry = { ...record(context), check: fields.check, title, owner, dueDate: fields.dueDate, status: 'open', evidence: '', updates: [] };
      return mutate(proposalKey(context.inputs), 'tasks', (proposal) => { proposal.tasks.push(entry); return entry; });
    },
    updateTask(context, id, status, evidence) {
      if (!['open', 'waiting', 'verified'].includes(status)) throw new Error('Choose a valid action status.');
      const note = String(evidence || '').trim();
      if (note.length > 3000) throw new Error('Evidence must be 3,000 characters or fewer.');
      if (status === 'verified' && note.length < 8) throw new Error('To mark this task Done, use Notes to say who confirmed it (your source), when, and what they confirmed.');
      return mutate(proposalKey(context.inputs), null, (proposal) => {
        const task = proposal.tasks.find((row) => row.id === id);
        if (!task) throw new Error('This action was not found in the current proposal.');
        if (task.updates.length >= 40) throw new Error('This action has reached its update limit. Add a new action to continue its record.');
        const update = { ...record(context), status, evidence: note };
        task.updates.push(update);
        Object.assign(task, { status, evidence: note, updatedAt: update.createdAt, verifiedFingerprint: status === 'verified' ? update.fingerprint : null });
        return task;
      });
    },
  };
}

function priorityActions(context, proposal = emptyProposal(), now = new Date()) {
  const fingerprint = proposalFingerprint(context);
  const today = localDate(now);
  const checks = [...CHECKS];
  if (Number(context.inputs.eventUplift) > 0) checks.push({ id: 'event', title: 'Validate the event increase', owner: 'Event or tourism team', ask: 'Check event dates, expected attendance and hotel demand. This uplift is a planner assumption, not a measured event effect.' });
  const rows = checks.map((check) => {
    const tasks = proposal.tasks.filter((task) => task.check === check.id);
    const currentVerified = tasks.filter((task) => task.status === 'verified' && task.verifiedFingerprint === fingerprint && task.evidence);
    const unresolved = tasks.filter((task) => !currentVerified.includes(task));
    const overdue = tasks.filter((task) => task.dueDate < today && !(task.status === 'verified' && task.verifiedFingerprint === fingerprint));
    const stale = tasks.some((task) => task.status === 'verified' && task.verifiedFingerprint !== fingerprint);
    const openCount = unresolved.filter((task) => task.status === 'open').length;
    const waitingCount = unresolved.filter((task) => task.status === 'waiting').length;
    const staleCount = unresolved.filter((task) => task.status === 'verified').length;
    const remainingChecks = [
      openCount ? `${openCount} open action${openCount === 1 ? '' : 's'}` : '',
      waitingCount ? `${waitingCount} action${waitingCount === 1 ? '' : 's'} waiting for a response` : '',
      staleCount ? `${staleCount} earlier check${staleCount === 1 ? '' : 's'} needing review after plan changes` : '',
    ].filter(Boolean).join('; ');
    const status = overdue.length ? 'red' : currentVerified.length && !unresolved.length ? 'green' : 'amber';
    const records = Number(context.result?.route?.yearsObserved) || 0;
    const assumptionReason = check.id === 'demand'
      ? `${!context.result?.route?.knownMarket ? 'No matching route history: comparison countries are starting assumptions, not evidence of bookings.' : records < 3 ? `Only ${records} matching past flight record${records === 1 ? '' : 's'}; this gives limited history for this country and month.` : 'Past flight records do not establish future bookings.'} The plan assumes ${pct(context.inputs.loadFactor)} full flights. Confirm demand for the proposed capacity.`
      : check.id === 'event' ? `The plan adds ${pct(context.inputs.eventUplift)} hotel demand for an event or season. This is a scenario assumption, not a measured event effect.`
      : check.id === 'hotels' ? `The plan assumes ${pct(context.inputs.conversionRate)} of passengers ending their trip here use hotels, with ${Number(context.inputs.averageStay).toFixed(2)} nights per stay. Confirm these assumptions and available capacity.`
      : 'The visitor mix and trip purpose are estimates. Check who is travelling before using them for marketing or hotel planning.';
    const reason = overdue.length ? `${overdue.length} check${overdue.length === 1 ? ' is' : 's are'} overdue. ${stale ? 'Earlier evidence also needs review after the plan changed.' : 'Follow up with the assigned owner.'} ${assumptionReason}`
      : currentVerified.length && !unresolved.length ? 'Evidence was recorded by a user for these exact assumptions. This is a completed check, not approval of the route.'
      : currentVerified.length ? `${currentVerified.length} action${currentVerified.length === 1 ? ' has' : 's have'} evidence for the current plan. Remaining: ${remainingChecks}. ${assumptionReason}`
      : stale ? `The plan changed after evidence was recorded. Recheck it before using the earlier conclusion. ${assumptionReason}`
      : tasks.some((task) => task.status === 'waiting') ? `Waiting for a response; there is no verified evidence for the current plan. ${assumptionReason}`
      : `${assumptionReason} No verified evidence is recorded for this check.`;
    return { ...check, status, reason, evidence: currentVerified.map((task) => ({ owner: task.owner, note: task.evidence, date: task.updatedAt })), tasks: tasks.map((task) => task.id) };
  });
  // Extra follow-ups remain visible even if no built-in check covers them.
  for (const task of proposal.tasks.filter((task) => !checks.some((check) => check.id === task.check))) {
    const verified = task.status === 'verified' && task.verifiedFingerprint === fingerprint && task.evidence;
    const overdue = !verified && task.dueDate < today;
    rows.push({ id: `task:${task.id}`, title: task.title, owner: task.owner, ask: 'Follow up on this action and record the response.', status: overdue ? 'red' : verified ? 'green' : 'amber', reason: verified ? 'User-recorded evidence matches the current assumptions.' : `Due ${task.dueDate}; no completed check for the current assumptions.`, tasks: [task.id], evidence: verified ? [{ owner: task.owner, note: task.evidence, date: task.updatedAt }] : [] });
  }
  const driverId = context.decision?.workplaceDecision?.driver?.id;
  const preferredId = driverId === 'lowerLoad' ? 'demand' : ['lowerHotelUse', 'shorterStay'].includes(driverId) ? 'hotels' : 'demand';
  const first = rows.find((row) => row.status === 'red') || rows.find((row) => row.id === preferredId && row.status !== 'green') || rows.find((row) => row.status !== 'green');
  return { rows, recommended: first ? { ...first, why: first.status === 'red' ? 'Start here because this check is overdue.' : first.id === preferredId && driverId ? `${context.decision.workplaceDecision.driverText} Checking this assumption first could change the decision.` : first.reason } : null };
}

function stakeholderDraft(context, kind, proposal = emptyProposal()) {
  const route = context.result?.route?.origin || context.inputs.originKey;
  const month = monthName(context.inputs.month);
  const assumptions = context.decision?.assumptions || [
    { label: 'Extra flights each week', value: context.inputs.extraFlights }, { label: 'Seats per flight', value: context.inputs.seatsPerFlight },
    { label: 'Flight occupancy', value: pct(context.inputs.loadFactor) }, { label: 'Hotel use', value: pct(context.inputs.conversionRate) }, { label: 'Average stay', value: context.inputs.averageStay },
  ];
  const headline = context.decision?.workplaceDecision?.hotelNightsText || `The current plan estimates a change of ${fmt(context.result?.delta?.guestNights)} guest nights versus the historical-baseline estimate.`;
  const comparisonBasis = context.decision?.workplaceDecision ? 'This isolates the flight change versus zero extra flights using the same visitor assumptions.' : 'This compares the current plan with its estimated historical baseline.';
  const intro = `We are reviewing the proposed route from ${route} to Abu Dhabi for ${month}.\n${headline}\n${comparisonBasis}\nThis is a planning estimate, not confirmed demand. Guest nights count people staying overnight, not occupied rooms.`;
  const request = kind === 'airline' ? 'Please help confirm the proposed schedule and aircraft capacity, expected bookings and flight occupancy, and the proportion ending their journey in Abu Dhabi. Please distinguish visitors from residents returning home, state the source/date, and highlight any constraints.'
    : kind === 'hotel' ? 'Please help confirm expected hotel use, typical stay length, available hotel capacity and existing occupancy for this month. Please include guests per occupied room before translating guest nights into room needs, and state the source/date.'
    : 'Please review these assumptions and agree which checks must be completed before advancing the proposal.';
  const actions = priorityActions(context, proposal).rows.filter((row) => row.status !== 'green').map((row) => `- ${row.title}: ${row.reason} Suggested contact: ${row.owner}.`);
  const title = kind === 'airline' ? 'Airline planning inquiry' : kind === 'hotel' ? 'Hotel capacity inquiry' : 'Team proposal update';
  return `Subject: ${title} — ${route}, ${month}\n\n${intro}\n\n${request}\n\nAssumptions to review\n${assumptions.map((row) => `- ${row.label}: ${row.value}`).join('\n')}\n\n${context.result?.route?.knownMarket ? 'The baseline is an estimate based on past flight records, not directly observed hotel outcomes for this route.' : 'There are no route records. Comparison countries are only starting points for the assumptions.'}\n\nPending checks\n${actions.length ? actions.join('\n') : 'All listed checks have user-recorded evidence for the current assumptions. Please review that evidence before making a decision.'}\n\nPlease reply with any corrections and the source/date of the information.\n\nDraft for review — prepared in Air2Stay. Nothing has been sent.`;
}

function createProposalWorkspace({ mount, rail = null, launcher = null, onOpenWorkspace, getContext, onRestore, onRecommendation, chatEnabled = false, track = () => {} }) {
  if (!mount) throw new Error('A proposal workspace mount is required.');
  const doc = mount.ownerDocument || document;
  let storage;
  try { storage = doc.defaultView?.localStorage || localStorage; } catch { storage = null; }
  const store = createProposalStore(storage);
  let context = null;
  let lastFingerprint = '';
  let lastKey = '';
  let message = '';
  let messageIsError = false;
  let draftKind = 'airline';
  let selectedCheck = null;
  let drawerOpen = false;
  const openTools = new Set();
  function closeDrawer(restoreFocus=true) {
    drawerOpen=false;
    rail?.querySelector('dialog')?.close?.();
    launcher?.setAttribute('aria-expanded','false');
    if(restoreFocus)launcher?.focus({preventScroll:true});
  }
  function openDrawer() {
    if(!current()?.result)return;
    drawerOpen=true;
    const dialog=rail?.querySelector('dialog');
    if(!dialog?.open)dialog?.showModal?.();
    launcher?.setAttribute('aria-expanded','true');
  }
  const toggleDrawer=()=>{if(drawerOpen)closeDrawer();else openDrawer();};
  launcher?.addEventListener('click',toggleDrawer);
  let generatedDraft = null;
  let downloadReady = null;
  const draftValues = new Map();
  const emit = (name) => {
    const allowed = { proposal_version: 'proposal_save', proposal_comment: 'proposal_comment', proposal_task: 'proposal_task', 'proposal_task-update': 'proposal_task', proposal_draft: 'proposal_draft', proposal_restore: 'proposal_restore' };
    if (!allowed[name]) return;
    try { track(allowed[name]); } catch { /* Analytics must never block a local action. */ }
  };
  function notice(value, error = false) { message = value; messageIsError = error; }
  function current() { return context; }
  function preserveDrafts() {
    if (!lastKey) return;
    for (const field of mount.querySelectorAll('form [name]')) draftValues.set(`${lastKey}:${field.form.dataset.pwForm}:${field.form.dataset.id || ''}:${field.name}`, field.value);
    openTools.clear();
    for (const tool of mount.querySelectorAll('[data-pw-tool][open]')) openTools.add(tool.dataset.pwTool);
    const draft = mount.querySelector('[data-pw-draft]');
    if (draft && generatedDraft) generatedDraft.text = draft.value;
  }
  function restoreDrafts(key) {
    for (const field of mount.querySelectorAll('form [name]')) {
      const value = draftValues.get(`${key}:${field.form.dataset.pwForm}:${field.form.dataset.id || ''}:${field.name}`);
      if (value !== undefined) field.value = value;
    }
  }
  function forgetForm(form, key) {
    for (const field of form.querySelectorAll('[name]')) draftValues.delete(`${key}:${form.dataset.pwForm}:${form.dataset.id || ''}:${field.name}`);
  }
  function checkStatus(status, dotOnly = false) {
    const label = CHECK_STATUS[status];
    const attributes = dotOnly ? ` role="img" aria-label="${label}" title="${label}"` : '';
    return `<span class="pw-check-status pw-check-status-${status}"${attributes}><span class="pw-status-dot" aria-hidden="true"></span>${dotOnly ? '' : label}</span>`;
  }

  function renderRail(ctx, priority) {
    const pending = priority.rows.filter(row => row.status !== 'green').length;
    if (launcher) {
      const count = launcher.querySelector('[data-pw-drawer-count]');
      launcher.disabled = false;
      launcher.classList.toggle('is-urgent', priority.rows.some(row => row.status === 'red'));
      count.textContent = String(pending);
      count.hidden = false;
      const label = `Actions · ${pending} ${pending === 1 ? 'check needs' : 'checks need'} attention`;
      launcher.setAttribute('aria-label', label);
      launcher.setAttribute('title', label);
    }
    if (!rail) return;
    const first = priority.recommended;
    const rows = first ? [first, ...priority.rows.filter(row => row.id !== first.id)] : priority.rows;
    rail.innerHTML = `<dialog id="proposalDrawer" class="pw-drawer pw-simple-drawer" aria-labelledby="pwDrawerTitle" aria-describedby="pwDrawerContext">
      <header class="pw-drawer-header">
        <div><h2 id="pwDrawerTitle">Priority actions</h2><p id="pwDrawerContext" class="pw-rail-context">${escape(ctx.result.route.origin)} · ${escape(monthName(ctx.inputs.month))}</p></div>
        <button type="button" class="pw-drawer-close" data-pw-drawer-close aria-label="Close actions panel"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>
      </header>
      <ul class="pw-rail-body pw-simple-list">${rows.map(row => {
        const display = CHECK_DISPLAY[row.id];
        const title = escape(display?.title || row.title);
        return `<li class="pw-simple-row${selectedCheck === row.id ? ' pw-selected' : ''}">
          <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${display?.icon || 'M4 10l4 4 8-8'}"/></svg>
          <span class="pw-simple-title">${title}</span>
          ${checkStatus(row.status, true)}
          <button type="button" data-pw-rail="review" data-check="${escape(row.id)}" aria-label="Review ${title}">Review</button>
        </li>`;
      }).join('')}</ul>
    </dialog>`;
    const dialog = rail.querySelector('dialog');
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeDrawer(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeDrawer();
    });
    if (drawerOpen) openDrawer();
  }

  function reveal(selector) {
    closeDrawer(false);
    onOpenWorkspace?.();
    const target=mount.querySelector(selector);
    if (!target) return;
    for(let parent=target.closest('details');parent;parent=parent.parentElement?.closest('details')) parent.open=true;
    target.scrollIntoView({block:'start',behavior:'instant'});
    target.focus?.({preventScroll:true});
  }
  rail?.addEventListener('click', event => {
    if (event.target.closest('[data-pw-drawer-close]')) { closeDrawer(); return; }
    const button = event.target.closest('[data-pw-rail="review"]');
    if (!button || !current()?.result) return;
    preserveDrafts();
    selectedCheck = button.dataset.check;
    closeDrawer(false);
    render();
    reveal('[data-pw-selected-check] h4, .pw-task[data-pw-related] h4');
  });
  rail?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drawerOpen) event.stopPropagation();
  });

  function render() {
    const ctx = current();
    if (!ctx?.inputs || !ctx?.result) {closeDrawer(false);if(launcher){launcher.disabled=true;launcher.classList.remove('is-urgent');launcher.querySelector('[data-pw-drawer-count]').hidden=true;launcher.setAttribute('aria-label','Actions unavailable: correct the plan inputs');launcher.setAttribute('title','Actions unavailable: correct the plan inputs');} mount.innerHTML = '<p class="control-note">Choose a valid plan to see its proposal workspace.</p>'; if(rail)rail.innerHTML='<p class="control-note">Correct the plan inputs to see priority actions and communications.</p>'; return; }
    const key = proposalKey(ctx.inputs);
    if (key !== lastKey) {
      selectedCheck = null;
      openTools.clear();
    }
    const fingerprint = proposalFingerprint(ctx);
    const proposal = store.get(key);
    const priority = priorityActions(ctx, proposal);
    if(selectedCheck && !priority.rows.some(row=>row.id===selectedCheck))selectedCheck=null;
    const currentPlan = `${ctx.result.route.origin || ctx.inputs.originKey} · ${monthName(ctx.inputs.month)}`;
    const checkHtml = priority.rows.filter(row => !row.id.startsWith('task:')).map(row => {
      const display = CHECK_DISPLAY[row.id];
      const recommended = row.id === priority.recommended?.id;
      const selected = row.id === selectedCheck;
      return `<article class="pw-check pw-check-${row.status}${recommended ? ' pw-recommendation' : ''}" ${selected ? 'data-pw-selected-check' : ''}>
        ${recommended ? '<p class="pw-start-here">Start here</p>' : ''}
        <div class="pw-check-heading"><h4 tabindex="-1">${escape(display.title)}</h4>${checkStatus(row.status)}</div>
        <p>${escape(display.why)}</p>
        <button type="button" data-pw-action="add-task" data-check="${escape(row.id)}" aria-label="Add task for ${escape(display.title)}">Add task</button>
      </article>`;
    }).join('');
    const relatedTasks = priority.rows.find(row => row.id === selectedCheck)?.tasks || [];
    const taskHtml = proposal.tasks.slice().reverse().map(task => {
      const stale = task.status === 'verified' && task.verifiedFingerprint !== fingerprint;
      const status = stale ? 'open' : task.status;
      const overdue = task.dueDate < localDate(new Date()) && status !== 'verified';
      const check = CHECK_DISPLAY[task.check]?.title;
      const startHere = priority.recommended?.id === `task:${task.id}`;
      const options = Object.entries(TASK_STATUS).map(([value, label]) => `<option value="${value}"${status === value ? ' selected' : ''}>${label}</option>`).join('');
      return `<article class="pw-task" ${relatedTasks.includes(task.id) ? 'data-pw-related' : ''}>
        ${startHere ? '<p class="pw-start-here">Start here</p>' : ''}
        <h4 tabindex="-1" id="pwTask-${escape(task.id)}">${escape(task.title)}</h4>
        <p class="pw-task-meta">${check ? `${escape(check)} · ` : ''}${escape(task.owner)} · Due <time datetime="${escape(task.dueDate)}">${escape(task.dueDate)}</time>
          ${overdue ? checkStatus('red') : ''}${stale ? '<span class="pw-recheck">Plan changed · Review this again</span>' : ''}
        </p>
        <form data-pw-form="task-update" data-id="${escape(task.id)}">
          <label>Status<select name="status">${options}</select></label>
          <label>Notes<textarea name="evidence" maxlength="3000" rows="2" placeholder="To mark Done, add who confirmed what, and when.">${escape(task.evidence)}</textarea></label>
          <button type="submit" class="secondary-button">Save</button>
        </form>
        ${task.updates.length ? `<details><summary>Task history (${task.updates.length})</summary><ol class="pw-history">${task.updates.slice().reverse().map(row => `<li>${escape(displayDate(row.createdAt))} · ${escape(TASK_STATUS[row.status] || row.status)}<p>${escape(row.evidence || 'No notes added.')}</p></li>`).join('')}</ol></details>` : ''}
      </article>`;
    }).join('');
    const tool = (name) => openTools.has(name) ? ' open' : '';
    const historyHtml = proposal.versions.slice().reverse().map((version) => `<li><div class="pw-item-heading"><strong>${escape(version.name)}</strong><span>${escape(displayDate(version.createdAt))}</span></div><p>${version.fingerprint === fingerprint ? 'Matches the current assumptions.' : 'Saved assumptions differ from the current plan.'} Estimated guest nights: ${fmt(version.result?.scenario?.guestNights)}.</p><details><summary>Saved assumptions</summary><dl class="pw-assumptions">${Object.entries(version.inputs).filter(([key, value]) => INPUT_LABELS[key] && value != null && value !== '').map(([key, value]) => `<div><dt>${escape(INPUT_LABELS[key])}</dt><dd>${escape(['loadFactor', 'p2pShare', 'conversionRate', 'eventUplift'].includes(key) ? pct(value) : typeof value === 'boolean' ? value ? 'Yes' : 'No' : value)}</dd></div>`).join('')}</dl><p class="control-note">The snapshot also retains the visitor mix and comparison-country details for loading this version and downloading history.</p></details><button type="button" class="secondary-button" data-pw-action="restore" data-id="${escape(version.id)}">Load this version</button></li>`).join('');
    mount.innerHTML = `<div class="pw-heading">
      <div><h2>Follow-ups</h2><p>${escape(currentPlan)}</p></div>
      <span class="pw-local">Saved in this browser</span>
    </div>
    ${store.warning ? `<p class="pw-warning" role="alert">${escape(store.warning)}</p>` : ''}
    <p class="pw-message ${messageIsError ? 'pw-warning' : ''}" role="status" aria-live="polite">${escape(message)}</p>
    <div class="pw-followup-grid">
      <section class="pw-priorities" aria-labelledby="pwChecksHeading">
        <h3 id="pwChecksHeading">What needs checking</h3>
        <div class="pw-check-list">${checkHtml}</div>
      </section>
      <section class="pw-your-tasks" aria-labelledby="pwTasksHeading">
        <h3 id="pwTasksHeading">Your tasks</h3>
        <details class="pw-task-editor" data-pw-tool="task"${tool('task')}>
          <summary>New task</summary>
          <form class="pw-form-grid" data-pw-form="task">
            <label>Check<select name="check">
              ${CHECKS.map(check => `<option value="${check.id}">${escape(CHECK_DISPLAY[check.id].title)}</option>`).join('')}
              <option value="event">Event demand</option><option value="general">Other follow-up</option>
            </select></label>
            <label>Task<input name="title" required maxlength="300" placeholder="What needs confirming?"></label>
            <label>Owner or team<input name="owner" required maxlength="100" placeholder="For example, hotel team"></label>
            <label>Due date<input name="dueDate" type="date" required></label>
            <button type="submit">Add task</button>
          </form>
        </details>
        <div class="pw-task-list">${taskHtml || '<p class="pw-empty">No tasks yet. Choose <strong>Add task</strong> on a check to get started.</p>'}</div>
      </section>
    </div>
    <div class="pw-tools" aria-label="More follow-up tools">
      <details class="pw-discussion" data-pw-tool="note"${tool('note')}>
        <summary>Add note</summary>
        <form data-pw-form="comment">
          <label>Note<textarea name="text" required maxlength="3000" rows="3" placeholder="Record a question, reply or useful detail"></textarea></label>
          <button type="submit">Save note</button>
        </form>
        <ol class="pw-history">${proposal.comments.slice().reverse().map(entry => `<li><small>${escape(displayDate(entry.createdAt))} · ${entry.fingerprint === fingerprint ? 'Current plan' : 'Earlier plan'}</small><p>${escape(entry.text)}</p></li>`).join('') || '<li>No notes yet.</li>'}</ol>
        ${chatEnabled && proposal.discussions.length ? `<details><summary>Planning chat history (${proposal.discussions.length})</summary><ol class="pw-history">${proposal.discussions.slice().reverse().map(entry => `<li><strong>${entry.role === 'user' ? 'You' : 'Air2Stay'}</strong> <small>· ${escape(displayDate(entry.createdAt))} · ${entry.fingerprint === fingerprint ? 'Current plan' : 'Earlier plan'}</small><p>${escape(entry.text)}</p></li>`).join('')}</ol></details>` : ''}
      </details>
      <details class="pw-drafts" data-pw-tool="email"${tool('email')}>
        <summary>Draft email</summary>
        <p class="pw-task-meta">Review the draft, then copy it into your email app to send.</p>
        <label>Message for<select data-pw-draft-kind>
          <option value="airline" ${draftKind === 'airline' ? 'selected' : ''}>Airline or airport planner</option>
          <option value="hotel" ${draftKind === 'hotel' ? 'selected' : ''}>Hotel team</option>
          <option value="team" ${draftKind === 'team' ? 'selected' : ''}>Your team</option>
        </select></label>
        <button type="button" data-pw-action="draft">Prepare draft</button>
        ${generatedDraft ? `<label>Email draft<textarea data-pw-draft rows="14">${escape(generatedDraft.text)}</textarea></label><div class="pw-actions"><button type="button" class="secondary-button" data-pw-action="copy-draft">Copy draft</button><button type="button" class="secondary-button" data-pw-action="download-draft">Download draft</button></div>` : ''}
      </details>
      <details data-pw-tool="decision"${tool('decision')}>
        <summary>Log decision</summary>
        <form data-pw-form="decision">
          <label>Decision<select name="outcome"><option>Investigate</option><option>Hold</option><option>Ready for review</option></select></label>
          <label>Reason<textarea name="text" required maxlength="3000" rows="3"></textarea></label>
          <button type="submit">Save decision</button>
        </form>
        <ol class="pw-history">${proposal.decisions.slice().reverse().map(entry => `<li><strong>${escape(entry.outcome)}</strong> <small>· ${escape(displayDate(entry.createdAt))} · ${entry.fingerprint === fingerprint ? 'Current plan' : 'Earlier plan'}</small><p>${escape(entry.text)}</p></li>`).join('') || '<li>No decisions yet.</li>'}</ol>
      </details>
      <details data-pw-tool="history"${tool('history')}>
        <summary>Saved versions and backup</summary>
        <form class="pw-inline-form" data-pw-form="version">
          <label>Version name<input name="name" maxlength="100" placeholder="For example, initial airline proposal"></label>
          <button type="submit">Save version</button>
        </form>
        <ol class="pw-history">${historyHtml || '<li>No versions saved for this plan yet.</li>'}</ol>
        <button type="button" class="secondary-button" data-pw-action="backup">Download local history</button>
        <div id="pwRecommendationFeedback"></div>
      </details>
    </div>
    ${downloadReady ? `<div class="pw-download-ready"><a id="pwDownloadReady" href="${escape(downloadReady.url)}" download="${escape(downloadReady.filename)}">Download ${escape(downloadReady.filename)}</a>
      ${downloadReady.historyText ? `<details><summary>View or copy history JSON</summary><label>History JSON<textarea readonly rows="8">${escape(downloadReady.historyText)}</textarea></label></details>` : ''}
    </div>` : ''}`;
    restoreDrafts(key);
    renderRail(ctx, priority);
    lastKey = key;
    lastFingerprint = fingerprint;
    try { onRecommendation?.(mount.querySelector('#pwRecommendationFeedback'), { context: ctx, recommended: priority.recommended, fingerprint }); } catch { /* Feedback should not interrupt proposal work. */ }
  }
  function download(text, filename, type = 'text/plain;charset=utf-8') {
    const view = doc.defaultView;
    const blob = new view.Blob([text], { type });
    const url = view.URL.createObjectURL(blob);
    if (downloadReady) view.URL.revokeObjectURL(downloadReady.url);
    downloadReady = {
      url, filename, fingerprint: proposalFingerprint(current()),
      historyText: type === 'application/json' ? text : null,
    };
    const link = doc.createElement('a');
    link.href = url; link.download = filename; doc.body.append(link); link.click(); link.remove();
  }
  mount.addEventListener('submit', (event) => {
    const form = event.target.closest('form[data-pw-form]');
    if (!form) return;
    event.preventDefault();
    const ctx = current();
    const key = proposalKey(ctx.inputs);
    let savedTask = null;
    const fields = Object.fromEntries([...form.querySelectorAll('[name]')].map((field) => [field.name, field.value]));
    preserveDrafts();
    try {
      const action = form.dataset.pwForm;
      if (action === 'version') store.saveVersion(ctx, fields.name);
      if (action === 'comment') {const selected=priorityActions(ctx,store.get(key)).rows.find(row=>row.id===selectedCheck);store.addComment(ctx,selected?`Check: ${selected.title}\n${fields.text}`:fields.text);}
      if (action === 'decision') store.addDecision(ctx, fields.outcome, fields.text);
      if (action === 'task') {
        savedTask = store.addTask(ctx, fields);
        openTools.delete('task');
      }
      if (action === 'task-update') savedTask = store.updateTask(ctx, form.dataset.id, fields.status, fields.evidence);
      forgetForm(form, key);
      notice(store.warning || (action === 'task' ? 'Task added.' : action === 'task-update' ? 'Task saved.' : 'Saved for this plan.'));
      emit(`proposal_${action}`);
    } catch (error) { notice(error.message, true); }
    render();
    if (savedTask) {
      const heading = doc.getElementById?.(`pwTask-${savedTask.id}`);
      heading?.scrollIntoView({ block: 'nearest' });
      heading?.focus({ preventScroll: true });
    } else if (messageIsError) {
      const status = mount.querySelector('.pw-message');
      status?.scrollIntoView({ block: 'nearest' });
    }
  });
  mount.addEventListener('change', (event) => {
    if (event.target.matches('[data-pw-draft-kind]')) { draftKind = event.target.value; generatedDraft = null; preserveDrafts(); render(); }
  });
  mount.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-pw-action]');
    if (!button) return;
    const ctx = current();
    const proposal = store.get(proposalKey(ctx.inputs));
    const action = button.dataset.pwAction;
    preserveDrafts();
    try {
      if (action === 'backup') { download(JSON.stringify(store.exportData(), null, 2), 'Air2Stay-proposal-history.json', 'application/json'); notice('History file ready. Use the download link or copy the backup text.'); }
      if (action === 'draft') {
        const row = priorityActions(ctx, proposal).rows.find(check => check.id === selectedCheck);
        generatedDraft = { fingerprint: proposalFingerprint(ctx), text: stakeholderDraft(ctx, draftKind, proposal) + (row ? `\n\nCheck in focus: ${row.title}\n${row.reason}\nSuggested contact: ${row.owner}` : '') };
        notice('Email draft ready to review.');
      }
      if (action === 'copy-draft') {
        const field = mount.querySelector('[data-pw-draft]');
        generatedDraft.text = field.value;
        try { await doc.defaultView.navigator.clipboard.writeText(field.value); notice('Draft copied. Nothing was sent.'); }
        catch { field.focus(); field.select(); notice('Copy is unavailable here. The draft is selected; use your keyboard to copy it.'); const messageNode = mount.querySelector('.pw-message'); if (messageNode) messageNode.textContent = message; return; }
      }
      if (action === 'download-draft') {
        const field = mount.querySelector('[data-pw-draft]');
        generatedDraft.text = field.value;
        const routeName = String(ctx.result.route.origin || ctx.inputs.originKey).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
        download(field.value, `Air2Stay-${routeName}-${monthName(ctx.inputs.month)}-${draftKind}-draft.txt`);
        notice('Draft file ready. If the download did not start, choose the Download link below. Nothing was sent.');
      }
      if (action === 'restore') {
        const version = proposal.versions.find((row) => row.id === button.dataset.id);
        if (!version) throw new Error('That saved version is unavailable.');
        if (!onRestore) throw new Error('Loading a saved version is unavailable in this app.');
        await onRestore(clone(version.inputs));
        context = getContext?.() || context;
        generatedDraft = null;
        notice(`Loaded ${version.name}. The results have been recalculated using the app’s current data.`);
      }
      if (action === 'add-task') {
        const check = priorityActions(ctx, proposal).rows.find(row => row.id === button.dataset.check);
        if (!check) return;
        selectedCheck = check.id;
        openTools.add('task');
        render();
        const editor = mount.querySelector('.pw-task-editor');
        const form = editor.querySelector('form');
        if (form.elements.check.value !== check.id || !form.elements.title.value) {
          form.elements.check.value = check.id;
          form.elements.title.value = check.title;
          form.elements.owner.value = check.owner;
          form.elements.dueDate.value = '';
        }
        editor.scrollIntoView({ block: 'nearest' });
        form.elements.dueDate.focus({ preventScroll: true });
        return;
      }
      emit(`proposal_${action}`);
    } catch (error) { notice(error.message, true); }
    render();
  });
  return {
    update(nextContext) {
      preserveDrafts();
      context = nextContext === undefined ? getContext?.() : nextContext;
      if (downloadReady && (!context || proposalFingerprint(context) !== downloadReady.fingerprint)) {
        doc.defaultView.URL.revokeObjectURL(downloadReady.url);
        downloadReady = null;
      }
      if (context && proposalFingerprint(context) !== lastFingerprint) {
        const changedRoute = proposalKey(context.inputs) !== lastKey;
        const hadDraft = !!generatedDraft;
        generatedDraft = null;
        notice(changedRoute ? 'Showing notes for this country and month.' : hadDraft ? 'The plan changed. Prepare a new draft with the updated numbers.' : 'The plan changed. Earlier evidence must be checked against these assumptions.');
      }
      render();
    },
    contextSummary() {
      const ctx = current();
      if (!ctx?.inputs || !ctx?.result) return null;
      const proposal = store.get(proposalKey(ctx.inputs));
      const priorities = priorityActions(ctx, proposal);
      const fingerprint = proposalFingerprint(ctx);
      return { scope: 'Local notes in this browser; not independent verification.', checks: priorities.rows.map(({ id, title, status, reason, owner }) => ({ id, title, status, reason, owner })), recommended: priorities.recommended ? { id: priorities.recommended.id, title: priorities.recommended.title, why: priorities.recommended.why, owner: priorities.recommended.owner } : null, tasks: proposal.tasks.map(({ title, owner, dueDate, status, verifiedFingerprint }) => ({ title, owner, dueDate, status, evidenceMatchesCurrentPlan: status === 'verified' && verifiedFingerprint === fingerprint })), comments: proposal.comments.slice(-5).map(({ text, fingerprint: fp }) => ({ text, matchesCurrentPlan: fp === fingerprint })), decisions: proposal.decisions.slice(-3).map(({ outcome, text, fingerprint: fp }) => ({ outcome, text, matchesCurrentPlan: fp === fingerprint })), discussions: proposal.discussions.slice(-6).map(({ role, text, fingerprint: fp }) => ({ role, text, matchesCurrentPlan: fp === fingerprint })), savedVersions: proposal.versions.length };
    },
    recordDiscussion(message = {}) {
      const { role, text, source = 'local', context: discussionContext } = message;
      const ctx = discussionContext || (getContext ? getContext() : current());
      if (!ctx?.inputs || !String(text || '').trim()) return false;
      try {
        const entry = store.addDiscussion(ctx, role, text, source);
        // Main chat renders feedback against this same ID after saving/reloading.
        message.id = entry.id;
        preserveDrafts();
        render();
        return true;
      } catch (error) { notice(`Chat history was not saved: ${error.message}`, true); render(); return false; }
    },
    discussion() {
      const ctx = getContext ? getContext() : current();
      if (!ctx?.inputs) return [];
      const fingerprint = proposalFingerprint(ctx);
      return store.get(proposalKey(ctx.inputs)).discussions.map(({ id, role, text, source, createdAt, fingerprint: recordedFingerprint }) => ({ id, role: role === 'assistant' ? 'bot' : role, text, source: source || 'local', createdAt, matchesCurrentPlan: recordedFingerprint === fingerprint }));
    },
    clearDiscussion() {
      const ctx = getContext ? getContext() : current();
      if (!ctx?.inputs) return false;
      store.clearDiscussions(proposalKey(ctx.inputs));
      preserveDrafts(); render();
      return true;
    },
    exportLocalData() { return store.exportData(); },
    dispose() {
      closeDrawer(false);launcher?.removeEventListener('click',toggleDrawer);
      if (downloadReady) doc.defaultView.URL.revokeObjectURL(downloadReady.url);
      downloadReady = null;
      mount.querySelector('#pwDownloadReady')?.closest('.pw-download-ready')?.remove();
    },
  };
}
return { proposalKey, proposalFingerprint, createProposalStore, priorityActions, stakeholderDraft, createProposalWorkspace };
})();

export const proposalKey = pwInternals.proposalKey;
export const proposalFingerprint = pwInternals.proposalFingerprint;
export const createProposalStore = pwInternals.createProposalStore;
export const priorityActions = pwInternals.priorityActions;
export const stakeholderDraft = pwInternals.stakeholderDraft;
export const createProposalWorkspace = pwInternals.createProposalWorkspace;
