// check_disponibilidad.js — Diagnóstico de disponibilidad para mañana
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const dateStr = manana.toISOString().split('T')[0];
  const checkIn  = `${dateStr}T14:00:00`;
  const checkOut = `${dateStr}T23:59:00`;

  console.log(`\n=== Diagnóstico de disponibilidad para: ${dateStr} ===\n`);

  // 1. Todas las habitaciones (sin filtro de fechas)
  const todasRes = await pool.query(`
    SELECT
      h.id_habitacion,
      h.nombre_habitacion,
      h.nombre_alias,
      h.codigo_habitacion,
      h.tarifa_noche,
      h.visible,
      hotel.nombre_hotel
    FROM public.habitaciones h
    JOIN public.hoteles hotel ON hotel.id_hotel = h.id_hotel
    ORDER BY hotel.nombre_hotel, h.codigo_habitacion
  `);
  console.log(`Total habitaciones en BD: ${todasRes.rows.length}`);
  todasRes.rows.forEach(r => {
    console.log(`  [${r.nombre_hotel}] ${r.nombre_habitacion} | alias: ${r.nombre_alias ?? '(sin alias)'} | tarifa: $${r.tarifa_noche} | visible: ${r.visible}`);
  });

  // 2. Habitaciones visibles (las que devuelve el portal sin fecha)
  const visiblesRes = await pool.query(`
    SELECT h.id_habitacion, h.nombre_habitacion, h.nombre_alias, h.visible
    FROM public.habitaciones h
    WHERE coalesce(h.visible, true) = true
    ORDER BY h.codigo_habitacion
  `);
  console.log(`\nHabitaciones visibles en portal: ${visiblesRes.rows.length}`);
  visiblesRes.rows.forEach(r => console.log(`  - ${r.nombre_habitacion} | alias: ${r.nombre_alias ?? '(sin alias)'} | visible: ${r.visible}`));

  // 3. Reservas activas que pisan el día de mañana
  const reservasRes = await pool.query(`
    SELECT
      rh.id_reserva_hotel,
      rh.check_in,
      rh.check_out,
      rh.estado,
      h.nombre_habitacion,
      h.nombre_alias,
      COALESCE(hues.nombre_completo, '(sin huesped)') AS huesped
    FROM public.reservas_hotel rh
    JOIN public.habitaciones h ON h.id_habitacion = rh.id_habitacion
    LEFT JOIN public.huespedes hues ON hues.id_huesped = rh.id_huesped
    WHERE rh.estado NOT IN ('cancelada', 'check_out', 'no_show')
      AND rh.check_in < $2::timestamptz
      AND rh.check_out > $1::timestamptz
    ORDER BY rh.check_in
  `, [checkIn, checkOut]);

  console.log(`\nReservas activas que cubren ${dateStr}: ${reservasRes.rows.length}`);
  if (reservasRes.rows.length === 0) {
    console.log('  (ninguna)');
  } else {
    reservasRes.rows.forEach(r => {
      const ci = new Date(r.check_in).toLocaleString('es-HN');
      const co = new Date(r.check_out).toLocaleString('es-HN');
      console.log(`  [${r.estado}] ${r.nombre_habitacion} (alias: ${r.nombre_alias ?? '-'}) | ${ci} → ${co} | Huésped: ${r.huesped}`);
    });
  }

  // 4. Bloqueos activos para mañana
  const bloqueosRes = await pool.query(`
    SELECT
      b.id_bloqueo,
      b.fecha_inicio,
      b.fecha_fin,
      b.motivo,
      h.nombre_habitacion,
      h.nombre_alias
    FROM public.bloqueos_habitacion b
    JOIN public.habitaciones h ON h.id_habitacion = b.id_habitacion
    WHERE b.fecha_inicio <= $1::date
      AND b.fecha_fin >= $1::date
  `, [dateStr]);

  console.log(`\nBloqueos activos para ${dateStr}: ${bloqueosRes.rows.length}`);
  if (bloqueosRes.rows.length === 0) {
    console.log('  (ninguno)');
  } else {
    bloqueosRes.rows.forEach(b => {
      console.log(`  ${b.nombre_habitacion} (alias: ${b.nombre_alias ?? '-'}) | ${b.fecha_inicio} → ${b.fecha_fin} | Motivo: ${b.motivo}`);
    });
  }

  // 5. Resultado final: simulación de lo que devuelve el portal para mañana
  const occupiedRes = await pool.query(`
    SELECT DISTINCT id_habitacion FROM public.reservas_hotel
    WHERE estado NOT IN ('cancelada', 'check_out', 'no_show')
      AND check_in < $2::timestamptz
      AND check_out > $1::timestamptz
  `, [checkIn, checkOut]);
  const occupiedIds = occupiedRes.rows.map(r => r.id_habitacion);

  const portalRooms = visiblesRes.rows.map(r => ({
    nombre: r.nombre_alias || r.nombre_habitacion,
    disponible: !occupiedIds.includes(r.id_habitacion),
  }));

  console.log(`\nResultado portal para ${dateStr}:`);
  portalRooms.forEach(r => console.log(`  ${r.disponible ? '✅' : '❌'} ${r.nombre}`));

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
