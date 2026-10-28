#!/usr/bin/env bash
# Levanta LanguageTool local en localhost:8081 vía Docker, con el mismo
# container que crea la app (src-tauri/src/grammar.rs: LT_IMAGE + run_args).
# Requisitos: docker.
set -euo pipefail

NAME="twriter-languagetool"
IMAGE="erikvl87/languagetool:6.8"   # = LT_IMAGE de grammar.rs
PORT=8081

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker no está instalado." >&2
  exit 1
fi

# Un container con otra imagen (el `:latest` de versiones viejas de este
# script, que además publicaba el puerto a toda la LAN) se recrea, igual que
# «Actualizar LanguageTool» en la app.
if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$" \
  && [ "$(docker inspect -f '{{.Config.Image}}' "${NAME}")" != "${IMAGE}" ]; then
  echo "Container con otra imagen, recreándolo con ${IMAGE}…"
  docker rm -f "${NAME}" >/dev/null
fi

if docker ps --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "LanguageTool ya está corriendo en localhost:${PORT}"
  exit 0
fi

if docker ps -a --format '{{.Names}}' | grep -q "^${NAME}$"; then
  echo "Container existente, reiniciando…"
  docker start "${NAME}" >/dev/null
else
  echo "Bajando imagen ${IMAGE} (primera vez ~300MB)…"
  docker pull "${IMAGE}" >/dev/null
  echo "Levantando container ${NAME} en :${PORT}…"
  docker run -d \
    --name "${NAME}" \
    --restart unless-stopped \
    -p "127.0.0.1:${PORT}:8010" \
    -e Java_Xms=512m \
    -e Java_Xmx=2g \
    "${IMAGE}" >/dev/null
fi

echo "Esperando que LT responda…"
for _ in $(seq 1 30); do
  if curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/v2/languages" | grep -q '^200$'; then
    echo "LanguageTool listo en http://localhost:${PORT}"
    exit 0
  fi
  sleep 1
done

echo "Warning: LT levantó el container pero todavía no responde. Probá:" >&2
echo "  curl http://localhost:${PORT}/v2/languages" >&2
exit 1
