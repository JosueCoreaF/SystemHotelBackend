-- ════════════════════════════════════════════════════════════════
-- Empresas & Sistema de Créditos Empresariales
-- ════════════════════════════════════════════════════════════════

-- ── 1. Empresas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.empresas (
  id_empresa UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre TEXT NOT NULL,
  rtn TEXT,
  contacto_nombre TEXT,
  contacto_telefono TEXT,
  contacto_correo TEXT,
  direccion TEXT,
  limite_credito NUMERIC(12, 2) NOT NULL DEFAULT 0,
  dias_credito INTEGER NOT NULL DEFAULT 30,
  estado TEXT NOT NULL DEFAULT 'activo',
  notas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT empresas_nombre_unique UNIQUE (nombre),
  CONSTRAINT empresas_rtn_unique UNIQUE (rtn),
  CONSTRAINT empresas_estado_check CHECK (estado IN ('activo', 'inactivo', 'suspendido')),
  CONSTRAINT empresas_limite_check CHECK (limite_credito >= 0),
  CONSTRAINT empresas_dias_credito_check CHECK (dias_credito > 0)
);

-- ── 2. Movimientos de crédito ────────────────────────────────────────────────
-- tipo_movimiento: 'cargo' = la empresa consumió a crédito, 'abono' = la empresa pagó
CREATE TABLE IF NOT EXISTS public.creditos_empresa (
  id_credito UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  id_empresa UUID NOT NULL REFERENCES public.empresas(id_empresa) ON DELETE RESTRICT,
  id_reserva_hotel UUID REFERENCES public.reservas_hotel(id_reserva_hotel) ON DELETE SET NULL,
  tipo_movimiento TEXT NOT NULL,
  monto NUMERIC(12, 2) NOT NULL,
  moneda TEXT NOT NULL DEFAULT 'HNL',
  descripcion TEXT,
  referencia TEXT,
  fecha_movimiento TIMESTAMPTZ NOT NULL DEFAULT now(),
  registrado_por UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT creditos_tipo_check CHECK (tipo_movimiento IN ('cargo', 'abono')),
  CONSTRAINT creditos_monto_check CHECK (monto > 0)
);

-- ── 3. Agregar RTN a huéspedes (particulares) ───────────────────────────────
ALTER TABLE public.huespedes ADD COLUMN IF NOT EXISTS rtn TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_huespedes_rtn ON public.huespedes (rtn) WHERE rtn IS NOT NULL AND rtn <> '';

-- ── 4. Vincular reservas con empresas (opcional) ─────────────────────────────
ALTER TABLE public.reservas_hotel ADD COLUMN IF NOT EXISTS id_empresa UUID REFERENCES public.empresas(id_empresa) ON DELETE SET NULL;

-- ── 5. Índices ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_empresas_nombre ON public.empresas (UPPER(nombre));
CREATE INDEX IF NOT EXISTS idx_empresas_rtn ON public.empresas (rtn) WHERE rtn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_creditos_empresa ON public.creditos_empresa (id_empresa, fecha_movimiento DESC);
CREATE INDEX IF NOT EXISTS idx_creditos_reserva ON public.creditos_empresa (id_reserva_hotel) WHERE id_reserva_hotel IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reservas_empresa ON public.reservas_hotel (id_empresa) WHERE id_empresa IS NOT NULL;

-- ── 6. Vista: saldo por empresa ──────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_saldos_empresa AS
SELECT
  e.id_empresa,
  e.nombre,
  e.rtn,
  e.limite_credito,
  e.dias_credito,
  e.estado,
  e.contacto_nombre,
  e.contacto_telefono,
  COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0) AS total_cargos,
  COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS total_abonos,
  COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS saldo_pendiente,
  COUNT(c.id_credito) FILTER (WHERE c.tipo_movimiento = 'cargo') AS total_operaciones
FROM public.empresas e
LEFT JOIN public.creditos_empresa c ON c.id_empresa = e.id_empresa
GROUP BY e.id_empresa, e.nombre, e.rtn, e.limite_credito, e.dias_credito, e.estado, e.contacto_nombre, e.contacto_telefono;

-- ── 6b. Vista: cargos vencidos (por cobrar después de N días) ────────────────
CREATE OR REPLACE VIEW public.v_creditos_vencidos AS
SELECT
  c.id_credito,
  c.id_empresa,
  e.nombre AS empresa,
  e.rtn,
  e.dias_credito,
  e.contacto_nombre,
  e.contacto_telefono,
  c.monto,
  c.moneda,
  c.descripcion,
  c.referencia,
  c.fecha_movimiento,
  c.fecha_movimiento + (e.dias_credito || ' days')::interval AS fecha_vencimiento,
  CURRENT_DATE - (c.fecha_movimiento + (e.dias_credito || ' days')::interval)::date AS dias_vencido,
  CASE
    WHEN CURRENT_DATE > (c.fecha_movimiento + (e.dias_credito || ' days')::interval)::date THEN 'vencido'
    WHEN CURRENT_DATE > (c.fecha_movimiento + (e.dias_credito - 7 || ' days')::interval)::date THEN 'por_vencer'
    ELSE 'vigente'
  END AS estado_credito
FROM public.creditos_empresa c
JOIN public.empresas e ON e.id_empresa = c.id_empresa
WHERE c.tipo_movimiento = 'cargo'
  -- Excluir cargos que ya fueron cubiertos por abonos (simplificado: cargo aún abierto si saldo empresa > 0)
  AND (
    SELECT COALESCE(SUM(CASE WHEN cc.tipo_movimiento = 'cargo' THEN cc.monto ELSE -cc.monto END), 0)
    FROM public.creditos_empresa cc WHERE cc.id_empresa = c.id_empresa
  ) > 0;

-- ── 7. Triggers updated_at ───────────────────────────────────────────────────
DROP TRIGGER IF EXISTS empresas_set_updated_at ON public.empresas;
CREATE TRIGGER empresas_set_updated_at BEFORE UPDATE ON public.empresas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 8. RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.creditos_empresa ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read empresas" ON public.empresas FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated manage empresas" ON public.empresas FOR ALL USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated read creditos" ON public.creditos_empresa FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated manage creditos" ON public.creditos_empresa FOR ALL USING (auth.role() = 'authenticated');
