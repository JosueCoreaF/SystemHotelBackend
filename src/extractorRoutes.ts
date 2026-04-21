import multer from 'multer';
import type { Express, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { extractReservationsFromCsv, extractReservationsFromXlsx, writeTextReport } from './extractor.js';
import { ApiError, asyncHandler } from './http.js';
import { importReservationsToDb } from './importer.js';

const upload = multer();

export function registerExtractorRoutes(app: Express) {
  app.post('/api/extractor/upload', upload.single('file'), asyncHandler(async (request: Request, response: Response) => {
    const reqAny = request as Request & { file?: { buffer: Buffer; size?: number; originalname?: string } };
    const file = reqAny.file;
    let consolidated: any[] = [];

    try {
      // request logging removed for production
    } catch (err) {
      console.warn('[extractor] logging failed', err);
    }

    if (file && file.originalname && file.originalname.endsWith('.xlsx')) {
      // Procesar archivo Excel
      consolidated = await extractReservationsFromXlsx(file.buffer);
    } else if (file) {
      // Procesar como CSV
      const csvContent = file.buffer.toString('utf-8');
      consolidated = extractReservationsFromCsv(csvContent);
    } else if (request.body?.csv) {
      consolidated = extractReservationsFromCsv(request.body.csv);
    } else {
      throw new ApiError(400, 'Se requiere un archivo .xlsx/.csv en el campo "file" o un campo "csv" en el body.');
    }

    try {
      // count logging removed
    } catch (err) {
      console.warn('[extractor] could not log consolidated count', err);
    }

    try {
      writeTextReport('reportes_generados/reporte_consolidado_completo.txt', consolidated as any);
    } catch (err) {
      console.warn('No se pudo escribir reporte de texto:', err);
    }

    try {
      // response logging removed
    } catch {
      // Ignora fallos de logging.
    }

    // Construir resumen por mes
    const resumen: Record<string, { count: number; monto: number; habitaciones: string[]; estados: Record<string, number> }> = {};
    for (const r of consolidated) {
      const key = `${r.mes || 'DESCONOCIDO'}-${r.ano || '0'}`;
      if (!resumen[key]) resumen[key] = { count: 0, monto: 0, habitaciones: [], estados: {} };
      resumen[key].count++;
      resumen[key].monto += Number(r.precio) || 0;
      if (!resumen[key].habitaciones.includes(r.habitacion)) resumen[key].habitaciones.push(r.habitacion);
      resumen[key].estados[r.estado_pago] = (resumen[key].estados[r.estado_pago] || 0) + 1;
    }

    return response.json({ ok: true, count: consolidated.length, data: consolidated, resumen });
  }));

  app.post('/api/extractor/import', asyncHandler(async (request: Request, response: Response) => {
    const payload = request.body;
    if (!Array.isArray(payload)) {
      throw new ApiError(400, 'Se requiere un arreglo JSON de reservas consolidadas en el body.');
    }

    try {
      const result = await importReservationsToDb(payload as any[]);
      return response.json({ ok: true, inserted: result.inserted, ids: result.ids });
    } catch (err: any) {
      console.error('[importer] error', err);
      throw new ApiError(500, `Error importando reservas: ${err?.message ?? String(err)}`);
    }
  }));

  // ── Guardar JSONs de reservas y discrepancias en carpeta local ──
  app.post('/api/extractor/save-json', asyncHandler(async (request: Request, response: Response) => {
    const { reservas, discrepancias } = request.body;
    if (!reservas && !discrepancias) {
      throw new ApiError(400, 'Se requiere al menos "reservas" o "discrepancias" en el body.');
    }

    const dir = path.resolve('reportes_generados');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const saved: string[] = [];

    if (reservas) {
      const fname = 'reservas_extraidas.json';
      fs.writeFileSync(path.join(dir, fname), JSON.stringify(reservas, null, 2), 'utf-8');
      saved.push(fname);
    }
    if (discrepancias) {
      const fname = 'discrepancias.json';
      fs.writeFileSync(path.join(dir, fname), JSON.stringify(discrepancias, null, 2), 'utf-8');
      saved.push(fname);
    }

    return response.json({ ok: true, files: saved, directory: dir });
  }));
}