const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { app, pool } = require('../src/app');
const { seed } = require('../src/seed');
const { runOnce, MAX_ATTEMPTS } = require('../src/worker');
// Process the outbox until quiet. Tolerates another worker (e.g. a running dev server) holding rows: SKIP LOCKED makes us skip them.
const drain = async () => { for (let i = 0; i < 4; i++) { await runOnce(); await new Promise((r) => setTimeout(r, 80)); } };

let base, server;
const tokens = {}, ids = {};
before(async () => {
  await seed(60);
  server = app.listen(0);
  base = 'http://localhost:' + server.address().port;
  for (const e of ['member1', 'member1b', 'lead1', 'viewer1', 'member2', 'admin']) {
    const r = await fetch(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: e + '@ops.test', password: 'password123' }) });
    tokens[e] = (await r.json()).token;
    ids[e] = (await (await api(e, 'GET', '/me')).json()).user.id;
  }
});
after(async () => { server.close(); await pool.end(); });

const api = (who, method, path, body, headers = {}) =>
  fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokens[who], ...headers },
    body: body ? JSON.stringify(body) : undefined });
const newItem = async (title = 'T', extra = {}) =>
  (await api('member1', 'POST', '/items', { title, type: 'task', priority: 'urgent', team_id: 1, ...extra })).json();
const move = (who, it, to, version) => api(who, 'POST', `/items/${it.id}/transition`, { to, version });

// ---- concurrency ----
test('concurrent claim: exactly one wins, loser gets the latest item', async () => {
  const it = await newItem();
  const rs = await Promise.all([api('member1', 'POST', `/items/${it.id}/claim`), api('member1b', 'POST', `/items/${it.id}/claim`)]);
  assert.deepStrictEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const loser = await (rs[0].status === 409 ? rs[0] : rs[1]).json();
  assert.ok(loser.latest.assignee_id);
});

test('repeating your own claim (retry after timeout) is a harmless success', async () => {
  const it = await newItem();
  assert.strictEqual((await api('member1', 'POST', `/items/${it.id}/claim`)).status, 200);
  assert.strictEqual((await api('member1', 'POST', `/items/${it.id}/claim`)).status, 200);
  const ev = await (await api('member1', 'GET', `/items/${it.id}/activity`)).json();
  assert.strictEqual(ev.events.filter((e) => e.kind === 'assigned').length, 1);
});

test('stale update rejected and data unchanged', async () => {
  const it = await newItem('orig');
  assert.strictEqual((await api('member1', 'PATCH', `/items/${it.id}`, { version: 1, title: 'first' })).status, 200);
  const stale = await api('member1b', 'PATCH', `/items/${it.id}`, { version: 1, title: 'second' });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual((await stale.json()).latest.title, 'first');
});

test('many simultaneous edits on one version: exactly one succeeds', async () => {
  const it = await newItem();
  const rs = await Promise.all([...Array(8)].map((_, i) => api(i % 2 ? 'member1' : 'member1b', 'PATCH', `/items/${it.id}`, { version: 1, title: 'race ' + i })));
  const codes = rs.map((r) => r.status);
  assert.strictEqual(codes.filter((c) => c === 200).length, 1);
  assert.strictEqual(codes.filter((c) => c === 409).length, 7);
});

test('same idempotency key creates one item (even when concurrent)', async () => {
  const body = { title: 'idem-unique-xyz', type: 'task', priority: 'low', team_id: 1 };
  const hd = { 'Idempotency-Key': 'k-' + Date.now() };
  const rs = await Promise.all([api('member1', 'POST', '/items', body, hd), api('member1', 'POST', '/items', body, hd), api('member1', 'POST', '/items', body, hd)]);
  const js = await Promise.all(rs.map((r) => r.json()));
  assert.ok(js.every((j) => j.id === js[0].id));
  const n = await pool.query("SELECT count(*) FROM work_items WHERE title='idem-unique-xyz'");
  assert.strictEqual(n.rows[0].count, '1');
});

// ---- workflow + authorization ----
test('workflow: invalid jump rejected, only a lead can approve, history recorded', async () => {
  const it = await newItem();
  assert.strictEqual((await move('member1', it, 'closed', 1)).status, 422);
  assert.strictEqual((await move('member1', it, 'in_progress', 1)).status, 200); // auto-assigns member1 (v2)
  assert.strictEqual((await move('member1', it, 'awaiting_approval', 2)).status, 200);
  assert.strictEqual((await move('member1', it, 'resolved', 3)).status, 403);
  assert.strictEqual((await move('lead1', it, 'resolved', 3)).status, 200);
  const ev = (await (await api('lead1', 'GET', `/items/${it.id}/activity`)).json()).events;
  assert.strictEqual(ev.filter((e) => e.kind === 'status_changed').length, 3);
});

test('ownership: a non-owner member cannot move someone else\'s item, a lead can', async () => {
  const it = await newItem();
  await api('member1', 'POST', `/items/${it.id}/claim`);
  const v = (await (await api('member1', 'GET', `/items/${it.id}`)).json()).version;
  assert.strictEqual((await move('member1b', it, 'in_progress', v)).status, 403);
  const caps = await (await api('member1b', 'GET', `/items/${it.id}`)).json();
  assert.deepStrictEqual(caps.can.transitions, []);
  assert.strictEqual((await move('lead1', it, 'in_progress', v)).status, 200);
});

test('four-eyes: a lead cannot approve an item assigned to themselves', async () => {
  const it = await newItem();
  assert.strictEqual((await move('lead1', it, 'in_progress', 1)).status, 200);
  assert.strictEqual((await move('lead1', it, 'awaiting_approval', 2)).status, 200);
  assert.strictEqual((await move('lead1', it, 'resolved', 3)).status, 403);
  assert.strictEqual((await move('admin', it, 'resolved', 3)).status, 200);
});

test('authorization: other team gets 404, viewer cannot write, lists are team-scoped', async () => {
  const it = await newItem();
  assert.strictEqual((await api('member2', 'GET', `/items/${it.id}`)).status, 404);
  assert.strictEqual((await api('member2', 'PATCH', `/items/${it.id}`, { version: 1, title: 'x' })).status, 404);
  assert.strictEqual((await api('member2', 'GET', `/items/${it.id}/activity`)).status, 404);
  assert.strictEqual((await api('viewer1', 'GET', `/items/${it.id}`)).status, 200);
  assert.strictEqual((await api('viewer1', 'POST', `/items/${it.id}/claim`)).status, 403);
  assert.strictEqual((await api('viewer1', 'POST', `/items/${it.id}/comments`, { text: 'hi' })).status, 403);
  const list = await (await api('member2', 'GET', '/items?limit=100')).json();
  assert.ok(list.items.length > 0 && list.items.every((i) => i.team_id !== 1));
  const forced = await (await api('member2', 'GET', '/items?team_id=1')).json(); // cannot widen scope via filters
  assert.strictEqual(forced.items.length, 0);
});

test('assignment: members cannot assign others, leads can, assignee must belong to the team', async () => {
  const it = await newItem();
  assert.strictEqual((await api('member1', 'POST', `/items/${it.id}/assign`, { assignee_id: ids.member1b, version: 1 })).status, 403);
  assert.strictEqual((await api('lead1', 'POST', `/items/${it.id}/assign`, { assignee_id: ids.member2, version: 1 })).status, 422);
  assert.strictEqual((await api('lead1', 'POST', `/items/${it.id}/assign`, { assignee_id: ids.viewer1, version: 1 })).status, 422);
  assert.strictEqual((await api('lead1', 'POST', `/items/${it.id}/assign`, { assignee_id: ids.member1b, version: 1 })).status, 200);
  assert.strictEqual((await api('lead1', 'POST', `/items/${it.id}/assign`, { assignee_id: ids.member1, version: 1 })).status, 409); // stale
});

test('server-computed capabilities match what the server enforces', async () => {
  const it = await newItem();
  const asViewer = await (await api('viewer1', 'GET', `/items/${it.id}`)).json();
  assert.deepStrictEqual([asViewer.can.edit, asViewer.can.claim, asViewer.can.assign, asViewer.can.transitions], [false, false, false, []]);
  const asMember = await (await api('member1b', 'GET', `/items/${it.id}`)).json();
  assert.deepStrictEqual([asMember.can.claim, asMember.can.assign, asMember.can.transitions], [true, false, ['in_progress']]);
});

// ---- async processing (outbox) ----
test('outbox: assignment produces exactly one notification, even if the job is processed twice', async () => {
  const it = await newItem();
  await api('lead1', 'POST', `/items/${it.id}/assign`, { assignee_id: ids.member1b, version: 1 });
  await drain();
  const count = async () => (await pool.query('SELECT count(*)::int n FROM notifications WHERE item_id=$1 AND user_id=$2', [it.id, ids.member1b])).rows[0].n;
  assert.strictEqual(await count(), 1);
  await pool.query("UPDATE outbox SET status='pending' WHERE payload->>'item_id' = $1", [String(it.id)]); // simulate redelivery
  await drain();
  assert.strictEqual(await count(), 1);
  const n = await (await api('member1b', 'GET', '/notifications')).json();
  assert.ok(n.unread >= 1 && n.items.some((x) => x.item_id === it.id));
});

test('outbox: a failing job retries with backoff, ends up dead, and does not block other jobs', async () => {
  const bad = (await pool.query("INSERT INTO outbox(kind,payload) VALUES('bogus','{}') RETURNING id")).rows[0].id;
  const it = await newItem();
  await api('lead1', 'POST', `/items/${it.id}/assign`, { assignee_id: ids.member1b, version: 1 });
  await runOnce();
  let row = (await pool.query('SELECT * FROM outbox WHERE id=$1', [bad])).rows[0];
  assert.strictEqual(row.attempts, 1);
  assert.strictEqual(row.status, 'pending');
  assert.ok(new Date(row.run_at) > new Date()); // delayed, not retried immediately
  const good = await pool.query('SELECT 1 FROM notifications WHERE item_id=$1 AND user_id=$2', [it.id, ids.member1b]);
  assert.strictEqual(good.rowCount, 1); // the healthy job in the same batch still succeeded
  for (let i = 1; i < MAX_ATTEMPTS; i++) { await pool.query('UPDATE outbox SET run_at=now() WHERE id=$1', [bad]); await runOnce(); }
  row = (await pool.query('SELECT * FROM outbox WHERE id=$1', [bad])).rows[0];
  assert.deepStrictEqual([row.status, row.attempts], ['dead', MAX_ATTEMPTS]);
});

test('approval request notifies leads but never the actor', async () => {
  const it = await newItem();
  await move('member1', it, 'in_progress', 1); await move('member1', it, 'awaiting_approval', 2);
  await drain();
  const lead = await pool.query('SELECT 1 FROM notifications WHERE item_id=$1 AND user_id=$2 AND message LIKE $3', [it.id, ids.lead1, '%requests approval%']);
  const self = await pool.query('SELECT 1 FROM notifications WHERE item_id=$1 AND user_id=$2', [it.id, ids.member1]);
  assert.strictEqual(lead.rowCount, 1);
  assert.strictEqual(self.rowCount, 0);
});

// ---- search / pagination ----
test('keyset pagination by priority visits every item once, in order', async () => {
  const seen = []; let cursor = null, lastRank = 5;
  do {
    const r = await (await api('admin', 'GET', `/items?sort=priority&limit=17${cursor ? '&cursor=' + cursor : ''}`)).json();
    for (const i of r.items) { assert.ok(i.priority_rank <= lastRank); lastRank = i.priority_rank; seen.push(i.id); }
    cursor = r.nextCursor;
  } while (cursor);
  const total = (await pool.query('SELECT count(*)::int n FROM work_items')).rows[0].n;
  assert.strictEqual(seen.length, total);
  assert.strictEqual(new Set(seen).size, total);
});

test('search: prefix match on title and jump-to-id', async () => {
  const it = await newItem('Zebrafish gateway meltdown');
  const a = await (await api('member1', 'GET', '/items?q=zebraf%20gate')).json();
  assert.deepStrictEqual(a.items.map((i) => i.id), [it.id]);
  const b = await (await api('member1', 'GET', `/items?q=%23${it.id}`)).json();
  assert.ok(b.items.some((i) => i.id === it.id));
});

test('no-op edit does not bump version or pollute history', async () => {
  const it = await newItem('same');
  const r = await (await api('member1', 'PATCH', `/items/${it.id}`, { version: 1, title: 'same' })).json();
  assert.strictEqual(r.version, 1);
});
