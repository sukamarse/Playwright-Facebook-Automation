const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { chromium } = require('playwright'); // Đã vá lỗi mở Chrome thủ công

let mainWindow;
let isRunning = false;
let activeWorkers = {}; 

const BASE_DATA_FOLDER = 'C:\\Playwright\\ChromeData';
const PROFILES_FILE = 'C:\\Playwright\\profiles.json';

if (!fs.existsSync('C:\\Playwright')) fs.mkdirSync('C:\\Playwright', { recursive: true });
if (!fs.existsSync(BASE_DATA_FOLDER)) fs.mkdirSync(BASE_DATA_FOLDER, { recursive: true });

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 700,
        height: 950,
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

ipcMain.handle('get-profiles', () => { 
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

// --- HÀM MỞ TRÌNH DUYỆT THỦ CÔNG ---
ipcMain.on('open-manual', async (event, config) => {
    const { profileName, proxyObj } = config;
    sendLog(`[${profileName}] 🔓 Đang mở trình duyệt thủ công...`);

    const safeName = profileName.split('').map(c => /^[\p{L}\p{N}]$/u.test(c) ? c : '_').join('');
    const userDataDir = path.join(BASE_DATA_FOLDER, safeName);
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    let playwrightProxy = undefined;
    if (proxyObj && proxyObj.ip && proxyObj.port) {
        playwrightProxy = { server: `http://${proxyObj.ip}:${proxyObj.port}` };
        if (proxyObj.user && proxyObj.pass) {
            playwrightProxy.username = proxyObj.user;
            playwrightProxy.password = proxyObj.pass;
        }
    }

    try {
        const browser = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            channel: 'chrome',
            args: ['--disable-notifications', '--disable-dev-shm-usage', '--no-sandbox'],
            proxy: playwrightProxy
        });

        const page = browser.pages()[0];
        await page.goto("https://facebook.com");
        
        browser.on('disconnected', () => { sendLog(`[${profileName}] 🔒 Đã đóng trình duyệt thủ công.`); });
    } catch (e) {
        sendLog(`[${profileName}] ❌ LỖI MỞ TRÌNH DUYỆT: ${e.message}`);
    }
});

// --- QUẢN LÝ TIẾN TRÌNH CON ---
ipcMain.on('stop-bot', () => {
    isRunning = false;
    sendLog("🛑 Đã nhận lệnh dừng. Đang tiêu diệt toàn bộ luồng...");
    for (let profileName in activeWorkers) {
        if (activeWorkers[profileName]) {
            activeWorkers[profileName].kill(); 
            sendLog(`💀 Đã ngắt tiến trình [${profileName}]`);
        }
    }
    activeWorkers = {}; 
    mainWindow.webContents.send('state-change', false);
});

ipcMain.on('start-bot', async (event, config) => {
    if (isRunning) return;
    isRunning = true;
    mainWindow.webContents.send('state-change', true);

    // Bắt thêm startTime và endTime
    const { selectedProfiles, allProfilesObj, webAppUrl, startTime, endTime, minPost, maxPost } = config;

    selectedProfiles.forEach((profileName, index) => {
        setTimeout(() => {
            if (!isRunning) return;

            sendLog(`🚀 Đang khởi tạo tiến trình cho [${profileName}]...`);
            const worker = fork(path.join(__dirname, 'worker.js'));
            activeWorkers[profileName] = worker;

            worker.on('message', (message) => {
                if (message.type === 'log') sendLog(`[${profileName}] ${message.msg}`);
            });

            worker.on('exit', (code) => {
                sendLog(`[${profileName}] Tiến trình đã kết thúc. RAM đã được giải phóng.`);
                delete activeWorkers[profileName];
                if (Object.keys(activeWorkers).length === 0) {
                    isRunning = false;
                    mainWindow.webContents.send('state-change', false);
                    sendLog("🎉 TẤT CẢ TIẾN TRÌNH ĐÃ DỪNG!");
                }
            });

            worker.send({
                type: 'start',
                config: {
                    profileName: profileName,
                    proxyObj: allProfilesObj[profileName]?.proxy,
                    profileImage: allProfilesObj[profileName]?.image,
                    webAppUrl: webAppUrl,
                    startTime: startTime, // Truyền xuống Worker
                    endTime: endTime,     // Truyền xuống Worker
                    minPost: minPost,
                    maxPost: maxPost,
                    BASE_DATA_FOLDER: BASE_DATA_FOLDER
                }
            });

        }, index * 30000); 
    });
});