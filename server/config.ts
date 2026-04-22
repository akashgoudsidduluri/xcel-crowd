import 'dotenv/config';

export const config = {
  DB_USER: process.env.DB_USER || 'postgres',
  DB_PASSWORD: process.env.DB_PASSWORD || 'postgres',
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_PORT: parseInt(process.env.DB_PORT || '5432', 10),
  DB_NAME: process.env.DB_NAME || 'next_in_line',
  DATABASE_URL: process.env.DATABASE_URL,
  PORT: parseInt(process.env.PORT || '3001', 10),
  DECAY_INTERVAL: parseInt(process.env.DECAY_INTERVAL || '5000', 10),
};
