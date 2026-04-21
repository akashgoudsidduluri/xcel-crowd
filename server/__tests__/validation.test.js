const request = require('supertest');

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

const { pool } = require('../db/pool');
const { createApp } = require('../index');

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
      expect(res.body.details).toEqual(expect.any(Array));
      expect(res.body.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['title'] }),
          expect.objectContaining({ path: ['capacity'] }),
        ])
      );
    });

    it('should pass validation and call DB if valid payload', async () => {
      const client = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({
            rows: [{ id: '123', title: 'Engineer', capacity: 3, created_by: null, created_at: new Date().toISOString() }],
          }) // INSERT ... RETURNING
          .mockResolvedValueOnce({ rows: [] }), // COMMIT
        release: jest.fn(),
      };
      pool.connect.mockResolvedValueOnce(client);

      const res = await request(app)
        .post('/jobs')
        .send({ title: 'Engineer', capacity: 3 });

      expect(res.statusCode).toBe(201);
      expect(client.query).toHaveBeenCalled();
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
