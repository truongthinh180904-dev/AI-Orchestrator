# Hướng Dẫn Vận Hành Service Khởi Động (launchd) & Chống Ngủ (caffeinate) Trên macOS

Tài liệu này hướng dẫn chi tiết cách thiết lập, cấu hình và vận hành **AI Orchestrator** dưới dạng tiến trình nền (LaunchAgent) trên hệ điều hành macOS, kết hợp cơ chế chống ngủ **caffeinate** để đảm bảo hệ thống vận hành bền bỉ, liên tục và tự động phục hồi suốt đêm mà không bị gián đoạn bởi cơ chế tiết kiệm điện năng của hệ điều hành.

---

## 1. Kiến Trúc Dịch Vụ Nền Trên macOS: LaunchAgent vs LaunchDaemon

Hệ điều hành macOS sử dụng hệ thống init và quản lý tiến trình tập trung **launchd**. Đối với các ứng dụng điều phối mã nguồn và thực thi AI như AI Orchestrator:

- **LaunchAgent (`~/Library/LaunchAgents/`)**:
  - Chạy trong bối cảnh phiên đăng nhập của người dùng (`gui/<UID>`).
  - Có toàn quyền truy cập vào môi trường làm việc của lập trình viên: Node.js, pnpm, Git SSH credentials, khóa bảo mật GPG/Keychain, biến môi trường người dùng và tiện ích `/usr/bin/caffeinate`.
  - **Khuyến nghị**: AI Orchestrator được thiết kế chạy dưới dạng **LaunchAgent per-user** để đảm bảo thực thi an toàn, không cần quyền `root`/`sudo`.

- **LaunchDaemon (`/Library/LaunchDaemons/`)**:
  - Chạy ở mức hệ thống dưới quyền `root`, khởi động trước khi người dùng đăng nhập.
  - Hạn chế truy cập vào Keychain và GUI domain của người dùng, không phù hợp cho tác vụ git release và chạy công cụ phát triển phần mềm.

---

## 2. Chi Tiết File Cấu Hình Property List (.plist)

Hệ thống cung cấp sẵn 2 tệp plist hoàn chỉnh đã được kiểm tra tính hợp lệ (`plutil -lint` PASS):

### 2.1. Service Daemon: `services/launchd/com.ai-orchestrator.service.plist`
Dành cho tiến trình máy chủ API Orchestrator (Fastify Server, SQLite DB, Task Scheduler, Resource Quota, System Resource Monitor).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ai-orchestrator.service</string>
    <key>ProcessType</key>
    <string>Standard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-dimsu</string>
        <string>/usr/bin/env</string>
        <string>pnpm</string>
        <string>--filter</string>
        <string>@ai-orchestrator/orchestrator</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/truongthinh/Documents/AI Orchestrator</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>NODE_ENV</key>
        <string>production</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/truongthinh/Documents/AI Orchestrator/logs/launchd.service.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/truongthinh/Documents/AI Orchestrator/logs/launchd.service.stderr.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>30</integer>
</dict>
</plist>
```

#### Giải thích các tham số cốt lõi:
- **`Label`**: Tên định danh duy nhất của service trong hệ thống launchd (`com.ai-orchestrator.service`).
- **`ProgramArguments`**: Lệnh thực thi được bọc ngoài bởi `/usr/bin/caffeinate -dimsu`. Caffeinate sẽ giữ máy thức liên tục chừng nào tiến trình con (`pnpm start`) còn hoạt động.
- **`WorkingDirectory`**: Đường dẫn thư mục gốc dự án.
- **`EnvironmentVariables`**: Thiết lập `PATH` (chứa các thư mục cài đặt `node`, `pnpm`, `git`, Homebrew) để launchd tìm thấy các binary cần thiết.
- **`RunAtLoad`**: Đặt là `true` để service tự động khởi chạy ngay khi người dùng đăng nhập vào macOS.
- **`KeepAlive`**: 
  - `Crashed: true`: Tự động khởi động lại service nếu tiến trình bị sập đột ngột (crash/kill).
  - `SuccessfulExit: false`: Khi tiến trình chủ động thoát với mã 0 (chủ động tắt server), launchd không ép khởi động lại.
- **`ThrottleInterval`**: Đặt ngưỡng nghỉ 30 giây giữa các lần khởi động lại để chống tình trạng crash loop liên tục làm cạn kiệt tài nguyên máy.
- **`StandardOutPath` / `StandardErrorPath`**: Ghi vết nhật ký xuất chuẩn và lỗi ra thư mục `logs/` độc lập.

---

### 2.2. Runner Daemon Xuyên Đêm: `services/launchd/com.ai-orchestrator.runner.plist`
Dành cho tiến trình thực thi hàng loạt các task qua kịch bản `run-agy.sh` theo khung giờ định kỳ (ví dụ kích hoạt vào 22:00 mỗi đêm).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ai-orchestrator.runner</string>
    <key>ProcessType</key>
    <string>Background</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-dimsu</string>
        <string>/bin/bash</string>
        <string>/Users/truongthinh/Documents/AI Orchestrator/run-agy.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/truongthinh/Documents/AI Orchestrator</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>STOP_AT_HOUR</key>
        <string>7</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/truongthinh/Documents/AI Orchestrator/logs/launchd.runner.stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/truongthinh/Documents/AI Orchestrator/logs/launchd.runner.stderr.log</string>
    <key>RunAtLoad</key>
    <false/>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>22</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
</dict>
</plist>
```

---

## 3. Cơ Chế Giữ Máy Thức Bằng `caffeinate`

macOS có cơ chế quản lý năng lượng nghiêm ngặt (App Nap, Display Sleep, System Sleep). Nếu máy rơi vào trạng thái ngủ, các kết nối mạng, tác vụ tính toán và tiến trình nền sẽ bị tạm ngưng (freeze).

Tiện ích `/usr/bin/caffeinate` của macOS cung cấp giải pháp can thiệp Power Management Assertion:

| Cờ (Flag) | Ý nghĩa kỹ thuật | Tác dụng trong chạy xuyên đêm |
|---|---|---|
| `-d` | Create a display sleep assertion | Giữ màn hình luôn sáng, ngăn OS đưa GPU/Display vào chế độ sleep |
| `-i` | Create an idle sleep assertion | Ngăn macOS chuyển sang trạng thái ngủ khi máy không có người dùng thao tác |
| `-m` | Create a disk idle assertion | Giữ ổ cứng/SSD luôn ở trạng thái sẵn sàng, ngăn ngắt đĩa lúc ghi SQLite |
| `-s` | Create a system sleep assertion | Ngăn toàn bộ hệ điều hành sleep khi máy đang cắm nguồn sạc AC |
| `-u` | Declare user active assertion | Giả lập sự hiện diện của người dùng |
| `-w <PID>` | Wait for process PID | Tự động giữ máy thức cho đến khi tiến trình PID tương ứng kết thúc |

### Khuyến nghị thiết lập phần cứng MacBook chạy xuyên đêm:
1. **Luôn cắm sạc nguồn (AC Power Adapter)**: Cờ `-s` yêu cầu nguồn điện AC để phát huy tối đa hiệu quả.
2. **Cấu hình Clamshell Mode (gập nắp máy)**: Nếu muốn gập màn hình MacBook lại khi ngủ đêm:
   - Cắm sạc nguồn.
   - Kết nối với màn hình ngoài hoặc cổng chuyển đổi HDMI/USB-C (hoặc cài đặt cờ caffeinate).
3. **Cấu hình System Settings trên macOS**:
   - Vào *System Settings* > *Displays* > *Advanced...* > Bật *Prevent automatic sleeping on power adapter when the display is off*.
   - Hoặc chạy wrapper: `./scripts/run-caffeinated.sh <lệnh>`.

---

## 4. Quản Lý Dịch Vụ Bằng Script `scripts/service-control.sh`

Kịch bản `scripts/service-control.sh` cung cấp giao diện dòng lệnh trực quan để cài đặt, khởi động, kiểm tra và gỡ bỏ service mà không cần nhớ cú pháp phức tạp của `launchctl`.

### 4.1. Cài đặt và kích hoạt dịch vụ
```bash
# Cài đặt Orchestrator Server daemon vào ~/Library/LaunchAgents:
./scripts/service-control.sh install service

# Cài đặt Runner xuyên đêm (theo lịch 22:00 -> 07:00):
./scripts/service-control.sh install runner
```

### 4.2. Khởi động / Dừng / Khởi động lại
```bash
# Khởi động dịch vụ
./scripts/service-control.sh start service

# Khởi động lại dịch vụ
./scripts/service-control.sh restart service

# Dừng dịch vụ
./scripts/service-control.sh stop service
```

### 4.3. Kiểm tra trạng thái và nhật ký
```bash
# Kiểm tra trạng thái đăng ký, PID và thông tin launchctl
./scripts/service-control.sh status service

# Xem 30 dòng log mới nhất
./scripts/service-control.sh logs service

# Theo dõi trực tiếp (live streaming logs)
tail -f logs/launchd.service.stdout.log logs/launchd.service.stderr.log
```

### 4.4. Gỡ bỏ dịch vụ
```bash
./scripts/service-control.sh uninstall service
```

---

## 5. Thao Tác Trực Tiếp Bằng Lệnh NATIVE `launchctl`

Dành cho quản trị viên muốn thao tác sâu bằng công cụ chuẩn của Apple:

```bash
# 1. Đăng ký và kích hoạt service trong domain của user hiện tại (macOS hiện đại)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ai-orchestrator.service.plist

# 2. Kiểm tra thông tin chi tiết của service (trạng thái, PID, exit code gần nhất)
launchctl print gui/$(id -u)/com.ai-orchestrator.service

# 3. Ép khởi động (kickstart) ngay lập tức
launchctl kickstart -k gui/$(id -u)/com.ai-orchestrator.service

# 4. Gửi tín hiệu dừng (kill)
launchctl kill SIGTERM gui/$(id -u)/com.ai-orchestrator.service

# 5. Gỡ bỏ service khỏi launchd
launchctl bootout gui/$(id -u)/com.ai-orchestrator.service
```

---

## 6. Tích Hợp Đồng Bộ Với Hệ Thống Điều Phối AI Orchestrator

Dịch vụ launchd + caffeinate kết hợp hoàn hảo với các thành phần đã phát triển trong Giai đoạn 7:

1. **Tuân thủ khung giờ (OPS-002)**: Khi server khởi động dưới dạng service, `ExecutionScheduleManager` kiểm soát giờ chạy. Ngoài khung giờ (ví dụ ban ngày), TaskScheduler tự động ở trạng thái nghỉ, không tiêu tốn tài nguyên.
2. **Tự động phục hồi sau restart (OPS-003)**: Khi máy khởi động lại hoặc service bị launchd restart, `main.ts` kích hoạt `autoRecover: true`. `RecoveryService` tự động kiểm tra task/run dở dang từ phiên trước, requeue các task chưa quá hạn thử và bảo toàn 100% lịch sử kiểm toán trong SQLite.
3. **Giám sát liveness và Heartbeat (OPS-004)**: `ProcessMonitorService` liên tục theo dõi PID và heartbeat của worker, tự dọn dẹp các tiến trình chết mà không làm treo hệ thống.
4. **Bảo vệ tài nguyên hệ thống (OPS-005)**: `SystemResourceMonitor` giám sát CPU/RAM/Disk; nếu chạm ngưỡng nguy hiểm, hệ thống tạm dừng nhận task mới và tự hồi phục khi tài nguyên trở lại mức an toàn.
5. **Cơ chế Dừng khẩn cấp (Emergency Stop)**:
   - Tạo file `STOP` ở thư mục gốc: `touch STOP`
   - Hoặc gọi lệnh: `./scripts/service-control.sh stop service`

---

## 7. Xử Lý Sự Cố Thường Gặp (Troubleshooting)

### 7.1. Cảnh báo "Background Items Added" trên macOS Ventura/Sonoma/Sequoia
Khi cài đặt file `.plist`, macOS sẽ hiển thị thông báo hệ thống thông báo mục nền mới được thêm vào.
- **Cách xử lý**: Vào *System Settings* > *General* > *Login Items & Extensions* > Tìm kiếm `pnpm` hoặc `com.ai-orchestrator.service` trong danh sách *Allow in the Background* và đảm bảo công tắc đang bật (**ON**).

### 7.2. Lỗi không tìm thấy `node` hoặc `pnpm` trong log stderr
LaunchAgent chạy trong môi trường non-interactive shell tối giản, không nạp file `~/.zshrc` hoặc `~/.bashrc`.
- **Cách xử lý**: Kiểm tra đường dẫn node/pnpm bằng lệnh `which node` và `which pnpm`. Cập nhật đường dẫn đó vào mục `PATH` trong thẻ `<key>EnvironmentVariables</key>` của tệp `.plist`.

### 7.3. Kiểm tra tính hợp lệ của tệp plist
Trước khi nạp vào launchd, luôn kiểm tra bằng công cụ kiểm định của Apple:
```bash
plutil -lint services/launchd/com.ai-orchestrator.service.plist
# Kết quả phải trả về: OK
```
