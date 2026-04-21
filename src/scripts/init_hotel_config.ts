import { pool } from '../db.js';

async function init() {
  console.log('--- Inicializando tabla configuracion_hotelera ---');
  try {
    await pool.query(`
      INSERT INTO public.configuracion_hotelera (
        id_config, 
        hora_check_in, 
        hora_check_out, 
        moneda, 
        porcentaje_impuesto, 
        permite_sobreventa
      )
      VALUES ('default', '15:00', '12:00', 'USD', 0, false)
      ON CONFLICT (id_config) DO NOTHING;
    `);
    console.log('✅ configuracion_hotelera inicializada con éxito.');
  } catch (err) {
    console.error('❌ Error inicializando configuración:', err);
  } finally {
    await pool.end();
  }
}

init();
