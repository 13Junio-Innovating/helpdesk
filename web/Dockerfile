# syntax=docker/dockerfile:1
# Front estático (Vite) servido pelo Nginx, que também repassa /api para a API.
# Build a partir da RAIZ do monorepo: docker build -f web/Dockerfile .
FROM node:22.22-alpine AS build
WORKDIR /app
# Atrás de proxy corporativo com TLS interceptado: --secret id=npm_ca,src=ca.crt (não fica na imagem)
ENV NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca
RUN --mount=type=secret,id=npm_ca,required=false npm install -g npm@11.21.1
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY web/package.json web/
RUN --mount=type=secret,id=npm_ca,required=false npm ci -w shared -w web
COPY shared shared
COPY web web
RUN npm run build -w shared && npm run build -w web

FROM nginx:1.27-alpine
COPY web/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
