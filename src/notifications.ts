import nodemailer from 'nodemailer';
import { pool } from './db.js';

type ReservationNotifyOpts = {
  reservationId: string;
  guestName: string;
  guestEmail?: string | null;
  guestPhone?: string | null;
  hotelId?: string | null;
  nights?: number;
  totalHNL?: number;
  totalUSD?: number;
  habitacionId?: string | null;
};

async function insertAudit(action: string, description: string, reservationId?: string | null) {
  try {
    await pool.query(
      `INSERT INTO public.bitacora_actividad (tipo, accion, descripcion, entidad_id) VALUES ($1, $2, $3, $4)`,
      ['reserva', action, description, reservationId ?? null]
    );
  } catch (err) {
    console.warn('[Notify] Could not write audit log:', err);
  }
}

export async function notifyReservationAdmin(opts: ReservationNotifyOpts) {
  const { reservationId, guestName, guestEmail, guestPhone, hotelId, nights, totalHNL, totalUSD } = opts;

  // Obtener contacto del hotel
  let hotelContact: { correo_contacto?: string | null; telefono?: string | null; nombre_hotel?: string | null } = {};
  if (hotelId) {
    try {
      const r = await pool.query('select correo_contacto, telefono, nombre_hotel from public.hoteles where id_hotel = $1 limit 1', [hotelId]);
      hotelContact = r.rows[0] ?? {};
    } catch (err) {
      console.warn('[Notify] Could not load hotel contact:', err);
    }
  }

  const subject = `Nueva solicitud de reserva${hotelContact.nombre_hotel ? ' · ' + hotelContact.nombre_hotel : ''}`;
  const bodyText = [
    `Reserva ID: ${reservationId}`,
    `Huésped: ${guestName}`,
    `Email: ${guestEmail ?? '—'}`,
    `Tel: ${guestPhone ?? '—'}`,
    `Noches: ${nights ?? '—'}`,
    `Total HNL: ${totalHNL ?? '—'}`,
    `Total USD: ${totalUSD ?? '—'}`,
  ].join('\n');

  // EMAIL
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = Number(process.env.SMTP_PORT ?? 587);
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM ?? 'no-reply@hotel-verona.local';

  const recipients: string[] = [];
  if (hotelContact.correo_contacto) recipients.push(hotelContact.correo_contacto);
  if (process.env.ADMIN_NOTIFICATION_EMAIL) recipients.push(process.env.ADMIN_NOTIFICATION_EMAIL);

  if (smtpHost && recipients.length > 0) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
        auth: smtpUser && smtpPass ? { user: smtpUser, pass: smtpPass } : undefined,
      });

      await transporter.sendMail({
        from: smtpFrom,
        to: recipients.join(','),
        subject,
        text: bodyText,
        html: `<pre style="font-family:monospace">${bodyText}</pre>`,
      });
      await insertAudit('email_notificacion', `Email notificación enviado a ${recipients.join(', ')}`, reservationId);
    } catch (err) {
      console.warn('[Notify] Error sending email:', err);
    }
  } else {
    console.log('[Notify] SMTP no configurado o sin destinatarios, omitiendo envío de email.');
  }

  // WHATSAPP
  const waUrl = process.env.WHATSAPP_API_URL;
  const waToken = process.env.WHATSAPP_API_TOKEN;
  const waRecipients: string[] = [];
  if (hotelContact.telefono) waRecipients.push(hotelContact.telefono);
  if (process.env.ADMIN_WHATSAPP_NUMBER) waRecipients.push(process.env.ADMIN_WHATSAPP_NUMBER);

  if (waUrl && waToken && waRecipients.length > 0) {
    for (const phoneRaw of waRecipients) {
      const phone = phoneRaw.replace(/[^0-9]/g, '');
      try {
        const res = await fetch(waUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${waToken}` },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: bodyText } }),
        });
        if (!res.ok) {
          const errB = await res.text();
          console.warn('[Notify] WhatsApp API error:', errB);
        } else {
          await insertAudit('whatsapp_notificacion', `WhatsApp enviado a ${phone}`, reservationId);
        }
      } catch (err) {
        console.warn('[Notify] Error sending WhatsApp:', err);
      }
    }
  } else {
    console.log('[Notify] WhatsApp no configurado o sin destinatarios, omitiendo envío de WA.');
  }
}

export default { notifyReservationAdmin };
