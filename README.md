# Next In Line — Hiring Pipeline ATS

A queue-based applicant tracking system (ATS) built with **PostgreSQL, Express, React, and Node.js (PERN stack)**. Features strict concurrency control, automatic promotion cascades, decay handling, and event-sourced audit trail.

## 🎯 Core Features

### State Machine
```
APPLIED → ACTIVE (if capacity available) | WAITLISTED (if full)
↓
WAITLISTED → ACTIVE (auto-promoted when slot opens)
↓
ACTIVE → HIRED | REJECTED (manual exit) | DECAYED (timeout)
↓
DECAYED → WAITLISTED (re-queued at end, penalty applied)
```

### Key Capabilities
- **Capacity Control**: Fixed slots per job, overflow queued in FIFO order
- **Auto-Promotion**: When an ACTIVE slot opens, top WAITLISTED applicant instantly promoted
- **Decay Handling**: ACTIVE applicants with expired acknowledgment deadlines decay and re-queue
- **Concurrency Safe**: Row-level PostgreSQL locking prevents race conditions
- **Event Sourced**: Every transition logged; system reconstructible from event_logs
- **Transactional Integrity**: All multi-step operations wrapped in atomic transactions
- **No External Queues**: Pure PostgreSQL + setInterval (no Bull, BeeQueue, etc.)

## 📋 Database Schema

### `jobs`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| title | TEXT | Job title |
| capacity | INT | Max concurrent ACTIVE applicants |
| active_count | INT | Current ACTIVE count |
| created_at | TIMESTAMP | |

### `applicants`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| name | TEXT | Applicant name |
| email | TEXT | Unique email |
| created_at | TIMESTAMP | |

### `applications`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| job_id | UUID | FK to jobs |
| applicant_id | UUID | FK to applicants |
| status | ENUM | [APPLIED, WAITLISTED, ACTIVE, DECAYED, REJECTED, HIRED] |
| queue_position | INT | WAITLISTED only; NULL if ACTIVE |
| ack_deadline | TIMESTAMP | Deadline to acknowledge (ACTIVE only) |
| last_transition_at | TIMESTAMP | Last status change |
| created_at | TIMESTAMP | |

### `event_logs`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| application_id | UUID | FK to applications |
| from_status | TEXT | Previous status |
| to_status | TEXT | New status |
| timestamp | TIMESTAMP | When transition occurred |
| metadata | JSONB | Reason, triggered_by, etc. |

## 🚀 Quick Start

### Prerequisites
- **Node.js** 16+ 
- **PostgreSQL** 12+
- **npm** 7+

### 1. Database Setup

```bash
# Create database
createdb next_in_line

# Set environment (Linux/Mac)
export DB_NAME=next_in_line
export DB_USER=postgres
export DB_PASSWORD=your_password
export DB_HOST=localhost
export DB_PORT=5432

# Or on Windows (PowerShell)
$env:DB_NAME="next_in_line"
$env:DB_USER="postgres"
$env:DB_PASSWORD="your_password"
$env:DB_HOST="localhost"
$env:DB_PORT=5432
```

### 2. Install & Start Server

```bash
cd server
npm install
npm start

# Server runs on http://localhost:3001
# Migrations auto-run on startup
# Decay worker starts immediately
```

### 3. Install & Start Client

```bash
cd client
npm install
npm start

# Open http://localhost:3000 in browser
```

## 📡 API Endpoints

### Jobs
```bash
POST   /jobs
       { title: string, capacity: int }
       → { id, title, capacity, active_count, created_at }

GET    /jobs
       → [jobs...]

GET    /jobs/:id
       → job

GET    /jobs/:id/pipeline
       → {
           job: {...},
           applicants: [...],
           summary: { total, active, waitlisted, hired, rejected }
         }
```

### Applicants
```bash
POST   /applicants
       { name: string, email: string }
       → { id, name, email, created_at }

GET    /applicants
       → [applicants...]

GET    /applicants/:id
       → applicant
```

### Applications
```bash
POST   /applications
       { job_id: uuid, applicant_id: uuid }
       → { id, job_id, applicant_id, status, queue_position, ack_deadline, ... }

GET    /applications/:id
       → application

POST   /applications/:id/ack
       → Resets ack_deadline (applicant acknowledges)
       → { id, ..., ack_deadline: new_date }

POST   /applications/:id/exit
       { outcome: 'HIRED' | 'REJECTED' }
       → { application: {...}, promoted: boolean }
       → Auto-promotes next WAITLISTED applicant
```

## ⚙️ How It Works

### Applying
1. POST `/applications` with job_id + applicant_id
2. Server locks job row (SELECT FOR UPDATE)
3. Checks active_count vs capacity
4. If capacity available → status = ACTIVE, ack_deadline set to NOW() + 24h
5. If full → status = WAITLISTED, queue_position assigned
6. Transitions logged in event_logs
7. Atomicity guaranteed via PostgreSQL transaction

### Exiting (HIRED/REJECTED)
1. POST `/applications/:id/exit` with outcome
2. Updates status to outcome
3. Decrements job.active_count
4. Calls `promoteNext()` to fill vacant slot
5. Reindexes remaining queue positions
6. All changes wrapped in single transaction

### Promotion Flow
1. Promoted applicant found: `SELECT ... WHERE status = 'WAITLISTED' ORDER BY queue_position LIMIT 1 FOR UPDATE SKIP LOCKED`
2. Status → ACTIVE, ack_deadline set
3. Queue positions reindexed (ROW_NUMBER() OVER ORDER BY queue_position)
4. Logged in event_logs
5. Returns boolean indicating success

### Decay Worker
Runs every 45 seconds:
1. Query: `SELECT * FROM applications WHERE status = 'ACTIVE' AND ack_deadline < NOW()`
2. For each expired applicant:
   - Transition ACTIVE → DECAYED (logged)
   - Decrement job.active_count
   - Re-insert into WAITLISTED at end (MAX(queue_position) + 1)
   - Transition DECAYED → WAITLISTED (logged)
   - Call promoteNext() to fill slot
3. New applicants can re-acknowledge to reset deadline
4. Each decay cascades to next promotion in same loop

## 🔒 Concurrency Safety

### Transaction Pattern
All multi-step operations follow this pattern:

```javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  
  // Lock job row
  await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
  
  // Check capacity
  if (job.active_count < job.capacity) { ... }
  
  // Insert/update application
  await client.query('UPDATE applications ...', [...]);
  
  // Update job state
  await client.query('UPDATE jobs ...', [...]);
  
  // Log transition
  await logTransition(client, appId, fromStatus, toStatus, meta);
  
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

### Race Condition Prevention
- **Row-level locking**: `SELECT ... FOR UPDATE` prevents concurrent modifications
- **Atomic transactions**: All-or-nothing strategy
- **Snapshot isolation**: PostgreSQL default (READ COMMITTED)

### Example: Two simultaneous applications for last slot
1. Request A locks job row, sees active_count = capacity - 1
2. Request B waits for lock (blocked)
3. Request A inserts application with status = ACTIVE, increments active_count
4. Request A commits
5. Request B acquires lock, sees active_count = capacity
6. Request B inserts application with status = WAITLISTED, queue_position = 0
7. Request B commits
→ Result: Exactly one ACTIVE, one WAITLISTED. No data corruption.

## 📊 Event Log Structure

Every state transition automatically logged:

```json
{
  "id": "uuid",
  "application_id": "uuid",
  "from_status": "APPLIED",
  "to_status": "ACTIVE",
  "timestamp": "2025-04-13T15:30:00Z",
  "metadata": {
    "reason": "new_application",
    "triggered_by": "applicationsRoute",
    "capacity_check": {
      "active_count": 5,
      "capacity": 10
    }
  }
}
```

**Query application history:**
```sql
SELECT * FROM event_logs 
WHERE application_id = 'xxx' 
ORDER BY timestamp ASC;
```

**Reconstruct current state from logs:**
```sql
SELECT to_status FROM event_logs 
WHERE application_id = 'xxx' 
ORDER BY timestamp DESC LIMIT 1;
```

## 🛠️ Development

### Server Logs
```
✓ Database connection successful
✓ All migrations completed
✓ Server running on port 3001
[DECAY WORKER] Started with interval: 45000ms
```

### Monitoring Decay Worker
```
[DECAY WORKER] Found 3 expired applications
[DECAY WORKER] Processed application <uuid>
[DECAY WORKER] Processed application <uuid>
```

### Test Scenario: Capacity Exhaustion
```bash
# Create job with capacity 2
curl -X POST http://localhost:3001/jobs \
  -H "Content-Type: application/json" \
  -d '{"title":"Engineer","capacity":2}'

# Apply 3 applicants
curl -X POST http://localhost:3001/applications \
  -d '{"job_id":"<job_id>","applicant_id":"<app1_id>"}'
# → status: ACTIVE, queue_position: null

curl -X POST http://localhost:3001/applications \
  -d '{"job_id":"<job_id>","applicant_id":"<app2_id>"}'
# → status: ACTIVE, queue_position: null

curl -X POST http://localhost:3001/applications \
  -d '{"job_id":"<job_id>","applicant_id":"<app3_id>"}'
# → status: WAITLISTED, queue_position: 0

# Exit first applicant
curl -X POST http://localhost:3001/applications/<app1_id>/exit \
  -d '{"outcome":"HIRED"}'

# Check applicant 3 (should now be ACTIVE, promoted)
curl http://localhost:3001/applications/<app3_id>
# → status: ACTIVE, ack_deadline: (now + 24h)
```

## 📄 Frontend Workflow

### Dashboard
- Lists all jobs with live capacity visualization
- Shows recent applicants per job segmented by status
- Create new jobs
- Submit applications (creates applicants inline)
- Auto-refreshes every 15 seconds

### Applicant Card
- Click applicant row → view full profile
- Displays acknowledgment countdown (warns if < 1 hour)
- Acknowledge button (resets deadline)
- Hire / Reject buttons (exit with outcome)
- Shows queue position if WAITLISTED

## 🐛 Debugging

### Common Issues

**"Error: Cannot acquire lock"**
- Indicates database transaction timeout or connection pool exhausted
- Check max pool size in `db/pool.js`
- Verify PostgreSQL server is running

**Missing migrations on startup**
- Ensure migration files in `server/db/migrations/`
- Check file permissions
- Verify database credentials in env variables

**Decay worker not running**
- Check console for "[DECAY WORKER] Started" message
- Verify `services/decayWorker.js` is imported in `index.js`
- Check for errors in periodic logs

**Queue positions out of sequence**
- Run reindexQueue() manually for a job to fix
- Verify all WAITLISTED records have non-null queue_position

### Inspection Queries

```sql
-- Full pipeline for a job
SELECT status, COUNT(*) as count FROM applications 
WHERE job_id = '<job_id>' 
GROUP BY status;

-- Verify queue positions are contiguous
SELECT queue_position FROM applications 
WHERE job_id = '<job_id>' AND status = 'WAITLISTED' 
ORDER BY queue_position;

-- Check for duplicates
SELECT applicant_id, COUNT(*) 
FROM applications 
WHERE job_id = '<job_id>' AND status IN ('ACTIVE', 'WAITLISTED') 
GROUP BY applicant_id HAVING COUNT(*) > 1;

-- Event audit trail
SELECT from_status, to_status, COUNT(*) 
FROM event_logs 
WHERE application_id = '<app_id>' 
GROUP BY from_status, to_status;
```

## 📚 Architecture Notes

### Why No External Queue Libraries?
- **Direct PostgreSQL**: Simpler deployment, fewer dependencies
- **Transactional**: One database ensures consistency
- **Observable**: All state in tables, fully queryable
- **Retryable**: Failures roll back atomically

### Why Row-Level Locking?
- **Prevents races**: Only one transaction per job at capacity boundary
- **Minimal contention**: Lock held only during transaction
- **Fair**: FIFO ordering of waiting transactions

### Why Event Sourcing?
- **Auditability**: Complete history unchangeable
- **Debugging**: Trace every state transition
- **Recovery**: Restore state from events alone
- **Compliance**: Immutable record for legal/HR

## 🚢 Production Deployment

### Environment Variables
```bash
NODE_ENV=production
PORT=3001
DB_NAME=next_in_line
DB_USER=app_user
DB_PASSWORD=strong_password
DB_HOST=db.example.com
DB_PORT=5432
```

### PostgreSQL Indexes
Already created by migrations:
- `idx_jobs_created_at`
- `idx_applicants_email`
- `idx_applications_job_status`
- `idx_applications_job_queue`
- `idx_applications_ack_deadline`
- `idx_event_logs_app`
- `idx_event_logs_timestamp`

### Decay Worker Interval
Default 45 seconds. Adjust per workload:
```javascript
startDecayWorker(30 * 1000); // 30s for aggressive decay
startDecayWorker(120 * 1000); // 2min for relaxed decay
```

### Monitoring
- Track job.active_count vs capacity
- Monitor applications with status = ACTIVE and ack_deadline < NOW()
- Alert on event_logs insert rate spike
- Watch database connection pool utilization

## 📝 License

MIT

---

## ⚖️ Tradeoffs Made
- **Raw SQL vs. ORM:** I chose to use raw `pg` queries rather than an ORM (like Drizzle or Prisma) to maintain absolute, granular control over the `SELECT FOR UPDATE` locking mechanism without abstraction overhead. The tradeoff is more verbose code and manually constructed SQL strings.
- **Manual Polling vs. Event-Driven Decay:** The inactivity decay cascade runs via a `setInterval` continuous polling worker. The tradeoff is that the decay isn't executed natively in real-time right at the millisecond of expiration, but it vastly simplifies the architecture by not requiring a background job queue manager like BullMQ or Redis.

## 🚀 What I'd Change With More Time
- **Comprehensive Automated Testing:** Implement automated integration tests (e.g., using Jest and Supertest) rather than relying on manual `curl` sequences and database inspection workflows.
- **Strict Input Validation:** Add strict input validation middleware (e.g., using Zod or Joi) to catch malformed requests before they hit the database layer.
- **TypeScript Migration:** Port the codebase to TypeScript for better developer experience, stricter type safety, and to avoid runtime errors when tracking application state.
