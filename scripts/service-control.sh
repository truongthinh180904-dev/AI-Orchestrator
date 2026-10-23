#!/usr/bin/env bash
# service-control.sh — Trình điều khiển và quản lý vòng đời LaunchAgent trên macOS cho AI Orchestrator
# Hỗ trợ cả 2 dịch vụ:
#   1. service: AI Orchestrator HTTP/API daemon (Fastify + TaskScheduler + Caffeinate)
#   2. runner: AI Orchestrator Automated Overnight Batch Runner (run-agy.sh + Caffeinate)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${HOME}/Library/LaunchAgents"

ACTION="${1:-help}"
SERVICE_TYPE="${2:-service}"

case "$SERVICE_TYPE" in
  service)
    LABEL="com.ai-orchestrator.service"
    PLIST_SOURCE="$REPO_DIR/services/launchd/com.ai-orchestrator.service.plist"
    STDOUT_LOG="$REPO_DIR/logs/launchd.service.stdout.log"
    STDERR_LOG="$REPO_DIR/logs/launchd.service.stderr.log"
    ;;
  runner)
    LABEL="com.ai-orchestrator.runner"
    PLIST_SOURCE="$REPO_DIR/services/launchd/com.ai-orchestrator.runner.plist"
    STDOUT_LOG="$REPO_DIR/logs/launchd.runner.stdout.log"
    STDERR_LOG="$REPO_DIR/logs/launchd.runner.stderr.log"
    ;;
  *)
    echo "Lỗi: Loại dịch vụ không hợp lệ: '$SERVICE_TYPE'. Hỗ trợ: 'service' hoặc 'runner'."
    exit 1
    ;;
esac

TARGET_PLIST="$TARGET_DIR/$LABEL.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"

ensure_macos() {
  if [ "$(uname -s)" != "Darwin" ]; then
    echo "Lỗi: launchd chỉ hỗ trợ trên nền tảng macOS (Darwin)."
    exit 1
  fi
}

ensure_logs_dir() {
  mkdir -p "$REPO_DIR/logs"
}

cmd_generate() {
  if [ -f "$PLIST_SOURCE" ]; then
    cat "$PLIST_SOURCE"
  else
    echo "Lỗi: Không tìm thấy file plist tại: $PLIST_SOURCE"
    exit 1
  fi
}

cmd_install() {
  ensure_macos
  ensure_logs_dir
  mkdir -p "$TARGET_DIR"

  if [ ! -f "$PLIST_SOURCE" ]; then
    echo "Lỗi: File cấu hình plist không tồn tại: $PLIST_SOURCE"
    exit 1
  fi

  # Kiểm tra tính hợp lệ XML plist trước khi cài đặt
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$PLIST_SOURCE" >/dev/null || {
      echo "Lỗi: File plist không hợp lệ theo chuẩn Apple Property List."
      exit 1
    }
  fi

  echo "==> Cài đặt $LABEL vào $TARGET_DIR..."
  cp "$PLIST_SOURCE" "$TARGET_PLIST"
  chmod 644 "$TARGET_PLIST"

  # Nạp service vào launchd
  echo "==> Đăng ký service vào Launchd ($DOMAIN)..."
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  fi

  if launchctl bootstrap "$DOMAIN" "$TARGET_PLIST" 2>/dev/null; then
    echo "Đã đăng ký service thành công bằng 'launchctl bootstrap'."
  else
    # Fallback cho macOS phiên bản cũ
    launchctl load -w "$TARGET_PLIST" 2>/dev/null || true
    echo "Đã đăng ký service bằng 'launchctl load'."
  fi

  echo "Hoàn thành cài đặt $LABEL. Xem trạng thái bằng: $0 status $SERVICE_TYPE"
}

cmd_uninstall() {
  ensure_macos
  echo "==> Gỡ bỏ $LABEL khỏi launchd..."
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  fi
  launchctl unload "$TARGET_PLIST" 2>/dev/null || true

  if [ -f "$TARGET_PLIST" ]; then
    rm -f "$TARGET_PLIST"
    echo "Đã xóa file plist: $TARGET_PLIST"
  fi
  echo "Đã gỡ bỏ service $LABEL thành công."
}

cmd_start() {
  ensure_macos
  echo "==> Khởi động service $LABEL..."
  if ! launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null; then
    launchctl start "$LABEL" 2>/dev/null || {
      echo "Lỗi khởi động service. Vui lòng đảm bảo service đã được cài đặt (chạy: $0 install $SERVICE_TYPE)."
      exit 1
    }
  fi
  echo "Đã gửi lệnh kích hoạt service $LABEL."
}

cmd_stop() {
  ensure_macos
  echo "==> Dừng service $LABEL..."
  launchctl kill SIGTERM "$DOMAIN/$LABEL" 2>/dev/null || launchctl stop "$LABEL" 2>/dev/null || {
    echo "Không thể gửi tín hiệu dừng (có thể service không chạy)."
  }
  echo "Đã gửi tín hiệu dừng service $LABEL."
}

cmd_restart() {
  cmd_stop || true
  sleep 1
  cmd_start
}

cmd_status() {
  ensure_macos
  echo "======================================================"
  echo " Trạng thái Launchd Service: $LABEL"
  echo "======================================================"
  if [ -f "$TARGET_PLIST" ]; then
    echo "• File plist đã cài đặt: $TARGET_PLIST (TỒN TẠI)"
  else
    echo "• File plist chưa cài đặt: $TARGET_PLIST (CHƯA CÀI ĐẶT)"
  fi

  echo "• Kiểm tra launchctl:"
  if launchctl print "$DOMAIN/$LABEL" 2>/dev/null; then
    echo "==> Dịch vụ ĐANG ĐƯỢC QUẢN LÝ bởi launchd ($DOMAIN)."
  elif launchctl list | grep -q "$LABEL"; then
    launchctl list | grep "$LABEL"
  else
    echo "==> Dịch vụ KHÔNG đang chạy trong session hiện tại."
  fi

  echo "------------------------------------------------------"
  echo "• File Log Stdout: $STDOUT_LOG"
  [ -f "$STDOUT_LOG" ] && tail -n 5 "$STDOUT_LOG" || echo "  (Chưa có log)"
  echo "• File Log Stderr: $STDERR_LOG"
  [ -f "$STDERR_LOG" ] && tail -n 5 "$STDERR_LOG" || echo "  (Chưa có log)"
  echo "======================================================"
}

cmd_logs() {
  echo "=== Logs Stdout ($STDOUT_LOG) ==="
  [ -f "$STDOUT_LOG" ] && tail -n 30 "$STDOUT_LOG" || echo "(File chưa tồn tại)"
  echo ""
  echo "=== Logs Stderr ($STDERR_LOG) ==="
  [ -f "$STDERR_LOG" ] && tail -n 30 "$STDERR_LOG" || echo "(File chưa tồn tại)"
}

cmd_help() {
  echo "AI Orchestrator — Launchd & Caffeinate Service Management"
  echo ""
  echo "Cú pháp: $0 <lệnh> [loại_service]"
  echo ""
  echo "Loại service (tùy chọn, mặc định: 'service'):"
  echo "  service : Orchestrator daemon HTTP API + TaskScheduler"
  echo "  runner  : Automated Overnight Runner (run-agy.sh)"
  echo ""
  echo "Lệnh hỗ trợ:"
  echo "  install    : Kiểm tra, sao chép plist vào ~/Library/LaunchAgents/ và nạp vào launchd"
  echo "  uninstall  : Dừng và gỡ bỏ service khỏi launchd và xóa file plist"
  echo "  start      : Khởi động hoặc kickstart dịch vụ qua launchctl"
  echo "  stop       : Dừng dịch vụ qua launchctl (SIGTERM)"
  echo "  restart    : Dừng và khởi động lại dịch vụ"
  echo "  status     : Hiển thị trạng thái đăng ký, PID và nhật ký gần nhất"
  echo "  logs       : Xem 30 dòng log gần nhất của stdout và stderr"
  echo "  generate   : In nội dung file plist mẫu ra stdout"
  echo "  help       : Hiển thị hướng dẫn này"
  echo ""
  echo "Ví dụ:"
  echo "  $0 install service      # Cài đặt Orchestrator daemon"
  echo "  $0 start service        # Khởi động Orchestrator daemon"
  echo "  $0 status service       # Kiểm tra trạng thái"
  echo "  $0 install runner       # Cài đặt runner xuyên đêm theo lịch 22:00"
}

case "$ACTION" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  generate)  cmd_generate ;;
  help|*)    cmd_help ;;
esac
