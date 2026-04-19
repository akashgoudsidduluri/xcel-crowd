const request = require('supertest');
const app = require('../index');
const { pool } = require('../db/pool');

// Mock the database pool so we don't hit the real database during CI
jest.mock('../db/pool', () => {
  const mPool = {
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    }),
    query: jest.fn(),
  };
  return { pool: mPool, runMigrations: jest.fn() };
});

// Mock decay worker to avoid setTimeouts keeping tests open
jest.mock('../services/decayWorker', () => ({
  startDecayWorker: jest.fn(),
  stopDecayWorker: jest.fn(),
}));

describe('API Route Validations (Zod Integration)', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /jobs', () => {
    it('should return 400 VALIDATION_ERROR if required fields are missing', async () => {
      const res = await request(app)
        .post('/jobs')
        .send({ title: '' }); // Missing capacity, invalid title length
      
      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      
      // Should flag both missing capacity and empty title
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'title', message: 'Title is required' }),
          expect.objectContaining({ path: 'capacity' })
        ])
      );
    });

    it('should pass validation and call DB if valid payload', async () => {
      // Setup mock DB response for successful job creation
      pool.query.mockResolvedValueOnce({ 
        rows: [{ id: '123', title: 'Engineer', capacity: 3, active_count: 0 }] 
      });

      const res = await request(app)
        .post('/jobs')
        .send({ title: 'Engineer', capacity: 3 });

      expect(res.statusCode).toBe(201);
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('POST /applications', () => {
    it('should validate email format and reject invalid UUIDs', async () => {
      const res = await request(app)
        .post('/applications')
        .send({ 
          name: 'John Doe', 
          email: 'not-an-email', 
          job_id: 'invalid-string' 
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'email', message: 'Invalid email format' }),
          expect.objectContaining({ path: 'job_id', message: 'Invalid job ID format' })
        ])
      );
    });
  });

});
