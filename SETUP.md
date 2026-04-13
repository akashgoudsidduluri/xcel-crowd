# Setup Guide for Next In Line

## Prerequisites

- **Node.js 16+**: https://nodejs.org/
- **PostgreSQL 12+**: https://www.postgresql.org/
- **npm 7+**: Comes with Node.js

## 1. Database Setup

### Windows (PowerShell)
```powershell
# Start PostgreSQL
# (Usually runs as Windows service automatically)

# Open PostgreSQL terminal
psql -U postgres

# Inside psql:
CREATE DATABASE next_in_line;
\q
```

### macOS (Homebrew)
```bash
# Install PostgreSQL if needed
brew install postgresql

# Start PostgreSQL service
brew services start postgresql

# Create database
createdb next_in_line
```

### Linux (Ubuntu/Debian)
```bash
# Install PostgreSQL if needed
sudo apt-get install postgresql postgresql-contrib

# Start service
sudo systemctl start postgresql

# Create database (as postgres user)
sudo -u postgres createdb next_in_line
```

## 2. Environment Configuration

### Create `.env.local` files

### Server: `server/.env.local`
```
NODE_ENV=development
PORT=3001
DB_NAME=next_in_line
DB_USER=postgres
DB_PASSWORD=postgres
DB_HOST=localhost
DB_PORT=5432
```

### Client: `client/.env.local`
```
REACT_APP_API_URL=http://localhost:3001
```

## 3. Install Dependencies

### Server
```bash
cd server
npm install
```

### Client
```bash
cd client
npm install
```

## 4. Start the Application

### Terminal Window 1 — Backend
```bash
cd server
npm start
```

Expected output:
```
✓ Database connection successful

Running database migrations...
✓ Migration completed: 001_create_jobs.sql
✓ Migration completed: 002_create_applicants.sql
✓ Migration completed: 003_create_applications.sql
✓ Migration completed: 004_create_event_logs.sql
All migrations completed.

[DECAY WORKER] Started with interval: 45000ms

✓ Server running on port 3001
```

### Terminal Window 2 — Frontend
```bash
cd client
npm start
```

Your browser should open automatically to `http://localhost:3000`

## 5. Verify Setup

### API Health Check
```bash
curl http://localhost:3001/health
```

Expected response:
```json
{ "status": "ok", "timestamp": "2025-04-13T15:30:00.000Z" }
```

### Database Verification
```bash
psql -d next_in_line

-- Check tables exist
\dt
```

Expected tables: jobs, applicants, applications, event_logs

## 6. First Test Run

### Create a Job
1. Go to http://localhost:3000
2. Click "+ New Job"
3. Enter title: "Software Engineer"
4. Enter capacity: 3
5. Click "Create Job"

### Submit Applications
1. Click "+ Apply" on the job card
2. Enter applicant name: "Alice Johnson"
3. Enter email: "alice@example.com"
4. Click "Submit Application"
5. Repeat for 4 more applicants with different emails

**Expected behavior:**
- First 3 applications → status: ACTIVE
- 4th and 5th applications → status: WAITLISTED (queue positions 0, 1)

### Test Promotion
1. Click on one ACTIVE applicant
2. Click "Reject"
3. Refresh page or wait 15 seconds
4. The first WAITLISTED applicant is now ACTIVE

## 7. Troubleshooting

### "ECONNREFUSED" on server startup
**Problem**: Cannot connect to PostgreSQL
**Solution**:
```bash
# Verify PostgreSQL is running
psql -U postgres

# If fails, start PostgreSQL:
# Windows: Services → PostgreSQL Server → Start
# macOS: brew services start postgresql
# Linux: sudo systemctl start postgresql
```

### "Password authentication failed"
**Problem**: Wrong credentials in .env
**Solution**:
```bash
# Check PostgreSQL password
sudo -u postgres psql

# Set new password if needed:
ALTER USER postgres WITH PASSWORD 'postgres';
```

### Port 3001 already in use
**Problem**: Another app is using port 3001
**Solution**:
```bash
# Change port in server/.env.local
PORT=3002

# Also update client/.env.local
REACT_APP_API_URL=http://localhost:3002
```

### Blank page on http://localhost:3000
**Problem**: React development server not started
**Solution**:
```bash
cd client
rm -rf node_modules package-lock.json
npm install
npm start
```

### Error: "Cannot find module 'pg'"
**Problem**: Dependencies not installed
**Solution**:
```bash
cd server
npm install
# Wait for completion, then npm start
```

## 8. Database Commands

### Check Job Status
```bash
psql -d next_in_line

SELECT id, title, capacity, active_count 
FROM jobs 
ORDER BY created_at DESC;
```

### View Event History
```bash
SELECT application_id, from_status, to_status, timestamp 
FROM event_logs 
ORDER BY timestamp DESC 
LIMIT 20;
```

### Inspect Queue Positions
```bash
SELECT name, status, queue_position 
FROM applications a
JOIN applicants ap ON a.applicant_id = ap.id
WHERE a.status IN ('ACTIVE', 'WAITLISTED')
ORDER BY a.status, a.queue_position;
```

### Reset Database (if needed)
```bash
-- Drop and recreate
DROP DATABASE IF EXISTS next_in_line;
CREATE DATABASE next_in_line;

-- Then restart server to re-run migrations
```

## 9. Development Tips

### Enable Detailed Logging
Set in `server/index.js`:
```javascript
// Add console.log() calls in route handlers for debugging
```

### Monitor Decay Worker
Look for these logs:
```
[DECAY WORKER] Found X expired applications
[DECAY WORKER] Processed application <uuid>
```

### Live Database Inspection
Keep a terminal running:
```bash
psql -d next_in_line

-- Then in psql, run queries and refresh with \e
```

### Frontend Hot Reload
React dev server automatically reloads on file changes

### Backend Hot Reload (optional)
Install nodemon for auto-restart:
```bash
npm install --save-dev nodemon

# Edit server/package.json:
# "dev": "nodemon index.js"

npm run dev
```

## 10. Next Steps

- [ ] Review the [README.md](../README.md) for architecture details
- [ ] Test concurrent applications for the same job
- [ ] Wait 45+ seconds to observe decay worker in action
- [ ] Inspect event_logs to see full audit trail
- [ ] Deploy to cloud (Heroku, Vercel, etc.)

---

For troubleshooting or questions, check the main README.md or GitHub Issues.
