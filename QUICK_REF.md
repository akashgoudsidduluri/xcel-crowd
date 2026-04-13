# Quick Reference — Next In Line Architecture

## Core Principles

1. **Queue-based State Machine**: APPLIED → ACTIVE | WAITLISTED → HIRED | REJECTED | DECAYED
2. **Capacity Control**: Fixed slots with FIFO overflow queue
3. **Transactional Integrity**: PostgreSQL ACID guarantees row-level locking
4. **Event Sourced**: All transitions logged, system reconstructible
5. **No External Queues**: Pure PostgreSQL + setInterval

## Request Flow

### Application Submission
```
POST /applications { job_id, applicant_id }
  ↓
BEGIN transaction
  ├─ SELECT job FOR UPDATE (lock)
  ├─ active_count < capacity?
  │  ├─ YES → status = ACTIVE, set ack_deadline
  │  └─ NO  → status = WAITLISTED, assign queue_position
  ├─ INSERT application
  ├─ UPDATE job.active_count if ACTIVE
  ├─ INSERT event_logs (APPLIED → status)
  └─ COMMIT
  ↓
Response: { id, status, queue_position, ack_deadline, ... }
```

### Promotion (when ACTIVE exits)
```
POST /applications/:id/exit { outcome: 'HIRED' | 'REJECTED' }
  ↓
BEGIN transaction
  ├─ SELECT application FOR UPDATE
  ├─ UPDATE status to outcome
  ├─ UPDATE job.active_count --
  ├─ promoteNext()
  │  ├─ SELECT next WAITLISTED FOR UPDATE
  │  ├─ UPDATE to ACTIVE, set ack_deadline
  │  ├─ INSERT event_logs
  │  ├─ UPDATE job.active_count ++
  │  └─ Reindex queue_positions
  ├─ INSERT event_logs
  └─ COMMIT
  ↓
Response: { application, promoted: boolean }
```

### Decay Worker (every 45s)
```
For each: SELECT ... WHERE status = ACTIVE AND ack_deadline < NOW()
  ↓
BEGIN transaction (per applicant)
  ├─ UPDATE status = DECAYED
  ├─ INSERT event_logs (ACTIVE → DECAYED)
  ├─ SELECT job FOR UPDATE
  ├─ UPDATE job.active_count --
  ├─ Get next queue_position
  ├─ UPDATE status = WAITLISTED, queue_position = N
  ├─ INSERT event_logs (DECAYED → WAITLISTED)
  ├─ promoteNext()  ← Fills the slot
  └─ COMMIT
```

## Database Patterns

### Capacity Check Pattern
```javascript
// ALWAYS use transaction + row lock
const client = await pool.connect();
try {
  await client.query('BEGIN');
  
  const job = (await client.query(
    'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
    [jobId]
  )).rows[0];
  
  if (job.active_count < job.capacity) { /* ACTIVE */ }
  else { /* WAITLISTED */ }
  
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

### Queue Position Assignment
```javascript
// Get next available position for WAITLISTED
const nextPos = (await client.query(
  'SELECT COALESCE(MAX(queue_position), -1) + 1 as next_position FROM applications WHERE job_id = $1 AND status = "WAITLISTED"',
  [jobId]
)).rows[0].next_position;
```

### Reindex Contiguous Positions
```javascript
const query = `
  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY queue_position ASC) - 1 as new_position
    FROM applications
    WHERE job_id = $1 AND status = 'WAITLISTED'
  )
  UPDATE applications a
  SET queue_position = r.new_position
  FROM ranked r
  WHERE a.id = r.id
`;
```

### Event Logging (inside transaction)
```javascript
await logTransition(
  client,  // Pass transaction client, NOT pool
  applicationId,
  'ACTIVE',
  'HIRED',
  {
    reason: 'manual_exit',
    triggered_by: 'applicationsRoute',
  }
);
// INSERT happens in same transaction before COMMIT
```

## API Endpoint Summary

| Method | Endpoint | Body | Response |
|--------|----------|------|----------|
| POST | /jobs | {title, capacity} | job |
| GET | /jobs | - | [jobs] |
| GET | /jobs/:id | - | job |
| GET | /jobs/:id/pipeline | - | {job, applicants[], summary} |
| POST | /applicants | {name, email} | applicant |
| GET | /applicants | - | [applicants] |
| GET | /applicants/:id | - | applicant |
| POST | /applications | {job_id, applicant_id} | application |
| GET | /applications/:id | - | application |
| POST | /applications/:id/ack | - | application (ack_deadline reset) |
| POST | /applications/:id/exit | {outcome} | {application, promoted} |

## State Transitions Allowed

```
APPLIED
  ↓
  ├─→ ACTIVE (if capacity)
  └─→ WAITLISTED (if full)

ACTIVE
  ├─→ HIRED (manual)
  ├─→ REJECTED (manual)
  └─→ DECAYED (automatic, timeout)

WAITLISTED
  └─→ ACTIVE (automatic, promotion)

DECAYED
  └─→ WAITLISTED (automatic, re-queue)
```

## Critical Rules

1. ✅ **Always** lock job row with `SELECT ... FOR UPDATE`
2. ✅ **Always** wrap multi-step ops in BEGIN...COMMIT
3. ✅ **Always** log transitions inside same transaction
4. ✅ **Always** rollback on error
5. ✅ **Always** reindex queue after mutations
6. ✅ **Always** set ack_deadline when transitioning TO ACTIVE
7. ✅ **Always** clear ack_deadline when transitioning FROM ACTIVE

8. ❌ **Never** check capacity outside transaction
9. ❌ **Never** modify event_logs (append-only)
10. ❌ **Never** leave transaction scope with uncommitted changes
11. ❌ **Never** skip logTransition calls

## Performance Queries

```sql
-- Check capacity enforcement
SELECT job_id, COUNT(*) as active_count FROM applications 
WHERE status = 'ACTIVE' GROUP BY job_id;
-- Compare to jobs.capacity

-- Verify queue contiguity
SELECT job_id, queue_position FROM applications 
WHERE status = 'WAITLISTED' 
ORDER BY job_id, queue_position;

-- Find applicants with expiring acks
SELECT name, ack_deadline FROM applications a
JOIN applicants ap ON a.applicant_id = ap.id
WHERE status = 'ACTIVE' AND ack_deadline < NOW() + INTERVAL '1 HOUR';

-- Decay frequency
SELECT DATE_TRUNC('hour', timestamp), COUNT(*) FROM event_logs
WHERE from_status = 'ACTIVE' AND to_status = 'DECAYED'
GROUP BY 1 ORDER BY 1 DESC;
```

## Debugging Checklist

- [ ] Check decay worker started: `[DECAY WORKER] Started...` in logs
- [ ] Verify migrations ran: `✓ Migration completed: 00X_*`
- [ ] Test capacity: POST 3 apps to job with capacity=2, verify 1 WAITLISTED
- [ ] Test promotion: Exit ACTIVE app, verify WAITLISTED becomes ACTIVE
- [ ] Check event log: `SELECT * FROM event_logs LIMIT 5;`
- [ ] Verify no over-capacity: `SELECT COUNT(*) FROM applications WHERE status='ACTIVE' GROUP BY job_id;`
- [ ] Inspect queue: `SELECT queue_position FROM applications WHERE status='WAITLISTED';`

## File Navigation

```
/server
  /db
    pool.js              ← PostgreSQL connection
    migrations/
      001-004_*.sql      ← Schema
  /routes
    jobs.js              ← Job CRUD
    applications.js      ← Core logic (apply, exit, ack)
    applicants.js        ← Applicant CRUD
  /services
    logService.js        ← Event logging
    promotionService.js  ← promoteNext(), reindexQueue()
    decayWorker.js       ← Periodic decay + cascade
  index.js               ← Express app + startup

/client
  /src
    /pages
      Dashboard.jsx      ← Job list + apply form
      ApplicantView.jsx  ← Applicant status view
    /components
      JobCard.jsx        ← Pipeline card
    /api
      index.js           ← Axios wrappers
    /styles
      *.css              ← Styling
    App.jsx              ← Router
    index.js             ← Entry point

/docs
  README.md              ← Full doc
  SETUP.md               ← Install guide
  CONCURRENCY.md         ← Race prevention
  TESTING.md             ← Integration tests
  QUICK_REF.md           ← This file
```

## Environment Setup

```bash
# Server
NODE_ENV=development
PORT=3001
DB_NAME=next_in_line
DB_USER=postgres
DB_PASSWORD=postgres
DB_HOST=localhost
DB_PORT=5432

# Client
REACT_APP_API_URL=http://localhost:3001
```

## Common Operations

### Add Applicant to Waitlist Manually
```javascript
// Via route: just POST /applications
// The route handles all logic automatically
```

### Force Decay (Testing)
```sql
UPDATE applications SET ack_deadline = NOW() - INTERVAL '1 second'
WHERE id = '<app_id>';
-- Wait 45s, decay worker will process
```

### View State Reconstruction
```sql
SELECT to_status FROM event_logs 
WHERE application_id = '<app_id>' 
ORDER BY timestamp DESC LIMIT 1;
-- Gives current status
```

### List Stale Applications
```sql
SELECT id, name, ack_deadline FROM applications a
JOIN applicants ap ON a.applicant_id = ap.id
WHERE status = 'ACTIVE' AND ack_deadline < NOW();
```

## Monitoring Dashboard Ideas

- Real-time job capacity gauges
- Queue depth per job
- Promotion frequency
- Decay events per hour
- Applicant acknowledgment warnings
- Event log audit trail
- Database connection pool status

---

**Last Updated**: April 13, 2025  
**Version**: 1.0.0  
**Stack**: PERN (PostgreSQL, Express, React, Node.js)
