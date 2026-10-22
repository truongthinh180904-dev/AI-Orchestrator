# SKILL: Git & Release (REL-*, FND-006)

## Quy tắc an toàn
- Trước khi làm: `git status --porcelain` phải rỗng (hoặc chỉ chứa thay đổi của chính task). Bẩn ngoài ý muốn → `BLOCKED`.
- Ưu tiên `git worktree add ../wt-<task-id> -b agy/<task-id>-<slug>` để cô lập.
- Branch: `agy/<task-id>-<slug>` (task), `feature/<feature-id>` (release). Branch đã tồn tại → lỗi, không ghi đè.
- Cấm: `push --force`, `reset --hard` trên nhánh chung, `rebase` nhánh đã push, push trực tiếp `main`, tự merge PR.
- Gọi git bằng `spawn('git', [...args], { cwd })`, parse output `--porcelain`.

## Commit
Conventional Commits: `feat(AGY-002): parse NDJSON stream`. Một commit logic / task. Lưu SHA (`git rev-parse HEAD`) vào DB.

## Push & PR
1. `git push -u origin <branch>`; xác nhận bằng `git ls-remote --heads origin <branch>`.
2. `gh pr create --base main --head <branch> --title "..." --body-file reports/<feature>.md`.
3. Lưu URL PR + SHA + quality report. Trạng thái feature = `READY_FOR_REVIEW`; **chờ người duyệt**.
4. Lỗi mạng/auth → retry có giới hạn rồi `FAILED` kèm log; không in token ra log.

## Điều kiện release
Đủ mọi task bắt buộc của feature `DONE` + integration test pass + Quality Gate PASS.
