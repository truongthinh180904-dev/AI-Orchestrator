# SKILL: Process spawn + NDJSON stream (AGY Worker)

Dùng khi: AGY-001 → AGY-008, OPS-004.

## Spawn an toàn
```ts
const child = spawn(exe, args, { cwd, env: pickEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: false });
```
- `exe` và `args` là **mảng tách biệt**; cấm `shell: true`, cấm ghép chuỗi lệnh từ input.
- `env`: whitelist (PATH, HOME, biến cần thiết); không truyền secrets không cần.
- Lắng nghe `error` (không tìm thấy exe), `exit`/`close` (code + signal), `stdout`, `stderr`.
- Ưu tiên sự kiện `close` để chắc chắn đã đọc hết stdout.

## NDJSON parser
- Giữ `buffer: string`; mỗi chunk: `buffer += chunk.toString('utf8')` (dùng `StringDecoder` để không cắt giữa ký tự UTF-8).
- Tách theo `\n`, phần cuối chưa có `\n` giữ lại buffer; khi process đóng → flush phần dư.
- Bỏ dòng rỗng; `JSON.parse` lỗi → phát event `parse_error` (kèm dòng thô), **không crash**.
- Mỗi event gán `seq` tăng dần, lưu DB ngay (không gom cuối).
- Giới hạn độ dài 1 dòng (vd 1MB) để tránh tràn bộ nhớ.

## Kết quả run
| Điều kiện | Status |
|---|---|
| exit 0 + có event `result` hợp lệ | `SUCCESS` (chỉ là CLI xong, **chưa** là task DONE) |
| exit ≠ 0 hoặc event `result` báo lỗi | `ERROR` |
| exit 0 nhưng không có/sai `result` | `INVALID_OUTPUT` |
| bị kill do timeout | `TIMEOUT` |
| bị người dùng dừng | `CANCELLED` |

## Timeout / Stop
`SIGTERM` → chờ grace (vd 10s) → `SIGKILL`. Đảm bảo dọn timer, không để zombie. Kill cả process group nếu AGY sinh tiến trình con (spawn với `detached: true` + `process.kill(-pid)`).

## Cách gọi AGY
Cấu hình trong env/config, không hard-code:
`AGY_BIN`, `AGY_ARGS` (có `-p "<prompt>"`), tham số thêm cho chế độ output NDJSON theo kết quả test đã thành công của người dùng. Khi kiểm thử dùng **mock CLI** (script Node phát NDJSON giả, giả lập lỗi/treo/crash).
