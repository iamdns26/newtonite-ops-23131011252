const express = require('express');
const crypto = require('crypto');
const { pool, tx } = require('./db');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const RANK = { viewer: 1, member: 2, lead: 3, admin: 4 };
const ROLE_BY_RANK = { 1: 'viewer', 2: 'member', 3: 'lead', 4: 'admin' };
const TYPES = ['incident', 'customer_issue', 'payment', 'compliance', 'task'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
// status -> { allowed next status: minimum role rank needed }. Approval (awaiting_approval -> resolved) needs a Lead/Admin
// who is NOT the assignee (four-eyes principle).
const TRANSITIONS = {
  open: { in_progress: 2 },
  in_progress: { open: 2, awaiting_approval: 2 },
  awaiting_approval: { resolved: 3, in_progress: 3 },
  resolved: { closed: 2, in_progress: 2 },
  closed: {},
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// ---------- auth helpers ----------
function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const sig = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function signToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 8 * 3600e3 })).toString('base64url');
  return body + '.' + sig(body);
}
function readToken(t) {
  try {
    const [body, s] = (t || '').split('.');
    if (!body || !s) return null;
    const a = Buffer.from(sig(body)), b = Buffer.from(s);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// ---------- shared helpers ----------
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next); // forward async errors to error handler
const log = (c, itemId, actor, kind, detail = {}) =>
  c.query('INSERT INTO activity_events(item_id,actor_id,kind,detail) VALUES($1,$2,$3,$4)', [itemId, actor, kind, detail]);
// Outbox row written in the same transaction as the change => the notification exists iff the change committed.
const enqueue = (c, kind, item, req, extra = {}) =>
  c.query('INSERT INTO outbox(kind,payload) VALUES($1,$2)', [kind, {
    item_id: item.id, title: item.title, team_id: item.team_id, assignee_id: item.assignee_id, created_by: item.created_by,
    actor_id: req.user.id, actor_name: req.user.name, ...extra }]);

// THE single permission check used by every endpoint. Non-members get 404 (don't leak existence); low role gets 403.
function authorize(req, teamId, minRole) {
  const r = req.roles.get(teamId);
  if (!r) throw new HttpError(404, 'Not found');
  if (r < RANK[minRole]) throw new HttpError(403, `Requires ${minRole} role`);
}
const ITEM_SQL = `SELECT w.*, a.name AS assignee_name, t.name AS team_name, cr.name AS creator_name
  FROM work_items w LEFT JOIN users a ON a.id=w.assignee_id JOIN teams t ON t.id=w.team_id JOIN users cr ON cr.id=w.created_by`;
async function getItem(c, id) {
  if (!Number.isInteger(id)) throw new HttpError(404, 'Not found');
  const r = await c.query(ITEM_SQL + ' WHERE w.id=$1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Not found');
  return r.rows[0];
}
const conflict = (item, msg = 'Item changed or already taken; reload') => new HttpError(409, msg, { latest: item });
const label = (s) => String(s).replace(/_/g, ' ');

// Throws if this user may not move the item to `to`. Used by both the endpoint and the capability hints sent to the UI,
// so the UI can never offer a button the server would refuse for a role reason.
function checkTransition(req, item, to) {
  const need = (TRANSITIONS[item.status] || {})[to];
  if (!need) throw new HttpError(422, `Cannot move from ${label(item.status)} to ${label(to)}`);
  authorize(req, item.team_id, ROLE_BY_RANK[need]);
  // Responsibility means something: once an item has an owner, only the owner or a lead/admin can move it along.
  if (item.assignee_id != null && item.assignee_id !== req.user.id && req.roles.get(item.team_id) < RANK.lead)
    throw new HttpError(403, `Only ${item.assignee_name || 'the assignee'} or a lead can change this item's status`);
  if (item.status === 'awaiting_approval' && to === 'resolved' && item.assignee_id === req.user.id)
    throw new HttpError(403, 'You cannot approve work assigned to yourself');
  if (to === 'awaiting_approval' && item.assignee_id == null) throw new HttpError(422, 'Assign the item before requesting approval');
}
// Capabilities are computed on the server so the frontend renders what is allowed instead of re-implementing rules.
function present(req, item) {
  const r = req.roles.get(item.team_id) || 0, open = item.status !== 'closed', mine = item.assignee_id === req.user.id;
  const ok = (fn) => { try { fn(); return true; } catch { return false; } };
  return {
    ...item,
    my_role: ROLE_BY_RANK[r],
    can: {
      edit: r >= 2 && open,
      comment: r >= 2,
      claim: r >= 2 && open && item.assignee_id == null,
      assign: r >= 3 && open,
      release: r >= 2 && item.status === 'open' && item.assignee_id != null && (mine || r >= 3),
      transitions: Object.keys(TRANSITIONS[item.status]).filter((to) => ok(() => checkTransition(req, item, to))),
    },
  };
}

const auth = h(async (req, res, next) => {
  const p = readToken((req.get('Authorization') || '').replace('Bearer ', ''));
  if (!p) throw new HttpError(401, 'Unauthenticated');
  const [u, m] = await Promise.all([
    pool.query('SELECT id, name FROM users WHERE id=$1', [p.id]),
    pool.query('SELECT m.team_id, m.role, t.name AS team_name FROM memberships m JOIN teams t ON t.id=m.team_id WHERE m.user_id=$1', [p.id]),
  ]);
  if (!u.rows[0]) throw new HttpError(401, 'Unauthenticated');
  // Roles are re-read from the DB on every request, so removing someone from a team takes effect immediately.
  req.user = u.rows[0];
  req.memberships = m.rows;
  req.roles = new Map(m.rows.map((x) => [x.team_id, RANK[x.role]]));
  next();
});

// tiny in-memory login throttle (per email); a shared store such as Redis would replace this with several instances
const attempts = new Map();
function throttle(email) {
  const now = Date.now(), a = (attempts.get(email) || []).filter((t) => now - t < 60e3);
  if (a.length >= 10) throw new HttpError(429, 'Too many attempts, try again in a minute');
  a.push(now); attempts.set(email, a);
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(express.static(__dirname + '/../public'));

app.post('/login', h(async (req, res) => {
  const { email, password } = req.body || {};
  const e = String(email || '').toLowerCase().trim();
  throttle(e);
  const r = await pool.query('SELECT * FROM users WHERE email=$1', [e]);
  const u = r.rows[0];
  if (!u || !checkPw(String(password || ''), u.pw_hash)) throw new HttpError(401, 'Wrong email or password');
  attempts.delete(e);
  res.json({ token: signToken({ id: u.id }) });
}));

app.get('/me', auth, (req, res) => res.json({ user: req.user, memberships: req.memberships }));

// Teams the caller belongs to, with assignable members (used by the assign picker and the create form).
app.get('/teams', auth, h(async (req, res) => {
  const r = await pool.query(
    `SELECT t.id, t.name, coalesce(json_agg(json_build_object('id',u.id,'name',u.name,'role',m.role) ORDER BY u.name)
        FILTER (WHERE u.id IS NOT NULL), '[]') AS members
     FROM teams t LEFT JOIN memberships m ON m.team_id=t.id LEFT JOIN users u ON u.id=m.user_id
     WHERE t.id = ANY($1) GROUP BY t.id ORDER BY t.name`, [[...req.roles.keys()]]);
  res.json(r.rows.map((t) => ({ ...t, my_role: ROLE_BY_RANK[req.roles.get(t.id)] })));
}));

// "Needs my attention": my active items, approvals waiting for me (as lead), and unclaimed urgent items.
const ACTIVE = (a) => `${a}status NOT IN ('resolved','closed')`;
const attentionSql = (a, me, leads) =>
  `((${a}assignee_id=${me} AND ${ACTIVE(a)}) OR (${a}status='awaiting_approval' AND ${a}team_id = ANY(${leads}))
    OR (${a}status='open' AND ${a}assignee_id IS NULL AND ${a}priority='urgent'))`;
const leadTeamsOf = (req) => [...req.roles].filter(([, r]) => r >= RANK.lead).map(([t]) => t);

// Dashboard counts, computed in SQL and scoped to the caller's teams.
app.get('/stats', auth, h(async (req, res) => {
  const r = await pool.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE ${attentionSql('', '$2', '$3')})::int AS attention,
            count(*) FILTER (WHERE assignee_id=$2 AND ${ACTIVE('')})::int AS mine,
            count(*) FILTER (WHERE assignee_id IS NULL AND ${ACTIVE('')})::int AS unassigned,
            count(*) FILTER (WHERE status='awaiting_approval' AND team_id = ANY($3))::int AS approvable,
            count(*) FILTER (WHERE due_date < now() AND ${ACTIVE('')})::int AS overdue,
            count(*) FILTER (WHERE priority='urgent' AND ${ACTIVE('')})::int AS urgent,
            count(*) FILTER (WHERE status='open')::int AS open,
            count(*) FILTER (WHERE status='in_progress')::int AS in_progress,
            count(*) FILTER (WHERE status='awaiting_approval')::int AS awaiting_approval,
            count(*) FILTER (WHERE status='resolved')::int AS resolved,
            count(*) FILTER (WHERE status='closed')::int AS closed
     FROM work_items WHERE team_id = ANY($1)`, [[...req.roles.keys()], req.user.id, leadTeamsOf(req)]);
  res.json(r.rows[0]);
}));

// Turn free text into a prefix tsquery ("pay gat" -> "pay:* & gat:*") that the GIN index can serve.
function tsQuery(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.slice(0, 8).map((w) => w + ':*').join(' & ');
}

// List: server-side filters + search + keyset pagination, always scoped to the caller's teams.
app.get('/items', auth, h(async (req, res) => {
  const q = req.query, teams = [...req.roles.keys()];
  const where = ['w.team_id = ANY($1)'], p = [teams];
  const bind = (v) => { p.push(v); return '$' + p.length; };
  if (q.status) where.push(`w.status = ${bind(String(q.status))}`);
  if (q.priority) where.push(`w.priority = ${bind(String(q.priority))}`);
  if (q.type) where.push(`w.type = ${bind(String(q.type))}`);
  if (q.team_id) where.push(`w.team_id = ${bind(Number(q.team_id) || 0)}`);
  if (q.assignee === 'me') where.push(`w.assignee_id = ${bind(req.user.id)}`);
  if (q.created_by === 'me') where.push(`w.created_by = ${bind(req.user.id)}`);
  if (q.unassigned === '1') where.push('w.assignee_id IS NULL');
  if (q.active === '1') where.push(ACTIVE('w.'));
  if (q.overdue === '1') where.push(`w.due_date < now() AND ${ACTIVE('w.')}`);
  if (q.approvable === '1') where.push(`w.status = 'awaiting_approval' AND w.team_id = ANY(${bind(leadTeamsOf(req))})`);
  if (q.attention === '1') where.push(attentionSql('w.', bind(req.user.id), bind(leadTeamsOf(req))));
  if (q.q) {
    const raw = String(q.q).trim(), ts = tsQuery(raw);
    const text = ts ? `to_tsvector('simple', w.title) @@ to_tsquery('simple', ${bind(ts)})` : 'false';
    // "#123" or "123" jumps straight to an item id, otherwise prefix full-text search on the title
    where.push(/^#?\d{1,9}$/.test(raw) ? `(w.id = ${bind(Number(raw.replace('#', '')))} OR ${text})` : text);
  }
  const byPriority = q.sort === 'priority';
  if (q.cursor) {
    const [a, b] = String(q.cursor).split(':').map(Number);
    if (byPriority && Number.isFinite(a) && Number.isFinite(b)) where.push(`(w.priority_rank, w.id) < (${bind(a)}, ${bind(b)})`);
    else if (!byPriority && Number.isFinite(a)) where.push(`w.id < ${bind(a)}`);
  }
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
  const order = byPriority ? 'w.priority_rank DESC, w.id DESC' : 'w.id DESC';
  const r = await pool.query(`${ITEM_SQL} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit + 1}`, p);
  const items = r.rows.slice(0, limit), last = items[items.length - 1];
  res.json({ items, nextCursor: r.rows.length > limit ? (byPriority ? `${last.priority_rank}:${last.id}` : String(last.id)) : null });
}));

function validateFields(b, partial) {
  const out = {};
  if (!partial || b.title !== undefined) {
    const t = String(b.title ?? '').trim();
    if (!t || t.length > 200) throw new HttpError(400, 'Title is required (max 200 characters)');
    out.title = t;
  }
  if (b.description !== undefined) {
    if (typeof b.description !== 'string' || b.description.length > 5000) throw new HttpError(400, 'Description must be text up to 5000 characters');
    out.description = b.description;
  }
  if (b.priority !== undefined) {
    if (!PRIORITIES.includes(b.priority)) throw new HttpError(400, 'Invalid priority');
    out.priority = b.priority;
  }
  if (b.due_date !== undefined) {
    if (b.due_date === null || b.due_date === '') out.due_date = null;
    else if (Number.isNaN(Date.parse(b.due_date))) throw new HttpError(400, 'Invalid due date');
    else out.due_date = new Date(b.due_date).toISOString();
  }
  return out;
}

// Create: idempotent via Idempotency-Key header. The key row is inserted in the SAME transaction as the item,
// so a concurrent duplicate blocks on the unique key until we commit, then replays our stored response.
app.post('/items', auth, h(async (req, res) => {
  const b = req.body || {}, key = req.get('Idempotency-Key');
  if (!TYPES.includes(b.type) || !PRIORITIES.includes(b.priority) || !Number.isInteger(b.team_id)) throw new HttpError(400, 'type, priority, team_id are required/valid');
  const f = validateFields(b, false);
  authorize(req, b.team_id, 'member');
  const { item, replay } = await tx(async (c) => {
    if (key) {
      const k = await c.query('INSERT INTO idempotency_keys(key,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [key, req.user.id]);
      if (!k.rowCount) {
        const s = await c.query('SELECT response FROM idempotency_keys WHERE key=$1 AND user_id=$2', [key, req.user.id]);
        return { item: s.rows[0].response, replay: true };
      }
    }
    const r = await c.query(
      'INSERT INTO work_items(title,description,type,priority,team_id,created_by,due_date) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',
      [f.title, f.description || '', b.type, b.priority, b.team_id, req.user.id, f.due_date || null]);
    const created = await getItem(c, r.rows[0].id);
    await log(c, created.id, req.user.id, 'created', { priority: b.priority });
    await enqueue(c, 'created', created, req, { priority: b.priority });
    if (key) await c.query('UPDATE idempotency_keys SET response=$3 WHERE key=$1 AND user_id=$2', [key, req.user.id, created]);
    return { item: created, replay: false };
  });
  if (replay) res.set('Idempotent-Replay', 'true');
  res.status(replay ? 200 : 201).json(present(req, item));
}));

app.get('/items/:id', auth, h(async (req, res) => {
  const item = await getItem(pool, Number(req.params.id));
  authorize(req, item.team_id, 'viewer');
  res.json(present(req, item));
}));

// Edit with optimistic locking: UPDATE only matches if the client's version is still current.
app.patch('/items/:id', auth, h(async (req, res) => {
  const b = req.body || {}, id = Number(req.params.id);
  if (!Number.isInteger(b.version)) throw new HttpError(400, 'version is required');
  const f = validateFields(b, true);
  const out = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req, cur.team_id, 'member');
    if (cur.status === 'closed') throw new HttpError(422, 'Closed items cannot be edited; reopen first');
    if (cur.version !== b.version) throw conflict(cur);
    const norm = (k, v) => (k === 'due_date' ? (v ? new Date(v).getTime() : null) : v);
    const changed = Object.keys(f).filter((k) => norm(k, f[k]) !== norm(k, cur[k]));
    if (!changed.length) return cur; // nothing to do: no version bump, no noise in history
    const m = { ...cur, ...f };
    const r = await c.query(
      `UPDATE work_items SET title=$3, description=$4, priority=$5, due_date=$6, version=version+1, updated_at=now()
       WHERE id=$1 AND version=$2`, [id, b.version, m.title, m.description, m.priority, m.due_date]);
    if (!r.rowCount) throw conflict(await getItem(c, id)); // lost a race between our read and write
    const next = await getItem(c, id);
    if (changed.includes('priority')) {
      await log(c, id, req.user.id, 'priority_changed', { from: cur.priority, to: f.priority });
      await enqueue(c, 'priority_changed', next, req, { from: cur.priority, to: f.priority });
    }
    const other = changed.filter((k) => k !== 'priority');
    if (other.length) await log(c, id, req.user.id, 'edited', { fields: other, ...(other.includes('title') ? { from: cur.title, to: f.title } : {}) });
    return next;
  });
  res.json(present(req, out));
}));

// Atomic claim: conditional UPDATE, 0 rows = someone else won. Repeating your own successful claim is a no-op success.
app.post('/items/:id/claim', auth, h(async (req, res) => {
  const id = Number(req.params.id);
  const out = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req, cur.team_id, 'member');
    if (cur.assignee_id === req.user.id) return cur; // retry of a request that already succeeded
    if (cur.status === 'closed') throw new HttpError(422, 'Closed items cannot be claimed');
    const r = await c.query('UPDATE work_items SET assignee_id=$2, version=version+1, updated_at=now() WHERE id=$1 AND assignee_id IS NULL', [id, req.user.id]);
    if (!r.rowCount) throw conflict(await getItem(c, id), 'Someone else just took this item');
    const next = await getItem(c, id);
    await log(c, id, req.user.id, 'assigned', { from: null, to: req.user.id, to_name: req.user.name });
    return next;
  });
  res.json(present(req, out));
}));

// Assign / reassign / unassign (assignee_id: null). Version-checked. Leads can assign anyone in the team;
// members can only release their own item.
app.post('/items/:id/assign', auth, h(async (req, res) => {
  const id = Number(req.params.id), { version } = req.body || {}, target = (req.body || {}).assignee_id;
  if (!Number.isInteger(version)) throw new HttpError(400, 'version is required');
  if (target !== null && !Number.isInteger(target)) throw new HttpError(400, 'assignee_id must be a user id or null');
  const out = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req, cur.team_id, 'member');
    if (cur.status === 'closed') throw new HttpError(422, 'Closed items cannot be reassigned');
    if (cur.version !== version) throw conflict(cur);
    let toName = null;
    if (target === null) {
      if (cur.status !== 'open') throw new HttpError(422, 'Move the item back to Open before unassigning');
      if (cur.assignee_id !== req.user.id) authorize(req, cur.team_id, 'lead');
    } else {
      if (target !== req.user.id || (cur.assignee_id != null && cur.assignee_id !== req.user.id)) authorize(req, cur.team_id, 'lead');
      const m = await c.query(
        `SELECT u.name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.user_id=$1 AND m.team_id=$2 AND m.role <> 'viewer'`, [target, cur.team_id]);
      if (!m.rows[0]) throw new HttpError(422, 'Assignee must be a non-viewer member of the item\'s team');
      toName = m.rows[0].name;
    }
    if (cur.assignee_id === target) return cur;
    const r = await c.query('UPDATE work_items SET assignee_id=$3, version=version+1, updated_at=now() WHERE id=$1 AND version=$2', [id, version, target]);
    if (!r.rowCount) throw conflict(await getItem(c, id));
    const next = await getItem(c, id);
    await log(c, id, req.user.id, 'assigned', { from: cur.assignee_id, from_name: cur.assignee_name, to: target, to_name: toName });
    if (target) await enqueue(c, 'assigned', next, req, { to: target });
    return next;
  });
  res.json(present(req, out));
}));

// Workflow: allowed-transitions map + role check + version check, all server side.
app.post('/items/:id/transition', auth, h(async (req, res) => {
  const { to, version } = req.body || {}, id = Number(req.params.id);
  if (!Number.isInteger(version)) throw new HttpError(400, 'version is required');
  const out = await tx(async (c) => {
    const cur = await getItem(c, id);
    authorize(req, cur.team_id, 'viewer');
    checkTransition(req, cur, to);
    if (cur.version !== version) throw conflict(cur);
    // Starting work on an unassigned item assigns it to you, atomically with the status change.
    const autoAssign = to === 'in_progress' && cur.assignee_id == null;
    const r = await c.query(
      'UPDATE work_items SET status=$3, assignee_id=CASE WHEN $5::boolean THEN $4::int ELSE assignee_id END, version=version+1, updated_at=now() WHERE id=$1 AND version=$2',
      [id, version, to, req.user.id, autoAssign]);
    if (!r.rowCount) throw conflict(await getItem(c, id));
    const next = await getItem(c, id);
    if (autoAssign) await log(c, id, req.user.id, 'assigned', { from: null, to: req.user.id, to_name: req.user.name });
    await log(c, id, req.user.id, 'status_changed', { from: cur.status, to });
    await enqueue(c, 'status_changed', next, req, { from: cur.status, to });
    return next;
  });
  res.json(present(req, out));
}));

app.post('/items/:id/comments', auth, h(async (req, res) => {
  const id = Number(req.params.id), text = String((req.body || {}).text || '').trim();
  if (!text || text.length > 2000) throw new HttpError(400, 'Comment is required (max 2000 characters)');
  await tx(async (c) => {
    const item = await getItem(c, id);
    authorize(req, item.team_id, 'member');
    await log(c, id, req.user.id, 'comment', { text });
    await enqueue(c, 'comment', item, req);
  });
  res.status(201).json({ ok: true });
}));

// History, newest first, paginated (histories grow without bound).
app.get('/items/:id/activity', auth, h(async (req, res) => {
  const id = Number(req.params.id), limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
  const before = req.query.before ? Number(req.query.before) : null;
  authorize(req, (await getItem(pool, id)).team_id, 'viewer');
  const r = await pool.query(
    `SELECT e.id, e.kind, e.detail, e.created_at, e.actor_id, u.name AS actor FROM activity_events e JOIN users u ON u.id=e.actor_id
     WHERE e.item_id=$1 AND ($2::bigint IS NULL OR e.id < $2) ORDER BY e.id DESC LIMIT ${limit + 1}`, [id, before]);
  const events = r.rows.slice(0, limit);
  res.json({ events, nextBefore: r.rows.length > limit ? events[events.length - 1].id : null });
}));

// Notifications are produced asynchronously by the outbox worker.
app.get('/notifications', auth, h(async (req, res) => {
  const base = 'FROM notifications n JOIN work_items w ON w.id=n.item_id WHERE n.user_id=$1 AND w.team_id = ANY($2)';
  const args = [req.user.id, [...req.roles.keys()]];
  const [list, unread] = await Promise.all([
    pool.query(`SELECT n.id, n.item_id, n.message, n.read_at, n.created_at ${base} ORDER BY n.id DESC LIMIT 30`, args),
    pool.query(`SELECT count(*)::int AS n ${base} AND n.read_at IS NULL`, args),
  ]);
  res.json({ items: list.rows, unread: unread.rows[0].n });
}));
app.post('/notifications/read', auth, h(async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.filter(Number.isInteger) : null;
  await pool.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND ($2::bigint[] IS NULL OR id = ANY($2))', [req.user.id, ids]);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => { // central error handler
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

module.exports = { app, pool, hash, HttpError };
