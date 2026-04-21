import ExcelJS from 'exceljs';

// ─── Extracción desde Excel con estilos ─────────────────────────────────────
/**
 * Procesa un archivo Excel (.xlsx) y extrae reservas interpretando estilos de celda.
 * @param buffer Buffer del archivo Excel
 * @returns Array de reservas interpretadas
 */
export async function extractReservationsFromXlsx(buffer: Buffer): Promise<any[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const allConsolidated: any[] = [];

  // ── Resolver color desde theme + tint a ARGB hex ──
  const defaultThemeColors: Record<number, string> = {
    0: 'FFFFFF', // blanco
    1: '000000', // negro
    2: 'E7E6E6', // gris claro
    3: '44546A', // gris azulado
    4: '4472C4', // azul
    5: 'ED7D31', // naranja/salmón → CRÉDITO
    6: 'A5A5A5', // gris
    7: 'FFC000', // dorado
    8: '5B9BD5', // azul claro
    9: '70AD47', // verde
  };

  function resolveThemeColor(colorObj: any): string | null {
    if (!colorObj) return null;
    if (colorObj.argb) return colorObj.argb;
    if (colorObj.theme !== undefined) {
      const base = defaultThemeColors[colorObj.theme];
      if (!base) return null;
      // Aplicar tint si existe
      const tint = colorObj.tint ?? 0;
      if (tint === 0) return 'FF' + base;
      // Tint positivo = aclarar, negativo = oscurecer
      const r = parseInt(base.slice(0, 2), 16);
      const g = parseInt(base.slice(2, 4), 16);
      const b = parseInt(base.slice(4, 6), 16);
      let nr: number, ng: number, nb: number;
      if (tint > 0) {
        nr = Math.round(r + (255 - r) * tint);
        ng = Math.round(g + (255 - g) * tint);
        nb = Math.round(b + (255 - b) * tint);
      } else {
        const t = Math.abs(tint);
        nr = Math.round(r * (1 - t));
        ng = Math.round(g * (1 - t));
        nb = Math.round(b * (1 - t));
      }
      const hex = [nr, ng, nb].map(c => Math.min(255, Math.max(0, c)).toString(16).padStart(2, '0')).join('');
      return 'FF' + hex.toUpperCase();
    }
    return null;
  }

  // ── Detectar estilos de una celda ──
  function detectStyleInfo(cell: ExcelJS.Cell): Record<string, string> {
    const info: Record<string, string> = {};
    // Font color (ARGB o theme)
    const fontResolved = resolveThemeColor(cell.font?.color);
    // Ignorar negro (000000) y blanco (FFFFFF) en font — son "sin color especial"
    if (fontResolved && !fontResolved.endsWith('FFFFFF') && !fontResolved.endsWith('000000')) {
      info.fontColor = fontResolved;
    }
    // Fill colors (ARGB o theme)
    const fill = cell.fill as any;
    const fgResolved = resolveThemeColor(fill?.fgColor);
    // Ignorar blanco (FFFFFF) en fill — es "sin relleno"
    if (fgResolved && !fgResolved.endsWith('FFFFFF')) info.fillColor = fgResolved;
    const bgResolved = resolveThemeColor(fill?.bgColor);
    if (bgResolved && !bgResolved.endsWith('FFFFFF')) info.bgColor = bgResolved;
    return info;
  }

  // ── Mapear estilos a estado financiero y operativo ──
  function mapStyleToEstado(styleInfo: Record<string, string>): {
    estado_pago: string; estado_habitacion: string; detalles: string[];
  } {
    const fontColor = (styleInfo.fontColor ?? '').toUpperCase();
    const fillColor = (styleInfo.fillColor ?? '').toUpperCase();
    const bgColor = (styleInfo.bgColor ?? '').toUpperCase();

    let estado_pago = 'pagado'; // Negro por defecto = pagado (ingreso registrado)
    let estado_habitacion = 'ocupada';
    const detalles: string[] = [];

    // Extraer RGB sin alfa (ARGB → RGB de 6 dígitos)
    const fontRGB = fontColor.length >= 8 ? fontColor.slice(2) : fontColor;
    const fillRGB = fillColor.length >= 8 ? fillColor.slice(2) : fillColor;
    const bgRGB = bgColor.length >= 8 ? bgColor.slice(2) : bgColor;

    // Comparación exacta contra lista de colores conocidos
    const colorMatch = (rgb: string, ...targets: string[]) =>
      targets.some(t => rgb === t);

    // ── Clasificar colores individuales ──
    const isBlueFont = colorMatch(fontRGB, '0000FF', '0070C0', '4472C4', '00B0F0', '0070FF', '1F4E79', '5B9BD5');
    const isRedFont = colorMatch(fontRGB, 'FF0000', 'C00000', 'FF4040');

    const isYellowFill = colorMatch(fillRGB, 'FFFF00', 'FFF200', 'FFD966')
                      || colorMatch(bgRGB, 'FFFF00', 'FFF200', 'FFD966');
    const isGreenFill = colorMatch(fillRGB, '00FF00', '008000', '92D050', '00B050', '70AD47')
                     || colorMatch(bgRGB, '00FF00', '008000', '92D050', '00B050', '70AD47');
    const isRedFill = colorMatch(fillRGB, 'FF0000', 'C00000', 'FF4040')
                   || colorMatch(bgRGB, 'FF0000', 'C00000', 'FF4040');

    // Salmón / durazno (theme:5 + tint) = CRÉDITO
    // Colores resueltos de theme:5 (ED7D31) con tints: F4B183, F4B084, F2A46E, etc.
    const isSalmonFill = (() => {
      const checkSalmon = (rgb: string) => {
        if (!rgb || rgb === 'FFFFFF' || rgb === '000000') return false;
        const r = parseInt(rgb.slice(0, 2), 16);
        const g = parseInt(rgb.slice(2, 4), 16);
        const b = parseInt(rgb.slice(4, 6), 16);
        // Salmón/durazno: R alto (>200), G medio (100-200), B bajo-medio (50-160)
        return r > 200 && g >= 100 && g <= 200 && b >= 50 && b <= 160;
      };
      return checkSalmon(fillRGB) || checkSalmon(bgRGB);
    })();

    // Naranja puro / dorado = CAPITAL PENDIENTE (FFC000, FFA500, etc.)
    const isOrangeFill = colorMatch(fillRGB, 'FFA500', 'FF8C00', 'FFC000')
                      || colorMatch(bgRGB, 'FFA500', 'FF8C00', 'FFC000');

    // ══════════════════════════════════════════════════════
    // 1. Reglas de estado_habitacion (operativas) — prioridad alta
    // ══════════════════════════════════════════════════════

    // Relleno Verde + Rojo (fill O font) → Mantenimiento (fuera de servicio)
    if (isGreenFill && (isRedFill || isRedFont)) {
      estado_habitacion = 'mantenimiento';
      estado_pago = 'n/a';
      detalles.push('Fondo verde + rojo: habitación en mantenimiento');
    }
    // Relleno Rojo solo (sin verde) → No disponible
    else if (isRedFill && !isGreenFill) {
      estado_habitacion = 'no_disponible';
      estado_pago = 'n/a';
      detalles.push('Fondo rojo: no disponible');
    }
    // Relleno Verde solo → Reserva por confirmar
    else if (isGreenFill) {
      estado_habitacion = 'por_confirmar';
      detalles.push('Fondo verde: reserva por confirmar');
    }

    // ══════════════════════════════════════════════════════
    // 2. Reglas de estado_pago (financieras)
    //    Solo si la habitación no está en mantenimiento/no_disponible
    // ══════════════════════════════════════════════════════
    if (estado_pago !== 'n/a') {
      // Amarillo + texto rojo → Cortesía (precio forzado a 0)
      if (isYellowFill && isRedFont) {
        estado_pago = 'cortesia';
        detalles.push('Fondo amarillo + texto rojo: noche de cortesía');
      }
      // Relleno salmón/durazno → Crédito (cuentas por cobrar empresas)
      // Prioridad sobre deuda: una celda salmón con texto azul = crédito + deuda
      else if (isSalmonFill && isBlueFont) {
        estado_pago = 'credito';
        detalles.push('Fondo salmón + texto azul: crédito pendiente de cobro');
      }
      else if (isSalmonFill) {
        estado_pago = 'credito';
        detalles.push('Fondo salmón: venta al crédito');
      }
      // Texto azul (sin salmón) → Deuda pendiente
      else if (isBlueFont) {
        estado_pago = 'deuda';
        detalles.push('Texto azul: deuda pendiente');
      }
      // Relleno naranja/dorado → Capital pendiente
      else if (isOrangeFill) {
        estado_pago = 'capital_pendiente';
        detalles.push('Fondo naranja: capital pendiente');
      }
      // Amarillo solo → sin significado especial (queda como pagado)
      // Negro / sin color → pagado (default, ingreso registrado con monto)
    }

    return { estado_pago, estado_habitacion, detalles };
  }

  // ── Iterar TODAS las hojas del libro ──
  for (const sheet of workbook.worksheets) {
    // Saltar hojas de gráficos u hojas vacías
    if (!sheet || sheet.rowCount < 3) continue;
    // Saltar hojas con nombres tipo "Gráfico1", "Chart"
    if (/^(gr.fico|chart)/i.test(sheet.name)) continue;

    // Extraer texto robusto de celda (soporta richText, objetos, merged cells)
    const getCellText = (cell: ExcelJS.Cell): string => {
      const v = cell.value;
      if (v == null) return '';
      if (typeof v === 'string') return v.trim();
      if (typeof v === 'number') return String(v);
      if (typeof v === 'object' && 'richText' in (v as any)) {
        return ((v as any).richText as any[]).map((rt: any) => rt.text ?? '').join('').trim();
      }
      if (v instanceof Date) return '';
      return String(v).trim();
    };

    // Buscar nombre de mes en un texto
    const findMesInText = (text: string): string | null => {
      const upper = text.toUpperCase().replace(/[^A-ZÁÉÍÓÚÑ\s]/g, ' ');
      for (const mesName of Object.keys(MESES)) {
        if (upper.includes(mesName)) return mesName;
      }
      return null;
    };

    const findYear = (text: string): string | null => {
      const match = text.match(/\b(20\d{2})\b/);
      return match ? match[1] : null;
    };

    // ── Fase 1: Escanear TODA la hoja para encontrar secciones de mes ──
    // Cada sección empieza con una fila cuya columna A contiene un nombre de mes
    type MonthSection = {
      mesRaw: string;
      anoRaw: string;
      headerRow: number;     // fila del encabezado de mes
      habitacionMap: Record<number, string>;
      dataStartRow: number;  // primera fila de datos (headerRow + 2)
      dataEndRow: number;    // última fila de datos (se calcula después)
    };

    const sections: MonthSection[] = [];
    const totalRows = sheet.rowCount;

    for (let rowNum = 1; rowNum <= totalRows; rowNum++) {
      const row = sheet.getRow(rowNum);
      const cellA = getCellText(row.getCell(1));
      const mes = findMesInText(cellA);
      if (!mes) continue;

      // Verificar que la siguiente fila existe y tiene año o datos de habitación
      const nextRow = sheet.getRow(rowNum + 1);
      const cellA2 = getCellText(nextRow.getCell(1));

      // Extraer año
      const ano = findYear(cellA2) ?? findYear(cellA) ?? findYear(sheet.name) ?? String(new Date().getFullYear());

      // Mapear columnas a habitaciones desde esta fila de encabezado
      const habitacionMap: Record<number, string> = {};
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber >= 4) {
          const numHab = getCellText(cell);
          const nombreHab = getCellText(nextRow.getCell(colNumber));
          if (numHab || nombreHab) {
            habitacionMap[colNumber] = numHab || nombreHab || `HAB-${colNumber}`;
          }
        }
      });
      // Revisar fila 2 también para columnas que solo tienen nombre en la segunda fila
      nextRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        if (colNumber >= 4 && !habitacionMap[colNumber]) {
          const val = getCellText(cell);
          if (val) habitacionMap[colNumber] = val;
        }
      });

      if (Object.keys(habitacionMap).length === 0) continue;

      sections.push({
        mesRaw: mes,
        anoRaw: ano,
        headerRow: rowNum,
        habitacionMap,
        dataStartRow: rowNum + 2, // datos empiezan 2 filas después del encabezado
        dataEndRow: totalRows,    // se ajustará abajo
      });
    }

    // Ajustar dataEndRow de cada sección: termina donde empieza la siguiente
    for (let i = 0; i < sections.length - 1; i++) {
      sections[i].dataEndRow = sections[i + 1].headerRow - 1;
    }

    if (sections.length === 0) {
      continue;
    }

  // ── Tipo intermedio para filas diarias antes de consolidar ──
  type DailyRow = {
    empresa: string; huesped: string; cliente_o_empresa: string;
    descripcion: string; precio: number; celular: string; factura: string;
    tipo_estadia: 'noche' | 'horas' | 'otro';
    dia: number; mes: string; ano: string; habitacion: string;
    estado_pago: string; estado_habitacion: string; detalles: string[];
    styleInfo: Record<string, string>;
    texto_celda: string;
  };

  const dailyRows: DailyRow[] = [];

  // ── Recorrer cada sección de mes ──
  for (const section of sections) {
    const { mesRaw, anoRaw, habitacionMap, dataStartRow, dataEndRow } = section;

    for (let rowNumber = dataStartRow; rowNumber <= dataEndRow; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const diaRaw = row.getCell(1).value;
      const dia = Number(diaRaw) || 0;
      if (dia < 1 || dia > 31) continue; // No es una fila de día válido

      // Recorrer cada columna de habitación
      for (const [colStr, habName] of Object.entries(habitacionMap)) {
        const colNum = Number(colStr);
        const cell = row.getCell(colNum);
        const cellText = String(cell.value ?? '').trim();

        // Saltar celdas vacías, disponibles, solo puntuación, o solo "0"
        if (!cellText || /^\*?\s*DISPONIBLE/i.test(cellText) || /^\.+$/.test(cellText) || /^0+$/.test(cellText)) continue;

        // Detectar estilos
      const styleInfo = detectStyleInfo(cell);
      const { estado_pago, estado_habitacion, detalles } = mapStyleToEstado(styleInfo);

      // Cortesía: forzar precio a 0 (pero se registra el huésped para estadística)
      const esCortesia = estado_pago === 'cortesia';

      // Usar extract_from_cell para parsear el texto (misma lógica que CSV)
      const parsed = extract_from_cell(cellText);
      if (parsed) {
        dailyRows.push({
          ...parsed,
          precio: esCortesia ? 0 : parsed.precio,
          dia,
          mes: mesRaw,
          ano: anoRaw,
          habitacion: habName,
          estado_pago,
          estado_habitacion,
          detalles,
          styleInfo,
          texto_celda: cellText,
        });
      } else {
        // Si no es parseable como RESERVA, verificar si es una nota/evento que NO debe extraerse
        const _upCell = cellText.toUpperCase();
        const esNota = /^(PAGO\s+DE|CONCIERTO|EVENTO|DESCANSA|INICIO\s+DE\s+LABORES|NO\s+VENDER|CENA\s+|VENDRA|PROBLEMAS\s+EN)\b/i.test(_upCell);
        // Saltar notas/eventos que no son reservas reales
        if (esNota) continue;

        // Incluir como dato genérico
        dailyRows.push({
          empresa: 'N/A',
          huesped: 'N/A',
          cliente_o_empresa: cellText.toUpperCase(),
          descripcion: cleanDescripcion(cellText),
          precio: 0,
          celular: 'N/A',
          factura: 'N/A',
          tipo_estadia: 'noche' as const,
          dia,
          mes: mesRaw,
          ano: anoRaw,
          habitacion: habName,
          estado_pago,
          estado_habitacion,
          detalles,
          styleInfo,
          texto_celda: cellText,
        });
      }
    } // fin loop columnas habitación
    } // fin loop filas de un mes
  } // fin loop de secciones

  // ── Ordenar por mes → habitación → día ──
  dailyRows.sort((a, b) => {
    // Primero por mes/año
    const mesA = MESES[a.mes] ?? 0, mesB = MESES[b.mes] ?? 0;
    const anoA = Number(a.ano), anoB = Number(b.ano);
    if (anoA !== anoB) return anoA - anoB;
    if (mesA !== mesB) return mesA - mesB;
    const hA = parseInt(a.habitacion, 10), hB = parseInt(b.habitacion, 10);
    if (!isNaN(hA) && !isNaN(hB) && hA !== hB) return hA - hB;
    if (a.habitacion !== b.habitacion) return a.habitacion.localeCompare(b.habitacion);
    return a.dia - b.dia;
  });

  // ── Consolidar estancias contiguas (mismo cliente + misma hab + días consecutivos + mismo mes) ──
  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);

  function buildDateForRow(r: DailyRow, dia: number): Date {
    const mesNum = MESES[r.mes] ?? 1;
    const anoNum = Number(r.ano) || new Date().getFullYear();
    return new Date(anoNum, mesNum - 1, dia);
  }

  // Función para generar llave de identidad de un registro (incluye mes para no mezclar meses)
  function identityKey(r: DailyRow): string {
    const nombre = r.empresa !== 'N/A' ? `${r.empresa}/${r.huesped}` : r.cliente_o_empresa;
    return `${r.mes}||${r.ano}||${r.habitacion}||${nombre}||${r.estado_pago}`;
  }

  const consolidated: any[] = [];
  if (!dailyRows.length) {
    allConsolidated.push(...consolidated);
    continue;
  }

  let actual = { ...dailyRows[0] };
  let diaInicio = actual.dia;
  let diaAnterior = actual.dia;
  let noches = 1;
  let precioAcumulado = actual.precio;
  // Acumular detalles/estilos del grupo
  let allDetalles = [...actual.detalles];

  for (let i = 1; i < dailyRows.length; i++) {
    const s = dailyRows[i];
    const mismoCliente = identityKey(s) === identityKey(actual);
    const diasConsecutivos = s.dia === diaAnterior + 1;

    if (mismoCliente && diasConsecutivos) {
      noches++;
      precioAcumulado += s.precio;
      diaAnterior = s.dia;
      // Agregar detalles nuevos que no estén ya
      for (const d of s.detalles) {
        if (!allDetalles.includes(d)) allDetalles.push(d);
      }
      // Si algún día tiene celular/factura y el actual no, tomar el dato
      if (actual.celular === 'N/A' && s.celular !== 'N/A') actual.celular = s.celular;
      if (actual.factura === 'N/A' && s.factura !== 'N/A') actual.factura = s.factura;
    } else {
      // Guardar la reserva cerrada
      const checkIn = buildDateForRow(actual, diaInicio);
      const checkOut = buildDateForRow(actual, diaAnterior + 1);

      // Corregir estado_habitacion según fecha
      let estadoHab = actual.estado_habitacion;
      if (estadoHab === 'ocupada') {
        if (checkIn > hoy) estadoHab = 'reservada';
        else if (checkOut <= hoy) estadoHab = 'completada';
      }

      consolidated.push({
        empresa: actual.empresa,
        huesped: actual.huesped,
        cliente_o_empresa: actual.cliente_o_empresa,
        descripcion: actual.descripcion,
        precio: Math.round(precioAcumulado * 100) / 100,
        celular: actual.celular,
        factura: actual.factura,
        tipo_estadia: actual.tipo_estadia,
        habitacion: actual.habitacion,
        mes: actual.mes,
        ano: actual.ano,
        check_in: `${checkIn.getFullYear()}-${String(checkIn.getMonth() + 1).padStart(2, '0')}-${String(checkIn.getDate()).padStart(2, '0')}`,
        check_out: `${checkOut.getFullYear()}-${String(checkOut.getMonth() + 1).padStart(2, '0')}-${String(checkOut.getDate()).padStart(2, '0')}`,
        total_noches: noches,
        estado_pago: actual.estado_pago,
        estado_habitacion: estadoHab,
        detalles: allDetalles,
        styleInfo: actual.styleInfo,
        texto_celda: actual.texto_celda,
      });

      // Nueva estadía
      actual = { ...s };
      diaInicio = s.dia;
      diaAnterior = s.dia;
      noches = 1;
      precioAcumulado = s.precio;
      allDetalles = [...s.detalles];
    }
  }

  // Última reserva
  if (dailyRows.length > 0) {
  const checkIn = buildDateForRow(actual, diaInicio);
  const checkOut = buildDateForRow(actual, diaAnterior + 1);
  let estadoHab = actual.estado_habitacion;
  if (estadoHab === 'ocupada') {
    if (checkIn > hoy) estadoHab = 'reservada';
    else if (checkOut <= hoy) estadoHab = 'completada';
  }

  consolidated.push({
    empresa: actual.empresa,
    huesped: actual.huesped,
    cliente_o_empresa: actual.cliente_o_empresa,
    descripcion: actual.descripcion,
    precio: Math.round(precioAcumulado * 100) / 100,
    celular: actual.celular,
    factura: actual.factura,
    tipo_estadia: actual.tipo_estadia,
    habitacion: actual.habitacion,
    mes: actual.mes,
    ano: actual.ano,
    check_in: `${checkIn.getFullYear()}-${String(checkIn.getMonth() + 1).padStart(2, '0')}-${String(checkIn.getDate()).padStart(2, '0')}`,
    check_out: `${checkOut.getFullYear()}-${String(checkOut.getMonth() + 1).padStart(2, '0')}-${String(checkOut.getDate()).padStart(2, '0')}`,
    total_noches: noches,
    estado_pago: actual.estado_pago,
    estado_habitacion: estadoHab,
    detalles: allDetalles,
    styleInfo: actual.styleInfo,
    texto_celda: actual.texto_celda,
  });
  }

    // Agregar resultados de esta hoja al total
    allConsolidated.push(...consolidated);

  } // fin del loop de hojas

  console.log(`  📊 Extracción completada: ${allConsolidated.length} reservas de ${workbook.worksheets.length} hoja(s)`);

  return allConsolidated;
}
// backend/src/extractor.ts
import fs from 'fs';
import path from 'path';

// ─── Tipos ────────────────────────────────────────────────────────────────────
type RawReservation = {
  empresa: string;
  huesped: string;
  cliente_o_empresa: string;
  descripcion: string;
  precio: number;
  celular: string;
  factura: string;
  dia: number;
  mes: string;
  ano: string;
  habitacion: string;
  tipo_estadia: 'noche' | 'horas' | 'otro'; // ← nuevo campo
};

export type ConsolidatedReservation = RawReservation & {
  check_in: string;
  total_noches: number;
};

const MESES: Record<string, number> = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6,
  JULIO: 7, AGOSTO: 8, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
};

// Palabras que indican un área de eventos, no una habitación
const AREA_KEYWORDS = ['SALON', 'CAFETERIA', 'CAFETERÍA', 'AUDITORIO', 'EVENTO', 'CONFERENCIA'];

// ─── Utilidades ───────────────────────────────────────────────────────────────

function splitCsvLine(line: string, delimiter = ';') {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (ch === delimiter && !inQuotes) { result.push(cur); cur = ''; continue; }
    cur += ch;
  }
  result.push(cur);
  return result.map(c => c.trim());
}

/**
 * Parsea montos en Lempiras con manejo de los formatos del CSV:
 *   L,1.380.00  → 1380.00  (L con coma, puntos como miles y decimal)
 *   L.1,320.00  → 1320.00  (anglosajón: coma=miles, punto=decimal)
 *   L.1.320,00  → 1320.00  (europeo: punto=miles, coma=decimal)
 *   L.1320      → 1320.00  (sin decimales)
 *   $46.94      → 46.94    (USD)
 */
function parseHNL(raw: string): number {
  let s = raw.trim()
    .replace(/^(?:Lps\.?|HNL|L[.,\s]?|\$)\s*/i, '') // quitar prefijo moneda
    .replace(/\s/g, '')
    .trim();

  if (!s) return 0;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;

  if (dots >= 2) {
    // "1.380.00" → múltiples puntos → todos son miles excepto el último
    const last = s.lastIndexOf('.');
    s = s.slice(0, last).replace(/\./g, '') + '.' + s.slice(last + 1);
  } else if (commas >= 2) {
    // "1,380,00" → múltiples comas → todas son miles excepto la última
    const last = s.lastIndexOf(',');
    s = s.slice(0, last).replace(/,/g, '') + '.' + s.slice(last + 1);
  } else if (dots === 1 && commas === 1) {
    const di = s.indexOf('.');
    const ci = s.indexOf(',');
    if (ci < di) {
      // "1,320.00" → coma=miles, punto=decimal
      s = s.replace(',', '');
    } else {
      // "1.320,00" → punto=miles, coma=decimal
      s = s.replace('.', '').replace(',', '.');
    }
  } else if (commas === 1) {
    const afterComma = s.split(',')[1] ?? '';
    // Si después de la coma vienen exactamente 3 dígitos → es miles
    s = afterComma.length === 3 ? s.replace(',', '') : s.replace(',', '.');
  } else if (dots === 1) {
    const afterDot = s.split('.')[1] ?? '';
    // Si después del punto vienen exactamente 3 dígitos → es miles
    if (afterDot.length === 3) s = s.replace('.', '');
  }

  s = s.replace(/[^\d.]/g, '');
  const n = Number(s);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}


function detectTipoEstadia(text: string): 'noche' | 'horas' | 'otro' {
  const up = text.toUpperCase();
  if (/\d+\s*HORAS?/i.test(up) || /MEDIA\s+HORA/i.test(up) || /POR\s+HORAS/i.test(up)) return 'horas';
  if (/NOCHE/i.test(up)) return 'noche';
  return 'otro';
}

/**
 * Limpieza final de la descripción:
 * - Elimina fragmentos residuales de CEL: sin número
 * - Elimina números de precio residuales
 * - Capitaliza y trunca a 300 chars
 */
/**
 * Limpieza final de la descripción:
 * - Elimina fragmentos residuales de CEL: sin número
 * - Elimina precios residuales tipo ".00" o ". 00" o "L.0"
 * - Capitaliza y trunca a 300 chars
 */
function cleanDescripcion(text: string): string {
  let t = text;
  // Eliminar "CEL:" o "CEL :" que quedaron sin número
  t = t.replace(/CEL\.?\s*:?\s*(?=$|\s|[^0-9+])/gi, '').trim();
  // Eliminar ".00", ". 00", ".0" residuales al final o flotantes
  t = t.replace(/\s*\.\s*0{1,2}\s*$/g, '').trim();
  t = t.replace(/(?<![\d])\.\s*0{1,2}(?![\d])/g, '').trim();
  // Eliminar "TEL" o "TEL:" residual sin número
  t = t.replace(/\bTEL\.?\s*:?\s*$/gi, '').trim();
  // Eliminar punto final suelto
  t = t.replace(/^\s*\.\s*/, '').replace(/\s*\.\s*$/, '').trim();
  // Limpiar espacios dobles
  t = t.replace(/\s{2,}/g, ' ').trim();
  // Capitalizar primera letra
  if (t.length > 0) t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  // Truncar
  if (t.length > 300) t = t.slice(0, 297) + '…';
  return t || 'N/A';
}

// ─── Extracción de celda ──────────────────────────────────────────────────────

function extract_from_cell(text?: string): Omit<RawReservation, 'dia' | 'mes' | 'ano' | 'habitacion'> | null {
  if (!text) return null;
  let raw = String(text).trim();
  if (/DISPONIBLE/i.test(raw)) return null;

  // Normalizar patrones fusionados antes de procesar
  raw = raw.replace(/\bAL\./gi, 'A L.');
  raw = raw.replace(/NOCHE(L[.,])/gi, 'NOCHE $1');
  raw = raw.replace(/NOCHEA\b/gi, 'NOCHE A');
  // Normalizar "$." → "$" (Airbnb/Expedia usan "$. 52.68" o "$.53.35")
  raw = raw.replace(/\$\s*\.\s*/g, '$ ');
  // Normalizar "L. I380" → "L. 1380" (typo I=1 en Excel)
  raw = raw.replace(/(L\.\s*)I(\d{3})/gi, '$11$2');

  const _up = raw.toUpperCase();

  // Detectar prefijo tipo RESERVA (incluyendo variantes de typo del Excel)
  // Variantes conocidas: REERVA, RESEDERVA, RESERAV, REERERVA, RESE4RVA, RESRVA, RESERSA, RESERCA
  const _prefixMatch = raw.match(/^(RESERVA-?\s*|RE[A-Z0-9]{2,7}(?:VA|AV|SA|CA))\s+/i);
  // Si no hay prefijo RESERVA-like, aceptar solo si tiene patrones claros de reserva
  if (!_prefixMatch && !/\b(?:\d+\s*HABI|UNA\s+HABI|HABI\w*(?:ION|IOB|ON)\s+POR)\b/i.test(_up)) return null;

  // ── Tipo de estadía ──
  const tipo_estadia = detectTipoEstadia(raw);

  // ── Precio ──
  // Lookbehind (?<![A-Za-z]) evita capturar L de palabras como SANDOVAL.
  // L\s*[.,]?\s* cubre: "L.1320", "L,1380", "L .1217", "L. 1320"
  // Se excluyen patrones de hora: dígitos seguidos de PM/AM o ":XX"
  let precio = 0;

  // Primero quitar horarios del texto para que no interfieran (ej: "4.40PM", "4:40")
  const rawSinHorario = raw.replace(/\b\d{1,2}[:.]\d{2}\s*(?:PM|AM|pm|am)\b/g, '');

  const matchPrecio = rawSinHorario.match(/(?<![A-Za-z])(?:Lps\.?|L\s*[.,:]?\s*|HNL|\$)\s*(\d[\d,.]*\d|\d)/i);
  if (matchPrecio) {
    precio = parseHNL(matchPrecio[1]);
  } else {
    // Fallback 1: "A NUMBER" con posible separador de miles (ej: "A 1,380.00", "A 1,861.")
    const matchNumSuelto = rawSinHorario.match(/\bA\s+\.?([1-9][\d,.]+\d)\b(?!\s*(?:HORA|MIN|NOC|DIA|HAB))/i);
    if (matchNumSuelto) {
      precio = parseHNL(matchNumSuelto[1]);
    } else {
      // Fallback 2: "NUMBER DOLARES" o "HORA NUMBER" (ej: "68 DOLARES", "HORA 400.00")
      const matchDolares = rawSinHorario.match(/\b(\d[\d,.]*\d|\d+)\s*(?:DOLARES|DOLAR|USD)\b/i);
      if (matchDolares) {
        precio = parseHNL(matchDolares[1]);
      } else {
        // Fallback 3: número suelto después de HORA/NOCHE (ej: "HORA 400.00")
        const matchBare = rawSinHorario.match(/(?:HORA|NOCHE)\s+([1-9]\d{2,}(?:[.,]\d{2})?)\b/i);
        if (matchBare) precio = parseHNL(matchBare[1]);
      }
    }
  }


  // ── Celular ──
  let celular = 'N/A';
  // Primero buscar después de CEL: (con o sin número)
  const matchCelKey = raw.match(/CEL\.?\s*:?\s*(\+?\d[\d\s\-]{6,14}\d)/i);
  if (matchCelKey) {
    celular = matchCelKey[1].replace(/\s/g, '').trim();
  } else {
    // Buscar cualquier número de teléfono (8+ dígitos)
    const matchCel = raw.match(/\b(\+?[23456789]\d{7,13})\b/);
    if (matchCel) celular = matchCel[1].trim();
  }

  // ── Factura ──
  let factura = 'N/A';
  // Patrón: FACTURA #12345 o FACT.17150 o #17150 solos
  const matchFactura = raw.match(/(?:FACTURA|FACTS?\.?)\s*#?\s*0*(\d{4,})/i);
  if (matchFactura) {
    factura = `FACTURA #${matchFactura[1]}`;
  } else {
    // Número suelto de factura: #017201 o # 17119
    const matchHash = raw.match(/#\s*0*(\d{4,})/);
    if (matchHash) factura = `FACTURA #${matchHash[1]}`;
  }

  // ── Separar nombres de la descripción ──
  // Eliminar prefijo RESERVA (o variante de typo) del inicio
  let resto = _prefixMatch ? raw.slice(_prefixMatch[0].length).trim() : raw.trim();
  // Eliminar RESERVA duplicado (ej: "RESERVA RESERVA GABRIEL LEIVA")
  resto = resto.replace(/^RESERVA[-\s]+/i, '').trim();

  // Corte donde empieza la descripción de la estadía
  // Soporta typos comunes del Excel: HAITACION, HABITACIOB, HABOTACION, ABITACION, 1HABITACION, etc.
  const corteRegex = /(?:UNA\s+HA\w{3,}|TRIPLE|DOBLE|\d*\s*HA\w*(?:CION|CIOB|CIO)\b|\d*\s*HABI\w+|\d*\s*ABITACI\w*|\d+\s*NOCHE|POR\s+(?:UNA\s+)?(?:NOCHE|DIA|\d+\s*HORA|MEDIA\s+HORA)|PAGANDO|\bYA\s+PAGO\b|\bA\s+(?:L\.?|Lps|\$)|CORTESIA|SALON\s+|CAFETER)/i;
  let parteName = resto;
  let parteDesc = 'N/A';

  const corteMatch = resto.match(corteRegex);
  if (corteMatch && (corteMatch.index ?? 0) > 0) {
    parteName = resto.slice(0, corteMatch.index).trim();
    parteDesc = resto.slice(corteMatch.index).trim();
  }

  // Quitar número suelto al final del nombre (ej. "MARLON SANDOVAL 1" → "MARLON SANDOVAL")
  // También cubre "-1" residual de textos como "Skarleth Mejía -1 HABITACION"
  parteName = parteName.replace(/\s+[-]?\d+\s*$/, '').trim();

  // Quitar precio embebido al final del nombre (ej. "GUILLERMO FLORES 1470.02")
  const _trailingPrice = parteName.match(/\s+(\d[\d,.]+)\s*$/);
  if (_trailingPrice) {
    const _tp = parseHNL(_trailingPrice[1]);
    if (_tp >= 100) {
      if (precio === 0) precio = _tp;
      parteName = parteName.slice(0, _trailingPrice.index).trim();
    }
  }

  // Quitar precio con símbolo de moneda al final (ej. "PAGO DE ALQUILER L. 1,000.00.")
  parteName = parteName.replace(/\s+(?:L[\s.,]*|Lps\.?\s*|\$\s*)\d[\d,.]*\.?\s*$/i, '').trim();

  // Quitar "L." o "L" suelto al final sin dígitos (ej. "CINTHIA BERTRAND L.")
  parteName = parteName.replace(/\s+L\.?\s*$/i, '').trim();

  // Quitar guión o "CEL." residual al final del nombre
  parteName = parteName.replace(/\s+[-]+\s*$/, '').trim();
  parteName = parteName.replace(/\s+CEL\.?\s*$/i, '').trim();

  // Quitar descripciones de horario (ej. "4 A 8 DE LA NOCHE")
  parteName = parteName.replace(/\s+\d+\s+A\s+\d+\s+DE\s+.*$/i, '').trim();

  // Si el "nombre" es solo un número, es cantidad de habitaciones, no un nombre
  if (/^\d+$/.test(parteName)) parteName = '';

  // Si el nombre empieza con número + HABI/NOCHE, no hay nombre real (ej: "1 HABITACION POR 1NOCHE...")
  if (/^\d+\s*(?:HA\w*|NOCHE|POR\b)/i.test(parteName)) parteName = '';

  // Limpiar la descripción: quitar precio, celular, factura ya extraídos
  if (parteDesc !== 'N/A') {
    // Quitar el bloque "A L. 1,320.00" o "A L,1.380.00" completo
    parteDesc = parteDesc.replace(/A\s+(?:Lps\.?|L[.,]?\s*|HNL|\$)\s*[\d][\d,. ]*/gi, '');
    // Quitar precio suelto que quedó sin el "A"
    parteDesc = parteDesc.replace(/(?<![A-Za-z])(?:Lps\.?|L[.,]\s*|L\.\s*|HNL|\$)\s*[\d][\d,.]*/gi, '');
    if (celular !== 'N/A') parteDesc = parteDesc.replace(celular, '');
    // Eliminar factura y hash
    parteDesc = parteDesc.replace(/(?:FACTURA|FACTS?\.?)\s*#?\s*\d+/gi, '');
    parteDesc = parteDesc.replace(/#\s*\d+/gi, '');
    // Eliminar CEL: residual
    parteDesc = parteDesc.replace(/CEL\.?\s*:?\s*(\+?\d[\d\s\-]*\d)?/gi, '');
    parteDesc = parteDesc.replace(/\s{2,}/g, ' ').trim();
    parteDesc = cleanDescripcion(parteDesc);
  }

  // ── Nombre: empresa / huésped ──
  let empresa = 'N/A';
  let huesped = 'N/A';
  let cliente_o_empresa = 'N/A';

  const nombreUp = parteName.trim().toUpperCase();

  // Si el nombre contiene palabras de área de eventos, no es un huésped
  const esArea = AREA_KEYWORDS.some(kw => nombreUp.includes(kw));

  if (parteName.includes('/') && !esArea) {
    const partes = parteName.split('/').map(p => p.trim().toUpperCase()).filter(p => p);
    if (partes.length >= 2) {
      empresa = partes[0];
      huesped = partes.slice(1).join(' / ');
      cliente_o_empresa = 'N/A';
    } else {
      cliente_o_empresa = partes[0] || nombreUp || 'N/A';
    }
  } else {
    cliente_o_empresa = nombreUp || 'N/A';
  }

  return { empresa, huesped, cliente_o_empresa, descripcion: parteDesc, precio, celular, factura, tipo_estadia };
}

// ─── Función principal exportada ──────────────────────────────────────────────

export function extractReservationsFromCsv(content: string): ConsolidatedReservation[] {
  const normalized = content.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');

  let mesActual = 'ENERO';
  let anoActual = '2025';
  let mapaHabitaciones: Record<number, string> = {};
  const rawReservations: RawReservation[] = [];
  const MONTHS_KEYS = Object.keys(MESES);

  for (const line of lines) {
    const cols = splitCsvLine(line, ';');
    if (!cols.length || !cols[0]) continue;
    const col0 = cols[0].trim().toUpperCase();

    // Fila con TURNOS: también puede contener el mes en col0 o en las celdas
    if (line.toUpperCase().includes('TURNOS')) {
      // Actualizar mes/año si vienen en esta misma fila
      if (MESES[col0]) mesActual = col0;
      if (/^20\d{2}$/.test(col0)) anoActual = col0;
      for (const cell of cols) {
        const v = cell.trim().toUpperCase();
        if (MESES[v]) mesActual = v;
        if (/^20\d{2}$/.test(v)) anoActual = v;
      }
      // Mapear SOLO los números que son habitaciones (no años)
      mapaHabitaciones = {};
      cols.forEach((val, idx) => {
        const v = val.trim();
        if (/^\d+$/.test(v) && Number(v) < 1000) {
          mapaHabitaciones[idx] = v;
        }
      });
      continue;
    }

    // Cambio de mes/año en filas independientes
    if (MESES[col0]) { mesActual = col0; continue; }
    if (/^20\d{2}$/.test(col0)) { anoActual = col0; continue; }

    // Fila de día
    if (/^\d+$/.test(col0)) {
      const dia = Number(col0);
      for (const [idxStr, hab] of Object.entries(mapaHabitaciones)) {
        const celda = cols[Number(idxStr)];
        const datos = extract_from_cell(celda);
        if (datos) {
          rawReservations.push({ ...datos, dia, mes: mesActual, ano: anoActual, habitacion: hab });
        }
      }
    }
  }

  // ── Ordenar: habitación numérica → año → mes → día ──
  rawReservations.sort((a, b) => {
    const hA = parseInt(a.habitacion, 10), hB = parseInt(b.habitacion, 10);
    if (!isNaN(hA) && !isNaN(hB) && hA !== hB) return hA - hB;
    if (a.ano !== b.ano) return Number(a.ano) - Number(b.ano);
    if (a.mes !== b.mes) return MONTHS_KEYS.indexOf(a.mes) - MONTHS_KEYS.indexOf(b.mes);
    return a.dia - b.dia;
  });

  // ── Consolidar estancias contiguas (mismo cliente, misma hab, días consecutivos) ──
  const consolidadas: ConsolidatedReservation[] = [];
  if (!rawReservations.length) return consolidadas;

  let actual: any = { ...rawReservations[0] };
  let diaInicio = actual.dia;
  let diaAnterior = actual.dia;
  let noches = 1;
  // precio acumulado por estadía
  let precioAcumulado = actual.precio;

  for (let i = 1; i < rawReservations.length; i++) {
    const s = rawReservations[i];
    const fechaA = new Date(Number(actual.ano), MESES[actual.mes] - 1, diaAnterior);
    const fechaS = new Date(Number(s.ano), MESES[s.mes] - 1, s.dia);
    const diffDays = Math.round((fechaS.getTime() - fechaA.getTime()) / 86_400_000);

    const mismoCliente =
      s.habitacion === actual.habitacion &&
      s.cliente_o_empresa === actual.cliente_o_empresa &&
      s.empresa === actual.empresa &&
      s.huesped === actual.huesped;

    if (mismoCliente && diffDays === 1) {
      noches++;
      precioAcumulado += s.precio;
      diaAnterior = s.dia;
      // Conservar mes/año del último día para calcular el check_out bien
      actual.mes = s.mes;
      actual.ano = s.ano;
    } else {
      // Guardar la reserva cerrada
      consolidadas.push({
        ...actual,
        check_in: `${diaInicio}/${rawReservations[i - noches].mes}/${rawReservations[i - noches].ano}`,
        total_noches: noches,
        precio: Math.round(precioAcumulado * 100) / 100,
      } as ConsolidatedReservation);

      // Nueva estadía
      actual = { ...s };
      diaInicio = s.dia;
      diaAnterior = s.dia;
      noches = 1;
      precioAcumulado = s.precio;
    }
  }

  // Última reserva
  consolidadas.push({
    ...actual,
    check_in: `${diaInicio}/${rawReservations[rawReservations.length - noches].mes}/${rawReservations[rawReservations.length - noches].ano}`,
    total_noches: noches,
    precio: Math.round(precioAcumulado * 100) / 100,
  } as ConsolidatedReservation);

  return consolidadas;
}

// Alias para compatibilidad
export const processHotelCsv = extractReservationsFromCsv;

// ─── Reporte de texto ─────────────────────────────────────────────────────────
export function writeTextReport(outPath: string, consolidated: ConsolidatedReservation[]) {
  const lines: string[] = ['=== REPORTE CONSOLIDADO (GENERADO POR API) ===', ''];
  for (const r of consolidated) {
    lines.push(`-> Check-In: ${r.check_in}`);
    if (r.cliente_o_empresa && r.cliente_o_empresa !== 'N/A') lines.push(`-> Nombre: ${r.cliente_o_empresa}`);
    else { lines.push(`-> Empresa: ${r.empresa}`); lines.push(`-> Huésped: ${r.huesped}`); }
    lines.push(`-> Habitación: ${r.habitacion}`);
    lines.push(`-> Tipo: ${r.tipo_estadia}`);
    lines.push(`-> Descripción: ${r.descripcion}`);
    lines.push(`-> Estancia: ${r.total_noches} Noche(s)`);
    lines.push(`-> Factura: ${r.factura}`);
    lines.push(`-> Precio Total: L.${r.precio.toFixed(2)}`);
    lines.push(`-> Celular: ${r.celular}`);
    lines.push('-'.repeat(40), '');
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'), { encoding: 'utf-8' });
}