# DECISIONS.md — Ghi lại các quyết định kỹ thuật / giả định

## FND-001: Khởi tạo pnpm monorepo & tsconfig base
- **Workspace structure**: Sử dụng `pnpm-workspace.yaml` quản lý 4 packages: `apps/orchestrator`, `apps/dashboard`, `packages/shared`, `packages/db`.
- **Package naming**: Sử dụng namespace `@ai-orchestrator/*` (`@ai-orchestrator/orchestrator`, `@ai-orchestrator/dashboard`, `@ai-orchestrator/shared`, `@ai-orchestrator/db`).
- **TypeScript config**: Tạo `tsconfig.base.json` với `strict: true`, `noUncheckedIndexedAccess: true`, `module: NodeNext`, `moduleResolution: NodeNext`, ESM `"type": "module"`. Mỗi package kế thừa từ `tsconfig.base.json`.
- **Build script**: Mỗi package cung cấp script `"build": "tsc"`, root cung cấp script `"build": "pnpm -r build"`.
- **Dependencies**: Cài đặt `typescript` và `@types/node` ở root workspace level để chia sẻ compiler cho toàn bộ monorepo.
