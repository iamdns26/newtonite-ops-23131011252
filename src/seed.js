const { pool, ensureSchema } = require('./db');
const { hash } = require('./app');

// Seeds 3 teams, 10 users (password: password123) and n realistic sample items with history.
// Pass --if-empty to skip when data already exists.
async function seed(n = 3000, ifEmpty = false) {
  await ensureSchema();
  if (ifEmpty && (await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return;
  await pool.query('TRUNCATE notifications, outbox, activity_events, idempotency_keys, work_items, memberships, users, teams RESTART IDENTITY CASCADE');
  for (const t of ['Payments', 'Support', 'Compliance']) await pool.query('INSERT INTO teams(name) VALUES($1)', [t]);
  const pw = hash('password123');
  const users = [ // [email, name, [[team_id, role], ...]]
    ['admin@ops.test', 'Alice Admin', [[1, 'admin'], [2, 'admin'], [3, 'admin']]],
    ['lead1@ops.test', 'Lena Lead', [[1, 'lead']]],
    ['member1@ops.test', 'Mo Member', [[1, 'member']]],
    ['member1b@ops.test', 'Mia Member', [[1, 'member']]],
    ['viewer1@ops.test', 'Vik Viewer', [[1, 'viewer']]],
    ['lead2@ops.test', 'Leo Lead', [[2, 'lead']]],
    ['member2@ops.test', 'Max Member', [[2, 'member'], [3, 'viewer']]],
    ['viewer2@ops.test', 'Val Viewer', [[2, 'viewer']]],
    ['lead3@ops.test', 'Lou Lead', [[3, 'lead']]],
    ['member3@ops.test', 'Meg Member', [[3, 'member']]],
  ];
  for (const [email, name, ms] of users) {
    const r = await pool.query('INSERT INTO users(email,name,pw_hash) VALUES($1,$2,$3) RETURNING id', [email, name, pw]);
    for (const [t, role] of ms) await pool.query('INSERT INTO memberships VALUES($1,$2,$3)', [r.rows[0].id, t, role]);
  }
  // Titles come from per-team templates so the data looks like real operational work.
  await pool.query(`
    WITH tpl(team_id, type, title) AS (VALUES
      (1,'payment','Refund stuck in pending for order #'),(1,'incident','Card gateway timeouts in region eu-'),
      (1,'payment','Chargeback dispute needs evidence, case '),(1,'task','Reconcile settlement batch '),
      (2,'customer_issue','Customer cannot reset password, ticket '),(2,'customer_issue','Duplicate invoice reported by account '),
      (2,'incident','Support queue backlog above SLA, shift '),(2,'task','Follow up on escalation '),
      (3,'compliance','KYC review overdue for customer '),(3,'compliance','Data export request (GDPR) ref '),
      (3,'task','Quarterly access review, group '),(3,'incident','Audit log gap detected on node '))
    , src AS (
      SELECT g, 1 + (g % 3) AS team_id,
             (ARRAY['open','open','in_progress','in_progress','awaiting_approval','resolved','closed'])[1 + floor(random()*7)::int] AS status,
             random() AS r1, random() AS r2
      FROM generate_series(1, $1::int) g)
    INSERT INTO work_items(title,description,type,priority,status,team_id,assignee_id,created_by,due_date,created_at,updated_at)
    SELECT t.title || (1000 + s.g), 'Reported by an internal user. Needs investigation and a clear owner. Reference ' || (1000 + s.g) || '.',
      t.type,
      (ARRAY['low','medium','medium','high','urgent'])[1 + floor(s.r1*5)::int],
      s.status, s.team_id,
      CASE WHEN s.status = 'open' AND s.r2 < 0.5 THEN NULL
           ELSE (SELECT user_id FROM memberships m WHERE m.team_id = s.team_id AND m.role <> 'viewer' ORDER BY random() LIMIT 1) END,
      (SELECT user_id FROM memberships m WHERE m.team_id = s.team_id AND m.role <> 'viewer' ORDER BY random() LIMIT 1),
      now() + ((s.r2*45 - 4) || ' days')::interval,
      now() - ((random()*30) || ' days')::interval, now() - ((random()*3) || ' days')::interval
    FROM src s JOIN LATERAL (SELECT title, type FROM tpl WHERE tpl.team_id = s.team_id ORDER BY random() LIMIT 1) t ON true`, [n]);
  await pool.query(`INSERT INTO activity_events(item_id,actor_id,kind,detail,created_at)
    SELECT id, created_by, 'created', jsonb_build_object('priority', priority), created_at FROM work_items`);
}

module.exports = { seed };
if (require.main === module) {
  seed(3000, process.argv.includes('--if-empty'))
    .then(() => { console.log('Seeded'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
