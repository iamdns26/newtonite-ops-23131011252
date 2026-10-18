'use strict';
/* Relay frontend — vanilla JS, no build step.
 * State lives in one object (S). The server is the source of truth: the UI applies optimistic changes for fast
 * actions (claim, status moves), then replaces them with the server's answer, or re-fetches if the server disagreed.
 * Which buttons appear comes from `item.can` (computed by the server), not from rules duplicated here. */

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nice = (s) => esc(String(s).replace(/_/g, ' '));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const QUEUES = {
  attention: { label: 'Needs my attention', qs: 'attention=1', hot: true },
  mine: { label: 'Assigned to me', qs: 'assignee=me&active=1' },
  approve: { label: 'Awaiting my approval', qs: 'approvable=1', stat: 'approvable', hot: true },
  unassigned: { label: 'Unassigned', qs: 'unassigned=1&active=1' },
  overdue: { label: 'Overdue', qs: 'overdue=1', hot: true },
  all: { label: 'All work', qs: '', stat: 'total' },
};
const STATUSES = ['open', 'in_progress', 'awaiting_approval', 'resolved', 'closed'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
const DEMO = [['admin', 'Admin', 'all teams'], ['lead1', 'Lead', 'Payments'], ['member1', 'Member', 'Payments'], ['member1b', 'Member #2', 'Payments'],
  ['viewer1', 'Viewer', 'Payments'], ['lead2', 'Lead', 'Support'], ['member2', 'Member', 'Support'], ['lead3', 'Lead', 'Compliance']];

const S = {
  token: localStorage.getItem('relay.token'), me: null, teams: [], stats: {}, notif: { items: [], unread: 0 },
  queue: 'attention', filters: { status: '', priority: '', type: '', team_id: '' }, sort: 'priority', q: '', view: 'list',
  items: [], cursor: null, loadingList: false, listError: null, seq: 0, board: {},
  sel: null, events: [], eventsNext: null, editing: false, draft: null, conflict: false, bellOpen: false, modal: null,
};

// ---------- helpers ----------
const hue = (id) => (Number(id) * 67) % 360;
const initials = (n) => String(n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const avatar = (id, name) => `<span class="avatar" style="background:hsl(${hue(id)} 45% 42%)" title="${esc(name)}">${esc(initials(name))}</span>`;
const who = (id, name) => (id == null ? '<span class="mut">Unassigned</span>' : `${avatar(id, name)} ${id === S.me.id ? 'You' : esc(name)}`);
function rel(d) {
  const s = (Date.now() - new Date(d)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  if (s < 86400 * 14) return Math.round(s / 86400) + ' d ago';
  return new Date(d).toLocaleDateString();
}
function due(item) {
  if (!item.due_date) return { text: 'No due date', over: false };
  const days = Math.ceil((new Date(item.due_date) - Date.now()) / 864e5), active = !['resolved', 'closed'].includes(item.status);
  if (days < 0 && active) return { text: `Overdue ${-days}d`, over: true };
  if (days === 0) return { text: 'Due today', over: false };
  return { text: days > 0 ? `Due in ${days}d` : new Date(item.due_date).toLocaleDateString(), over: false };
}
function toast(msg, kind = '') {
  const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg;
  $('#toasts').append(t); setTimeout(() => t.remove(), kind ? 5000 : 2800);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

async function api(method, path, body, headers = {}) {
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 15000);
  let r;
  try {
    r = await fetch(path, { method, signal: ctrl.signal, body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}), ...headers } });
  } catch (e) {
    throw Object.assign(new Error(e.name === 'AbortError' ? 'The server took too long to answer' : 'Network problem — check your connection'), { network: true });
  } finally { clearTimeout(timer); }
  let j = null; try { j = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && S.token) { logout(); throw Object.assign(new Error('Session expired, please sign in again'), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error((j && j.error) || 'Request failed'), { status: r.status, data: j });
  return j;
}

// ---------- auth ----------
function renderLogin(err = '') {
  $('#root').innerHTML = `<div class="login"><div class="hero"><div class="logo" style="color:#fff"><i style="background:#fff"></i>Relay</div>
    <h1>One place for work that can't get lost.</h1>
    <p>Requests, incidents and approvals with a clear owner, a visible next step, and a history that explains every decision.</p></div>
    <form class="form" id="lf"><h2>Sign in</h2><span class="mut">Use a demo account to explore different roles (password: password123)</span>
    <label class="lb" for="em">Email</label><input class="fld" id="em" autocomplete="username" value="member1@ops.test">
    <label class="lb" for="pw">Password</label><input class="fld" id="pw" type="password" autocomplete="current-password" value="password123">
    <div class="err" id="le">${esc(err)}</div><button class="btn pri" id="lb" style="padding:9px">Sign in</button>
    <label class="lb" style="margin-top:22px">Quick demo logins</label>
    <div class="demo">${DEMO.map(([k, r, t]) => `<button type="button" data-demo="${k}"><b>${r}</b><span>${t}</span></button>`).join('')}</div></form></div>`;
  $('#lf').onsubmit = (e) => { e.preventDefault(); login($('#em').value, $('#pw').value); };
  document.querySelectorAll('[data-demo]').forEach((b) => (b.onclick = () => login(b.dataset.demo + '@ops.test', 'password123')));
}
async function login(email, password) {
  const btn = $('#lb'); if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/login', { email, password });
    S.token = r.token; localStorage.setItem('relay.token', r.token); await boot();
  } catch (e) { if (btn) btn.disabled = false; $('#le').textContent = e.message; }
}
function logout() {
  S.token = null; S.me = null; S.sel = null; localStorage.removeItem('relay.token'); clearInterval(S.timers); renderLogin();
}
async function boot() {
  try {
    const [me, teams] = await Promise.all([api('GET', '/me'), api('GET', '/teams')]);
    S.me = me.user; S.teams = teams;
  } catch (e) { return renderLogin(); }
  S.queue = 'attention'; renderShell(); refreshAll();
  clearInterval(S.timers);
  // gentle polling keeps lists, counts, notifications and the open item fresh without a websocket
  S.timers = setInterval(() => {
    if (document.hidden) return;
    loadNotifs(); checkOpenItem();
    if (++S.tick % 3 === 0) { loadStats(); loadList(true, true); }
  }, 10000);
  S.tick = 0;
}

// ---------- shell ----------
function renderShell() {
  $('#root').innerHTML = `<div class="shell">
  <header class="top"><div class="logo"><i></i>Relay</div>
    <div class="searchbox"><input class="fld" id="search" placeholder="Search by title or #id" aria-label="Search work items" value="${esc(S.q)}"><span class="kbd">/</span></div>
    <button class="btn pri" data-act="new">+ New item</button><span class="spacer"></span>
    <div class="menu bell"><button class="btn ghost" data-act="bell" aria-label="Notifications">🔔<span class="dot hide" id="nd">0</span></button><div id="pop"></div></div>
    <div class="menu" style="display:flex;align-items:center;gap:8px">${avatar(S.me.id, S.me.name)}<span class="hide-sm">${esc(S.me.name)}</span>
      <button class="btn sm" data-act="logout">Sign out</button></div></header>
  <div class="body" id="body"><nav class="queues" id="queues" aria-label="Queues"></nav>
    <main class="center"><div class="toolbar" id="toolbar"></div><div id="banner"></div><div class="scroll" id="scroll"><div id="content"></div><div id="more"></div></div></main>
    <aside class="detail hide" id="detail" aria-label="Item details"></aside></div></div>`;
  $('#search').addEventListener('input', debounce((e) => { S.q = e.target.value.trim(); loadList(true); }, 250));
  new IntersectionObserver((en) => { if (en[0].isIntersecting) loadList(false); }, { root: $('#scroll'), rootMargin: '200px' }).observe($('#more'));
  renderQueues(); renderToolbar(); renderBell();
}
function renderQueues() {
  const st = S.stats;
  const n = (k) => { const v = st[QUEUES[k].stat || k]; return v == null ? '' : `<span class="n ${QUEUES[k].hot && v ? 'hot' : ''}">${v}</span>`; };
  $('#queues').innerHTML = Object.entries(QUEUES).map(([k, q]) => `<button class="q ${S.queue === k ? 'on' : ''}" data-act="queue" data-k="${k}">${q.label}${n(k)}</button>`).join('') +
    `<h6>By status</h6>` + STATUSES.map((s) => `<button class="q ${S.filters.status === s ? 'on' : ''}" data-act="statusf" data-k="${s}">${cap(s.replace(/_/g, ' '))}<span class="n">${st[s] ?? ''}</span></button>`).join('');
}
function renderToolbar() {
  const opt = (arr, cur, all) => `<option value="">${all}</option>` + arr.map((v) => `<option value="${esc(v.v ?? v)}" ${String(v.v ?? v) === String(cur) ? 'selected' : ''}>${esc(v.t ?? cap(String(v).replace(/_/g, ' ')))}</option>`).join('');
  $('#toolbar').innerHTML = `<h1>${QUEUES[S.queue].label}</h1>
    <select class="fld" data-f="priority" aria-label="Priority">${opt(PRIORITIES, S.filters.priority, 'Any priority')}</select>
    <select class="fld" data-f="type" aria-label="Type">${opt(TYPES, S.filters.type, 'Any type')}</select>
    ${S.teams.length > 1 ? `<select class="fld" data-f="team_id" aria-label="Team">${opt(S.teams.map((t) => ({ v: t.id, t: t.name })), S.filters.team_id, 'All my teams')}</select>` : ''}
    <select class="fld" data-f="sort" aria-label="Sort"><option value="priority" ${S.sort === 'priority' ? 'selected' : ''}>Sort: priority</option><option value="newest" ${S.sort === 'newest' ? 'selected' : ''}>Sort: newest</option></select>
    ${S.filters.status ? `<button class="btn sm" data-act="statusf" data-k="${S.filters.status}">Status: ${nice(S.filters.status)} ✕</button>` : ''}
    <span class="spacer"></span><div class="seg"><button class="${S.view === 'list' ? 'on' : ''}" data-act="view" data-k="list">List</button><button class="${S.view === 'board' ? 'on' : ''}" data-act="view" data-k="board">Board</button></div>`;
}
function renderBell() {
  const dot = $('#nd'); if (!dot) return;
  dot.textContent = S.notif.unread > 99 ? '99+' : S.notif.unread; dot.classList.toggle('hide', !S.notif.unread);
  $('#pop').innerHTML = !S.bellOpen ? '' : `<div class="pop"><header>Notifications<button class="btn sm" data-act="readall">Mark all read</button></header>` +
    (S.notif.items.length ? S.notif.items.map((n) => `<div class="nitem ${n.read_at ? '' : 'unread'}" data-act="notif" data-id="${n.item_id}" data-nid="${n.id}"><div>${esc(n.message)}<div class="sm mut">${rel(n.created_at)}</div></div></div>`).join('')
      : '<div class="empty">Nothing yet. You\'ll be told when work is assigned to you or needs your approval.</div>') + '</div>';
}

// ---------- data loading ----------
async function refreshAll() { await Promise.all([loadStats(), loadList(true), loadNotifs()]); }
async function loadStats() { try { S.stats = await api('GET', '/stats'); renderQueues(); } catch (e) { /* non-critical */ } }
async function loadNotifs() { try { S.notif = await api('GET', '/notifications'); renderBell(); } catch (e) { /* non-critical */ } }
function listQuery(extra = '', omitStatus = false) {
  const f = S.filters, p = [QUEUES[S.queue].qs, !omitStatus && f.status && 'status=' + f.status, f.priority && 'priority=' + f.priority, f.type && 'type=' + f.type,
    f.team_id && 'team_id=' + f.team_id, S.q && 'q=' + encodeURIComponent(S.q), S.sort === 'priority' ? 'sort=priority' : '', extra];
  return p.filter(Boolean).join('&');
}
// `seq` guards against out-of-order responses: if the user changed filters while a request was in flight, the old answer is dropped.
async function loadList(reset, silent = false) {
  if (!reset && (S.loadingList || !S.cursor || S.view === 'board')) return;
  const seq = reset ? ++S.seq : S.seq; S.loadingList = true; S.listError = null;
  if (reset && !silent) { S.items = []; S.board = {}; S.cursor = null; renderList(true); }
  try {
    if (S.view === 'board') {
      // one request per status column; a status filter simply empties the other columns
      const cols = await Promise.all(STATUSES.map((s) => (S.filters.status && S.filters.status !== s ? { items: [], nextCursor: null }
        : api('GET', '/items?' + listQuery('limit=15&status=' + s, true)))));
      if (seq !== S.seq) return;
      STATUSES.forEach((s, i) => (S.board[s] = { items: cols[i].items, cursor: cols[i].nextCursor }));
    } else {
      const r = await api('GET', '/items?' + listQuery('limit=25' + (reset ? '' : '&cursor=' + S.cursor)));
      if (seq !== S.seq) return;
      S.items = reset ? r.items : S.items.concat(r.items); S.cursor = r.nextCursor;
    }
  } catch (e) { if (seq === S.seq) S.listError = e.message; }
  if (seq === S.seq) { S.loadingList = false; renderList(); }
}
async function loadColumn(s) {
  const c = S.board[s]; if (!c || !c.cursor) return;
  const r = await api('GET', '/items?' + listQuery(`limit=15&status=${s}&cursor=${c.cursor}`, true));
  c.items = c.items.concat(r.items); c.cursor = r.nextCursor; renderList();
}

// ---------- list / board rendering ----------
function rowHtml(i) {
  const d = due(i);
  return `<div class="row p-${i.priority} ${S.sel && S.sel.id === i.id ? 'sel' : ''} ${i._pending ? 'pending' : ''}" data-act="open" data-id="${i.id}" tabindex="0">
    <span class="bar"></span><div style="min-width:0"><div class="t1"><span class="mono mut sm">#${i.id}</span><span class="title">${esc(i.title)}</span></div>
    <div class="t2"><span class="tag p-${i.priority}">${i.priority}</span><span>${esc(i.team_name)} · ${nice(i.type)}</span><span class="due ${d.over ? 'over' : ''}">${d.text}</span></div></div>
    <div class="right"><span>${who(i.assignee_id, i.assignee_name)}</span><span class="pill st-${i.status}">${nice(i.status)}</span></div></div>`;
}
function cardHtml(i) {
  const d = due(i);
  return `<div class="card p-${i.priority} ${S.sel && S.sel.id === i.id ? 'sel' : ''}" data-act="open" data-id="${i.id}" tabindex="0">
    <div class="sm mut mono">#${i.id} · ${esc(i.team_name)}</div><div class="title">${esc(i.title)}</div>
    <div class="sm" style="display:flex;justify-content:space-between;align-items:center"><span class="due ${d.over ? 'over' : ''}">${d.text}</span><span>${i.assignee_id ? avatar(i.assignee_id, i.assignee_name) : '<span class="mut">—</span>'}</span></div></div>`;
}
function renderList(loading = false) {
  const el = $('#content'); if (!el) return;
  if (S.listError) { el.innerHTML = `<div class="banner err" style="margin:0">Couldn't load work: ${esc(S.listError)} <button class="btn sm" data-act="retry">Retry</button></div>`; $('#more').innerHTML = ''; return; }
  if (loading) { el.innerHTML = `<div class="list">${'<div class="skel"></div>'.repeat(6)}</div>`; return; }
  if (S.view === 'board') {
    el.innerHTML = `<div class="board">${STATUSES.map((s) => { const c = S.board[s] || { items: [] };
      return `<div class="col"><h5><span>${nice(s)}</span><span>${c.items.length}${c.cursor ? '+' : ''}</span></h5>${c.items.map(cardHtml).join('') || '<div class="sm mut" style="padding:6px">Nothing here</div>'}${c.cursor ? `<button class="btn sm" data-act="col" data-k="${s}">Load more</button>` : ''}</div>`; }).join('')}</div>`;
    $('#more').innerHTML = ''; return;
  }
  el.innerHTML = S.items.length ? `<div class="list">${S.items.map(rowHtml).join('')}</div>`
    : `<div class="list"><div class="empty"><b>Nothing here.</b><br>${S.q || S.filters.priority || S.filters.type || S.filters.status ? 'No work matches these filters.' : S.queue === 'all' ? 'No work items yet — create the first one.' : "You're all caught up in this queue."}</div></div>`;
  $('#more').innerHTML = S.cursor ? '<div class="empty sm">Loading more…</div>' : (S.items.length > 25 ? '<div class="empty sm">End of list</div>' : '');
}
function patchLocal(item) { // keep the list/board copy of an item in sync with the latest known server state
  const swap = (arr) => { const k = arr.findIndex((x) => x.id === item.id); if (k >= 0) arr[k] = { ...arr[k], ...item, can: undefined }; };
  swap(S.items); Object.values(S.board).forEach((c) => swap(c.items));
}

// ---------- detail pane ----------
function nextStep(i) {
  const d = due(i), can = i.can || { transitions: [] };
  if (i.status === 'closed') return ['calm', 'Closed — nothing left to do.'];
  if (i.status === 'awaiting_approval') return can.transitions.includes('resolved') ? ['', 'Waiting on you: review the work, then approve or send it back.'] : ['warn', i.assignee_id === S.me.id ? 'Waiting for another lead to approve your work.' : 'Waiting for a lead to approve.'];
  if (d.over) return ['bad', `${d.text.replace('Overdue', 'Overdue by')} — needs attention now.`];
  if (i.assignee_id == null) return ['warn', can.claim ? 'Nobody owns this yet. Claim it to take responsibility.' : 'Nobody owns this yet — waiting for someone on the team to pick it up.'];
  if (i.status === 'resolved') return ['', 'Resolved. Close it once the requester confirms.'];
  if (i.status === 'in_progress') return ['', i.assignee_id === S.me.id ? 'You\'re on it. Request approval when the work is done.' : `${i.assignee_name} is working on this.`];
  return ['', i.assignee_id === S.me.id ? 'Assigned to you — start work when ready.' : `Assigned to ${i.assignee_name}; work hasn't started yet.`];
}
const transLabel = (from, to) => ({ in_progress: from === 'open' ? 'Start work' : from === 'resolved' ? 'Reopen' : 'Send back', open: 'Return to open', awaiting_approval: 'Request approval', resolved: 'Approve & resolve', closed: 'Close' }[to]);

function renderDetail() {
  const el = $('#detail'), i = S.sel; if (!el) return;
  $('#body').classList.toggle('has-detail', !!i); el.classList.toggle('hide', !i);
  if (!i) { el.innerHTML = ''; return; }
  const can = i.can || { transitions: [] }, busy = i._pending ? 'disabled' : '', [tone, msg] = nextStep(i), d = due(i);
  const team = S.teams.find((t) => t.id === i.team_id), assignable = (team ? team.members : []).filter((m) => m.role !== 'viewer');
  el.innerHTML = `<div class="dh"><div style="display:flex;justify-content:space-between;align-items:center"><span class="mono mut sm">#${i.id} · ${esc(i.team_name)}</span>
      <button class="btn ghost sm" data-act="close" aria-label="Close details">✕ Close</button></div>
    <h2>${esc(i.title)}</h2><div class="meta"><span class="pill st-${i.status}">${nice(i.status)}</span><span class="tag p-${i.priority}">${i.priority} priority</span><span class="mut sm">${nice(i.type)}</span>${i._pending ? '<span class="sm mut">Saving…</span>' : ''}</div></div>
  <div class="dbody">
    ${S.conflict ? `<div class="banner err" style="margin:0 0 12px">Someone else changed this item while you were editing. Your draft is kept below; review it and save again.</div>` : ''}
    <div class="next ${tone}">${esc(msg)}</div>
    ${i.my_role === 'viewer' ? '<div class="sm mut" style="margin-bottom:12px">You have view-only access to this team.</div>' : ''}
    <div class="acts">
      ${can.claim ? `<button class="btn pri" data-act="claim" ${busy}>Claim this item</button>` : ''}
      ${can.transitions.map((t) => `<button class="btn ${t === 'resolved' || t === 'awaiting_approval' || (t === 'in_progress' && i.status === 'open') ? 'pri' : ''}" data-act="move" data-to="${t}" ${busy}>${transLabel(i.status, t)}</button>`).join('')}
      ${can.release ? `<button class="btn" data-act="release" ${busy}>Unassign</button>` : ''}
      ${can.edit && !S.editing ? `<button class="btn" data-act="edit">Edit details</button>` : ''}
    </div>
    ${can.assign ? `<div class="acts" style="margin-top:10px"><select class="fld" id="asg" style="width:auto" aria-label="Assign to"><option value="">Assign to…</option>${assignable.map((m) => `<option value="${m.id}" ${m.id === i.assignee_id ? 'disabled' : ''}>${esc(m.name)} (${m.role})</option>`).join('')}</select><button class="btn" data-act="assign" ${busy}>Assign</button></div>` : ''}
    <div class="sec">Details</div>
    ${S.editing ? editForm(i) : `<p class="desc ${i.description ? '' : 'mut'}">${esc(i.description) || 'No description yet.'}</p>`}
    <div class="grid2"><div><small>Owner</small>${who(i.assignee_id, i.assignee_name)}</div><div><small>Due</small><span class="due ${d.over ? 'over' : ''}">${i.due_date ? new Date(i.due_date).toLocaleDateString() + ' · ' + d.text : '—'}</span></div>
      <div><small>Requested by</small>${esc(i.creator_name)}</div><div><small>Last updated</small>${rel(i.updated_at)}</div></div>
    <div class="sec">Activity</div>
    ${i.can && i.can.comment ? `<div class="cbox"><textarea class="fld" id="cm" rows="1" placeholder="Add a comment…" maxlength="2000"></textarea><button class="btn pri" data-act="comment" id="cb">Post</button></div>` : ''}
    <ul class="tl">${S.events.map(eventHtml).join('')}</ul>
    ${S.eventsNext ? '<button class="btn sm" data-act="olderev">Show older activity</button>' : ''}</div>`;
}
function editForm(i) {
  const f = S.draft;
  return `<div id="ef"><label class="lb" for="e-t">Title</label><input class="fld" id="e-t" maxlength="200" value="${esc(f.title)}">
    <label class="lb" for="e-d">Description</label><textarea class="fld" id="e-d" rows="4" maxlength="5000">${esc(f.description)}</textarea>
    <div class="two"><div><label class="lb" for="e-p">Priority</label><select class="fld" id="e-p">${PRIORITIES.map((p) => `<option ${p === f.priority ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
    <div><label class="lb" for="e-due">Due date</label><input class="fld" type="date" id="e-due" value="${esc(f.due)}"></div></div>
    <div class="acts" style="margin-top:12px"><button class="btn pri" data-act="save">Save changes</button><button class="btn" data-act="cancel">Cancel</button></div></div>`;
}
function eventHtml(e) {
  const d = e.detail || {}, a = `<b>${e.actor_id === S.me.id ? 'You' : esc(e.actor)}</b>`;
  const txt = {
    created: () => `${a} created this item`,
    comment: () => `${a} commented<div class="bubble">${esc(d.text)}</div>`,
    status_changed: () => `${a} moved it from ${nice(d.from)} to <b>${nice(d.to)}</b>`,
    priority_changed: () => `${a} changed priority from ${esc(d.from)} to <b>${esc(d.to)}</b>`,
    assigned: () => d.to == null ? `${a} unassigned it${d.from_name ? ' (was ' + esc(d.from_name) + ')' : ''}` : d.to === e.actor_id ? `${a} took ownership` : `${a} assigned it to <b>${esc(d.to_name)}</b>${d.from_name ? ' (was ' + esc(d.from_name) + ')' : ''}`,
    edited: () => `${a} edited ${(d.fields || []).map(nice).join(', ')}${d.to ? ` — renamed to “${esc(d.to)}”` : ''}`,
  }[e.kind] || (() => `${a} ${nice(e.kind)}`);
  return `<li class="k-${esc(e.kind)}">${txt()}<time title="${new Date(e.created_at).toLocaleString()}">${rel(e.created_at)}</time></li>`;
}

async function openItem(id) {
  try {
    S.editing = false; S.conflict = false;
    S.sel = await api('GET', '/items/' + id); renderDetail(); renderList();
    await loadEvents(true);
  } catch (e) { toast(e.message, 'err'); }
}
async function loadEvents(reset) {
  if (!S.sel) return;
  const id = S.sel.id, r = await api('GET', `/items/${id}/activity?limit=15${!reset && S.eventsNext ? '&before=' + S.eventsNext : ''}`);
  if (!S.sel || S.sel.id !== id) return; // user navigated away
  S.events = reset ? r.events : S.events.concat(r.events); S.eventsNext = r.nextBefore;
  const keep = $('#cm') ? $('#cm').value : ''; renderDetail(); if (keep && $('#cm')) $('#cm').value = keep;
}
// Stale-data protection: poll the open item; if someone else changed it, refresh (or warn if we're mid-edit).
async function checkOpenItem() {
  const cur = S.sel; if (!cur || cur._pending) return;
  try {
    const fresh = await api('GET', '/items/' + cur.id);
    if (!S.sel || S.sel.id !== cur.id || S.sel._pending || fresh.version === S.sel.version) return;
    if (S.editing) { S.sel = fresh; S.conflict = true; } else { S.sel = fresh; toast('This item was just updated by someone else'); }
    patchLocal(fresh); await loadEvents(true); renderList();
  } catch (e) { if (e.status === 404) { S.sel = null; renderDetail(); toast('That item is no longer available to you', 'warn'); } }
}

// Optimistic mutation: show the expected result immediately, let the server decide, then reconcile.
async function mutate(optimistic, request, okMsg) {
  const id = S.sel.id;
  S.sel = { ...S.sel, ...optimistic, _pending: true }; patchLocal(S.sel); const row = S.items.find((x) => x.id === id); if (row) row._pending = true;
  renderDetail(); renderList();
  try {
    const fresh = await request();
    S.sel = fresh; patchLocal(fresh); if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.status === 409 ? e.message + ' — showing the latest version.' : e.network ? e.message + '. Checking what happened…' : e.message, e.status === 409 ? 'warn' : 'err');
    try { S.sel = await api('GET', '/items/' + id); patchLocal(S.sel); } catch (e2) { /* keep optimistic view cleared below */ }
  }
  S.items.forEach((x) => delete x._pending); if (S.sel) delete S.sel._pending;
  renderDetail(); renderList(); loadEvents(true); loadStats();
}

// ---------- create modal ----------
function openNew() {
  const teams = S.teams.filter((t) => t.my_role !== 'viewer');
  if (!teams.length) return toast('You only have view access, so you cannot create items.', 'warn');
  S.modal = { key: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()), busy: false };
  const m = document.createElement('div'); m.className = 'scrim'; m.id = 'modal';
  m.innerHTML = `<form class="modal" id="nf"><h3>New work item</h3><span class="mut">Say what needs doing and why. You can assign it afterwards.</span>
    <label class="lb" for="n-t">Title</label><input class="fld" id="n-t" maxlength="200" required autofocus placeholder="e.g. Refund stuck in pending for order #4821">
    <label class="lb" for="n-d">Description</label><textarea class="fld" id="n-d" rows="4" maxlength="5000" placeholder="What happened? What have you tried? What would 'done' look like?"></textarea>
    <div class="two"><div><label class="lb" for="n-team">Team</label><select class="fld" id="n-team">${teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div>
    <div><label class="lb" for="n-type">Type</label><select class="fld" id="n-type">${TYPES.map((t) => `<option value="${t}">${cap(t.replace(/_/g, ' '))}</option>`).join('')}</select></div>
    <div><label class="lb" for="n-p">Priority</label><select class="fld" id="n-p">${['medium', 'low', 'high', 'urgent'].map((p) => `<option>${p}</option>`).join('')}</select></div>
    <div><label class="lb" for="n-due">Due date (optional)</label><input class="fld" type="date" id="n-due"></div></div>
    <div class="err" id="n-err"></div><div class="mfoot"><button type="button" class="btn" data-act="cancelnew">Cancel</button><button class="btn pri" id="n-go">Create item</button></div></form>`;
  document.body.append(m);
  $('#nf').onsubmit = async (e) => {
    e.preventDefault(); if (S.modal.busy) return; S.modal.busy = true; $('#n-go').disabled = true; $('#n-err').textContent = '';
    try { // the same Idempotency-Key is reused on retry, so a double-click or a timeout-and-retry can never create two items
      const it = await api('POST', '/items', { title: $('#n-t').value, description: $('#n-d').value, team_id: Number($('#n-team').value), type: $('#n-type').value,
        priority: $('#n-p').value, due_date: $('#n-due').value || null }, { 'Idempotency-Key': S.modal.key });
      m.remove(); S.modal = null; toast(`Created #${it.id}`); S.queue = 'all'; S.sort = 'newest'; renderQueues(); renderToolbar(); await Promise.all([loadList(true), loadStats()]); openItem(it.id);
    } catch (err) { S.modal.busy = false; $('#n-go').disabled = false; $('#n-err').textContent = err.message + (err.network ? ' — it is safe to press Create again.' : ''); }
  };
}

// ---------- actions ----------
const ACT = {
  logout, retry: () => loadList(true), close() { S.sel = null; S.editing = false; renderDetail(); renderList(); },
  new: openNew, cancelnew() { $('#modal')?.remove(); S.modal = null; },
  queue(el) { S.queue = el.dataset.k; S.filters.status = ''; S.board = {}; renderQueues(); renderToolbar(); loadList(true); },
  statusf(el) { S.filters.status = S.filters.status === el.dataset.k ? '' : el.dataset.k; renderQueues(); renderToolbar(); loadList(true); },
  view(el) { S.view = el.dataset.k; renderToolbar(); loadList(true); },
  col: (el) => loadColumn(el.dataset.k),
  open: (el) => openItem(Number(el.dataset.id)),
  bell() { S.bellOpen = !S.bellOpen; renderBell(); },
  async readall() { await api('POST', '/notifications/read', {}); loadNotifs(); },
  async notif(el) { S.bellOpen = false; api('POST', '/notifications/read', { ids: [Number(el.dataset.nid)] }).then(loadNotifs); renderBell(); openItem(Number(el.dataset.id)); },
  claim: () => mutate({ assignee_id: S.me.id, assignee_name: S.me.name }, () => api('POST', `/items/${S.sel.id}/claim`), 'You now own this item'),
  move(el) { const to = el.dataset.to, v = S.sel.version; return mutate({ status: to }, () => api('POST', `/items/${S.sel.id}/transition`, { to, version: v }), 'Moved to ' + to.replace(/_/g, ' ')); },
  release() { const v = S.sel.version; return mutate({ assignee_id: null, assignee_name: null }, () => api('POST', `/items/${S.sel.id}/assign`, { assignee_id: null, version: v }), 'Unassigned'); },
  assign() {
    const uid = Number($('#asg').value); if (!uid) return toast('Pick someone to assign this to', 'warn');
    const v = S.sel.version, m = S.teams.find((t) => t.id === S.sel.team_id).members.find((x) => x.id === uid);
    return mutate({ assignee_id: uid, assignee_name: m.name }, () => api('POST', `/items/${S.sel.id}/assign`, { assignee_id: uid, version: v }), 'Assigned to ' + m.name);
  },
  edit() { const i = S.sel; S.editing = true; S.conflict = false; S.draft = { title: i.title, description: i.description, priority: i.priority, due: i.due_date ? i.due_date.slice(0, 10) : '' }; renderDetail(); },
  cancel() { S.editing = false; S.conflict = false; renderDetail(); },
  async save() {
    const i = S.sel, body = { version: i.version, title: $('#e-t').value, description: $('#e-d').value, priority: $('#e-p').value, due_date: $('#e-due').value || null };
    S.draft = { title: body.title, description: body.description, priority: body.priority, due: $('#e-due').value };
    try {
      const fresh = await api('PATCH', '/items/' + i.id, body); S.sel = fresh; S.editing = false; S.conflict = false; patchLocal(fresh); toast('Saved');
      renderDetail(); renderList(); loadEvents(true); loadStats();
    } catch (e) {
      if (e.status === 409) { // keep the user's draft, show the newest server version underneath, let them decide
        S.sel = await api('GET', '/items/' + i.id); S.conflict = true; patchLocal(S.sel); renderDetail(); renderList(); loadEvents(true);
      } else toast(e.message, 'err');
    }
  },
  async comment() {
    const t = $('#cm').value.trim(); if (!t) return; $('#cb').disabled = true;
    try { await api('POST', `/items/${S.sel.id}/comments`, { text: t }); $('#cm').value = ''; await loadEvents(true); }
    catch (e) { toast(e.message, 'err'); $('#cb') && ($('#cb').disabled = false); }
  },
  olderev: () => loadEvents(false),
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!e.target.closest('.bell') && S.bellOpen) { S.bellOpen = false; renderBell(); }
  if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el, e);
});
document.addEventListener('change', (e) => {
  const f = e.target.dataset.f; if (!f) return;
  if (f === 'sort') S.sort = e.target.value; else S.filters[f] = e.target.value;
  loadList(true);
});
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (e.key === 'Escape') { if ($('#modal')) ACT.cancelnew(); else if (S.sel) ACT.close(); }
  else if (e.key === '/' && !typing && $('#search')) { e.preventDefault(); $('#search').focus(); }
  else if ((e.key === 'Enter') && document.activeElement.dataset.act === 'open') ACT.open(document.activeElement);
  else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && document.activeElement.id === 'cm') ACT.comment();
});

S.token ? boot() : renderLogin();
