import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const databaseUrl = process.env.DATABASE_URL
  ?? process.env.POSTGRES_URL
  ?? process.env.POSTGRES_PRISMA_URL
  ?? process.env.SUPABASE_DB_URL;

if (!databaseUrl) {
  console.error('❌ No DATABASE_URL found');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

async function runMigration() {
  try {
    console.log('📦 Ejecutando migración: add_status_fields.sql');
    
    const migrationPath = path.join(__dirname, '..', 'sql', 'add_status_fields.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    
    const client = await pool.connect();
    
    try {
      await client.query(sql);
      console.log('✅ Migración completada exitosamente');
    } finally {
      client.release();
    }
    
    // Verificar los cambios
    const checkResult = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'reservas_hotel' 
      AND column_name IN ('estado_pago', 'estado_habitacion', 'detalles_estado')
      ORDER BY column_name
    `);
    
    console.log('\n✓ Campos verificados:');
    checkResult.rows.forEach(row => {
      console.log(`  - ${row.column_name}: ${row.data_type}`);
    });
    
  } catch (error) {
    console.error('❌ Error en migración:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
