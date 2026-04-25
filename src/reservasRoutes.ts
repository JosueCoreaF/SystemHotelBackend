import type { Express, Request, Response } from 'express';
import { pool } from './db.js';
import { ApiError, asyncHandler } from './http.js';

function parseDateParam(value: unknown, fallback: Date) {
  if (!value) return fallback;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return fallback;
  return d;
}

export function registerReservasRoutes(app: Express) {
  // GET /api/reservas/summary?start=YYYY-MM-DD&end=YYYY-MM-DD&groupBy=day|month|week
  app.get('/api/reservas/summary', asyncHandler(async (request: Request, response: Response) => {
    const q = request.query;
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(now.getFullYear() - 1);

    const start = parseDateParam(q.start, oneYearAgo).toISOString();
    const end = parseDateParam(q.end, now).toISOString();
    const groupBy = String(q.groupBy || 'day');

    const allowed = new Set(['day', 'month', 'week']);
    if (!allowed.has(groupBy)) throw new ApiError(400, 'groupBy debe ser day|month|week');

    let periodExpr = "date_trunc('day', r.check_in)::date";
    if (groupBy === 'month') periodExpr = "date_trunc('month', r.check_in)::date";
    if (groupBy === 'week') periodExpr = "date_trunc('week', r.check_in)::date";

    const sql = `
      select
        ${periodExpr} as periodo,
        count(*)::int as total_reservas,
        coalesce(sum(r.total_reserva::numeric), 0)::numeric as total_monto
      from public.reservas_hotel r
      where r.check_in >= $1::timestamptz
        and r.check_in < $2::timestamptz
      group by periodo
      order by periodo asc
    `;

    const result = await pool.query(sql, [start, end]);
    response.json({ ok: true, groupBy, start, end, data: result.rows });
  }));

  // GET /api/reservas/stream?start=...&end=...&cursor=createdAt|id&limit=1000
  app.get('/api/reservas/stream', asyncHandler(async (request: Request, response: Response) => {
    const q = request.query;
    const now = new Date();
    const oneYearAgo = new Date(now);
    oneYearAgo.setFullYear(now.getFullYear() - 1);

    const start = parseDateParam(q.start, oneYearAgo).toISOString();
    const end = parseDateParam(q.end, now).toISOString();
    const rawLimit = Number(q.limit ?? 1000);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 5000) : 1000;

    const cursor = typeof q.cursor === 'string' ? q.cursor : null;
    let sql: string;
    let params: any[];

    if (cursor) {
      const parts = String(cursor).split('|');
      if (parts.length !== 2) throw new ApiError(400, 'Cursor inválido');
      const [cursorCreatedAt, cursorId] = parts;
      sql = `
        select r.*
        from public.reservas_hotel r
        where r.check_in >= $1::timestamptz
          and r.check_in < $2::timestamptz
          and (r.created_at, r.id_reserva_hotel) > ($3::timestamptz, $4::uuid)
        order by r.created_at asc, r.id_reserva_hotel asc
        limit $5
      `;
      params = [start, end, cursorCreatedAt, cursorId, limit];
    } else {
      sql = `
        select r.*
        from public.reservas_hotel r
        where r.check_in >= $1::timestamptz
          and r.check_in < $2::timestamptz
        order by r.created_at asc, r.id_reserva_hotel asc
        limit $3
      `;
      params = [start, end, limit];
    }

    const result = await pool.query(sql, params);
    const rows = result.rows || [];
    let nextCursor = null;
    if (rows.length >= limit) {
      const last = rows[rows.length - 1];
      nextCursor = `${new Date(last.created_at).toISOString()}|${last.id_reserva_hotel}`;
    }

    response.json({ ok: true, rows, nextCursor });
  }));

  // Health / advice endpoint for indexing recommendations
  app.get('/api/reservas/index-advice', asyncHandler(async (_req: Request, res: Response) => {
    res.json({
      ok: true,
      advice: [
        "CREATE INDEX IF NOT EXISTS idx_reservas_check_in ON public.reservas_hotel (check_in);",
        "CREATE INDEX IF NOT EXISTS idx_reservas_created_at_id ON public.reservas_hotel (created_at, id_reserva_hotel);",
        "Consider materialized views or nightly jobs to pre-aggregate totals per day/month for very large datasets."
      ]
    });
  }));
}
