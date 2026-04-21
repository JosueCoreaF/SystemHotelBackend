# SystemHotelBackend

API REST y WebSocket del sistema Hotel Verona. Proporciona endpoints para reservas, habitaciones, pagos, usuarios y la lógica del chat en tiempo real.

Stack
- Node.js (v18+) + TypeScript
- Express 5
- Socket.IO (servidor)
- PostgreSQL (`pg`)
- PM2 para procesos en producción

Requisitos
- Node.js 18+
- PostgreSQL o URL de base de datos (p. ej. Supabase)

Inicio rápido (desarrollo)
```bash
cd SystemHotelBackend
cp .env.example .env
# Edita .env: DATABASE_URL, API_PORT, CORS_ORIGIN, SMTP_*, JWT_SECRET, (otros según tu entorno)
npm install
npm run dev
```

Comandos principales
- `npm run dev` — servidor de desarrollo (watch / tsx)
- `npm run build` — compilar TypeScript a `dist/`
- `npm start` — iniciar servidor compilado
- `npm run type-check` — comprobación de tipos TS
- `npm run pm2:start` — iniciar en PM2 (configurado en scripts)
- `npm run pm2:restart` — reiniciar PM2
- `npm run db:init` / `npm run db:migrate` — scripts de inicialización/migración

Estructura principal
```
backend/src/
├── scripts/             # Scripts de administración (init_hotel_config, migrate_config...)
├── app.ts               # Express app + registro de rutas
├── chatRoutes.ts        # Rutas + lógica relacionada con chat y WebSocket
├── db.ts                # Conexión a PostgreSQL
├── extractor.ts
├── importer.ts
├── notifications.ts
├── permissions.ts       # Middlewares de permisos
└── server.ts            # Entry point + Socket.IO boot

sql/                    # Esquemas y scripts SQL (schema_hotel_fresh.sql, etc.)
docs/                   # Documentación de modelos
```

Variables de entorno clave
- `DATABASE_URL` — conexión a la DB (Postgres)
- `API_PORT` — puerto del servidor (ej. 4000)
- `CORS_ORIGIN` — URL del frontend permitida en CORS
- `SMTP_HOST/SMTP_USER/SMTP_PASS` — para envío de emails
- `JWT_SECRET` — secreto para tokens JWT (si aplica)
- `SUPABASE_SERVICE_ROLE_KEY` — clave de servicio (solo servidor)

Endpoints y notas relevantes
- `DELETE /api/chat/channels/:channelId` — elimina un canal de chat (borra mensajes/lecturas y emite evento `channel_deleted`).
- La inicialización de sockets y eventos está en `backend/src/server.ts` y `backend/src/chatRoutes.ts`.

Despliegue (producción)
```bash
cd SystemHotelBackend
npm run build
npm run pm2:start
pm2 logs verona-server --lines 200
```

Seguridad
- Nunca subir claves de servicio (`SUPABASE_SERVICE_ROLE_KEY`, claves SMTP, `JWT_SECRET`) al repositorio.

Para detalles de modelos y esquema revisa `sql/schema_hotel_fresh.sql` y `docs/hotel-verona-models.md`.

## Docker (opcional)

Este backend puede ejecutarse dentro de un contenedor Node.js usando el `Dockerfile` incluido.

Desde la raíz del monorepo:

```bash
docker compose build
docker compose up -d
```

El servicio `backend` del `docker-compose.yml` expone el puerto `4000`. Para desarrollo local opcionalmente se incluye un servicio `db` (Postgres) en el `docker-compose.yml`.

Instalación de Docker Desktop (Windows): https://docs.docker.com/desktop/windows/install/  
Comprueba que Docker está disponible con `docker --version` antes de ejecutar los comandos anteriores.
