const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Todas las reservas activas en los próximos 30 días
  const res = await pool.query(`
    SELECT rh.check_in, rh.check_out, rh.estado,
           h.nombre_habitacion, h.nombre_alias
    FROM public.reservas_hotel rh
    JOIN public.habitaciones h ON h.id_habitacion = rh.id_habitacion
    WHERE rh.estado NOT IN ('cancelada','check_out','no_show')
      AND rh.check_out > NOW()
      AND rh.check_in < NOW() + INTERVAL '30 days'
    ORDER BY rh.check_in
  `);
  console.log('\nReservas activas (próximos 30 días):', res.rows.length);
  res.rows.forEach(r => {
    const ci = new Date(r.check_in).toLocaleDateString('es-HN');
    const co = new Date(r.check_out).toLocaleDateString('es-HN');
    console.log(`  [${r.estado}] ${r.nombre_habitacion} (alias: ${r.nombre_alias || '-'}) | ${ci} -> ${co}`);
  });

  // Verificar exactamente qué habitaciones ocupadas hay para el 25 de abril
  const hoy = '2026-04-25T00:00:00';
  const fin  = '2026-04-25T23:59:59';
  const ocRes = await pool.query(`
    SELECT DISTINCT h.nombre_habitacion, h.nombre_alias, rh.check_in, rh.check_out, rh.estado
    FROM public.reservas_hotel rh
    JOIN public.habitaciones h ON h.id_habitacion = rh.id_habitacion
    WHERE rh.estado NOT IN ('cancelada','check_out','no_show')
      AND rh.check_in < $2::timestamptz
      AND rh.check_out > $1::timestamptz
  `, [hoy, fin]);
  console.log('\nHabitaciones ocupadas el 25 de abril:', ocRes.rows.length);
  ocRes.rows.forEach(r => {
    console.log(`  ${r.nombre_habitacion} (${r.nombre_alias || '-'}) [${r.estado}]`);
  });

  // Mismo check para el 26 de abril
  const hoy2 = '2026-04-26T00:00:00';
  const fin2  = '2026-04-26T23:59:59';
  const ocRes2 = await pool.query(`
    SELECT DISTINCT h.nombre_habitacion, h.nombre_alias, rh.check_in, rh.check_out, rh.estado
    FROM public.reservas_hotel rh
    JOIN public.habitaciones h ON h.id_habitacion = rh.id_habitacion
    WHERE rh.estado NOT IN ('cancelada','check_out','no_show')
      AND rh.check_in < $2::timestamptz
      AND rh.check_out > $1::timestamptz
  `, [hoy2, fin2]);
  console.log('\nHabitaciones ocupadas el 26 de abril:', ocRes2.rows.length);
  ocRes2.rows.forEach(r => {
    console.log(`  ${r.nombre_habitacion} (${r.nombre_alias || '-'}) [${r.estado}]`);
  });

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
