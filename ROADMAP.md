# ROADMAP — AI Coding Orchestrator (MVP)

Mục tiêu: phần mềm thật, tự vận hành. Orchestrator + worker thực thi; Dashboard chỉ điều khiển/quan sát.

```
Dashboard (Next.js) → HTTP/SSE → Orchestrator (Node+TS) → SQLite
                                   ├─ Resource Manager
                                   └─ AGY Adapter (làm trước; Codex/Claude adapter để sau)
Quality Gate → Git Release → PR (chờ người duyệt, không tự merge)
```
**MVP:** 1 coding agent / thời điểm, 1 repo hoạt động, SQLite, AGY CLI. Chưa multi-agent song song.

**Thứ tự chạy cho AGY:** FND → TSK → AGY → ORC → QLT → REL → UI → OPS. (Milestone A = FND-001…AGY-008 là mốc đầu tiên; làm xong dừng để người kiểm tra.)

---

## GĐ 0 — Foundation
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| FND-001 | Khởi tạo pnpm monorepo, `tsconfig` base strict, 4 package rỗng | — | `pnpm -r build` pass |
| FND-002 | ESLint + Prettier + Vitest, script `lint`, `typecheck`, `test` ở root | FND-001 | 3 lệnh pass |
| FND-003 | `packages/db`: kết nối SQLite, runner migration có bảng `_migrations`, migration 001 (tasks, features, runs, events, reports) | FND-001 | Chạy migration 2 lần không lỗi, có test |
| FND-004 | Logger JSON (timestamp, level, context) + `AppError` | FND-001 | Test log đủ trường |
| FND-005 | Load env bằng zod, `.env.example`, `.gitignore` chặn `.env` | FND-001 | Thiếu biến bắt buộc → báo lỗi rõ; không secret trong git |
| FND-006 | Hàm `checkRepoClean(path)` dùng `git status --porcelain` | FND-001 | Repo bẩn → trả lỗi, không ghi đè |

## GĐ 1 — Task Management
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| TSK-001 | Schema + model Task/Feature/Dependency (zod + repository class) | FND-003 | Migration + test CRUD |
| TSK-002 | Parser Excel/CSV (`exceljs`/`papaparse`) theo 3 sheet: Tasks, Features, Config | TSK-001 | Đọc đúng file mẫu |
| TSK-003 | Validate dữ liệu, báo lỗi theo (sheet, dòng, cột) | TSK-002 | Test từng loại lỗi |
| TSK-004 | Phát hiện trùng task_id, dependency không tồn tại | TSK-001 | Từ chối dữ liệu sai |
| TSK-005 | Phát hiện cycle (DFS/Kahn), trả về đường đi chu trình | TSK-004 | Test đồ thị có/không chu trình |
| TSK-006 | API: `POST /import` (dry-run + commit), `GET/PATCH /tasks`, `GET /features` | TSK-003, TSK-004 | Test API (inject Fastify) |
| TSK-007 | UI chọn repo + preview import, nút Xác nhận/Hủy | TSK-006 | Import được từ UI |

## GĐ 2 — AGY Worker (mốc ưu tiên)
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| AGY-001 | `ProcessAdapter`: spawn(exe, args[]), cwd, env whitelist, trả handle | FND-004 | Không dùng shell; test với `node -e` |
| AGY-002 | `NdjsonParser`: buffer theo `\n`, parse từng dòng, JSON lỗi → event `parse_error` không crash | AGY-001 | Test chunk cắt giữa dòng, dòng lỗi, dòng rỗng |
| AGY-003 | Chuẩn hóa event stream + lưu bảng `events` (run_id, seq, type, payload, ts); stdout/stderr thô cũng lưu | AGY-002, FND-003 | Log còn sau khi process chết |
| AGY-004 | Xử lý exit code + event `result` → `SUCCESS` / `ERROR` / `INVALID_OUTPUT` | AGY-002 | Test 3 trường hợp |
| AGY-005 | Timeout: SIGTERM → chờ grace → SIGKILL; hàm `stop(runId)` | AGY-001 | Process treo bị dừng đúng hạn |
| AGY-006 | Chạy trong working dir/worktree cô lập, kiểm tra cwd thuộc repo đã đăng ký | AGY-001 | Cwd sai bị từ chối |
| AGY-007 | Worker execution API: `POST /runs`, `GET /runs/:id`, `GET /runs/:id/stream` (SSE), `POST /runs/:id/stop` | AGY-003, 004, 005 | Chạy thử qua API với CLI giả |
| AGY-008 | Test CLI giả: lỗi, timeout, crash, output rác (script mock) | AGY-007 | Mỗi tình huống có test + bằng chứng |

> Prompt/flag gọi AGY: cấu hình ở `config` (executable, args mẫu có `-p`), không hard-code. Adapter nhận `AgentCommand {exe, args[], cwd}`.

## GĐ 3 — Planner & Orchestrator
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| ORC-001 | State machine task: `TODO→READY→RUNNING→VERIFYING→DONE`, `FAILED`, `BLOCKED`, `PAUSED`, `CANCELLED` | TSK-001, AGY-004 | Chuyển trạng thái trái phép → throw |
| ORC-002 | Dependency resolver: danh sách task READY | TSK-005, ORC-001 | Chỉ trả task đủ dependency |
| ORC-003 | Scheduler tuần tự, lock 1 agent, chống chạy trùng (transaction SQLite) | ORC-002, AGY-007 | Test gọi đồng thời không chạy 2 task |
| ORC-004 | Retry policy: `max_attempts`, backoff | ORC-003 | Không retry vô hạn |
| ORC-005 | Checkpoint + lịch sử lần chạy (attempt, run, kết quả) | ORC-001, AGY-003 | Truy lại từng run |
| ORC-006 | Planner: gọi AGY sinh plan JSON (task, scope file, acceptance) từ repo | ORC-002 | Plan qua zod hợp lệ |
| ORC-007 | Chế độ review: plan chờ `approve` mới chạy | ORC-006 | Chưa duyệt → không thực thi |
| ORC-008 | Điều phối theo plan đã duyệt | ORC-003, ORC-007 | Chạy đúng thứ tự dependency |

## GĐ 4 — Quality Gate
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| QLT-001 | Cấu hình lệnh kiểm định theo repo (format/lint/test/build) | ORC-003 | Đọc từ config |
| QLT-002 | Runner chạy các lệnh, lưu stdout/stderr/exit code | QLT-001 | Có bản ghi mỗi lệnh |
| QLT-003 | So diff với phạm vi task, liệt kê file ngoài phạm vi | AGY-003 | Báo đúng file lạ |
| QLT-004 | Reviewer agent: findings `{severity, file, line, message}` (zod) | QLT-003 | Output hợp lệ schema |
| QLT-005 | Security check: `pnpm audit` + quét secret (gitleaks nếu có) | QLT-001 | Kết quả thật được lưu |
| QLT-006 | Vòng sửa có giới hạn (max N) | QLT-002, QLT-004 | Hết lượt thì dừng, `FAILED` |
| QLT-007 | Quality Gate tổng hợp PASS/FAIL theo policy + bằng chứng | QLT-002, 004, 005 | Không PASS chỉ vì CLI báo SUCCESS |

## GĐ 5 — Feature Release
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| REL-001 | Xác định feature và tập task bắt buộc | ORC-008 | Danh sách task thành phần |
| REL-002 | Kiểm tra feature đủ task + integration test | REL-001, QLT-007 | Thiếu task → chặn |
| REL-003 | Tạo branch feature an toàn (không ghi đè) | REL-002 | Branch trùng → lỗi |
| REL-004 | Commit chuẩn hóa, lưu SHA | REL-003 | SHA trong DB |
| REL-005 | Push, xử lý lỗi Git, xác nhận remote branch | REL-004 | `git ls-remote` thấy branch |
| REL-006 | Tạo PR (`gh pr create`) + báo cáo release | REL-005 | Lưu URL, SHA, quality report |

## GĐ 6 — Dashboard
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| UI-001 | Layout + navigation | FND-001 | Chạy local |
| UI-002 | Danh sách task/feature + bộ lọc | TSK-006 | Dữ liệu từ API |
| UI-003 | Task detail + timeline | ORC-005 | Lịch sử thật |
| UI-004 | Live logs (SSE) + thông báo | AGY-003 | Cập nhật realtime |
| UI-005 | Diff viewer | QLT-003 | Xem diff thật |
| UI-006 | Test report + review findings | QLT-007 | Hiển thị bằng chứng |
| UI-007 | Pause/Resume/Stop/Approve | ORC-003, ORC-007 | Điều khiển backend thật |
| UI-008 | Trang release/PR | REL-006 | Hiện branch, SHA, PR URL |

## GĐ 7 — Overnight & Recovery
| ID | Làm gì | Dep | Nghiệm thu |
|---|---|---|---|
| OPS-001 | Resource & Quota Manager (concurrency, backoff) | ORC-003 | Giới hạn hoạt động |
| OPS-002 | Lịch chạy theo khung giờ | OPS-001 | Tuân thủ lịch |
| OPS-003 | Phục hồi sau restart (task RUNNING → kiểm tra → requeue/fail) | ORC-005 | Không mất lịch sử, không chạy trùng |
| OPS-004 | Kiểm tra process còn sống (PID + heartbeat) | AGY-001, OPS-003 | Phân biệt chết vs xong |
| OPS-005 | Giám sát CPU/RAM/disk, ngưỡng cảnh báo/dừng | OPS-001 | Vượt ngưỡng → dừng nhận task |
| OPS-006 | Service khởi động (launchd) + `caffeinate` giữ máy thức; hướng dẫn | OPS-002 | Tài liệu + plist |
| OPS-007 | Soak test + mô phỏng lỗi xuyên đêm | OPS-003, 004, 005 | Đạt thời lượng, không mất dữ liệu |

---

## Milestone nghiệm thu
- **A** Chạy được 1 task: FND-001 → AGY-008
- **B** Tự điều phối: TSK-001 → ORC-008
- **C** Code có kiểm định: QLT-001 → QLT-007
- **D** Bàn giao feature: REL-001 → REL-006
- **E** Vận hành bằng dashboard: UI-001 → UI-008
- **F** Chạy xuyên đêm: OPS-001 → OPS-007

## Nghiệm thu toàn sản phẩm
- [ ] Import từ chối ID trùng, thiếu dependency, chu trình
- [ ] Chạy 1 task AGY thật, xem log trực tiếp, lưu exit code
- [ ] Phân biệt CLI thành công với đạt acceptance criteria
- [ ] Không chạy task khi dependency chưa DONE
- [ ] Timeout/Stop/Pause/Resume không làm sai DB
- [ ] Restart service không mất lịch sử, không chạy trùng
- [ ] Quality gate fail thì không release
- [ ] Chỉ push khi đủ task bắt buộc + integration test
- [ ] Dashboard xem được diff, log, test report, commit, PR
- [ ] Soak test nhiều giờ + giả lập rate limit/lỗi process
