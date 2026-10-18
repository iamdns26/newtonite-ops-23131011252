CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, pw_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams(id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS memberships(
  user_id INT REFERENCES users(id), team_id INT REFERENCES teams(id),
  role TEXT NOT NULL CHECK (role IN ('viewer','member','lead','admin')), PRIMARY KEY(user_id, team_id));
CREATE INDEX IF NOT EXISTS idx_memberships_team ON memberships(team_id, role);

CREATE TABLE IF NOT EXISTS work_items(
  id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  -- numeric rank lets us sort/paginate by priority with an index (keyset pagination on (rank, id)).
  priority_rank SMALLINT GENERATED ALWAYS AS (CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END) STORED,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id INT NOT NULL REFERENCES teams(id), assignee_id INT REFERENCES users(id),
  created_by INT NOT NULL REFERENCES users(id), due_date TIMESTAMPTZ,
  version INT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- Append-only history. Written in the same transaction as the change it describes.
CREATE TABLE IF NOT EXISTS activity_events(
  id BIGSERIAL PRIMARY KEY, item_id INT NOT NULL REFERENCES work_items(id), actor_id INT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS idempotency_keys(
  key TEXT NOT NULL, user_id INT NOT NULL, response JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(key, user_id));

-- Transactional outbox: a row is inserted in the SAME transaction as the business change, and a worker
-- turns it into notifications later (at-least-once; consumers are idempotent).
CREATE TABLE IF NOT EXISTS outbox(
  id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','dead')),
  attempts INT NOT NULL DEFAULT 0, run_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(run_at, id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS notifications(
  id BIGSERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), item_id INT NOT NULL REFERENCES work_items(id),
  outbox_id BIGINT NOT NULL, message TEXT NOT NULL, read_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, user_id));   -- makes re-processing the same outbox row harmless
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_items_team_id ON work_items(team_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_team_prio ON work_items(team_id, priority_rank DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_assignee ON work_items(assignee_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_status ON work_items(status, team_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_items_due ON work_items(due_date) WHERE status NOT IN ('resolved','closed');
CREATE INDEX IF NOT EXISTS idx_items_search ON work_items USING GIN (to_tsvector('simple', title));
CREATE INDEX IF NOT EXISTS idx_activity_item ON activity_events(item_id, id);
