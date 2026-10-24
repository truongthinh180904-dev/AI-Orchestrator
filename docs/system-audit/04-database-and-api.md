# 04 — Database và API

## Database
Engine: SQLite (`better-sqlite3`), PRAGMA: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000` (`packages/db/src/connection.ts`). 18 migration (`001_initial_schema.sql` … `018_soak_tests.sql`).

Nhóm bảng đã đọc từ migration:
| Nhóm | Bảng |
|---|---|
| Lõi | `features`, `tasks`, `task_dependencies`, `runs`, `events`, `reports`, `agent_locks`, `checkpoints`, `plans` |
| Chất lượng | `quality_command_records`, `review_findings`, `security_checks`, `secret_findings`, `repair_loops`, `repair_iterations`, `quality_gate_evaluations` |
| Vận hành | `feature_releases`, `quota_events`, `execution_schedules`, `schedule_events`, `recovery_audits`, `system_resource_events`, `soak_test_runs` |
| Hệ thống | `_migrations` |

Quan hệ chính: `tasks.feature_id → features`, `task_dependencies(task_id, depends_on)`, `runs.task_id → tasks`, `events.run_id → runs`.
Chưa liệt kê đầy đủ index/unique từng bảng trong báo cáo này; cần đối chiếu lại các file SQL trước khi kết luận về index thiếu.

## Điểm cần chú ý
- Toàn vẹn: `createMany` bỏ `scope_files` (ISS-004).
- Hiệu năng: `findReadyTasks`/`getDependencyStatus` load toàn bộ task và dependency; `getPlanExecutionSummary` gọi trong vòng lặp → O(N²) (ISS-008).
- Ghi: mỗi dòng stdout sinh 2 INSERT đồng bộ vào `events`; `getEvents()` không phân trang (ISS-006).
- Concurrency: một process, WAL, 1 coding process; chưa xác minh race khi chạy nhiều instance orchestrator.

## API (13 route file, prefix theo từng file)
`health`, `import` (preview/execute), `tasks`, `features`, `runs` (POST /runs, GET /runs/:id/stream SSE), `scheduler`, `plans` (generate), `quality` (run, review), `quota`, `schedule`, `system-resources`, `power`, `soak-test` (run, simulate-fault).
Nhận xét: không có auth; một số endpoint nhận `command: {exe,args,cwd,env}` trực tiếp; chưa liệt kê đầy đủ từng method/path trong tài liệu này (không đủ dữ liệu đã ghi lại).
