-- ─────────────────────────────────────────────────────────────────────────────
-- Migración: Agregar campos de estado normalizados a reservas_hotel
-- Descripción: Normaliza los 10 estados (operativos + pago + habitación) 
--              directamente en la BD en lugar de calcularlos dinámicamente
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Agregar columnas si no existen
ALTER TABLE public.reservas_hotel 
ADD COLUMN IF NOT EXISTS estado_pago text default 'pagado',
ADD COLUMN IF NOT EXISTS estado_habitacion text default 'ocupada',
ADD COLUMN IF NOT EXISTS detalles_estado jsonb default '[]'::jsonb;

-- 2. Crear constraints para los nuevos estados
ALTER TABLE public.reservas_hotel 
DROP CONSTRAINT IF EXISTS reservas_hotel_estado_pago_check,
DROP CONSTRAINT IF EXISTS reservas_hotel_estado_habitacion_check,
ADD CONSTRAINT reservas_hotel_estado_pago_check 
  check (estado_pago in ('pagado', 'cortesia', 'credito', 'deuda', 'capital_pendiente', 'reservada', 'abonada', 'n/a')),
ADD CONSTRAINT reservas_hotel_estado_habitacion_check 
  check (estado_habitacion in ('ocupada', 'reservada', 'por_confirmar', 'no_disponible', 'mantenimiento', 'disponible', 'limpieza'));

-- 3. Crear índices para mejor performance
CREATE INDEX IF NOT EXISTS idx_reservas_hotel_estado_pago 
  ON public.reservas_hotel (id_hotel, estado_pago);

CREATE INDEX IF NOT EXISTS idx_reservas_hotel_estado_habitacion 
  ON public.reservas_hotel (id_hotel, estado_habitacion);

CREATE INDEX IF NOT EXISTS idx_reservas_hotel_estado_combined 
  ON public.reservas_hotel (id_hotel, estado, estado_pago, estado_habitacion);

-- 4. Función para calcular dinámicamente los estados (para compatibilidad backward)
CREATE OR REPLACE FUNCTION public.calculate_reservation_states(
  p_check_in timestamptz,
  p_check_out timestamptz,
  p_estado text,
  p_total_reserva numeric,
  p_anticipo numeric
)
RETURNS TABLE (estado_operativo text, estado_pago_calc text, estado_hab_calc text) AS $$
DECLARE
  hoy DATE;
  check_in_date DATE;
  check_out_date DATE;
BEGIN
  hoy := CURRENT_DATE;
  check_in_date := (p_check_in AT TIME ZONE 'UTC')::DATE;
  check_out_date := (p_check_out AT TIME ZONE 'UTC')::DATE;

  -- Estado operativo (basado en fecha y estado de BD)
  estado_operativo := 
    CASE 
      WHEN p_estado = 'cancelada' THEN 'cancelada'
      WHEN p_estado = 'no_show' THEN 'no_show'
      WHEN p_estado = 'check_out' THEN 'completada'
      WHEN p_estado = 'check_in' THEN 'confirmada'
      WHEN p_estado = 'confirmada' THEN 'confirmada'
      ELSE 'creada'
    END;

  -- Estado de habitación (basado en fechas relativas)
  estado_hab_calc := 
    CASE
      WHEN check_in_date > hoy THEN 'reservada'
      WHEN check_out_date <= hoy THEN 'disponible'
      WHEN check_in_date <= hoy AND check_out_date > hoy THEN 'ocupada'
      ELSE 'ocupada'
    END;

  -- Estado de pago (basado en anticipo vs total)
  estado_pago_calc := 
    CASE
      WHEN p_total_reserva = 0 THEN 'cortesia'
      WHEN p_anticipo >= p_total_reserva THEN 'pagado'
      WHEN p_anticipo > 0 AND p_anticipo < p_total_reserva THEN 'abonada'
      WHEN p_anticipo = 0 AND p_total_reserva > 0 THEN 'pendiente'
      ELSE 'pagado'
    END;

  RETURN NEXT;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- 5. Migrar datos existentes (calcular estados basados en lógica actual)
UPDATE public.reservas_hotel r
SET 
  estado_pago = CASE
    WHEN total_reserva = 0 THEN 'cortesia'
    WHEN anticipo >= total_reserva THEN 'pagado'
    WHEN anticipo > 0 AND anticipo < total_reserva THEN 'abonada'
    WHEN anticipo = 0 AND total_reserva > 0 THEN 'pendiente'
    ELSE 'pagado'
  END,
  estado_habitacion = CASE
    WHEN check_in::DATE > CURRENT_DATE THEN 'reservada'
    WHEN check_out::DATE <= CURRENT_DATE THEN 'disponible'
    WHEN check_in::DATE <= CURRENT_DATE AND check_out::DATE > CURRENT_DATE THEN 'ocupada'
    ELSE 'ocupada'
  END
WHERE estado_pago IS NULL OR estado_habitacion IS NULL;

-- 6. Crear vista consolidada para compatibilidad
CREATE OR REPLACE VIEW public.reservas_hotel_completa AS
SELECT 
  rh.*,
  -- Estado operativo legacy (para compatibilidad)
  CASE 
    WHEN rh.estado = 'cancelada' THEN 'cancelada'
    WHEN rh.estado = 'no_show' THEN 'no_show'
    WHEN rh.estado = 'check_out' THEN 'completada'
    WHEN rh.estado = 'check_in' THEN 'confirmada'
    WHEN rh.estado = 'confirmada' THEN 'confirmada'
    ELSE 'creada'
  END AS estado_operativo
FROM public.reservas_hotel rh;

-- 7. Log de migración
DO $$
BEGIN
  INSERT INTO public.bitacora_actividad (tipo, accion, descripcion)
  VALUES ('SISTEMA', 'MIGRACION', 'Campos estado_pago y estado_habitacion agregados a reservas_hotel');
  
  RAISE NOTICE 'Migración completada: % reservas actualizadas con nuevos estados', 
    (SELECT COUNT(*) FROM public.reservas_hotel WHERE estado_pago IS NOT NULL);
END $$;
