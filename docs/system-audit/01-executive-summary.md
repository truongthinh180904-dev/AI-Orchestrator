# 01 — Executive Summary

Ngày audit: 2026-10-24. Nhánh `dev`. Chỉ đọc code và chạy lệnh không phá hủy.

## Tổng quan
Modular monolith, pnpm monorepo, 4 package:
- `packages/shared`: logger, secret scanner, git helper, AppError.
- `packages/db`: SQLite (`better-sqlite3`), 18 migration, repositories.
- `apps/orchestrator`: Fastify + SSE (port 3000), scheduler, runner, quality gate.
- `apps/dashboard`: Next.js 15 App Router (port 3001).

`PROGRESS.md` ghi 57/57 task `DONE`. Kiểm chứng thực tế: lint, typecheck, build pass; `pnpm test` KHÔNG pass hoàn toàn (xem 07).

## Điểm mạnh
- Cấu trúc package rõ ràng, SQLite bật WAL, `foreign_keys=ON`, `busy_timeout`.
- Migration đánh số, có test dày (1398 test).
- Có quality gate, scope diff, secret scan, recovery, quota (đã xác minh có code).

## Điểm yếu
- Scheduler tạo trong `buildServer()` chưa nối với `QualityGateService` (xem ISS-001).
- API không xác thực, nhận lệnh tùy ý.
- Thiếu CORS cho dashboard chạy trình duyệt thật.
- `pnpm test` fail 11/136 file.

## 10 vấn đề ưu tiên
| ID | Mức | Tóm tắt |
|---|---|---|
| ISS-001 | Critical | Scheduler bỏ qua Quality Gate, markDone khi CLI exit 0 |
| ISS-002 | High | Không có CORS |
| ISS-003 | High | API không auth, spawn lệnh tùy ý, đọc file tùy ý |
| ISS-004 | High | `createMany()` bỏ `scope_files` |
| ISS-005 | High | Dashboard `build` = `tsc`, không `next build` |
| ISS-006 | Medium | `_runs` Map tăng vô hạn, ghi event đồng bộ từng dòng |
| ISS-007 | Medium | Soak test làm bẩn DB và sampler thật |
| ISS-008 | Medium | Full-table scan / O(N²) trong dependency |
| ISS-009 | Medium | RepairLoop spawn trực tiếp, bỏ qua lock/run record |
| ISS-010 | Low | Vệ sinh repo, test fail, file rác |

Trạng thái bằng chứng: tất cả mục trên là "đã xác minh từ source" trừ khi ghi khác; chưa tái hiện bằng chạy thực tế (xem giới hạn ở 07).
