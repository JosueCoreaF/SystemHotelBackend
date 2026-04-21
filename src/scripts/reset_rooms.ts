import { pool } from '../db.js';

async function main() {
  const r = await pool.query(
    `UPDATE public.habitaciones SET estado = 'disponible' WHERE estado = 'mantenimiento' RETURNING codigo_habitacion, nombre_habitacion`
  );
  console.log('Habitaciones reseteadas:', r.rowCount);
  r.rows.forEach((x: any) => console.log(' -', x.nombre_habitacion, x.codigo_habitacion));

  await pool.query('DELETE FROM bloqueos_habitacion');
  console.log('Bloqueos previos eliminados');

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
