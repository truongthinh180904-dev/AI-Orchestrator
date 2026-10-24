# 05 — Code Quality và Security

Độ chắc chắn: "Cao" = đọc trực tiếp code; chưa tái hiện bằng chạy thực.

| ID | Mức | Bằng chứng | Chắc chắn |
|---|---|---|---|
| ISS-001 | Critical | `apps/orchestrator/src/server.ts:266-275` tạo `TaskScheduler` không có `qualityGateService` (tạo ở ~333-342); `task-scheduler.ts:443-469` nhánh `else if (autoVerify)` gọi `markDone` | Cao |
| ISS-002 | High | Không đăng ký `@fastify/cors` trong `server.ts`; dashboard gọi cross-origin ở `apps/dashboard/src/lib/api.ts:95-113` | Cao (chưa thử trình duyệt) |
| ISS-003 | High | Không middleware auth (`server.ts:360-386`); `runs.ts:27-37`, `quality.ts:243-261`, `planner-service.ts:170-173`, `reviewer-service.ts:261-264` nhận exe/args; `import-service.ts:44-45` nhận `filePath`; `repositoryRegistry` mặc định undefined (`server.ts:213-223`) | Cao. Giảm nhẹ: bind 127.0.0.1 |
| ISS-004 | High | `task-repository.ts:508-538` INSERT thiếu `scope_files` so với `create()` 118-133 | Cao |
| ISS-005 | High | `apps/dashboard/package.json:9` `"build": "tsc"` | Cao |
| ISS-006 | Medium | `execution-manager.ts:82,294,375` `_runs` không prune; `execution-stream.ts:210-231,289` | Cao |
| ISS-007 | Medium | `soak-test-runner.ts:259-301,472,530,592` | Cao |
| ISS-008 | Medium | `task-repository.ts:677-695`, `plan-orchestrator.ts:187`, `recovery-service.ts:130-132` | Cao |
| ISS-009 | Medium | `repair-loop-service.ts:444-456`; `AGY_ARGS.split(' ')` | Cao |
| ISS-010 | Low | `test/ops-007.test.ts` chưa commit; `reports/REL-001.md}...` tên file lỗi; `reports/qlt-001.md` sai hoa thường; path cá nhân trong plist; `server.ts:321` biểu thức thừa | Cao |
| ISS-011 | Medium | `pnpm test` fail 11/136 file (xem 07), vi phạm định nghĩa DONE trong `AGENTS.md` mục 4 | Cao |

## Điểm tốt
`spawn` dùng mảng args, có secret scanner, zod validation, WAL.

## Giới hạn
Không chạy dependency audit, không pentest, không đọc `.env`. Chưa kiểm tra XSS/CSRF phía dashboard chi tiết.
