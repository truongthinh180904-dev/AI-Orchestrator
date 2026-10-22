# AGENTS.md — Rule bắt buộc cho AGY (đọc ĐẦU TIÊN, mỗi lần chạy)

## 0. Chế độ chạy tự động (headless, `-p`)
- Bạn chạy không có người trực. **TUYỆT ĐỐI không hỏi lại người dùng.** Gặp điểm mơ hồ → chọn phương án đơn giản, an toàn nhất, ghi quyết định vào `DECISIONS.md`, rồi làm tiếp.
- Mỗi lần chạy chỉ làm **ĐÚNG 1 task** (task kế tiếp đủ điều kiện trong `PROGRESS.md`), xong thì dừng.
- Không tự chạy lệnh phá hủy ngoài repo (`rm -rf` ngoài thư mục dự án, `git push --force`, `git reset --hard` trên nhánh chung, sudo).
- Bị kẹt >3 lần thử sửa cùng một lỗi → đánh dấu task `BLOCKED` trong `PROGRESS.md`, ghi nguyên nhân + log, dừng.

## 1. Quy trình mỗi task (bắt buộc theo thứ tự)
1. Đọc `AGENTS.md`, `ROADMAP.md`, `PROGRESS.md`, và các `SKILL-*.md` liên quan.
2. Chọn task: trạng thái `TODO`, mọi dependency đã `DONE`, thứ tự ID trong ROADMAP. Đặt `IN_PROGRESS`.
3. Kiểm tra `git status`: nếu có thay đổi chưa commit không thuộc task → dừng, ghi `BLOCKED`.
4. Làm việc trên nhánh `dev` (chưa ở đó thì `git checkout dev`). KHÔNG tạo nhánh mới cho từng task; mỗi task là 1 commit trên `dev`. Báo cáo nghiệm thu đặt ở `reports/<task-id>.md`.
5. Viết test trước hoặc cùng lúc với code (xem `SKILL-testing.md`).
6. Chạy: `pnpm lint && pnpm typecheck && pnpm test` (và `pnpm build` nếu task chạm build). Phải **exit code 0**.
7. Kiểm tra từng dòng "Nghiệm thu" của task, ghi bằng chứng (lệnh + kết quả) vào `reports/<task-id>.md`.
8. Commit: `feat(<task-id>): <mô tả ngắn>` (Conventional Commits). Không push main, không merge.
9. Cập nhật `PROGRESS.md`: `DONE` + commit SHA + ngày giờ. Nếu lỗi: `FAILED` + lý do.
10. In dòng cuối cùng: `RESULT: DONE <task-id>` hoặc `RESULT: FAILED <task-id>` hoặc `RESULT: BLOCKED <task-id>`.

## 2. Quy tắc kỹ thuật đã chốt (KHÔNG tự ý đổi)
| Mục | Chốt |
|---|---|
| Ngôn ngữ | TypeScript `strict: true`, Node.js >= 20 LTS |
| Monorepo | pnpm workspaces: `apps/orchestrator`, `apps/dashboard`, `packages/shared`, `packages/db` |
| Database | SQLite (`better-sqlite3`), migration SQL có đánh số, chạy lặp an toàn |
| Validation | `zod` cho mọi input từ ngoài (Excel, API, NDJSON) |
| API | Fastify (HTTP) + SSE cho log; thao tác điều khiển qua REST |
| Dashboard | Next.js (App Router) + TypeScript, không logic nghiệp vụ trong UI |
| Test | Vitest; lint ESLint; format Prettier |
| Process | `child_process.spawn(exe, argsArray)`, **cấm** `exec`/`shell: true` với input động |
| Concurrency | Tối đa 1 coding process tại một thời điểm |
| Git | Branch riêng, commit chuẩn hóa, push + PR, **không tự merge** |
| Excel | Chỉ là nguồn yêu cầu; runtime state nằm trong SQLite, AI không ghi trạng thái vào Excel |

## 3. Quy tắc code
- Hàm nhỏ, một trách nhiệm; không `any` (dùng `unknown` + zod); không `// @ts-ignore`.
- Lỗi dùng class `AppError` có `code`, `message`, `context`; không nuốt lỗi.
- Log có cấu trúc JSON (`timestamp`, `level`, `context`); không log secrets.
- Không đưa token/API key vào code, prompt, log, commit. Dùng `.env` (đã có trong `.gitignore`) + `.env.example`.
- Không thêm dependency khi chưa cần; thêm thì ghi lý do vào `DECISIONS.md`.
- Chỉ sửa file trong phạm vi task. Cần sửa ngoài phạm vi → ghi `DECISIONS.md`, giữ thay đổi tối thiểu.

## 4. Định nghĩa "DONE"
Task chỉ DONE khi: lint + typecheck + test pass **thật**, mọi tiêu chí nghiệm thu có bằng chứng, commit đã tạo. **Không được tự tuyên bố hoàn thành khi chưa chạy lệnh kiểm tra.**

## 5. Cấu trúc file điều phối (do bạn duy trì)
- `PROGRESS.md` — bảng trạng thái task (nguồn sự thật cho lần chạy sau).
- `DECISIONS.md` — quyết định/giả định đã đưa ra.
- `reports/<task-id>.md` — bằng chứng nghiệm thu.