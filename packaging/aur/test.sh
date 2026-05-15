#!/usr/bin/env bash
# Prueba local del PKGBUILD twriter-bin antes de publicarlo al AUR.
# Asume que `./scripts/bump-version.sh` ya sincronizó la versión en PKGBUILD.
# Valida que el .deb esté publicado en GitHub, recalcula sha256, lintea
# con namcap y hace build + install.
#
# Uso:
#   ./packaging/aur/test.sh
set -euo pipefail

cd "$(dirname "$0")"
AUR_DIR="$(pwd)"
ROOT="$(cd "$AUR_DIR/../.." && pwd)"

# 1) Validar coherencia: PKGBUILD pkgver == package.json version
PKG_VER="$(grep -oP '^pkgver=\K.*' PKGBUILD)"
APP_VER="$(grep -oP '"version":\s*"\K[0-9]+\.[0-9]+\.[0-9]+' "$ROOT/package.json" | head -1)"
if [[ "$PKG_VER" != "$APP_VER" ]]; then
  echo "ERROR: PKGBUILD pkgver=$PKG_VER ≠ package.json $APP_VER." >&2
  echo "       Corré primero: ./scripts/bump-version.sh $APP_VER" >&2
  exit 1
fi
echo "Versión coherente: $PKG_VER"

# 2) Verificar que el .deb existe en el release
DEB_URL="https://github.com/T4toh/tWriter/releases/download/v${PKG_VER}/tWriter_${PKG_VER}_amd64.deb"
echo "Chequeando release: $DEB_URL"
if ! curl -sIfL -o /dev/null "$DEB_URL"; then
  echo "ERROR: el .deb v${PKG_VER} no está publicado todavía." >&2
  echo "       Esperá a que termine el GitHub Action (gh run watch) y reintentá." >&2
  exit 1
fi
echo "  .deb encontrado en GitHub."

# 3) Dependencias del host
for cmd in updpkgsums makepkg; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Falta '$cmd'. Instalá: sudo pacman -S pacman-contrib base-devel" >&2
    exit 1
  fi
done

# 4) Recalcular sha256sums (el .deb cambió con la nueva versión)
echo "Recalculando sha256sums…"
updpkgsums

# 5) Lint del PKGBUILD (warn-only)
if command -v namcap &>/dev/null; then
  echo "namcap PKGBUILD:"
  namcap PKGBUILD || true
else
  echo "namcap no instalado, salteo lint. (sudo pacman -S namcap)"
fi

# 6) Build + install
echo "Building + instalando…"
makepkg -sif --noconfirm

# 7) Lint del paquete generado
PKG_FILE="$(ls -1t twriter-bin-${PKG_VER}-*-x86_64.pkg.tar.zst 2>/dev/null | head -1 || true)"
if [[ -n "$PKG_FILE" ]] && command -v namcap &>/dev/null; then
  echo "namcap $PKG_FILE:"
  namcap "$PKG_FILE" || true
fi

echo
echo "Listo. tWriter ${PKG_VER} instalado."
echo "Smoke test: abrir 'twriter' desde el menú o ejecutar 'twriter' en otra terminal."
echo "Si todo OK → ./packaging/aur/publish.sh"
