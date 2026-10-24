# Hướng dẫn test nhanh AI Orchestrator

Đặt thư mục `demo-data/` vào gốc repo (cùng cấp `package.json`).

## 0. Chuẩn bị (1 lần)
```bash
cd "/Users/truongthinh/Documents/AI Orchestrator"
git status --short            # nên sạch; nếu còn ops-007.test.ts thì commit trước
cp .env.example .env
mkdir -p data logs
pnpm install
pnpm build
```

## 1. Chạy backend (Terminal 1)
```bash
pnpm --filter @ai-orchestrator/orchestrator start
```
Kiểm tra ở terminal khác:
```bash
curl http://127.0.0.1:3000/api/health
curl http://127.0.0.1:3000/api/tasks
```

## 2. Chạy dashboard (Terminal 2)
```bash
pnpm --filter @ai-orchestrator/dashboard dev
```
Mở http://localhost:3001

## 3. Kịch bản test Import (trang /import)
Ở ô đường dẫn file máy chủ, nhập đường dẫn THƯ MỤC (hệ thống đọc tasks.csv + features.csv + config.csv):

| Bộ dữ liệu | Đường dẫn nhập | Kết quả mong đợi khi bấm "Xem trước" |
|---|---|---|
| Hợp lệ | `demo-data/demo-csv` | HỢP LỆ: 5 task, 1 feature, 0 lỗi. Nút "Xác nhận Nhập" bật. |
| Nhiều lỗi | `demo-data/bad-csv` | KHÔNG HỢP LỆ. Nút Xác nhận bị khóa. Lỗi gồm: trùng `BAD-001`; dependency `BAD-999` không tồn tại; dòng BAD-004 thiếu title; BAD-005 priority "abc"; BAD-006 trỏ feature không có. |
| Chu trình | `demo-data/cycle-csv` | KHÔNG HỢP LỆ. Báo chu trình dạng CYC-001 -> CYC-003 -> CYC-002 -> CYC-001. |

Kiểm tra thêm:
1. Import `demo-csv` → bấm "Xác nhận Nhập" → vào /tasks thấy 5 task.
2. Import `demo-csv` lần 2 → phải bị từ chối vì trùng ID với DB.
3. Import `bad-csv` rồi xem /tasks: KHÔNG được có task BAD-xxx nào (nhập bị từ chối nguyên khối).

## 4. Kiểm tra thứ tự phụ thuộc (sau khi nhập demo-csv)
Thứ tự đúng: DEMO-001 → (DEMO-002 và DEMO-003) → DEMO-004 → DEMO-005.
- Chỉ DEMO-001 được ở trạng thái READY lúc đầu.
- DEMO-004 chỉ READY khi cả DEMO-002 và DEMO-003 đã DONE.

## 5. Chạy task thật với AGY (thận trọng)
Chỉ làm sau khi bước 3-4 ổn. Thử trên một repo thử riêng, không dùng repo chính, vì AGY chạy với quyền tự duyệt:
```bash
mkdir -p ~/sandbox/hello && cd ~/sandbox/hello && git init && git commit --allow-empty -m init
```
Đăng ký repo `~/sandbox/hello` trong dashboard rồi bấm chạy (trang /controls), xem log trực tiếp.
Ghi lại: thời gian một task, quota Gemini/Claude trước và sau.

## 6. Điều khiển
Trang /controls: thử Pause, Resume, Stop khi task đang chạy; sau đó kiểm tra trạng thái trong /tasks có khớp.

## 7. Test tự động và soak test
```bash
pnpm test
node scripts/run-soak-test.mjs --mode virtual --duration 900000 --iterations 15 --tasks 10
```

## Lưu ý
- Tên cột trong CSV theo ROADMAP (`task_id`, `feature_id`, ...). Nếu import báo thiếu cột hoặc lỗi định dạng, mở `fixtures/sample-csv/tasks.csv` có sẵn trong repo, so tiêu đề cột và cách ghi nhiều dependency (dấu phẩy hay chấm phẩy) rồi sửa file demo cho khớp.
- Nếu preview của `demo-csv` báo lỗi mà không phải do cố ý, gửi lại nguyên văn lỗi để chỉnh.
