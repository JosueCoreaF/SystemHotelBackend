import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL
  ?? process.env.POSTGRES_URL
  ?? process.env.POSTGRES_PRISMA_URL
  ?? process.env.SUPABASE_DB_URL;

if (!databaseUrl) {
  throw new Error(
    'No se encontro una conexion PostgreSQL. Define DATABASE_URL, POSTGRES_URL o SUPABASE_DB_URL en .env antes de iniciar la API.',
  );
}

const ssl = databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
  ? false
  : { rejectUnauthorized: false };

export const pool = new Pool({
  connectionString: databaseUrl,
  ssl,
});

export async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>, userId?: string | null) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (userId) {
      // Set session context for Supabase auth.uid() compatibility
      await client.query(
        `
        SELECT 
          set_config('request.jwt.claims', json_build_object('sub', $1::text)::text, true),
          set_config('request.jwt.claim.sub', $1::text, true)
        `,
        [userId]
      );
    }
    const result = await work(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}