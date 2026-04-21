# Backend multi-stage Dockerfile
FROM node:18-alpine AS builder
WORKDIR /app

# Install deps (including dev deps for tsc)
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy sources and build
COPY . .
RUN npm run build

FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Copy build output and production deps
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

EXPOSE 4000
CMD ["node", "dist/server.js"]
