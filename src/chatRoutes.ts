import type { Express } from 'express';
import type { Server as HttpServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { z } from 'zod';
import { pool } from './db.js';
import { asyncHandler, ApiError } from './http.js';
import { extractUserId, requirePermission } from './permissions.js';

// ─── Schemas ─────────────────────────────────────────────────────────────────

const sendMessageSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1).max(4000),
  messageType: z.enum(['text', 'data_card', 'cierre_share', 'system']).default('text'),
  metadata: z.record(z.string(), z.unknown()).optional(),
  references: z
    .array(
      z.object({
        entityType: z.enum(['reserva', 'pago', 'huesped', 'habitacion', 'cierre']),
        entityId: z.string().uuid(),
      }),
    )
    .optional(),
});

// ─── REST endpoints ──────────────────────────────────────────────────────────

let _io: SocketServer | null = null;

export function registerChatRoutes(app: Express, io?: SocketServer) {
  if (io) _io = io;
  // List channels
  app.get('/api/chat/channels', asyncHandler(async (req, res) => {
    const userId = extractUserId(req);
    if (!userId) throw new ApiError(401, 'No autenticado.');

    const { rows } = await pool.query(`
      SELECT c.*, 
        (SELECT count(*) FROM public.chat_messages m 
          WHERE m.channel_id = c.id 
          AND m.created_at > coalesce(
            (SELECT last_read_at FROM public.chat_read_status WHERE user_id = $1 AND channel_id = c.id),
            '1970-01-01'
          )
        )::int as unread_count
      FROM public.chat_channels c
      ORDER BY c.created_at ASC
    `, [userId]);

    res.json(rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      channelType: r.channel_type,
      createdBy: r.created_by,
      createdAt: r.created_at,
      unreadCount: r.unread_count,
    })));
  }));

  // List messages for a channel (paginated)
  app.get('/api/chat/channels/:channelId/messages', asyncHandler(async (req, res) => {
    const userId = extractUserId(req);
    if (!userId) throw new ApiError(401, 'No autenticado.');

    const channelId = req.params.channelId;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const before = typeof req.query.before === 'string' ? req.query.before : null;

    let query = `
      SELECT m.*, 
        coalesce(
          (SELECT json_agg(json_build_object(
            'id', r.id, 'entityType', r.entity_type, 'entityId', r.entity_id
          )) FROM public.chat_references r WHERE r.message_id = m.id),
          '[]'
        ) as refs
      FROM public.chat_messages m
      WHERE m.channel_id = $1
    `;
    const params: unknown[] = [channelId];

    if (before) {
      query += ` AND m.created_at < $${params.length + 1}`;
      params.push(before);
    }

    query += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const { rows } = await pool.query(query, params);

    // Mark channel as read
    await pool.query(`
      INSERT INTO public.chat_read_status (user_id, channel_id, last_read_at)
      VALUES ($1, $2, now())
      ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_at = now()
    `, [userId, channelId]);

    res.json(rows.reverse().map((r: any) => ({
      id: r.id,
      channelId: r.channel_id,
      senderId: r.sender_id,
      senderName: r.sender_name,
      content: r.content,
      messageType: r.message_type,
      metadata: r.metadata,
      references: r.refs,
      createdAt: r.created_at,
    })));
  }));

  // Send a message (REST fallback — primary path is via Socket.io)
  app.post('/api/chat/channels/:channelId/messages', asyncHandler(async (req, res) => {
    const userId = extractUserId(req);
    if (!userId) throw new ApiError(401, 'No autenticado.');

    const channelId = req.params.channelId;
    const body = sendMessageSchema.parse({ ...req.body, channelId });

    const msg = await insertMessage(userId, body);
    res.status(201).json(msg);
  }));

  // Resolve entity data for a Data Card
  app.get('/api/chat/entity/:entityType/:entityId', asyncHandler(async (req, res) => {
    const userId = extractUserId(req);
    if (!userId) throw new ApiError(401, 'No autenticado.');

    const entityType = String(req.params.entityType);
    const entityId = String(req.params.entityId);
    const data = await resolveEntity(entityType, entityId);
    if (!data) throw new ApiError(404, 'Entidad no encontrada.');
    res.json(data);
  }));

  /* ── Public guest chat (omnichannel) ─────────────────────────────── */

  // Create or retrieve a guest support channel
  app.post('/api/public/chat/init', asyncHandler(async (req, res) => {
    const { nombre, correo, telefono } = req.body ?? {};
    if (!nombre || (!correo && !telefono)) throw new ApiError(400, 'nombre y al menos correo o teléfono son requeridos.');

    const identifier = correo ? correo.toLowerCase().trim() : telefono.trim();
    const guestId = `guest:${identifier}`;
    const channelName = `🟢 ${nombre}`;

    // Check if channel already exists for this guest
    const existing = await pool.query(
      `SELECT id FROM public.chat_channels WHERE created_by = $1 AND channel_type = 'cliente' LIMIT 1`,
      [guestId],
    );

    let channelId: string;

    if (existing.rows.length > 0) {
      channelId = existing.rows[0].id;
    } else {
      const ins = await pool.query(
        `INSERT INTO public.chat_channels (name, channel_type, created_by) VALUES ($1, 'cliente', $2) RETURNING id`,
        [channelName, guestId],
      );
      channelId = ins.rows[0].id;

      // Send system welcome message
      await pool.query(
        `INSERT INTO public.chat_messages (channel_id, sender_id, sender_name, content, message_type) VALUES ($1, $2, $3, $4, 'system')`,
        [channelId, guestId, nombre, `${nombre} inició una conversación desde el portal de clientes.`],
      );
    }

    // Load recent messages
    const { rows: msgs } = await pool.query(
      `SELECT id, sender_id, sender_name, content, message_type, created_at FROM public.chat_messages WHERE channel_id = $1 ORDER BY created_at ASC LIMIT 100`,
      [channelId],
    );

    res.json({
      channelId,
      guestId,
      messages: msgs.map((m: any) => ({
        id: m.id,
        senderId: m.sender_id,
        senderName: m.sender_name,
        content: m.content,
        messageType: m.message_type,
        createdAt: m.created_at,
      })),
    });
  }));

  // Guest sends a message
  app.post('/api/public/chat/send', asyncHandler(async (req, res) => {
    const { channelId, guestId, nombre, content } = req.body ?? {};
    if (!channelId || !guestId || !content) throw new ApiError(400, 'Datos incompletos.');

    const senderName = nombre || 'Huésped';
    const { rows } = await pool.query(
      `INSERT INTO public.chat_messages (channel_id, sender_id, sender_name, content, message_type) VALUES ($1, $2, $3, $4, 'text') RETURNING *`,
      [channelId, guestId, senderName, content.slice(0, 4000)],
    );
    const msg = rows[0];

    // Emitir en tiempo real al panel admin
    if (_io) {
      const payload = {
        id: msg.id,
        channelId: msg.channel_id,
        senderId: msg.sender_id,
        senderName: msg.sender_name,
        content: msg.content,
        messageType: msg.message_type,
        metadata: {},
        references: [],
        createdAt: msg.created_at,
      };
      _io.to(`channel:${channelId}`).emit('new_message', payload);
      _io.emit('unread_update', { channelId });
    }

    res.status(201).json({
      id: msg.id,
      senderId: msg.sender_id,
      senderName: msg.sender_name,
      content: msg.content,
      createdAt: msg.created_at,
    });
  }));

  // Guest polls for new messages
  app.get('/api/public/chat/messages/:channelId', asyncHandler(async (req, res) => {
    const channelId = req.params.channelId;
    const after = typeof req.query.after === 'string' ? req.query.after : null;

    let query = `SELECT id, sender_id, sender_name, content, message_type, created_at FROM public.chat_messages WHERE channel_id = $1`;
    const params: unknown[] = [channelId];
    if (after) {
      query += ` AND created_at > $2`;
      params.push(after);
    }
    query += ` ORDER BY created_at ASC LIMIT 100`;
    const { rows } = await pool.query(query, params);

    res.json(rows.map((m: any) => ({
      id: m.id,
      senderId: m.sender_id,
      senderName: m.sender_name,
      content: m.content,
      messageType: m.message_type,
      createdAt: m.created_at,
    })));
  }));
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

export function initChatSocket(httpServer: HttpServer) {
  const io = new SocketServer(httpServer, {
    cors: { origin: '*' },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    const userId = socket.handshake.auth?.userId as string | undefined;
    if (!userId) {
      socket.disconnect(true);
      return;
    }

    // Join user to their personal room for targeted events
    socket.join(`user:${userId}`);

    // Join a channel
    socket.on('join_channel', (channelId: string) => {
      socket.join(`channel:${channelId}`);
    });

    // Leave a channel
    socket.on('leave_channel', (channelId: string) => {
      socket.leave(`channel:${channelId}`);
    });

    // Send message via WebSocket
    socket.on('send_message', async (payload: unknown, callback?: (result: unknown) => void) => {
      try {
        const parsed = sendMessageSchema.parse(payload);
        const msg = await insertMessage(userId, parsed);

        // Broadcast to channel (exclude sender — sender gets msg via ack callback)
        socket.to(`channel:${parsed.channelId}`).emit('new_message', msg);

        // Notify unread counts to all connected users
        io.emit('unread_update', { channelId: parsed.channelId });

        if (typeof callback === 'function') callback({ ok: true, message: msg });
      } catch (err: any) {
        console.error('[Chat] Error sending message:', err);
        if (typeof callback === 'function') callback({ ok: false, error: err.message });
      }
    });

    // Mark channel as read
    socket.on('mark_read', async (channelId: string) => {
      try {
        await pool.query(`
          INSERT INTO public.chat_read_status (user_id, channel_id, last_read_at)
          VALUES ($1, $2, now())
          ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_at = now()
        `, [userId, channelId]);
      } catch (err) {
        console.error('[Chat] Error marking read:', err);
      }
    });

    // Typing indicator
    socket.on('typing', (channelId: string) => {
      socket.to(`channel:${channelId}`).emit('user_typing', { userId, channelId });
    });

    socket.on('disconnect', () => {
      // disconnection handled
    });
  });

  return io;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function insertMessage(
  userId: string,
  body: z.infer<typeof sendMessageSchema>,
) {
  // Resolve sender name
  const userResult = await pool.query(
    `SELECT coalesce(raw_user_meta_data ->> 'full_name', email) as name FROM auth.users WHERE id = $1`,
    [userId],
  );
  const senderName = userResult.rows[0]?.name ?? 'Usuario';

  const { rows } = await pool.query(`
    INSERT INTO public.chat_messages (channel_id, sender_id, sender_name, content, message_type, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [
    body.channelId,
    userId,
    senderName,
    body.content,
    body.messageType,
    JSON.stringify(body.metadata ?? {}),
  ]);

  const msg = rows[0];

  // Insert references if any
  if (body.references?.length) {
    for (const ref of body.references) {
      await pool.query(`
        INSERT INTO public.chat_references (message_id, entity_type, entity_id)
        VALUES ($1, $2, $3)
      `, [msg.id, ref.entityType, ref.entityId]);
    }
  }

  return {
    id: msg.id,
    channelId: msg.channel_id,
    senderId: msg.sender_id,
    senderName: msg.sender_name,
    content: msg.content,
    messageType: msg.message_type,
    metadata: msg.metadata,
    references: (body.references ?? []).map((r) => ({
      entityType: r.entityType,
      entityId: r.entityId,
    })),
    createdAt: msg.created_at,
  };
}

async function resolveEntity(entityType: string, entityId: string) {
  switch (entityType) {
    case 'reserva': {
      const { rows } = await pool.query(`
        SELECT r.id_reserva_hotel, r.estado, r.check_in, r.check_out, r.total_reserva, r.moneda,
               h.nombre_completo as huesped, hab.nombre_habitacion as habitacion, hot.nombre_hotel as hotel
        FROM public.reservas_hotel r
        LEFT JOIN public.huespedes h ON h.id_huesped = r.id_huesped
        LEFT JOIN public.habitaciones hab ON hab.id_habitacion = r.id_habitacion
        LEFT JOIN public.hoteles hot ON hot.id_hotel = r.id_hotel
        WHERE r.id_reserva_hotel = $1
      `, [entityId]);
      if (!rows[0]) return null;
      const r = rows[0];
      return {
        type: 'reserva',
        id: r.id_reserva_hotel,
        label: `Reserva · ${r.huesped ?? 'Sin huésped'}`,
        data: {
          huesped: r.huesped, habitacion: r.habitacion, hotel: r.hotel,
          estado: r.estado, checkIn: r.check_in, checkOut: r.check_out,
          total: Number(r.total_reserva), moneda: r.moneda,
        },
      };
    }

    case 'pago': {
      const { rows } = await pool.query(`
        SELECT p.id_pago_hotel, p.monto, p.metodo_pago, p.referencia, p.fecha_pago, p.moneda,
               h.nombre_completo as huesped
        FROM public.pagos_hotel p
        LEFT JOIN public.reservas_hotel r ON r.id_reserva_hotel = p.id_reserva_hotel
        LEFT JOIN public.huespedes h ON h.id_huesped = r.id_huesped
        WHERE p.id_pago_hotel = $1
      `, [entityId]);
      if (!rows[0]) return null;
      const p = rows[0];
      return {
        type: 'pago',
        id: p.id_pago_hotel,
        label: `Pago · ${p.huesped ?? 'Sin huésped'}`,
        data: {
          huesped: p.huesped, monto: Number(p.monto), metodo: p.metodo_pago,
          referencia: p.referencia, fecha: p.fecha_pago, moneda: p.moneda,
        },
      };
    }

    case 'huesped': {
      const { rows } = await pool.query(`
        SELECT id_huesped, nombre_completo, correo, telefono
        FROM public.huespedes WHERE id_huesped = $1
      `, [entityId]);
      if (!rows[0]) return null;
      const g = rows[0];
      return {
        type: 'huesped',
        id: g.id_huesped,
        label: `Huésped · ${g.nombre_completo}`,
        data: { nombre: g.nombre_completo, correo: g.correo, telefono: g.telefono, estado: 'Activo' },
      };
    }

    case 'habitacion': {
      const { rows } = await pool.query(`
        SELECT hab.id_habitacion, hab.nombre_habitacion, hab.estado, hot.nombre_hotel
        FROM public.habitaciones hab
        LEFT JOIN public.hoteles hot ON hot.id_hotel = hab.id_hotel
        WHERE hab.id_habitacion = $1
      `, [entityId]);
      if (!rows[0]) return null;
      const h = rows[0];
      return {
        type: 'habitacion',
        id: h.id_habitacion,
        label: `Hab. ${h.nombre_habitacion}`,
        data: { nombre: h.nombre_habitacion, hotel: h.nombre_hotel, estado: h.estado },
      };
    }

    case 'hotel': {
      const { rows } = await pool.query(`
        SELECT id_hotel, nombre_hotel, ciudad, direccion, estrellas, estado
        FROM public.hoteles WHERE id_hotel = $1
      `, [entityId]);
      if (!rows[0]) return null;
      const h = rows[0];
      return {
        type: 'hotel',
        id: h.id_hotel,
        label: `Hotel ${h.nombre_hotel}`,
        data: { nombre: h.nombre_hotel, ciudad: h.ciudad, estrellas: h.estrellas, estado: h.estado },
      };
    }

    case 'personal': {
      const { rows } = await pool.query(`
        SELECT p.id_personal, p.nombre_completo, p.rol, p.estado, p.correo,
               hot.nombre_hotel
        FROM public.personal_hotel p
        LEFT JOIN public.hoteles hot ON hot.id_hotel = p.id_hotel
        WHERE p.id_personal = $1
      `, [entityId]);
      if (!rows[0]) return null;
      const p = rows[0];
      return {
        type: 'personal',
        id: p.id_personal,
        label: `${p.nombre_completo}`,
        data: { nombre: p.nombre_completo, rol: p.rol, hotel: p.nombre_hotel, estado: p.estado },
      };
    }

    default:
      return null;
  }
}
