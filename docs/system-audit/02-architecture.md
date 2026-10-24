# 02 — Architecture

## Cây thư mục (chọn lọc)
```
AI Orchestrator/
├─ AGENTS.md ROADMAP.md PROGRESS.md DECISIONS.md
├─ apps/
│  ├─ orchestrator/src/{main.ts,server.ts,routes/,adapters/,services/}
│  └─ dashboard/src/{app/,lib/api.ts,__tests__/}
├─ packages/
│  ├─ db/src/{connection.ts,migrator.ts,repositories/,migrations/*.sql}
│  └─ shared/src/{logger.ts,security/secret-scanner.ts,git.ts}
├─ services/launchd/*.plist
├─ test/ reports/ docs/
```

## Module và trách nhiệm
| Module | Trách nhiệm |
|---|---|
| `routes/*` (13 file) | REST/SSE: health, import, tasks, features, runs, scheduler, plans, quality, quota, schedule, system-resources, power, soak-test |
| `adapters/process-adapter.ts` | `spawn(exe, args)` |
| `adapters/execution-manager.ts`, `execution-stream.ts` | Quản lý process, ghi stdout/NDJSON vào `events` |
| `adapters/worktree-manager.ts`, `repository-registry.ts` | Git worktree, whitelist repo |
| `services/task-scheduler.ts` | Chọn task READY, chạy, chuyển trạng thái |
| `services/quality-gate-service.ts` + quality-runner, scope-diff, security-check, reviewer, repair-loop | Kiểm định trước khi DONE |
| `services/recovery-service.ts` | Khôi phục run treo sau crash |
| `services/resource-quota-manager.ts`, `system-resource-monitor.ts` | Giới hạn tài nguyên/quota |
| `packages/db` | Schema, migration, repository |

## Sơ đồ
```mermaid
flowchart LR
  UI[Dashboard Next.js :3001] -- fetch/SSE --> API[Fastify :3000]
  API --> SCH[TaskScheduler]
  API --> RUN[RunService]
  SCH --> EXE[ExecutionManager]
  RUN --> EXE
  EXE --> PROC[ProcessAdapter -> agy CLI]
  EXE --> STR[ExecutionStreamRecorder]
  SCH -.chưa nối trong server.ts.-> QG[QualityGateService]
  QG --> QR[QualityRunner / Scope / Security / Reviewer / Repair]
  API --> DB[(SQLite WAL)]
  STR --> DB
  SCH --> DB
```
Kiến trúc: modular monolith, một process Node cho backend, không queue/cache ngoài. Excel chỉ là nguồn import.
