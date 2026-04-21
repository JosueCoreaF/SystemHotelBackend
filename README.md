# SystemHotelBackend

API REST + WebSocket del sistema de gestión hotelera **Hotel Verona**.

## Stack

- Node.js + Express 5 + TypeScript
- Socket.IO (chat en tiempo real)
- PostgreSQL (`pg`)
- Nodemailer (notificaciones email)
- PM2 (proceso en producción)

## Setup

```bash
cp .env.example .env
# Edita .env con tus credenciales de DB, SMTP, etc.
npm install
npm run dev
```

## Scripts

| Comando | Descripción |
|---|---|
| `npm run dev` | Servidor en modo watch (tsx) |
| `npm run build` | Compilar TypeScript a `dist/` |
| `npm start` | Iniciar servidor compilado |
| `npm run type-check` | Verificar tipos TS |
| `npm run pm2:start` | Iniciar con PM2 |
| `npm run pm2:restart` | Reiniciar PM2 |
| `npm run db:init` | Inicializar configuración del hotel |
| `npm run db:migrate` | Migrar configuración |

## Estructura

```
src/
├── scripts/             # Scripts de administración de base de datos
│   ├── init_hotel_config.ts
│   ├── migrate_config.ts
│   └── normalize_dates.ts
├── app.ts               # Express app + rutas REST
├── chatRoutes.ts        # Rutas de chat + Socket.IO
├── db.ts                # Conexión a PostgreSQL
├── extractor.ts         # Lógica de extracción de datos
├── extractorRoutes.ts   # Rutas del extractor
├── http.ts              # Cliente HTTP utilitario
├── importer.ts          # Importador de datos
├── notifications.ts     # Notificaciones email + WhatsApp
├── permissions.ts       # Middleware de permisos
└── server.ts            # Entry point: boot + Socket.IO + PM2
sql/
├── schema.sql           # Esquema principal
├── schema_hotel_fresh.sql
├── automation_logging.sql
├── storage_media_bucket.sql
├── super_admin_access.sql
└── restrict_access_roles_admin_only.sql
docs/
└── hotel-verona-models.md
```

## CORS

Configura `CORS_ORIGIN` en `.env` con la URL del frontend desplegado.  
En desarrollo: `http://localhost:5173`.

## PM2 (producción)

```bash
npm run build
npm run pm2:start
```
