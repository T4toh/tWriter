#!/usr/bin/env bash
# Sincroniza la versión en package.json, src-tauri/Cargo.toml y src-tauri/tauri.conf.json.
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

echo "Versión bumpeada a $NEW en:"
echo "  - package.json"
echo "  - src-tauri/tauri.conf.json"
echo "  - src-tauri/Cargo.toml"
echo
echo "Próximo paso:"
echo "  git add -A && git commit -m \"chore: bump v$NEW\""
echo "  git tag v$NEW"
echo "  git push && git push --tags"
