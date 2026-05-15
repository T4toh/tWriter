#!/usr/bin/env bash
# Sincroniza la versión en package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json
# y packaging/aur/PKGBUILD. Después corre `cargo update -p twriter` para refrescar Cargo.lock.
# Uso: ./scripts/bump-version.sh 0.2.0
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

# package.json
sed -i -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEW\"/" package.json

# tauri.conf.json
sed -i -E "s/\"version\": \"[0-9]+\.[0-9]+\.[0-9]+\"/\"version\": \"$NEW\"/" src-tauri/tauri.conf.json

# Cargo.toml — solo la primera línea ^version (la del [package])
sed -i -E "0,/^version = \"[0-9]+\.[0-9]+\.[0-9]+\"/s//version = \"$NEW\"/" src-tauri/Cargo.toml

# PKGBUILD — pkgver + reset pkgrel=1
sed -i -E "s/^pkgver=.*/pkgver=$NEW/" packaging/aur/PKGBUILD
sed -i -E "s/^pkgrel=.*/pkgrel=1/" packaging/aur/PKGBUILD

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
