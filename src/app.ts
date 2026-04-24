import cors from 'cors';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from './db.js';
import { registerExtractorRoutes } from './extractorRoutes.js';
import { registerEmpresasRoutes } from './empresasRoutes.js';
import { ApiError, asyncHandler } from './http.js';
import { extractUserId, requirePermission } from './permissions.js';

const app = express();

// Conversión de moneda entre HNL y USD (definida aquí para uso local antes de la declaración global)
function convertCurrencyAmount(
  amount: number,
  from: string,
  to: string,
  config: { tipoCambio: number; monedaBase: string; monedaAlterna: string }
): number {
  if (from === to) return amount;
  const rate = config.tipoCambio || 24.5;
  if (from === 'USD') return amount * rate;   // USD -> HNL
  return amount / rate;                        // HNL -> USD
}
app.use(cors({
  exposedHeaders: ['x-user-id'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-id'],
}));
app.use(express.json({ limit: '50mb' }));

// Health check endpoint used by deploy scripts
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', now: new Date().toISOString() });
});

registerExtractorRoutes(app);
registerEmpresasRoutes(app);

const routeId = (request: Request) => String(request.params.id ?? '');

type Queryable = Pick<typeof pool, 'query'>;

type QueryableOrNull = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> } | null;

export async function logActivity(
  db: QueryableOrNull,
  tipo: 'reserva' | 'pago' | 'mantenimiento' | 'huesped' | 'credito' | 'configuracion' | 'acceso',
  accion: string,
  descripcion: string,
  entidadId?: string | null,
  usuarioId?: string | null
) {
  try {
    const client = db ?? pool;
    await client.query(
      `
      INSERT INTO public.bitacora_actividad (tipo, accion, descripcion, entidad_id, usuario_id)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [tipo, accion, descripcion, entidadId ?? null, usuarioId ?? null]
    );
  } catch (err) {
    console.warn('[AuditLog] Failed to log activity:', err);
  }
}

const mapHotelStatusToLegacy = (status: string) => {
  if (status === 'pendiente') return 'creada';
  if (status === 'confirmada' || status === 'check_in') return 'confirmada';
  if (status === 'check_out') return 'completada';
  return 'cancelada';
};

const mapLegacyStatusToHotel = (status: string) => {
  if (status === 'creada') return 'pendiente';
  if (status === 'confirmada') return 'confirmada';
  if (status === 'completada') return 'check_out';
  if (status === 'check_in') return 'check_in';
  if (status === 'no_show') return 'no_show';
  return 'cancelada';
};

const supportedCurrencies = ['USD', 'HNL'] as const;
type SupportedCurrency = (typeof supportedCurrencies)[number];

const normalizeSupportedCurrency = (value: unknown, fallback: SupportedCurrency): SupportedCurrency => (
  typeof value === 'string' && (supportedCurrencies as readonly string[]).includes(value.toUpperCase())
    ? value.toUpperCase() as SupportedCurrency
    : fallback
);

const DEFAULT_USD_HNL_RATE = 26.5768; // tipo de cambio compra BAC

const getPairExchangeRate = (baseCurrency: SupportedCurrency, secondaryCurrency: SupportedCurrency, usdHnlRate: number) => {
  if (baseCurrency === secondaryCurrency) return 1;
  if (baseCurrency === 'USD' && secondaryCurrency === 'HNL') return usdHnlRate;
  if (baseCurrency === 'HNL' && secondaryCurrency === 'USD') return 1 / usdHnlRate;
  return 1;
};

async function fetchUsdHnlRate() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD', { signal: controller.signal });
    if (!response.ok) throw new Error('Tipo de cambio no disponible.');
    const payload = await response.json() as { rates?: Record<string, number> };
    const rate = Number(payload.rates?.HNL ?? 0);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('Tipo de cambio inválido.');
    return rate;
  } finally {
    clearTimeout(timeoutId);
  }
}

type HotelPricingConfig = {
  baseCurrency: SupportedCurrency;
  secondaryCurrency: SupportedCurrency;
  exchangeRate: number;
  exchangeUpdatedAt: string;
  seniorDiscountPercent: number;
  seniorAge: number;
  taxPercent: number;
};

export async function getHotelPricingConfig(db: Queryable = pool, forceRefresh = false): Promise<HotelPricingConfig> {
  const result = await db.query(
    `
      select
        moneda,
        moneda_alterna,
        tipo_cambio_base,
        tipo_cambio_actualizado_en,
        descuento_tercera_edad,
        edad_tercera_edad,
        porcentaje_impuesto
      from public.configuracion_hotelera
      where id_config = 'default'
      limit 1
    `,
  );

  const row = result.rows[0] ?? {};
  const baseCurrency = normalizeSupportedCurrency(row.moneda, 'USD');
  const secondaryCurrency = normalizeSupportedCurrency(row.moneda_alterna, baseCurrency === 'USD' ? 'HNL' : 'USD');
  let exchangeRate = Number(row.tipo_cambio_base ?? DEFAULT_USD_HNL_RATE);
  let exchangeUpdatedAt = row.tipo_cambio_actualizado_en
    ? new Date(row.tipo_cambio_actualizado_en).toISOString()
    : new Date(0).toISOString();
  const lastUpdatedMs = new Date(exchangeUpdatedAt).getTime();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const shouldRefresh = baseCurrency !== secondaryCurrency
    && (forceRefresh || !Number.isFinite(lastUpdatedMs) || Date.now() - lastUpdatedMs > ONE_DAY_MS);

  if (shouldRefresh) {
    try {
      const usdHnlRate = await fetchUsdHnlRate();
      exchangeRate = getPairExchangeRate(baseCurrency, secondaryCurrency, usdHnlRate);
      exchangeUpdatedAt = new Date().toISOString();
      await db.query(
        `
          update public.configuracion_hotelera
          set tipo_cambio_base = $2,
              tipo_cambio_actualizado_en = $3,
              moneda = $4,
              moneda_alterna = $5
          where id_config = 'default'
        `,
        [
          'default',
          exchangeRate,
          exchangeUpdatedAt,
          baseCurrency,
          secondaryCurrency,
        ],
      );
    } catch {
      exchangeRate = Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : getPairExchangeRate(baseCurrency, secondaryCurrency, DEFAULT_USD_HNL_RATE);
    }
  }

  return {
    baseCurrency,
    secondaryCurrency,
    exchangeRate: Number.isFinite(exchangeRate) && exchangeRate > 0 ? exchangeRate : 1,
    exchangeUpdatedAt,
    seniorDiscountPercent: Number(row.descuento_tercera_edad ?? 0),
    seniorAge: Number(row.edad_tercera_edad ?? 60),
    taxPercent: Number(row.porcentaje_impuesto ?? 0),
  };
}

const tariffConfigPayloadSchema = z.object({
  descuentoTerceraEdad: z.number().min(0).max(100),
  edadTerceraEdad: z.number().int().min(50).max(100),
});

const customTariffPayloadSchema = z.object({
  hotelId: z.string().uuid(),
  habitacionId: z.string().uuid().optional().nullable(),
  nombre: z.string().trim().min(2),
  descripcion: z.string().trim().optional(),
  montoNoche: z.number().min(0),
  moneda: z.enum(supportedCurrencies),
  activa: z.boolean().optional(),
  prioridad: z.number().int().min(0).max(999).optional(),
});

const roomTariffUpdatePayloadSchema = z.object({
  montoNoche: z.number().min(0),
});

async function syncFreshReservationPaymentStatus(reservationId: string, db: Queryable = pool) {
  const reservationResult = await db.query(
    'select estado, total_reserva from public.reservas_hotel where id_reserva_hotel = $1',
    [reservationId],
  );

  const reservation = reservationResult.rows[0];
  if (!reservation || reservation.estado === 'cancelada') return;

  const paidResult = await db.query(
    'select coalesce(sum(monto_en_moneda_reserva), 0)::numeric as total from public.pagos_hotel where id_reserva_hotel = $1',
    [reservationId],
  );

  const totalPaid = Number(paidResult.rows[0]?.total ?? 0);
  const totalReservation = Number(reservation.total_reserva ?? 0);

  const nextStatus = totalReservation > 0 && totalPaid >= totalReservation
    ? 'check_out'
    : totalPaid > 0
      ? 'confirmada'
      : 'pendiente';

  if (reservation.estado !== nextStatus) {
    await db.query(
      'update public.reservas_hotel set estado = $2 where id_reserva_hotel = $1',
      [reservationId, nextStatus],
    );
  }
}

async function syncFreshReservationLedger(reservationId: string, db: Queryable = pool) {
  const paidResult = await db.query(
    `
      select
        coalesce(sum(monto), 0)::numeric as total_pagado,
        coalesce(sum(monto_en_moneda_reserva), 0)::numeric as total_reserva
      from public.pagos_hotel
      where id_reserva_hotel = $1
    `,
    [reservationId],
  );

  const totalInReservationCurrency = Number(paidResult.rows[0]?.total_reserva ?? 0);

  await db.query(
    'update public.reservas_hotel set anticipo = $2 where id_reserva_hotel = $1',
    [reservationId, totalInReservationCurrency],
  );

  await syncFreshReservationPaymentStatus(reservationId, db);
}

async function getFreshBootstrapData() {
  const [hoteles, huespedes, personal] = await Promise.all([
    pool.query('select id_hotel as id, nombre_hotel as nombre from public.hoteles order by nombre_hotel asc'),
    pool.query('select id_huesped as id, nombre_completo as nombre from public.huespedes order by nombre_completo asc'),
    pool.query('select id_personal as id, nombre_completo as nombre from public.personal_hotel order by nombre_completo asc'),
  ]);

  return {
    hoteles: hoteles.rows,
    huespedes: huespedes.rows,
    personalHotelero: personal.rows,
    sedes: hoteles.rows,
    clientes: huespedes.rows,
    entrenadores: personal.rows,
    membresias: [],
  };
}

async function getFreshOperationalDataCompat() {
  const [
    huespedes,
    hoteles,
    personal,
    tiposHabitacion,
    habitaciones,
    reservasHotel,
    pagosHotel,
    configuracionHotelera,
  ] = await Promise.all([
    pool.query('select * from public.huespedes order by fecha_registro asc, nombre_completo asc'),
    pool.query('select * from public.hoteles order by nombre_hotel asc'),
    pool.query('select * from public.personal_hotel order by nombre_completo asc'),
    pool.query('select * from public.tipos_habitacion order by nombre_tipo asc'),
    pool.query(`
      select
        h.*,
        row_number() over(order by h.codigo_habitacion asc) as sort_index
      from public.habitaciones h
      order by h.codigo_habitacion asc
    `),
    pool.query('select * from public.reservas_hotel order by created_at desc'),
    pool.query('select * from public.pagos_hotel order by fecha_pago desc'),
    pool.query('select * from public.configuracion_hotelera where id_config = $1 limit 1', ['default']),
  ]);

  const personas = [
    ...huespedes.rows.map((row) => ({
      id_persona: row.id_huesped,
      nombre: row.nombre_completo,
      correo: row.correo,
      direccion_ciudad: row.ciudad,
      direccion_colonia: null,
      direccion_calle: row.direccion,
      fecha_nacimiento: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    })),
    ...personal.rows.map((row) => {
      const hotel = hoteles.rows.find((hotelRow) => hotelRow.id_hotel === row.id_hotel);
      return {
        id_persona: row.id_personal,
        nombre: row.nombre_completo,
        correo: row.correo,
        direccion_ciudad: hotel?.ciudad ?? null,
        direccion_colonia: null,
        direccion_calle: hotel?.direccion ?? null,
        fecha_nacimiento: null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }),
  ];

  const telefonos = [
    ...huespedes.rows.filter((row) => row.telefono).map((row) => ({ id_persona: row.id_huesped, telefono: row.telefono })),
    ...personal.rows.filter((row) => row.telefono).map((row) => ({ id_persona: row.id_personal, telefono: row.telefono })),
  ];

  const clientes = huespedes.rows.map((row) => ({
    id_persona: row.id_huesped,
    fecha_registro: row.fecha_registro,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const entrenadores = personal.rows.map((row) => ({
    id_persona: row.id_personal,
    especialidad: row.rol,
    estado_laboral: row.estado === 'vacaciones' ? 'Vacaciones' : row.estado === 'inactivo' ? 'Inactivo' : 'Activo',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const sedes = hoteles.rows.map((row) => ({
    id_sede: row.id_hotel,
    nombre_sede: row.nombre_hotel,
    ubicacion: `${row.ciudad} - ${row.direccion}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const actividades = tiposHabitacion.rows.map((row) => ({
    id_actividad: row.id_tipo_habitacion,
    nombre_actividad: row.nombre_tipo,
    descripcion: row.descripcion,
    tipo: 'Servicio',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const programaciones = habitaciones.rows.map((row) => ({
    id_programacion: row.id_habitacion,
    id_sede: row.id_hotel,
    id_actividad: row.id_tipo_habitacion,
    id_entrenador: null,
    horario: new Date(Date.now() + Number(row.sort_index) * 86_400_000).toISOString(),
    cupo_maximo: row.capacidad,
    costo: row.tarifa_noche,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const reservas = reservasHotel.rows.map((row) => ({
    id_reserva: row.id_reserva_hotel,
    id_cliente: row.id_huesped,
    id_programacion: row.id_habitacion,
    fecha_reserva: row.created_at,
    precio_aplicado: row.total_reserva,
    estado: mapHotelStatusToLegacy(row.estado),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const pagos = pagosHotel.rows.map((row) => ({
    id_pago: row.id_pago_hotel,
    monto: row.monto,
    fecha_pago: row.fecha_pago,
    metodo_pago: row.metodo_pago,
    referencia: row.referencia,
    id_reserva: row.id_reserva_hotel,
    id_membresia: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));

  const config = configuracionHotelera.rows[0];
  const configuracionOperativa = [{
    id_config: 'default',
    ciudad_base: config?.ciudad_base ?? hoteles.rows[0]?.ciudad ?? 'Tegucigalpa',
    horas_anticipacion_reserva: config?.horas_anticipacion_reserva ?? 12,
    umbral_ocupacion: config?.umbral_ocupacion ?? 85,
    auto_confirmar_pagos: config?.auto_confirmar_pagos ?? true,
    permitir_edicion_personal: config?.permitir_edicion_personal ?? true,
    hora_check_in: config?.hora_check_in?.slice(0, 5) ?? '15:00',
    hora_check_out: config?.hora_check_out?.slice(0, 5) ?? '12:00',
    orientacion_calendario: config?.orientacion_calendario ?? 'horizontal',
  }];

  return {
    huespedes: huespedes.rows,
    hoteles: hoteles.rows,
    personalHotelero: personal.rows,
    tiposHabitacion: tiposHabitacion.rows,
    habitacionesHotel: habitaciones.rows,
    reservasHotel: reservasHotel.rows,
    pagosHotel: pagosHotel.rows,
    configuracionHotelera: configuracionHotelera.rows,
    personas,
    telefonos,
    clientes,
    membresias: [],
    entrenadores,
    sedes,
    actividades,
    programaciones,
    reservas,
    pagos,
    configuracionOperativa,
  };
}

const withHotelReservationAliases = <T extends Record<string, unknown>>(row: T) => ({
  ...row,
  huespedId: row.clienteId ?? null,
  huesped: row.cliente ?? null,
  habitacionId: row.actividadId ?? null,
  habitacion: row.actividad ?? null,
  hotel: row.sede ?? null,
  responsableId: row.entrenadorId ?? null,
  responsable: row.entrenador ?? null,
});

const withHotelPaymentAliases = <T extends Record<string, unknown>>(row: T) => ({
  ...row,
  huesped: row.cliente ?? null,
  huespedId: row.clienteId ?? null,
  estadia: row.actividad ?? null,
  hotel: row.sede ?? null,
  estadiaId: row.reservaId ?? null,
});

const withHotelActivityAliases = <T extends Record<string, unknown>>(row: T) => ({
  ...row,
  nombreHabitacion: row.nombreActividad ?? null,
  hotelId: row.sedeId ?? null,
  hotel: row.sede ?? null,
  responsableId: row.entrenadorId ?? null,
  responsable: row.entrenador ?? null,
  capacidad: row.cupoMaximo ?? null,
  tarifa: row.costo ?? null,
  ocupacion: row.inscritos ?? 0,
});

async function getFreshReservationById(id: string) {
  const result = await pool.query(
    `
      select
        r.id_reserva_hotel as id,
        r.id_huesped as "clienteId",
        h.nombre_completo as cliente,
        r.id_habitacion as "actividadId",
        room.nombre_habitacion as actividad,
        r.created_at as "fechaReserva",
        r.check_in as horario,
        $2::text as estado,
        r.total_reserva as "precioAplicado",
        r.adultos,
        r.ninos,
        r.moneda,
        hotel.nombre_hotel as sede
      from public.reservas_hotel r
      join public.huespedes h on h.id_huesped = r.id_huesped
      join public.habitaciones room on room.id_habitacion = r.id_habitacion
      join public.hoteles hotel on hotel.id_hotel = r.id_hotel
      where r.id_reserva_hotel = $1
    `,
    [id, 'confirmada'],
  );

  const row = result.rows[0] ?? null;
  if (!row) return null;

  const statusResult = await pool.query('select estado from public.reservas_hotel where id_reserva_hotel = $1', [id]);
  const hotelStatus = statusResult.rows[0]?.estado ?? 'pendiente';
  row.estado = mapHotelStatusToLegacy(hotelStatus);
  return row;
}

async function getFreshPaymentById(id: string) {
  const result = await pool.query(
    `
      select
        p.id_pago_hotel as id,
        p.monto,
        p.moneda,
        p.monto_en_moneda_reserva as "montoReserva",
        p.fecha_pago as "fechaPago",
        p.metodo_pago as "metodoPago",
        p.referencia,
        p.id_reserva_hotel as "reservaId",
        null::uuid as "membresiaId",
        h.nombre_completo as cliente,
        room.nombre_habitacion as actividad,
        null::text as "tipoPlan"
      from public.pagos_hotel p
      join public.reservas_hotel r on r.id_reserva_hotel = p.id_reserva_hotel
      join public.huespedes h on h.id_huesped = r.id_huesped
      join public.habitaciones room on room.id_habitacion = r.id_habitacion
      where p.id_pago_hotel = $1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

async function getFreshRoomById(id: string) {
  const result = await pool.query(
    `
      select
        h.id_habitacion as id,
        h.id_hotel as "hotelId",
        hotel.nombre_hotel as hotel,
        h.id_tipo_habitacion as "tipoHabitacionId",
        t.nombre_tipo as tipo,
        h.codigo_habitacion as codigo,
        h.nombre_habitacion as nombre,
        h.piso,
        h.capacidad,
        h.tarifa_noche as tarifa,
        h.estado,
        h.cargo_persona_extra as "cargoPersonaExtra",
        h.nombre_alias as "nombreAlias",
        h.tipo as "tipoCustom",
        h.created_at as "createdAt"
      from public.habitaciones h
      join public.hoteles hotel on hotel.id_hotel = h.id_hotel
      join public.tipos_habitacion t on t.id_tipo_habitacion = h.id_tipo_habitacion
      where h.id_habitacion = $1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

async function ensureFreshReservationRules(clienteId: string, habitacionId: string, checkIn: string, checkOut: string, excludeId?: string) {
  const guestResult = await pool.query('select 1 from public.huespedes where id_huesped = $1', [clienteId]);
  if (guestResult.rowCount === 0) {
    throw new ApiError(400, 'El huesped indicado no existe.');
  }

  const roomResult = await pool.query(
    `
      select id_habitacion, id_hotel, tarifa_noche, estado
      from public.habitaciones
      where id_habitacion = $1
    `,
    [habitacionId],
  );

  const room = roomResult.rows[0];
  if (!room) throw new ApiError(404, 'La habitación indicada no existe.');
  if (['mantenimiento', 'bloqueada', 'limpieza'].includes(room.estado)) {
    throw new ApiError(409, 'La habitación no está disponible para reserva.');
  }

  const start = new Date(checkIn);
  start.setUTCHours(15, 0, 0, 0);
  const end = new Date(checkOut);
  end.setUTCHours(12, 0, 0, 0);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    if (end > start) {
       // Si es el mismo día pero con horas normalizadas fallo, permitimos si el usuario realmente quiere el día siguiente
    }
    // Re-verificación para asegurar que al menos hay una noche de diferencia
    const rawStart = new Date(checkIn);
    rawStart.setUTCHours(0,0,0,0);
    const rawEnd = new Date(checkOut);
    rawEnd.setUTCHours(0,0,0,0);
    
    if (rawEnd <= rawStart) {
      throw new ApiError(400, 'La fecha de salida debe ser posterior a la de entrada (mínimo 1 noche).');
    }
  }

  const normalizedIn = start.toISOString();
  const normalizedOut = end.toISOString();

  const overlapReservations = await pool.query(
    `
      select count(*)::int as total
      from public.reservas_hotel
      where id_habitacion = $1
        and estado not in ('cancelada', 'no_show')
        and check_out > $2::timestamptz
        and check_in < $3::timestamptz
        and ($4::uuid is null or id_reserva_hotel <> $4::uuid)
    `,
    [habitacionId, normalizedIn, normalizedOut, excludeId ?? null],
  );

  if ((overlapReservations.rows[0]?.total ?? 0) > 0) {
    throw new ApiError(409, 'La habitación ya está ocupada en el rango seleccionado.');
  }

  const overlapBlocks = await pool.query(
    `
      select count(*)::int as total
      from public.bloqueos_habitacion
      where id_habitacion = $1
        and fecha_fin > $2::timestamptz
        and fecha_inicio < $3::timestamptz
    `,
    [habitacionId, normalizedIn, normalizedOut],
  );

  if ((overlapBlocks.rows[0]?.total ?? 0) > 0) {
    throw new ApiError(409, 'La habitación está bloqueada en el rango seleccionado.');
  }

  return room;
}

const personPayloadSchema = z.object({
  nombre: z.string().trim().min(3),
  correo: z.string().trim().email(),
  telefonos: z.array(z.string().trim().min(7)).default([]),
  direccion: z.object({
    ciudad: z.string().trim().optional(),
    colonia: z.string().trim().optional(),
    calle: z.string().trim().optional(),
  }).optional().default({}),
  fechaNacimiento: z.string().date().optional(),
  roles: z.object({
    cliente: z.boolean().default(true),
    entrenador: z.boolean().default(false),
  }),
  especialidad: z.string().trim().optional(),
  estadoLaboral: z.enum(['Activo', 'Inactivo', 'Vacaciones']).optional(),
});
const guestPayloadSchema = z.object({
  nombre: z.string().trim().min(3),
  correo: z.string().trim().email().optional().or(z.literal('')).default(''),
  telefono: z.string().trim().min(7).optional(),
  ciudad: z.string().trim().optional(),
  direccion: z.string().trim().optional(),
});

const activityPayloadSchema = z.object({
  nombreActividad: z.string().trim().min(3).optional(),
  nombreHabitacion: z.string().trim().min(3).optional(),
  nombre_habitacion: z.string().trim().min(3).optional(),
  nombre_alias: z.string().trim().nullable().optional(),
  descripcion: z.string().trim().min(3),
  tipo: z.enum(['Clase grupal', 'Servicio']),
  sedeId: z.string().uuid().optional(),
  hotelId: z.string().uuid().optional(),
  entrenadorId: z.string().uuid().nullable().optional(),
  responsableId: z.string().uuid().nullable().optional(),
  horario: z.string().datetime().optional(),
  cupoMaximo: z.number().int().positive(),
  capacidad: z.number().int().positive().optional(),
  costo: z.number().min(0),
  codigoHabitacion: z.string().trim().min(1).max(30).regex(/^[A-Za-z0-9-]+$/).optional(),
  piso: z.number().int().min(0).optional(),
  estadoOperativo: z.enum(['disponible', 'ocupada', 'mantenimiento', 'bloqueada', 'limpieza']).optional(),
  estado: z.enum(['disponible', 'ocupada', 'mantenimiento', 'bloqueada', 'limpieza']).optional(),
  cargo_persona_extra: z.number().min(0).optional(),
}).transform((payload) => ({
  nombreActividad: payload.nombre_habitacion ?? payload.nombreHabitacion ?? payload.nombreActividad ?? '',
  nombre_alias: payload.nombre_alias ?? null,
  descripcion: payload.descripcion,
  tipo: payload.tipo,
  sedeId: payload.hotelId ?? payload.sedeId ?? '',
  entrenadorId: payload.responsableId ?? payload.entrenadorId ?? null,
  horario: payload.horario,
  cupoMaximo: payload.capacidad ?? payload.cupoMaximo,
  costo: payload.costo,
  codigoHabitacion: payload.codigoHabitacion?.trim().toUpperCase() ?? '',
  piso: payload.piso ?? 1,
  estadoOperativo: payload.estado ?? payload.estadoOperativo ?? 'disponible',
  cargo_persona_extra: payload.cargo_persona_extra ?? 0,
}));

const reservationPayloadSchema = z.object({
  clienteId: z.string().uuid().optional(),
  huespedId: z.string().uuid().optional(),
  actividadId: z.string().uuid().optional(),
  habitacionId: z.string().uuid().optional(),
  fechaReserva: z.string().datetime().optional(),
  checkIn: z.string().datetime().optional(),
  checkOut: z.string().datetime().optional(),
  noches: z.number().int().positive().optional(),
  adultos: z.number().int().positive().optional(),
  ninos: z.number().int().min(0).optional(),
  observaciones: z.string().trim().optional(),
  estado: z.enum(['creada', 'confirmada', 'cancelada', 'completada']).default('creada'),
  precioAplicado: z.number().min(0).optional(),
  moneda: z.string().trim().optional().default('USD'),
  originReservationId: z.string().uuid().optional(),
  empresaId: z.string().uuid().optional(),
  pago: z.object({
    fechaPago: z.string().datetime().optional(),
    metodoPago: z.enum(['efectivo', 'tarjeta', 'transferencia', 'deposito', 'canje', 'otro']),
    referencia: z.string().trim().min(1).optional(),
    moneda: z.string().trim().optional().default('USD'),
  }).optional(),
}).transform((payload) => ({
  clienteId: payload.huespedId ?? payload.clienteId ?? '',
  actividadId: payload.habitacionId ?? payload.actividadId ?? '',
  fechaReserva: payload.fechaReserva,
  checkIn: payload.checkIn,
  checkOut: payload.checkOut,
  noches: payload.noches,
  adultos: payload.adultos ?? 1,
  ninos: payload.ninos ?? 0,
  observaciones: payload.observaciones,
  estado: payload.estado,
  precioAplicado: payload.precioAplicado,
  moneda: payload.moneda,
  pago: payload.pago,
  originReservationId: payload.originReservationId,
  empresaId: payload.empresaId,
}));

const reservationReschedulePayloadSchema = z.object({
  actividadId: z.string().uuid().optional(),
  habitacionId: z.string().uuid().optional(),
}).transform((payload) => ({
  actividadId: payload.habitacionId ?? payload.actividadId ?? '',
}));

const _trainerPayloadSchema = z.object({
  nombre: z.string().trim().min(3),
  correo: z.string().trim().email(),
  fechaNacimiento: z.string().date(),
  especialidad: z.string().trim().min(2).optional(),
  areaOperativa: z.string().trim().min(2).optional(),
  estadoLaboral: z.enum(['Activo', 'Inactivo', 'Vacaciones']).default('Activo'),
}).transform((payload) => ({
  nombre: payload.nombre,
  correo: payload.correo,
  fechaNacimiento: payload.fechaNacimiento,
  especialidad: payload.areaOperativa ?? payload.especialidad ?? '',
  estadoLaboral: payload.estadoLaboral,
}));

const paymentPayloadSchema = z.object({
  reservaId: z.string().uuid(),
  monto: z.number().min(0),
  moneda: z.string().trim().optional().default('USD'),
  fechaPago: z.string().datetime().optional(),
  metodoPago: z.enum(['efectivo', 'tarjeta', 'transferencia', 'deposito', 'canje', 'otro']),
  referencia: z.string().trim().min(1).optional(),
});

const roomBlockPayloadSchema = z.object({
  habitacionId: z.string().uuid(),
  fechaInicio: z.string().datetime(),
  fechaFin: z.string().datetime(),
  motivo: z.string().trim().min(3),
  permitirConReservas: z.boolean().optional(),
});

const operationalSettingsPayloadSchema = z.object({
  ciudadBase: z.string().trim().min(2),
  horasAnticipacionReserva: z.number().int().min(0),
  umbralOcupacion: z.number().int().min(0).max(100),
  autoConfirmarPagos: z.boolean(),
  permitirEdicionPersonal: z.boolean(),
  horaCierre: z.string().trim().regex(/^\d{2}:\d{2}$/),
  horaCheckIn: z.string().trim().regex(/^\d{2}:\d{2}$/).optional(),
  orientacionCalendario: z.enum(['horizontal', 'vertical']).optional(),
});


function formatPgError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    const pgError = error as { code?: string; detail?: string; message?: string };
    if (pgError.code === '23505') return new ApiError(409, pgError.detail ?? 'Registro duplicado.');
    if (pgError.code === '23503') return new ApiError(400, pgError.detail ?? 'Referencia invalida.');
    if (pgError.code === '23514') return new ApiError(400, pgError.detail ?? 'Violacion de regla de negocio.');
  }

  return error;
}

async function getPersonById(id: string) {
  const result = await pool.query(
    `
      select
        h.id_huesped as id,
        h.nombre_completo as nombre,
        h.correo,
        h.ciudad,
        null::text as colonia,
        h.direccion as calle,
        null::date as "fechaNacimiento",
        case when h.telefono is null then '{}'::text[] else array[h.telefono] end as telefonos,
        true as "esCliente",
        false as "esEntrenador",
        h.fecha_registro as "fechaRegistro",
        null::text as especialidad,
        null::text as "estadoLaboral"
      from public.huespedes h
      where h.id_huesped = $1

      union all

      select
        p.id_personal as id,
        p.nombre_completo as nombre,
        p.correo,
        hotel.ciudad,
        null::text as colonia,
        hotel.direccion as calle,
        null::date as "fechaNacimiento",
        case when p.telefono is null then '{}'::text[] else array[p.telefono] end as telefonos,
        false as "esCliente",
        true as "esEntrenador",
        p.created_at as "fechaRegistro",
        p.rol as especialidad,
        case
          when p.estado = 'vacaciones' then 'Vacaciones'
          when p.estado = 'inactivo' then 'Inactivo'
          else 'Activo'
        end as "estadoLaboral"
      from public.personal_hotel p
      join public.hoteles hotel on hotel.id_hotel = p.id_hotel
      where p.id_personal = $1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}
async function getFreshGuestById(id: string) {
  const result = await pool.query(
    `
      select
        h.id_huesped as id,
        h.nombre_completo as nombre,
        h.correo,
        h.telefono,
        h.ciudad,
        h.direccion,
        h.fecha_registro as "fechaRegistro"
      from public.huespedes h
      where h.id_huesped = $1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

async function getCustomTariffById(id: string) {
  const result = await pool.query(
    `
      select
        t.id_tarifa_personalizada as id,
        t.id_hotel as "hotelId",
        h.nombre_hotel as hotel,
        t.id_habitacion as "habitacionId",
        room.nombre_habitacion as habitacion,
        room.codigo_habitacion as codigo,
        t.nombre_tarifa as nombre,
        t.descripcion,
        t.moneda,
        t.monto_noche as "montoNoche",
        t.activa,
        t.prioridad,
        t.created_at as "createdAt",
        t.updated_at as "updatedAt"
      from public.tarifas_personalizadas_hotel t
      join public.hoteles h on h.id_hotel = t.id_hotel
      left join public.habitaciones room on room.id_habitacion = t.id_habitacion
      where t.id_tarifa_personalizada = $1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

app.get('/api/bootstrap', asyncHandler(async (_request, response) => {
  response.json(await getFreshBootstrapData());
}));

app.get('/api/operational-data', asyncHandler(async (_request, response) => {
  response.json(await getFreshOperationalDataCompat());
}));

app.get('/api/hotel-bootstrap', asyncHandler(async (_request, response) => {
  const [hoteles, habitaciones] = await Promise.all([
    pool.query(`
      select id_hotel as id, nombre_hotel as nombre
      from public.hoteles
      order by nombre_hotel asc
    `).then((result) => result.rows),
    pool.query(`
      select id_habitacion as id, nombre_habitacion as nombre, id_hotel as "hotelId"
      from public.habitaciones
      order by nombre_habitacion asc
    `).then((result) => result.rows),
  ]);

  response.json({ hoteles, habitaciones });
}));

app.get('/api/hotel-operational-data', asyncHandler(async (_request, response) => {
  const [
    hoteles,
    habitaciones,
    reservasHotel,
    personas,
    clientes,
    personal,
    bitacora,
  ] = await Promise.all([
    pool.query('select * from public.hoteles order by nombre_hotel asc').then((result) => result.rows),
    pool.query('select * from public.habitaciones order by nombre_habitacion asc').then((result) => result.rows),
    pool.query('select * from public.reservas_hotel order by created_at desc').then((result) => result.rows),
    pool.query('select * from public.huespedes order by fecha_registro asc, nombre_completo asc').then((result) => result.rows),
    pool.query('select id_huesped as id_persona, fecha_registro, created_at, updated_at from public.huespedes order by fecha_registro asc, id_huesped asc').then((result) => result.rows),
    pool.query('select * from public.personal_hotel order by nombre_completo asc').then((result) => result.rows),
    pool.query('select id_actividad, tipo, accion, descripcion, entidad_id, usuario_id, created_at from public.bitacora_actividad order by created_at desc limit 75'),
  ]);

  response.json({
    hoteles,
    habitaciones,
    reservasHotel,
    personas,
    clientes,
    personal,
    bitacora: bitacora.rows.map((row) => ({
      id: row.id_actividad,
      tipo: row.tipo,
      accion: row.accion,
      descripcion: row.descripcion,
      entidad_id: row.entidad_id,
      usuario_id: row.usuario_id,
      created_at: row.created_at,
    })),
  });
}));

app.put('/api/configuracion-operativa', requirePermission('configuracion', 'write'), asyncHandler(async (request, response) => {
  const payload = operationalSettingsPayloadSchema.parse(request.body);

  await pool.query(
    `
      insert into public.configuracion_hotelera (
        id_config,
        hora_check_in,
        hora_check_out,
        moneda,
        porcentaje_impuesto,
        permite_sobreventa,
        orientacion_calendario,
        ciudad_base,
        horas_anticipacion_reserva,
        umbral_ocupacion,
        auto_confirmar_pagos,
        permitir_edicion_personal
      )
      values ('default', $1, $2, 'USD', 0, false, $3, $4, $5, $6, $7, $8)
      on conflict (id_config)
      do update set
        hora_check_in = excluded.hora_check_in,
        hora_check_out = excluded.hora_check_out,
        orientacion_calendario = excluded.orientacion_calendario,
        ciudad_base = excluded.ciudad_base,
        horas_anticipacion_reserva = excluded.horas_anticipacion_reserva,
        umbral_ocupacion = excluded.umbral_ocupacion,
        auto_confirmar_pagos = excluded.auto_confirmar_pagos,
        permitir_edicion_personal = excluded.permitir_edicion_personal
    `,
    [
      payload.horaCheckIn || '15:00',
      payload.horaCierre,
      payload.orientacionCalendario || 'horizontal',
      payload.ciudadBase,
      payload.horasAnticipacionReserva,
      payload.umbralOcupacion,
      payload.autoConfirmarPagos,
      payload.permitirEdicionPersonal,
    ],
  );

  const userId = extractUserId(request);
  await logActivity(null, 'configuracion', 'modificada', 'Configuración operativa actualizada', null, userId);

  response.json({ ok: true });
}));

app.get('/api/personas', asyncHandler(async (request, response) => {
  const role = typeof request.query.role === 'string' ? request.query.role : null;
  const search = typeof request.query.search === 'string' ? request.query.search.trim().toLowerCase() : '';

  const [guestResult, staffResult] = await Promise.all([
    pool.query(
      `
        select
          h.id_huesped as id,
          h.nombre_completo as nombre,
          h.correo,
          h.ciudad,
          null::text as colonia,
          h.direccion as calle,
          null::date as "fechaNacimiento",
          case when h.telefono is null then '{}'::text[] else array[h.telefono] end as telefonos,
          true as "esCliente",
          false as "esEntrenador",
          h.fecha_registro as "fechaRegistro",
          null::text as especialidad,
          null::text as "estadoLaboral"
        from public.huespedes h
        where (
          $1::text = ''
          or lower(h.nombre_completo) like '%' || $1 || '%'
          or lower(h.correo) like '%' || $1 || '%'
        )
        order by h.nombre_completo asc
      `,
      [search],
    ),
    pool.query(
      `
        select
          p.id_personal as id,
          p.nombre_completo as nombre,
          p.correo,
          hotel.ciudad,
          null::text as colonia,
          hotel.direccion as calle,
          null::date as "fechaNacimiento",
          case when p.telefono is null then '{}'::text[] else array[p.telefono] end as telefonos,
          false as "esCliente",
          true as "esEntrenador",
          p.created_at as "fechaRegistro",
          p.rol as especialidad,
          case
            when p.estado = 'vacaciones' then 'Vacaciones'
            when p.estado = 'inactivo' then 'Inactivo'
            else 'Activo'
          end as "estadoLaboral"
        from public.personal_hotel p
        join public.hoteles hotel on hotel.id_hotel = p.id_hotel
        where (
          $1::text = ''
          or lower(p.nombre_completo) like '%' || $1 || '%'
          or lower(p.correo) like '%' || $1 || '%'
        )
        order by p.nombre_completo asc
      `,
      [search],
    ),
  ]);

  const rows = [...guestResult.rows, ...staffResult.rows].filter((row: { esCliente: boolean; esEntrenador: boolean }) => {
    if (role === 'cliente') return row.esCliente;
    if (role === 'entrenador') return row.esEntrenador;
    if (role === 'persona') return !row.esCliente && !row.esEntrenador;
    return true;
  }).sort((left, right) => String(left.nombre).localeCompare(String(right.nombre), 'es'));

  response.json(rows);
}));

app.get('/api/personas/:id', asyncHandler(async (request, response) => {
  const id = routeId(request);
  const row = await getPersonById(id);
  if (!row) throw new ApiError(404, 'Persona no encontrada.');
  response.json(row);
}));

app.post('/api/personas', asyncHandler(async (request, response) => {
  const payload = personPayloadSchema.parse(request.body);

  if (payload.roles.cliente && payload.roles.entrenador) {
    throw new ApiError(400, 'El modelo actual separa huéspedes y personal. Crea cada perfil por separado.');
  }

  const person = await withTransaction(async (client) => {
    if (payload.roles.entrenador) {
      const hotelResult = await client.query('select id_hotel from public.hoteles order by nombre_hotel asc limit 1');
      const hotelId = hotelResult.rows[0]?.id_hotel as string | undefined;
      if (!hotelId) throw new ApiError(400, 'No hay hoteles configurados para crear personal.');

      const created = await client.query(
        `
          insert into public.personal_hotel (
            id_hotel,
            nombre_completo,
            correo,
            telefono,
            rol,
            estado
          )
          values ($1, $2, $3, $4, $5, $6)
          returning id_personal
        `,
        [
          hotelId,
          payload.nombre,
          payload.correo.toLowerCase(),
          payload.telefonos[0] ?? null,
          (payload.especialidad ?? 'soporte').toLowerCase(),
          payload.estadoLaboral === 'Vacaciones' ? 'vacaciones' : payload.estadoLaboral === 'Inactivo' ? 'inactivo' : 'activo',
        ],
      );

      return created.rows[0].id_personal as string;
    }

    const created = await client.query(
      `
        insert into public.huespedes (
          nombre_completo,
          correo,
          telefono,
          ciudad,
          direccion
        )
        values ($1, $2, $3, $4, $5)
        returning id_huesped
      `,
      [
        payload.nombre,
        payload.correo.toLowerCase(),
        payload.telefonos[0] ?? null,
        payload.direccion.ciudad ?? null,
        payload.direccion.calle ?? null,
      ],
    );

    return created.rows[0].id_huesped as string;
  });

  const created = await getPersonById(person);
  response.status(201).json(created);
}));
app.post('/api/huespedes', asyncHandler(async (request, response) => {
  const payload = guestPayloadSchema.parse(request.body);

  const userId = extractUserId(request);
  const guest = await withTransaction(async (client) => {
    const existing = await client.query(
      'select id_huesped from public.huespedes where lower(correo) = lower($1) limit 1',
      [payload.correo],
    );

    if ((existing.rowCount ?? 0) > 0) {
      const guestId = existing.rows[0].id_huesped as string;
      await client.query(
        `
          update public.huespedes
          set nombre_completo = $2,
              correo = $3,
              telefono = $4,
              ciudad = $5,
              direccion = $6
          where id_huesped = $1
        `,
        [guestId, payload.nombre, payload.correo.toLowerCase(), payload.telefono ?? null, payload.ciudad ?? null, payload.direccion ?? null],
      );
      return getFreshGuestById(guestId);
    }

    const inserted = await client.query(
      `
        insert into public.huespedes (
          nombre_completo,
          correo,
          telefono,
          ciudad,
          direccion
        )
        values ($1, $2, $3, $4, $5)
        returning id_huesped
      `,
      [payload.nombre, payload.correo.toLowerCase(), payload.telefono ?? null, payload.ciudad ?? null, payload.direccion ?? null],
    );

    const guestId = inserted.rows[0].id_huesped as string;
    return getFreshGuestById(guestId);
  }, userId);

  await logActivity(null, 'huesped', 'registrado', `Huésped ${payload.nombre} registrado/actualizado`, guest?.id ?? null, userId);

  response.status(201).json(guest ?? {});
}));

app.put('/api/personas/:id', asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = personPayloadSchema.parse(request.body);
  const existing = await getPersonById(id);
  if (!existing) throw new ApiError(404, 'Persona no encontrada.');

  await withTransaction(async (client) => {
    if (existing.esCliente) {
      await client.query(
        `
          update public.huespedes
          set nombre_completo = $2,
              correo = $3,
              telefono = $4,
              ciudad = $5,
              direccion = $6
          where id_huesped = $1
        `,
        [
          id,
          payload.nombre,
          payload.correo.toLowerCase(),
          payload.telefonos[0] ?? null,
          payload.direccion.ciudad ?? null,
          payload.direccion.calle ?? null,
        ],
      );
      return;
    }

    await client.query(
      `
        update public.personal_hotel
        set nombre_completo = $2,
            correo = $3,
            telefono = $4,
            rol = $5,
            estado = $6
        where id_personal = $1
      `,
      [
        id,
        payload.nombre,
        payload.correo.toLowerCase(),
        payload.telefonos[0] ?? null,
        (payload.especialidad ?? existing.especialidad ?? 'soporte').toLowerCase(),
        payload.estadoLaboral === 'Vacaciones' ? 'vacaciones' : payload.estadoLaboral === 'Inactivo' ? 'inactivo' : 'activo',
      ],
    );
  });

  const updated = await getPersonById(id);
  response.json(updated);
}));

app.delete('/api/personas/:id', asyncHandler(async (request, response) => {
  const id = routeId(request);
  const existing = await getPersonById(id);
  if (!existing) throw new ApiError(404, 'Persona no encontrada.');

  if (existing.esCliente) {
    await pool.query('delete from public.huespedes where id_huesped = $1', [id]);
  } else if (existing.esEntrenador) {
    await pool.query('delete from public.personal_hotel where id_personal = $1', [id]);
  }

  response.status(204).send();
}));

app.post('/api/personal', asyncHandler(async (request, response) => {
  const payload = request.body;
  
  const mapRol = (esp: string) => {
    if (!esp) return 'soporte';
    const norm = esp.toLowerCase();
    if (['recepcion', 'gerencia', 'limpieza', 'soporte', 'administracion'].includes(norm)) return norm;
    if (norm.includes('admin')) return 'administracion';
    if (norm.includes('recep')) return 'recepcion';
    return 'soporte';
  };

  const mapEstado = (est: string) => {
    if (!est) return 'activo';
    const norm = est.toLowerCase();
    if (['activo', 'inactivo', 'vacaciones'].includes(norm)) return norm;
    return 'activo';
  };

  const personalId = await withTransaction(async (client) => {
    const hotelRes = await client.query('select id_hotel from public.hoteles limit 1');
    const hotelId = hotelRes.rows[0]?.id_hotel;
    if (!hotelId) throw new ApiError(400, 'No hay hoteles configurados.');

    const insertResult = await client.query(
      `
        insert into public.personal_hotel (id_hotel, nombre_completo, correo, rol, estado)
        values ($1, $2, $3, $4, $5)
        returning id_personal
      `,
      [hotelId, payload.nombre, payload.correo, mapRol(payload.especialidad), mapEstado(payload.estadoLaboral)]
    );
    return insertResult.rows[0].id_personal;
  });

  response.status(201).json({ id: personalId });
}));

app.put('/api/personal/:id', asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = request.body;
  
  const mapRol = (esp: string) => {
    if (!esp) return 'soporte';
    const norm = esp.toLowerCase();
    if (['recepcion', 'gerencia', 'limpieza', 'soporte', 'administracion'].includes(norm)) return norm;
    if (norm.includes('admin')) return 'administracion';
    if (norm.includes('recep')) return 'recepcion';
    return 'soporte';
  };

  const mapEstado = (est: string) => {
    if (!est) return 'activo';
    const norm = est.toLowerCase();
    if (['activo', 'inactivo', 'vacaciones'].includes(norm)) return norm;
    return 'activo';
  };

  const existing = await pool.query('select 1 from public.personal_hotel where id_personal = $1', [id]);
  if (existing.rowCount === 0) throw new ApiError(404, 'Personal no encontrado.');

  await pool.query(
    `
      update public.personal_hotel
      set nombre_completo = $2,
          correo = $3,
          rol = $4,
          estado = $5
      where id_personal = $1
    `,
    [id, payload.nombre, payload.correo, mapRol(payload.especialidad), mapEstado(payload.estadoLaboral)]
  );

  response.json({ id });
}));

app.delete('/api/personal/:id', asyncHandler(async (request, response) => {
  const id = routeId(request);
  const existing = await pool.query('select 1 from public.personal_hotel where id_personal = $1', [id]);
  if (existing.rowCount === 0) throw new ApiError(404, 'Personal no encontrado.');

  await pool.query('delete from public.personal_hotel where id_personal = $1', [id]);

  response.status(204).send();
}));

app.get('/api/habitaciones', asyncHandler(async (_request, response) => {
  const result = await pool.query(
    `
      select
        h.id_habitacion as id,
        h.id_tipo_habitacion as "catalogoId",
        h.nombre_habitacion as "nombreActividad",
        coalesce(h.descripcion, t.descripcion) as descripcion,
        'Servicio'::text as tipo,
        h.id_hotel as "sedeId",
        hotel.nombre_hotel as sede,
        null::uuid as "entrenadorId",
        'Sin responsable'::text as entrenador,
        coalesce(h.created_at, now()) as horario,
        h.capacidad as "cupoMaximo",
        h.tarifa_noche as costo,
        count(r.id_reserva_hotel) filter (where r.estado not in ('cancelada', 'check_out', 'no_show'))::int as inscritos
      from public.habitaciones h
      join public.hoteles hotel on hotel.id_hotel = h.id_hotel
      left join public.tipos_habitacion t on t.id_tipo_habitacion = h.id_tipo_habitacion
      left join public.reservas_hotel r on r.id_habitacion = h.id_habitacion
      group by h.id_habitacion, t.id_tipo_habitacion, hotel.id_hotel
      order by hotel.nombre_hotel asc, h.codigo_habitacion asc
    `,
  );

  response.json(result.rows.map(withHotelActivityAliases));
}));

app.get('/api/habitaciones/:id', asyncHandler(async (request, response) => {
  const id = routeId(request);
  const row = await getFreshRoomById(id);
  if (!row) throw new ApiError(404, 'Habitación no encontrada.');
  response.json(row);
}));

app.post('/api/habitaciones', requirePermission('habitaciones', 'write'), asyncHandler(async (request, response) => {
  const payload = activityPayloadSchema.parse(request.body);
  const userId = extractUserId(request);
  const createdId = await withTransaction(async (client) => {
    const hotel = await client.query('select 1 from public.hoteles where id_hotel = $1', [payload.sedeId]);
    if (hotel.rowCount === 0) throw new ApiError(404, 'El hotel indicado no existe.');

    const duplicate = await client.query(
      'select 1 from public.habitaciones where id_hotel = $1 and codigo_habitacion = $2 limit 1',
      [payload.sedeId, payload.codigoHabitacion],
    );
    if ((duplicate.rowCount ?? 0) > 0) {
      throw new ApiError(409, 'Ya existe una habitación con ese código en el hotel seleccionado.');
    }

    const roomTypeName = payload.tipo === 'Clase grupal' ? 'Estándar' : 'Suite';
    const existingType = await client.query(
      'select id_tipo_habitacion from public.tipos_habitacion where lower(nombre_tipo) = lower($1) limit 1',
      [roomTypeName],
    );

    const roomTypeId = existingType.rows[0]?.id_tipo_habitacion
      ?? (await client.query(
        `
          insert into public.tipos_habitacion (nombre_tipo, descripcion, capacidad_base, tarifa_base)
          values ($1, $2, $3, $4)
          returning id_tipo_habitacion
        `,
        [roomTypeName, payload.descripcion, payload.cupoMaximo, payload.costo],
      )).rows[0].id_tipo_habitacion;

    const created = await client.query(
      `
        insert into public.habitaciones (
          id_hotel,
          id_tipo_habitacion,
          codigo_habitacion,
          nombre_habitacion,
          piso,
          capacidad,
          tarifa_noche,
          estado
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning id_habitacion
      `,
      [
        payload.sedeId,
        roomTypeId,
        payload.codigoHabitacion,
        payload.nombreActividad,
        payload.piso,
        payload.cupoMaximo,
        payload.costo,
        payload.estadoOperativo,
      ],
    );

    return created.rows[0].id_habitacion as string;
  }, userId);

  const room = await getFreshRoomById(createdId);
  response.status(201).json(room ?? { id: createdId });
}));

app.put('/api/habitaciones/:id', requirePermission('habitaciones', 'write'), asyncHandler(async (request: Request, response: Response) => {
  const id = routeId(request);
  const payload = activityPayloadSchema.parse(request.body);
  const existing = await getFreshRoomById(id);
  if (!existing) throw new ApiError(404, 'Habitación no encontrada.');

  await withTransaction(async (client) => {
    const hotel = await client.query('select 1 from public.hoteles where id_hotel = $1', [payload.sedeId]);
    if (hotel.rowCount === 0) throw new ApiError(404, 'El hotel indicado no existe.');

    const roomTypeName = payload.tipo === 'Clase grupal' ? 'Estándar' : 'Suite';
    const existingType = await client.query(
      'select id_tipo_habitacion from public.tipos_habitacion where lower(nombre_tipo) = lower($1) limit 1',
      [roomTypeName],
    );

    const roomTypeId = existingType.rows[0]?.id_tipo_habitacion
      ?? (await client.query(
        `
          insert into public.tipos_habitacion (nombre_tipo, descripcion, capacidad_base, tarifa_base)
          values ($1, $2, $3, $4)
          returning id_tipo_habitacion
        `,
        [roomTypeName, payload.descripcion, payload.cupoMaximo, payload.costo],
      )).rows[0].id_tipo_habitacion;

    await client.query(
      `
        update public.habitaciones
        set id_hotel = $2,
            id_tipo_habitacion = $3,
            codigo_habitacion = $4,
            nombre_habitacion = $5,
            nombre_alias = $11,
            piso = $6,
            capacidad = $7,
            tarifa_noche = $8,
            estado = $9,
            cargo_persona_extra = $12
        where id_habitacion = $1
      `,
      [
        id,
        payload.sedeId,
        roomTypeId,
        payload.codigoHabitacion,
        payload.nombreActividad,
        payload.piso,
        payload.cupoMaximo,
        payload.costo,
        payload.estadoOperativo,
        payload.descripcion,
        payload.nombre_alias,
        payload.cargo_persona_extra,
      ],
    );
  });

  const room = await getFreshRoomById(id);
  response.json(room ?? {});
}));

app.patch('/api/habitaciones/:id/tarifa', requirePermission('habitaciones', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = roomTariffUpdatePayloadSchema.parse(request.body);
  const existing = await getFreshRoomById(id);
  if (!existing) throw new ApiError(404, 'Habitación no encontrada.');

  await pool.query(
    'update public.habitaciones set tarifa_noche = $2 where id_habitacion = $1',
    [id, payload.montoNoche],
  );

  const room = await getFreshRoomById(id);
  response.json(room ?? {});
}));

app.patch('/api/habitaciones/:id/info', requirePermission('habitaciones', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = request.body;
  const existing = await getFreshRoomById(id);
  if (!existing) throw new ApiError(404, 'Habitación no encontrada.');

  await pool.query(
    'update public.habitaciones set nombre_habitacion = coalesce($2, nombre_habitacion), capacidad = coalesce($3, capacidad), estado = coalesce($4, estado), cargo_persona_extra = coalesce($5, cargo_persona_extra), nombre_alias = coalesce($6, nombre_alias), tipo = coalesce($7, tipo) where id_habitacion = $1',
    [id, payload.nombre_habitacion ?? null, payload.capacidad ?? null, payload.estado ?? null, payload.cargo_persona_extra ?? null, payload.nombre_alias ?? null, payload.tipo ?? null],
  );

  const room = await getFreshRoomById(id);
  response.json(room ?? {});
}));

app.get('/api/tarifas', asyncHandler(async (request, response) => {
  const hotelId = typeof request.query.hotelId === 'string' ? request.query.hotelId : null;
  const forceRefresh = String(request.query.refresh ?? '').toLowerCase() === 'true';
  const config = await getHotelPricingConfig(pool, forceRefresh);

  const [currentRates, customRates] = await Promise.all([
    pool.query(
      `
        select
          room.id_habitacion as id,
          room.id_hotel as "hotelId",
          h.nombre_hotel as hotel,
          room.id_tipo_habitacion as "tipoHabitacionId",
          t.nombre_tipo as tipo,
          room.codigo_habitacion as codigo,
          room.nombre_habitacion as habitacion,
          room.tarifa_noche as "montoNoche",
          room.estado
        from public.habitaciones room
        join public.hoteles h on h.id_hotel = room.id_hotel
        join public.tipos_habitacion t on t.id_tipo_habitacion = room.id_tipo_habitacion
        where ($1::uuid is null or room.id_hotel = $1::uuid)
        order by h.nombre_hotel asc, room.codigo_habitacion asc
      `,
      [hotelId],
    ),
    pool.query(
      `
        select
          t.id_tarifa_personalizada as id,
          t.id_hotel as "hotelId",
          h.nombre_hotel as hotel,
          t.id_habitacion as "habitacionId",
          room.nombre_habitacion as habitacion,
          room.codigo_habitacion as codigo,
          t.nombre_tarifa as nombre,
          t.descripcion,
          t.moneda,
          t.monto_noche as "montoNoche",
          t.activa,
          t.prioridad,
          t.created_at as "createdAt",
          t.updated_at as "updatedAt"
        from public.tarifas_personalizadas_hotel t
        join public.hoteles h on h.id_hotel = t.id_hotel
        left join public.habitaciones room on room.id_habitacion = t.id_habitacion
        where ($1::uuid is null or t.id_hotel = $1::uuid)
        order by h.nombre_hotel asc, t.prioridad desc, t.updated_at desc
      `,
      [hotelId],
    ),
  ]);

  response.json({
    config: {
      monedaBase: config.baseCurrency,
      monedaAlterna: config.secondaryCurrency,
      tipoCambio: config.exchangeRate,
      actualizadoEn: config.exchangeUpdatedAt,
      descuentoTerceraEdad: config.seniorDiscountPercent,
      edadTerceraEdad: config.seniorAge,
      porcentajeImpuesto: config.taxPercent,
    },
    actuales: currentRates.rows,
    personalizadas: customRates.rows,
  });
}));

app.put('/api/tarifas/configuracion', requirePermission('configuracion', 'write'), asyncHandler(async (request, response) => {
  const payload = tariffConfigPayloadSchema.parse(request.body);

  await pool.query(
    `
      insert into public.configuracion_hotelera (id_config, moneda, moneda_alterna, descuento_tercera_edad, edad_tercera_edad)
      values ('default', 'HNL', 'USD', $1, $2)
      on conflict (id_config) do update
        set moneda = 'HNL',
            moneda_alterna = 'USD',
            descuento_tercera_edad = excluded.descuento_tercera_edad,
            edad_tercera_edad = excluded.edad_tercera_edad,
            updated_at = now()
    `,
    [payload.descuentoTerceraEdad, payload.edadTerceraEdad],
  );

  const userId = extractUserId(request);
  await logActivity(null, 'configuracion', 'modificada', 'Configuración de tarifas actualizada', null, userId);

  const config = await getHotelPricingConfig(pool, true);
  response.json({
    monedaBase: config.baseCurrency,
    monedaAlterna: config.secondaryCurrency,
    tipoCambio: config.exchangeRate,
    actualizadoEn: config.exchangeUpdatedAt,
    descuentoTerceraEdad: config.seniorDiscountPercent,
    edadTerceraEdad: config.seniorAge,
    porcentajeImpuesto: config.taxPercent,
  });
}));

app.post('/api/tarifas-personalizadas', requirePermission('habitaciones', 'write'), asyncHandler(async (request, response) => {
  const payload = customTariffPayloadSchema.parse(request.body);
  if (payload.habitacionId) {
    const room = await getFreshRoomById(payload.habitacionId);
    if (!room) throw new ApiError(404, 'Habitación no encontrada para la tarifa personalizada.');
    if (room.hotelId !== payload.hotelId) {
      throw new ApiError(400, 'La habitación seleccionada no pertenece al hotel indicado.');
    }
  }

  const created = await pool.query(
    `
      insert into public.tarifas_personalizadas_hotel (
        id_hotel,
        id_habitacion,
        nombre_tarifa,
        descripcion,
        moneda,
        monto_noche,
        activa,
        prioridad
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      returning id_tarifa_personalizada
    `,
    [
      payload.hotelId,
      payload.habitacionId ?? null,
      payload.nombre,
      payload.descripcion ?? null,
      payload.moneda,
      payload.montoNoche,
      payload.activa ?? true,
      payload.prioridad ?? 0,
    ],
  );

  const tariff = await getCustomTariffById(created.rows[0].id_tarifa_personalizada as string);
  response.status(201).json(tariff ?? {});
}));

app.put('/api/tarifas-personalizadas/:id', requirePermission('habitaciones', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = customTariffPayloadSchema.parse(request.body);
  const existing = await getCustomTariffById(id);
  if (!existing) throw new ApiError(404, 'Tarifa personalizada no encontrada.');
  if (payload.habitacionId) {
    const room = await getFreshRoomById(payload.habitacionId);
    if (!room) throw new ApiError(404, 'Habitación no encontrada para la tarifa personalizada.');
    if (room.hotelId !== payload.hotelId) {
      throw new ApiError(400, 'La habitación seleccionada no pertenece al hotel indicado.');
    }
  }

  await pool.query(
    `
      update public.tarifas_personalizadas_hotel
      set id_hotel = $2,
          id_habitacion = $3,
          nombre_tarifa = $4,
          descripcion = $5,
          moneda = $6,
          monto_noche = $7,
          activa = $8,
          prioridad = $9
      where id_tarifa_personalizada = $1
    `,
    [
      id,
      payload.hotelId,
      payload.habitacionId ?? null,
      payload.nombre,
      payload.descripcion ?? null,
      payload.moneda,
      payload.montoNoche,
      payload.activa ?? true,
      payload.prioridad ?? 0,
    ],
  );

  const tariff = await getCustomTariffById(id);
  response.json(tariff ?? {});
}));

app.delete('/api/tarifas-personalizadas/:id', requirePermission('habitaciones', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const existing = await getCustomTariffById(id);
  if (!existing) throw new ApiError(404, 'Tarifa personalizada no encontrada.');

  await pool.query('delete from public.tarifas_personalizadas_hotel where id_tarifa_personalizada = $1', [id]);
  response.status(204).send();
}));

app.delete('/api/habitaciones/:id', requirePermission('habitaciones', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const existing = await getFreshRoomById(id);
  if (!existing) throw new ApiError(404, 'Habitación no encontrada.');

  const reservations = await pool.query(
    `
      select count(*)::int as total
      from public.reservas_hotel
      where id_habitacion = $1
        and estado not in ('cancelada', 'check_out', 'no_show')
    `,
    [id],
  );

  if ((reservations.rows[0]?.total ?? 0) > 0) {
    throw new ApiError(409, 'No se puede eliminar la habitación porque tiene reservas activas asociadas.');
  }

  await pool.query('delete from public.habitaciones where id_habitacion = $1', [id]);
  response.status(204).send();
}));

app.get('/api/bloqueos-habitacion', asyncHandler(async (request, response) => {
  const hotelId = typeof request.query.hotelId === 'string' ? request.query.hotelId : null;
  const fechaInicio = typeof request.query.fechaInicio === 'string' ? request.query.fechaInicio : null;
  const fechaFin = typeof request.query.fechaFin === 'string' ? request.query.fechaFin : null;

  const result = await pool.query(
    `
      select
        b.id_bloqueo as id,
        b.id_habitacion as "habitacionId",
        h.nombre_habitacion as habitacion,
        h.codigo_habitacion as codigo,
        h.id_hotel as "hotelId",
        hotel.nombre_hotel as hotel,
        b.fecha_inicio as "fechaInicio",
        b.fecha_fin as "fechaFin",
        b.motivo,
        b.created_at as "createdAt"
      from public.bloqueos_habitacion b
      join public.habitaciones h on h.id_habitacion = b.id_habitacion
      join public.hoteles hotel on hotel.id_hotel = h.id_hotel
      where ($1::uuid is null or h.id_hotel = $1::uuid)
        and ($2::timestamptz is null or b.fecha_fin > $2::timestamptz)
        and ($3::timestamptz is null or b.fecha_inicio < $3::timestamptz)
      order by b.fecha_inicio asc, h.codigo_habitacion asc
    `,
    [hotelId, fechaInicio, fechaFin],
  );

  response.json(result.rows);
}));

app.post('/api/bloqueos-habitacion', requirePermission('reservas', 'write'), asyncHandler(async (request, response) => {
  const payload = roomBlockPayloadSchema.parse(request.body);
  const start = new Date(payload.fechaInicio);
  const end = new Date(payload.fechaFin);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new ApiError(400, 'El rango de fechas del bloqueo no es válido.');
  }

  const userId = extractUserId(request);
  const created = await withTransaction(async (client) => {
    const roomResult = await client.query(
      `
        select id_habitacion, id_hotel, nombre_habitacion
        from public.habitaciones
        where id_habitacion = $1
      `,
      [payload.habitacionId],
    );

    const room = roomResult.rows[0];
    if (!room) throw new ApiError(404, 'La habitación indicada no existe.');

    if (!payload.permitirConReservas) {
      const overlappingReservations = await client.query(
        `
          select count(*)::int as total
          from public.reservas_hotel
          where id_habitacion = $1
            and estado not in ('cancelada', 'check_out', 'no_show')
            and check_out > $2::timestamptz
            and check_in < $3::timestamptz
        `,
        [payload.habitacionId, payload.fechaInicio, payload.fechaFin],
      );

      if ((overlappingReservations.rows[0]?.total ?? 0) > 0) {
        throw new ApiError(409, 'No se puede cerrar la habitación porque ya tiene reservas activas en ese rango. Marca la opción de permitir cierre con reservas si solo quieres bloquear nuevas reservas.');
      }
    }

    const overlappingBlocks = await client.query(
      `
        select count(*)::int as total
        from public.bloqueos_habitacion
        where id_habitacion = $1
          and fecha_fin > $2::timestamptz
          and fecha_inicio < $3::timestamptz
      `,
      [payload.habitacionId, payload.fechaInicio, payload.fechaFin],
    );

    if ((overlappingBlocks.rows[0]?.total ?? 0) > 0) {
      throw new ApiError(409, 'Ya existe un cierre operativo para esa habitación dentro del rango seleccionado.');
    }

    const inserted = await client.query(
      `
        insert into public.bloqueos_habitacion (
          id_habitacion,
          fecha_inicio,
          fecha_fin,
          motivo
        )
        values ($1, $2, $3, $4)
        returning id_bloqueo
      `,
      [payload.habitacionId, payload.fechaInicio, payload.fechaFin, payload.motivo],
    );

    const blockId = inserted.rows[0].id_bloqueo as string;
    const blockResult = await client.query(
      `
        select
          b.id_bloqueo as id,
          b.id_habitacion as "habitacionId",
          h.nombre_habitacion as habitacion,
          h.codigo_habitacion as codigo,
          h.id_hotel as "hotelId",
          hotel.nombre_hotel as hotel,
          b.fecha_inicio as "fechaInicio",
          b.fecha_fin as "fechaFin",
          b.motivo,
          b.created_at as "createdAt"
        from public.bloqueos_habitacion b
        join public.habitaciones h on h.id_habitacion = b.id_habitacion
        join public.hoteles hotel on hotel.id_hotel = h.id_hotel
        where b.id_bloqueo = $1
      `,
      [blockId],
    );

    return blockResult.rows[0] ?? { id: blockId };
  }, userId);

  response.status(201).json(created);
}));

app.delete('/api/bloqueos-habitacion/:id', requirePermission('reservas', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const existing = await pool.query('select 1 from public.bloqueos_habitacion where id_bloqueo = $1', [id]);
  if (existing.rowCount === 0) throw new ApiError(404, 'Bloqueo no encontrado.');

  await pool.query('delete from public.bloqueos_habitacion where id_bloqueo = $1', [id]);
  response.status(204).send();
}));

app.post('/api/vaciar-datos', requirePermission('configuracion', 'write'), asyncHandler(async (request, response) => {
  const secciones: string[] = Array.isArray(request.body.secciones) ? request.body.secciones : [];
  if (secciones.length === 0) throw new ApiError(400, 'Selecciona al menos una sección para vaciar.');

  const allowed = new Set([
    'pagos', 'creditos', 'reservas', 'bloqueos', 'huespedes',
    'empresas', 'tarifas', 'personal', 'habitaciones', 'tipos_habitacion', 'hoteles',
  ]);
  for (const s of secciones) {
    if (!allowed.has(s)) throw new ApiError(400, `Sección no válida: ${s}`);
  }

  const del = (s: string) => secciones.includes(s);
  const vaciadas: string[] = [];

  // Orden por dependencias (hijos antes que padres)
  if (del('pagos'))            { await pool.query('DELETE FROM public.pagos_hotel');              vaciadas.push('Pagos'); }
  if (del('creditos'))         { await pool.query('DELETE FROM public.creditos_empresa');         vaciadas.push('Créditos'); }
  if (del('reservas'))         { await pool.query('DELETE FROM public.reservas_hotel');           vaciadas.push('Reservas'); }
  if (del('bloqueos'))         { await pool.query('DELETE FROM public.bloqueos_habitacion');      vaciadas.push('Bloqueos'); }
  if (del('huespedes'))        { await pool.query('DELETE FROM public.huespedes');                vaciadas.push('Huéspedes'); }
  if (del('empresas'))         { await pool.query('DELETE FROM public.empresas');                 vaciadas.push('Empresas'); }
  if (del('tarifas'))          { await pool.query('DELETE FROM public.tarifas_personalizadas_hotel'); vaciadas.push('Tarifas'); }
  if (del('personal'))         { await pool.query('DELETE FROM public.personal_hotel');           vaciadas.push('Personal'); }
  if (del('habitaciones'))     { await pool.query('DELETE FROM public.habitaciones');             vaciadas.push('Habitaciones'); }
  if (del('tipos_habitacion')) { await pool.query('DELETE FROM public.tipos_habitacion');         vaciadas.push('Tipos de habitación'); }
  if (del('hoteles'))          { await pool.query('DELETE FROM public.hoteles');                  vaciadas.push('Hoteles'); }

  // Resetear habitaciones en mantenimiento si se vaciaron bloqueos
  if (del('bloqueos') && !del('habitaciones')) {
    await pool.query("UPDATE public.habitaciones SET estado = 'disponible' WHERE estado = 'mantenimiento'");
  }

  const userId = extractUserId(request);
  await logActivity(null, 'configuracion', 'vaciado', `Datos vaciados: ${vaciadas.join(', ')}`, null, userId);

  response.json({ ok: true, message: `Vaciado: ${vaciadas.join(', ')}.` });
}));

// ─── Enviar correo de invitación ──────────────────────────────────────────────
app.post('/api/send-invitation-email', requirePermission('accesos', 'write'), asyncHandler(async (request, response) => {
  const { email, fullName, inviteUrl } = request.body;
  if (!email || !inviteUrl) throw new ApiError(400, 'Email y enlace de invitación son requeridos.');

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.VITE_SUPABASE_URL;

  if (!serviceKey || !supabaseUrl) {
    throw new ApiError(501, 'Servicio de correo no configurado. Configure SUPABASE_SERVICE_ROLE_KEY.');
  }

  // Use Supabase Auth Admin to invite the user (sends email automatically)
  const res = await fetch(`${supabaseUrl}/auth/v1/invite`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      email,
      data: { full_name: fullName, invite_url: inviteUrl },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.warn('[Invite Email] Supabase invite failed:', errBody);
    throw new ApiError(502, 'No se pudo enviar el correo de invitación.');
  }

  const userId = extractUserId(request);
  await logActivity(null, 'acceso', 'invitacion_enviada', `Invitación enviada por correo a ${email}`, null, userId);

  response.json({ ok: true, message: `Correo de invitación enviado a ${email}.` });
}));

// ─── WhatsApp Webhook para notificaciones ─────────────────────────────────────
app.post('/api/webhook/whatsapp', asyncHandler(async (request, response) => {
  // Configura WHATSAPP_API_URL y WHATSAPP_API_TOKEN en .env
  const waUrl = process.env.WHATSAPP_API_URL;
  const waToken = process.env.WHATSAPP_API_TOKEN;
  if (!waUrl || !waToken) {
    throw new ApiError(501, 'Servicio de WhatsApp no configurado. Configura WHATSAPP_API_URL y WHATSAPP_API_TOKEN.');
  }

  const { telefono, mensaje } = request.body;
  if (!telefono || !mensaje) throw new ApiError(400, 'telefono y mensaje son requeridos.');

  const waRes = await fetch(waUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${waToken}` },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono.replace(/[^0-9]/g, ''),
      type: 'text',
      text: { body: mensaje },
    }),
  });

  if (!waRes.ok) {
    const errBody = await waRes.text();
    console.warn('[WhatsApp] Error:', errBody);
    throw new ApiError(502, 'No se pudo enviar el mensaje de WhatsApp.');
  }

  const userId = extractUserId(request);
  await logActivity(null, 'acceso', 'whatsapp_enviado', `WhatsApp enviado a ${telefono}`, null, userId);
  response.json({ ok: true, message: `Mensaje enviado a ${telefono} vía WhatsApp.` });
}));

// ─── Respaldar configuración sensible ────────────────────────────────────────
app.get('/api/backup-config', requirePermission('configuracion', 'read'), asyncHandler(async (request, response) => {
  const includeAccess = request.query.includeAccess === 'true';
  const userId = extractUserId(request);

  const [configRows, tiposRows] = await Promise.all([
    pool.query('SELECT * FROM public.configuracion_hotelera'),
    pool.query('SELECT * FROM public.tipos_habitacion ORDER BY nombre'),
  ]);

  const backup: Record<string, unknown> = {
    version: 1,
    exportedAt: new Date().toISOString(),
    configuracion_hotelera: configRows.rows,
    tipos_habitacion: tiposRows.rows,
  };

  if (includeAccess) {
    if (!userId) throw new ApiError(403, 'Se requiere autenticación para exportar accesos.');
    const roleCheck = await pool.query(
      "SELECT raw_user_meta_data->>'role' AS role FROM auth.users WHERE id = $1",
      [userId]
    );
    if (roleCheck.rows[0]?.role !== 'super_admin') {
      throw new ApiError(403, 'Solo super_admin puede exportar perfiles de acceso.');
    }
    const accessRows = await pool.query(
      "SELECT id, email, raw_user_meta_data->>'role' AS role, raw_user_meta_data->>'permissions' AS permissions, raw_user_meta_data->>'full_name' AS full_name FROM auth.users ORDER BY email"
    );
    backup.access_profiles = accessRows.rows;
  }

  await logActivity(null, 'configuracion', 'exportada', `Respaldo de configuración exportado${includeAccess ? ' (con accesos)' : ''}`, null, userId);
  response.json(backup);
}));

app.get('/api/estadias', asyncHandler(async (request, response) => {
  // Parámetros de paginación
  const page = Math.max(1, parseInt(request.query.page as string) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(request.query.pageSize as string) || 20));
  const offset = (page - 1) * pageSize;

  // Consulta total de registros
  const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM public.reservas_hotel');
  const total = totalResult.rows[0]?.total || 0;

  // Consulta paginada
  const result = await pool.query(
    `
      select
        r.id_reserva_hotel as id,
        r.id_huesped as "clienteId",
        h.nombre_completo as cliente,
        r.id_habitacion as "actividadId",
        room.nombre_habitacion as actividad,
        r.created_at as "fechaReserva",
        r.check_in as horario,
        r.total_reserva as "precioAplicado",
        r.adultos,
        r.ninos,
        r.moneda,
        hotel.nombre_hotel as sede,
        r.estado as hotel_estado
      from public.reservas_hotel r
      join public.huespedes h on h.id_huesped = r.id_huesped
      join public.habitaciones room on room.id_habitacion = r.id_habitacion
      join public.hoteles hotel on hotel.id_hotel = r.id_hotel
      order by r.check_in asc, r.created_at desc
      limit $1 offset $2
    `,
    [pageSize, offset]
  );

  response.json({
    data: result.rows.map((row) => withHotelReservationAliases({
      ...row,
      estado: mapHotelStatusToLegacy(row.hotel_estado),
    })),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize)
  });
}));

app.get('/api/estadias/:id', asyncHandler(async (request, response) => {
  const id = routeId(request);
  const row = await getFreshReservationById(id);
  if (!row) throw new ApiError(404, 'Reserva no encontrada.');
  response.json(withHotelReservationAliases(row));
}));

app.post('/api/estadias', requirePermission('reservas', 'write'), asyncHandler(async (request, response) => {
  const payload = reservationPayloadSchema.parse(request.body);
  const checkIn = payload.checkIn ?? payload.fechaReserva ?? new Date(Date.now() + 86_400_000).toISOString();
  const checkOut = payload.checkOut ?? new Date(new Date(checkIn).getTime() + (payload.noches ?? 1) * 86_400_000).toISOString();
  const room = await ensureFreshReservationRules(payload.clienteId, payload.actividadId, checkIn, checkOut, (payload as any).originReservationId);

  const _userId = extractUserId(request);
  const reservationId = await withTransaction(async (client) => {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    const nights = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86_400_000));
    const finalPrice = payload.precioAplicado ?? Number(room.tarifa_noche) * nights;
    const finalStatus = payload.pago ? 'confirmada' : mapLegacyStatusToHotel(payload.estado);

    const created = await client.query(
      `
        insert into public.reservas_hotel (
          id_huesped,
          id_hotel,
          id_habitacion,
          check_in,
          check_out,
          adultos,
          ninos,
          estado,
          total_reserva,
          anticipo,
          observaciones,
          moneda,
          id_empresa
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, $11, $12)
        returning id_reserva_hotel
      `,
      [
        payload.clienteId,
        room.id_hotel,
        payload.actividadId,
        checkIn,
        checkOut,
        payload.adultos ?? 1,
        payload.ninos ?? 0,
        finalStatus,
        finalPrice,
        payload.observaciones ?? null,
        payload.moneda ?? 'USD',
        payload.empresaId ?? null,
      ],
    );

    const createdReservationId = created.rows[0].id_reserva_hotel as string;

    // Si es crédito empresarial, registrar cargo automático
    if (payload.empresaId && finalPrice > 0) {
      await client.query(
        `
          insert into public.creditos_empresa (id_empresa, id_reserva_hotel, tipo_movimiento, monto, moneda, descripcion, referencia, fecha_movimiento)
          values ($1, $2, 'cargo', $3, $4, $5, 'Reserva manual', $6::timestamptz)
        `,
        [
          payload.empresaId,
          createdReservationId,
          finalPrice,
          payload.moneda ?? 'USD',
          `Hab. ${room.nombre_habitacion} - ${new Date(checkIn).toLocaleDateString('es')}`,
          checkIn,
        ],
      );
    }

    if (payload.pago) {
      const paymentCurrency = payload.pago.moneda ?? payload.moneda ?? 'USD';
      await client.query(
        `
          insert into public.pagos_hotel (
            id_reserva_hotel,
            monto,
            metodo_pago,
            referencia,
            fecha_pago,
            estado,
            moneda,
            monto_en_moneda_reserva
          )
          values ($1, $2, $3, $4, $5, 'aplicado', $6, $7)
        `,
        [
          createdReservationId,
          finalPrice,
          payload.pago.metodoPago,
          payload.pago.referencia ?? null,
          payload.pago.fechaPago ?? new Date().toISOString(),
          paymentCurrency,
          finalPrice,
        ],
      );
    }

    await syncFreshReservationLedger(createdReservationId, client);

    await logActivity(
      client,
      'reserva',
      'creada',
      `Reserva creada para la habitación ${room.nombre_habitacion} (Ingreso: ${new Date(checkIn).toLocaleDateString('es')})`,
      createdReservationId
    );

    return createdReservationId;
  });

  const reservation = await getFreshReservationById(reservationId);
  response.status(201).json(withHotelReservationAliases(reservation ?? {}));
}));

app.put('/api/estadias/:id', requirePermission('reservas', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = reservationPayloadSchema.parse(request.body);
  const existing = await getFreshReservationById(id);
  if (!existing) throw new ApiError(404, 'Reserva no encontrada.');

  const previousState = existing.estado;
  const checkIn = payload.checkIn ?? existing.horario;
  const checkOut = payload.checkOut ?? new Date(new Date(checkIn).getTime() + (payload.noches ?? 1) * 86_400_000).toISOString();
  const room = await ensureFreshReservationRules(payload.clienteId, payload.actividadId, checkIn, checkOut, id);
  const nights = Math.max(1, Math.ceil((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000));
  const finalStatus = mapLegacyStatusToHotel(payload.estado);

  await withTransaction(async (client) => {
    await client.query(
      `
        update public.reservas_hotel
        set id_huesped = $2,
            id_hotel = $3,
            id_habitacion = $4,
            check_in = $5,
            check_out = $6,
            adultos = $7,
            ninos = $8,
            estado = $9,
            total_reserva = $10,
            observaciones = $11,
            moneda = $12
        where id_reserva_hotel = $1
      `,
      [
        id,
        payload.clienteId,
        room.id_hotel,
        payload.actividadId,
        checkIn,
        checkOut,
        payload.adultos ?? 1,
        payload.ninos ?? 0,
        finalStatus,
        payload.precioAplicado ?? Number(room.tarifa_noche) * nights,
        payload.observaciones ?? null,
        payload.moneda ?? existing.moneda ?? 'USD',
      ],
    );

    await syncFreshReservationLedger(id, client);

    if (previousState !== finalStatus) {
      let msg = `Reserva modificada (Estado: ${finalStatus})`;
      if (finalStatus === 'cancelada') msg = 'Reserva cancelada';
      if (finalStatus === 'confirmada' && previousState === 'pendiente') msg = `Huésped hizo check-in en la habitación ${room.nombre_habitacion}`;
      if (finalStatus === 'check_out') msg = `Huésped hizo check-out de la habitación ${room.nombre_habitacion}`;
      await logActivity(client, 'reserva', 'modificada', msg, id);
    } else {
      await logActivity(client, 'reserva', 'modificada', `Detalles de reserva actualizados`, id);
    }
  });

  const reservation = await getFreshReservationById(id);
  response.json(withHotelReservationAliases(reservation ?? {}));
}));

app.delete('/api/estadias/:id', requirePermission('reservas', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const existing = await getFreshReservationById(id);
  if (!existing) throw new ApiError(404, 'Reserva no encontrada.');

  await withTransaction(async (client) => {
    await client.query('delete from public.reservas_hotel where id_reserva_hotel = $1', [id]);
    await logActivity(client, 'reserva', 'cancelada', `Reserva eliminada`, id);
  });
  response.status(204).send();
}));

app.patch('/api/estadias/:id/cancelar', requirePermission('reservas', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);

  const existing = await getFreshReservationById(id);
  if (!existing) throw new ApiError(404, 'Reserva no encontrada.');

  await withTransaction(async (client) => {
    await client.query(
      `
        update public.reservas_hotel
        set estado = 'cancelada'
        where id_reserva_hotel = $1
      `,
      [id],
    );
    await syncFreshReservationLedger(id, client);
    await logActivity(client, 'reserva', 'cancelada', `Reserva cancelada`, id);
  });

  const reservation = await getFreshReservationById(id);
  response.json(withHotelReservationAliases(reservation ?? {}));
}));

app.patch('/api/estadias/:id/reprogramar', requirePermission('reservas', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = reservationReschedulePayloadSchema.parse(request.body);
  const existing = await pool.query(
    'select id_huesped, check_in, check_out from public.reservas_hotel where id_reserva_hotel = $1',
    [id],
  );

  const reservation = existing.rows[0];
  if (!reservation) throw new ApiError(404, 'Reserva no encontrada.');

  const room = await ensureFreshReservationRules(
    reservation.id_huesped,
    payload.actividadId,
    reservation.check_in,
    reservation.check_out,
    id,
  );

  const nights = Math.max(1, Math.ceil((new Date(reservation.check_out).getTime() - new Date(reservation.check_in).getTime()) / 86_400_000));

  await withTransaction(async (client) => {
    await client.query(
      `
        update public.reservas_hotel
        set id_hotel = $2,
            id_habitacion = $3,
            total_reserva = $4,
            estado = 'confirmada'
        where id_reserva_hotel = $1
      `,
      [id, room.id_hotel, payload.actividadId, Number(room.tarifa_noche) * nights],
    );
    await syncFreshReservationLedger(id, client);
    await logActivity(client, 'reserva', 'modificada', `Reserva reprogramada a la habitación ${room.nombre_habitacion}`, id);
  });

  const updated = await getFreshReservationById(id);
  response.json(withHotelReservationAliases(updated ?? {}));
}));

app.post('/api/membresias/checkout', asyncHandler(async (request, response) => {
  void request;
  response.status(410).json({ message: 'Las membresias ya no forman parte del flujo hotelero.' });
}));

app.get('/api/pagos', asyncHandler(async (request, response) => {
  // Parámetros de paginación
  const page = Math.max(1, parseInt(request.query.page as string) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(request.query.pageSize as string) || 20));
  const offset = (page - 1) * pageSize;

  // Consulta total de registros
  const totalResult = await pool.query('SELECT COUNT(*)::int AS total FROM public.pagos_hotel');
  const total = totalResult.rows[0]?.total || 0;

  // Consulta paginada
  const result = await pool.query(
    `
      select
        p.id_pago_hotel as id,
        p.monto,
        p.moneda,
        p.monto_en_moneda_reserva as "montoReserva",
        p.fecha_pago as "fechaPago",
        p.metodo_pago as "metodoPago",
        p.referencia,
        p.id_reserva_hotel as "reservaId",
        null::uuid as "membresiaId",
        h.nombre_completo as cliente,
        room.nombre_habitacion as actividad,
        hotel.nombre_hotel as sede,
        null::text as "tipoPlan"
      from public.pagos_hotel p
      join public.reservas_hotel r on r.id_reserva_hotel = p.id_reserva_hotel
      join public.huespedes h on h.id_huesped = r.id_huesped
      join public.habitaciones room on room.id_habitacion = r.id_habitacion
      join public.hoteles hotel on hotel.id_hotel = r.id_hotel
      order by p.fecha_pago desc
      limit $1 offset $2
    `,
    [pageSize, offset]
  );

  response.json({
    data: result.rows.map(withHotelPaymentAliases),
    page,
    pageSize,
    total,
    totalPages: Math.ceil(total / pageSize)
  });
}));

app.post('/api/pagos', requirePermission('pagos', 'write'), asyncHandler(async (request, response) => {
  const payload = paymentPayloadSchema.parse(request.body);
  if (!payload.reservaId) {
    throw new ApiError(400, 'Solo se aceptan pagos asociados a una reserva hotelera.');
  }

  const reservationResult = await pool.query(
    'select id_reserva_hotel, total_reserva, moneda from public.reservas_hotel where id_reserva_hotel = $1',
    [payload.reservaId],
  );

  const reservation = reservationResult.rows[0];
  if (!reservation) throw new ApiError(404, 'La reserva indicada no existe.');

  const config = await getHotelPricingConfig(pool);
  const reservationCurrency = (reservation.moneda as string) || 'USD';
  const paymentCurrency = payload.moneda || config.baseCurrency || 'USD';
  const montoEnMonedaReserva = convertCurrencyAmount(
    payload.monto,
    paymentCurrency as SupportedCurrency,
    reservationCurrency as SupportedCurrency,
    { tipoCambio: config.exchangeRate, monedaBase: config.baseCurrency, monedaAlterna: config.secondaryCurrency } as any,
  );

  const paidResult = await pool.query(
    'select coalesce(sum(monto_en_moneda_reserva), 0)::numeric as total from public.pagos_hotel where id_reserva_hotel = $1',
    [payload.reservaId],
  );
  const totalPaid = Number(paidResult.rows[0]?.total ?? 0);
  if (totalPaid + montoEnMonedaReserva > Number(reservation.total_reserva) + 0.01) {
    throw new ApiError(400, `El pago (${payload.monto} ${paymentCurrency}) supera el saldo pendiente de la reserva.`);
  }

  const paymentId = await withTransaction(async (client) => {
    const paymentResult = await client.query(
      `
        insert into public.pagos_hotel (
          id_reserva_hotel,
          monto,
          metodo_pago,
          referencia,
          fecha_pago,
          estado,
          moneda,
          monto_en_moneda_reserva
        )
        values ($1, $2, $3, $4, $5, 'aplicado', $6, $7)
        returning id_pago_hotel
      `,
      [
        payload.reservaId,
        payload.monto,
        payload.metodoPago,
        payload.referencia ?? null,
        payload.fechaPago ?? new Date().toISOString(),
        paymentCurrency,
        montoEnMonedaReserva,
      ],
    );

    await syncFreshReservationLedger(payload.reservaId, client);

    const resRoom = await client.query(
      'select h.nombre_habitacion from public.habitaciones h join public.reservas_hotel r on r.id_habitacion = h.id_habitacion where r.id_reserva_hotel = $1',
      [payload.reservaId],
    );
    const roomName = resRoom.rows[0]?.nombre_habitacion ?? 'desconocida';
    await logActivity(client, 'pago', 'creado', `Nuevo pago procesado por $${payload.monto} (Habitación ${roomName})`, paymentResult.rows[0].id_pago_hotel);

    return paymentResult.rows[0].id_pago_hotel as string;
  });

  const payment = await getFreshPaymentById(paymentId);
  response.status(201).json(payment);
}));

app.put('/api/pagos/:id', requirePermission('pagos', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const payload = paymentPayloadSchema.parse(request.body);
  const existing = await getFreshPaymentById(id);
  if (!existing) throw new ApiError(404, 'Pago no encontrado.');

  if (!payload.reservaId) {
    throw new ApiError(400, 'Solo se aceptan pagos asociados a una reserva hotelera.');
  }

  const reservationResult = await pool.query(
    'select id_reserva_hotel, total_reserva, moneda from public.reservas_hotel where id_reserva_hotel = $1',
    [payload.reservaId],
  );
  const reservation = reservationResult.rows[0];
  if (!reservation) throw new ApiError(404, 'La reserva indicada no existe.');

  const config = await getHotelPricingConfig(pool);
  const reservationCurrency = (reservation.moneda as string) || 'USD';
  const paymentCurrency = payload.moneda || config.baseCurrency || 'USD';
  const montoEnMonedaReserva = convertCurrencyAmount(
    payload.monto,
    paymentCurrency as SupportedCurrency,
    reservationCurrency as SupportedCurrency,
    { tipoCambio: config.exchangeRate, monedaBase: config.baseCurrency, monedaAlterna: config.secondaryCurrency } as any,
  );

  const paidResult = await pool.query(
    'select coalesce(sum(monto_en_moneda_reserva), 0)::numeric as total from public.pagos_hotel where id_reserva_hotel = $1 and id_pago_hotel <> $2',
    [payload.reservaId, id],
  );
  const totalPaid = Number(paidResult.rows[0]?.total ?? 0);
  if (totalPaid + montoEnMonedaReserva > Number(reservation.total_reserva) + 0.01) {
    throw new ApiError(400, `El pago (${payload.monto} ${paymentCurrency}) supera el saldo pendiente de la reserva.`);
  }

  await withTransaction(async (client) => {
    await client.query(
      `
        update public.pagos_hotel
        set id_reserva_hotel = $2,
            monto = $3,
            metodo_pago = $4,
            referencia = $5,
            fecha_pago = $6,
            moneda = $7,
            monto_en_moneda_reserva = $8
        where id_pago_hotel = $1
      `,
      [
        id,
        payload.reservaId,
        payload.monto,
        payload.metodoPago,
        payload.referencia ?? existing.referencia ?? null,
        payload.fechaPago ?? existing.fechaPago,
        paymentCurrency,
        montoEnMonedaReserva,
      ],
    );

    if (existing.reservaId) {
      await syncFreshReservationLedger(existing.reservaId, client);
    }
    if (payload.reservaId && payload.reservaId !== existing.reservaId) {
      await syncFreshReservationLedger(payload.reservaId, client);
    }
    if (payload.reservaId === existing.reservaId) {
      await syncFreshReservationLedger(payload.reservaId, client);
    }
  });

  const payment = await getFreshPaymentById(id);
  response.json(payment);
}));

app.delete('/api/pagos/:id', requirePermission('pagos', 'write'), asyncHandler(async (request, response) => {
  const id = routeId(request);
  const existing = await getFreshPaymentById(id);
  if (!existing) throw new ApiError(404, 'Pago no encontrado.');

  await withTransaction(async (client) => {
    await client.query('delete from public.pagos_hotel where id_pago_hotel = $1', [id]);
    if (existing.reservaId) {
      await syncFreshReservationLedger(existing.reservaId, client);
    }
  });

  response.status(204).send();
}));

// ── Portal público: configuración hotelera (tipo de cambio + ISV) ──
app.get('/api/public/config', asyncHandler(async (_request, response) => {
  const config = await getHotelPricingConfig();
  response.json({
    tipoCambio: config.exchangeRate,
    monedaBase: config.baseCurrency,
    monedaAlterna: config.secondaryCurrency,
    porcentajeImpuesto: config.taxPercent,
    descuentoTerceraEdad: config.seniorDiscountPercent,
  });
}));

// ── Portal público: disponibilidad de habitaciones ──
app.get('/api/public/disponibilidad', asyncHandler(async (request, response) => {
  const checkIn = typeof request.query.checkIn === 'string' ? request.query.checkIn : null;
  const checkOut = typeof request.query.checkOut === 'string' ? request.query.checkOut : null;

  const rooms = await pool.query(`
    select
      h.id_habitacion as id,
      h.nombre_habitacion as nombre,
      h.codigo_habitacion as codigo,
      t.descripcion as descripcion,
      t.nombre_tipo as tipo,
      h.capacidad,
      h.tarifa_noche as "tarifaNoche",
      coalesce(h.cargo_persona_extra, 0) as "cargoPersonaExtra",
      hotel.nombre_hotel as hotel,
      hotel.id_hotel as "hotelId",
      coalesce(h.numero_camas, 1) as "numeroCamas",
      h.nombre_alias as "nombreAlias",
      coalesce(h.visible, true) as visible
    from public.habitaciones h
    join public.hoteles hotel on hotel.id_hotel = h.id_hotel
    left join public.tipos_habitacion t on t.id_tipo_habitacion = h.id_tipo_habitacion
    where coalesce(h.visible, true) = true
    order by hotel.nombre_hotel asc, h.codigo_habitacion asc
  `);

  let occupiedIds: string[] = [];
  if (checkIn && checkOut) {
    const conflicts = await pool.query(`
      select distinct id_habitacion
      from public.reservas_hotel
      where estado not in ('cancelada', 'check_out', 'no_show')
        and check_in < $2::timestamptz
        and check_out > $1::timestamptz
    `, [checkIn, checkOut]);
    occupiedIds = conflicts.rows.map((r: any) => r.id_habitacion);
  }

  const result = rooms.rows.map((r: any) => ({
    ...r,
    disponible: !occupiedIds.includes(r.id),
  }));

  response.json(result);
}));

// ── Portal público: info de hoteles ──
app.get('/api/public/hoteles', asyncHandler(async (_request, response) => {
  const result = await pool.query(`
    select id_hotel as id, nombre_hotel as nombre, direccion, telefono, correo_contacto as correo, ciudad, estrellas
    from public.hoteles order by nombre_hotel asc
  `);
  response.json(result.rows);
}));

// ── Portal público: crear solicitud de reserva ──
app.post('/api/public/solicitud-reserva', asyncHandler(async (request, response) => {
  const { nombre, correo, telefono, habitacionId, checkIn, checkOut, adultos, ninos, observaciones } = request.body;

  if (!nombre || !correo || !habitacionId || !checkIn || !checkOut) {
    throw new ApiError(400, 'Faltan campos requeridos: nombre, correo, habitacionId, checkIn, checkOut.');
  }

  // Verificar disponibilidad
  const conflict = await pool.query(`
    select id_reserva_hotel from public.reservas_hotel
    where id_habitacion = $1
      and estado not in ('cancelada', 'check_out', 'no_show')
      and check_in < $3::timestamptz
      and check_out > $2::timestamptz
    limit 1
  `, [habitacionId, checkIn, checkOut]);

  if (conflict.rows.length > 0) {
    throw new ApiError(409, 'La habitación ya no está disponible para esas fechas.');
  }

  // Buscar o crear huésped
  let guestResult = await pool.query(
    `select id_huesped from public.huespedes where lower(correo) = lower($1) limit 1`,
    [correo]
  );
  let guestId: string;
  if (guestResult.rows.length > 0) {
    guestId = guestResult.rows[0].id_huesped;
  } else {
    const created = await pool.query(
      `insert into public.huespedes (nombre_completo, correo, telefono) values ($1, $2, $3) returning id_huesped`,
      [nombre, correo, telefono ?? null]
    );
    guestId = created.rows[0].id_huesped;
  }

  // Obtener habitación
  const room = await pool.query(
    `select id_hotel, tarifa_noche, capacidad, coalesce(cargo_persona_extra, 0) as cargo_persona_extra from public.habitaciones where id_habitacion = $1`,
    [habitacionId]
  );
  if (room.rows.length === 0) throw new ApiError(404, 'Habitación no encontrada.');

  const ciDate = new Date(checkIn);
  const coDate = new Date(checkOut);
  const nights = Math.max(1, Math.ceil((coDate.getTime() - ciDate.getTime()) / 86_400_000));
  const numAdultos = adultos ?? 1;
  const capacidad = Number(room.rows[0].capacidad);
  const cargoExtraUSD = Number(room.rows[0].cargo_persona_extra); // USD
  const extrasPersonas = Math.max(0, numAdultos - capacidad);
  // Tarifa USD ya incluye impuestos (ISV 15% + Turismo 4%)
  const totalUSD = (Number(room.rows[0].tarifa_noche) * nights) + (cargoExtraUSD * extrasPersonas * nights);
  const total = Math.round(totalUSD * DEFAULT_USD_HNL_RATE * 100) / 100;

  const reservation = await pool.query(`
    insert into public.reservas_hotel (id_huesped, id_hotel, id_habitacion, check_in, check_out, adultos, ninos, estado, total_reserva, anticipo, observaciones, moneda)
    values ($1, $2, $3, $4, $5, $6, $7, 'pendiente', $8, 0, $9, 'HNL')
    returning id_reserva_hotel
  `, [guestId, room.rows[0].id_hotel, habitacionId, checkIn, checkOut, adultos ?? 1, ninos ?? 0, total, observaciones ?? null]);

  await logActivity(null, 'reserva', 'creada', `Solicitud de reserva desde portal público: ${nombre} (${correo})`, reservation.rows[0].id_reserva_hotel);

  // Emitir notificación en tiempo real para UI (toast)
  try {
    const io = (request as any).app?.get('io');
    if (io) {
      io.emit('new_reservation', {
        id: reservation.rows[0].id_reserva_hotel,
        guestName: nombre,
        totalHNL: total,
        totalUSD: totalUSD,
        nights,
        hotelId: room.rows[0].id_hotel,
        habitacionId,
      });
    }
  } catch (err) {
    console.warn('[Realtime] No se pudo emitir new_reservation:', err);
  }

  // Enviar notificaciones por email/WhatsApp a contactos configurados (no bloqueante)
  try {
    const { notifyReservationAdmin } = await import('./notifications.js');
    notifyReservationAdmin({
      reservationId: reservation.rows[0].id_reserva_hotel,
      guestName: nombre,
      guestEmail: correo,
      guestPhone: telefono,
      hotelId: room.rows[0].id_hotel,
      nights,
      totalHNL: total,
      totalUSD: totalUSD,
      habitacionId,
    }).catch((e) => console.warn('[Notify] notifyReservationAdmin failed:', e));
  } catch (err) {
    console.warn('[Notify] Could not load notifications module:', err);
  }

  response.status(201).json({ id: reservation.rows[0].id_reserva_hotel, total, noches: nights, mensaje: 'Solicitud de reserva registrada. El hotel confirmará su disponibilidad.' });
}));

// ── Portal público: guía local / concierge digital ──
app.get('/api/public/local-guide', asyncHandler(async (_request, response) => {
  const result = await pool.query(`
    select id, title, content, category, icon, image_url, event_date, sort_order
    from public.local_guide_posts
    where is_active = true
    order by sort_order asc, created_at desc
  `);
  response.json(result.rows);
}));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({ message: 'Payload invalido.', issues: error.flatten() });
    return;
  }

  const mappedError = formatPgError(error);
  if (mappedError instanceof ApiError) {
    response.status(mappedError.status).json({ message: mappedError.message });
    return;
  }

  const message = mappedError instanceof Error ? mappedError.message : 'Error interno del servidor.';
  response.status(500).json({ message });
});

export default app;