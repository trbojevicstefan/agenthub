# syntax=docker/dockerfile:1
# The web app's runtime: one container per active user runs the session service (desktop/runtime.cjs) with no
# Electron. Agents and terminals run on the user's machines over SSH; the container only needs Node and ssh.
# Build from the repository root:
#   docker build -f deploy/runtime.Dockerfile -t opaya-runtime:latest .
# The launcher (web/src/launcher.ts) starts it with a read-only root file system, no capabilities, memory, CPU and
# process limits, and the user's own folder as /data.
FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/opaya
COPY package.json package-lock.json ./
COPY web/package.json web/
# The desktop app's own packages only (node-pty, xterm): no Electron and no web workspace. node-pty is built for Node.
RUN npm ci --omit=dev --workspaces=false --ignore-scripts --no-audit --no-fund && npm rebuild node-pty

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/opaya
COPY --from=build /opt/opaya/node_modules node_modules
COPY package.json ./
COPY desktop desktop
COPY ui/terminal-layout.js ui/terminal-layout.js
COPY scripts/probe.py scripts/probe.py
ENV NODE_ENV=production OPAYA_RUNTIME=web OPAYA_DATA=/data HOME=/data/home
USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "desktop/runtime.cjs"]
