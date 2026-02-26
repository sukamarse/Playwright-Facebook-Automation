const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process'); // THƯ VIỆN QUẢN LÝ MULTI THREADED

let mainWindow;
let isRunning = false;
let activeWorkers = {}; // Lưu trữ danh sách các công nhân đang cày

const BASE_DATA_FOLDER = 'C:\\Playwright\\ChromeData';
const PROFILES_FILE = 'C:\\Playwright\\profiles.json';

if (!fs.existsSync('D:\\AutoSelenium')) fs.mkdirSync('D:\\AutoSelenium', { recursive: true });
if (!fs.existsSync(BASE_DATA_FOLDER)) fs.mkdirSync(BASE_DATA_FOLDER, { recursive: true });

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 700,
        height: 900,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    mainWindow.loadFile('index.html');
    mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(createWindow);

function sendLog(msg) {
    if (mainWindow) {
        const time = new Date().toLocaleTimeString();
        mainWindow.webContents.send('log-message', `[${time}] ${msg}`);
    }
}

// ... (GIỮ NGUYÊN TOÀN BỘ CÁC HÀM XỬ LÝ JSON PROFILE CŨ: get-profiles, save-profile, delete-profile, update-profile-image, select-image) ...
ipcMain.handle('get-profiles', () => { /* Giữ nguyên code cũ của bạn */ 
    let profiles = {};
    if (fs.existsSync(PROFILES_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));
            if (Array.isArray(data)) {
                for (let name of data) profiles[name] = { proxy: { ip: "", port: "", user: "", pass: "" }, image: null };
            } else {
                profiles = data;
                for (let key in profiles) {
                    if (!profiles[key].image) profiles[key].image = null; 
                    if (typeof profiles[key].proxy === 'string') {
                        let pStr = profiles[key].proxy.trim().replace(/^https?:\/\//i, '');
                        if (pStr) {
                            let parts = pStr.split(':');
                            profiles[key].proxy = { ip: parts[0] ? parts[0].trim() : "", port: parts[1] ? parts[1].trim() : "", user: parts[2] ? parts[2].trim() : "", pass: parts[3] ? parts[3].trim() : "" };
                        } else { profiles[key].proxy = { ip: "", port: "", user: "", pass: "" }; }
                    } else if (!profiles[key].proxy) { profiles[key].proxy = { ip: "", port: "", user: "", pass: "" }; }
                }
            }
            fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 4));
            return profiles;
        } catch (e) {}
    }
    return profiles;
});
ipcMain.handle('save-profile', (event, name, proxyObj) => { let profiles = {}; if (fs.existsSync(PROFILES_FILE)) try { profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8')); } catch(e){} profiles[name] = { proxy: proxyObj, image: null }; fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 4)); return profiles; });
ipcMain.handle('delete-profile', (event, name) => { let profiles = {}; if (fs.existsSync(PROFILES_FILE)) try { profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8')); } catch(e){} delete profiles[name]; fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 4)); return profiles; });
ipcMain.handle('update-profile-image', (event, name, imagePath) => { let profiles = {}; if (fs.existsSync(PROFILES_FILE)) try { profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8')); } catch(e){} if (profiles[name]) { profiles[name].image = imagePath; fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 4)); } return profiles; });
ipcMain.handle('select-image', async () => { const res = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'png', 'jpeg'] }] }); return res.canceled ? null : res.filePaths[0]; });


// =========================================================================
// QUẢN LÝ TIẾN TRÌNH CON (TRUE MULTI-PROCESSING)
// =========================================================================

ipcMain.on('stop-bot', () => {
    isRunning = false;
    sendLog("🛑 Đã nhận lệnh dừng. Đang tiêu diệt toàn bộ luồng...");
    
    // Gửi lệnh stop hoặc Bắn bỏ trực tiếp các tiến trình đang chạy
    for (let profileName in activeWorkers) {
        if (activeWorkers[profileName]) {
            activeWorkers[profileName].kill(); // Tiêu diệt tiến trình ngay lập tức giải phóng RAM
            sendLog(`💀 Đã ngắt tiến trình [${profileName}]`);
        }
    }
    activeWorkers = {}; // Xóa sạch danh sách
    mainWindow.webContents.send('state-change', false);
});

ipcMain.on('start-bot', async (event, config) => {
    if (isRunning) return;
    isRunning = true;
    mainWindow.webContents.send('state-change', true);

    const { selectedProfiles, allProfilesObj, webAppUrl, minPost, maxPost } = config;

    selectedProfiles.forEach((profileName, index) => {
        // Delay 1 phút giữa các tiến trình để tránh CPU giật lag
        setTimeout(() => {
            if (!isRunning) return;

            sendLog(`🚀 Đang khởi tạo tiến trình độc lập cho [${profileName}]...`);
            
            // TẠO TIẾN TRÌNH CON ĐỘC LẬP TỪ FILE worker.js
            const worker = fork(path.join(__dirname, 'worker.js'));
            activeWorkers[profileName] = worker;

            // Lắng nghe log từ tiến trình con gửi lên
            worker.on('message', (message) => {
                if (message.type === 'log') {
                    sendLog(`[${profileName}] ${message.msg}`);
                }
            });

            // Nếu tiến trình con bị crash hoặc tự đóng
            worker.on('exit', (code) => {
                sendLog(`[${profileName}] Tiến trình đã kết thúc (Code: ${code}). RAM đã được giải phóng.`);
                delete activeWorkers[profileName];
                
                // Nếu tất cả tiến trình đều chết, báo UI dừng lại
                if (Object.keys(activeWorkers).length === 0) {
                    isRunning = false;
                    mainWindow.webContents.send('state-change', false);
                    sendLog("🎉 TẤT CẢ TIẾN TRÌNH ĐÃ DỪNG!");
                }
            });

            // Truyền cấu hình và ra lệnh cho tiến trình con bắt đầu chạy
            worker.send({
                type: 'start',
                config: {
                    profileName: profileName,
                    proxyObj: allProfilesObj[profileName]?.proxy,
                    profileImage: allProfilesObj[profileName]?.image,
                    webAppUrl: webAppUrl,
                    minPost: minPost,
                    maxPost: maxPost,
                    BASE_DATA_FOLDER: BASE_DATA_FOLDER
                }
            });

        }, index * 60000); // So le 60 giây
    });
});