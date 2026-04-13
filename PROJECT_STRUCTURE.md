# Project Structure & Architecture Overview

## 📁 Directory Tree

```
next-in-line/
├── README.md                    ← Start here: full documentation
├── SETUP.md                     ← Installation & configuration
├── QUICK_REF.md                 ← Developer quick reference
├── CONCURRENCY.md               ← Race condition prevention (deep dive)
├── TESTING.md                   ← Integration tests & examples
├── .gitignore                   ← Git ignore rules
│
├── server/                      ← Backend (Express + PostgreSQL)
│   ├── package.json             ← npm dependencies
│   ├── .env.example             ← Environment template
│   ├── index.js                 ← Express app entry + startup
│   │
│   ├── db/
│   │   ├── pool.js              ← PostgreSQL connection pooling
│   │   └── migrations/          ← Database schema
│   │       ├── 001_create_jobs.sql
│   │       ├── 002_create_applicants.sql
│   │       ├── 003_create_applications.sql
│   │       └── 004_create_event_logs.sql
│   │
│   ├── routes/                  ← API endpoint handlers
│   │   ├── jobs.js              ← POST/GET /jobs, /jobs/:id/pipeline
│   │   ├── applications.js      ← POST/GET /applications, /ack, /exit
│   │   └── applicants.js        ← POST/GET /applicants
│   │
│   └── services/                ← Business logic
│       ├── logService.js        ← Event logging (immutable audit trail)
│       ├── promotionService.js  ← Promotion + queue reindexing
│       └── decayWorker.js       ← Background decay + cascade (setInterval)
│
├── client/                      ← Frontend (React)
│   ├── package.json             ← npm dependencies (includes react-router-dom)
│   ├── .env.example             ← Environment template
│   ├── public/
│   │   └── index.html           ← HTML entry point
│   │
│   └── src/
│       ├── index.js             ← React app entry
│       ├── App.jsx              ← Router component
│       ├── App.css              ← Global styles
│       ├── index.css            ← Base styles + utilities
│       │
│       ├── pages/               ← Page components
│       │   ├── Dashboard.jsx    ← Job list, create job, quick apply
│       │   └── ApplicantView.jsx ← Individual applicant status view
│       │
│       ├── components/          ← Reusable UI components
│       │   └── JobCard.jsx      ← Job card w/ pipeline preview
│       │
│       ├── api/                 ← API integration
│       │   └── index.js         ← Axios wrappers for all endpoints
│       │
│       └── styles/              ← Component-specific styles
│           ├── Dashboard.css
│           ├── JobCard.css
│           └── ApplicantView.css
```

## 🔄 Data Flow Diagram

```
USER (Browser)
    ↓
FRONTEND (React @ localhost:3000)
    ├─ Dashboard (view jobs, submit applications)
    ├─ JobCard (pipeline preview)
    └─ ApplicantView (status details)
    ↓
AXIOS API CLIENT (axios requests)
    ↓
BACKEND API (Express @ localhost:3001)
    ├─ POST /applications
    ├─ GET /applications/:id
    ├─ POST /applications/:id/exit
    ├─ GET /jobs/:id/pipeline
    ├─ POST /jobs
    ├─ POST /applicants
    └─ ... [9 endpoints total]
    ↓
REQUEST HANDLER (routes/*.js)
    ├─ Parse request
    ├─ Validate input
    ├─ Begin transaction
    ├─ Lock resource (SELECT FOR UPDATE)
    ├─ Execute business logic (services/*.js)
    ├─ Log transition (logService)
    ├─ Commit/rollback
    └─ Return response
    ↓
DATABASE TRANSACTION (PostgreSQL)
    ├─ Lock job row
    ├─ Check capacity
    ├─ Insert/update applications
    ├─ Update jobs counters
    ├─ Insert event_logs
    ├─ Reindex queue_positions
    └─ Commit (atomic)
    ↓
BACKGROUND WORKER (every 45 seconds)
    ├─ Query expired ACTIVE applications
    ├─ Decay each one (ACTIVE → DECAYED → WAITLISTED)
    ├─ Cascade promotions (WAITLISTED → ACTIVE)
    └─ Emit logs
    ↓
DATABASE TABLES
    ├─ jobs (id, title, capacity, active_count)
    ├─ applicants (id, name, email)
    ├─ applications (id, job_id, applicant_id, status, queue_position, ack_deadline)
    └─ event_logs (id, application_id, from_status, to_status, timestamp, metadata)
```

## 🔐 Concurrency Safety

Every write operation follows this pattern:

```
┌─────────────────────────────────────────────┐
│ 1. Connect to PostgreSQL (pooled)           │
├─────────────────────────────────────────────┤
│ 2. BEGIN transaction                        │
├─────────────────────────────────────────────┤
│ 3. SELECT resource FOR UPDATE (lock!)       │
│    └─ Prevents other txns from modifying   │
├─────────────────────────────────────────────┤
│ 4. Check conditions (within locked scope)   │
├─────────────────────────────────────────────┤
│ 5. Execute updates                          │
├─────────────────────────────────────────────┤
│ 6. Log transition (event_logs)              │
├─────────────────────────────────────────────┤
│ 7. COMMIT (all-or-nothing)                  │
├─────────────────────────────────────────────┤
│ 8. On error: ROLLBACK (no corruption)       │
├─────────────────────────────────────────────┤
│ 9. Release client back to pool              │
└─────────────────────────────────────────────┘
```

**Result**: Two simultaneous requests → exactly one correct outcome (no race).

## 📊 State Machine Flow

```
[Applicant Applies]
        ↓
    BEGIN TXN
        ↓
   [Lock Job]
        ↓
  [Capacity?]
        ├─ YES → [ACTIVE]
        │         ├─ Set ack_deadline (+24h)
        │         ├─ Log: APPLIED → ACTIVE
        │         ├─ Increment job.active_count
        │         └─ Return 201
        │
        └─ NO → [WAITLISTED]
                 ├─ Assign queue_position
                 ├─ Log: APPLIED → WAITLISTED
                 └─ Return 201
    COMMIT
        ↓
[Applicant Exits or Times Out]
        ↓
    BEGIN TXN
        ├─ Set status → HIRED | REJECTED | DECAYED
        ├─ Decrement job.active_count
        ├─ Log transition
        ├─ Call promoteNext()
        │   ├─ Find next WAITLISTED (lowest queue_position)
        │   ├─ Set status → ACTIVE
        │   ├─ Set ack_deadline (+24h)
        │   ├─ Increment job.active_count
        │   ├─ Reindex queue_positions
        │   └─ Log promotion
        └─ COMMIT
        ↓
[New ACTIVE applicant is promoted]
```

## ⚙️ Decay Worker Loop (every 45 seconds)

```
┌────────────────────────────────────────────┐
│ [Timer: Every 45 seconds]                  │
└────────────────────────────────────────────┘
              ↓
    [Query Expired ACTIVE]
    SELECT * FROM applications
    WHERE status = 'ACTIVE'
    AND ack_deadline < NOW()
              ↓
    [For each expired applicant]
              ├─ BEGIN TXN
              ├─ status: ACTIVE → DECAYED
              ├─ Log: ACTIVE → DECAYED
              ├─ Decrement job.active_count
              ├─ Requeue: status: DECAYED → WAITLISTED
              ├─ Assign end-of-queue position
              ├─ Log: DECAYED → WAITLISTED
              ├─ promoteNext() [cascade!]
              │   └─ Find & promote next WAITLISTED
              ├─ COMMIT
              └─ Next applicant...
              ↓
    [Cascade Complete]
    (New applicants may have been promoted
     to fill vacated slots automatically)
```

## 🗄️ Database Schema Hierarchy

```
┌─────────────┐
│    JOBS     │ ← Fixed capacity containers
├─────────────┤
│ id (PK)     │
│ title       │ "Senior Engineer"
│ capacity    │ 10 (max ACTIVE)
│ active_count│ 8 (current ACTIVE)
└─────────────┘
      ↑
      │ references
      │
┌───────────────────────┐
│   APPLICATIONS        │ ← State machine instances
├───────────────────────┤
│ id (PK)               │
│ job_id (FK) ──────────┼──→ JOBS
│ applicant_id (FK) ────┼──→ APPLICANTS
│ status (enum)         │ ACTIVE, WAITLISTED, DECAYED, HIRED, REJECTED
│ queue_position        │ NULL if ACTIVE, 0-N if WAITLISTED
│ ack_deadline          │ NOW() + 24h if ACTIVE, NULL otherwise
│ last_transition_at    │ Timestamp of last state change
│ created_at            │ When applied
└───────────────────────┘
      ↖ ↗
       × (many-to-many via IDs)
      ↙ ↖
┌──────────────────┐      ┌───────────────────────┐
│   APPLICANTS     │      │   EVENT_LOGS          │ ← Audit trail
├──────────────────┤      ├───────────────────────┤
│ id (PK)          │      │ id (PK)               │
│ name             │      │ application_id (FK)   │
│ email (UNIQUE)   │      │ from_status           │
│ created_at       │      │ to_status             │
└──────────────────┘      │ timestamp             │
                          │ metadata (JSONB)      │
                          │   └─ reason, triggered_by, etc.
                          └───────────────────────┘
```

## 📚 File Relationships

```
index.js (ENTRY POINT)
  ├→ imports db/pool.js (DB connection)
  │           └→ auto-runs migrations
  ├→ imports routes (3 routers)
  │   ├→ routes/jobs.js
  │   ├→ routes/applications.js (MAIN LOGIC)
  │   │   ├→ imports services/promotionService.js
  │   │   ├→ imports services/logService.js
  │   │   └→ uses db/pool.js directly for transactions
  │   └→ routes/applicants.js
  │
  └→ imports services/decayWorker.js
      ├→ imports services/logService.js
      ├→ imports services/promotionService.js
      └→ uses db/pool.js for background tasks

FRONTEND (App.jsx)
  └→ renders routes
      ├→ pages/Dashboard.jsx
      │   ├→ JobCard.jsx
      │   └→ api/index.js (axios wrapper)
      └→ pages/ApplicantView.jsx
          └→ api/index.js
```

## 🚀 Getting Started

1. **Read**: [SETUP.md](SETUP.md) — Install dependencies & configure
2. **Understand**: [README.md](README.md) — Architecture & API overview
3. **Deep Dive**: [CONCURRENCY.md](CONCURRENCY.md) — Race condition prevention
4. **Test**: [TESTING.md](TESTING.md) — Integration test examples
5. **Reference**: [QUICK_REF.md](QUICK_REF.md) — Cheat sheet for developers

## 📈 Scalability Notes

**Current Setup**:
- Connection pool: 20 connections
- Decay worker: every 45 seconds
- Queue reindex: on every promotion

**For 1000+ concurrent applicants**:
1. Increase `pool.max` to 50 in `db/pool.js`
2. Add pagination to `/jobs/:id/pipeline`
3. Add filtering to applications query
4. Consider caching job list (5s TTL)
5. Monitor: `SELECT count(*) FROM pg_stat_activity;`

**For 10,000+ total applications**:
1. Archive old event_logs to separate table
2. Add composite indexes on (job_id, status, queue_position)
3. Consider read replicas for reporting queries
4. Batch reindex operations with LIMIT/OFFSET

## 🔍 Debugging Commands

```bash
# Terminal 1: Start backend
cd server && npm start

# Terminal 2: Start frontend  
cd client && npm start

# Terminal 3: Monitor database
psql -d next_in_line
  → \watch 'SELECT COUNT(*) FROM applications;'
  → SELECT * FROM event_logs LIMIT 10;
  → SELECT * FROM applications WHERE status = 'ACTIVE';

# Terminal 4: Monitor logs
tail -f /var/log/postgresql/postgresql.log  # macOS
# or check PostgreSQL logs via GUI (pgAdmin)
```

---

**Status**: ✅ Complete  
**Stack**: PostgreSQL 12+ | Node.js 16+ | React 18+ | Express 4+  
**Pattern**: Queue-based state machine with strict concurrency control  
**Guarantee**: Zero race conditions, full auditability, ACID compliance
