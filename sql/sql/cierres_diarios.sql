-- ════════════════════════════════════════════════════════════════
-- Tabla: cierres_diarios — Almacena el cierre de caja por día/hotel
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cierres_diarios (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fecha            DATE NOT NULL,
  hotel            TEXT NOT NULL DEFAULT 'Todas',
  encargado_id     UUID REFERENCES auth.users(id),
  encargado_nombre TEXT,
  snapshot         JSONB NOT NULL,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(fecha, hotel)
);

ALTER TABLE cierres_diarios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read cierres"
  ON cierres_diarios FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can insert cierres"
  ON cierres_diarios FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can update cierres"
  ON cierres_diarios FOR UPDATE
  USING (auth.role() = 'authenticated');
