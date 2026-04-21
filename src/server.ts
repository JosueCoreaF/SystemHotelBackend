import dotenv from 'dotenv';
import http from 'http';
import app, { getHotelPricingConfig } from './app.js';
import { pool } from './db.js';
import { registerChatRoutes, initChatSocket } from './chatRoutes.js';

dotenv.config();

const port = Number(process.env.API_PORT ?? 4000);

async function ensureHotelPricingSchema() {
  await pool.query(`
    alter table if exists public.configuracion_hotelera
      add column if not exists moneda_alterna text not null default 'HNL',
      add column if not exists tipo_cambio_base numeric(12, 6) not null default 24.5,
      add column if not exists tipo_cambio_actualizado_en timestamptz not null default now(),
      add column if not exists descuento_tercera_edad numeric(5, 2) not null default 0,
      add column if not exists edad_tercera_edad integer not null default 60;

    create table if not exists public.tarifas_personalizadas_hotel (
      id_tarifa_personalizada uuid primary key default gen_random_uuid(),
      id_hotel uuid not null references public.hoteles(id_hotel) on delete cascade,
      id_habitacion uuid references public.habitaciones(id_habitacion) on delete set null,
      nombre_tarifa text not null,
      descripcion text,
      moneda text not null default 'USD',
      monto_noche numeric(10, 2) not null default 0,
      activa boolean not null default true,
      prioridad integer not null default 0,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint tarifas_personalizadas_hotel_moneda_check check (moneda in ('USD', 'HNL')),
      constraint tarifas_personalizadas_hotel_monto_check check (monto_noche >= 0)
    );

    alter table if exists public.tarifas_personalizadas_hotel
      alter column id_habitacion drop not null;

    create index if not exists idx_tarifas_personalizadas_hotel_room
      on public.tarifas_personalizadas_hotel (id_habitacion, activa, prioridad desc, updated_at desc);

    drop trigger if exists tarifas_personalizadas_hotel_set_updated_at on public.tarifas_personalizadas_hotel;
    create trigger tarifas_personalizadas_hotel_set_updated_at
    before update on public.tarifas_personalizadas_hotel
    for each row execute function public.set_updated_at();
    insert into public.configuracion_hotelera (id_config, moneda, moneda_alterna, tipo_cambio_actualizado_en)
    values ('default', 'USD', 'HNL', '1970-01-01T00:00:00Z')
    on conflict (id_config) do nothing;
  `);
}

async function ensureMediaBucketExists() {
  try {
    // Intentamos asegurar el bucket si el esquema storage existe y tenemos permiso
    await pool.query(`
      do $$ 
      begin
          if exists (select from information_schema.schemata where schema_name = 'storage') then
              insert into storage.buckets (id, name, public)
              values ('hotel-verona-media', 'hotel-verona-media', true)
              on conflict (id) do nothing;
          end if;
      end $$;
    `);
    console.log('[Storage] Bucket hotel-verona-media verificado.');
  } catch (err) {
    console.log('[Storage] Nota: No se pudo verificar el bucket automáticamente (esto es normal si los permisos son restrictivos).');
  }
}

async function start() {
  await pool.query('select 1');
  await ensureHotelPricingSchema();
  await ensureMediaBucketExists();

  // Actualizar tipo de cambio al iniciar y programar una actualización diaria
  try {
    await getHotelPricingConfig(pool, true);
    console.log('[TipoCambio] Actualizado al iniciar.');
  } catch (err) {
    console.warn('[TipoCambio] No se pudo actualizar al iniciar:', err);
  }

  // Programar actualización diaria a una hora fija (por defecto 00:00).
  const updateHour = Number(process.env.EXCHANGE_UPDATE_HOUR ?? 0);
  const updateMinute = Number(process.env.EXCHANGE_UPDATE_MINUTE ?? 0);

  const scheduleDailyUpdate = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(updateHour, updateMinute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();

    const run = async () => {
      try {
        await getHotelPricingConfig(pool, true);
        console.log('[TipoCambio] Actualizado (programado).');
      } catch (err) {
        console.warn('[TipoCambio] Error actualizando tipo de cambio (programado):', err);
      } finally {
        // Programamos la siguiente ejecución en 24h
        setTimeout(run, 24 * 60 * 60 * 1000);
      }
    };

    setTimeout(run, delay);
    console.log(`[TipoCambio] Próxima actualización programada en ${next.toISOString()}.`);
  };

  scheduleDailyUpdate();

  // Create HTTP server and attach Socket.io
  const httpServer = http.createServer(app);
  const io = initChatSocket(httpServer);

  // Register chat REST routes (io needed to broadcast guest messages)
  registerChatRoutes(app, io);
  // Exponer io a los handlers usando app locals para poder emitir desde rutas
  (app as any).set('io', io);

  httpServer.listen(port, () => {
    console.log(`Hotel Verona API escuchando en http://localhost:${port}/api`);
    console.log(`[Chat] Socket.io disponible en ws://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error('No se pudo iniciar la API.', error);
  process.exit(1);
});