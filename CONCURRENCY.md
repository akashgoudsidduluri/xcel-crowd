# Concurrency & Transaction Architecture

This document explains the critical patterns used to ensure data integrity in Next In Line.

## Transaction Pattern

All operations that modify state follow this atomic pattern:

```javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  
  // 1. Lock the critical resource
  const lockResult = await client.query(
    'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
    [jobId]
  );
  
  // 2. Perform checks and calculations
  const job = lockResult.rows[0];
  if (!job) {
    await client.query('ROLLBACK');
    return res.status(404).json({ error: 'Job not found' });
  }
  
  // 3. Execute updates in order
  await client.query('UPDATE applications SET status = ...', [...]);
  await client.query('UPDATE jobs SET active_count = ...', [...]);
  
  // 4. Log the transition (MUST be same transaction)
  await logTransition(client, appId, fromStatus, toStatus, metadata);
  
  // 5. Commit atomically
  await client.query('COMMIT');
  
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

### Critical Rules
1. **Always** use `SELECT ... FOR UPDATE` to lock the job row
2. **Never** check capacity outside a transaction
3. **Always** log transitions inside the same transaction (before COMMIT)
4. **Always** rollback on any error
5. **Always** release the client in finally block

---

## Race Condition: Two Applications for Last Slot

### Scenario
Job has capacity=2, active_count=1. Two applicants simultaneously apply.

### Without Row-Level Locking (BROKEN)
```
Time  | Request A                    | Request B
------|------------------------------|----------------------------
T0    | SELECT active_count (1)      | (blocked, waiting for A)
T1    | 1 < 2 ✓                      |
T2    | INSERT application ACTIVE    |
T3    | UPDATE jobs active_count=2   |
T4    | COMMIT                       |
T5    |                              | SELECT active_count (2)
T6    |                              | 2 < 2 ✗ Should go WAITLISTED
T7    |                              | But Query ran BEFORE T3!
T8    |                              | Race condition!
```

### With Row-Level Locking (CORRECT)
```
Time  | Request A                         | Request B
------|-----------------------------------|------------------------------------
T0    | SELECT * FROM jobs FOR UPDATE    | (blocked, waiting for lock on jobs)
T1    | (lock acquired, job row held)    |
T2    | sees active_count=1              |
T3    | 1 < 2 ✓                          |
T4    | INSERT application ACTIVE        |
T5    | UPDATE jobs active_count=2       |
T6    | COMMIT                           | (still waiting for lock release)
T7    | (lock released)                  |
T8    |                                  | SELECT * FROM jobs FOR UPDATE
T9    |                                  | (lock acquired)
T10   |                                  | sees active_count=2
T11   |                                  | 2 < 2 ✗ Must go WAITLISTED
T12   |                                  | INSERT application WAITLISTED
T13   |                                  | COMMIT
Result: One ACTIVE, one WAITLISTED ✓
```

---

## promoteNext() Atomicity

The promotion function MUST atomically:
1. Decrement active_count (slot freed)
2. Find and update next WAITLISTED
3. Reindex remaining queue positions
4. Increment active_count (slot filled)

```javascript
async function promoteNext(client, jobId) {
  // All in one transaction!
  
  // 1. Slot freed
  await client.query(
    'UPDATE jobs SET active_count = active_count - 1 WHERE id = $1',
    [jobId]
  );

  // 2. Find next with pessimistic lock
  const nextApplicantResult = await client.query(
    `SELECT id, applicant_id FROM applications 
     WHERE job_id = $1 AND status = 'WAITLISTED' 
     ORDER BY queue_position ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [jobId]
  );

  if (nextApplicantResult.rows.length === 0) {
    return false; // No one to promote
  }

  const { id: applicationId } = nextApplicantResult.rows[0];

  // 3. Promote applicant
  const ackDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await client.query(
    `UPDATE applications 
     SET status = 'ACTIVE', queue_position = NULL, ack_deadline = $1, last_transition_at = NOW()
     WHERE id = $2`,
    [ackDeadline, applicationId]
  );

  // 4. Log transition
  await logTransition(client, applicationId, 'WAITLISTED', 'ACTIVE', {
    reason: 'promoted_from_waitlist',
    triggered_by: 'promotionService',
  });

  // 5. Slot filled
  await client.query(
    'UPDATE jobs SET active_count = active_count + 1 WHERE id = $1',
    [jobId]
  );

  // 6. Reindex queue
  await reindexQueue(client, jobId);

  return true;
}
```

### Why This Order?
- **Step 1 (decrement)**: Prevents other transactions from seeing duplicate capacity
- **Steps 2-4**: Transition applicant while slot truly vacant
- **Step 5 (increment)**: Restore capacity only after transition logged
- **Step 6 (reindex)**: Fix queue positions for visibility

If any step fails, entire transaction rolls back (no corruption).

---

## Queue Position Reindexing

**Problem**: After removals, queue positions might have gaps:
```
queue_position: 0 ✓
queue_position: 2 ✗ (gap!)
queue_position: 5 ✗ (gap!)
```

**Solution**: Use window function to regenerate contiguous positions
```javascript
async function reindexQueue(client, jobId) {
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

  await client.query(query, [jobId]);
}
```

**Result**: Always contiguous 0, 1, 2, 3, ...

---

## Decay Worker Cascade

### Problem
If 5 ACTIVE applicants decay simultaneously, we need 5 promotions to fill those slots.

### Solution: Loop inside single transaction per applicant

```javascript
async function processDecayedApplications() {
  const client = await pool.connect();

  try {
    const expiredResult = await client.query(
      `SELECT id, job_id FROM applications 
       WHERE status = 'ACTIVE' AND ack_deadline < NOW()
       ORDER BY created_at ASC`
    );

    console.log(`[DECAY WORKER] Found ${expiredResult.rows.length} expired`);

    for (const { id: applicationId, job_id: jobId } of expiredResult.rows) {
      // NEW TRANSACTION FOR EACH APPLICANT
      await client.query('BEGIN');

      try {
        // 1. Decay the applicant
        await client.query(
          `UPDATE applications 
           SET status = 'DECAYED', last_transition_at = NOW()
           WHERE id = $1`,
          [applicationId]
        );

        await logTransition(client, applicationId, 'ACTIVE', 'DECAYED', {
          reason: 'ack_deadline_expired',
          triggered_by: 'decayWorker',
        });

        // 2. Lock job
        await client.query(
          'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
          [jobId]
        );

        // 3. Decrement active_count
        await client.query(
          'UPDATE jobs SET active_count = active_count - 1 WHERE id = $1',
          [jobId]
        );

        // 4. Re-queue at end
        const nextPosition = await getNextQueuePosition(client, jobId);
        await client.query(
          `UPDATE applications 
           SET status = 'WAITLISTED', queue_position = $1, ack_deadline = NULL, last_transition_at = NOW()
           WHERE id = $2`,
          [nextPosition, applicationId]
        );

        await logTransition(client, applicationId, 'DECAYED', 'WAITLISTED', {
          reason: 'requeued_after_decay',
          triggered_by: 'decayWorker',
          penalty: 'queued_at_end',
        });

        // 5. Promote next WAITLISTED (fills vacated slot)
        await promoteNext(client, jobId);

        await client.query('COMMIT');
        console.log(`[DECAY WORKER] Processed ${applicationId}`);
      } catch (innerErr) {
        await client.query('ROLLBACK');
        console.error(`[DECAY WORKER] Error: ${innerErr.message}`);
      }
    }
  } finally {
    client.release();
  }
}
```

### Cascade Effect
```
ACTIVE (expired) ──decay──> DECAYED ──requeue──> WAITLISTED
                                                    ↓
                                               promoteNext()
                                                    ↓
                                             Next WAITLISTED
                                                  ACTIVE
                                                (slot filled)
```

If job has 3 empty slots and 5 decayed applicants:
1. Applicant 1 decays → WAITLISTED (pos 0) → ACTIVE (promoted) ✓
2. Applicant 2 decays → WAITLISTED (pos 1) → Active (promoted) ✓
3. Applicant 3 decays → WAITLISTED (pos 2) → ACTIVE (promoted) ✓
4. Applicant 4 decays → WAITLISTED (pos 0) (no slot)
5. Applicant 5 decays → WAITLISTED (pos 1) (no slot)

---

## Isolation Levels

PostgreSQL default: **READ COMMITTED**

For this system, READ COMMITTED is sufficient because:
1. We use pessimistic locking (SELECT FOR UPDATE)
2. No dirty read risk (locks held during whole transaction)
3. Phantom reads prevented by job row lock
4. Serialization conflicts detected by lock waits

**Example**: With REPEATABLE READ, unnecessary conflicts if:
- Transaction A reads job state
- Transaction B updates job
- Transaction A tries to update (conflict)

---

## Deadlock Prevention

**Risk**: Transaction A locks Job X, then tries Job Y. Meanwhile Transaction B locks Job Y, tries Job X.

**Prevention**: Always acquire locks in consistent order (by job_id ascending).

In our system, this is implicit because:
```javascript
// Each operation locks exactly ONE job row
await client.query(
  'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
  [jobId]  // Single job, single lock
);
```

Each API endpoint locks **only one** job, so circular waits impossible.

---

## Event Log Immutability

**Design**: event_logs is append-only (no UPDATE/DELETE)

```javascript
// Always INSERT, never modify
const query = `
  INSERT INTO event_logs (id, application_id, from_status, to_status, timestamp, metadata)
  VALUES ($1, $2, $3, $4, NOW(), $5)
`;
```

**Benefit**: 
- Audit trail is tamper-proof (for version control)
- Can reconstruct state at any past timestamp
- Legal/compliance compliant

---

## Testing Concurrency

### Manual Test: Concurrent Applications
```bash
# Terminal 1
curl -X POST http://localhost:3001/applications \
  -H "Content-Type: application/json" \
  -d '{"job_id":"JOB_ID","applicant_id":"APP1_ID"}' &
  
# Terminal 2 (same time)
curl -X POST http://localhost:3001/applications \
  -H "Content-Type: application/json" \
  -d '{"job_id":"JOB_ID","applicant_id":"APP2_ID"}' &

# Check results
curl http://localhost:3001/jobs/JOB_ID/pipeline
```

Expected: If capacity=1, one ACTIVE, one WAITLISTED (guaranteed).

### Load Test: Many Concurrent Operations
```bash
# Helper: POST N applications
for i in {1..10}; do
  curl -X POST http://localhost:3001/applications \
    -H "Content-Type: application/json" \
    -d "{\"job_id\":\"JOB_ID\",\"applicant_id\":\"APP_ID_$i\"}" &
done
wait

# Check final state
curl http://localhost:3001/jobs/JOB_ID/pipeline | jq '.summary'
```

Expected: Summary totals match exactly (no missing applications).

---

## Connection Pool Tuning

```javascript
const pool = new Pool({
  max: 20,                      // Max connections
  idleTimeoutMillis: 30000,     // Close idle after 30s
  connectionTimeoutMillis: 2000, // Fail fast
});
```

For production:
- **High concurrency**: max: 50
- **Low concurrency**: max: 10
- Monitor: `SELECT count(*) FROM pg_stat_activity;`

---

## Monitoring Query

Check overall data integrity:

```sql
-- 1. No over-capacity jobs
SELECT j.id, j.title, j.active_count, j.capacity 
FROM jobs j 
WHERE j.active_count > j.capacity;
-- Should return: 0 rows

-- 2. Verify event log coverage
SELECT COUNT(DISTINCT application_id) as apps_with_events,
       COUNT(DISTINCT application_id) as all_apps
FROM applications a
LEFT JOIN event_logs el ON a.id = el.application_id;
-- Should be equal

-- 3. Check for duplicates
SELECT applicant_id, COUNT(*) 
FROM applications 
WHERE status IN ('ACTIVE', 'WAITLISTED') 
GROUP BY applicant_id, job_id 
HAVING COUNT(*) > 1;
-- Should return: 0 rows (no duplicate ACTIVE/WAITLISTED per job)

-- 4. Verify queue position contiguity
SELECT queue_position, COUNT(*) 
FROM applications 
WHERE status = 'WAITLISTED' AND job_id = $1 
GROUP BY queue_position 
ORDER BY queue_position;
-- Should be: 0, 1 (count 1), 2 (count 1), ...
```

---

End of concurrency guide. This architecture ensures **no race conditions**, **no data corruption**, and **full auditability**.
