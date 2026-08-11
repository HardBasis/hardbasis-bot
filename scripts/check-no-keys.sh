#!/usr/bin/env bash
# Fail if a real-looking API key was committed. A key is hb_ followed by 32 hex
# chars; the repo must only ever contain hb_ placeholders (e.g. hb_xxx…). This
# runs in CI and is cheap enough to run in a pre-commit hook too.
set -euo pipefail

PATTERN='hb_[0-9a-f]{32}'

# Scan tracked files only (never node_modules / state / logs). Exclude this
# script itself and its Actions workflow, which necessarily name the pattern.
if git rev-parse --git-dir >/dev/null 2>&1; then
  files=$(git ls-files | grep -vE '^(scripts/check-no-keys\.sh|\.github/workflows/ci\.yml)$' || true)
else
  files=$(find . -type f -not -path './.git/*' -not -path './node_modules/*')
fi

hits=""
for f in $files; do
  if grep -InE "$PATTERN" "$f" >/dev/null 2>&1; then
    hits="$hits\n$(grep -InE "$PATTERN" "$f" | sed "s#^#$f:#")"
  fi
done

if [ -n "$hits" ]; then
  echo "❌ committed-key check FAILED — a value matching $PATTERN is present:"
  echo -e "$hits"
  echo "Remove it, rotate the key, and scrub history if it was ever pushed."
  exit 1
fi

echo "✅ committed-key check passed (no $PATTERN found in tracked files)"
