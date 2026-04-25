import { withTransaction } from './db.js';

const MONTHS: Record<string, number> = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
  JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
};

function parseCheckIn(checkIn?: string): string | null {
  if (!checkIn) return null;
  const s = String(checkIn).trim();

  // Formato ISO: 2026-04-01
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // Formato legacy: dia/MES/año (ej: 1/ABRIL/2026)
  const parts = s.split('/').map(p => p.trim());
  if (parts.length !== 3) return null;
  const day = Number(parts[0]);
  const monthName = parts[1].toUpperCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const month = MONTHS[monthName] ?? null;
  const year = Number(parts[2]);
  if (!day || !month || !year) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

export async function importReservationsToDb(reservations: any[]) {
  return withTransaction(async (client) => {

    // 1. Hotel por defecto
    let hotelResult = await client.query(`SELECT id_hotel FROM public.hoteles LIMIT 1`);
    if (hotelResult.rowCount === 0) {
      hotelResult = await client.query(`
        INSERT INTO public.hoteles (nombre_hotel, ciudad, direccion)
        VALUES ('Hotel Verona', 'Tegucigalpa', 'Direccion Por Defecto')
        RETURNING id_hotel
      `);
    }
    const hotelId = hotelResult.rows[0].id_hotel;

    // 2. Tipo de habitación genérico
    let tipoHabResult = await client.query(`SELECT id_tipo_habitacion FROM public.tipos_habitacion WHERE nombre_tipo = 'Estándar' LIMIT 1`);
    if (tipoHabResult.rowCount === 0) {
      tipoHabResult = await client.query(`
        INSERT INTO public.tipos_habitacion (nombre_tipo, descripcion, capacidad_base, tarifa_base)
        VALUES ('Estándar', 'Tipo de habitación para migraciones auto-generadas', 2, 500)
        RETURNING id_tipo_habitacion
      `);
    }
    const tipoHabId = tipoHabResult.rows[0].id_tipo_habitacion;

    const configResult = await client.query(`SELECT hora_check_in, hora_check_out FROM public.configuracion_hotelera WHERE id_config = 'default' LIMIT 1`);
    const hotelConfig = configResult.rows[0] || { hora_check_in: '15:00', hora_check_out: '12:00' };

    const insertedIds: string[] = [];
    let skipped = 0;


    for (const r of reservations) {
      const checkInDate = parseCheckIn(r.check_in);
      if (!checkInDate) { skipped++; continue; }

      const nochest: number = typeof r.total_noches === 'number' && r.total_noches > 0 ? r.total_noches : 1;
      const checkOutSql = `(to_timestamp('${checkInDate} ${hotelConfig.hora_check_out}', 'YYYY-MM-DD HH24:MI') AT TIME ZONE 'America/Tegucigalpa' + interval '${nochest} days')::timestamptz`;

      // 3. Nombre del huésped
      let rawName = r.cliente_o_empresa;
      if (!rawName || rawName === 'N/A') {
        rawName = r.empresa && r.empresa !== 'N/A' ? r.empresa : (r.huesped !== 'N/A' ? r.huesped : 'Huésped Genérico');
      }
      const guestName = String(rawName).trim();
      const celular = r.celular !== 'N/A' ? r.celular : null;

      // 4. Buscar o crear habitación (necesaria para el chequeo de duplicados)
      const habCodigo = String(r.habitacion || 'TEMP_1').trim();
      let habitacionResult = await client.query(`
        SELECT id_habitacion FROM public.habitaciones
        WHERE codigo_habitacion = $1 AND id_hotel = $2 LIMIT 1
      `, [habCodigo, hotelId]);

      if (habitacionResult.rowCount === 0) {
        habitacionResult = await client.query(`
          INSERT INTO public.habitaciones (id_hotel, id_tipo_habitacion, codigo_habitacion, nombre_habitacion, capacidad, tarifa_noche)
          VALUES ($1, $2, $3, $4, 2, 0)
          RETURNING id_habitacion
        `, [hotelId, tipoHabId, habCodigo, `Habitación ${habCodigo}`]);
      }
      const habitacionId = habitacionResult.rows[0].id_habitacion;

      // ── VALIDACIÓN DE SOBREVENTA ──────────────────────────────────────────
      // Si ya existe una reserva activa para la misma habitación y fecha, omitir (no sobreventa)
      const overlapCheck = await client.query(`
        SELECT 1 FROM public.reservas_hotel
        WHERE id_habitacion = $1
          AND check_in::date = $2::date
          AND estado NOT IN ('cancelada', 'no_show')
        LIMIT 1
      `, [habitacionId, checkInDate]);
      if ((overlapCheck.rowCount ?? 0) > 0) { skipped++; continue; }

      // ── CHEQUEO DE DUPLICADOS ──────────────────────────────────────────────
      // Si ya existe una reserva con el mismo huésped + habitación + check-in → omitir
      const dupCheck = await client.query(`
        SELECT r.id_reserva_hotel
        FROM public.reservas_hotel r
        JOIN public.huespedes h ON h.id_huesped = r.id_huesped
        WHERE r.id_habitacion = $1
          AND r.check_in::date = $2::date
          AND UPPER(TRIM(h.nombre_completo)) = UPPER(TRIM($3))
        LIMIT 1
      `, [habitacionId, checkInDate, guestName]);
      if ((dupCheck.rowCount ?? 0) > 0) { skipped++; continue; }

      // 5. Buscar o crear huésped
      const correoFalso = `migrante_${Date.now()}_${Math.random().toString(36).substring(7)}@verona.com`;
      let huespedResult = await client.query(
        `SELECT id_huesped FROM public.huespedes
         WHERE UPPER(TRIM(nombre_completo)) = UPPER(TRIM($1)) LIMIT 1`,
        [guestName]
      );
      if (huespedResult.rowCount === 0) {
        huespedResult = await client.query(`
          INSERT INTO public.huespedes (nombre_completo, correo, telefono, documento_identidad)
          VALUES ($1, $2, $3, $4)
          RETURNING id_huesped
        `, [guestName, correoFalso, celular, 'N/A']);
      }
      const huespedId = huespedResult.rows[0].id_huesped;

      // 6. Observaciones
      const obsPartes: string[] = [];
      if (r.descripcion && r.descripcion !== 'N/A') obsPartes.push(r.descripcion);
      if (r.factura && r.factura !== 'N/A') obsPartes.push(`Factura: ${r.factura}`);
      if (r.tipo_estadia && r.tipo_estadia !== 'noche') obsPartes.push(`Tipo: ${r.tipo_estadia}`);
      if (Array.isArray(r.detalles) && r.detalles.length > 0) obsPartes.push(`Detalles: ${r.detalles.join(', ')}`);
      const obs = obsPartes.join(' | ');

      let precioNum = Number(r.precio) || 0;
      let estadoReserva = 'confirmada';

      // Normalizar cadenas de estado para evitar insertar valores no permitidos
      const normalizeStr = (v: any) => {
        if (v === null || v === undefined) return '';
        return String(v).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').trim();
      };

      const rawEstadoPago = r.estado_pago ?? r.tipo ?? 'pagado';
      const rawEstadoHab = r.estado_habitacion ?? 'ocupada';
      const estadoPago = normalizeStr(rawEstadoPago);
      const estadoHabRaw = normalizeStr(rawEstadoHab).replace(/\s+/g, '_');

      const mapEstadoHab = (t: string) => {
        if (!t) return 'ocupada';
        if (t.includes('bloque') || t.includes('mantenimiento')) return 'mantenimiento';
        if (t.includes('no_disponible') || t.includes('nodisponible') || t === 'no_disponible') return 'no_disponible';
        if (t.includes('reserv')) return 'reservada';
        if (t.includes('por_confirm')) return 'por_confirmar';
        if (t.includes('limpieza')) return 'limpieza';
        if (t.includes('dispon')) return 'disponible';
        if (t.includes('ocup')) return 'ocupada';
        return 'ocupada';
      };

      const estadoHab = mapEstadoHab(estadoHabRaw);

      if (estadoPago === 'deuda') {
        estadoReserva = 'confirmada';
      } else if (estadoHab === 'por_confirmar') {
        estadoReserva = 'pendiente';
      } else if (estadoPago === 'cortesia') {
        precioNum = 0;
        obsPartes.push('Tarifa de cortesía');
      } else if (estadoPago === 'capital_pendiente') {
        obsPartes.push('Capital pendiente: dinero entregado, noche no consumida');
      } else if (estadoPago === 'credito') {
        obsPartes.push('Estancia a crédito empresarial');
        // Buscar o crear empresa por nombre y vincular
        const empresaNombre = (r.empresa && r.empresa !== 'N/A') ? r.empresa : (r.cliente_o_empresa && r.cliente_o_empresa !== 'N/A' ? r.cliente_o_empresa : null);
        if (empresaNombre) {
          let empresaResult = await client.query(
            `SELECT id_empresa FROM public.empresas WHERE UPPER(TRIM(nombre)) = UPPER(TRIM($1)) LIMIT 1`,
            [empresaNombre]
          );
          if (empresaResult.rowCount === 0) {
            empresaResult = await client.query(
              `INSERT INTO public.empresas (nombre, dias_credito) VALUES ($1, 30) RETURNING id_empresa`,
              [empresaNombre]
            );
          }
          const empresaId = empresaResult.rows[0].id_empresa;
          // Guardar para vincular después de insertar reserva
          (r as any)._empresaId = empresaId;
        }
      } else if (estadoHab === 'mantenimiento' || estadoHab === 'no_disponible') {
        // Crear bloqueo por fechas específicas en vez de cambiar el estado global
        const blockStart = checkInDate + 'T00:00:00-06';
        const blockEndDate = new Date(checkInDate + 'T00:00:00');
        blockEndDate.setDate(blockEndDate.getDate() + nochest);
        const blockEnd = blockEndDate.toISOString().slice(0, 10) + 'T23:59:59-06';

        // Evitar duplicados: verificar si ya existe un bloqueo que cubra este rango
        const existingBlock = await client.query(`
          SELECT 1 FROM public.bloqueos_habitacion
          WHERE id_habitacion = $1
            AND fecha_inicio <= $2::timestamptz
            AND fecha_fin >= $3::timestamptz
          LIMIT 1
        `, [habitacionId, blockStart, blockEnd]);

        if ((existingBlock.rowCount ?? 0) === 0) {
          await client.query(`
            INSERT INTO public.bloqueos_habitacion (id_habitacion, fecha_inicio, fecha_fin, motivo)
            VALUES ($1, $2::timestamptz, $3::timestamptz, $4)
          `, [habitacionId, blockStart, blockEnd, 'Mantenimiento (importado)']);
        }
        obsPartes.push('Bloqueo por mantenimiento');
      }

      // 7. Insertar reserva (Usando hora_check_in dinámica)
      let reservaId: string | null = null;
      const esMantenimiento = estadoHab === 'mantenimiento' || estadoHab === 'no_disponible';
      if (!esMantenimiento) {
        const empresaIdLink = (r as any)._empresaId ?? null;
        const reservaResult = await client.query(`
          INSERT INTO public.reservas_hotel (id_huesped, id_hotel, id_habitacion, check_in, check_out, estado, origen_reserva, total_reserva, observaciones, id_empresa, estado_pago, estado_habitacion, detalles_estado)
          VALUES ($1, $2, $3, $4::timestamptz, ${checkOutSql}, $5, 'recepcion', $6, $7, $8, $9, $10, $11)
          RETURNING id_reserva_hotel
        `, [huespedId, hotelId, habitacionId, checkInDate + ' ' + hotelConfig.hora_check_in + '-06', estadoReserva, precioNum, obs, empresaIdLink, estadoPago, estadoHab, JSON.stringify(r.detalles || [])]);
        reservaId = reservaResult.rows[0].id_reserva_hotel;
        if (reservaId) insertedIds.push(reservaId);

        // Si es crédito empresarial, registrar cargo automático
        if (estadoPago === 'credito' && empresaIdLink && precioNum > 0) {
          await client.query(`
            INSERT INTO public.creditos_empresa (id_empresa, id_reserva_hotel, tipo_movimiento, monto, moneda, descripcion, referencia, fecha_movimiento)
            VALUES ($1, $2, 'cargo', $3, 'HNL', $4, $5, $6::timestamptz)
          `, [empresaIdLink, reservaId, precioNum,
              `Hab. ${habCodigo} - ${guestName} - ${nochest} noche(s)`,
              r.factura && r.factura !== 'N/A' ? r.factura : 'Extractor',
              checkInDate + ' ' + hotelConfig.hora_check_in + '-06']);
        }
      }

      // 8. Pago automático (no para créditos ni deudas pendientes)
      if (precioNum > 0 && reservaId && estadoPago !== 'credito' && estadoPago !== 'deuda' && estadoPago !== 'capital_pendiente') {
        const reference = (r.factura && r.factura !== 'N/A') ? r.factura : 'Migración Histórica';
        await client.query(`
          INSERT INTO public.pagos_hotel (id_reserva_hotel, monto, metodo_pago, referencia, estado, fecha_pago)
          VALUES ($1, $2, 'otro', $3, 'aplicado', $4::timestamptz)
        `, [reservaId, precioNum, reference, checkInDate + ' ' + hotelConfig.hora_check_in + '-06']);
      }
    }

    return { inserted: insertedIds.length, skipped, ids: insertedIds };
  });
}
