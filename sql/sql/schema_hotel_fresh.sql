create extension if not exists pgcrypto;

-- Función para actualizar el timestamp updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

-- ── 1. Huespedes ─────────────────────────────────────────────────────────────
create table if not exists public.huespedes (
	id_huesped uuid primary key default gen_random_uuid(),
	nombre_completo text not null,
	correo text not null,
	telefono text,
	documento_identidad text,
	ciudad text,
	direccion text,
	fecha_registro timestamptz not null default now(),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint huespedes_correo_unique unique (correo),
	constraint huespedes_correo_format_check check (position('@' in correo) > 1)
);

-- ── 2. Hoteles ───────────────────────────────────────────────────────────────
create table if not exists public.hoteles (
	id_hotel uuid primary key default gen_random_uuid(),
	nombre_hotel text not null,
	ciudad text not null,
	direccion text not null,
	telefono text,
	correo_contacto text,
	estrellas integer not null default 3,
	estado text not null default 'activo',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint hoteles_nombre_unique unique (nombre_hotel),
	constraint hoteles_estrellas_check check (estrellas between 1 and 5),
	constraint hoteles_estado_check check (estado in ('activo', 'inactivo', 'mantenimiento'))
);

-- ── 3. Personal del Hotel ────────────────────────────────────────────────────
create table if not exists public.personal_hotel (
	id_personal uuid primary key default gen_random_uuid(),
	id_hotel uuid not null references public.hoteles(id_hotel) on delete cascade,
	nombre_completo text not null,
	correo text not null,
	telefono text,
	rol text not null,
	estado text not null default 'activo',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint personal_hotel_correo_unique unique (correo),
	constraint personal_hotel_estado_check check (estado in ('activo', 'inactivo', 'vacaciones')),
	constraint personal_hotel_rol_check check (rol in ('recepcion', 'gerencia', 'limpieza', 'soporte', 'administracion'))
);

-- ── 4. Tipos de Habitación ───────────────────────────────────────────────────
create table if not exists public.tipos_habitacion (
	id_tipo_habitacion uuid primary key default gen_random_uuid(),
	nombre_tipo text not null,
	descripcion text,
	capacidad_base integer not null default 1,
	tarifa_base numeric(10, 2) not null default 0,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint tipos_habitacion_nombre_unique unique (nombre_tipo),
	constraint tipos_habitacion_capacidad_check check (capacidad_base > 0),
	constraint tipos_habitacion_tarifa_check check (tarifa_base >= 0)
);

-- ── 5. Habitaciones ──────────────────────────────────────────────────────────
create table if not exists public.habitaciones (
	id_habitacion uuid primary key default gen_random_uuid(),
	id_hotel uuid references public.hoteles(id_hotel) on delete cascade,
	id_tipo_habitacion uuid not null references public.tipos_habitacion(id_tipo_habitacion) on delete restrict,
	codigo_habitacion text not null,
	nombre_habitacion text not null,
	piso integer,
	capacidad integer not null default 1,
	tarifa_noche numeric(10, 2) not null default 0,
	cargo_persona_extra numeric(10, 2) not null default 0,
	estado text not null default 'disponible',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint habitaciones_hotel_codigo_unique unique (id_hotel, codigo_habitacion),
	constraint habitaciones_capacidad_check check (capacidad > 0),
	constraint habitaciones_tarifa_check check (tarifa_noche >= 0),
	constraint habitaciones_estado_check check (estado in ('disponible', 'ocupada', 'mantenimiento', 'bloqueada', 'limpieza'))
);

-- ── 6. Tarifas Personalizadas ────────────────────────────────────────────────
create table if not exists public.tarifas_personalizadas_hotel (
  id_tarifa_personalizada uuid primary key default gen_random_uuid(),
  id_hotel uuid not null references public.hoteles(id_hotel) on delete cascade,
  id_habitacion uuid references public.habitaciones(id_habitacion) on delete cascade,
  nombre_tarifa text not null,
  descripcion text,
  moneda text not null default 'USD',
  monto_noche numeric(10, 2) not null default 0,
  activa boolean not null default true,
  prioridad integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── 7. Reservas del Hotel ────────────────────────────────────────────────────
create table if not exists public.reservas_hotel (
	id_reserva_hotel uuid primary key default gen_random_uuid(),
	id_huesped uuid not null references public.huespedes(id_huesped) on delete restrict,
	id_hotel uuid not null references public.hoteles(id_hotel) on delete restrict,
	id_habitacion uuid not null references public.habitaciones(id_habitacion) on delete restrict,
	check_in timestamptz not null,
	check_out timestamptz not null,
	adultos integer not null default 1,
	ninos integer not null default 0,
	estado text not null default 'pendiente',
	origen_reserva text not null default 'web',
	moneda text not null default 'USD',
	total_reserva numeric(10, 2) not null default 0,
	anticipo numeric(10, 2) not null default 0,
	observaciones text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint reservas_hotel_fechas_check check (check_out > check_in),
	constraint reservas_hotel_adultos_check check (adultos > 0),
	constraint reservas_hotel_ninos_check check (ninos >= 0),
	constraint reservas_hotel_total_check check (total_reserva >= 0),
	constraint reservas_hotel_anticipo_check check (anticipo >= 0 and anticipo <= total_reserva),
	constraint reservas_hotel_estado_check check (estado in ('pendiente', 'confirmada', 'cancelada', 'check_in', 'check_out', 'no_show')),
	constraint reservas_hotel_origen_check check (origen_reserva in ('web', 'recepcion', 'telefono', 'agencia'))
);

-- ── 8. Pagos del Hotel ───────────────────────────────────────────────────────
create table if not exists public.pagos_hotel (
	id_pago_hotel uuid primary key default gen_random_uuid(),
	id_reserva_hotel uuid not null references public.reservas_hotel(id_reserva_hotel) on delete cascade,
	monto numeric(10, 2) not null,
	moneda text not null default 'USD',
	monto_en_moneda_reserva numeric(10, 2) not null default 0,
	metodo_pago text not null,
	referencia text,
	fecha_pago timestamptz not null default now(),
	estado text not null default 'registrado',
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint pagos_hotel_monto_check check (monto >= 0),
	constraint pagos_hotel_metodo_check check (metodo_pago in ('efectivo', 'tarjeta', 'transferencia', 'deposito', 'canje', 'otro')),
	constraint pagos_hotel_estado_check check (estado in ('registrado', 'aplicado', 'anulado'))
);

-- ── 9. Bloqueos de Habitación ────────────────────────────────────────────────
create table if not exists public.bloqueos_habitacion (
	id_bloqueo uuid primary key default gen_random_uuid(),
	id_habitacion uuid not null references public.habitaciones(id_habitacion) on delete cascade,
	fecha_inicio timestamptz not null,
	fecha_fin timestamptz not null,
	motivo text not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint bloqueos_habitacion_fechas_check check (fecha_fin > fecha_inicio)
);

-- ── 10. Configuración Hotelera ───────────────────────────────────────────────
create table if not exists public.configuracion_hotelera (
	id_config text primary key default 'default',
	hora_check_in time not null default '15:00',
	hora_check_out time not null default '12:00',
	moneda text not null default 'USD',
	moneda_alterna text not null default 'HNL',
	tipo_cambio_base numeric(10, 2) not null default 24.5,
	tipo_cambio_actualizado_en timestamptz not null default now(),
	porcentaje_impuesto numeric(5, 2) not null default 0,
	descuento_tercera_edad numeric(5, 2) not null default 0,
	edad_tercera_edad integer not null default 60,
	permite_sobreventa boolean not null default false,
	orientacion_calendario text default 'horizontal',
	ciudad_base text default 'Tegucigalpa',
	horas_anticipacion_reserva integer default 12,
	umbral_occupacion integer default 85,
	auto_confirmar_pagos boolean default true,
	permitir_edicion_personal boolean default true,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint configuracion_hotelera_singleton_check check (id_config = 'default'),
	constraint configuracion_hotelera_impuesto_check check (porcentaje_impuesto >= 0)
);

-- ── 11. Índices ──────────────────────────────────────────────────────────────
create index if not exists idx_huespedes_correo_lower on public.huespedes (lower(correo));
create index if not exists idx_hoteles_ciudad on public.hoteles (ciudad);
create index if not exists idx_personal_hotel_hotel on public.personal_hotel (id_hotel, rol);
create index if not exists idx_habitaciones_hotel on public.habitaciones (id_hotel, estado);
create index if not exists idx_habitaciones_tipo on public.habitaciones (id_tipo_habitacion);
create index if not exists idx_reservas_hotel_huesped on public.reservas_hotel (id_huesped, created_at desc);
create index if not exists idx_reservas_hotel_habitacion on public.reservas_hotel (id_habitacion, check_in, check_out);
create index if not exists idx_reservas_hotel_hotel on public.reservas_hotel (id_hotel, estado, check_in);
create index if not exists idx_pagos_hotel_reserva on public.pagos_hotel (id_reserva_hotel, fecha_pago desc);
create index if not exists idx_bloqueos_habitacion_habitacion on public.bloqueos_habitacion (id_habitacion, fecha_inicio, fecha_fin);

-- ── 12. Triggers ─────────────────────────────────────────────────────────────
do $$
declare
    t text;
begin
    for t in select table_name from information_schema.tables where table_schema = 'public' and table_name in (
        'huespedes', 'hoteles', 'personal_hotel', 'tipos_habitacion', 'habitaciones', 
        'reservas_hotel', 'pagos_hotel', 'bloqueos_habitacion', 'configuracion_hotelera',
        'tarifas_personalizadas_hotel'
    )
    loop
        execute format('drop trigger if exists %I_set_updated_at on public.%I', t, t);
        execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t, t);
    end loop;
end;
$$;

-- ── 13. Datos Iniciales ──────────────────────────────────────────────────────
insert into public.configuracion_hotelera (id_config) values ('default') on conflict (id_config) do nothing;