import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runMigration() {
  try {
    console.log('Ejecutando migración...');
    
    const sql = `
      ALTER TABLE public.habitaciones
      ADD COLUMN IF NOT EXISTS nombre_alias text,
      ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'Clase grupal';

      CREATE INDEX IF NOT EXISTS idx_habitaciones_nombre_alias ON public.habitaciones(nombre_alias);
      CREATE INDEX IF NOT EXISTS idx_habitaciones_tipo ON public.habitaciones(tipo);
    `;

    await pool.query(sql);
    console.log('✅ Migración completada exitosamente');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migración:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
