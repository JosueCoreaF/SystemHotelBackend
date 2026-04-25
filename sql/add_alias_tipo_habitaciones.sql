-- Agregar columnas nombre_alias y tipo a la tabla habitaciones
ALTER TABLE public.habitaciones
ADD COLUMN IF NOT EXISTS nombre_alias text,
ADD COLUMN IF NOT EXISTS tipo text DEFAULT 'Clase grupal';

-- Crear índice para nombre_alias
CREATE INDEX IF NOT EXISTS idx_habitaciones_nombre_alias ON public.habitaciones(nombre_alias);
CREATE INDEX IF NOT EXISTS idx_habitaciones_tipo ON public.habitaciones(tipo);
