# Etapa 1: instalar dependencias nativas sin dejar herramientas de compilación en runtime
FROM node:20-bookworm-slim AS deps
WORKDIR /usr/src/app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Etapa 2: imagen final ligera para VPS
FROM node:20-bookworm-slim
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY package*.json ./
COPY server.js ./
COPY public ./public
RUN mkdir -p Data \
  && chown -R node:node /usr/src/app
USER node
EXPOSE 3000
CMD ["npm", "start"]
