# DECISIONS.md — Ghi lại các quyết định kỹ thuật / giả định

## FND-001: Khởi tạo pnpm monorepo & tsconfig base
- **Workspace structure**: Sử dụng `pnpm-workspace.yaml` quản lý 4 packages: `apps/orchestrator`, `apps/dashboard`, `packages/shared`, `packages/db`.
- **Package naming**: Sử dụng namespace `@ai-orchestrator/*` (`@ai-orchestrator/orchestrator`, `@ai-orchestrator/dashboard`, `@ai-orchestrator/shared`, `@ai-orchestrator/db`).
- **TypeScript config**: Tạo `tsconfig.base.json` với `strict: true`, `noUncheckedIndexedAccess: true`, `module: NodeNext`, `moduleResolution: NodeNext`, ESM `"type": "module"`. Mỗi package kế thừa từ `tsconfig.base.json`.
- **Build script**: Mỗi package cung cấp script `"build": "tsc"`, root cung cấp script `"build": "pnpm -r build"`.
- **Dependencies**: Cài đặt `typescript` và `@types/node` ở root workspace level để chia sẻ compiler cho toàn bộ monorepo.

## FND-002: Cấu hình ESLint, Prettier, Vitest và scripts root
- **TypeScript Version**: Hạ từ 7.0.2 xuống 5.9.3 (peer dependency của `typescript-eslint` yêu cầu `<6.1.0`).
- **ESLint**: Sử dụng ESLint v9/v10 flat config (`eslint.config.mjs`) tích hợp `typescript-eslint` với `projectService: true`, bật các rules nghiêm ngặt (`@typescript-eslint/no-explicit-any`: error, `@typescript-eslint/no-floating-promises`: error) và `eslint-config-prettier`.
- **Prettier**: Thêm `.prettierrc` chuẩn hóa (semi, singleQuote, trailingComma, printWidth: 100). Trong `.prettierignore`, bổ sung `*.md` để bảo toàn format tài liệu và rule của dự án.
- **Vitest**: Cấu hình `vitest.config.ts` chạy unit test trên Node environment, quét các file `**/*.test.ts`. Chuyển đổi test từ `node:test` sang Vitest API (`describe`, `it`, `expect`).
- **Scripts root**: Cung cấp `lint` (`eslint .`), `typecheck` (`tsc --noEmit && pnpm -r typecheck`), `test` (`vitest run`), `format` (`prettier --check .`), `format:fix` (`prettier --write .`). Mỗi package trong workspace bổ sung script `"typecheck": "tsc --noEmit"`.

## FND-003: SQLite Connection & Migration Runner
- **Thư viện**: Cài đặt `better-sqlite3` và `@types/better-sqlite3` trong `packages/db`.
- **Cấu hình PRAGMA**: Tự động bật `journal_mode = WAL`, `foreign_keys = ON`, và `busy_timeout = 5000` khi khởi tạo kết nối qua `createDatabase()`.
- **Migration Runner**:
  - Tự động tạo bảng `_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL)`.
  - Quét thư mục `packages/db/migrations` (sắp xếp theo thứ tự bảng chữ cái/đánh số `001_...`).
  - Mỗi file migration được thực thi trong một SQLite transaction (`db.transaction(...)`), tự động ghi nhận vào `_migrations` với timestamp ISO-8601 UTC.
  - Idempotent: Nếu migration đã được ghi nhận trong `_migrations`, runner sẽ bỏ qua. Chạy lại nhiều lần an toàn, không sinh lỗi.
  - Xử lý lỗi: Bất kỳ lỗi nào trong quá trình chạy file migration đều dẫn đến rollback transaction và throw `AppError` với mã `MIGRATION_EXECUTION_FAILED`.
- **Migration 001**: Khởi tạo 6 bảng nghiệp vụ cốt lõi theo `ROADMAP.md` và `SKILL-sqlite.md`: `features`, `tasks`, `task_dependencies`, `runs`, `events`, `reports` kèm các chỉ mục (indexes) tối ưu hóa truy vấn.
- **Error Handling**: Cung cấp lớp `AppError` chuẩn (`code`, `message`, `context`).
