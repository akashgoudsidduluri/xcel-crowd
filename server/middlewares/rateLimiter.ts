import rateLimit from 'express-rate-limit';

/**
 * ============================================================================
 * RATE LIMITERS
 * ============================================================================
 * 
 * Lightweight, in-memory rate limiting for critical endpoints.
 */

// Strict: For application intake (high sensitivity)
export const applyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  message: "Too many applications, try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

// Moderate: For state transitions and status changes
export const actionLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: "Too many actions, try again later",
  standardHeaders: true,
  legacyHeaders: false,
});

// Relaxed: For administrative or general creation tasks
export const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: "Rate limit exceeded, try again later",
  standardHeaders: true,
  legacyHeaders: false,
});
