-- Permitir monto 0 para pagos tipo canje
ALTER TABLE public.pagos_hotel DROP CONSTRAINT IF EXISTS pagos_hotel_monto_check;
ALTER TABLE public.pagos_hotel ADD CONSTRAINT pagos_hotel_monto_check CHECK (monto >= 0);
