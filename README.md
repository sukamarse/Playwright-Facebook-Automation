# FB Automation

Bot tự động comment Facebook đa luồng, chạy trên Electron + Playwright.

---
Note: Project được xây dựng cho mục đích cá nhân, việc triển khai code được thực hiện với sự hỗ trợ của các công cụ AI
---

## 📁 Cấu trúc dự án

```
fb-automation/
├── package.json
├── AppScript.js          ← Code dán vào Google Apps Script
├── src/
│   ├── main.js           ← Electron main process
│   ├── preload.js        ← IPC bridge
│   └── worker.js         ← Bot logic (1 tiến trình / profile)
└── ui/
    └── index.html        ← Giao diện
```

---

## ⚙️ Cài đặt

```bash
# 1. Vào thư mục dự án
cd fb-automation

# 2. Cài dependencies
npm install

# 3. Chạy app
npm start
```

> Yêu cầu máy đã cài **Google Chrome** vì bot dùng `channel: 'chrome'`.

---

## 📂 Dữ liệu lưu ở đâu

Tất cả cố định tại `C:\Playwright\`:

```
C:\Playwright\
├── profiles.json          ← Danh sách profile + proxy + đường dẫn ảnh
├── ChromeData\
│   ├── Nick1\             ← Session Chrome của profile "Nick1"
│   ├── Trang\
│   └── ...
└── Logs\
    ├── 2025-01-15.log
    ├── 2025-01-16.log
    └── ...
```

Log được **buffer trong RAM** và ghi ra HDD mỗi **15 phút** (hoặc khi tích lũy 200 dòng) để giảm số lần HDD spin-up.

---

## 🗂️ Cấu trúc Google Sheet

Mỗi sheet = 1 profile. Tên sheet phải **khớp chính xác** với tên profile trong app.

| Cột A | Cột B | Cột I |
|---|---|---|
| Link Facebook | Status (tự động) | Timestamp lần cuối fetch |
| https://fb.com/... | _(trống)_ | 🕐 Lần cuối fetch: ... |
| https://fb.com/... | FAIL | |
| https://fb.com/... | BLOCK | |

- **FAIL**: Link bị lỗi không comment được (thử lại 2 vòng liên tiếp vẫn fail).
- **BLOCK**: Facebook chặn tính năng comment tại bài viết này (ví dụ: "Giờ bạn chưa dùng được tính năng này"). Bot tự động bỏ qua link này ở các vòng lặp sau trong ngày.

Sheet đặc biệt tên **`comments`** (viết thường) chứa danh sách nội dung comment, mỗi dòng 1 câu.

Sheet nào tên bắt đầu bằng `_` sẽ bị bỏ qua (dùng để ghi chú / config).

---

## 🔌 Cài đặt Google Apps Script

1. Mở Google Sheet → **Extensions → Apps Script**
2. Xóa toàn bộ code mặc định, dán nội dung file `AppScript.js` vào
3. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Copy URL deployment dán vào ô URL trong app
5. Khi cập nhật script: **Deploy → Manage deployments → Edit → New version → Deploy**

---

## 🚀 Hướng dẫn sử dụng

### Lần đầu (đăng nhập)
1. Thêm profile → nhấn **🌐 Mở** → đăng nhập Facebook trong cửa sổ mở ra → đóng lại
2. Lặp lại cho từng profile

### Chạy bot
1. Tick chọn các profile muốn chạy
2. Dán URL Google Apps Script
3. Cài khung giờ hoạt động và thời gian nghỉ giữa các post
4. Nhấn **▶ BẮT ĐẦU CHẠY ĐA LUỒNG**

### Gán ảnh cho profile
Nhấn **🖼 Đổi** cạnh tên profile → chọn ảnh JPG/PNG. Bot sẽ đính kèm ảnh vào comment theo xác suất ngẫu nhiên.

---

## ⚡ Tính năng

### Bot
- **Đa luồng** — mỗi profile chạy tiến trình riêng biệt, độc lập hoàn toàn
- **Stagger khởi động** — delay 30 giây giữa các profile, tránh spike CPU
- **Khung giờ hoạt động** — tự ngủ ngoài giờ, hỗ trợ overnight (VD: 23:00–06:00)
- **Pause / Resume** từng profile riêng lẻ
- **Status dot** màu real-time trên từng profile (🟢 running / 🟡 paused / 🔵 sleeping / 🔴 error)
- **Smart comment box** — 4 lớp bảo vệ tránh nhầm vào Messenger dock
- **Tự đóng chat popup** trước khi comment
- **Xóa comment cũ (Tùy chọn)** — Tự động tìm và xóa tối đa 2 comment cũ nhất của chính profile đó trong bài viết trước khi comment mới, giúp tránh bị Facebook filter spam.
- **3 mode comment**: chỉ text / chỉ ảnh / text + ảnh

### 🕵️ Anti-Detection (Chống phát hiện Bot)
- **Stealth Inject Script** — Xóa hoàn toàn cờ `navigator.webdriver`, spoof toàn bộ thông số WebGL, Plugins ảo, Chrome Object để giả lập người thật 100%.
- **Random Viewport** — Mỗi session sử dụng độ phân giải trình duyệt khác nhau để tránh fingerprinting tĩnh.
- **Human-like Mouse/Scroll** — Cuộn trang ngẫu nhiên nhiều bước, có khoảng nghỉ ngẫu nhiên mô phỏng người dùng đọc bài.
- **Fix Notification & Permissions** — Chặn các popup permission ngầm của Chrome (sửa lỗi trả về state bị từ chối ngầm của Playwright).

### 🛡 Reliability & Crash Handling
- **Tự động xử lý Crash (OOM)** — Bắt sự kiện `page.on('crash')` (Out-of-memory, Status Breakpoint). Khi tab bị văng do Facebook quá nặng, bot tự động bỏ qua và sang link mới mà không bị treo tiến trình vĩnh viễn.
- **Phát hiện chặn Comment thông minh** — Quét nội dung DOM tìm các thông báo block ("Giờ bạn chưa dùng được tính năng này", "Để bảo vệ cộng đồng", v.v.). Đánh dấu `BLOCK` lên Sheet và lưu vào bộ nhớ tạm để bỏ qua link ở lịch trình tiếp theo.
- **Auto detect session hết hạn** — dừng ngay và báo thay vì chạy vô ích
- **Retry với backoff** — lỗi fetch Sheet thử lại tối đa 5 lần (2→4→6→...30 phút)
- **Fail tracking 2 vòng** — link fail 1 lần chưa ghi, fail 2 vòng liên tiếp mới ghi FAIL lên Sheet
- **Graceful shutdown** — gửi stop, đợi Chrome đóng sạch trước khi force kill

### ⚡ Tiết kiệm tài nguyên
- **Block Media & Font** — Không load Video (tính năng autoplay của FB rất ngốn RAM), Audio, và Font ngoài → Tiết kiệm 30-50MB RAM môi tab.
- **sleepLong() chunk 30s** cho các quãng ngủ dài (ngủ giữa vòng, chờ data, ngoài giờ)
- **setStatus dedup** — không gửi IPC nếu trạng thái không đổi
- **Log buffer 15 phút** — HDD chỉ bị ghi tối đa 4 lần/giờ
- **Chrome flags cực nhẹ** — Tắt extension, tắt backgrounding ngầm, giới hạn RAM (`--max-old-space-size`).


---

## 🔄 Luồng hoạt động

```
Khởi động worker
      ↓
Fetch data từ Google Sheet
      ↓
Mở Chrome → Check session
      ↓
Lặp qua từng link:
  → Bỏ qua nếu link nằm trong danh sách BLOCK của session
  → Scroll ngẫu nhiên mô phỏng người dùng + đóng chat popup
  → Xóa tối đa 2 comment cũ của mình (nếu tính năng được bật)
  → Tìm ô comment (loại trừ Messenger)
  → Upload ảnh (nếu có)
  → Gõ comment + gửi
  → Ghi nhớ fail / báo FAIL lên Sheet
  → Nghỉ ngẫu nhiên (minPost–maxPost giây)
      ↓
Đóng Chrome, giải phóng RAM
      ↓
Ngủ 60–120 phút → lặp lại
```

---

## 📋 Cấu hình

| Tham số | Mô tả | Mặc định |
|---|---|---|
| Giờ bắt đầu | Giờ bot bắt đầu hoạt động | 06:45 |
| Giờ kết thúc | Giờ bot dừng (hỗ trợ overnight) | 00:30 |
| Nghỉ min (giây) | Thời gian nghỉ tối thiểu giữa 2 post | 180 |
| Nghỉ max (giây) | Thời gian nghỉ tối đa giữa 2 post | 360 |

---

## 🔐 Bảo mật

- Thông tin proxy lưu plain text trong `profiles.json` — không chia sẻ file này
- Mỗi profile có thư mục Chrome riêng, session hoàn toàn tách biệt
- Preload script dùng `contextIsolation: true` theo best practice của Electron
