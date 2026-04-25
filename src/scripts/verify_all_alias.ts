import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function verifyAllAlias() {
  try {
    const result = await pool.query(
      `SELECT nombre_habitacion, nombre_alias FROM public.habitaciones ORDER BY nombre_habitacion`
    );

    console.log('\n📋 Alias de todas las habitaciones:\n');
    result.rows.forEach(row => {
      console.log(`  ${row.nombre_habitacion.padEnd(25)} → ${row.nombre_alias || '(sin alias)'}`);
    });
    
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyAllAlias();
