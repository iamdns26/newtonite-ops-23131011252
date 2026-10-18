# Engineering Decisions

Stack: Node/Express + PostgreSQL, vanilla JS frontend. One relational database is the single source of truth; correctness rules live in SQL and server code, never only in the UI.

## 1. Concurrency: optimistic locking + atomic claim, decided by the database
**Problem:** two people claim the same item; two people edit the same item; a UI shows stale data.
**Choice:** every item has a `version`. Edits, assignment and status moves send the version they saw; `UPDATE … WHERE id=? AND version=?` matches 0 rows if anything changed, and the server answers **409 with the latest item**. *Claim* is a separate conditional update (`… WHERE assignee_id IS NULL`), so exactly one of two simultaneous claimers wins without the client needing a version. Postgres row locking serializes the writers; no application-level locks exist, so this also holds with several app instances.
**Trade-offs:** no locks are held while a human thinks (good), but a loser must re-apply their change. In the UI an edit conflict keeps the user's draft and shows the newest version beside it. Whole-item versioning is coarse (editing the title conflicts with a concurrent priority change); field-level merging would be the next refinement.

## 2. Retry safety: idempotent create, no-op retries for the rest
**Problem:** a user is unsure whether a request succeeded and repeats it.
**Choice:** `POST /items` takes an `Idempotency-Key`. The key row is inserted in the same transaction as the item; a concurrent duplicate blocks on the primary key until the first commits, then replays the stored response (verified by a test firing three simultaneous requests). The UI generates one key per open form, so double-clicks and timeout-retries cannot create duplicates. Claim is naturally idempotent (claiming something you already own returns success with no new history row); a repeated status move or stale edit is rejected by the version check, and the UI reconciles by re-fetching the item after any network failure.
**Trade-off:** idempotency keys are stored forever (a cleanup job would expire them after ~24 h).

## 3. Reliable asynchronous work: transactional outbox
**Problem:** notifications must not be lost if the process dies, must not be sent for changes that rolled back, and must not be duplicated on retry.
**Choice:** the business change, its activity-log row and an `outbox` row are written in **one transaction**. A background worker claims rows with `FOR UPDATE SKIP LOCKED` (safe to run in many instances; a crash rolls the claim back so the row is retried), builds notifications, and marks the row done. Delivery is *at-least-once*, so the effect is made idempotent with `UNIQUE(outbox_id, user_id)` + `ON CONFLICT DO NOTHING`. Failures retry with exponential backoff and become `dead` after 5 attempts (kept for inspection); each job runs in its own savepoint so one poisoned row never blocks the batch. The API response never waits for this work.
**Trade-offs:** notifications arrive a second or two late, polling (1.5 s) rather than LISTEN/NOTIFY, no alerting on dead rows yet, and the browser polls (10 s) instead of using websockets/SSE.

## 4. Authorization: one choke point, resource-level, re-checked per request
**Choice:** roles are per team (`viewer < member < lead < admin`). Every endpoint calls `authorize(req, item.team_id, minRole)`; roles are re-read from the DB on each request so removing someone takes effect immediately. Non-members get **404** (existence isn't leaked), insufficient role gets 403, and every list query is filtered by the caller's teams in SQL (a `team_id` filter can only narrow, never widen). Workflow rules are server-enforced: a transition map with a minimum role per edge; only a lead/admin can approve, and **never the item's own assignee** (four-eyes); once an item has an owner only the owner or a lead can move it; only leads can assign other people, assignees must be non-viewer members of the item's team.
The UI doesn't re-implement these rules: the server returns `can: { edit, claim, assign, release, transitions[] }` with each item, computed by the same functions that guard the endpoints, so buttons and enforcement cannot drift apart.
**Trade-off:** roles are hard-coded, not configurable per team; no audit of permission changes.

## 5. Data model, history and scale
**Choice:** `work_items` (with a `version`), append-only `activity_events` (JSONB detail) written in the same transaction as each change, so history can never disagree with state and important actions can't silently vanish. Lists use **keyset pagination** (`(priority_rank, id) < (?, ?)` on a stored generated column) rather than OFFSET, with composite indexes per access path, a GIN index for prefix full-text search on titles, and dashboard counts computed in SQL (never in the browser). Activity is paginated newest-first; the browser only ever holds one page of items plus one page of history.
**Trade-offs:** search covers titles only; the "needs attention" queue uses an OR across three conditions (fine at tens of thousands of rows, would become a maintained materialized flag or search index at 10×); `/stats` does a filtered scan per poll (cache per user/team at higher load); `activity_events` isn't partitioned yet.

## Frontend state
Single store, server is the source of truth. Fast actions (claim, status moves) are **optimistic**: the UI shows the expected result at once (row dimmed, "Saving…"), then replaces it with the server's answer; on 409/failure it shows what happened and re-fetches the authoritative item. List responses carry a sequence number so a slow older response can't overwrite a newer filter. The open item is polled; if someone else changed it you're told (or, mid-edit, warned with your draft kept).

## What I intentionally did not build
Websocket push, per-team configurable workflows, attachments, email delivery of notifications, refresh tokens/SSO, rate limiting beyond a simple login throttle, frontend automated tests.

## Known limitations
- Login throttle and JWT are minimal (in-memory throttle; 8 h token without revocation; roles are re-read per request, so permission changes are immediate, but tokens can't be force-expired).
- Notifications are in-app only; dead outbox rows need manual inspection/replay.
- Idempotency keys aren't expired; only item creation uses them.
- Search is title-only, prefix-based; no fuzzy matching.
- Conflict handling is whole-item, not field-level merge.
- Board shows 15 per column with "load more"; no drag-and-drop.
- Seed passwords are shared demo passwords; set `JWT_SECRET` in any real deployment.

## What I'd do next (another week)
Server-sent events for live updates; per-user notification preferences and email/Slack delivery via the same outbox; field-level conflict merge; saved views; a dedicated search index (and denormalized "needs attention" flags) once data is 10× larger; partition `activity_events` by month; metrics + alerting on outbox lag/dead rows; browser tests for the conflict paths.
