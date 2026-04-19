#!/usr/bin/env node
/**
 * Test runner for stress tests
 * Usage: npm run test:stress
 */

import { Pool } from 'pg';
import { runAllStressTests } from './stress.test';

async function main() {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/ats',
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
    max: 20,
  });

  try {
    // Test connection
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✓ Database connected\n');

    // Run all stress tests
    await runAllStressTests(pool);

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('Failed to run tests:', err);
    await pool.end();
    process.exit(1);
  }
}

main();
