# RUN.md — Cách cho AGY CLI tự chạy (MacBook)

## 1. Chuẩn bị (1 lần)
```bash
mkdir -p ~/projects/orchestrator && cd ~/projects/orchestrator
git init
# copy vào thư mục này: AGENTS.md ROADMAP.md PROGRESS.md SKILL-*.md RUN.md
mkdir -p reports && touch DECISIONS.md
git add -A && git commit -m "chore: add agent instructions"
```

## 2. Prompt cố định cho mỗi lần chạy (`-p`)
```
Đọc AGENTS.md rồi làm đúng theo đó. Đọc ROADMAP.md, PROGRESS.md và các SKILL-*.md liên quan.
Chọn task TODO kế tiếp có mọi dependency DONE, làm đúng 1 task, chạy kiểm tra thật, commit, cập nhật PROGRESS.md.
Không hỏi lại người dùng; mơ hồ thì tự chọn phương án an toàn và ghi vào DECISIONS.md.
Dòng cuối: RESULT: DONE|FAILED|BLOCKED <task-id>.
```

## 3. Vòng lặp chạy tự động (`run-agy.sh`)
> Điền đúng executable/cờ AGY của bạn (đã test NDJSON + quyền tự chạy không hỏi). Ở đây chỉ giả định `-p`.
```bash
#!/usr/bin/env bash
set -u
AGY_BIN="${AGY_BIN:-agy}"
MAX_RUNS="${MAX_RUNS:-8}"          # MVP: Milestone A ≈ 14 task; chỉnh theo ý
STOP_AFTER="${STOP_AFTER:-AGY-008}" # dừng sau task này để bạn kiểm tra
PROMPT="$(cat <<'EOF'
Đọc AGENTS.md rồi làm đúng theo đó. Đọc ROADMAP.md, PROGRESS.md và các SKILL-*.md liên quan.
Chọn task TODO kế tiếp có mọi dependency DONE, làm đúng 1 task, chạy kiểm tra thật, commit, cập nhật PROGRESS.md.
Không hỏi lại người dùng; mơ hồ thì tự chọn phương án an toàn và ghi vào DECISIONS.md.
Dòng cuối: RESULT: DONE|FAILED|BLOCKED <task-id>.
EOF
)"
mkdir -p logs
for i in $(seq 1 "$MAX_RUNS"); do
  LOG="logs/run-$(date +%Y%m%d-%H%M%S)-$i.log"
  echo "== Run $i → $LOG"
  "$AGY_BIN" -p "$PROMPT" 2>&1 | tee "$LOG"
  LAST="$(grep -E '^RESULT:' "$LOG" | tail -1)"
  echo "$LAST"
  case "$LAST" in
    *BLOCKED*) echo "Dừng: BLOCKED"; break;;
    *"DONE $STOP_AFTER"*) echo "Đã tới mốc $STOP_AFTER"; break;;
    "") echo "Không có RESULT, dừng để kiểm tra"; break;;
  esac
done
```
Chạy: `chmod +x run-agy.sh && caffeinate -i ./run-agy.sh` (`caffeinate` giữ Mac không ngủ).

## 4. Thứ tự khuyến nghị
1. Chạy tới **AGY-008** (Milestone A) → bạn kiểm tra `PROGRESS.md`, `reports/`, chạy `pnpm test`.
2. Đặt `STOP_AFTER=ORC-008` cho Milestone B, rồi QLT → REL → UI → OPS.
3. Task `FAILED/BLOCKED`: đọc `reports/<task-id>.md` + `logs/`, sửa ROADMAP hoặc đổi `TODO` rồi chạy tiếp.

## 5. Lưu ý
- Chạy trong repo sạch; script dừng nếu `BLOCKED` do working tree bẩn.
- Không đưa API key vào prompt/log; để trong `.env`.
- Soak test dài giờ chỉ bật sau khi OPS-007 pass.
