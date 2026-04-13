const { v4: uuidv4 } = require('uuid');

/**
 * Log a state transition to event_logs table
 * MUST be called within the same transaction as the status change
 */
async function logTransition(client, applicationId, fromStatus, toStatus, metadata = {}) {
  const logId = uuidv4();
  const query = `
    INSERT INTO event_logs (id, application_id, from_status, to_status, timestamp, metadata)
    VALUES ($1, $2, $3, $4, NOW(), $5)
  `;
  
  await client.query(query, [
    logId,
    applicationId,
    fromStatus,
    toStatus,
    JSON.stringify(metadata),
  ]);

  return logId;
}

/**
 * Retrieve full event history for an application
 */
async function getApplicationEventHistory(pool, applicationId) {
  const query = `
    SELECT 
      id,
      application_id,
      from_status,
      to_status,
      timestamp,
      metadata
    FROM event_logs
    WHERE application_id = $1
    ORDER BY timestamp ASC
  `;

  const result = await pool.query(query, [applicationId]);
  return result.rows;
}

/**
 * Reconstruct application state from event logs
 */
async function reconstructApplicationState(pool, applicationId) {
  const events = await getApplicationEventHistory(pool, applicationId);
  
  if (events.length === 0) {
    return null;
  }

  const finalEvent = events[events.length - 1];
  return {
    applicationId,
    currentStatus: finalEvent.to_status,
    transitionCount: events.length,
    firstTransition: events[0].timestamp,
    lastTransition: finalEvent.timestamp,
    eventHistory: events,
  };
}

module.exports = {
  logTransition,
  getApplicationEventHistory,
  reconstructApplicationState,
};
