# syntax=docker/dockerfile:1
# The Opaya web server. Build from the repository root:
#   docker compose -f deploy/docker-compose.yml build web
# Only the web workspace is installed. The Electron app and its dependencies stay out of the image.
FROM node:24-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci --workspace web --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY web web
RUN npm run build --workspace web

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY web/package.json web/
RUN npm ci --workspace web --include-workspace-root=false --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force
COPY --from=build /src/web/dist web/dist
COPY ui/assets/opaya-logo.png ui/assets/opaya-logo.png
WORKDIR /app/web
# A fixed user ID, so the key file on the host can belong to this user only (see deploy/README.md).
USER 10001:10001
EXPOSE 3000
CMD ["node", "dist/main.js"]
