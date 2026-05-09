# Etapa 1: instalar dependencias nativas de forma limpia y verificable
FROM node:20-bookworm-slim AS deps
WORKDIR /usr/src/app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Se copia primero package.json/lock para aprovechar cache de Docker.
COPY package.json package-lock.json* ./

# Forzamos registry público y validamos que express/sqlite3 realmente existan.
# Esto evita imágenes construidas con node_modules incompletos o cache corrupta.
RUN set -eux; \
  npm config set registry https://registry.npmjs.org/; \
  npm cache clean --force; \
  if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi; \
  test -f node_modules/express/index.js; \
  test -f node_modules/sqlite3/lib/sqlite3.js

# Etapa 2: imagen final ligera para VPS
FROM node:20-bookworm-slim
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY server.js ./
COPY public ./public

RUN mkdir -p Data \
  && chown -R node:node /usr/src/app

USER node
EXPOSE 3000
CMD ["npm", "start"]
