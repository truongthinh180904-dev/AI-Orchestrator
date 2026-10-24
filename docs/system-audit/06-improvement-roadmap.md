# 06 — Improvement Roadmap

Mỗi mục: gốc rễ → cách sửa nhỏ nhất → file → độ phức tạp (S/M/L) → rủi ro → nghiệm thu → test.

## P0
**ISS-001 Quality Gate bị bỏ qua** — Gốc: thứ tự khởi tạo trong `server.ts`. Sửa: tạo `QualityGateService` trước, truyền vào `TaskScheduler` (hoặc setter). File: `server.ts`. S. Rủi ro: task cũ sẽ bị gate chặn. Nghiệm thu: scheduler không `markDone` khi chưa có gate pass. Test: integration `buildServer()` + CLI giả exit 0 phải ra VERIFYING.

**ISS-003 API không auth** — Sửa: token header (biến env) cho mọi route trừ health; bắt buộc `RepositoryRegistry`; bỏ/whitelist `command` từ body, giới hạn `filePath`. File: `server.ts`, routes, import-service. M. Rủi ro: client hiện tại cần gửi token. Nghiệm thu: request không token trả 401; exe ngoài whitelist bị từ chối. Test: route tests 401/403.

**ISS-002 CORS** — Sửa: đăng ký `@fastify/cors` với origin `http://localhost:3001` (ghi dependency vào `DECISIONS.md`) hoặc Next rewrite proxy. S. Nghiệm thu: preflight OPTIONS thành công từ dashboard. Test: inject OPTIONS.

## P1
- **ISS-004** thêm `scope_files` vào `createMany`. S. Test: import rồi đọc lại scope_files.
- **ISS-005** `build` = `next build`, giữ `typecheck` riêng. S. Nghiệm thu: có `.next`, `next start` chạy.
- **ISS-011** sửa 11 file test fail (cấu hình JSX/vitest cho dashboard; mã lỗi `NOT_A_GIT_REPO` trong `shared/git.ts`). M. Nghiệm thu: `pnpm test` exit 0.
- **ISS-006** prune `_runs` khi run kết thúc, batch insert events, phân trang `getEvents`. M.
- **ISS-007** soak test dùng DB tạm, khôi phục sampler gốc, khóa endpoint ở production. M.

## P2
- **ISS-008** query SQL có điều kiện (`WHERE status IN ...`), tính dependency một lần. M.
- **ISS-009** repair loop đi qua `RunService` + lock. M.
- **ISS-010** dọn repo, commit/loại test chưa commit, bỏ path cá nhân khỏi plist (template), xóa dead expression. S.

## P3
Observability (metrics), CI chạy lint/typecheck/test/build, backup SQLite, tài liệu vận hành.

Thứ tự: ISS-001 → ISS-011 → ISS-003/002 → ISS-004/005 → còn lại.
