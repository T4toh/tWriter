#!/usr/bin/env bash
# Detiene el container de LanguageTool levantado por start-languagetool.sh.
set -euo pipefail

NAME="twriter-languagetool"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker no está instalado." >&2
  exit 1
fi

if docker stop "${NAME}" >/dev/null 2>&1; then
  echo "LanguageTool detenido."
else
  echo "No estaba corriendo."
fi
