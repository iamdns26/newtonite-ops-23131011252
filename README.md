# Relay — Operations Under Pressure (Newtonite challenge)

Internal web app for creating, assigning, tracking and approving operational work across teams.
Node.js + Express + PostgreSQL. Vanilla-JS frontend served by the API (no build step).

## Run
Prerequisites: Docker + Docker Compose.
```
docker compose up --build        # app on http://localhost:3000 (auto-creates schema, seeds 3,000 items)
```
If you previously ran an older version, reset the DB first: `docker compose down -v`.

Without Docker (Node 20+, Postgres running):
```
cp .env.example .env             # set DATABASE_URL / JWT_SECRET (export them, or use your shell's env)
npm install && npm run seed && npm start
```

## Demo logins (password for all: `password123`)
The login page has one-click buttons for each of these.

| User | Teams / role |
|---|---|
| admin@ops.test | admin in all teams |
| lead1@ops.test / member1@ops.test / member1b@ops.test / viewer1@ops.test | Payments: lead / member / member / viewer |
| lead2@ops.test / member2@ops.test (+viewer in Compliance) / viewer2@ops.test | Support: lead / member / viewer |
| lead3@ops.test / member3@ops.test | Compliance: lead / member |

**Two-user demo:** open two browsers as `member1` and `member1b`, open the same unassigned item in both and press *Claim* at the same moment. One wins; the other is told, shown the latest state, and nothing is duplicated.

## What's in the app
- **Queues** that answer "what needs me?": Needs my attention, Assigned to me, Awaiting my approval, Unassigned, Overdue, All, plus status filters, priority/type/team filters, sort, prefix search on title and `#id` jump. List and Board views.
- **Work item detail** with a plain-language "what happens next" line, owner, due date, full activity timeline (comments + every change), assignment, workflow buttons.
- **Notifications** (bell) generated asynchronously by an outbox worker.
- Server-side authorization with team roles: viewer < member < lead < admin.

## Tests
```
docker compose up -d db && npm install && npm test      # needs Postgres at DATABASE_URL (default postgres://ops:ops@localhost:5432/ops)
```
Tests re-seed the database. They cover: concurrent claim, many simultaneous edits, stale update, retry-safe claim, idempotent create, workflow + four-eyes approval, ownership rule, team isolation, resource-level authorization, assignment rules, outbox exactly-once effect / retries / dead-lettering / failure isolation, keyset pagination, search.

## API (all JSON, Bearer token)
`POST /login` · `GET /me` · `GET /teams` · `GET /stats` · `GET /items?…` · `POST /items` (Idempotency-Key) · `GET|PATCH /items/:id` · `POST /items/:id/{claim,assign,transition,comments}` · `GET /items/:id/activity` · `GET /notifications` · `POST /notifications/read`

## Known limitations
See `ENGINEERING_DECISIONS.md` ("Known limitations").
