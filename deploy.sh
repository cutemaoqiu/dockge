#!/usr/bin/env bash
# 构建自建 Dockge 镜像并部署到 NAS（构建在 NAS 上跑，本机只出前端产物）
set -euo pipefail
cd "$(dirname "$0")"

eval "$(fnm env)"
fnm use 22 >/dev/null
[ -d node_modules ] || npm ci
npm run build:frontend

tar -czf - --exclude node_modules --exclude .git --exclude data . \
    | ssh 05 'rm -rf /opt/dockge-src && mkdir -p /opt/dockge-src && tar -xzf - -C /opt/dockge-src'

ssh 05 'cd /opt/dockge-src \
    && docker build -f docker/Dockerfile --target release -t dockge-custom:local . >/dev/null \
    && sed -i "s|image: dockge-custom:.*|image: dockge-custom:local|" /opt/dockge/compose.yaml \
    && cd /opt/dockge && docker compose up -d \
    && docker ps --filter name=dockge --format "{{.Status}} {{.Image}}"'
