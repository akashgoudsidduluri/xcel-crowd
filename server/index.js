require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool, runMigrations } = require('./db/pool');
const { startDecayWorker } = require('./services/decayWorker');

// Import routes
const jobsRouter = require('./routes/jobs');
const applicationsRouter = require('./routes/applications');
const applicantsRouter = require('./routes/applicants');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/jobs', jobsRouter);
app.use('/applications', applicationsRouter);
app.use('/applicants', applicantsRouter);

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Startup sequence
async function start() {
  try {
    console.log('Connecting to database...');
    await pool.query('SELECT NOW()');
    console.log('✓ Database connection successful');

    console.log('\nRunning database migrations...');
    await runMigrations();

    console.log('\nStarting decay worker...');
    startDecayWorker(45 * 1000); // Run every 45 seconds

    app.listen(PORT, () => {
      console.log(`\n✓ Server running on port ${PORT}`);
      console.log(`\nAPI Endpoints:`);
      console.log('  POST   /jobs');
      console.log('  GET    /jobs');
      console.log('  GET    /jobs/:id');
      console.log('  GET    /jobs/:id/pipeline');
      console.log('  POST   /applicants');
      console.log('  GET    /applicants');
      console.log('  GET    /applicants/:id');
      console.log('  POST   /applications');
      console.log('  GET    /applications/:id');
      console.log('  POST   /applications/:id/ack');
      console.log('  POST   /applications/:id/exit');
    });
  } catch (err) {
    console.error('✗ Failed to start server:', err);
    process.exit(1);
  }
}

start();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Received SIGINT');
  process.exit(0);
});

module.exports = app;
