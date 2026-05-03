-- ============================================================================
-- SCHEMA DOCUMENTATION - Hotel Verona System Database
-- Generated: 2026-05-03
-- ============================================================================

-- Tabla: hoteles
-- Descripción: Catálogo maestro de hoteles
-- PK: id_hotel (uuid)
-- Registros: 1-N hoteles
CREATE TABLE IF NOT EXISTS public.hoteles (
  id_hotel uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_hotel text NOT NULL UNIQUE,
  ciudad text,
  direccion text,
  telefono text,
  correo_contacto text,
  estrellas integer DEFAULT 3,
  estado text DEFAULT 'activo',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.hoteles IS 'Catálogo maestro de hoteles. Cada hotel puede tener múltiples habitaciones y personal.';
COMMENT ON COLUMN public.hoteles.id_hotel IS 'UUID único generado automáticamente.';
COMMENT ON COLUMN public.hoteles.nombre_hotel IS 'Nombre único del hotel.';
COMMENT ON COLUMN public.hoteles.estado IS 'activo|inactivo|en_mantenimiento';

-- Tabla: tipos_habitacion
-- Descripción: Tipos de habitaciones (Suite, Doble, Individual, etc.)
-- PK: id_tipo_habitacion (uuid)
-- Registros: 1-N tipos
CREATE TABLE IF NOT EXISTS public.tipos_habitacion (
  id_tipo_habitacion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_tipo text NOT NULL UNIQUE,
  descripcion text,
  capacidad_minima integer DEFAULT 1,
  capacidad_maxima integer DEFAULT 4,
  amenities text[],
  created_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.tipos_habitacion IS 'Catálogo de tipos de habitación disponibles en el sistema.';
COMMENT ON COLUMN public.tipos_habitacion.capacidad_maxima IS 'Máxima cantidad de huéspedes permitidos.';

-- Tabla: habitaciones
-- Descripción: Inventario de habitaciones físicas
-- PK: id_habitacion (uuid)
-- FK: id_hotel, id_tipo_habitacion
-- Índices: habitaciones (56 registros aprox.)
CREATE TABLE IF NOT EXISTS public.habitaciones (
  id_habitacion uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_hotel uuid NOT NULL REFERENCES public.hoteles(id_hotel) ON DELETE CASCADE,
  id_tipo_habitacion uuid REFERENCES public.tipos_habitacion(id_tipo_habitacion) ON DELETE SET NULL,
  codigo_habitacion text NOT NULL UNIQUE,
  nombre_habitacion text,
  piso integer,
  capacidad integer DEFAULT 2,
  tarifa_noche numeric DEFAULT 0,
  estado text DEFAULT 'disponible',
  visible boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.habitaciones IS 'Inventario de habitaciones física. Cada habitación pertenece a un hotel y tiene un tipo definido.';
COMMENT ON COLUMN public.habitaciones.tarifa_noche IS 'Tarifa base por noche en moneda local (HNL).';
COMMENT ON COLUMN public.habitaciones.estado IS 'disponible|ocupada|bloqueada|mantenimiento';

-- Tabla: habitaciones_history (AUDIT TABLE)
-- Descripción: Auditoría automática de cambios en habitaciones
-- PK: id_history (uuid)
-- FK: id_habitacion
-- Trigger: trigger_audit_habitaciones (INSERT/UPDATE/DELETE)
CREATE TABLE IF NOT EXISTS public.habitaciones_history (
  id_history uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_habitacion uuid REFERENCES public.habitaciones(id_habitacion) ON DELETE CASCADE,
  codigo_habitacion text,
  nombre_habitacion text,
  estado text,
  changed_by uuid,
  changed_at timestamp with time zone DEFAULT now(),
  change_type text,
  previous_values jsonb,
  created_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.habitaciones_history IS 'Tabla de auditoría automática. Registra todos los cambios (INSERT/UPDATE/DELETE) en habitaciones con snapshots JSON.';

-- Tabla: bloqueos_habitacion
-- Descripción: Bloques de mantenimiento/cierre de habitaciones
-- PK: id_bloqueo (uuid)
-- FK: id_habitacion
CREATE TABLE IF NOT EXISTS public.bloqueos_habitacion (
  id_bloqueo uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_habitacion uuid NOT NULL REFERENCES public.habitaciones(id_habitacion) ON DELETE CASCADE,
  fecha_inicio date NOT NULL,
  fecha_fin date NOT NULL,
  razon text,
  created_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.bloqueos_habitacion IS 'Bloques de disponibilidad (mantenimiento, limpieza, cierre).';

-- Tabla: tarifas_personalizadas_hotel
-- Descripción: Tarifas personalizadas por habitación/período
-- PK: id_tarifa (uuid)
-- FK: id_hotel, id_habitacion
CREATE TABLE IF NOT EXISTS public.tarifas_personalizadas_hotel (
  id_tarifa uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_hotel uuid NOT NULL REFERENCES public.hoteles(id_hotel) ON DELETE CASCADE,
  id_habitacion uuid REFERENCES public.habitaciones(id_habitacion) ON DELETE SET NULL,
  tarifa_noche numeric NOT NULL,
  tarifa_fin_semana numeric,
  fecha_vigencia_inicio date,
  fecha_vigencia_fin date,
  created_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.tarifas_personalizadas_hotel IS 'Sobrescribe tarifa_noche de habitaciones para períodos/condiciones específicas.';

-- Tabla: huespedes
CREATE TABLE IF NOT EXISTS public.huespedes (
  id_huesped uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre_completo text NOT NULL,
  correo text UNIQUE,
  telefono text,
  rtn text UNIQUE,
  direccion text,
  ciudad text,
  pais text DEFAULT 'Honduras',
  fecha_nacimiento date,
  estado text DEFAULT 'activo',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.huespedes IS 'Catálogo de huéspedes/clientes del sistema.';

-- Tabla: empresas
-- Descripción: Empresas clientes (B2B)
-- PK: id_empresa (uuid)
CREATE TABLE IF NOT EXISTS public.empresas (
  id_empresa uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL UNIQUE,
  rtn text UNIQUE,
  contacto_nombre text,
  contacto_email text,
  contacto_telefono text,
  direccion text,
  ciudad text,
  estado text DEFAULT 'activo',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.empresas IS 'Empresas clientes para reservas corporativas y créditos.';

-- Tabla: creditos_empresa
-- Descripción: Línea de crédito de empresas
-- PK: id_credito (uuid)
-- FK: id_empresa, id_reserva_hotel, registrado_por
CREATE TABLE IF NOT EXISTS public.creditos_empresa (
  id_credito uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_empresa uuid NOT NULL REFERENCES public.empresas(id_empresa) ON DELETE CASCADE,
  id_reserva_hotel uuid REFERENCES public.reservas_hotel(id_reserva_hotel) ON DELETE SET NULL,
  monto_aprobado numeric NOT NULL,
  monto_utilizado numeric DEFAULT 0,
  monto_disponible numeric GENERATED ALWAYS AS (monto_aprobado - monto_utilizado) STORED,
  fecha_inicio date NOT NULL,
  fecha_vencimiento date,
  interes_porcentaje numeric DEFAULT 0,
  registrado_por uuid NOT NULL REFERENCES public.personal_hotel(id_personal_hotel) ON DELETE RESTRICT,
  estado text DEFAULT 'activo',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.creditos_empresa IS 'Línea de crédito asignada a empresas. monto_disponible es calculado automáticamente.';

-- Tabla: reservas_hotel
-- Descripción: Registros principales de reservas
-- PK: id_reserva_hotel (uuid)
-- FK: id_hotel, id_habitacion, id_huesped, id_empresa
-- Índices: 11 índices incluyendo compuestos
-- RLS: habilitado (super_admin)
CREATE TABLE IF NOT EXISTS public.reservas_hotel (
  id_reserva_hotel uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_hotel uuid NOT NULL REFERENCES public.hoteles(id_hotel) ON DELETE CASCADE,
  id_habitacion uuid NOT NULL REFERENCES public.habitaciones(id_habitacion) ON DELETE CASCADE,
  id_huesped uuid NOT NULL REFERENCES public.huespedes(id_huesped) ON DELETE CASCADE,
  id_empresa uuid REFERENCES public.empresas(id_empresa) ON DELETE SET NULL,
  check_in timestamp with time zone NOT NULL,
  check_out timestamp with time zone NOT NULL,
  total_reserva numeric NOT NULL,
  moneda text DEFAULT 'HNL',
  metodo_pago text,
  estado text DEFAULT 'pendiente',
  notas text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.reservas_hotel IS 'Tabla principal de reservas. Estado: pendiente|confirmada|check_out|cancelada. RLS: solo super_admin.';
COMMENT ON COLUMN public.reservas_hotel.total_reserva IS 'Monto total en moneda especificada.';
COMMENT ON COLUMN public.reservas_hotel.estado IS 'pendiente|confirmada|check_out|cancelada';

-- Tabla: pagos_hotel
-- Descripción: Registro de pagos por reserva (permite pagos parciales)
-- PK: id_pago_hotel (uuid)
-- FK: id_reserva_hotel
CREATE TABLE IF NOT EXISTS public.pagos_hotel (
  id_pago_hotel uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_reserva_hotel uuid NOT NULL REFERENCES public.reservas_hotel(id_reserva_hotel) ON DELETE CASCADE,
  monto numeric NOT NULL,
  moneda text DEFAULT 'HNL',
  monto_en_moneda_reserva numeric,
  metodo_pago text,
  referencia text,
  fecha_pago timestamp with time zone NOT NULL DEFAULT now(),
  estado text DEFAULT 'pendiente',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.pagos_hotel IS 'Registro detallado de pagos. Permite múltiples pagos parciales por reserva.';
COMMENT ON COLUMN public.pagos_hotel.estado IS 'pendiente|completado|fallido|rechazado';

-- Tabla: personal_hotel
-- Descripción: Personal del hotel (staff)
-- PK: id_personal_hotel (uuid)
-- FK: id_hotel
CREATE TABLE IF NOT EXISTS public.personal_hotel (
  id_personal_hotel uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_hotel uuid NOT NULL REFERENCES public.hoteles(id_hotel) ON DELETE CASCADE,
  nombre_completo text NOT NULL,
  correo text UNIQUE,
  puesto text,
  fecha_contratacion date,
  salario numeric,
  estado text DEFAULT 'activo',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.personal_hotel IS 'Personal (staff) asignado a cada hotel.';

-- Tabla: cierres_diarios
-- Descripción: Cierre de caja diario por hotel
-- PK: id_cierre (uuid)
-- FK: id_hotel, encargado_id
CREATE TABLE IF NOT EXISTS public.cierres_diarios (
  id_cierre uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_hotel uuid NOT NULL REFERENCES public.hoteles(id_hotel) ON DELETE CASCADE,
  fecha date NOT NULL,
  encargado_id uuid NOT NULL REFERENCES public.personal_hotel(id_personal_hotel) ON DELETE RESTRICT,
  ingresos_totales numeric DEFAULT 0,
  egresos_totales numeric DEFAULT 0,
  diferencia numeric,
  notas text,
  estado text DEFAULT 'pendiente',
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.cierres_diarios IS 'Cierre de caja diario por hotel.';

-- Tabla: configuracion_hotelera
-- Descripción: Configuraciones generales del sistema hotelero
-- PK: id_config (uuid)
CREATE TABLE IF NOT EXISTS public.configuracion_hotelera (
  id_config uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clave text NOT NULL UNIQUE,
  valor text,
  tipo_dato text DEFAULT 'text',
  descripcion text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.configuracion_hotelera IS 'Configuraciones generales: tipo de cambio, comisiones, políticas, etc.';

-- Tabla: bitacora_actividad
-- Descripción: Auditoría de acciones del sistema
-- PK: id_actividad (uuid)
-- FK: usuario_id
CREATE TABLE IF NOT EXISTS public.bitacora_actividad (
  id_actividad uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo text NOT NULL,
  accion text NOT NULL,
  descripcion text,
  entidad_id uuid,
  usuario_id uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
COMMENT ON TABLE public.bitacora_actividad IS 'Log de auditoría de acciones: tipo (CREATE|UPDATE|DELETE|VIEW), accion, entidad_id, usuario_id.';

-- ============================================================================
-- KEY INDICES SUMMARY (51 Total)
-- ============================================================================
-- Foreign Key Indices (17):
--   idx_bitacora_actividad_*, idx_bloqueos_*, idx_chat_*
--   idx_cierres_diarios_*, idx_creditos_empresa_*, idx_habitaciones_*
--   idx_pagos_*, idx_personal_*, idx_reservas_*, idx_tarifas_*
--
-- Composite Indices (5):
--   idx_reservas_estado_checkin_checkout
--   idx_reservas_hotel_fecha
--   idx_pagos_reserva_fecha
--   idx_habitaciones_hotel_estado
--   idx_bloqueos_fechas
--
-- Other Indices (29):
--   idx_empresas_nombre, idx_empresas_rtn
--   idx_huespedes_correo_lower, idx_huespedes_rtn
--   idx_habitaciones_estado, idx_habitaciones_visible, etc.

-- ============================================================================
-- RLS POLICIES (5 Total)
-- ============================================================================
-- 1. rls_reservas_superadmin - Restrict reservas_hotel to super_admin
-- 2. rls_pagos_superadmin - Restrict pagos_hotel to super_admin
-- 3. rls_huespedes_superadmin - Restrict huespedes to super_admin
-- 4. rls_habitaciones_read - Allow authenticated to read habitaciones
-- 5. rls_creditos_superadmin - Restrict creditos_empresa to super_admin

-- ============================================================================
-- FUNCTIONS (3 Utility Functions)
-- ============================================================================
-- 1. calcular_noches(check_in timestamptz, check_out timestamptz) → integer
-- 2. verificar_disponibilidad(id_habitacion uuid, check_in timestamptz, check_out timestamptz) → boolean
-- 3. generar_reporte_ocupacion(id_hotel uuid) → TABLE (...)

-- ============================================================================
-- END OF SCHEMA DOCUMENTATION
-- ============================================================================
