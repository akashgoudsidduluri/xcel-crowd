/**
 * ============================================================================
 * CENTRALIZED STATE MACHINE VALIDATION (PRODUCTION GRADE)
 * ============================================================================
 * 
 * CRITICAL RULES:
 * 1. Every application status transition MUST go through this module
 * 2. All transitions explicitly defined in VALID_TRANSITIONS
 * 3. ALWAYS validate before execution in database
 * 4. EVERY transition MUST be logged to audit_logs
 * 5. NO direct status updates outside this validation layer
 * 6. NO business logic directly mutating status in routes/services
 * 
 * VIOLATION = PRODUCTION FAILURE
 */

import { StateTransitionError } from './errors';

export type ApplicationStatus =
  | 'WAITLISTED'
  | 'PENDING_ACK'
  | 'ACTIVE'
  | 'INACTIVE'
  | 'HIRED'
  | 'REJECTED';

export const ALL_STATUSES: ApplicationStatus[] = [
  'WAITLISTED',
  'PENDING_ACK',
  'ACTIVE',
  'INACTIVE',
  'HIRED',
  'REJECTED',
];

/**
 * ============================================================================
 * EXPLICIT TRANSITION RULES
 * ============================================================================
 * 
 * WAITLISTED
 *   └─→ PENDING_ACK  (auto-promotion when capacity available)
 * 
 * PENDING_ACK
 *   ├─→ ACTIVE       (acknowledged by applicant before deadline)
 *   ├─→ WAITLISTED   (deadline expired, requeue with penalty)
 *   └─→ INACTIVE     (applicant withdrew)
 * 
 * ACTIVE
 *   ├─→ HIRED        (final outcome)
 *   ├─→ REJECTED     (final outcome)
 *   └─→ INACTIVE     (applicant withdrew)
 * 
 * INACTIVE (terminal)
 * HIRED (terminal)
 * REJECTED (terminal)
 * 
 * CRITICAL: NO direct transitions to ACTIVE during apply flow.
 *           ALWAYS go through PENDING_ACK first.
 */
const VALID_TRANSITIONS: Record<ApplicationStatus, Set<ApplicationStatus>> = {
  WAITLISTED: new Set(['PENDING_ACK', 'INACTIVE']),
  PENDING_ACK: new Set(['ACTIVE', 'WAITLISTED', 'INACTIVE']),
  ACTIVE: new Set(['HIRED', 'REJECTED', 'INACTIVE']),
  INACTIVE: new Set([]), // terminal
  HIRED: new Set([]), // terminal
  REJECTED: new Set([]), // terminal
};

/**
 * Validate that a state transition is allowed
 * Throws immediately if invalid - FAIL FAST
 * 
 * @param fromStatus Current state
 * @param toStatus Desired state
 * @throws Error with specific reason if transition invalid
 */
export function validateTransition(
  fromStatus: ApplicationStatus,
  toStatus: ApplicationStatus
): void {
  // Self-transitions not allowed
  if (fromStatus === toStatus) {
    throw new StateTransitionError(
      fromStatus,
      toStatus,
      'Cannot transition to the same state'
    );
  }

  // Check if transition exists in rules
  const allowedTransitions = VALID_TRANSITIONS[fromStatus];
  
  if (!allowedTransitions || !allowedTransitions.has(toStatus)) {
    const allowed = Array.from(allowedTransitions || []);
    throw new StateTransitionError(
      fromStatus,
      toStatus,
      `Allowed next states: ${allowed.length > 0 ? allowed.join(', ') : 'NONE (terminal state)'}`
    );
  }
}

/**
 * Check if transition is valid without throwing
 * Useful for conditional logic
 */
export function canTransition(
  fromStatus: ApplicationStatus,
  toStatus: ApplicationStatus
): boolean {
  try {
    validateTransition(fromStatus, toStatus);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get all allowed next states for a given status
 * Returns empty array if terminal state
 */
export function getAllowedNextStates(status: ApplicationStatus): ApplicationStatus[] {
  return Array.from(VALID_TRANSITIONS[status] || []);
}

/**
 * Check if status is terminal (no further transitions allowed)
 */
export function isTerminalStatus(status: ApplicationStatus): boolean {
  const transitions = VALID_TRANSITIONS[status];
  return !transitions || transitions.size === 0;
}

/**
 * Get human-readable description of transition
 * Useful for audit logs and error messages
 */
export function getTransitionDescription(
  fromStatus: ApplicationStatus,
  toStatus: ApplicationStatus
): string {
  const descriptions: Record<string, string> = {
    'WAITLISTED→PENDING_ACK': 'Auto-promoted from waitlist to pending acknowledgment',
    'WAITLISTED→INACTIVE': 'Applicant withdrew while on waitlist',
    'PENDING_ACK→ACTIVE': 'Applicant acknowledged and moved to active',
    'PENDING_ACK→WAITLISTED': 'Acknowledgment expired; requeued with penalty',
    'PENDING_ACK→INACTIVE': 'Applicant withdrew during pending acknowledgment',
    'ACTIVE→HIRED': 'Applicant hired',
    'ACTIVE→REJECTED': 'Applicant rejected',
    'ACTIVE→INACTIVE': 'Applicant withdrew from active position',
  };
  
  const key = `${fromStatus}→${toStatus}`;
  return descriptions[key] || 'State transition';
}
