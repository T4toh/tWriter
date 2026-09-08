#!/usr/bin/env bash
# Sincroniza la versión en package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
# y packaging/aur/PKGBUILD. Después corre `cargo update -p twriter` para refrescar Cargo.lock.
# Uso: ./scripts/bump-version.sh 0.2.0
#
# Los reemplazos van con perl y no con `sed -i`: el sed de macOS (BSD) pide el
# sufijo de backup como argumento de `-i`, así que `sed -i -E` se come el `-E`
# como sufijo, deja un `archivo-E` al lado y corre el script en BRE — donde
# `[0-9]+` no es cuantificador y no matchea nada. Eso fue el bump v0.11.0:
# cuatro archivos `*-E` commiteados y la versión sin tocar en tres de los
# cuatro destinos. perl -pi se comporta igual en macOS y en Linux.
set -euo pipefail

NEW="${1:-}"
if [[ -z "$NEW" ]]; then
  echo "uso: $0 X.Y.Z" >&2
  exit 1
fi

if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version inválida: '$NEW' (debe ser semver X.Y.Z)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# package.json y tauri.conf.json — el primer "version" del archivo (sin /g).
perl -0777 -pi -e "s/\"version\": \"\d+\.\d+\.\d+\"/\"version\": \"$NEW\"/" package.json
perl -0777 -pi -e "s/\"version\": \"\d+\.\d+\.\d+\"/\"version\": \"$NEW\"/" src-tauri/tauri.conf.json

# Cargo.toml — solo la primera línea ^version (la del [package]).
perl -0777 -pi -e "s/^version = \"\d+\.\d+\.\d+\"/version = \"$NEW\"/m" src-tauri/Cargo.toml

# PKGBUILD — pkgver + reset pkgrel=1
perl -0777 -pi -e "s/^pkgver=.*/pkgver=$NEW/m" packaging/aur/PKGBUILD
perl -0777 -pi -e "s/^pkgrel=.*/pkgrel=1/m" packaging/aur/PKGBUILD

# Guard: que ninguno se haya quedado atrás en silencio. El bump roto anterior
# se publicó justamente porque el script decía "listo" sin haber cambiado nada.
fallo=0
check() { # archivo, patrón esperado
  if ! grep -qF "$2" "$1"; then
    echo "ERROR: $1 no quedó en $NEW (esperaba: $2)" >&2
    fallo=1
  fi
}
check package.json "\"version\": \"$NEW\""
check src-tauri/tauri.conf.json "\"version\": \"$NEW\""
check src-tauri/Cargo.toml "version = \"$NEW\""
check packaging/aur/PKGBUILD "pkgver=$NEW"
if [[ "$fallo" != 0 ]]; then
  echo "El bump quedó a medias: revisá los archivos antes de commitear." >&2
  exit 1
fi

# Cargo.lock — refresca la entrada de twriter sin tocar el resto del grafo
if command -v cargo &>/dev/null; then
  ( cd src-tauri && cargo update -p twriter --offline 2>/dev/null || cargo update -p twriter )
fi

echo "Versión bumpeada a $NEW en:"
echo "  - package.json"
echo "  - src-tauri/tauri.conf.json"
echo "  - src-tauri/Cargo.toml"
echo "  - src-tauri/Cargo.lock"
echo "  - packaging/aur/PKGBUILD (pkgrel=1)"
echo
echo "Próximo paso:"
echo "  git add -A && git commit -m \"chore: bump v$NEW\""
echo "  git tag v$NEW"
echo "  git push && git push --tags"
echo
echo "Y con el release ya publicado, antes de subir al AUR:"
echo "  ( cd packaging/aur && updpkgsums )   # el sha256 es del .deb del release"
echo "  git commit -am \"chore(aur): sha256 de v$NEW\""
