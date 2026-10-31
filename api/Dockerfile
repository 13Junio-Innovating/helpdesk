# syntax=docker/dockerfile:1
# API e worker (mesma imagem; o worker roda com `node dist/worker/main.js`).
# Build a partir da RAIZ do monorepo: docker build -f api/Dockerfile .
FROM node:22.22-alpine AS build
WORKDIR /app
# Atrás de proxy corporativo com TLS interceptado: --secret id=npm_ca,src=ca.crt (não fica na imagem)
ENV NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca
RUN --mount=type=secret,id=npm_ca,required=false npm install -g npm@11.21.1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN --mount=type=secret,id=npm_ca,required=false npm ci -w shared -w api
COPY shared shared
COPY api api
RUN npm run build -w shared && npm run build -w api

FROM node:22.22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN --mount=type=secret,id=npm_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm install -g npm@11.21.1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN --mount=type=secret,id=npm_ca,required=false NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca npm ci -w shared -w api --omit=dev && npm cache clean --force
COPY --from=build /app/shared/dist shared/dist
COPY --from=build /app/api/dist api/dist
WORKDIR /app/api
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/v1/health || exit 1
CMD ["node", "dist/main.js"]
