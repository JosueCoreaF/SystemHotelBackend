-- ⚠️ DESTRUCTIVO: Vaciar todas las reservas y pagos
-- Los pagos se eliminan automáticamente por CASCADE

-- Primero pagos (por si acaso)
DELETE FROM public.pagos_hotel;

-- Luego reservas
DELETE FROM public.reservas_hotel;
