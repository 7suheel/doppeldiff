#!/usr/bin/env bash
# Reproduces docs/EVALUATION.md: clones the evaluated repositories and runs doppeldiff on each commit
# (base = commit^, head = commit, claim = the commit subject, 1,000 inputs per function, seed 1).
# Usage: scripts/evaluate.sh [workdir]   (requires a built CLI: npm run build)
set -euo pipefail
WORK=${1:-${TMPDIR:-/tmp}/doppeldiff-eval}
CLI="$(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"
mkdir -p "$WORK/out"
declare -A REPOS=(
  [ufo]=unjs/ufo [validator.js]=validatorjs/validator.js [defu]=unjs/defu [es-toolkit]=toss/es-toolkit
  [change-case]=blakeembrey/change-case [ms]=vercel/ms [slugify]=simov/slugify [semver]=npm/node-semver
  [date-fns]=date-fns/date-fns [camelcase]=sindresorhus/camelcase [pretty-bytes]=sindresorhus/pretty-bytes
  [bytes.js]=visionmedia/bytes.js [path-to-regexp]=pillarjs/path-to-regexp [radash]=sodiray/radash
  [filesize.js]=avoidwork/filesize.js [decamelize]=sindresorhus/decamelize [qs]=ljharb/qs
)
COMMITS=(
  "ufo 5cd9e67" "ufo eb29945" "ufo 6cd1fcd" "validator.js 7d42ed2" "validator.js a38f15b" "validator.js 941db7f"
  "defu 11ba022" "defu e458b63" "es-toolkit 69a4fd1a" "es-toolkit ee2676d1" "es-toolkit 2950de59" "es-toolkit be30b1bd"
  "change-case 976fa36" "change-case 59d762f" "ms 2669f23" "ms f0bc0a2" "slugify f7a91b6" "slugify 8d8c538"
  "semver bea6028" "semver e583226" "semver e37e0ca"
  # Second held-out set
  "date-fns 766dea98" "date-fns b9c5865e" "camelcase 97e8e40" "camelcase 3433c29" "pretty-bytes 4e800a3"
  "pretty-bytes 5cb9c95" "bytes.js 581b2b5" "bytes.js db70acb" "path-to-regexp 7dd6f8f" "path-to-regexp 762bc6b"
  "radash 4cab190" "radash c378bd1" "filesize.js 109ae60" "filesize.js f5bd84b" "decamelize 5fb69c0"
  "decamelize 0eb37b4" "qs 54f7f3b" "qs 05a8755"
)
for name in "${!REPOS[@]}"; do
  [ -d "$WORK/$name" ] || git clone --quiet --filter=blob:none "https://github.com/${REPOS[$name]}.git" "$WORK/$name"
done
# qs needs its runtime dependencies in the checkout (as in a user's CI).
[ -d "$WORK/qs/node_modules" ] || (cd "$WORK/qs" && npm install --ignore-scripts --no-audit --no-fund --silent)
for entry in "${COMMITS[@]}"; do
  set -- $entry
  subject=$(git -C "$WORK/$1" log -1 --pretty=%s "$2")
  echo "== $1 $2: $subject"
  node "$CLI" --cwd "$WORK/$1" --base "$2^" --head "$2" --claim "$subject" --seed 1 --runs 1000 \
    --no-install --fail-on never --json "$WORK/out/$1-$2.json" || true
done
