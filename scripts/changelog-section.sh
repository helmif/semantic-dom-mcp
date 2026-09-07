#!/usr/bin/env sh
# Prints the CHANGELOG.md section for one version (without its heading).
# Usage: scripts/changelog-section.sh 0.5.0
# Exits 1 when the version has no section, so a release cannot ship unlogged.
set -eu
version="$1"
file="${2:-CHANGELOG.md}"
section=$(awk -v v="$version" '
  /^## \[/ { if (found) exit; if (index($0, "## [" v "]") == 1) { found = 1; next } }
  found { print }
' "$file")
if [ -z "$(printf '%s' "$section" | tr -d '[:space:]')" ]; then
  echo "CHANGELOG.md has no section for $version" >&2
  exit 1
fi
printf '%s\n' "$section"
