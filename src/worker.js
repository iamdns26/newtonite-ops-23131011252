// Outbox worker: turns outbox rows into notifications.
// Guarantees: at-least-once. Rows are claimed with FOR UPDATE SKIP LOCKED inside a transaction, so several
// workers/instances can run safely, and a crash mid-batch rolls back and the rows are simply picked up again.
// Handlers are idempotent (UNIQUE(outbox_id,user_id) + ON CONFLICT DO NOTHING), so a retry never duplicates.
const { pool, tx } = require('./db');

const MAX_ATTEMPTS = 5;
const backoffSeconds = (attempts) => Math.min(2 ** attempts, 300); // 2s, 4s, 8s, ... capped

async function teamLeads(c, teamId) {
  const r = await c.query("SELECT user_id FROM memberships WHERE team_id=$1 AND role IN ('lead','admin')", [teamId]);
  return r.rows.map((x) => x.user_id);
}

// Decide who is told what. Throws for unknown kinds so poisoned rows retry and finally land in 'dead'.
async function build(c, kind, p) {
  const tag = `#${p.item_id} ${p.title}`;
  switch (kind) {
    case 'assigned':
      return { users: [p.to], msg: `${p.actor_name} assigned you ${tag}` };
    case 'status_changed': {
      const label = String(p.to).replace(/_/g, ' ');
      if (p.to === 'awaiting_approval') return { users: await teamLeads(c, p.team_id), msg: `${p.actor_name} requests approval for ${tag}` };
      return { users: [p.assignee_id, p.created_by], msg: `${p.actor_name} moved ${tag} to ${label}` };
    }
    case 'comment':
      return { users: [p.assignee_id, p.created_by], msg: `${p.actor_name} commented on ${tag}` };
    case 'priority_changed':
      return { users: [p.assignee_id], msg: `${p.actor_name} changed priority of ${tag} to ${p.to}` };
    case 'created':
      return p.priority === 'urgent'
        ? { users: await teamLeads(c, p.team_id), msg: `Urgent item created: ${tag}` }
        : { users: [], msg: '' };
    default:
      throw new Error('unknown outbox kind: ' + kind);
  }
}

async function runOnce(limit = 20) {
  return tx(async (c) => {
    const jobs = (await c.query(
      `SELECT * FROM outbox WHERE status='pending' AND run_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit])).rows;
    let done = 0, failed = 0;
    for (const job of jobs) {
      await c.query('SAVEPOINT job'); // a failing job must not poison the rest of the batch
      try {
        const { users, msg } = await build(c, job.kind, job.payload);
        const targets = [...new Set(users)].filter((u) => u && u !== job.payload.actor_id);
        for (const u of targets)
          await c.query('INSERT INTO notifications(user_id,item_id,outbox_id,message) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
            [u, job.payload.item_id, job.id, msg]);
        await c.query("UPDATE outbox SET status='done', attempts=attempts+1, last_error=NULL WHERE id=$1", [job.id]);
        await c.query('RELEASE SAVEPOINT job'); done++;
      } catch (e) {
        await c.query('ROLLBACK TO SAVEPOINT job');
        const attempts = job.attempts + 1;
        await c.query(
          `UPDATE outbox SET attempts=$2, last_error=$3, status=$4, run_at = now() + ($5 || ' seconds')::interval WHERE id=$1`,
          [job.id, attempts, String(e.message).slice(0, 500), attempts >= MAX_ATTEMPTS ? 'dead' : 'pending', String(backoffSeconds(attempts))]);
        failed++;
      }
    }
    return { done, failed };
  });
}

function startWorker(intervalMs = 1500) {
  let stopped = false, timer;
  const loop = async () => {
    try { const r = await runOnce(); if (r.done + r.failed >= 20) return setImmediate(loop); } // drain backlog quickly
    catch (e) { console.error('outbox worker error', e.message); }
    if (!stopped) timer = setTimeout(loop, intervalMs);
  };
  loop();
  return () => { stopped = true; clearTimeout(timer); };
}

module.exports = { runOnce, startWorker, MAX_ATTEMPTS };
