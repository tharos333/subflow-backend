import Knex from 'knex';

export const db = Knex({
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: { min: 2, max: 10 },
  acquireConnectionTimeout: 10000,
});
