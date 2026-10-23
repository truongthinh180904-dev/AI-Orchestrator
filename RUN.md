# RUN.md — Cách cho AGY CLI tự chạy (MacBook)

## 1. Chuẩn bị (1 lần)
```bash
cd ~/projects/orchestrator
# thư mục phải có: AGENTS.md ROADMAP.md PROGRESS.md SKILL-*.md RUN.md run-agy.sh
mkdir -p reports logs && touch DECISIONS.md
chmod +x run-agy.sh
git add -A
git commit -m "chore: update agent rules and runner"
git branch --show-current     # phải in ra: dev
```
Nếu chưa phải `dev`: `git branch -m dev`.

## 2. Cờ AGY đã dùng
| Cờ | Tác dụng |
|---|---|
| `-p` | chạy 1 prompt không tương tác (script tự thêm) |
| `--dangerously-skip-permissions` | tự duyệt mọi quyền, không hỏi lại |
| `--print-timeout 2000s` | AGY tự dừng nếu 1 lượt quá ~33 phút |

Giữ `--output-format` ở mặc định `text` để script đọc được dòng `RESULT:`.
Đổi cờ: `AGY_FLAGS="..." ./run-agy.sh`. Có thể thêm `--model <tên>` (xem `agy models`) hoặc `--effort medium` để tiết kiệm quota.

> Cờ `--dangerously-skip-permissions` cho AGY chạy mọi lệnh mà không hỏi. Chỉ chạy trong thư mục dự án riêng, không chứa dữ liệu quan trọng khác.

## 3. Chạy thử 1 lượt
```bash
MAX_RUNS=1 ./run-agy.sh
```
Kiểm tra: không bị hỏi lại, `PROGRESS.md` cập nhật, có commit mới trên `dev`, log có `RESULT: DONE <task-id>`.

## 4. Chạy xuyên đêm

### Cách 1: Chạy tự động qua Launchd Service (Khuyến nghị trên macOS)
Chi tiết hướng dẫn tại [docs/launchd-service-guide.md](docs/launchd-service-guide.md).
```bash
# Cài đặt và khởi chạy Orchestrator Server daemon qua launchd:
./scripts/service-control.sh install service
./scripts/service-control.sh start service

# Kiểm tra trạng thái và log:
./scripts/service-control.sh status service
./scripts/service-control.sh logs service

# Hoặc cài đặt runner xuyên đêm tự động chạy từ 22:00:
./scripts/service-control.sh install runner
```

### Cách 2: Chạy trực tiếp với caffeinate và tmux
```bash
tmux new -s agy
STOP_AT_HOUR=7 ./scripts/run-caffeinated.sh ./run-agy.sh
```
(Thoát tmux mà vẫn chạy: `Ctrl+b` rồi `d`; vào lại: `tmux attach -t agy`.)

Biến chỉnh được: `COOLDOWN` (giây nghỉ giữa lượt, mặc định 180), `MAX_RUNS`, `STOP_AFTER` (vd `AGY-008`), `MAX_LOAD_PER_CORE`, `MIN_FREE_MEM_PCT`, `QUOTA_BACKOFF`.

Dừng an toàn: `touch STOP` trong thư mục dự án hoặc `./scripts/service-control.sh stop service`.
Theo dõi: `tail -f logs/orchestrator.log` hoặc `tail -f logs/launchd.service.stdout.log`.

## 5. Sau khi chạy
- Xem `PROGRESS.md`, `reports/`, `git log dev`, `logs/`.
- Task `FAILED/BLOCKED`: đọc `reports/<task-id>.md` + log tương ứng, sửa rồi đặt lại `TODO`.
- Soak test dài giờ chỉ bật sau khi OPS-007 pass.