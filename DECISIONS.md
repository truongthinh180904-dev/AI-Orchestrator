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

## FND-004: Logger JSON & AppError chuẩn hóa trong `@ai-orchestrator/shared`
- **Vị trí**:
  - `AppError` và `createLogger`/`logger` được định nghĩa trong `packages/shared` (`@ai-orchestrator/shared`), làm nguồn dùng chung duy nhất cho toàn bộ hệ thống (orchestrator, dashboard, db).
  - `packages/db` phụ thuộc `@ai-orchestrator/shared: "workspace:*"` và re-export `AppError` nhằm đảm bảo tính đồng nhất kiểu dữ liệu lỗi.
- **Cấu trúc Log JSON**:
  - Mỗi bản ghi là 1 dòng JSON (NDJSON) kết thúc bằng `\n`.
  - Bắt buộc chứa 4 trường: `timestamp` (ISO-8601 UTC), `level` (`debug` | `info` | `warn` | `error`), `message` (string), `context` (Record<string, unknown>).
  - Tự động cung cấp `context: {}` khi không có context truyền vào để luôn đủ trường theo nghiệm thu.
- **Cơ chế bảo mật (Không log secrets)**:
  - Tự động lọc và che giấu (`[REDACTED]`) các key nhạy cảm: `password`, `token`, `secret`, `apikey`, `api_key`, `authorization`, `auth`, `cookie`, `credential`, `private_key`, `access_token`, `refresh_token` (không phân biệt hoa thường).
  - Sử dụng biểu thức chính quy che Bearer token (`Bearer [REDACTED]`) và các dạng API token phổ biến (`sk-*`, `ghp_*`, v.v.) trong message, context string và stack trace.
  - Sử dụng `WeakSet` chống crash đệ quy khi gặp cấu trúc dữ liệu vòng lặp (`[CIRCULAR]`).
- **Khả năng mở rộng & Test**:
  - Hỗ trợ child logger qua `logger.child(childContext)` tự động gộp ngữ cảnh cha - con.
  - Hỗ trợ `destination` tùy biến (mặc định ghi `process.stdout.write`), cho phép inject transport hoặc mock trong unit tests mà không làm ô nhiễm stdout.
  - Xử lý đối số `errorOrContext` trong `logger.error`: nhận diện `Error`/`AppError` và bóc tách `name`, `code`, `message`, `stack`, `context` an toàn.

## FND-005: Load Env bằng Zod, .env.example, .gitignore chặn .env
- **Thư viện Zod**: Cài đặt `zod` trong `packages/shared` (`@ai-orchestrator/shared`) làm thư viện validation trung tâm cho monorepo theo quy định tại `AGENTS.md`.
- **Vị trí Module**:
  - `packages/shared/src/env.ts`: Cung cấp `envSchema`, `validateEnv`, `parseEnv`, `loadEnvFile`, và `loadEnv`.
  - Re-export tại `packages/shared/src/index.ts`.
  - `apps/orchestrator` khai báo dependency `@ai-orchestrator/shared: "workspace:*"` và cung cấp `apps/orchestrator/src/config.ts` (`getOrchestratorConfig()`).
- **Schema & Biến bắt buộc**:
  - `DATABASE_PATH`: Bắt buộc (`min(1)`), nếu thiếu hoặc rỗng sẽ throw `AppError` với code `ENV_VALIDATION_ERROR` và thông báo lỗi rõ ràng.
  - `NODE_ENV`: Enum `['development', 'test', 'production']`, mặc định `'development'`.
  - `PORT`: Coerce số nguyên `1-65535`, mặc định `3000`.
  - `HOST`: Chuỗi host, mặc định `'127.0.0.1'`.
  - `LOG_LEVEL`: Enum `['debug', 'info', 'warn', 'error']`, mặc định `'info'`.
  - `AGY_BIN`: Chuỗi tên/đường dẫn executable AGY worker, mặc định `'agy'`.
  - `AGY_ARGS`: Chuỗi tham số CLI tùy chọn (e.g. `'-p'`).
  - `NEXT_PUBLIC_ORCH_URL`: URL API orchestrator cho dashboard, tùy chọn.
- **Xử lý lỗi**:
  - Hàm `formatZodError` định dạng danh sách lỗi validation theo từng trường `[FIELD] message`.
  - Ném `AppError('ENV_VALIDATION_ERROR', ...)` kèm mảng `issues` trong context để caller có thể inspect có cấu trúc.
- **An toàn bí mật (Secret Safety)**:
  - `.gitignore` cấu hình chặn `.env` và mọi file `.env.*`, chỉ ngoại lệ bỏ chặn file mẫu `!.env.example`.
  - `.env.example` tạo tại thư mục gốc, chỉ chứa template cấu hình và placeholder, tuyệt đối không chứa credentials/secrets thật.
  - Unit test tự động kiểm tra `git check-ignore` và `git ls-files` để đảm bảo không lọt secret vào Git.

## FND-006: Hàm checkRepoClean(path) dùng git status --porcelain
- **Vị trí Module**:
  - `packages/shared/src/git.ts`: Cung cấp hàm `checkRepoClean`, `getRepoStatus`, `isRepoClean`, `parseGitPorcelain` và các kiểu dữ liệu liên quan (`GitFileStatus`, `RepoStatusResult`, `CheckRepoCleanOptions`). Re-export tại `packages/shared/src/index.ts`.
  - `apps/orchestrator/src/adapters/git.ts`: Adapter Git cho Orchestrator (theo cấu trúc `SKILL-node-typescript.md`), re-export các tiện ích Git từ `@ai-orchestrator/shared` và xuất qua `apps/orchestrator/src/index.ts`.
- **Cơ chế thực thi an toàn (Process Execution)**:
  - Gọi lệnh `git` bằng `child_process.spawn('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] })`, tuyệt đối không dùng `exec` hay `shell: true` với input động để tuân thủ quy tắc bảo mật của `AGENTS.md`.
  - Bắt lỗi khi không tìm thấy `git` trong PATH (`GIT_NOT_FOUND`) hoặc lỗi khởi tạo process (`GIT_SPAWN_ERROR`).
- **Phát hiện thư mục không hợp lệ**:
  - Kiểm tra sự tồn tại của thư mục qua `fs.existsSync` (`PATH_NOT_FOUND`) và `fs.statSync().isDirectory()` (`NOT_A_DIRECTORY`).
  - Kiểm tra repository Git hợp lệ qua mã thoát và stderr của git (`NOT_A_GIT_REPO`).
- **Phân tích cú pháp Porcelain**:
  - `parseGitPorcelain`: Phân tách các dòng định dạng `git status --porcelain` (v1), bóc tách 2 ký tự trạng thái `indexStatus`, `workTreeStatus`, đường dẫn file `path`, hỗ trợ phát hiện file đổi tên (`old -> new`) và gỡ bỏ dấu ngoặc kép khi Git quote đường dẫn chứa khoảng trắng.
- **Quy tắc nghiệm thu "Repo bẩn → trả lỗi, không ghi đè"**:
  - `checkRepoClean` ném `AppError` với mã lỗi `REPO_DIRTY` khi phát hiện thay đổi chưa commit (staged, unstaged, untracked, deleted).
  - Ngữ cảnh lỗi (`context`) lưu chi tiết: `dirtyCount`, mảng `dirtyFiles` và chuỗi raw output để phục vụ debug và log.
  - Hỗ trợ tùy chọn `allowedFiles` (cho phép bỏ qua các file trong phạm vi task hợp lệ) và `ignoreUntracked` (tùy chọn bỏ qua file chưa theo dõi).
  - Cung cấp `isRepoClean` và `getRepoStatus` cho các trường hợp chỉ cần kiểm tra trạng thái mà không ném ngoại lệ.
  - Đảm bảo cơ chế bảo vệ: khi gọi `checkRepoClean` trước các thao tác thay đổi file, lỗi `REPO_DIRTY` lập tức chặn thực thi, bảo vệ không làm mất hoặc ghi đè dữ liệu chưa commit.


## TSK-001: Schema + model Task/Feature/Dependency (zod + repository class)
- **Vị trí Module**:
  - `packages/shared/src/models/`: Chứa các định nghĩa Zod schemas và TypeScript types cho `Task`, `Feature`, `TaskDependency` cùng các input schemas (`CreateTaskInput`, `UpdateTaskInput`, `CreateFeatureInput`, `UpdateFeatureInput`, `TaskFilter`, `FeatureFilter`).
  - `packages/db/src/repositories/`: Chứa các repository classes `TaskRepository`, `FeatureRepository`, `TaskDependencyRepository`. Re-export qua `packages/db/src/index.ts`.
- **Thiết kế Schema & Zod Types**:
  - Tách bạch giữa Zod output type (`z.infer` / `z.output`) cho entity đã qua validation và input type (`z.input`) cho các hàm nhận tham số create/update nhằm hỗ trợ giá trị mặc định (defaults) mà không bắt buộc caller phải truyền vào.
  - Trạng thái Task (`TaskStatus`): bao gồm 9 trạng thái chuẩn theo ORC-001 (`TODO`, `READY`, `RUNNING`, `VERIFYING`, `DONE`, `FAILED`, `BLOCKED`, `PAUSED`, `CANCELLED`).
  - Trạng thái Feature (`FeatureStatus`): `TODO`, `IN_PROGRESS`, `DONE`, `FAILED`, `BLOCKED`.
- **Cơ chế lưu trữ SQLite & Tuân thủ SKILL-sqlite.md**:
  - Sử dụng prepared statements với parameterized queries (`?`), tuyệt đối không nối chuỗi SQL.
  - Các trường mảng (`acceptance_criteria`, `test_commands`, `required_tasks`, `integration_tests`) được serialize thành chuỗi JSON trong SQLite và deserialize + validate an toàn qua Zod khi đọc ra.
  - Đồng bộ quan hệ nhiều bước (như tạo task kèm dependencies hoặc sync dependencies) được bọc trong `db.transaction(...)` nhằm bảo đảm tính toàn vẹn dữ liệu.
  - Sử dụng batch query dependencies theo danh sách task IDs trong `findAll()` để loại bỏ hoàn toàn vấn đề N+1 query.
  - Bắt lỗi SQLite constraint (`SQLITE_CONSTRAINT_PRIMARYKEY`, `SQLITE_CONSTRAINT_FOREIGNKEY`) và chuyển đổi thành `AppError` tương ứng (`TASK_ALREADY_EXISTS`, `FEATURE_ALREADY_EXISTS`, `DEPENDENCY_ALREADY_EXISTS`, `FOREIGN_KEY_VIOLATION`, `SELF_DEPENDENCY_ERROR`, `TASK_NOT_FOUND`, `FEATURE_NOT_FOUND`).

## TSK-002: Parser Excel/CSV (exceljs/papaparse) theo 3 sheet: Tasks, Features, Config
- **Dependencies mới**:
  - `exceljs` (^4.4.0): Phục vụ đọc/ghi file định dạng Excel (`.xlsx`), parse các sheet và cấu trúc cell đa dạng (richText, formulas, hyperlinks, dates).
  - `papaparse` (^5.7.0) & `@types/papaparse` (^5.5.2): Phục vụ parse dữ liệu định dạng CSV tốc độ cao, hỗ trợ tự động nhận diện delimiter, xử lý quotes và multiline fields.
  - Vị trí cài đặt: `packages/shared` (`@ai-orchestrator/shared`) để cung cấp khả năng parse dùng chung cho backend Orchestrator, CLI, và các công cụ import.
- **Cấu trúc Module**:
  - `packages/shared/src/parser/types.ts`: Định nghĩa kiểu dữ liệu Zod schemas cho `ParsedTaskRow`, `ParsedFeatureRow`, `ParsedConfig`, `ParsedWorkbookResult` cùng bảng tra cứu bí danh tiêu đề cột (`TASK_HEADER_ALIASES`, `FEATURE_HEADER_ALIASES`, `CONFIG_HEADER_ALIASES`) và các hàm tiện ích bóc tách cell/chuỗi/danh sách.
  - `packages/shared/src/parser/mappers.ts`: Chuẩn hóa tiêu đề cột theo alias tiếng Anh / tiếng Việt (`Mã task`, `Tiêu đề`, `Nghiệm thu`, `Lệnh test`, `Phụ thuộc`, v.v.), map an toàn từng dòng về entity, xử lý giá trị mặc định (`priority: 0`, `max_attempts: 3`, `timeout_minutes: 30`, `status: TODO`).
  - `packages/shared/src/parser/excel.ts`: `parseExcelWorkbook` đọc từ đường dẫn file hoặc `Buffer`, tìm sheet không phân biệt chữ hoa/thường (`Tasks`, `Features`, `Config`). Cung cấp `createSampleExcelWorkbook` tạo workbook mẫu.
  - `packages/shared/src/parser/csv.ts`: `parseCsvSheet`, `parseCsvFiles`, `parseCsvDirectory` hỗ trợ đọc từ thư mục chứa các file `tasks.csv`, `features.csv`, `config.csv` hoặc từ đối tượng key-value mã nguồn CSV. Cung cấp `createSampleCsvFiles` tạo nội dung CSV mẫu.
  - `packages/shared/src/parser/index.ts`: Hàm `parseImportFile` thống nhất, tự động nhận biết định dạng nguồn (đường dẫn `.xlsx`/`.csv`/thư mục, Buffer với filename hint, hoặc đối tượng files) và trả về kết quả cấu trúc chuẩn `ParsedWorkbookResult`.
- **Hỗ trợ định dạng Config linh hoạt**:
  - Format 1 (Key-Value): Dòng có 2 cột `key` và `value` (hoặc `setting` và `val`), gom tất cả các cặp khóa - giá trị.
  - Format 2 (Horizontal Row): Dòng đầu là các tiêu đề cột thuộc tính (`repository`, `agy_bin`, `agy_args`, `verify_commands`, ...), dòng kế là giá trị.
  - Các cấu hình ngoài danh mục chuẩn tự động được lưu vào `settings: Record<string, unknown>`.
- **An toàn & Kiểm soát lỗi**:
  - Bắt buộc phải có sheet/file `Tasks` (nếu thiếu throw `AppError('MISSING_SHEET')`).
  - File không tồn tại throw `AppError('FILE_NOT_FOUND')`, thư mục không tồn tại throw `AppError('DIRECTORY_NOT_FOUND')`, định dạng không hỗ trợ throw `AppError('UNSUPPORTED_FILE_TYPE')`, file hỏng/rỗng throw `AppError('INVALID_FILE_FORMAT')`/`AppError('EMPTY_FILE')`.
- **Fixtures mẫu**:
  - Tạo `fixtures/sample-tasks.xlsx` và `fixtures/sample-csv/` (`tasks.csv`, `features.csv`, `config.csv`) làm file mẫu phục vụ nghiệm thu và kiểm thử tự động.

## TSK-003: Validate dữ liệu, báo lỗi theo (sheet, dòng, cột)
- **Vị trí Module**:
  - `packages/shared/src/validator/`: Xây dựng module validation toàn diện gồm `types.ts`, `formatters.ts`, `taskValidator.ts`, `featureValidator.ts`, `configValidator.ts`, `workbookValidator.ts` và `index.ts`. Re-export qua `@ai-orchestrator/shared`.
- **Định dạng báo lỗi theo (sheet, dòng, cột)**:
  - Cấu trúc `ValidationErrorItem`:
    - `sheet`: Tên sheet ('Tasks', 'Features', 'Config').
    - `row`: Số dòng 1-based trong sheet hoặc file dữ liệu.
    - `column`: Tên cột / thuộc tính (e.g. `'id'`, `'title'`, `'status'`, `'priority'`, `'max_attempts'`, `'timeout_minutes'`, `'dependencies'`, v.v.).
    - `code`: Mã lỗi chuẩn (`REQUIRED_FIELD`, `INVALID_IDENTIFIER_FORMAT`, `INVALID_STATUS`, `INVALID_INTEGER`, `VALUE_OUT_OF_RANGE`, `STRING_TOO_LONG`, `SELF_DEPENDENCY`, `EMPTY_LIST_ITEM`, `INVALID_WORKER_TYPE`, `INVALID_REPOSITORY`, `INVALID_EXECUTABLE`, `MISSING_REQUIRED_SHEET`, `EMPTY_SHEET`, `MISSING_REQUIRED_COLUMN`, `UNKNOWN_COLUMN`).
    - `message`: Thông báo chi tiết bằng tiếng Việt rõ ràng, dễ hiểu.
    - `value`: Giá trị lỗi (nếu có).
    - `severity`: `'error'` | `'warning'`.
  - Format hiển thị chuẩn: `[Sheet: dòng X, cột 'Y'] (CODE) Message [Giá trị: ...]`.
- **Cơ chế kiểm soát đa tầng (Raw + Parsed)**:
  - Validator hỗ trợ xác thực cả các dòng dữ liệu thô (`Record<string, unknown>` / `RawRow`) lẫn các entity đã được parse (`ParsedTaskRow`, `ParsedFeatureRow`, `ParsedConfig`).
  - Hỗ trợ đầy đủ các alias tiêu đề cột tiếng Anh và tiếng Việt (`Mã task`, `Tiêu đề`, `Độ ưu tiên`, `Trạng thái`, v.v.).
  - Bắt toàn bộ lỗi và cảnh báo (không fail-fast ở lỗi đầu tiên), trả về `ValidationReport` tổng thể gồm danh sách lỗi, cảnh báo và chuỗi tóm tắt `summary`.
- **Xử lý ngoại lệ**:
  - Cung cấp `WorkbookValidationError` kế thừa từ `AppError` (`code: 'VALIDATION_FAILED'`), chứa report chi tiết trong `context`.
  - Cung cấp `assertValidWorkbook` tự động ném `WorkbookValidationError` khi dữ liệu không hợp lệ.
  - Cung cấp `parseAndValidateWorkbook` kết hợp parser (TSK-002) và validator (TSK-003) làm điểm vào thuận tiện cho API import (TSK-006).

## TSK-004: Phát hiện trùng task_id, dependency không tồn tại — Từ chối dữ liệu sai
- **Module quan hệ thực thể (packages/shared/src/validator/relationshipValidator.ts)**:
  - `validateTaskIdsUniqueness`:
    - Quét toàn bộ danh sách task trong sheet Tasks hoặc batch import.
    - Phát hiện trùng lặp task_id nội bộ trong tập dữ liệu, báo lỗi tọa độ `(Tasks, dòng X, id)` với mã `DUPLICATE_TASK_ID` và thông điệp chỉ rõ dòng xuất hiện trước đó.
    - Kiểm tra đối chiếu với `options.existingTaskIds` (hoặc DB), báo lỗi `DUPLICATE_TASK_ID` khi mã task đã tồn tại trong hệ thống.
  - `validateFeatureIdsUniqueness`:
    - Phát hiện trùng lặp `feature_id` trong sheet Features và với `options.existingFeatureIds`, báo lỗi `DUPLICATE_FEATURE_ID`.
  - `validateDependenciesExistence`:
    - Tập hợp tất cả các task_id hợp lệ từ batch hiện tại và `options.existingTaskIds`.
    - Mặc định bổ sung `FOUNDATION_TASK_IDS` (`FND-001` ... `FND-006`) làm các task nền tảng đã hoàn thành của hệ thống khi không truyền `options.existingTaskIds`, giúp các task nghiệp vụ tham chiếu dependency nền tảng (như file mẫu `sample-tasks.xlsx`) được chấp thuận tự nhiên mà không cần cấu hình thêm.
    - Báo lỗi tọa độ `(Tasks, dòng X, dependencies)` với mã lỗi `NON_EXISTENT_DEPENDENCY` (kèm alias `MISSING_DEPENDENCY`) cho từng dependency không tồn tại.
  - `validateCrossEntityReferences`:
    - Báo lỗi `MISSING_FEATURE` khi `task.feature_id` không tồn tại trong sheet Features hoặc `existingFeatureIds`.
    - Báo lỗi `MISSING_REQUIRED_TASK` khi `feature.required_tasks` tham chiếu task không tồn tại.
  - `validateRelationships`: Gom tất cả các kiểm tra quan hệ trên và tích hợp tự động vào cả `validateWorkbook` lẫn `validateRawWorkbook`.
- **Cơ chế từ chối dữ liệu sai (assertValidWorkbook)**:
  - Khi có bất kỳ lỗi trùng task_id hoặc dependency không tồn tại nào, `validateWorkbook` và `validateRawWorkbook` thiết lập `valid: false` và liệt kê chi tiết trong `errors`.
  - `assertValidWorkbook` tự động ném `WorkbookValidationError` (kế thừa `AppError`) chứa toàn bộ thông tin chi tiết về các lỗi này, ngăn chặn triệt để dữ liệu sai lọt vào hệ thống.
- **Tầng cơ sở dữ liệu (TaskRepository & TaskDependencyRepository)**:
  - Bổ sung `findMissingDependencies(dependencies: string[])` trên `TaskRepository`: truy vấn nhanh và trả về danh sách các ID dependency chưa có trong DB.
  - Cải tiến `create()` và `update()`: kiểm tra trước các dependency tham chiếu, ném `AppError('FOREIGN_KEY_VIOLATION')` hoặc `TASK_ALREADY_EXISTS` rõ ràng kèm context.
  - Cải tiến `addDependency()`: kiểm tra sự tồn tại của task đích trước khi insert.
  - Bổ sung `createMany()`: Thực hiện nạp hàng loạt (bulk create) theo mô hình giao dịch nguyên tử (atomic transaction).
    - Kiểm tra trùng lặp ID trong batch (`DUPLICATE_TASK_ID`).
    - Kiểm tra trùng lặp ID với DB (`TASK_ALREADY_EXISTS`).
    - Kiểm tra toàn bộ dependency (nội bộ batch + DB) (`FOREIGN_KEY_VIOLATION`).
    - Nếu xảy ra bất kỳ lỗi nào, toàn bộ giao dịch bị rollback và không có task nào được ghi vào cơ sở dữ liệu ("Từ chối dữ liệu sai").

## TSK-005: Phát hiện cycle (DFS/Kahn), trả về đường đi chu trình
- **Module đồ thị phụ thuộc (`packages/shared/src/graph/`)**:
  - `DependencyGraph`: Lớp biểu diễn đồ thị có hướng (Directed Graph) chuyên biệt cho quan hệ phụ thuộc giữa các task. Lưu trữ cả chiều thuận `dependencies` (task u phụ thuộc vào v) và chiều nghịch `dependents` (task v là điều kiện tiên quyết của u).
  - **Thuật toán DFS 3 trạng thái màu (White/Gray/Black)**:
    - Trạng thái `0` (UNVISITED), `1` (VISITING / trong call stack), `2` (VISITED).
    - Khi duyệt cạnh `u -> v` mà `v` đang ở trạng thái `1` (VISITING), phát hiện cạnh ngược (back-edge).
    - Trích xuất trực tiếp đường đi chu trình từ mảng call stack: `cycle = currentPath.slice(startIndex).concat([v])` (ví dụ: `['A', 'B', 'C', 'A']`).
    - Hỗ trợ `findAllCyclesDFS()`: thu thập và chuẩn hóa tất cả các chu trình đơn (simple cycles) riêng biệt trong đồ thị.
  - **Thuật toán Kahn (Topological Sort dựa trên In-Degree)**:
    - Trong đồ thị thực thi, task u chỉ có thể chạy khi tất cả các task v mà u phụ thuộc vào đã chạy xong. In-degree của u tương ứng với số lượng dependencies chưa được hoàn thành của u.
    - Hàng đợi khởi tạo với các task có `inDegree === 0` (sẵn sàng chạy ngay). Sắp xếp theo `priority` (giảm dần) và `id` (tăng dần) để thứ tự chạy hoàn toàn xác định.
    - Nếu tổng số node xếp được sau khi hàng đợi rỗng < tổng số node, đồ thị tồn tại chu trình.
    - Thuật toán xác định tập node có `inDegree > 0` và truy vết theo các cạnh dependency còn lại để tái tạo đường đi chu trình khép kín `[v, ..., v]`.
  - **Hàm tiện ích**:
    - `formatCyclePath(cycle)`: Chuyển đổi mảng chu trình thành chuỗi biểu diễn trực quan: `'A -> B -> C -> A'`.
    - `canonicalizeCycle(cycle)`: Chuẩn hóa chu trình về node bắt đầu có mã nhỏ nhất theo bảng chữ cái.
    - `detectCycleDFS`, `detectCycleKahn`, `detectCycle`, `findCycle`, `topologicalSort`.
- **Tích hợp tầng Validation (`packages/shared/src/validator/`)**:
  - Bổ sung mã lỗi `CIRCULAR_DEPENDENCY` và alias `CYCLE_DETECTED` trong `VALIDATION_ERROR_CODES`.
  - `validateDependencyCycles`: Xây dựng `DependencyGraph` từ danh sách task, kiểm tra chu trình và gắn lỗi tọa độ `(sheet: 'Tasks', row: X, column: 'dependencies')` cho từng task tham gia chu trình kèm chuỗi đường đi trực quan.
  - Tự động tích hợp vào `validateRelationships`, áp dụng cho cả `validateWorkbook` và `validateRawWorkbook`.
  - `assertValidWorkbook` ném `WorkbookValidationError` khi workbook chứa chu trình phụ thuộc.
- **Tích hợp tầng Database Repositories (`packages/db`)**:
  - `TaskDependencyRepository.add()` và `setForTask()`: Kiểm tra trước xem thao tác thêm/cập nhật dependency có tạo chu trình với các task hiện có trong DB hay không. Nếu có, ném `AppError('CIRCULAR_DEPENDENCY_ERROR')` kèm thông tin chu trình và từ chối ghi dữ liệu.
  - `TaskRepository.createMany()`: Thực hiện kiểm tra chu trình (bằng batch graph kết hợp các dependency trong DB) trước khi ghi vào cơ sở dữ liệu. Nếu phát hiện chu trình, ném `AppError('CIRCULAR_DEPENDENCY_ERROR')` và rollback toàn bộ transaction.
  - `TaskRepository.detectCycle()`: Kiểm tra trạng thái chu trình trên toàn bộ cơ sở dữ liệu hiện hành.
  - `TaskRepository.getExecutionOrder()`: Trả về danh sách mã task theo đúng thứ tự thực thi tô-pô (topological sort), ném `AppError('CIRCULAR_DEPENDENCY_ERROR')` nếu DB bị vướng chu trình.




## TSK-006: API POST /import (dry-run + commit), GET/PATCH /tasks, GET /features
- **Kiến trúc Fastify & Dependency Injection**:
  - `buildServer(options: BuildServerOptions)` trong `apps/orchestrator/src/server.ts`: Nhận database instance (`better-sqlite3`), logger và config tùy chọn; không dùng singleton toàn cục; tối ưu hóa cho test automation qua Fastify `app.inject()`.
  - Bootstrap tại `apps/orchestrator/src/main.ts`: Khởi tạo môi trường (`loadEnv()`), kết nối DB SQLite (`createDatabase()`), áp dụng migrations (`runMigrations()`), lắng nghe theo cổng/host cấu hình và thiết lập graceful shutdown bắt tín hiệu `SIGINT`/`SIGTERM`.
  - Phân tầng rõ ràng theo `SKILL-node-typescript.md`:
    - `routes/`: validate input bằng `zod`, ánh xạ controller.
    - `services/`: nghiệp vụ thuần túy không phụ thuộc framework (`ImportService`, `TaskService`, `FeatureService`).
- **Dependencies mới**:
  - Thêm `fastify` và `@fastify/multipart` vào `apps/orchestrator` để xử lý HTTP REST API và upload file multipart/form-data.
  - Thêm `fastify` và `@types/better-sqlite3` vào root workspace `devDependencies` để phục vụ typecheck các acceptance tests tại `test/`.
  - Thêm `zod` và `@types/better-sqlite3` vào `apps/orchestrator`.
- **API POST /import (dry-run + commit)**:
  - Hỗ trợ đa dạng nguồn đầu vào: `filePath`, `buffer` (qua multipart upload), `fileContent` (chuỗi CSV hoặc base64), `files` (record CSV) hoặc `tasks`/`features` mảng object thô.
  - Chế độ `dry-run` (`dryRun: true` hoặc `mode: 'dry-run'`): Parse và validate toàn bộ tập dữ liệu, trả về `{ dryRun: true, valid, summary, report, preview }`, cam kết không sửa đổi cơ sở dữ liệu SQLite. Nếu phát hiện lỗi (trùng task_id, dependency không tồn tại, cycle), báo cáo chi tiết qua `report` mà không quăng lỗi crash.
  - Chế độ `commit` (`mode: 'commit'` hoặc `dryRun: false`): Nếu dữ liệu không hợp lệ, ném `AppError('IMPORT_VALIDATION_FAILED')` kèm chi tiết lỗi và từ chối ghi; nếu hợp lệ, thực thi ghi toàn bộ features, tasks và dependencies trong 1 transaction SQLite nguyên tử (atomic rollback nếu lỗi).
  - Tự động gieo mầm (auto-seed) các task mốc Foundation (`FND-001` ... `FND-006`) với trạng thái `DONE` khi import task có dependency tham chiếu đến chúng mà DB chưa có sẵn, bảo đảm các file mẫu như `sample-tasks.xlsx` hoạt động tự nhiên với ràng buộc khóa ngoại SQLite.
- **API GET/PATCH /tasks & GET /features**:
  - `GET /tasks`: Lấy danh sách task kèm `dependencies`, hỗ trợ query filter `status`, `feature_id`, `phase` và tìm kiếm text `search`.
  - `GET /tasks/:id`: Chi tiết task theo ID, trả về 404 `TASK_NOT_FOUND` nếu không tồn tại.
  - `PATCH /tasks/:id` & `PATCH /tasks`: Cập nhật linh hoạt các trường task, kiểm tra chặt chẽ schema zod; ném `FOREIGN_KEY_VIOLATION` nếu gán dependency không tồn tại; ném `CIRCULAR_DEPENDENCY_ERROR` nếu tạo chu trình phụ thuộc; ném 404 nếu không tìm thấy task.
  - `GET /features`: Danh sách feature, hỗ trợ filter `status`.
  - `GET /features/:id`: Chi tiết feature theo ID, trả về 404 `FEATURE_NOT_FOUND` nếu không tồn tại.
  - Hỗ trợ bí danh route song song `/api/import`, `/api/tasks`, `/api/features` và `/api/health`.
- **Xử lý lỗi tập trung (Error Handling)**:
  - Bắt và chuẩn hóa `AppError` thành mã HTTP tương ứng (404 cho `NOT_FOUND`, 409 cho `ALREADY_EXISTS`/`DUPLICATE`, 400 cho `VALIDATION_ERROR`/`CIRCULAR_DEPENDENCY`/`FOREIGN_KEY_VIOLATION`/`IMPORT_VALIDATION_FAILED`).
  - Định dạng phản hồi chuẩn hóa `{ error: { code, message, context } }` và `{ data: ... }` khi thành công.


## TSK-007: UI chọn repo + preview import, nút Xác nhận/Hủy
- **Kiến trúc Next.js App Router theo SKILL-nextjs-dashboard.md**:
  - `apps/dashboard`: Next.js 15 (App Router) + React 19 + TypeScript strict.
  - Phân tách vai trò rõ ràng: Dashboard chỉ hiển thị và điều khiển thao tác; toàn bộ nghiệp vụ kiểm tra và lưu trữ nằm ở Orchestrator API.
  - `apps/dashboard/src/lib/api.ts`: API client duy nhất cho toàn bộ dashboard, lấy base URL từ biến môi trường `NEXT_PUBLIC_ORCH_URL` (hoặc fallback `http://127.0.0.1:3000`). Mọi lỗi phản hồi từ API được unwrap chuẩn hóa thành `AppError` kèm `code`, `message`, `context`.
  - Kiểu dữ liệu (`ImportDryRunResult`, `ImportCommitResult`, `TaskWithDependencies`, `Feature`, v.v.) được định nghĩa tập trung trong `packages/shared/src/models/import.ts` và dùng chung toàn monorepo.
- **Dependencies mới**:
  - `next@15.1.7`, `react@19`, `react-dom@19` trong `apps/dashboard` để phục vụ Dashboard UI theo quy định tại `AGENTS.md`.
  - `@testing-library/react` và `happy-dom` trong `apps/dashboard` (devDependencies) để kiểm thử component UI nhanh chóng mà không cần trình duyệt thật.
- **Thiết kế Components**:
  - `RepoSelector`: Hỗ trợ người dùng nhập đường dẫn repository (`.` mặc định) và lựa chọn linh hoạt nguồn file: đường dẫn file máy chủ (`filePath`), upload file (`fileUpload` qua multipart FormData), hoặc nhập trực tiếp nội dung CSV (`rawCsv`).
  - `ImportPreview`: Hiển thị huy hiệu trạng thái (`HỢP LỆ (READY TO COMMIT)` hoặc `KHÔNG HỢP LỆ (HAS ERRORS)`), 4 thẻ thống kê số lượng (Tasks, Features, Errors, Warnings), bảng danh sách lỗi chi tiết nếu có (Sheet, Dòng, Cột, Mã lỗi, Thông báo), và bảng xem trước các Tasks kèm quan hệ phụ thuộc (`dependencies`) và Features.
  - `ImportWorkflow`: Điều phối 3 bước luồng thao tác người dùng:
    - Nút "Xem trước (Preview Import)": Gọi API dry-run, kích hoạt hiển thị `ImportPreview`.
    - Nút "Xác nhận Nhập (Confirm Import)": Chỉ kích hoạt khi bản xem trước hợp lệ (`valid: true`) và không có lỗi; bị vô hiệu hóa (`disabled`) khi chưa có preview, preview có lỗi, hoặc đang thực thi (`isLoading`).
    - Nút "Hủy bỏ (Reset)": Đưa giao diện về trạng thái ban đầu, xóa bỏ dữ liệu xem trước và thông báo lỗi.
    - Hiển thị banner lỗi đỏ khi API thất bại và banner thành công xanh khi hoàn tất import.
- **Chiến lược Test & Nghiệm thu**:
  - 11 unit tests cho `ApiClient` với các kịch bản JSON, multipart FormData, xử lý lỗi mạng và unwrap `AppError`.
  - 11 component tests với `@testing-library/react` mô phỏng đầy đủ tương tác người dùng: nhập form, chuyển tab CSV, kích hoạt preview, kiểm tra trạng thái disabled của nút Xác nhận khi có lỗi, và luồng commit thành công.
  - 5 acceptance tests trong `test/tsk-007.test.ts` khởi động máy chủ Fastify và SQLite in-memory thật, xác thực rằng người dùng thao tác qua UI client thực sự preview được file mẫu, xác nhận dry-run không làm thay đổi DB, và xác nhận thao tác commit ghi nhận chính xác 100% dữ liệu vào SQLite.

## AGY-001: ProcessAdapter: spawn(exe, args[]), cwd, env whitelist, trả handle
- **Nguyên tắc an toàn tiến trình (Process Security)**:
  - Tuân thủ nghiêm ngặt `AGENTS.md` và `SKILL-process-ndjson.md`: Tuyệt đối không dùng shell (`shell: false`). Cấm ghép chuỗi lệnh từ input động, chỉ nhận `exe` và mảng đối số `args: string[]`.
  - Kiểm tra và xác thực `AgentCommand` bằng schema `AgentCommandSchema` (`zod`).
  - Kiểm tra hợp lệ thư mục làm việc `cwd` bằng `fs.existsSync` và `fs.statSync().isDirectory()`. Nếu không hợp lệ, ném `AppError('INVALID_WORKING_DIRECTORY')` trước khi gọi `spawn`.
- **Cơ chế Env Whitelist an toàn (Không lộ secrets/tokens)**:
  - Xây dựng hàm `buildProcessEnv()` trong `packages/shared/src/models/agent-command.ts`.
  - Mặc định chỉ lọc và cho phép các biến hệ thống cơ bản cần thiết trong `DEFAULT_ENV_WHITELIST` (`PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `LANG`, `TERM`, `NODE_ENV`, `NODE_PATH`, `SSH_AUTH_SOCK`, `GIT_EXEC_PATH`, `AGY_BIN`, `AGY_ARGS`, v.v.).
  - Mọi biến nhạy cảm như secret keys, passwords, database credentials, API tokens trong `process.env` đều bị loại trừ hoàn toàn khỏi tiến trình con.
  - Cho phép người gọi bổ sung biến chủ đích qua `command.env` hoặc mở rộng danh sách trắng qua `command.extraEnvWhitelist`.
- **ProcessHandle & Quản lý vòng đời tiến trình**:
  - `ProcessAdapter.spawn()` trả về đối tượng `ProcessHandle` (kế thừa `EventEmitter`) cung cấp: `pid`, `child`, `stdout` (Readable), `stderr` (Readable), `command`, `startedAt`, `isRunning()`, `waitForExit(): Promise<ProcessExitResult>`, `kill(signal)`, `getExitResult()`.
  - Chờ sự kiện `close` (thay vì chỉ `exit`) để đảm bảo các luồng `stdout` và `stderr` đã được flush hoàn toàn theo hướng dẫn tại `SKILL-process-ndjson.md`.
  - Bắt lỗi bất đồng bộ khi khởi tạo tiến trình (ví dụ lỗi `ENOENT` khi binary không tồn tại) mà không gây unhandled promise rejection; đồng thời đảm bảo `waitForExit()` reject bằng `AppError('PROCESS_EXECUTION_ERROR')`.
  - Hỗ trợ cờ `detached` cho phép kill process group (`process.kill(-pid, signal)`) khi tiến trình con tạo sub-processes.
- **Dependencies**: Không thêm dependency mới (sử dụng `node:child_process`, `node:events`, `node:fs`, `node:path`, `zod` và `@ai-orchestrator/shared`).

## AGY-002: NdjsonParser (buffer theo \n, parse từng dòng, JSON lỗi → event parse_error không crash)
- **Vị trí Module**:
  - `packages/shared/src/models/ndjson.ts`: Định nghĩa các Zod schema và TypeScript types cho các sự kiện NDJSON (`NdjsonParsedEventSchema`, `NdjsonParseErrorEventSchema`, `NdjsonStreamEventSchema`, `NdjsonParserOptionsSchema`, `DEFAULT_MAX_LINE_LENGTH`). Re-export qua `packages/shared/src/models/index.ts` và `@ai-orchestrator/shared`.
  - `apps/orchestrator/src/adapters/ndjson-parser.ts`: Lớp `NdjsonParser` kế thừa `node:stream.Transform` và cung cấp giao diện xử lý luồng dữ liệu / sự kiện. Re-export qua `apps/orchestrator/src/adapters/index.ts` và `@ai-orchestrator/orchestrator`.
- **Cơ chế Buffer và UTF-8 Streaming**:
  - Sử dụng `node:string_decoder.StringDecoder('utf8')` giải mã từng chunk để đảm bảo các ký tự UTF-8 đa byte (như tiếng Việt có dấu, emoji 4-byte 🚀) khi bị cắt ngang giữa các chunk không bao giờ bị biến thành ký tự rác `\uFFFD`.
  - Phân tách theo ký tự xuống dòng `\n`, tự động loại bỏ ký tự `\r` (Windows CRLF) ở cuối dòng nếu có.
  - Phần dữ liệu chưa kết thúc bằng `\n` được giữ lại trong bộ đệm nội bộ (`_buffer`) và tiếp tục ghép với chunk kế tiếp; khi stream kết thúc (`flush()` hoặc `_flush()`), phần dữ liệu còn lại trong bộ đệm được parse trọn vẹn.
- **Quy tắc bỏ dòng rỗng & Khoảng trắng**:
  - Các dòng rỗng hoàn toàn (`\n`, `\r\n`) được bỏ qua, không phát sinh sự kiện và không tính vào bộ đếm `seq`.
  - Tùy chọn `ignoreWhitespaceOnly: true` (mặc định) cho phép bỏ qua các dòng chỉ chứa khoảng trắng hoặc tab (`   \n`, `\t\t\n`).
- **Xử lý lỗi JSON an toàn (Không crash)**:
  - Khi `JSON.parse` thất bại hoặc gặp dữ liệu không phải JSON, parser phát sự kiện `'parse_error'` chứa: `seq` (tăng dần), `type: 'parse_error'`, `raw` (dòng gốc), `error` (đối tượng Error), `errorMessage` (chuỗi mô tả lỗi), `timestamp` (ISO-8601).
  - Tên sự kiện được đặt rõ ràng là `parse_error` thay vì `error` của EventEmitter, nhờ đó Node.js tuyệt đối không throw Uncaught Exception ngay cả khi người gọi không gắn listener cho sự kiện này.
  - Parser tự động phục hồi ngay lập tức, tiếp tục tiếp nhận và parse các dòng hợp lệ tiếp theo mà không làm gián đoạn luồng dữ liệu.
- **Bảo vệ chống tràn bộ nhớ (Memory Exhaustion Protection)**:
  - Hỗ trợ tham số cấu hình `maxLineLength` (mặc định 1MB = `1024 * 1024`).
  - Nếu một dòng hoặc bộ đệm không có ký tự newline vượt quá `maxLineLength`, parser sẽ phát sự kiện `parse_error` và xóa bộ đệm để ngăn chặn tấn công DoS hoặc tràn RAM khi tiến trình con in output rác vô hạn.
- **Bộ đếm Sequence (`seq`) đơn điệu tăng dần**:
  - Mỗi sự kiện hợp lệ (`event`) và mỗi sự kiện lỗi (`parse_error`) đều được gán `seq` duy nhất tăng dần liên tục (bắt đầu từ 1 hoặc `initialSeq`), sẵn sàng phục vụ việc ghi nhận vào bảng SQLite `events` ở task AGY-003.
- **Khả năng tương thích Stream & Piping**:
  - `NdjsonParser` mở rộng `Transform` stream với `readableObjectMode: true`, cho phép pipe trực tiếp từ `handle.stdout` của `ProcessAdapter`.
  - Khởi tạo mặc định với `this.resume()` để chế độ stream luôn flowing, ngăn chặn tình trạng tắc nghẽn bộ đệm highWaterMark khi người dùng chỉ lắng nghe sự kiện qua EventEmitter (`parser.on('event', ...)`).
  - Cung cấp phương thức đồng bộ `NdjsonParser.parse()` và phương thức bất đồng bộ `NdjsonParser.parseStream()` phục vụ kiểm thử và xử lý nhanh NDJSON.
- **Dependencies**: Không thêm dependency bên ngoài mới (sử dụng thư viện chuẩn `node:string_decoder`, `node:stream`, `zod` và `@ai-orchestrator/shared`).


## AGY-003: Chuẩn hóa event stream + lưu bảng events (run_id, seq, type, payload, ts; stdout/stderr thô cũng lưu)
- **Vị trí Module**:
  - `packages/shared/src/models/run.ts`: Schema & types cho `Run`, `RunStatus` (`PENDING`, `RUNNING`, `SUCCESS`, `ERROR`, `INVALID_OUTPUT`, `TIMEOUT`, `CANCELLED`), `CreateRunInput`, `UpdateRunInput`.
  - `packages/shared/src/models/event.ts`: Schema & types cho `EventRecord`, `CreateEventInput`, `EventFilter`, hằng số các loại sự kiện chuẩn `STANDARD_EVENT_TYPES` (`stdout`, `stderr`, `parse_error`, `process_start`, `process_exit`). Re-export qua `packages/shared/src/models/index.ts` và `@ai-orchestrator/shared`.
  - `packages/db/src/repositories/run-repository.ts`: Lớp `RunRepository` thao tác CRUD với bảng `runs` bằng SQLite prepared statements.
  - `packages/db/src/repositories/event-repository.ts`: Lớp `EventRepository` ghi nhận sự kiện vào bảng `events` (đơn lẻ hoặc theo batch trong transaction), hỗ trợ `getNextSeq()`, `findByRunId()` có phân trang và lọc type/seq, cùng hàm `getRawLogs()` trích xuất log thô tuần tự thời gian.
  - `apps/orchestrator/src/adapters/execution-stream.ts`: Lớp `ExecutionStreamRecorder` và hàm helper `attachExecutionStream()`. Tự động gắn kết `ProcessHandle` (stdout, stderr, lifecycle) với `NdjsonParser` và `EventRepository`.
- **Cơ chế Chuẩn hóa Event Stream**:
  - Mỗi sự kiện ghi vào bảng `events` luôn có đủ 5 trường cốt lõi theo ROADMAP: `run_id`, `seq` (số nguyên dương tăng dần đơn điệu), `type` (chuỗi định danh loại sự kiện), `payload` (chuỗi JSON hợp lệ được serialize/deserialize tự động qua Zod), và `ts` (ISO-8601 UTC).
  - Chuẩn hóa loại sự kiện:
    - Vòng đời tiến trình: `process_start` (chứa `pid`, `command`, `startedAt`), `process_exit` (chứa `exitCode`, `signal`, `durationMs`).
    - Dòng thô: `stdout` (chứa dòng stdout gốc dạng `{ text }`), `stderr` (chứa dòng stderr gốc dạng `{ text }`).
    - Sự kiện NDJSON: `type` được trích xuất trực tiếp từ trường type của JSON payload (hoặc mặc định), kèm dữ liệu payload đã qua phân tích.
    - Lỗi cú pháp JSON: `parse_error` ghi nhận dòng thô (`raw`) và thông điệp lỗi (`errorMessage`) mà không ngắt luồng ghi nhận.
- **Lưu đồng thời stdout/stderr thô (Raw Logs)**:
  - Khi stdout phát sinh từng dòng, hệ thống lưu sự kiện `stdout` thô trước, sau đó nếu dòng là NDJSON hợp lệ thì lưu tiếp sự kiện chuẩn hóa tương ứng.
  - Luồng stderr được đệm bằng `StringDecoder('utf8')`, cắt theo `\n`, loại bỏ `\r`, và tự động flush phần còn dư khi stream kết thúc, lưu lại thành các sự kiện `stderr` thô.
  - Hàm `getRawLogs(runId)` trích xuất toàn bộ log `stdout` và `stderr` theo đúng thứ tự `seq ASC`.
- **Đảm bảo tiêu chí "Log còn sau khi process chết"**:
  - Mỗi sự kiện được ghi vào SQLite ngay lập tức (`EventRepository.create()` thực thi prepared statement đồng bộ ngay khi nhận sự kiện từ stream, không gom cuối hay lưu tạm trên RAM).
  - Ngay cả khi tiến trình kết thúc bình thường (exit 0), kết thúc có lỗi (exit != 0), bị crash do uncaught exception, hoặc bị kill cưỡng bức bằng tín hiệu `SIGKILL`/`SIGTERM`, toàn bộ dữ liệu log và sự kiện đã phát trước đó đều tồn tại nguyên vẹn trong cơ sở dữ liệu SQLite và có thể truy vấn bất kỳ lúc nào.
- **Ràng buộc khóa ngoại và toàn vẹn dữ liệu**:
  - Bảng `events` liên kết khóa ngoại `run_id REFERENCES runs(id) ON DELETE CASCADE`.
  - Khi một bản ghi `runs` bị xóa, các sự kiện liên quan trong `events` tự động được dọn dẹp sạch sẽ nhờ cơ chế `foreign_keys = ON` của SQLite.
- **Dependencies**: Không thêm dependency bên ngoài mới (sử dụng `better-sqlite3`, `zod`, `node:events`, `node:string_decoder`, `@ai-orchestrator/shared`, `@ai-orchestrator/db`).
