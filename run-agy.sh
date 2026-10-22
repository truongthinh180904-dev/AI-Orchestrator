#!/usr/bin/env bash
# run-agy.sh — chạy AGY tự động xuyên đêm, mỗi lượt 1 task, có giãn cách + kiểm tra tài nguyên + xử lý quota.
# Dùng: AGY_FLAGS="<cờ bỏ qua hỏi quyền của AGY>" caffeinate -i ./run-agy.sh
set -u

# ===== Cấu hình (đổi bằng biến môi trường) =====
AGY_BIN="${AGY_BIN:-agy}"
# --dangerously-skip-permissions: tự duyệt mọi quyền (không hỏi); --print-timeout: AGY tự giới hạn thời gian 1 lượt
# Giữ output dạng text (mặc định) để script đọc được dòng "RESULT:" — đừng thêm --output-format stream-json
AGY_FLAGS="${AGY_FLAGS:---dangerously-skip-permissions --print-timeout 2000s}"
MAX_RUNS="${MAX_RUNS:-60}"            # tối đa số lượt (số task)
STOP_AFTER="${STOP_AFTER:-}"          # vd AGY-008: dừng sau task này (để trống = chạy hết)
COOLDOWN="${COOLDOWN:-180}"           # giây nghỉ giữa 2 lượt (giãn cách chống quá tải/quota)
RUN_TIMEOUT="${RUN_TIMEOUT:-2100}"    # giây tối đa cho 1 lượt (35 phút), quá hạn thì kill
MAX_LOAD_PER_CORE="${MAX_LOAD_PER_CORE:-0.8}"  # load avg 1 phút / số core tối đa để bắt đầu lượt
MIN_FREE_MEM_PCT="${MIN_FREE_MEM_PCT:-20}"     # % RAM trống tối thiểu để bắt đầu lượt
MAX_CONSEC_FAIL="${MAX_CONSEC_FAIL:-3}"        # số lượt lỗi liên tiếp thì dừng
QUOTA_BACKOFF="${QUOTA_BACKOFF:-1800}"         # giây nghỉ khi gặp quota/rate limit (30 phút)
MAX_QUOTA_HITS="${MAX_QUOTA_HITS:-4}"          # chạm quota quá số lần này liên tiếp thì dừng
STOP_AT_HOUR="${STOP_AT_HOUR:-}"      # vd 7: tự dừng khi tới 07:00 sáng (để trống = không giới hạn)

PROMPT="$(cat <<'EOF'
Đọc AGENTS.md rồi làm đúng theo đó. Đọc ROADMAP.md, PROGRESS.md và các SKILL-*.md liên quan.
Chọn task TODO kế tiếp có mọi dependency DONE, làm đúng 1 task, chạy kiểm tra thật, commit, cập nhật PROGRESS.md.
Không hỏi lại người dùng; mơ hồ thì tự chọn phương án an toàn và ghi vào DECISIONS.md.
Dòng cuối: RESULT: DONE|FAILED|BLOCKED <task-id>.
EOF
)"

mkdir -p logs
LOCK="logs/.run-agy.lock"
if [ -e "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "Đã có run-agy.sh đang chạy (PID $(cat "$LOCK")). Thoát."; exit 1
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

ts() { date '+%Y-%m-%d %H:%M:%S'; }
say() { echo "[$(ts)] $*" | tee -a logs/orchestrator.log; }

CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo 4)"

resources_ok() {
  local load free
  load="$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')"
  free="$(memory_pressure 2>/dev/null | awk -F': ' '/free percentage/ {gsub(/%/,"",$2); print $2}')"
  load="${load:-0}"; free="${free:-100}"
  awk -v l="$load" -v c="$CORES" -v m="$MAX_LOAD_PER_CORE" -v f="$free" -v mf="$MIN_FREE_MEM_PCT" \
    'BEGIN{ exit !( (l/c) <= m && f >= mf ) }'
}

wait_resources() {
  local waited=0
  until resources_ok; do
    say "Máy đang bận (CPU/RAM vượt ngưỡng), chờ 60s..."
    sleep 60; waited=$((waited+60))
    [ "$waited" -ge 3600 ] && { say "Chờ tài nguyên quá 1 giờ, dừng."; return 1; }
  done
  return 0
}

past_deadline() {
  [ -z "$STOP_AT_HOUR" ] && return 1
  local h; h="$(date +%-H)"
  [ "$h" -ge "$STOP_AT_HOUR" ] && [ "$h" -lt 20 ]
}

fail_count=0; quota_hits=0

for i in $(seq 1 "$MAX_RUNS"); do
  [ -e STOP ] && { say "Thấy file STOP, dừng an toàn."; break; }
  past_deadline && { say "Tới giờ dừng ($STOP_AT_HOUR:00), kết thúc."; break; }
  grep -q '| TODO |' PROGRESS.md 2>/dev/null || { say "Không còn task TODO. Hoàn tất."; break; }
  if [ -n "$(git status --porcelain)" ]; then
    say "Working tree đang bẩn (thay đổi chưa commit) — dừng để bạn kiểm tra."; break
  fi
  git checkout -q dev 2>/dev/null || { say "Không checkout được nhánh dev, dừng."; break; }
  wait_resources || break

  LOG="logs/run-$(date +%Y%m%d-%H%M%S)-$i.log"
  say "=== Lượt $i/$MAX_RUNS → $LOG"

  # shellcheck disable=SC2086
  "$AGY_BIN" $AGY_FLAGS -p "$PROMPT" > "$LOG" 2>&1 &
  PID=$!
  ( sleep "$RUN_TIMEOUT"; kill -TERM "$PID" 2>/dev/null; sleep 10; kill -KILL "$PID" 2>/dev/null ) &
  WD=$!
  wait "$PID"; CODE=$?
  pkill -P "$WD" 2>/dev/null; kill "$WD" 2>/dev/null

  LAST="$(grep -E '^RESULT:' "$LOG" | tail -1)"
  say "exit=$CODE ${LAST:-<không có RESULT>}"

  if [ -z "$LAST" ]; then
    if grep -qiE 'quota|rate.?limit|429|too many requests|resource.?exhausted|overloaded' "$LOG"; then
      quota_hits=$((quota_hits+1))
      say "Có vẻ chạm quota/rate limit (lần $quota_hits). Nghỉ ${QUOTA_BACKOFF}s."
      [ "$quota_hits" -ge "$MAX_QUOTA_HITS" ] && { say "Chạm quota quá nhiều lần, dừng."; break; }
      git stash -u -q 2>/dev/null   # dọn thay đổi dở dang của lượt hỏng
      sleep "$QUOTA_BACKOFF"; continue
    fi
    fail_count=$((fail_count+1))
  else
    quota_hits=0
    case "$LAST" in
      *DONE*)    fail_count=0;;
      *FAILED*)  fail_count=$((fail_count+1));;
      *BLOCKED*) say "Task BLOCKED, dừng để bạn xem."; break;;
    esac
  fi

  [ "$fail_count" -ge "$MAX_CONSEC_FAIL" ] && { say "Lỗi liên tiếp $fail_count lượt, dừng."; break; }
  if [ -n "$STOP_AFTER" ] && echo "$LAST" | grep -q "DONE $STOP_AFTER"; then
    say "Đã tới mốc $STOP_AFTER, dừng."; break
  fi

  say "Nghỉ ${COOLDOWN}s trước lượt tiếp theo..."
  sleep "$COOLDOWN"
done

say "Kết thúc run-agy.sh."