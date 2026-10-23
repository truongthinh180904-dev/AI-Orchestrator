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

## AGY-004: Xử lý exit code + event result → SUCCESS / ERROR / INVALID_OUTPUT
- **Vị trí Module**:
  - `packages/shared/src/models/result.ts`: Định nghĩa schema `AgentResultStatusSchema`, `AgentResultPayloadSchema`, các hàm helper `isResultSuccess()`, `findResultEvents()`, kiểu dữ liệu `ResolveRunStatusInput`, `RunResolutionResult`, và hàm cốt lõi `resolveRunStatus()`. Re-export qua `packages/shared/src/models/index.ts` và `@ai-orchestrator/shared`.
  - `packages/shared/src/models/event.ts`: Bổ sung `RESULT: 'result'` vào hằng số `STANDARD_EVENT_TYPES`.
  - `apps/orchestrator/src/adapters/execution-stream.ts`: Tích hợp `resolveRunStatus()` vào callback sự kiện `close` của `ExecutionStreamRecorder`, cập nhật chính xác trạng thái trong SQLite `runs` table, và trả về qua `ExecutionCompletionResult`.
- **Cơ chế Phân giải Trạng thái Run (`resolveRunStatus`)**:
  - **Quy tắc 1: Người dùng hủy / Timeout**:
    - Nếu `isCancelled === true` → gán trạng thái `CANCELLED`.
    - Nếu `isTimeout === true` → gán trạng thái `TIMEOUT`.
  - **Quy tắc 2: Exit code khác 0 hoặc bị kill bởi signal**:
    - Nếu `exitCode !== 0 && exitCode !== null` → gán trạng thái `ERROR` (ưu tiên mã thoát thực tế của hệ điều hành, bất kể các sự kiện stream đã in trước đó).
    - Nếu `exitCode === null` và có `signal` (ví dụ `SIGKILL`, `SIGSEGV`) → gán trạng thái `ERROR`.
  - **Quy tắc 3: Exit code 0**:
    - Tìm kiếm sự kiện `result` trong danh sách các sự kiện (`findResultEvents()`).
    - Nếu **không có sự kiện result** nào trong toàn bộ stream → gán trạng thái `INVALID_OUTPUT` (xử lý tình huống process kết thúc nhưng output rỗng hoặc chỉ có log thường).
    - Lấy sự kiện `result` cuối cùng (final result). Nếu payload của sự kiện không thỏa mãn Zod schema `AgentResultPayloadSchema` (sai cú pháp, thiếu cả `status` và `success`, sai enum status, hoặc payload không phải object) → gán trạng thái `INVALID_OUTPUT`.
    - Nếu payload hợp lệ và `isResultSuccess(payload) === true` (chứa `status: 'SUCCESS'` hoặc `success: true`) → gán trạng thái `SUCCESS`.
    - Nếu payload hợp lệ nhưng `isResultSuccess(payload) === false` (chứa `status: 'ERROR'`, `status: 'FAILED'`, hoặc `success: false`) → gán trạng thái `ERROR` kèm thông điệp lỗi trích xuất từ `message`/`summary`/`error`.
- **Chuẩn hóa Schemas & Định dạng mềm dẻo**:
  - `AgentResultStatusSchema` sử dụng `z.preprocess` tự động `trim()` và chuyển thành chữ in hoa (`toUpperCase()`), cho phép chấp nhận các biến thể như `"success"`, `"Success"`, `"error"`, `"failed"`.
  - Hỗ trợ cả hai dạng báo cáo kết quả: theo trạng thái (`status: 'SUCCESS' | 'ERROR' | 'FAILED'`) hoặc theo cờ boolean (`success: true | false`).
  - Hỗ trợ giải mã JSON string an toàn nếu payload được lưu dưới dạng chuỗi đã serialize.
- **Phân định rõ ranh giới: CLI SUCCESS vs Task DONE (ROADMAP item 121)**:
  - Trạng thái `SUCCESS` ở cấp độ `Run` chỉ biểu thị tiến trình CLI worker đã thực thi xong và phát ra kết quả hợp lệ.
  - Task nghiệp vụ trong bảng `tasks` tuyệt đối không được tự động chuyển sang `DONE` tại tầng Worker/Adapter này; trạng thái `DONE` của Task chỉ được quyết định sau khi trải qua Quality Gate / Reviewer ở GĐ 3 và GĐ 4.
- **Mở rộng ExecutionStreamRecorder**:
  - Thêm phương thức `recorder.markTimeout()` và `recorder.markCancelled()` để chuẩn bị sẵn sàng cho task `AGY-005` (Timeout và Stop).
  - Thuộc tính getter `recorder.resolution` lưu trữ chi tiết lý do và parsed result.
  - `ExecutionCompletionResult` mở rộng cung cấp `status: RunStatus` và `resolution: RunResolutionResult`.
- **Dependencies**: Không thêm dependency bên ngoài mới (sử dụng thư viện có sẵn `zod`, `better-sqlite3`, `@ai-orchestrator/shared`, `@ai-orchestrator/db`).

## AGY-005: Timeout: SIGTERM → chờ grace → SIGKILL; hàm stop(runId) — Process treo bị dừng đúng hạn
- **Vị trí Module**:
  - `packages/shared/src/models/agent-command.ts`: Định nghĩa interface `TerminateProcessOptions` (`gracePeriodMs`, `signal`, `forceSignal`).
  - `packages/shared/src/models/event.ts`: Bổ sung sự kiện `PROCESS_TIMEOUT` (`process_timeout`) và `PROCESS_STOPPED` (`process_stopped`) vào `STANDARD_EVENT_TYPES`.
  - `apps/orchestrator/src/adapters/process-adapter.ts`:
    - Khai báo và hiện thực phương thức `terminate(options?: TerminateProcessOptions)` trên `ProcessHandle` và `ProcessHandleImpl`.
    - Điều chỉnh `isRunning()`: Bỏ điều kiện `!this.child.killed` để phản ánh đúng trạng thái thực tế của tiến trình (`exitCode === null && signalCode === null && _running`). Khi Node.js gọi `child.kill('SIGTERM')`, Node tự động đánh dấu `child.killed = true`, nhưng tiến trình ngoan cố có thể vẫn còn chạy và cần tiếp tục nhận tín hiệu `SIGKILL` sau khi hết thời gian ân hạn (`gracePeriodMs`).
  - `apps/orchestrator/src/adapters/execution-manager.ts`: Triển khai lớp `ExecutionManager`, singleton `defaultExecutionManager`, và hàm độc lập `stop(runId)` phục vụ dừng tiến trình theo yêu cầu và điều phối timeout watchdog.
  - `apps/orchestrator/src/adapters/index.ts`: Re-export toàn bộ module `execution-manager.js`.
- **Cơ chế Hủy Tiến trình Tuần tự (SIGTERM → grace → SIGKILL)**:
  - Khi bắt đầu dừng tiến trình (do timeout hoặc do gọi `stop(runId)`):
    1. Gửi tín hiệu ban đầu `SIGTERM` tới tiến trình (hoặc tới process group `-pid` nếu `detached: true`).
    2. Khởi động timer đếm lùi thời gian ân hạn `gracePeriodMs` (mặc định 10s, có thể cấu hình tùy ý).
    3. Nếu tiến trình thoát bình thường trong thời gian ân hạn: timer được hủy ngay lập tức qua `clearTimeout()`, không gửi `SIGKILL`.
    4. Nếu tiến trình ngoan cố/bị treo (bỏ qua SIGTERM, bẫy tín hiệu): khi timer hết hạn, hệ thống tự động gửi tín hiệu cưỡng chế `SIGKILL` buộc hệ điều hành tiêu diệt tiến trình.
- **Cơ chế Timeout Watchdog**:
  - Khi tiến trình được khởi chạy qua `startRun({ timeoutMs, ... })` hoặc đăng ký qua `register({ timeoutMs, ... })`:
    - Nếu tiến trình hoàn tất trước hạn: timer timeout được hủy tự động qua sự kiện `close`/`error`.
    - Nếu quá hạn `timeoutMs` mà tiến trình vẫn đang chạy: watchdog tự động đánh dấu `markTimeout()`, phát event `process_timeout` vào bảng `events`, và kích hoạt `terminate()` để dọn dẹp tiến trình treo đúng hạn, chuyển trạng thái trong bảng `runs` thành `TIMEOUT`.
- **Hàm `stop(runId)` & Quản lý Hủy bỏ**:
  - Cho phép dừng một lần chạy theo ID. Nếu tìm thấy tiến trình đang chạy:
    - Hủy timer timeout đang chờ (nếu có) để ngăn xung đột trạng thái.
    - Đánh dấu `isCancelled` và gọi `recorder.markCancelled()`.
    - Ghi nhận event `process_stopped` vào bảng `events`.
    - Thực hiện chu trình `terminate({ gracePeriodMs })`.
    - Trạng thái cuối cùng của run được cập nhật thành `CANCELLED`.
  - Cung cấp hàm xuất độc lập `stop(runId)` chuyển tiếp tới `defaultExecutionManager`, sẵn sàng tích hợp thẳng vào Fastify route `POST /runs/:id/stop` của `AGY-007`.
  - Cung cấp `stopAll()` phục vụ graceful shutdown hệ thống.
- **Tính Tất định trong Kiểm thử (Test Reliability)**:
  - Để tránh race condition khi Vitest chạy đồng thời 37 worker processes khiến tiến trình con chưa kịp khởi động đã nhận tín hiệu, các kịch bản kiểm thử tiến trình ngoan cố sử dụng cơ chế đồng bộ qua file cờ `readyFile` (`fs.writeFileSync`) ngay sau khi đăng ký `process.on('SIGTERM')`. Điều này đảm bảo 100% tính tất định và ổn định trên mọi môi trường.
- **Dependencies**: Không thêm dependency bên ngoài mới (sử dụng thư viện Node.js có sẵn `node:child_process`, `node:events`, `node:fs`, `node:path`, `node:os`).

## AGY-006: Chạy trong working dir/worktree cô lập, kiểm tra cwd thuộc repo đã đăng ký — Cwd sai bị từ chối
- **Vị trí Module**:
  - `packages/shared/src/models/workspace.ts`: Định nghĩa schema & types cho `RegisteredRepository`, `RegisterRepositoryInput`, `WorktreeInfo`, và `CreateWorktreeOptions`. Re-export qua `packages/shared/src/models/index.ts` và `@ai-orchestrator/shared`.
  - `packages/shared/src/git.ts`: Cung cấp hàm `runGitCommand`, `parseGitWorktreeList`, `gitWorktreeList`, `gitWorktreeAdd`, `gitWorktreeRemove`, `gitWorktreePrune`.
  - `apps/orchestrator/src/adapters/repository-registry.ts`: Triển khai lớp `RepositoryRegistry`, singleton `defaultRepositoryRegistry`, và hàm `createRepositoryRegistry()`.
  - `apps/orchestrator/src/adapters/worktree-manager.ts`: Triển khai lớp `WorktreeManager`, singleton `defaultWorktreeManager`, và hàm `createWorktreeManager()`.
  - `apps/orchestrator/src/adapters/process-adapter.ts`: Tích hợp xác thực cwd thông qua `RepositoryRegistry` trước khi spawn process.
  - `apps/orchestrator/src/adapters/execution-manager.ts`: Tích hợp hỗ trợ `RepositoryRegistry` và thực thi trên `IsolatedWorktree`.
  - `apps/orchestrator/src/adapters/git.ts` & `apps/orchestrator/src/index.ts`: Re-export toàn bộ công cụ workspace, worktree, và registry.
- **Cơ chế Kiểm tra CWD & Ranh giới Repo Đã Đăng ký (`RepositoryRegistry`)**:
  - Chỉ cho phép tiến trình worker thực thi trong các thư mục làm việc (cwd) thuộc một repository đã đăng ký hoặc một worktree cô lập được cấp quyền gắn liền với repository đó.
  - Chuẩn hóa đường dẫn canonical bằng `path.resolve` và `fs.realpathSync`, triệt để ngăn chặn các kỹ thuật tấn công thoát ranh giới:
    - Path traversal: dùng `..` để nhảy ra ngoài cây thư mục repo đã đăng ký.
    - Symlink escape: tạo symlink bên trong repo trỏ tới thư mục nhạy cảm bên ngoài (`/tmp`, `/etc`, v.v.).
    - Thư mục không tồn tại hoặc trỏ tới file thông thường.
  - Khi cwd không hợp lệ hoặc nằm ngoài danh sách đăng ký: Ném ngay `AppError` với mã lỗi `UNREGISTERED_REPOSITORY` hoặc `INVALID_WORKING_DIRECTORY` kèm ngữ cảnh chi tiết trước khi bất kỳ tiến trình con nào được khởi tạo (`Cwd sai bị từ chối`).
- **Cơ chế Worktree Cô lập (`WorktreeManager`)**:
  - Tuân thủ hướng dẫn tại `SKILL-git-release.md`: khởi tạo worktree cô lập bằng lệnh git an toàn không qua shell:
    `git worktree add -b agy/<task-id>[-<slug>] <worktreePath> [commitOrBranch]`
  - Worktree tạo ra được tự động đăng ký vào `RepositoryRegistry` như một workspace hợp lệ thuộc repo cha, cho phép tiến trình worker chạy trong thư mục worktree đó mà không bị chặn bởi bộ kiểm tra ranh giới.
  - Mọi thao tác sửa đổi file, tạo file mới trong worktree cô lập hoàn toàn không ảnh hưởng hay làm bẩn (`git status --porcelain`) working tree của repository gốc.
  - Hỗ trợ dọn dẹp an toàn: `git worktree remove` (kèm cờ `force: true` khi có thay đổi chưa commit) và tự động thu hồi quyền cwd khỏi `RepositoryRegistry`.
- **Tích hợp Tầng Process Adapter & Execution Manager**:
  - `ProcessAdapter` nhận tùy chọn `repositoryRegistry`. Trong `spawn()`, nếu registry được cấu hình, gọi `registry.assertCwdValid(command.cwd)`.
  - `ExecutionManager.startRun()` hỗ trợ nhận trực tiếp tham số `worktree?: IsolatedWorktree`, tự động trỏ `command.cwd` vào thư mục worktree và kiểm tra tính hợp lệ trước khi bắt đầu thực thi.
- **Dependencies**: Không thêm dependency bên ngoài mới (sử dụng thư viện Node.js có sẵn `node:child_process`, `node:fs`, `node:path`, `node:os`, `node:crypto`).

## AGY-007: Worker execution API: POST /runs, GET /runs/:id, GET /runs/:id/stream (SSE), POST /runs/:id/stop — Chạy thử qua API với CLI giả
- **Vị trí Module**:
  - `packages/shared/src/models/run.ts`: Bổ sung Zod schemas `CreateRunApiSchema`, `StopRunApiSchema`, `RunFilterSchema`, `RunCommandOverrideSchema` và các types tương ứng.
  - `packages/db/src/repositories/run-repository.ts`: Bổ sung phương thức `findAll(filter?: RunFilter): Run[]` phục vụ truy vấn danh sách runs theo taskId/status.
  - `apps/orchestrator/src/types.ts`: Khai báo `RunParamsSchema`, `RunStreamQuerySchema`, mở rộng `BuildServerOptions` (`executionManager`, `repositoryRegistry`), và re-export các schema từ `@ai-orchestrator/shared`.
  - `apps/orchestrator/src/services/run-service.ts`: Triển khai lớp `RunService` bao bọc toàn bộ logic điều khiển lần chạy (`startRun`, `getRun`, `listRuns`, `stopRun`, `getEvents`).
  - `apps/orchestrator/src/routes/runs.ts`: Khai báo plugin Fastify chứa 5 endpoints REST/SSE: `POST /runs`, `GET /runs`, `GET /runs/:id`, `GET /runs/:id/stream`, `POST /runs/:id/stop` (kèm alias `/api/runs*`).
  - `apps/orchestrator/src/server.ts`: Đăng ký `runRoutes`, tiêm `RunService`, bổ sung ánh xạ mã lỗi HTTP (`RUN_NOT_FOUND` → 404; `UNREGISTERED_REPOSITORY`, `INVALID_WORKING_DIRECTORY`, `INVALID_PAYLOAD` → 400).
  - `fixtures/mock-agy-cli.cjs`: Script Node.js giả lập AGY worker phát NDJSON (`status`, `stdout`, `result SUCCESS/ERROR`, `hang`, `stubborn`, `crash`, `invalid_output`) phục vụ kiểm thử tích hợp và kiểm thử nghiệm thu.
- **Hiện thực Server-Sent Events (SSE) theo chuẩn**:
  - Endpoint `GET /runs/:id/stream`: thiết lập các header SSE chuẩn `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`.
  - Truyền lại toàn bộ lịch sử event từ SQLite DB trước (`after_seq` / header `Last-Event-ID`).
  - Đối với tiến trình đang hoạt động: lắng nghe sự kiện phát sinh từ `ExecutionStreamRecorder`, gửi ngay lập tức tới client theo định dạng SSE chuẩn `id: <seq>\nevent: <type>\ndata: <json>\n\n`.
  - Gửi heartbeat comment định kỳ 15 giây (`: heartbeat\n\n`) để duy trì kết nối chống timeout qua reverse proxy theo đúng `SKILL-node-typescript.md`.
  - Dọn dẹp listener và timer khi client ngắt kết nối (`request.raw.on('close')`, `reply.raw.on('close')`).
  - Khi lần chạy kết thúc, tự động phát sự kiện hoàn tất `event: done` và đóng luồng kết nối `reply.raw.end()`.
- **Dừng tiến trình theo yêu cầu (`POST /runs/:id/stop`)**:
  - Tìm lần chạy trong hệ thống; nếu không tìm thấy trả về 404 `RUN_NOT_FOUND`.
  - Nếu lần chạy đang hoạt động trong `ExecutionManager`: gọi `stop(id, options)` kích hoạt chu trình tuần tự SIGTERM → grace period → SIGKILL và cập nhật trạng thái trong DB thành `CANCELLED`.
  - Nếu lần chạy đã kết thúc từ trước: trả về an toàn `{ data: { stopped: false, run } }` mà không gây lỗi hay crash server.
- **Dependencies**: Không thêm dependency ngoài mới (sử dụng Fastify và Node.js native streams có sẵn).


## AGY-008: Test CLI giả: lỗi, timeout, crash, output rác (script mock) — Mỗi tình huống có test + bằng chứng
- **Mở rộng Mock AGY CLI (`fixtures/mock-agy-cli.cjs`)**:
  - Tình huống Lỗi (`error`, `error_exit_only`, `error_exit_2`, `error_result_zero_exit`):
    - `error`: Ghi stderr `Fatal: compile error`, phát event `result` với `{ status: 'ERROR' }`, thoát mã 1.
    - `error_exit_only` / `error_exit_2`: Thoát với mã lỗi khác 0 mà không có event `result`.
    - `error_result_zero_exit`: Thoát với mã exit 0 nhưng payload event `result` thông báo lỗi nghiệp vụ (`status: 'ERROR'`), kiểm tra hệ thống phân giải chính xác thành `ERROR`.
  - Tình huống Timeout (`hang`, `timeout`, `stubborn`, `delay`):
    - `timeout` / `hang`: Chạy vô hạn; thoát an toàn khi nhận `SIGTERM` từ timeout watchdog.
    - `stubborn`: Chạy vô hạn; chủ động bỏ qua tín hiệu `SIGTERM`, buộc `ExecutionManager` phải nâng cấp lên `SIGKILL` sau grace period (150ms).
    - `delay`: Trì hoãn thực thi một khoảng thời gian trước khi hoàn thành, phục vụ kiểm thử timeout theo cấu hình.
  - Tình huống Crash đột ngột (`crash`, `crash_segfault`, `crash_uncaught`, `crash_signal`):
    - `crash_segfault`: Thoát với exit code 139 (tương đương SIGSEGV segmentation fault) kèm thông báo stderr; hệ thống ghi nhận exit code 139, lưu stderr và phân giải `status: 'ERROR'`.
    - `crash_uncaught`: Phát sinh ngoại lệ chưa bắt runtime trong tiến trình Node con, gây thoát đột ngột với mã 1 và stack trace ghi nhận vào DB `events`.
    - `crash_signal`: Tiến trình con tự kết liễu bằng `SIGKILL`, hệ thống nhận diện đúng signal và thu hồi tài nguyên sạch sẽ.
  - Tình huống Output rác / Sai định dạng (`invalid_output`, `no_result`, `invalid_result_schema`, `invalid_result_non_object`, `garbage_stream`, `garbage_stream_no_result`, `garbage_stream_error`, `empty`, `huge_line`):
    - `no_result` / `invalid_output`: Chỉ xuất stdout dạng plain text mà không có event `result`, thoát 0; phân giải thành `INVALID_OUTPUT`.
    - `invalid_result_schema`: Xuất event `result` có payload không thỏa mãn Zod schema `AgentResultPayloadSchema` (thiếu status/success hoặc sai định dạng); phân giải thành `INVALID_OUTPUT`.
    - `garbage_stream`: Xuất dòng JSON hỏng (`{"corrupted_json: true`), chuỗi byte nhị phân lạ xen kẽ các event hợp lệ; `NdjsonParser` thu thập các event `parse_error` vào bảng `events` mà không làm crash tiến trình hay server, run hoàn thành `SUCCESS`.
    - `garbage_stream_no_result` / `garbage_stream_error`: Dòng rác kết hợp không có result hoặc kết thúc bằng mã lỗi 1; phân giải lần lượt thành `INVALID_OUTPUT` và `ERROR`.
    - `huge_line`: Xuất dòng NDJSON kích thước lớn (200KB+) kiểm tra buffer NDJSON; bổ sung cơ chế `finish(code)` đảm bảo stream stdout flush trọn vẹn trước khi tiến trình thoát.
    - `empty`: Thoát ngay lập tức không xuất dòng nào; phân giải an toàn thành `INVALID_OUTPUT`.
- **Cải tiến an toàn trong Execution Manager & Execution Stream**:
  - `ExecutionManager`: Bổ sung kiểm tra `if (this.listenerCount('error') > 0)` khi chuyển tiếp sự kiện `'error'` từ `ProcessHandle`, ngăn chặn Node.js EventEmitter ném ngoại lệ `ERR_UNHANDLED_ERROR` khi không có listener cấp cao.
  - `ExecutionStreamRecorder`: Tự động cập nhật `status: 'ERROR'` vào bảng `runs` khi tiến trình con gặp lỗi khởi tạo (`ENOENT` / process error), đồng thời bọc bảo vệ các thao tác database trong khối teardown tránh lỗi khi kết nối database đã đóng.
- **Dependencies**: Không thêm bất kỳ dependency bên ngoài nào mới.

## ORC-001: State machine task: TODO→READY→RUNNING→VERIFYING→DONE, FAILED, BLOCKED, PAUSED, CANCELLED — Chuyển trạng thái trái phép → throw
- **Thiết kế State Machine & Bảng Chuyển Đổi Trạng Thái (`packages/shared/src/state/`)**:
  - Quản lý 9 trạng thái tiêu chuẩn của Task: `TODO`, `READY`, `RUNNING`, `VERIFYING`, `DONE`, `FAILED`, `BLOCKED`, `PAUSED`, `CANCELLED`.
  - **Chu trình tuyến tính cốt lõi**: `TODO → READY → RUNNING → VERIFYING → DONE`.
    - `TODO`: Chỉ được chuyển sang `READY` (khi thỏa mãn dependencies), `BLOCKED` (khi bị nghẽn/thiếu tài nguyên), hoặc `CANCELLED`.
    - `READY`: Chỉ được chuyển sang `RUNNING` (khi scheduler khởi chạy worker), `PAUSED`, `BLOCKED`, `CANCELLED`, hoặc quay về `TODO`.
    - `RUNNING`: Chỉ được chuyển sang `VERIFYING` (khi code xong, bước vào bước kiểm tra), `FAILED` (khi lỗi/crash/timeout), `PAUSED`, `BLOCKED`, hoặc `CANCELLED`. Tuyệt đối cấm nhảy cóc trực tiếp sang `DONE` (bắt buộc qua `VERIFYING`).
    - `VERIFYING`: Chỉ được chuyển sang `DONE` (khi mọi tiêu chí nghiệm thu/test pass), `FAILED` (khi test hỏng), `PAUSED`, `BLOCKED`, hoặc `CANCELLED`.
    - `DONE`: Trạng thái kết thúc (terminal state), không cho phép bất kỳ chuyển đổi nào ra khỏi `DONE` (`ALLOWED_TASK_TRANSITIONS['DONE'] = []`).
  - **Các nhánh phân nhánh / ngoại lệ**:
    - `FAILED`: Cho phép chuyển sang `READY` (retry theo chính sách retry ORC-004), `TODO` (re-queue), hoặc `CANCELLED`.
    - `BLOCKED`: Cho phép chuyển sang `READY` (khi gỡ chặn), `TODO`, `FAILED`, hoặc `CANCELLED`.
    - `PAUSED`: Cho phép chuyển sang `READY`, `RUNNING`, `VERIFYING`, `TODO`, `FAILED`, hoặc `CANCELLED`.
    - `CANCELLED`: Cho phép chuyển sang `TODO` (reopen task).
  - **Quy tắc chuyển cùng trạng thái (`from === to`)**: Mặc định từ chối (`allowSameState: false`) để bảo đảm mọi transition đều là một sự kiện thay đổi trạng thái thực sự; có thể bật bằng cờ tùy chọn khi cần tính idempotent.
  - **Xử lý chuyển trạng thái trái phép**: Ném ngay `AppError` với mã `ILLEGAL_STATE_TRANSITION`, thông báo rõ trạng thái nguồn, đích, danh sách các trạng thái hợp lệ được phép và lý do (nếu có).
- **Lớp Domain `TaskStateMachine` (`packages/shared/src/state/task-state-machine.ts`)**:
  - Quản lý trạng thái hiện tại, lưu trữ lịch sử chuyển đổi (`history`: `[{ from, to, timestamp, reason, meta }]`), hỗ trợ lắng nghe sự kiện qua `onTransition(listener)`.
  - Cung cấp các phương thức `canTransitionTo(target)`, `transition(target, options)`, `getAllowedTransitions()`, `isTerminal()`, `reset()`, hỗ trợ ghi đè cưỡng bức bằng `force: true` trong trường hợp quản trị đặc biệt.
- **Tầng Lưu Trữ SQLite (`packages/db/src/repositories/task-repository.ts`)**:
  - Bổ sung phương thức `transitionStatus(id, newStatus, options)`: Xác thực nghiêm ngặt bằng `assertValidTaskTransition` trước khi thực thi lệnh UPDATE trong SQLite; hỗ trợ tăng số lượt thực thi `incrementAttempt: true`.
  - Cập nhật `updateStatus(id, newStatus, options)`: Tích hợp tùy chọn `enforceTransitions: true` ủy quyền cho `transitionStatus()`, bảo toàn tính tương thích ngược với các hàm CRUD trước đó.
- **Tầng Dịch Vụ Orchestrator (`apps/orchestrator/src/services/task-state-service.ts`)**:
  - Khởi tạo `TaskStateService` điều phối chuyển đổi trạng thái task trong hệ thống.
  - Cung cấp các hàm ngữ cảnh tiện lợi: `markReady`, `markRunning`, `markVerifying`, `markDone`, `markFailed`, `markBlocked`, `pause`, `resume`, `cancel`.
  - Tự động ghi nhận sự kiện `task_transition` vào bảng `events` khi có `runId` và xuất log có cấu trúc JSON chuẩn (`timestamp`, `level`, `context`).
- **Tầng REST API (`apps/orchestrator/src/routes/tasks.ts`)**:
  - `POST /tasks/:id/transition` & `POST /api/tasks/:id/transition`: Nhận `{ status, reason, runId, incrementAttempt, force }`, validate bằng Zod `TaskTransitionBodySchema`, thực thi chuyển đổi và trả về 200 `{ data: updatedTask }`. Nếu chuyển đổi trái phép, middleware trả về 400 Bad Request với mã `ILLEGAL_STATE_TRANSITION`.
  - `GET /tasks/:id/allowed-transitions` & `GET /api/tasks/:id/allowed-transitions`: Truy vấn danh sách trạng thái hợp lệ có thể chuyển đến từ trạng thái hiện tại của task.
- **Dependencies**: Không thêm bất kỳ dependency bên ngoài nào mới.

## ORC-002: Dependency resolver: danh sách task READY — Chỉ trả task đủ dependency
- **Mục tiêu & Nguyên tắc Nghiệm Thu Cốt Lõi**:
  - Xây dựng module phân giải phụ thuộc (`DependencyResolver`) chịu trách nhiệm xác định chính xác danh sách các task sẵn sàng thực thi (`READY`).
  - **Tiêu chuẩn nghiệm thu bất biến ("Chỉ trả task đủ dependency")**: Một task CHỈ ĐƯỢC COI LÀ SẴN SÀNG khi 100% dependencies của nó tồn tại và đã ở trạng thái `DONE`. Bất kỳ dependency nào đang ở trạng thái `TODO`, `READY`, `RUNNING`, `VERIFYING`, `FAILED`, `BLOCKED`, `PAUSED`, `CANCELLED` hoặc bị thiếu (`MISSING`) đều lập tức loại trừ task phụ thuộc khỏi danh sách `READY`.
  - Task không có dependencies (dependencies = []) lập tức thỏa mãn điều kiện dependencies ngay khi ở trạng thái `TODO` hoặc `READY`.
- **Module Phân Giải Phụ Thuộc Domain (`packages/shared/src/resolver/`)**:
  - `types.ts`: Định nghĩa schema và kiểu dữ liệu `TaskDependencyStatus`, `TaskDependencyItem`, `ResolveReadyOptions`, `DependencyResolutionSummary`.
  - `dependency-resolver.ts`:
    - Hàm thuần khiết `isDependencySatisfied(status)`: Trả về `true` duy nhất khi `status === 'DONE'`.
    - Hàm thuần khiết `checkTaskDependencies(task, lookup)`: Phân tích chi tiết tình trạng dependencies, bóc tách danh sách dependencies đã xong (`satisfiedDependencies`), chưa xong (`unsatisfiedDependencies` kèm trạng thái hiện tại), và bị thiếu (`missingDependencies`).
    - Lớp `DependencyResolver`: Quản lý tập hợp task trong bộ nhớ, cung cấp các hàm nghiệp vụ:
      - `getReadyTasks(options)`: Lọc theo `featureId`, `phase`, `repository`, trạng thái ứng viên `candidateStatuses` (mặc định `['TODO', 'READY']`), áp dụng kiểm tra nghiêm ngặt mọi dependency phải là `DONE`.
      - Sắp xếp kết quả tất định (deterministic):
        1. `priority` giảm dần (nhiệm vụ quan trọng ưu tiên chạy trước cho Scheduler ORC-003).
        2. `created_at` tăng dần (nhiệm vụ vào trước xếp trước).
        3. `id` tăng dần (theo bảng chữ cái).
      - `getNextReadyTask(options)`: Lấy task có độ ưu tiên cao nhất sẵn sàng chạy ngay.
      - `checkTask(taskId)`: Báo cáo chi tiết tình trạng dependencies của 1 task kèm lý do rõ ràng.
      - `getResolutionSummary()`: Tổng hợp bức tranh toàn cảnh gồm readyTasks, blockedTasks (bị chặn bởi lỗi/hủy), pendingTasks (đang chờ tiền đề chạy), completedTasks.
      - `findBlockedByFailedTasks()`: Nhận diện các task bị nghẽn do tiền đề bị FAILED, CANCELLED hoặc BLOCKED.
- **Tầng Lưu Trữ Database (`packages/db/src/repositories/task-repository.ts`)**:
  - Bổ sung `findReadyTasks(filter, options)`: Truy vấn toàn bộ task và chạy qua `DependencyResolver` để bảo đảm tính thống nhất tuyệt đối giữa logic nghiệp vụ và dữ liệu SQLite.
  - Bổ sung `getDependencyStatus(taskId)`: Truy xuất tình trạng phụ thuộc chi tiết của task từ cơ sở dữ liệu.
  - Bổ sung `resolveAndMarkReady(filter)`: Thực hiện trong SQLite transaction an toàn: tìm tất cả các task `TODO` có đầy đủ dependencies `DONE`, chuyển trạng thái sang `READY` với lý do `'Dependencies satisfied (resolved ready)'`, và trả về danh sách các task `READY`.
- **Tầng Dịch Vụ Orchestrator (`apps/orchestrator/src/services/dependency-resolver-service.ts` & `task-service.ts`)**:
  - `DependencyResolverService`: Điều phối nghiệp vụ giải quyết phụ thuộc, hỗ trợ cờ `autoTransition: true` tự động đưa các task `TODO` đủ điều kiện vào trạng thái `READY` trước khi trả về.
  - `TaskService`: Tích hợp `DependencyResolverService`, cung cấp các phương thức `getReadyTasks()`, `getNextReadyTask()`, `getDependencyStatus()`, `resolveReady()`.
- **Tầng REST API (`apps/orchestrator/src/routes/tasks.ts`)**:
  - `GET /tasks/ready` & `GET /api/tasks/ready`: Trả về HTTP 200 `{ data: TaskWithDependencies[] }` chứa các task đủ điều kiện dependencies. Hỗ trợ query params: `feature_id`, `phase`, `autoTransition`, `limit`.
  - `GET /tasks/:id/dependency-status` & `GET /api/tasks/:id/dependency-status`: Trả về HTTP 200 `{ data: TaskDependencyStatus }` phân tích chi tiết phụ thuộc của task cụ thể; trả về 404 nếu không tìm thấy task.
  - `POST /tasks/resolve-ready` & `POST /api/tasks/resolve-ready`: Kích hoạt giải quyết phụ thuộc, chuyển đổi các task `TODO` đủ điều kiện sang `READY` và trả về danh sách task `READY`.
- **Dependencies**: Không thêm bất kỳ dependency bên ngoài nào mới.



## ORC-003: Scheduler tuần tự, lock 1 agent, chống chạy trùng (transaction SQLite) — Test gọi đồng thời không chạy 2 task
- **Mục tiêu & Yêu cầu Nghiệm Thu Cốt Lõi**:
  - Triển khai bộ điều phối tác vụ tuần tự (`TaskScheduler`) cho Orchestrator, tuân thủ nguyên tắc "Concurrency: Tối đa 1 coding process tại một thời điểm".
  - Tiêu chuẩn nghiệm thu bất biến: "Test gọi đồng thời không chạy 2 task". Khi nhiều tác nhân/yêu cầu kích hoạt song song (concurrent calls), chỉ duy nhất 1 task được khởi chạy, không xảy ra xung đột hay chạy trùng lặp tác vụ.
- **Cơ Chế Khóa Agent Bằng SQLite Transaction & Bảng `agent_locks` (`packages/db/migrations/002_agent_lock.sql`)**:
  - Bổ sung migration đánh số `002_agent_lock.sql` theo đúng chuẩn `SKILL-sqlite.md`, định nghĩa bảng `agent_locks` (`id` PK, `task_id` FK, `run_id` FK, `acquired_at`, `owner_pid`, `metadata`).
  - Lớp `AgentLockRepository` (`packages/db/src/repositories/agent-lock-repository.ts`):
    - Quản lý vòng đời khóa agent (`acquire`, `release`, `updateRunId`, `getCurrentLock`, `isLocked`, `forceRelease`).
    - Ném lỗi `AppError('AGENT_LOCK_HELD')` khi khóa đang bị chiếm giữ.
- **Dịch Vụ Điều Phối `TaskScheduler` (`apps/orchestrator/src/services/task-scheduler.ts`)**:
  - `acquireNextTask()`:
    - Bọc toàn bộ logic kiểm tra và chiếm quyền thực thi trong một SQLite Transaction chế độ tức thời (`tx.immediate()`), bảo đảm tính nguyên tử (atomicity) tuyệt đối ở tầng cơ sở dữ liệu.
    - Kiểm tra tính hợp lệ của lock hiện tại; tự động dọn dẹp stale lock nếu task cũ đã hoàn tất hoặc bị hủy.
    - Kiểm tra bảng `tasks` và `runs`: Nếu có bất kỳ task nào đang `RUNNING`/`VERIFYING` hoặc run nào đang `RUNNING`, lập tức từ chối với lý do `LOCK_HELD`, `CONCURRENCY_LIMIT_EXCEEDED` hoặc `ACTIVE_RUN_EXISTS`.
    - Trích xuất candidate task từ `DependencyResolver` (`findReadyTasks` với candidateStatuses `['READY', 'TODO']`, ưu tiên `priority DESC`, `created_at ASC`, `id ASC`).
    - Chuyển trạng thái task sang `RUNNING` (tăng attempt) và ghi bản ghi vào `agent_locks`.
  - `step()`: Thực hiện 1 chu kỳ điều phối hoàn chỉnh (acquire task -> gọi `RunService.startRun` -> giám sát tiến trình worker qua mock CLI/AGY -> cập nhật state machine task `RUNNING -> VERIFYING -> DONE/FAILED/CANCELLED` -> tự động giải phóng lock trong khối `finally`).
  - `runUntilEmpty()`: Vòng lặp điều phối tuần tự (sequential loop), xử lý lần lượt từng task đến khi hết task sẵn sàng hoặc có lệnh dừng/tạm dừng.
  - Hỗ trợ các cơ chế điều khiển vận hành: `pause()`, `resume()`, `stop()` (hỗ trợ ngắt tiến trình worker đang chạy qua `RunService.stopRun`), `getStatus()`, `releaseLock()`.
- **Đồng Bộ Kiểm Soát Concurrency Tầng `RunService` (`apps/orchestrator/src/services/run-service.ts`)**:
  - Bổ sung kiểm tra concurrency nghiêm ngặt trong `startRun`: Từ chối với lỗi `CONCURRENCY_LIMIT_EXCEEDED` hoặc `AGENT_LOCK_HELD` (HTTP 409 Conflict) nếu có một tiến trình worker khác đang hoạt động, ngăn chặn hoàn toàn việc gọi trực tiếp `POST /runs` phá vỡ giới hạn concurrency.
  - Tự động giải phóng lock trên sự kiện process `close` hoặc khi gọi `stopRun`.
- **Tầng REST API Điều Khiển Scheduler (`apps/orchestrator/src/routes/scheduler.ts`)**:
  - `POST /scheduler/next` & `POST /api/scheduler/next`: Kích hoạt bước điều phối kế tiếp.
  - `GET /scheduler/status` & `GET /api/scheduler/status`: Truy vấn trạng thái thời gian thực.
  - `POST /scheduler/start` & `POST /api/scheduler/start`: Khởi chạy vòng lặp tuần tự nền.
  - `POST /scheduler/pause` & `POST /scheduler/resume`: Tạm dừng / tiếp tục điều phối.
  - `POST /scheduler/stop` & `POST /api/scheduler/stop`: Dừng scheduler và hủy run đang chạy.
  - `POST /scheduler/release-lock`: Cưỡng bức giải phóng khóa agent khi cần can thiệp vận hành.
- **Cập Nhật Schema Mô Hình `@ai-orchestrator/shared`**:
  - `AgentLockSchema`, `CreateAgentLockSchema`, `SchedulerStatusSchema`, `ScheduleNextOptionsSchema`, `ScheduleStepResultSchema`.
- **Sửa Đổi Kiểm Thử Ngoài Phạm Vi Task Cần Thiết**:
  - Cập nhật `packages/db/src/__tests__/migrator.test.ts` phản ánh sự xuất hiện của migration `002_agent_lock.sql` (tổng 2 migrations, bảng `agent_locks`).
- **Dependencies**: Không thêm bất kỳ dependency bên ngoài nào mới.

## ORC-004: Retry policy (max_attempts, backoff) — Không retry vô hạn
- **Mục tiêu & Tiêu chuẩn Nghiệm Thu Cốt Lõi**:
  - Triển khai chính sách thử lại (Retry Policy) có cấu hình `max_attempts` và cơ chế tính toán độ trễ backoff.
  - Tiêu chuẩn nghiệm thu bất biến của ROADMAP: "Không retry vô hạn". Hệ thống phải bảo đảm dừng lại dứt khoát khi `attempts >= max_attempts`, không bao giờ lặp vô tận trong vòng điều phối tuần tự hay khi gọi qua API.
- **Mô-đun `RetryPolicy` (`packages/shared/src/retry/retry-policy.ts`)**:
  - `RetryPolicyOptionsSchema` & `RetryDecisionSchema`:
    - `max_attempts`: Số lần thử tối đa (mặc định 3, tối thiểu 1).
    - `strategy`: Chiến lược backoff (`'exponential' | 'linear' | 'fixed'`, mặc định `'exponential'`).
    - `initial_delay_ms`: Độ trễ cơ sở ban đầu (mặc định 1000ms).
    - `max_delay_ms`: Giới hạn trần tối đa của độ trễ (mặc định 30000ms).
    - `backoff_factor`: Hệ số nhân cho exponential backoff (mặc định 2).
    - `jitter`: Cờ ngẫu nhiên hóa độ trễ (mặc định false).
    - `jitter_ratio`: Tỷ lệ dao động jitter (mặc định 0.1, tức +/- 10%).
    - `retryable_statuses`: Danh sách trạng thái được phép retry (mặc định `['FAILED']`).
  - Hàm `computeBackoffDelay(attempt)`:
    - Exponential: `initial_delay_ms * Math.pow(backoff_factor, attempt - 1)` capped tại `max_delay_ms`.
    - Linear: `initial_delay_ms * attempt` capped tại `max_delay_ms`.
    - Fixed: `initial_delay_ms`.
    - Jitter: Bổ sung dao động ngẫu nhiên có kiểm soát trong phạm vi `[-jitter_ratio, +jitter_ratio]`.
  - Hàm `evaluate(task, context)`:
    - Nếu `task.attempts >= max_attempts`: Lập tức trả về `{ shouldRetry: false, reason: 'MAX_ATTEMPTS_EXCEEDED', delayMs: 0 }`.
    - Nếu `task.attempts < max_attempts`: Tính toán `delayMs`, tính `nextRetryAt` theo thời gian ISO-8601, trả về `{ shouldRetry: true, reason: 'RETRY_ATTEMPT_ALLOWED' }`.
- **Tầng Dịch Vụ State Machine (`apps/orchestrator/src/services/task-state-service.ts`)**:
  - Bổ sung `retryTask(taskId, options)`:
    - Kiểm tra `policy.evaluate(task)`. Nếu chạm ngưỡng `max_attempts` mà không có cờ `force: true`, ném ngay `AppError('MAX_ATTEMPTS_EXCEEDED')` với mã lỗi và ngữ cảnh chi tiết.
    - Chuyển đổi trạng thái an toàn: Nếu task đang `RUNNING`/`VERIFYING`, đưa về `FAILED` trước, sau đó chuyển sang `READY` để sẵn sàng cho lần điều phối kế tiếp.
    - Ghi nhận sự kiện `task_retry` vào bảng `events` SQLite kèm đầy đủ metadata (`attempt`, `maxAttempts`, `delayMs`, `strategy`, `nextRetryAt`, `reason`) phục vụ truy vết lịch sử (audit trail).
  - Bổ sung `resetAttempts(taskId, newAttempts = 0)`: Cho phép người vận hành reset số lần thử để mở lại chu kỳ xử lý sau sự cố.
- **Tích Hợp Scheduler (`apps/orchestrator/src/services/task-scheduler.ts`)**:
  - Tiếp nhận `retryPolicy` và `autoRetry` (mặc định `true`) trong `TaskSchedulerOptions`.
  - `step(options)`:
    - Khi worker thất bại (`runStatus !== 'SUCCESS'` hoặc exception), chuyển task sang `FAILED`.
    - Tự động gọi `this.retryPolicy.evaluate(failedTask)`.
    - Nếu `shouldRetry`: Chuyển task `FAILED -> READY`, áp dụng `waitBackoff` nếu được yêu cầu, trả về `status: 'RETRYING'`, `retried: true`.
    - Nếu `!shouldRetry` (đã chạm `max_attempts`): Giữ nguyên trạng thái `FAILED`, log warning, trả về `status: 'FAILED'`, `retried: false`, `reason: 'MAX_ATTEMPTS_EXCEEDED'`.
  - `runUntilEmpty(options)`: Vòng lặp tuần tự tự động điều phối lại task qua từng attempt cho đến khi thành công hoặc chạm mốc `max_attempts`, sau đó dừng sạch sẽ mà không bao giờ lặp vô tận.
- **Tầng REST API (`apps/orchestrator/src/routes/tasks.ts`)**:
  - `POST /tasks/:id/retry` & `POST /api/tasks/:id/retry`: Kích hoạt retry qua API.
  - Xử lý lỗi tập trung: Map `MAX_ATTEMPTS_EXCEEDED` sang mã HTTP 400 Bad Request kèm thông điệp rõ ràng.
- **Dependencies**: Không thêm bất kỳ dependency bên ngoài nào mới.

## ORC-005: Checkpoint + Lịch sử lần chạy (attempt, run, kết quả) — Truy lại từng run
- **Mục tiêu & Nghiệm thu**:
  - Triển khai cơ chế checkpointing phục vụ lưu vết các bước trung gian của từng task/run.
  - Xây dựng hệ thống quản lý lịch sử lần chạy đầy đủ theo từng attempt (`attempt, run, kết quả`).
  - Tiêu chuẩn nghiệm thu ROADMAP: "Truy lại từng run" — Cho phép tra cứu sâu bất kỳ run nào theo ID, trả về đầy đủ metadata, kết quả thực thi (duration, outcome, exit code, lỗi), danh sách checkpoints, reports, và thống kê sự kiện (event stats).
- **Cơ sở dữ liệu & Migration 003 (`packages/db/migrations/003_checkpoints.sql`)**:
  - Bổ sung bảng `checkpoints`:
    - `id TEXT PRIMARY KEY`, `task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE`, `run_id TEXT REFERENCES runs(id) ON DELETE CASCADE`, `attempt INTEGER NOT NULL DEFAULT 1`, `step TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'COMPLETED'`, `data TEXT NOT NULL DEFAULT '{}'`, `created_at TEXT NOT NULL`.
    - Các chỉ mục: `idx_checkpoints_task_id`, `idx_checkpoints_run_id`, `idx_checkpoints_task_attempt`.
  - Khai thác bảng `reports` đã có từ Migration 001:
    - Bổ sung `ReportRepository` để lưu trữ và truy vấn báo cáo nghiệm thu/chất lượng gắn với run hoặc task.
- **Mô hình Schemas & Types (`@ai-orchestrator/shared`)**:
  - `CheckpointSchema`, `CreateCheckpointInputSchema`, `CheckpointFilterSchema`.
  - `ReportSchema`, `CreateReportInputSchema`, `ReportFilterSchema`.
  - `RunOutcomeSchema`, `RunResultSummarySchema`, `TaskAttemptHistoryItemSchema`, `TaskRunHistorySchema`, `RunDetailSchema`.
- **Repositories (`@ai-orchestrator/db`)**:
  - `CheckpointRepository`: Hỗ trợ `create`, `getById`, `findByTaskId`, `findByRunId`, `getLatestByTaskId`, `getLatestByRunId`, `countByRunId`, `delete`.
  - `ReportRepository`: Hỗ trợ `create`, `getById`, `findByRunId`, `findByTaskId`, `countByRunId`, `delete`.
- **Tầng Dịch vụ (`apps/orchestrator/src/services/`)**:
  - `TaskHistoryService`:
    - `computeRunResult(run)`: Tính toán thời lượng `duration_ms`, phân loại `outcome` (`SUCCESS`, `ERROR`, `TIMEOUT`, `CANCELLED`, `IN_PROGRESS`, `UNKNOWN`), trích xuất thông điệp lỗi từ `events` (stderr/result payload), tổng hợp số lượng event, checkpoint, report.
    - `getTaskRunHistory(taskId)`: Tổng hợp toàn bộ lịch sử các lần chạy (attempts 1..N) tuần tự theo thời gian kèm run, checkpoints, reports và kết quả.
    - `getRunDetail(runId)`: Truy vấn sâu 1 run duy nhất ("Truy lại từng run"), trả về thông tin task, run, kết quả, checkpoints, reports, toàn bộ events và phân loại `eventStats` theo `type`.
    - Quản lý checkpoint & report: `createCheckpoint`, `getCheckpoints`, `getLatestCheckpoint`, `createReport`, `getReports`.
  - `TaskService` & `RunService`: Tích hợp `TaskHistoryService` để cung cấp các phương thức truy vấn thuận tiện.
  - `TaskScheduler`: Tự động ghi nhận checkpoint `run_started` khi khởi chạy run, và `run_completed`, `run_failed`, `run_cancelled` khi kết thúc từng bước điều phối, bảo đảm lưu vết tự động 100%.
- **Tầng REST API**:
  - Task endpoints:
    - `GET /tasks/:id/history` & `GET /api/tasks/:id/history`: Lịch sử các lần chạy đa attempt.
    - `GET /tasks/:id/checkpoints` & `GET /api/tasks/:id/checkpoints`: Danh sách checkpoint của task.
    - `POST /tasks/:id/checkpoints` & `POST /api/tasks/:id/checkpoints`: Tạo checkpoint cho task.
    - `GET /tasks/:id/checkpoints/latest` & `GET /api/tasks/:id/checkpoints/latest`: Checkpoint mới nhất của task.
  - Run endpoints:
    - `GET /runs/:id/detail` & `GET /api/runs/:id/detail`: Truy lại thông tin chi tiết của 1 run ("Truy lại từng run").
    - `GET /runs/:id/checkpoints` & `GET /api/runs/:id/checkpoints`: Checkpoints của run.
    - `POST /runs/:id/checkpoints` & `POST /api/runs/:id/checkpoints`: Tạo checkpoint cho run.
    - `GET /runs/:id/reports` & `GET /api/runs/:id/reports`: Reports của run.
    - `POST /runs/:id/reports` & `POST /api/runs/:id/reports`: Tạo report cho run.
- **Sửa Đổi Ngoài Phạm Vi Cần Thiết**:
  - Cập nhật `packages/db/src/__tests__/migrator.test.ts` phản ánh sự xuất hiện của migration `003_checkpoints.sql` (tổng 3 migrations, bảng `checkpoints`).
- **Dependencies**: Không thêm bất kỳ dependency bên ngoài nào mới.

## ORC-006: Planner gọi AGY sinh plan JSON (task, scope file, acceptance) từ repo
- **Cấu trúc Plan Schema Zod**: `PlanTaskSchema` bắt buộc `id`, `title`, `scope_files` (mảng file trong repo, tối thiểu 1 file), `acceptance_criteria` (mảng tiêu chí nghiệm thu, tối thiểu 1 tiêu chí), `dependencies`, `test_commands`, `priority`, `timeout_minutes`, `worker_type`.
- **Chuẩn hóa linh hoạt bí danh**: `PlanTaskInputSchema` tự động ánh xạ các biến thể bí danh LLM (`files`/`scope` -> `scope_files`, `acceptance` -> `acceptance_criteria`) và chuyển đổi sang schema chuẩn.
- **Trạng thái Plan**: Quản lý vòng đời `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `EXECUTING`, `COMPLETED`, `FAILED` (mặc định khởi tạo `PENDING_APPROVAL` chuẩn bị cho bước duyệt ORC-007).
- **Migration 004 & SQLite Persistence**: Thêm `004_plans.sql` và `PlanRepository` hỗ trợ lưu trữ toàn vẹn JSON tasks, raw output, trạng thái phê duyệt và khóa ngoại tới bảng `features`.
- **Kiểm định đồ thị phụ thuộc (DAG)**: Sử dụng `DependencyGraph` và `validatePlanTasksGraph` để chặn chu trình phụ thuộc (circular dependency), tự phụ thuộc, mã task ID trùng lặp, hoặc tham chiếu task ID không tồn tại trong plan.
- **Planner Service & Process Execution**: `PlannerService` gọi AGY CLI bằng `ProcessAdapter.spawn` (không dùng shell động) với prompt chuyên biệt, bóc tách JSON an toàn từ markdown fence/raw text, và giám sát timeout watchdog.
- **REST API Endpoints**: Cung cấp `POST /plans/generate`, `POST /plans/validate`, `GET /plans/:id`, `GET /plans`, `DELETE /plans/:id` (hỗ trợ cả tiền tố `/api`).
- **Dependencies**: Không thêm bất kỳ dependency bên ngoài nào mới; tái sử dụng Zod, better-sqlite3 và Fastify.

## ORC-007: Chế độ review: plan chờ approve mới chạy — Chưa duyệt → không thực thi
- **Mô hình Review & Approve**: Bổ sung `ApprovePlanInputSchema`, `RejectPlanInputSchema`, `PlanReviewSummarySchema`, `ExecutePlanInputSchema` trong `@ai-orchestrator/shared`.
- **Ràng buộc nghiệm thu "Chưa duyệt → không thực thi"**: Hàm `assertPlanApproved(plan)` và `assertCanExecute(id)` kiểm tra `status === 'APPROVED'`; nếu khác `APPROVED` (như `PENDING_APPROVAL`, `REJECTED`, `DRAFT`) lập tức ném `AppError('PLAN_NOT_APPROVED')` kèm mã HTTP 400.
- **Dịch vụ PlanReviewService**: Tách riêng dịch vụ review quản lý phê duyệt (`approvePlan`), từ chối (`rejectPlan`), chỉnh sửa (`editPlan`), gửi duyệt (`submitForReview`), và tra cứu tóm tắt (`getReviewSummary`).
- **Tóm tắt Review & Phân tích Đồ thị**: `computePlanReviewSummary` tính toán thứ tự thực thi tô-pô DAG (`execution_order`), các tầng phụ thuộc song song (`stages`), tập hợp file phạm vi duy nhất (`unique_scope_files`), và phát hiện cảnh báo va chạm file giữa các tác vụ độc lập.
- **Tự động yêu cầu duyệt lại khi sửa đổi**: Khi chỉnh sửa tasks trên kế hoạch đã `APPROVED`, hệ thống tự động reset trạng thái về `PENDING_APPROVAL`, xóa mốc duyệt để bảo đảm an toàn.
- **REST API Endpoints**: Bổ sung `POST /plans/:id/approve`, `POST /plans/:id/reject`, `POST /plans/:id/submit`, `GET /plans/:id/review`, `PATCH /plans/:id`, `POST /plans/:id/execute` (hỗ trợ cả tiền tố `/api`).
- **Centralized Error Handling**: Ánh xạ mã lỗi `PLAN_NOT_APPROVED` và `INVALID_PLAN_STATE_TRANSITION` về HTTP 400 Bad Request trong Fastify server.
- **Dependencies**: Tái sử dụng Zod, better-sqlite3 và Fastify; không thêm dependency ngoài mới nào.

## ORC-008: Điều phối theo plan đã duyệt — Chạy đúng thứ tự dependency
- **Migration 005 & Data Model**: Bổ sung `005_plan_orchestration.sql` thêm cột `plan_id` và index vào `tasks`; cập nhật `TaskSchema`, `TaskRepository`, và `ResolveReadyOptions`.
- **Dịch vụ PlanOrchestrator**: Quản lý điều phối kế hoạch, đồng bộ tasks sang SQLite (`materializePlanTasks`), thực thi từng bước (`stepPlan`) hoặc toàn diện (`orchestratePlan`).
- **Ràng buộc "Chưa duyệt → không thực thi"**: Kế hoạch chưa ở trạng thái `APPROVED` hoặc `EXECUTING` lập tức bị chặn với lỗi `PLAN_NOT_APPROVED` (HTTP 400).
- **Nghiệm thu "Chạy đúng thứ tự dependency"**: Tích hợp `TaskScheduler` và `DependencyResolver` bảo đảm task chỉ được acquire và thực thi khi toàn bộ dependencies đã `DONE`.
- **Đồ thị DAG phân nhánh & hội tụ**: Root chạy đầu, các nhánh chạy tuần tự theo lock 1 agent, task hội tụ (Join) chỉ kích hoạt khi toàn bộ nhánh phụ thuộc đạt `DONE`.
- **Cô lập lỗi (Failure Isolation)**: Khi một task thất bại hết lượt retry, các task phụ thuộc phía sau tuyệt đối không được kích hoạt; kế hoạch tự động chuyển sang `FAILED`.
- **Hoàn tất kế hoạch**: Khi 100% tasks trong plan đạt trạng thái `DONE`, trạng thái kế hoạch tự động chuyển sang `COMPLETED`.
- **REST API & Dependencies**: Bổ sung `POST /plans/:id/dispatch`, `/plans/:id/step`, `/plans/:id/orchestrate`, `GET /plans/:id/execution`; không thêm dependency bên ngoài mới nào.


