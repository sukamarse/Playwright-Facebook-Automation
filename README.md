# FB Automation v2 — Hướng dẫn cài đặt

## 📁 Cấu trúc dự án

```
fb-automation/
├── package.json
├── src/
│   ├── main.js         ← Electron main process
│   ├── preload.js      ← IPC bridge (security layer)
│   └── worker.js       ← Bot logic (1 tiến trình / profile)
├── ui/
│   └── index.html      ← Giao diện người dùng
└── assets/
    └── icon.png        ← (Tùy chọn) Icon app
```

## ⚙️ Cài đặt

```bash
# 1. Vào thư mục dự án
cd fb-automation

# 2. Cài dependencies
npm install

# 3. Cài Playwright browsers (chỉ cần 1 lần)
npx playwright install chromium

# 4. Chạy app
npm start
```

## 📂 Dữ liệu lưu ở đâu?

Toàn bộ dữ liệu được lưu tự động trong thư mục AppData của user hiện tại:

```
Windows:  C:\Users\<TênUser>\AppData\Roaming\fb-automation-v2\FB_Automation\
  ├── profiles.json       ← Danh sách profile
  ├── ChromeData\         ← Cookie/session Chrome của từng profile
  └── Logs\
        ├── 2025-01-15.log
        ├── 2025-01-16.log
        └── ...
```

> **Không còn hardcode ổ C** — dùng được trên mọi máy.

## 🆕 Tính năng mới so với v1

| Tính năng | v1 | v2 |
|---|---|---|
| Phát hiện session hết hạn | ❌ | ✅ Tự động check + báo |
| Log file theo ngày | ❌ | ✅ Tự động lưu .log |
| Pause / Resume từng profile | ❌ | ✅ |
| Status dot từng profile | ❌ | ✅ Màu real-time |
| Retry thông minh (backoff) | ❌ | ✅ Tối đa 5 lần |
| fetch() timeout | ❌ | ✅ 30 giây |
| Validate schema Sheet | ❌ | ✅ |
| Smart comment box (4 lớp chống nhầm Messenger) | ❌ | ✅ |
| Path động (không hardcode ổ C) | ❌ | ✅ |
| Profile folder collision-free | ❌ | ✅ Hash suffix |
| Color-coded log | ❌ | ✅ |
| Graceful shutdown | ❌ | ✅ |

## 📋 Format Google Apps Script

API cần trả về JSON theo cấu trúc:

```json
{
  "profiles": {
    "Nick 1": ["https://fb.com/...", "https://fb.com/..."],
    "Nick 2": ["https://fb.com/..."]
  },
  "comments": [
    "Comment mẫu 1",
    "Comment mẫu 2",
    "Comment mẫu 3"
  ]
}
```

## 🔐 Lưu ý bảo mật

- Thông tin proxy vẫn lưu dạng plain text trong `profiles.json`
- Không chia sẻ file `profiles.json` ra ngoài
- Mỗi profile có thư mục Chrome riêng biệt, không chia sẻ session với nhau
