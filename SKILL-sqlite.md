# SKILL: SQLite + Migration (better-sqlite3)

Dùng khi: FND-003, TSK-001, ORC-005, OPS-003 và mọi task chạm database.

## Quy tắc
- Dùng `better-sqlite3` (đồng bộ). Bật khi mở DB: `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`
- Migration: file `packages/db/migrations/NNN_name.sql` (001, 002…), **không sửa file đã chạy**; thay đổi mới = file mới.
- Runner: bảng `_migrations(id, name, applied_at)`; mỗi migration chạy trong 1 transaction; chạy lặp lại không lỗi.
- Luôn dùng prepared statement có tham số (`?`/`@name`), **cấm** nối chuỗi SQL.
- Thao tác nhiều bước (chọn task + đặt RUNNING) phải bọc `db.transaction(...)` để chống chạy trùng.
- Thời gian lưu ISO-8601 UTC (TEXT). JSON lưu TEXT + parse bằng zod khi đọc.
- Repository class trả về object đã qua zod; không để SQL rải rác ngoài `packages/db`.

## Bảng cốt lõi (gợi ý)
- `tasks(id PK, feature_id, title, description, phase, worker_type, repository, acceptance_criteria, test_commands, priority, max_attempts, timeout_minutes, status, attempts, created_at, updated_at)`
- `task_dependencies(task_id, depends_on_id, PK(task_id, depends_on_id))`
- `features(id PK, name, description, required_tasks, integration_tests, release_policy, status)`
- `runs(id PK, task_id, attempt, status, exit_code, pid, started_at, finished_at, branch, commit_sha)`
- `events(id PK AUTOINCREMENT, run_id, seq, type, payload, ts)` — index `(run_id, seq)`
- `reports(id PK, run_id, kind, content, created_at)`

## Test
Dùng DB `:memory:` hoặc file tạm; test: migration lặp, ràng buộc FK, transaction rollback.
