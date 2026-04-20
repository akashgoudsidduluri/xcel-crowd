/**
 * DATABASE TYPES & INTERFACES
 * ============================
 * 
 * Centralized type definitions for type-safe database operations.
 */

import { PoolClient, QueryResult } from 'pg';
import { ApplicationStatus } from '../stateMachine';

export interface Job {
  id: string;
  title: string;
  capacity: number;
  created_by?: string;
  created_at: Date;
}

export interface Applicant {
  id: string;
  name: string;
  email: string;
  created_at: Date;
}

export interface Application {
  id: string;
  job_id: string;
  applicant_id: string;
  status: ApplicationStatus;
  queue_position: number | null;
  ack_deadline: Date | null;
  penalty_count: number;
  last_transition_at: Date;
  created_at: Date;
}

export interface AuditLog {
  id: string;
  application_id: string;
  from_status: string;
  to_status: string;
  metadata: Record<string, any>;
  created_at: Date;
}

/**
 * Transaction context
 * Pass to all database operations to ensure atomicity
 */
export interface TransactionContext {
  client: PoolClient;
  query: (text: string, values?: any[]) => Promise<QueryResult>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Capacity check result
 */
export interface CapacityCheckResult {
  activeCount: number;
  capacity: number;
  hasCapacity: boolean;
  slotsAvailable: number;
}

/**
 * Promotion result
 */
export interface PromotionResult {
  promoted: number;
  nextApplicationId: string | null;
}

/**
 * Queue information
 */
export interface QueueInfo {
  jobId: string;
  capacity: number;
  activeCount: number;
  waitlistedCount: number;
  queue: QueueEntry[];
}

export interface QueueEntry {
  applicationId: string;
  applicantEmail: string;
  applicantName: string;
  queuePosition: number;
  status: ApplicationStatus;
  createdAt: Date;
}
