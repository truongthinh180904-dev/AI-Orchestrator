#!/usr/bin/env bash
# run-caffeinated.sh — Wrapper chạy lệnh bất kỳ với caffeinate để ngăn macOS rơi vào trạng thái ngủ (sleep).
# Tự động phát hiện macOS và dọn dẹp tiến trình an toàn khi có tín hiệu dừng.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Sử dụng: $0 <lệnh> [các đối số...]"
  echo "Ví dụ: $0 pnpm --filter @ai-orchestrator/orchestrator start"
  echo "       $0 ./run-agy.sh"
  exit 1
fi

OS_NAME="$(uname -s 2>/dev/null || echo "Unknown")"

if [ "$OS_NAME" = "Darwin" ]; then
  CAFFEINATE_BIN="$(command -v caffeinate 2>/dev/null || echo "/usr/bin/caffeinate")"
  if [ -x "$CAFFEINATE_BIN" ]; then
    echo "[caffeinate] Đang kích hoạt chế độ chống ngủ trên macOS (-dimsu)..."
    echo "[caffeinate] Thực thi lệnh: $*"
    # -d: giữ màn hình bật (display sleep assertion)
    # -i: chống idle sleep (idle sleep assertion)
    # -m: chống disk sleep (disk sleep assertion)
    # -s: chống sleep hệ thống khi cắm sạc AC
    # -u: giả lập hoạt động người dùng (user activity assertion)
    exec "$CAFFEINATE_BIN" -dimsu "$@"
  else
    echo "[caffeinate] Cảnh báo: Không tìm thấy tiện ích /usr/bin/caffeinate. Chạy lệnh trực tiếp."
    exec "$@"
  fi
else
  echo "[caffeinate] Hệ điều hành không phải macOS ($OS_NAME). Bỏ qua caffeinate và chạy lệnh trực tiếp."
  exec "$@"
fi
