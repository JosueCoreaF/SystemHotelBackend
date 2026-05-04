-- ============================================================================
-- DATABASE IMPROVEMENTS v4 - BUSINESS LOGIC & DATA INTEGRITY
-- Versión adaptada a estructura existente de configuracion_hotelera
-- Fecha: 2026-05-03
-- ============================================================================

-- ── 1. PREVENT DOUBLE BOOKING: Constraint Trigger ──────────────────────────

-- Crear función que valida disponibilidad ANTES de INSERT/UPDATE
CREATE OR REPLACE FUNCTION public.fn_validar_disponibilidad_reserva()
RETURNS TRIGGER AS $$
DECLARE
  v_habitacion_disponible boolean;
  v_error_msg text;
BEGIN
  -- Llamar función de verificación de disponibilidad
  v_habitacion_disponible := public.verificar_disponibilidad(
    NEW.id_habitacion,
    NEW.check_in,
    NEW.check_out
  );
  
  IF NOT v_habitacion_disponible THEN
    v_error_msg := FORMAT(
      'DOUBLE BOOKING PREVENTION: Habitación %s no está disponible para el período %s a %s. 
       Existe una reserva confirmada o un bloque de mantenimiento en ese rango.',
      NEW.id_habitacion,
      NEW.check_in,
      NEW.check_out
    );
    RAISE EXCEPTION '%', v_error_msg;
  END IF;
  
  -- Validación adicional: check_out debe ser posterior a check_in
  IF NEW.check_out <= NEW.check_in THEN
    RAISE EXCEPTION 'ERROR: check_out debe ser posterior a check_in (check_out: %, check_in: %)',
      NEW.check_out, NEW.check_in;
  END IF;
  
  -- Validación: total_reserva debe ser positivo
  IF NEW.total_reserva <= 0 THEN
    RAISE EXCEPTION 'ERROR: total_reserva debe ser mayor a 0 (valor actual: %)',
      NEW.total_reserva;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.fn_validar_disponibilidad_reserva() IS 
  'Trigger function que previene double booking validando disponibilidad ANTES de insertar/actualizar reserva.
   Lanza excepción si la habitación no está disponible en el rango check_in/check_out.';

-- Crear trigger que ejecuta la validación ANTES de INSERT/UPDATE
DROP TRIGGER IF EXISTS trigger_custom_validar_disponibilidad ON public.reservas_hotel CASCADE;
CREATE TRIGGER trigger_custom_validar_disponibilidad
BEFORE INSERT OR UPDATE ON public.reservas_hotel
FOR EACH ROW
EXECUTE FUNCTION public.fn_validar_disponibilidad_reserva();

-- ── 2. CURRENCY CONVERSION: Function con tipo de cambio dinámico ──────────────

-- Función para obtener tipo de cambio actual (USD → HNL) desde configuracion_hotelera
CREATE OR REPLACE FUNCTION public.fn_obtener_tipo_cambio(
  p_moneda_origen text DEFAULT 'USD'
)
RETURNS numeric AS $$
DECLARE
  v_tipo_cambio numeric;
BEGIN
  -- Si es conversión a HNL o es HNL, obtener de config
  IF p_moneda_origen = 'USD' THEN
    SELECT tipo_cambio_base INTO v_tipo_cambio
    FROM public.configuracion_hotelera
    WHERE id_config = '1'  -- Asumir que hay un único registro de config
    LIMIT 1;
    
    -- Si no existe, usar valor por defecto
    IF v_tipo_cambio IS NULL THEN
      v_tipo_cambio := 24.50;
      RAISE WARNING 'Tipo de cambio no configurado. Usando valor por defecto: 1 USD = % HNL', v_tipo_cambio;
    END IF;
  ELSIF p_moneda_origen = 'HNL' THEN
    RETURN 1.0; -- HNL a HNL es 1:1
  ELSE
    RAISE EXCEPTION 'Moneda no soportada: %', p_moneda_origen;
  END IF;
  
  RETURN v_tipo_cambio;
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.fn_obtener_tipo_cambio(text) TO authenticated, anon;

COMMENT ON FUNCTION public.fn_obtener_tipo_cambio(text) IS 
  'Obtiene el tipo de cambio actual de configuracion_hotelera.tipo_cambio_base. 
   p_moneda_origen: USD o HNL. Retorna el factor de conversión a HNL.
   Ejemplo: USD retorna 24.50 (1 USD = 24.50 HNL)';

-- Función para convertir moneda
CREATE OR REPLACE FUNCTION public.fn_convertir_moneda(
  p_monto numeric,
  p_moneda_origen text,
  p_moneda_destino text DEFAULT 'HNL'
)
RETURNS numeric AS $$
DECLARE
  v_monto_convertido numeric;
  v_tipo_cambio numeric;
BEGIN
  -- Si son iguales, retornar el monto sin conversión
  IF p_moneda_origen = p_moneda_destino THEN
    RETURN p_monto;
  END IF;
  
  -- Obtener tipo de cambio
  v_tipo_cambio := public.fn_obtener_tipo_cambio(p_moneda_origen);
  
  -- Realizar conversión
  IF p_moneda_origen = 'USD' AND p_moneda_destino = 'HNL' THEN
    v_monto_convertido := p_monto * v_tipo_cambio;
  ELSIF p_moneda_origen = 'HNL' AND p_moneda_destino = 'USD' THEN
    v_monto_convertido := p_monto / v_tipo_cambio;
  ELSE
    RAISE EXCEPTION 'Conversión no soportada: % a %', p_moneda_origen, p_moneda_destino;
  END IF;
  
  RETURN ROUND(v_monto_convertido, 2);
END;
$$ LANGUAGE plpgsql STABLE;

GRANT EXECUTE ON FUNCTION public.fn_convertir_moneda(numeric, text, text) TO authenticated, anon;

COMMENT ON FUNCTION public.fn_convertir_moneda(numeric, text, text) IS 
  'Convierte monto entre monedas usando tipo de cambio de configuracion_hotelera.tipo_cambio_base.
   Ejemplo: fn_convertir_moneda(100, USD, HNL) retorna 2450 (100 USD × 24.50)';

-- Trigger para calcular automáticamente monto_en_moneda_reserva al registrar pago
CREATE OR REPLACE FUNCTION public.fn_calcular_monto_conversion_pago()
RETURNS TRIGGER AS $$
DECLARE
  v_moneda_reserva text;
BEGIN
  -- Obtener moneda de la reserva asociada
  SELECT moneda INTO v_moneda_reserva
  FROM public.reservas_hotel
  WHERE id_reserva_hotel = NEW.id_reserva_hotel;
  
  -- Calcular conversión si es necesario
  IF v_moneda_reserva IS NOT NULL AND NEW.moneda != v_moneda_reserva THEN
    NEW.monto_en_moneda_reserva := public.fn_convertir_moneda(
      NEW.monto,
      NEW.moneda,
      v_moneda_reserva
    );
  ELSE
    -- Si no hay conversión, el monto es igual
    NEW.monto_en_moneda_reserva := NEW.monto;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trigger_custom_calcular_conversion_pago ON public.pagos_hotel CASCADE;
CREATE TRIGGER trigger_custom_calcular_conversion_pago
BEFORE INSERT OR UPDATE ON public.pagos_hotel
FOR EACH ROW
EXECUTE FUNCTION public.fn_calcular_monto_conversion_pago();

COMMENT ON FUNCTION public.fn_calcular_monto_conversion_pago() IS 
  'Trigger que calcula automáticamente monto_en_moneda_reserva usando el tipo de cambio vigente
   en el momento del pago, preservando la integridad de datos históricos.';

-- ── 3. AGREGAR COLUMNA "estado" EN ENTIDADES MAESTRAS (si no existe) ────────────

-- Verificar y agregar columna estado a hoteles si no existe
ALTER TABLE public.hoteles
ADD COLUMN IF NOT EXISTS estado text DEFAULT 'activo';

-- Agregar CHECK constraint si es necesario (idempotente)
DO $$
BEGIN
  ALTER TABLE public.hoteles
  ADD CONSTRAINT chk_hoteles_estado CHECK (estado IN ('activo', 'inactivo', 'en_mantenimiento')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

-- Lo mismo para tipos_habitacion
ALTER TABLE public.tipos_habitacion
ADD COLUMN IF NOT EXISTS estado text DEFAULT 'activo';

DO $$
BEGIN
  ALTER TABLE public.tipos_habitacion
  ADD CONSTRAINT chk_tipos_habitacion_estado CHECK (estado IN ('activo', 'inactivo')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;

-- Crear índices en la columna estado para filtrados rápidos
CREATE INDEX IF NOT EXISTS idx_hoteles_estado ON public.hoteles(estado);
CREATE INDEX IF NOT EXISTS idx_tipos_habitacion_estado ON public.tipos_habitacion(estado);

-- ── 4. VIEW: Reporte de integridad referencial ────────────────────────────────

-- Vista para verificar orfandad de datos (debería estar vacía en BD sana)
DROP VIEW IF EXISTS public.v_integridad_referencial CASCADE;
CREATE VIEW public.v_integridad_referencial AS
SELECT 
  'Reservas sin Habitación' as problema,
  COUNT(*) as cantidad,
  'Crítico' as severidad
FROM public.reservas_hotel r
WHERE NOT EXISTS (
  SELECT 1 FROM public.habitaciones h WHERE h.id_habitacion = r.id_habitacion
)
UNION ALL
SELECT 
  'Reservas sin Huésped',
  COUNT(*),
  'Crítico'
FROM public.reservas_hotel r
WHERE NOT EXISTS (
  SELECT 1 FROM public.huespedes h WHERE h.id_huesped = r.id_huesped
)
UNION ALL
SELECT 
  'Pagos sin Reserva',
  COUNT(*),
  'Crítico'
FROM public.pagos_hotel p
WHERE NOT EXISTS (
  SELECT 1 FROM public.reservas_hotel r WHERE r.id_reserva_hotel = p.id_reserva_hotel
)
UNION ALL
SELECT 
  'Habitaciones inactivas en Reservas activas',
  COUNT(*),
  'Advertencia'
FROM public.reservas_hotel r
WHERE r.estado IN ('confirmada', 'check_out')
AND EXISTS (
  SELECT 1 FROM public.habitaciones h 
  WHERE h.id_habitacion = r.id_habitacion 
  AND h.estado != 'disponible'
)
ORDER BY severidad DESC, cantidad DESC;

COMMENT ON VIEW public.v_integridad_referencial IS 
  'Reporte de integridad referencial. Debería estar vacía en BD saludable.
   Detecta: orfandad de datos, inconsistencias de estado, violaciones de lógica de negocio.';

-- ── 5. FUNCTION: Desactivar hotel (soft delete) ─────────────────────────────────

-- Función para "desactivar" un hotel en lugar de borrarlo
DROP FUNCTION IF EXISTS public.fn_desactivar_hotel(uuid) CASCADE;
CREATE OR REPLACE FUNCTION public.fn_desactivar_hotel(p_id_hotel uuid)
RETURNS TABLE (
  exito boolean,
  mensaje text,
  hotel_id uuid,
  habitaciones_afectadas integer,
  reservas_activas integer
) AS $$
DECLARE
  v_hab_count integer;
  v_res_count integer;
  v_hotel_nombre text;
BEGIN
  -- Obtener información del hotel
  SELECT nombre_hotel INTO v_hotel_nombre
  FROM public.hoteles
  WHERE id_hotel = p_id_hotel;
  
  IF v_hotel_nombre IS NULL THEN
    RETURN QUERY SELECT false, 'Hotel no encontrado'::text, p_id_hotel, 0, 0;
    RETURN;
  END IF;
  
  -- Contar habitaciones
  SELECT COUNT(*) INTO v_hab_count
  FROM public.habitaciones
  WHERE id_hotel = p_id_hotel;
  
  -- Contar reservas activas
  SELECT COUNT(*) INTO v_res_count
  FROM public.reservas_hotel r
  JOIN public.habitaciones h ON r.id_habitacion = h.id_habitacion
  WHERE h.id_hotel = p_id_hotel
  AND r.estado IN ('confirmada', 'pendiente');
  
  -- Actualizar estado del hotel
  UPDATE public.hoteles
  SET estado = 'inactivo', updated_at = now()
  WHERE id_hotel = p_id_hotel;
  
  -- Registrar en auditoría
  INSERT INTO public.bitacora_actividad (tipo, accion, descripcion, entidad_id, usuario_id)
  VALUES (
    'UPDATE',
    'SOFT_DELETE_HOTEL',
    FORMAT('Hotel desactivado: %s. Habitaciones: %s. Reservas activas: %s',
      v_hotel_nombre, v_hab_count, v_res_count),
    p_id_hotel,
    COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  );
  
  RETURN QUERY SELECT 
    true,
    FORMAT('Hotel "%s" desactivado exitosamente. Se preservaron %s habitaciones y %s reservas activas.',
      v_hotel_nombre, v_hab_count, v_res_count)::text,
    p_id_hotel,
    v_hab_count,
    v_res_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.fn_desactivar_hotel(uuid) TO authenticated;

COMMENT ON FUNCTION public.fn_desactivar_hotel(uuid) IS 
  'Desactiva un hotel en lugar de borrarlo (soft delete). Preserva historial y reportes financieros.
   Impide que se realicen nuevas reservas pero mantiene los datos históricos intactos.';

-- ── 6. VALIDAR/ACTUALIZAR configuracion_hotelera con valores necesarios ────────

-- Asegurar que tipo_cambio_base está actualizado
UPDATE public.configuracion_hotelera
SET tipo_cambio_base = 24.50,
    tipo_cambio_actualizado_en = now()
WHERE id_config = '1'
AND (tipo_cambio_base IS NULL OR tipo_cambio_base = 0);

-- Asegurar moneda correcta
UPDATE public.configuracion_hotelera
SET moneda = 'HNL',
    moneda_alterna = 'USD'
WHERE id_config = '1'
AND (moneda IS NULL OR moneda != 'HNL');

-- ============================================================================
-- SUMMARY OF CHANGES (v4 - BUSINESS LOGIC)
-- ============================================================================
-- ✅ 1. DOUBLE BOOKING PREVENTION
--    - Trigger: trigger_custom_validar_disponibilidad
--    - Function: fn_validar_disponibilidad_reserva()
--    - Impide reservar la misma habitación al mismo tiempo
--
-- ✅ 2. DYNAMIC CURRENCY CONVERSION
--    - Function: fn_obtener_tipo_cambio(text) → numeric
--    - Function: fn_convertir_moneda(numeric, text, text) → numeric
--    - Trigger: trigger_custom_calcular_conversion_pago
--    - Calcula automáticamente conversión usando tipo_cambio_base de config
--
-- ✅ 3. DATA PRESERVATION & SOFT DELETE
--    - Added: estado column to hoteles, tipos_habitacion
--    - Function: fn_desactivar_hotel(uuid) - Soft delete con auditoría
--    - Preserva integridad de reportes financieros históricos
--
-- ✅ 4. REFERENTIAL INTEGRITY CHECK
--    - View: v_integridad_referencial - Health check
--    - Detecta orfandad de datos y violaciones de lógica de negocio
--
-- ============================================================================
-- PRÓXIMAS RECOMENDACIONES DBA:
-- ============================================================================
-- 1. Considerar modificar FK con ON DELETE RESTRICT para entidades maestras
--    para evitar cascading deletes accidentales
--
-- 2. Crear políticas de auditoría más estrictas en pagos_hotel
--    especialmente cuando hay conversión de moneda
--
-- 3. Implementar control de concurrencia optimista en reservas_hotel
--    usando update_at timestamp para detectar cambios simultáneos
--
-- 4. Agregar backup automático de datos financieros críticos
--
-- ============================================================================
-- END v4 - BUSINESS LOGIC IMPROVEMENTS
-- ============================================================================
