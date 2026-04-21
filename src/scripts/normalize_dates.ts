import { pool } from '../db.js';

async function normalizeDates() {
  console.log('--- Iniciando normalización de fechas de reservas ---');
  try {
    const result = await pool.query(`
      UPDATE public.reservas_hotel 
      SET 
        check_in = (check_in::date + time '15:00:00')::timestamptz,
        check_out = (check_out::date + time '12:00:00')::timestamptz
      WHERE estado != 'cancelada'
      RETURNING id_reserva_hotel;
    `);
    console.log(`✅ Éxito: Se han normalizado ${result.rowCount} reservas.`);
  } catch (err) {
    console.error('❌ Error durante la normalización:', err);
  } finally {
    await pool.end();
  }
}

normalizeDates();
