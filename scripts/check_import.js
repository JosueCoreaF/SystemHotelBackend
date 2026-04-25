import dotenv from 'dotenv';
import { pool } from '../dist/db.js';

dotenv.config();

async function main() {
  try {
    const resHabCaf = await pool.query(
      'SELECT id_habitacion, codigo_habitacion, nombre_habitacion FROM public.habitaciones WHERE codigo_habitacion = $1 LIMIT 1',
      ['CAFETERIA']
    );
    const resHabTemp = await pool.query(
      'SELECT id_habitacion, codigo_habitacion, nombre_habitacion FROM public.habitaciones WHERE codigo_habitacion = $1 LIMIT 1',
      ['TEMP-TEST-123']
    );
    const habCaf = resHabCaf.rows[0] ?? null;
    const habTemp = resHabTemp.rows[0] ?? null;

    let bloqueosCaf = [];
    if (habCaf) {
      const b = await pool.query(
        'SELECT id_bloqueo, id_habitacion, fecha_inicio, fecha_fin, motivo FROM public.bloqueos_habitacion WHERE id_habitacion = $1 ORDER BY fecha_inicio DESC LIMIT 10',
        [habCaf.id_habitacion]
      );
      bloqueosCaf = b.rows;
    }

    let reservasTemp = [];
    if (habTemp) {
      const r = await pool.query(
        'SELECT id_reserva_hotel, id_habitacion, check_in, check_out, estado, total_reserva FROM public.reservas_hotel WHERE id_habitacion = $1 ORDER BY check_in DESC LIMIT 10',
        [habTemp.id_habitacion]
      );
      reservasTemp = r.rows;
    }

    const checkInDates = ['2026-04-30', '2026-05-02'];
    const reservasByDate = {};
    for (const d of checkInDates) {
      const q = await pool.query(
        "SELECT id_reserva_hotel, id_habitacion, check_in, estado, total_reserva FROM public.reservas_hotel WHERE check_in::date = $1::date",
        [d]
      );
      reservasByDate[d] = q.rows;
    }

    console.log(JSON.stringify({ habCaf, habTemp, bloqueosCaf, reservasTemp, reservasByDate }, null, 2));
  } catch (err) {
    console.error('ERROR', err);
  } finally {
    await pool.end();
  }
}

main();
