# SKILL: Testing & Quality Gate (Vitest)

Dùng khi: mọi task; chính cho QLT-*.

## Quy tắc test
- Vitest; file `*.test.ts` cạnh code hoặc trong `__tests__/`.
- Mỗi task có ít nhất 1 test cho từng dòng "Nghiệm thu", đặt tên test theo tiêu chí đó.
- Không gọi AGY thật, mạng thật, hay Git remote thật trong unit test → dùng mock/fixture/repo tạm (`mkdtemp`).
- Test process: dùng script mock Node; kiểm tra timeout bằng `vi.useFakeTimers()` hoặc timeout ngắn (≤ 500ms).
- Test API: `app.inject()` của Fastify.
- Test DB: `:memory:`.
- Không `it.skip`/`only` khi commit. Không giảm assertion để cho test pass.

## Quality Gate (QLT)
Policy PASS khi **tất cả**:
1. format/lint/typecheck exit 0
2. unit test exit 0
3. build exit 0 (nếu có)
4. không file thay đổi ngoài phạm vi (hoặc đã được giải thích)
5. không finding severity `high/critical` từ reviewer
6. không secret bị lộ, `audit` không có lỗ hổng high+
Mỗi lệnh lưu: `command`, `exit_code`, `stdout`, `stderr`, `duration_ms`. PASS/FAIL tính từ **bằng chứng**, không từ lời AI nói.

## Báo cáo `reports/<task-id>.md`
```
# <task-id>
## Lệnh đã chạy
- `pnpm test` → exit 0
## Nghiệm thu
- [x] <tiêu chí> — bằng chứng: <test/lệnh>
## File thay đổi
...
```
