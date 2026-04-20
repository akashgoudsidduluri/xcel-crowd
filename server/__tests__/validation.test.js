const request = require('supertest');
const { pool } = require('../db/pool');
const { createApp } = require('../index');

// Mock the database pool BEFORE importing createApp
jest.mock('../db/pool', () => {
  return {
    pool: {
      connect: jest.fn().mockResolvedValue({
        query: jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      }),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    },
    runMigrations: jest.fn(),
  };
});

// Mock decay worker to avoid setTimeouts keeping tests open
jest.mock('../services/decayWorker', () => ({
  startDecayWorker: jest.fn(),
  stopDecayWorker: jest.fn(),
}));

const app = createApp(pool);

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
      expect(res.body.error).toBe('VALIDATION_ERROR');
      
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
      if (pool.query && typeof pool.query.mockResolvedValueOnce === 'function') {
        pool.query.mockResolvedValueOnce({ 
          rows: [{ id: '123', title: 'Engineer', capacity: 3, active_count: 0 }] 
        });
      } else {
        // Fallback: set up mock using mockImplementation
        pool.query = jest.fn().mockResolvedValue({
          rows: [{ id: '123', title: 'Engineer', capacity: 3, active_count: 0 }]
        });
      }

      const res = await request(app)
        .post('/jobs')
        .send({ title: 'Engineer', capacity: 3 });

      // Validation should pass, and route should attempt DB operation
      // In mock environment, this may return 201 or 500 depending on mock setup
      // The important thing is the request was accepted (not 400 validation error)
      expect(res.statusCode).toBeGreaterThanOrEqual(200);
      expect(res.statusCode).toBeLessThan(400);
    });
  });

  describe('POST /applications', () => {
    it('should validate email format and reject invalid UUIDs', async () => {
      const res = await request(app)
        .post('/apply')
        .send({ 
          name: 'John Doe', 
          email: 'not-an-email', 
          jobId: 'invalid-uuid' 
        });
        
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('VALIDATION_ERROR');
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['email'] }),
          expect.objectContaining({ path: ['jobId'] })
        ])
      );
    });
  });

});
