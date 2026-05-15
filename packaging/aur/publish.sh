#!/usr/bin/env bash
# Publica el PKGBUILD actual al AUR (repo ssh: aur@aur.archlinux.org:twriter-bin.git).
# Asume que ya corriste ./test.sh y validaste localmente.
#
# Requisitos:
#   - SSH key cargada en aur.archlinux.org (https://aur.archlinux.org/account/)
#   - makepkg disponible (para regenerar .SRCINFO)
#
# Uso:
#   ./packaging/aur/publish.sh           # commitea con mensaje default
#   ./packaging/aur/publish.sh "msg"     # mensaje custom
set -euo pipefail

cd "$(dirname "$0")"
AUR_DIR="$(pwd)"
ROOT="$(cd "$AUR_DIR/../.." && pwd)"
AUR_PKG="twriter-bin"
AUR_REMOTE="ssh://aur@aur.archlinux.org/${AUR_PKG}.git"
AUR_CLONE="${XDG_CACHE_HOME:-$HOME/.cache}/aur/${AUR_PKG}"

if ! command -v makepkg &>/dev/null; then
  echo "Falta makepkg. Instalá: sudo pacman -S base-devel" >&2
  exit 1
fi

# 1) Sanity: PKGBUILD pkgver coincide con package.json
PKG_VER="$(grep -oP '^pkgver=\K.*' PKGBUILD)"
PKG_REL="$(grep -oP '^pkgrel=\K.*' PKGBUILD)"
APP_VER="$(grep -oP '"version":\s*"\K[0-9]+\.[0-9]+\.[0-9]+' "$ROOT/package.json" | head -1)"
if [[ "$PKG_VER" != "$APP_VER" ]]; then
  echo "ERROR: PKGBUILD pkgver=$PKG_VER no coincide con package.json $APP_VER." >&2
  echo "       Corré ./test.sh primero." >&2
  exit 1
fi

# 2) Validar SSH al AUR (ssh -T sale con exit 1 porque AUR no da shell interactiva;
#    capturamos la salida y greppeamos por separado para no chocar con pipefail)
echo "Verificando SSH al AUR…"
SSH_OUT="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -T aur@aur.archlinux.org 2>&1 || true)"
if ! echo "$SSH_OUT" | grep -q "Welcome"; then
  echo "ERROR: no se pudo autenticar en aur@aur.archlinux.org." >&2
  echo "       Salida de ssh:" >&2
  echo "$SSH_OUT" | sed 's/^/         /' >&2
  echo "       Cargá tu clave pública en https://aur.archlinux.org/account/" >&2
  exit 1
fi
echo "  SSH OK."

# 3) Clonar o actualizar el repo AUR local
if [[ ! -d "$AUR_CLONE/.git" ]]; then
  echo "Clonando $AUR_REMOTE en $AUR_CLONE…"
  mkdir -p "$(dirname "$AUR_CLONE")"
  git clone "$AUR_REMOTE" "$AUR_CLONE"
else
  echo "Actualizando $AUR_CLONE…"
  git -C "$AUR_CLONE" fetch origin
  git -C "$AUR_CLONE" reset --hard origin/master 2>/dev/null || git -C "$AUR_CLONE" reset --hard origin/main
fi

# 4) Copiar PKGBUILD + .install
cp -v "$AUR_DIR/PKGBUILD" "$AUR_CLONE/PKGBUILD"
cp -v "$AUR_DIR/${AUR_PKG}.install" "$AUR_CLONE/${AUR_PKG}.install"

# 5) Regenerar .SRCINFO dentro del clone
echo "Regenerando .SRCINFO…"
( cd "$AUR_CLONE" && makepkg --printsrcinfo > .SRCINFO )

# 6) Mostrar diff y pedir confirmación
echo
echo "=== diff a publicar ==="
git -C "$AUR_CLONE" --no-pager diff --stat
git -C "$AUR_CLONE" --no-pager diff
echo "======================="
echo

if git -C "$AUR_CLONE" diff --quiet && git -C "$AUR_CLONE" diff --cached --quiet; then
  echo "Nada para commitear. AUR ya está al día."
  exit 0
fi

read -r -p "Pushear v${PKG_VER}-${PKG_REL} al AUR? [y/N] " CONFIRM
case "$CONFIRM" in
  y|Y|yes|YES) ;;
  *) echo "Abortado."; exit 0 ;;
esac

# 7) Commit + push
MSG="${1:-Update to ${PKG_VER}-${PKG_REL}}"
git -C "$AUR_CLONE" add PKGBUILD .SRCINFO "${AUR_PKG}.install"
git -C "$AUR_CLONE" commit -m "$MSG"
git -C "$AUR_CLONE" push

echo
echo "Publicado. https://aur.archlinux.org/packages/${AUR_PKG}"
