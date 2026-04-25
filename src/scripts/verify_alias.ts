import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function verifyAlias() {
  try {
    const result = await pool.query(
      `SELECT id_habitacion, nombre_habitacion, nombre_alias, tipo FROM public.habitaciones WHERE nombre_habitacion = 'Salon de Conferencias' LIMIT 1`
    );

    if (result.rows.length > 0) {
      const room = result.rows[0];
      console.log('\n✅ Habitación encontrada:');
      console.log(`   ID: ${room.id_habitacion}`);
      console.log(`   Nombre: ${room.nombre_habitacion}`);
      console.log(`   Alias: ${room.nombre_alias || '(vacío)'}`);
      console.log(`   Tipo: ${room.tipo || '(vacío)'}`);
    } else {
      console.log('❌ Habitación no encontrada');
    }
    
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

verifyAlias();
