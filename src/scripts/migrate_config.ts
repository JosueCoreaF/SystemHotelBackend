import { pool } from '../db.js';

async function migrate() {
  console.log('--- Iniciando migración de configuración operativa ---');
  try {
    await pool.query(`
      ALTER TABLE public.configuracion_operativa 
      ADD COLUMN IF NOT EXISTS hora_check_in TEXT DEFAULT '15:00';
    `);
    console.log('✅ Éxito: Columna hora_check_in añadida (o ya existía).');
  } catch (err) {
    console.error('❌ Error durante la migración:', err);
  } finally {
    await pool.end();
  }
}

migrate();
