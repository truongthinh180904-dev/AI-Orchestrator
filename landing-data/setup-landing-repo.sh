#!/usr/bin/env bash
# Tạo repo thử nghiệm cho landing page. Chạy: bash setup-landing-repo.sh
set -e
REPO="${1:-$HOME/sandbox/landing-test}"
if [ -e "$REPO/.git" ]; then echo "Repo đã tồn tại: $REPO (giữ nguyên)"; exit 0; fi
mkdir -p "$REPO"
cd "$REPO"
git init -q -b main
printf 'node_modules/\n.DS_Store\n' > .gitignore
git add .gitignore
git commit -q -m "chore: init landing-test repo"
echo "Đã tạo repo sạch tại: $REPO"
git status --short | wc -l | xargs echo "File chưa commit:"
