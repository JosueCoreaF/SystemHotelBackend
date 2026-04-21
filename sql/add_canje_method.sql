-- Agregar 'canje' como método de pago válido
ALTER TABLE public.pagos_hotel DROP CONSTRAINT IF EXISTS pagos_hotel_metodo_check;
ALTER TABLE public.pagos_hotel ADD CONSTRAINT pagos_hotel_metodo_check
  CHECK (metodo_pago IN ('efectivo', 'tarjeta', 'transferencia', 'deposito', 'canje', 'otro'));
