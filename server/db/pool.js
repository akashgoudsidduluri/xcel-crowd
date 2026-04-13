const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Initialize PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'next_in_line',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Run migrations
async function runMigrations() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).sort();

  console.log('Running database migrations...');
  for (const file of files) {
    if (file.endsWith('.sql')) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      try {
        await pool.query(sql);
        console.log(`✓ Migration completed: ${file}`);
      } catch (err) {
        if (err.code === '42P07') {
          console.log(`⚠ Already exists, skipping: ${file}`);
          continue;
        }
        console.error(`✗ Migration failed: ${file}`, err.message);
        throw err;
      }
    }
  }
  console.log('All migrations completed.\n');
}

module.exports = { pool, runMigrations };
