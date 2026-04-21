import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { pool, withTransaction } from './db.js';
import { ApiError, asyncHandler } from './http.js';
import { logActivity } from './app.js';

const empresaSchema = z.object({
  nombre: z.string().min(1, 'Nombre de empresa requerido'),
  rtn: z.string().nullable().optional(),
  contacto_nombre: z.string().nullable().optional(),
  contacto_telefono: z.string().nullable().optional(),
  contacto_correo: z.string().nullable().optional(),
  direccion: z.string().nullable().optional(),
  limite_credito: z.number().min(0).default(0),
  dias_credito: z.number().int().min(1).default(30),
  estado: z.enum(['activo', 'inactivo', 'suspendido']).default('activo'),
  notas: z.string().nullable().optional(),
});

const creditoSchema = z.object({
  id_empresa: z.string().uuid(),
  id_reserva_hotel: z.string().uuid().nullable().optional(),
  tipo_movimiento: z.enum(['cargo', 'abono']),
  monto: z.number().positive('Monto debe ser mayor a 0'),
  moneda: z.string().default('HNL'),
  descripcion: z.string().nullable().optional(),
  referencia: z.string().nullable().optional(),
});

export function registerEmpresasRoutes(app: Express) {

  // ═══════════════════════════════════════════════════════════════
  // EMPRESAS CRUD
  // ═══════════════════════════════════════════════════════════════

  // Listar empresas (con saldo calculado)
  app.get('/api/empresas', asyncHandler(async (request: Request, response: Response) => {
    const search = String(request.query.search ?? '').trim();
    const estado = String(request.query.estado ?? '').trim();
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params: any[] = [];
    let idx = 1;

    if (search) {
      where += ` AND (UPPER(e.nombre) LIKE UPPER($${idx}) OR e.rtn LIKE $${idx})`;
      params.push(`%${search}%`);
      idx++;
    }
    if (estado && ['activo', 'inactivo', 'suspendido'].includes(estado)) {
      where += ` AND e.estado = $${idx}`;
      params.push(estado);
      idx++;
    }

    const countResult = await pool.query(`SELECT COUNT(*) FROM public.empresas e ${where}`, params);
    const total = Number(countResult.rows[0].count);

    const result = await pool.query(`
      SELECT
        e.id_empresa, e.nombre, e.rtn, e.contacto_nombre, e.contacto_telefono,
        e.contacto_correo, e.direccion, e.limite_credito, e.estado, e.notas,
        e.created_at, e.updated_at,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0) AS total_cargos,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS total_abonos,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS saldo_pendiente
      FROM public.empresas e
      LEFT JOIN public.creditos_empresa c ON c.id_empresa = e.id_empresa
      ${where}
      GROUP BY e.id_empresa
      ORDER BY e.nombre ASC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, limit, offset]);

    return response.json({ data: result.rows, total, page, limit });
  }));

  // Obtener empresa por ID
  app.get('/api/empresas/:id', asyncHandler(async (request: Request, response: Response) => {
    const result = await pool.query(`
      SELECT
        e.*,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0) AS total_cargos,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS total_abonos,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS saldo_pendiente
      FROM public.empresas e
      LEFT JOIN public.creditos_empresa c ON c.id_empresa = e.id_empresa
      WHERE e.id_empresa = $1
      GROUP BY e.id_empresa
    `, [request.params.id]);

    if (result.rowCount === 0) throw new ApiError(404, 'Empresa no encontrada.');
    return response.json(result.rows[0]);
  }));

  // Crear empresa
  app.post('/api/empresas', asyncHandler(async (request: Request, response: Response) => {
    const body = empresaSchema.parse(request.body);
    const result = await pool.query(`
      INSERT INTO public.empresas (nombre, rtn, contacto_nombre, contacto_telefono, contacto_correo, direccion, limite_credito, dias_credito, estado, notas)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [body.nombre, body.rtn || null, body.contacto_nombre || null, body.contacto_telefono || null,
        body.contacto_correo || null, body.direccion || null, body.limite_credito, body.dias_credito, body.estado, body.notas || null]);
    return response.status(201).json(result.rows[0]);
  }));

  // Actualizar empresa
  app.put('/api/empresas/:id', asyncHandler(async (request: Request, response: Response) => {
    const body = empresaSchema.partial().parse(request.body);
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const [key, val] of Object.entries(body)) {
      fields.push(`${key} = $${idx}`);
      values.push(val ?? null);
      idx++;
    }
    if (fields.length === 0) throw new ApiError(400, 'No hay campos para actualizar.');

    values.push(request.params.id);
    const result = await pool.query(
      `UPDATE public.empresas SET ${fields.join(', ')} WHERE id_empresa = $${idx} RETURNING *`,
      values
    );
    if (result.rowCount === 0) throw new ApiError(404, 'Empresa no encontrada.');
    return response.json(result.rows[0]);
  }));

  // Eliminar empresa (solo si saldo es 0)
  app.delete('/api/empresas/:id', asyncHandler(async (request: Request, response: Response) => {
    const saldoCheck = await pool.query(`
      SELECT COALESCE(SUM(CASE WHEN tipo_movimiento = 'cargo' THEN monto ELSE -monto END), 0) AS saldo
      FROM public.creditos_empresa WHERE id_empresa = $1
    `, [request.params.id]);
    const saldo = Number(saldoCheck.rows[0]?.saldo ?? 0);
    if (saldo > 0) throw new ApiError(409, `No se puede eliminar: la empresa tiene saldo pendiente de L.${saldo.toFixed(2)}`);

    const result = await pool.query(`DELETE FROM public.empresas WHERE id_empresa = $1 RETURNING id_empresa`, [request.params.id]);
    if (result.rowCount === 0) throw new ApiError(404, 'Empresa no encontrada.');
    return response.json({ ok: true });
  }));

  // ═══════════════════════════════════════════════════════════════
  // MOVIMIENTOS DE CRÉDITO
  // ═══════════════════════════════════════════════════════════════

  // Listar movimientos de una empresa
  app.get('/api/empresas/:id/creditos', asyncHandler(async (request: Request, response: Response) => {
    const page = Math.max(1, Number(request.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(request.query.limit) || 50));
    const offset = (page - 1) * limit;

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM public.creditos_empresa WHERE id_empresa = $1`, [request.params.id]
    );
    const total = Number(countResult.rows[0].count);

    const result = await pool.query(`
      SELECT c.*, r.check_in, r.check_out, r.observaciones AS reserva_obs
      FROM public.creditos_empresa c
      LEFT JOIN public.reservas_hotel r ON r.id_reserva_hotel = c.id_reserva_hotel
      WHERE c.id_empresa = $1
      ORDER BY c.fecha_movimiento DESC
      LIMIT $2 OFFSET $3
    `, [request.params.id, limit, offset]);

    return response.json({ data: result.rows, total, page, limit });
  }));

  // Reservas pendientes de una empresa (para selector de abono)
  app.get('/api/empresas/:id/reservas-pendientes', asyncHandler(async (request: Request, response: Response) => {
    const result = await pool.query(`
      SELECT r.id_reserva_hotel, r.check_in, r.check_out, r.total_reserva, r.estado, r.observaciones,
             h.nombre_completo AS huesped, hab.nombre AS habitacion,
             COALESCE((SELECT SUM(monto_en_moneda_reserva) FROM public.pagos_hotel WHERE id_reserva_hotel = r.id_reserva_hotel), 0) AS pagado
      FROM public.reservas_hotel r
      LEFT JOIN public.huespedes h ON h.id_huesped = r.id_huesped
      LEFT JOIN public.habitaciones hab ON hab.id_habitacion = r.id_habitacion
      WHERE r.id_empresa = $1 AND r.estado != 'cancelada'
      ORDER BY r.check_in ASC
    `, [request.params.id]);
    const pendientes = result.rows
      .map((r: any) => ({ ...r, saldo: Math.max(0, Number(r.total_reserva) - Number(r.pagado)) }))
      .filter((r: any) => r.saldo > 0.009);
    return response.json({ data: pendientes });
  }));

  // Registrar movimiento (cargo o abono)
  app.post('/api/creditos', asyncHandler(async (request: Request, response: Response) => {
    const body = creditoSchema.parse(request.body);

    // Verificar que la empresa existe y está activa
    const empresaCheck = await pool.query(
      `SELECT estado, limite_credito FROM public.empresas WHERE id_empresa = $1`, [body.id_empresa]
    );
    if (empresaCheck.rowCount === 0) throw new ApiError(404, 'Empresa no encontrada.');
    if (empresaCheck.rows[0].estado === 'suspendido' && body.tipo_movimiento === 'cargo') {
      throw new ApiError(409, 'Empresa suspendida: no se permiten nuevos cargos.');
    }

    // Si es cargo, verificar límite de crédito
    if (body.tipo_movimiento === 'cargo') {
      const saldoResult = await pool.query(`
        SELECT COALESCE(SUM(CASE WHEN tipo_movimiento = 'cargo' THEN monto ELSE -monto END), 0) AS saldo
        FROM public.creditos_empresa WHERE id_empresa = $1
      `, [body.id_empresa]);
      const saldoActual = Number(saldoResult.rows[0].saldo);
      const limite = Number(empresaCheck.rows[0].limite_credito);
      if (limite > 0 && (saldoActual + body.monto) > limite) {
        throw new ApiError(409, `Límite de crédito excedido. Saldo actual: L.${saldoActual.toFixed(2)}, Límite: L.${limite.toFixed(2)}`);
      }
    }

    const result = await pool.query(`
      INSERT INTO public.creditos_empresa (id_empresa, id_reserva_hotel, tipo_movimiento, monto, moneda, descripcion, referencia)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [body.id_empresa, body.id_reserva_hotel || null, body.tipo_movimiento, body.monto,
        body.moneda, body.descripcion || null, body.referencia || null]);

    // Si es abono, registrar también como pago en pagos_hotel para que se refleje en ingresos
    if (body.tipo_movimiento === 'abono') {
      let remainingAmount = body.monto;

      if (body.id_reserva_hotel) {
        // Abono directo a una reserva específica
        await pool.query(`
          INSERT INTO public.pagos_hotel (id_reserva_hotel, monto, metodo_pago, referencia, fecha_pago, estado, moneda, monto_en_moneda_reserva)
          VALUES ($1, $2, 'transferencia', $3, NOW(), 'aplicado', $4, $2)
        `, [body.id_reserva_hotel, body.monto, body.referencia || 'Abono crédito empresarial', body.moneda]);
      } else {
        // Distribuir el abono entre reservas pendientes de la empresa (de la más antigua a la más reciente)
        const pendingReservations = await pool.query(`
          SELECT r.id_reserva_hotel, r.total_reserva,
                 COALESCE((SELECT SUM(monto_en_moneda_reserva) FROM public.pagos_hotel WHERE id_reserva_hotel = r.id_reserva_hotel), 0) AS pagado
          FROM public.reservas_hotel r
          WHERE r.id_empresa = $1 AND r.estado != 'cancelada'
          ORDER BY r.check_in ASC
        `, [body.id_empresa]);

        for (const row of pendingReservations.rows) {
          if (remainingAmount <= 0) break;
          const saldoPendiente = Math.max(0, Number(row.total_reserva) - Number(row.pagado));
          if (saldoPendiente <= 0) continue;
          const montoPago = Math.min(remainingAmount, saldoPendiente);
          await pool.query(`
            INSERT INTO public.pagos_hotel (id_reserva_hotel, monto, metodo_pago, referencia, fecha_pago, estado, moneda, monto_en_moneda_reserva)
            VALUES ($1, $2, 'transferencia', $3, NOW(), 'aplicado', $4, $2)
          `, [row.id_reserva_hotel, montoPago, body.referencia || 'Abono crédito empresarial', body.moneda]);
          remainingAmount -= montoPago;
        }
      }
    }

    // Log de actividad
    const empresaNombre = (await pool.query(`SELECT nombre FROM public.empresas WHERE id_empresa = $1`, [body.id_empresa])).rows[0]?.nombre ?? '';
    void logActivity(null, 'credito', body.tipo_movimiento === 'cargo' ? 'cargo_registrado' : 'abono_registrado',
      `${body.tipo_movimiento === 'cargo' ? 'Cargo' : 'Abono'} de L.${body.monto.toFixed(2)} — ${empresaNombre}`,
      body.id_empresa);

    return response.status(201).json(result.rows[0]);
  }));

  // ═══════════════════════════════════════════════════════════════
  // RTN PARTICULARES (buscar huéspedes con RTN)
  // ═══════════════════════════════════════════════════════════════

  // Buscar huéspedes/empresas por RTN
  app.get('/api/rtn/buscar', asyncHandler(async (request: Request, response: Response) => {
    const rtn = String(request.query.rtn ?? '').trim();
    if (!rtn) throw new ApiError(400, 'RTN requerido.');

    const empresas = await pool.query(
      `SELECT id_empresa, nombre, rtn, 'empresa' AS tipo FROM public.empresas WHERE rtn = $1`, [rtn]
    );
    const huespedes = await pool.query(
      `SELECT id_huesped, nombre_completo AS nombre, rtn, 'particular' AS tipo FROM public.huespedes WHERE rtn = $1`, [rtn]
    );

    return response.json({ resultados: [...empresas.rows, ...huespedes.rows] });
  }));

  // Actualizar RTN de huésped
  app.patch('/api/huespedes/:id/rtn', asyncHandler(async (request: Request, response: Response) => {
    const rtn = String(request.body.rtn ?? '').trim();
    if (!rtn) throw new ApiError(400, 'RTN requerido.');

    const result = await pool.query(
      `UPDATE public.huespedes SET rtn = $1 WHERE id_huesped = $2 RETURNING id_huesped, nombre_completo, rtn`,
      [rtn, request.params.id]
    );
    if (result.rowCount === 0) throw new ApiError(404, 'Huésped no encontrado.');
    return response.json(result.rows[0]);
  }));

  // ═══════════════════════════════════════════════════════════════
  // RECORDATORIOS / CRÉDITOS VENCIDOS
  // ═══════════════════════════════════════════════════════════════

  // Resumen de cobranza: empresas con saldo y estado de vencimiento
  app.get('/api/creditos/cobranza', asyncHandler(async (_request: Request, response: Response) => {
    // Empresas con saldo > 0 y su cargo más antiguo sin cubrir
    const result = await pool.query(`
      SELECT
        e.id_empresa,
        e.nombre,
        e.rtn,
        e.dias_credito,
        e.contacto_nombre,
        e.contacto_telefono,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0) AS total_cargos,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS total_abonos,
        COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) AS saldo_pendiente,
        MIN(c.fecha_movimiento) FILTER (WHERE c.tipo_movimiento = 'cargo') AS primer_cargo,
        (MIN(c.fecha_movimiento) FILTER (WHERE c.tipo_movimiento = 'cargo') + (e.dias_credito || ' days')::interval)::date AS fecha_vencimiento,
        CASE
          WHEN CURRENT_DATE > (MIN(c.fecha_movimiento) FILTER (WHERE c.tipo_movimiento = 'cargo') + (e.dias_credito || ' days')::interval)::date
            THEN 'vencido'
          WHEN CURRENT_DATE > (MIN(c.fecha_movimiento) FILTER (WHERE c.tipo_movimiento = 'cargo') + ((e.dias_credito - 7) || ' days')::interval)::date
            THEN 'por_vencer'
          ELSE 'vigente'
        END AS estado_cobranza,
        CURRENT_DATE - (MIN(c.fecha_movimiento) FILTER (WHERE c.tipo_movimiento = 'cargo') + (e.dias_credito || ' days')::interval)::date AS dias_vencido
      FROM public.empresas e
      JOIN public.creditos_empresa c ON c.id_empresa = e.id_empresa
      WHERE e.estado = 'activo'
      GROUP BY e.id_empresa
      HAVING COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'cargo' THEN c.monto ELSE 0 END), 0)
           - COALESCE(SUM(CASE WHEN c.tipo_movimiento = 'abono' THEN c.monto ELSE 0 END), 0) > 0
      ORDER BY fecha_vencimiento ASC NULLS LAST
    `);

    const vencidos = result.rows.filter((r: any) => r.estado_cobranza === 'vencido');
    const porVencer = result.rows.filter((r: any) => r.estado_cobranza === 'por_vencer');
    const vigentes = result.rows.filter((r: any) => r.estado_cobranza === 'vigente');

    return response.json({
      resumen: {
        total_empresas: result.rows.length,
        vencidos: vencidos.length,
        por_vencer: porVencer.length,
        vigentes: vigentes.length,
        monto_vencido: vencidos.reduce((s: number, r: any) => s + Number(r.saldo_pendiente), 0),
        monto_por_vencer: porVencer.reduce((s: number, r: any) => s + Number(r.saldo_pendiente), 0),
        monto_vigente: vigentes.reduce((s: number, r: any) => s + Number(r.saldo_pendiente), 0),
      },
      empresas: result.rows,
    });
  }));
}
