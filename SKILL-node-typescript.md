# SKILL: Node.js + TypeScript + Fastify (Orchestrator)

Dùng khi: FND-*, TSK-006, AGY-007, ORC-*, QLT-*, REL-*, OPS-*.

## Cấu trúc
```
apps/orchestrator/src/
  main.ts            # bootstrap: env → db → server
  server.ts          # buildServer(deps) — dễ test bằng app.inject()
  routes/            # 1 file / nhóm route, validate bằng zod
  services/          # logic nghiệp vụ (không phụ thuộc Fastify)
  adapters/          # process, git, agy
packages/shared/     # types + zod schemas dùng chung
```

## Quy tắc
- `tsconfig`: `strict`, `noUncheckedIndexedAccess`, `module: NodeNext`. ESM (`"type":"module"`), import có đuôi `.js`.
- Dependency injection bằng tham số (`buildServer({ db, logger })`), không singleton toàn cục → test dễ.
- Route: parse input bằng zod → gọi service → trả JSON `{ data }` hoặc `{ error: { code, message } }`.
- Mọi async phải `await` hoặc xử lý lỗi; không floating promise (bật rule `@typescript-eslint/no-floating-promises`).
- Graceful shutdown: bắt `SIGINT/SIGTERM`, ngừng nhận task, đóng DB.
- SSE: header `text/event-stream`, gửi heartbeat 15s, dọn listener khi client ngắt.

## Mẫu error
```ts
export class AppError extends Error {
  constructor(public code: string, message: string, public context: Record<string, unknown> = {}) { super(message); }
}
```

## Checklist trước commit
`pnpm lint && pnpm typecheck && pnpm test` đều exit 0.
