# =====================================================================
# Máquina de Vendas — imagem Docker (frontend compilado + backend + Chromium)
# Não precisa editar. Use com o docker-compose.yml.
# =====================================================================

# ---------- 1) Compila o frontend ----------
FROM node:20-bookworm-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# IMPORTANTE: sem frontend/.env, o site usa o próprio endereço de onde for aberto.
RUN rm -f .env && npm run build

# ---------- 2) Sistema final ----------
FROM node:20-bookworm-slim

# Chromium do próprio Debian (funciona em servidores Intel/AMD e ARM) + utilitários:
#  - procps: o sistema usa "pkill" para limpar navegadores órfãos do WhatsApp
#  - tini:   encerra corretamente os processos filhos (evita navegadores "zumbis")
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium procps tini openssl ca-certificates fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/prisma ./prisma
RUN npx prisma generate
COPY backend/ ./
COPY --from=frontend /app/frontend/dist /app/frontend/dist

EXPOSE 3333
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
