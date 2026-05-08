#!/usr/bin/env bash
# Rebuild + reinstall local del PKGBUILD twriter-bin.
# Usar después de cada nueva release publicada en GitHub.
#
# Uso:
#   ./packaging/aur/rebuild.sh           # usa pkgver del PKGBUILD
#   ./packaging/aur/rebuild.sh 0.2.0     # bumpea pkgver primero
set -euo pipefail

cd "$(dirname "$0")"

NEW="${1:-}"
if [[ -n "$NEW" ]]; then
  if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "version inválida: '$NEW' (debe ser X.Y.Z)" >&2
    exit 1
  fi
  sed -i -E "s/^pkgver=.*/pkgver=$NEW/" PKGBUILD
  echo "pkgver bumpeado a $NEW"
fi

# Necesita pacman-contrib para updpkgsums
if ! command -v updpkgsums &>/dev/null; then
  echo "Falta updpkgsums. Instalá: sudo pacman -S pacman-contrib" >&2
  exit 1
fi

echo "Recalculando sha256sums…"
updpkgsums

echo "Building + instalando…"
makepkg -si --noconfirm

echo
echo "Listo. tWriter $(grep -oP '^pkgver=\K.*' PKGBUILD) instalado."
