-- ════════════════════════════════════════════════════════════════
-- Chat Operativo — Mensajes y referencias a entidades
-- ════════════════════════════════════════════════════════════════

-- ── 1. Canales de chat ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  channel_type TEXT NOT NULL DEFAULT 'general',
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_channels_type_check CHECK (channel_type IN ('general', 'hotel', 'cierre', 'privado'))
);

-- Canal por defecto
INSERT INTO public.chat_channels (id, name, channel_type)
VALUES ('00000000-0000-0000-0000-000000000001', 'General', 'general')
ON CONFLICT (id) DO NOTHING;

-- ── 2. Mensajes ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id),
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_messages_type_check CHECK (message_type IN ('text', 'data_card', 'cierre_share', 'system'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel ON public.chat_messages (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON public.chat_messages (sender_id);

-- ── 3. Referencias a entidades (Data Cards) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_references (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_references_entity_check CHECK (entity_type IN ('reserva', 'pago', 'huesped', 'habitacion', 'cierre'))
);

CREATE INDEX IF NOT EXISTS idx_chat_references_message ON public.chat_references (message_id);
CREATE INDEX IF NOT EXISTS idx_chat_references_entity ON public.chat_references (entity_type, entity_id);

-- ── 4. Lectura de mensajes (para badge de no leídos) ────────────────────────
CREATE TABLE IF NOT EXISTS public.chat_read_status (
  user_id UUID NOT NULL REFERENCES auth.users(id),
  channel_id UUID NOT NULL REFERENCES public.chat_channels(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.chat_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_read_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read channels" ON public.chat_channels FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated read messages" ON public.chat_messages FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated insert messages" ON public.chat_messages FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated read references" ON public.chat_references FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated insert references" ON public.chat_references FOR INSERT WITH CHECK (auth.role() = 'authenticated');
CREATE POLICY "Authenticated manage read status" ON public.chat_read_status FOR ALL USING (auth.uid() = user_id);
