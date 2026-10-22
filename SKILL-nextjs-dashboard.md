# SKILL: Next.js Dashboard (TSK-007, UI-001 → UI-008)

## Nguyên tắc
- Next.js App Router + TypeScript strict. Dashboard **chỉ** hiển thị/điều khiển; mọi logic nằm ở Orchestrator API.
- Gọi API qua 1 client duy nhất `lib/api.ts` (base URL từ env `NEXT_PUBLIC_ORCH_URL`); kiểu dữ liệu lấy từ `packages/shared`.
- Server Components cho trang danh sách; Client Components cho phần realtime/điều khiển.
- Không mock dữ liệu trong bản chính: trạng thái, log, diff đều từ API thật. Có trạng thái loading/empty/error rõ ràng.

## Live logs (SSE)
```ts
const es = new EventSource(`${ORCH}/runs/${id}/stream`);
es.onmessage = (e) => append(JSON.parse(e.data));
es.onerror = () => { /* hiển thị mất kết nối, EventSource tự reconnect */ };
// cleanup: return () => es.close();
```
Giới hạn số dòng giữ trong bộ nhớ (vd 5000), auto-scroll có nút dừng cuộn.

## Màn hình
| Màn | Nội dung |
|---|---|
| Tasks | bảng + lọc theo phase/feature/status |
| Task detail | timeline các run, log, test report, findings |
| Diff | hiển thị diff unified, tô màu thêm/xóa |
| Controls | Pause, Resume, Stop, Approve (xác nhận trước khi Stop) |
| Release | branch, commit SHA, PR URL |

## Chất lượng
- Thao tác điều khiển phải `disabled` khi đang gọi; hiển thị lỗi từ API.
- Có test component cơ bản (Vitest + Testing Library) cho các nút điều khiển và bảng task.
- Giao diện đơn giản, dùng được local, chưa cần đẹp tối đa ở MVP.
