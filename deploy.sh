#!/usr/bin/env bash
#
# Deploy ke Netlify.
#
# Netlify auto-build tiap kali ada push ke origin/master, jadi "deploy" di repo ini
# artinya: pastikan aman -> push. Build-nya jalan di server Netlify, bukan di sini.
#
# Pemakaian (dari Git Bash):
#   ./deploy.sh                 pre-flight tsc, lalu push
#   ./deploy.sh --full          + jalankan semua fixture dulu (lebih lama)
#   ./deploy.sh --dry           cek semuanya tapi TIDAK push
#
set -euo pipefail
cd "$(dirname "$0")"

BRANCH="master"          # branch produksi yang di-build Netlify
REMOTE="origin"
FULL=0
DRY=0
for arg in "$@"; do
    case "$arg" in
        --full) FULL=1 ;;
        --dry)  DRY=1 ;;
        *) echo "argumen tidak dikenal: $arg" >&2; exit 2 ;;
    esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\n\033[1;31mBATAL: %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. harus di branch produksi ────────────────────────────────────────────────
step "Cek branch"
current=$(git rev-parse --abbrev-ref HEAD)
[ "$current" = "$BRANCH" ] || die "sekarang di '$current', bukan '$BRANCH'. Pindah dulu: git checkout $BRANCH"
echo "di $BRANCH"

# ── 2. tidak boleh ada perubahan yang belum di-commit ──────────────────────────
# Sengaja HANYA cek file yang sudah dilacak git. File di pending-game-imports/
# memang dibiarkan untracked, dan itu penanda "import yang belum dikerjakan" --
# jangan pernah pakai `git add -A` di repo ini.
step "Cek working tree"
if ! git diff --quiet || ! git diff --cached --quiet; then
    git status --short
    die "masih ada perubahan yang belum di-commit. Commit dulu, baru deploy."
fi
echo "bersih (file untracked diabaikan, memang begitu seharusnya)"

# ── 3. typecheck ──────────────────────────────────────────────────────────────
# JANGAN `npm run build` di sini. Build produksi menimpa .next/ yang dipakai dev
# server, dan aplikasi jadi rusak sampai .next dihapus + dev server distart ulang.
# Netlify build sendiri di servernya; tsc memberi sinyal yang sama tanpa sentuh .next.
step "Typecheck (npx tsc --noEmit)"
npx tsc --noEmit || die "tsc gagal. Perbaiki dulu sebelum deploy."
echo "0 error"

# ── 4. fixture (opsional) ─────────────────────────────────────────────────────
if [ "$FULL" = "1" ]; then
    step "Jalankan semua fixture"
    failed=0
    for f in _fx-*.mjs; do
        [ -e "$f" ] || continue
        if out=$(node "$f" 2>&1); then
            printf '  %-38s %s\n' "$f" "$(echo "$out" | grep -oE '[0-9]+/[0-9]+ passed' | tail -1)"
        else
            printf '  %-38s GAGAL\n' "$f"; failed=1
        fi
    done
    [ "$failed" = "0" ] || die "ada fixture yang gagal."
fi

# ── 5. sinkron dengan remote ──────────────────────────────────────────────────
step "Sinkron dengan $REMOTE/$BRANCH"
git fetch "$REMOTE" "$BRANCH"
behind=$(git rev-list --count "$BRANCH..$REMOTE/$BRANCH")
ahead=$(git rev-list --count "$REMOTE/$BRANCH..$BRANCH")
if [ "$behind" != "0" ]; then
    echo "remote punya $behind commit yang belum ada di sini, coba fast-forward..."
    git merge --ff-only "$REMOTE/$BRANCH" || die "remote sudah menyimpang. Selesaikan manual (git log $REMOTE/$BRANCH)."
    ahead=$(git rev-list --count "$REMOTE/$BRANCH..$BRANCH")
fi
if [ "$ahead" = "0" ]; then
    echo "sudah sama persis dengan remote -- tidak ada yang perlu di-deploy."
    exit 0
fi
echo "$ahead commit siap dikirim:"
git log --oneline "$REMOTE/$BRANCH..$BRANCH" | sed 's/^/  /'

# ── 6. push -> Netlify build otomatis ─────────────────────────────────────────
if [ "$DRY" = "1" ]; then
    step "--dry: berhenti di sini, tidak push"
    exit 0
fi
step "Push ke $REMOTE/$BRANCH"
git push "$REMOTE" "$BRANCH"

printf '\n\033[1;32mSelesai.\033[0m Netlify mulai build otomatis sekarang.\n'
echo "Pantau progresnya di dashboard Netlify (tab Deploys)."
