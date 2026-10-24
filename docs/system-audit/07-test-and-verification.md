# 07 — Test và Verification

| Lệnh | Kết quả |
|---|---|
| `git status && git log --oneline -n 30` | Exit 0. Nhánh `dev`, 1 file chưa stage: `test/ops-007.test.ts` |
| `pnpm lint && pnpm typecheck && pnpm build` | Exit 0 (4 package build thành công) |
| `pnpm test` (`vitest run`) | **Exit 1**. Test Files: 11 failed, 125 passed (136). Tests: 1 failed, 1397 passed (1398). Duration 151.79s |

## Lỗi quan sát được
- `packages/shared/src/__tests__/git.test.ts`: kỳ vọng `NOT_A_GIT_REPO`, nhận `GIT_COMMAND_FAILED` (1 test fail).
- `apps/dashboard/src/__tests__/*.test.tsx` (ví dụ `test-report-review-findings.test.tsx`, test dùng `StatusBadge`): `RolldownError: Parse failure ... Unexpected JSX expression`. Nghi do transform JSX chưa cấu hình cho file `.tsx` khi chạy từ root vitest; chưa xác minh.
- Danh sách đầy đủ 11 file fail chưa trích được (lệnh grep bị hủy). Log đầy đủ: `.../steps/107/output.txt`.

## Chưa thực hiện
- `pnpm audit`, chạy server thật, thử dashboard trên trình duyệt, kiểm tra CORS thực tế.
- `gemini --help`: chưa xác nhận CLI có trong PATH.
- Tái hiện ISS-001 bằng chạy thực.

## Đề xuất
Trích 11 file fail, sửa cấu hình vitest, thêm test integration cho `buildServer()` + gate, thêm test 401/CORS, chạy `pnpm audit`, thêm CI.

Kết luận: không thể coi 57/57 task DONE là hợp lệ khi `pnpm test` chưa exit 0.
