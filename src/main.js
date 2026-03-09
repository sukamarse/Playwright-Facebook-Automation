'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs   = require('fs');
const { fork } = require('child_process');
const { chromium } = require('playwright');

// ─────────────────────────────────────────────
//  CONFIG  – đọc/ghi từ config.json cạnh main.js
//  User có thể thay đổi qua UI; fallback về C:\Playwright nếu chưa set
// ─────────────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_DEFAULTS = {
    dataRoot: 'C:\\Playwright',
};

function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return { ...CONFIG_DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
        }
    } catch (_) {}
    return { ...CONFIG_DEFAULTS };
}

function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 4), 'utf-8');
}

// Paths được tính lại mỗi lần từ config (để hot-reload sau khi user đổi)
function getPaths(cfg = readConfig()) {
    const root = cfg.dataRoot;
    return {
        DATA_ROOT:     root,
        CHROME_DATA:   path.join(root, 'ChromeData'),
        PROFILES_FILE: path.join(root, 'profiles.json'),
        LOG_DIR:       path.join(root, 'Logs'),
    };
}

function ensureDirs(paths) {
    for (const dir of [paths.DATA_ROOT, paths.CHROME_DATA, paths.LOG_DIR]) {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

// Khởi tạo lần đầu
ensureDirs(getPaths());

// ─────────────────────────────────────────────
//  CAPABILITIES  – scan optional feature modules
//  Mỗi entry: { file: 'tên file module', key: 'tên feature' }
//  Nếu file không tồn tại → feature disabled, UI hiện "Not available"
// ─────────────────────────────────────────────
const OPTIONAL_FEATURES = [
    { key: 'deleteOldComments', file: 'deleteOldComments.js' },
    // Thêm feature mới vào đây
];

const capabilities = {};
for (const f of OPTIONAL_FEATURES) {
    capabilities[f.key] = fs.existsSync(path.join(__dirname, f.file));
}

ipcMain.handle('get-capabilities', () => capabilities);

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let mainWindow   = null;
let isRunning    = false;
let activeWorkers = {};   // { profileName: ChildProcess }

// ─────────────────────────────────────────────
//  WINDOW
// ─────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 760,
        height: 980,
        minWidth: 680,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        },
        icon: path.join(__dirname, '..', 'assets', 'icon.png'),
        title: 'FB Automation v2'
    });

    mainWindow.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
    mainWindow.setMenuBarVisibility(false);

    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    // Gửi stop graceful trước, đợi 3s rồi force kill những cái còn lại
    for (const name of Object.keys(activeWorkers)) {
        try { activeWorkers[name].send({ type: 'stop' }); } catch (_) {}
    }
    setTimeout(() => {
        for (const name of Object.keys(activeWorkers)) {
            try { activeWorkers[name].kill('SIGKILL'); } catch (_) {}
        }
        app.quit();
    }, 3000);
});

// ─────────────────────────────────────────────
//  LOGGING  – gửi lên UI realtime, ghi disk theo batch
//  Buffer trong RAM, flush ra HDD mỗi 60 giây hoặc mỗi 50 dòng
//  → HDD chỉ spin-up ~1 lần/phút thay vì mỗi dòng log
// ─────────────────────────────────────────────
const LOG_FLUSH_INTERVAL = 900_000; // flush mỗi 15 phút
const LOG_FLUSH_MAX_LINES = 200;   // safety net: flush sớm nếu buffer > 200 dòng

let _logBuffer = [];   // buffer RAM
let _logFlushTimer = null;

function flushLogBuffer() {
    if (_logBuffer.length === 0) return;

    // Group theo ngày (hiếm khi khác nhau nhưng cẩn thận qua midnight)
    const byFile = {};
    for (const { logFile, line } of _logBuffer) {
        if (!byFile[logFile]) byFile[logFile] = [];
        byFile[logFile].push(line);
    }
    _logBuffer = [];

    for (const [logFile, lines] of Object.entries(byFile)) {
        fs.promises.appendFile(logFile, lines.join('\n') + '\n', 'utf-8').catch(() => {});
    }
}

function scheduleFlush() {
    if (_logFlushTimer) return; // timer đã chạy rồi
    _logFlushTimer = setTimeout(() => {
        _logFlushTimer = null;
        flushLogBuffer();
    }, LOG_FLUSH_INTERVAL);
}

function sendLog(msg, profileName = null) {
    if (!mainWindow) return;
    const ts   = new Date().toLocaleTimeString('vi-VN');
    const line = profileName ? `[${ts}][${profileName}] ${msg}` : `[${ts}] ${msg}`;

    mainWindow.webContents.send('log-message', line);

    const dateStr = new Date().toISOString().slice(0, 10);
    const logFile = path.join(getPaths().LOG_DIR, `${dateStr}.log`);
    _logBuffer.push({ logFile, line });

    if (_logBuffer.length >= LOG_FLUSH_MAX_LINES) {
        if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
        flushLogBuffer();
        return;
    }

    scheduleFlush();
}

// Flush khi app sắp đóng – tránh mất log cuối
app.on('before-quit', () => {
    if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
    flushLogBuffer();
});

// ─────────────────────────────────────────────
//  PROFILE HELPERS
// ─────────────────────────────────────────────
function readProfiles() {
    const { PROFILES_FILE } = getPaths();
    if (!fs.existsSync(PROFILES_FILE)) return {};
    try {
        const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8'));

        if (Array.isArray(raw)) {
            const migrated = {};
            for (const name of raw) {
                migrated[name] = { proxy: { ip:'', port:'', user:'', pass:'' }, image: null };
            }
            writeProfiles(migrated);
            return migrated;
        }

        for (const key of Object.keys(raw)) {
            if (!raw[key].image)  raw[key].image  = null;
            if (!raw[key].proxy || typeof raw[key].proxy !== 'object') {
                raw[key].proxy = { ip:'', port:'', user:'', pass:'' };
            }
            if (raw[key].minPost === undefined) raw[key].minPost = null;
            if (raw[key].maxPost === undefined) raw[key].maxPost = null;
            if (raw[key].deleteOldComments === undefined) raw[key].deleteOldComments = false;
        }
        return raw;
    } catch (e) {
        sendLog(`⚠️ Lỗi đọc profiles.json: ${e.message}`);
        return {};
    }
}

function writeProfiles(profiles) {
    const { PROFILES_FILE } = getPaths();
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 4), 'utf-8');
}

function safeProfileDir(profileName) {
    const safe = profileName
        .split('')
        .map(c => /^[\p{L}\p{N}]$/u.test(c) ? c : '_')
        .join('');
    return path.join(getPaths().CHROME_DATA, safe);
}

// ─────────────────────────────────────────────
//  IPC – PROFILE MANAGEMENT
// ─────────────────────────────────────────────
ipcMain.handle('get-profiles', () => readProfiles());

ipcMain.handle('save-profile', (_e, name, proxyObj, minPost, maxPost) => {
    const profiles = readProfiles();
    if (!profiles[name]) {
        profiles[name] = { proxy: proxyObj, image: null, minPost: minPost || null, maxPost: maxPost || null };
    } else {
        profiles[name].proxy   = proxyObj;
        profiles[name].minPost = minPost || null;
        profiles[name].maxPost = maxPost || null;
    }
    writeProfiles(profiles);
    return profiles;
});

ipcMain.handle('delete-profile', (_e, name) => {
    const profiles = readProfiles();
    delete profiles[name];
    writeProfiles(profiles);
    return profiles;
});

ipcMain.handle('update-profile-delay', (_e, name, minPost, maxPost) => {
    const profiles = readProfiles();
    if (profiles[name]) {
        profiles[name].minPost = minPost || null;
        profiles[name].maxPost = maxPost || null;
        writeProfiles(profiles);
    }
    return profiles;
});

ipcMain.handle('update-profile-delete-old', (_e, name, enabled) => {
    const profiles = readProfiles();
    if (profiles[name]) {
        profiles[name].deleteOldComments = !!enabled;
        writeProfiles(profiles);
    }
    return profiles;
});

ipcMain.handle('update-profile-image', (_e, name, imagePath) => {
    const profiles = readProfiles();
    if (profiles[name]) {
        profiles[name].image = imagePath;
        writeProfiles(profiles);
    }
    return profiles;
});

ipcMain.handle('select-image', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Chọn ảnh đính kèm comment',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
    });
    return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('open-log-folder', () => {
    require('electron').shell.openPath(getPaths().LOG_DIR);
});

ipcMain.handle('get-data-path', () => getPaths().DATA_ROOT);

// ── Config IPC ──
ipcMain.handle('get-config', () => readConfig());

ipcMain.handle('save-config', (_e, cfg) => {
    writeConfig(cfg);
    ensureDirs(getPaths(cfg));
    return { ok: true };
});

ipcMain.handle('select-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Chọn thư mục lưu dữ liệu',
        properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
});

// ─────────────────────────────────────────────
//  IPC – MỞ TRÌNH DUYỆT THỦ CÔNG (ĐĂNG NHẬP)
// ─────────────────────────────────────────────
ipcMain.on('open-manual', async (_e, { profileName, proxyObj }) => {
    sendLog(`🔓 Đang mở trình duyệt thủ công...`, profileName);

    const userDataDir = safeProfileDir(profileName);
    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    const playwrightProxy = buildProxy(proxyObj);

    try {
        const browser = await chromium.launchPersistentContext(userDataDir, {
            headless: false,
            channel: 'chrome',
            args: defaultArgs(),
            proxy: playwrightProxy
        });

        const page = browser.pages()[0] || await browser.newPage();
        await page.goto('https://www.facebook.com', { timeout: 60000 }).catch(() => {});

        browser.on('disconnected', () => {
            sendLog(`🔒 Đã đóng trình duyệt thủ công.`, profileName);
        });
    } catch (e) {
        sendLog(`❌ Lỗi mở trình duyệt: ${e.message}`, profileName);
    }
});

// ─────────────────────────────────────────────
//  IPC – BOT CONTROL
// ─────────────────────────────────────────────
ipcMain.on('stop-bot', () => {
    if (!isRunning) return;
    isRunning = false;
    sendLog('🛑 Đang dừng tất cả tiến trình...');

    for (const [name, worker] of Object.entries(activeWorkers)) {
        try {
            worker.send({ type: 'stop' });
            // Cho 15 giây tự exit sạch (browser.close() cần thời gian)
            // sau đó mới force kill tránh Chrome process zombie
            setTimeout(() => {
                if (activeWorkers[name]) {
                    activeWorkers[name].kill('SIGKILL');
                    delete activeWorkers[name];
                }
            }, 15_000);
        } catch (_) {}
    }
});

ipcMain.on('start-bot', (_e, config) => {
    if (isRunning) return;

    const { selectedProfiles, allProfilesObj, webAppUrl,
            startTime, endTime, minPost, maxPost } = config;

    if (!selectedProfiles || selectedProfiles.length === 0) return;

    isRunning = true;
    activeWorkers = {};
    // Token để nhận biết đúng "phiên chạy" – tránh setTimeout cũ spawn lại sau khi đã stop
    const sessionToken = Date.now();
    mainWindow._botSessionToken = sessionToken;
    mainWindow.webContents.send('state-change', true);
    sendLog(`🚀 Khởi động ${selectedProfiles.length} profile(s)...`);

    selectedProfiles.forEach((profileName, index) => {
        // Stagger: 30 giây mỗi profile để tránh spike CPU đồng thời
        setTimeout(() => {
            // Hủy nếu đã stop hoặc đây là setTimeout của phiên cũ
            if (!isRunning || mainWindow._botSessionToken !== sessionToken) return;
            // Hủy nếu profile này đã có worker rồi (tránh spawn 2 lần)
            if (activeWorkers[profileName]) return;
            spawnWorker(profileName, {
                profileName,
                proxyObj:     allProfilesObj[profileName]?.proxy || {},
                profileImage: allProfilesObj[profileName]?.image || null,
                webAppUrl,
                startTime,
                endTime,
                minPost,
                maxPost,
                // Per-profile delay: dùng giá trị riêng nếu có, fallback về global
                minPost: allProfilesObj[profileName]?.minPost || minPost,
                maxPost: allProfilesObj[profileName]?.maxPost || maxPost,
                deleteOldComments: allProfilesObj[profileName]?.deleteOldComments || false,
                userDataDir: safeProfileDir(profileName),
            });
        }, index * 30_000);
    });
});

ipcMain.on('pause-profile', (_e, profileName) => {
    const w = activeWorkers[profileName];
    if (w) { w.send({ type: 'pause' }); sendLog(`⏸ Đã pause`, profileName); }
});

ipcMain.on('resume-profile', (_e, profileName) => {
    const w = activeWorkers[profileName];
    if (w) { w.send({ type: 'resume' }); sendLog(`▶ Đã resume`, profileName); }
});

// ─────────────────────────────────────────────
//  SPAWN WORKER
// ─────────────────────────────────────────────
function spawnWorker(profileName, workerConfig) {
    sendLog(`🔧 Khởi tạo tiến trình...`, profileName);

    const worker = fork(path.join(__dirname, 'worker.js'), [], {
        silent: false,   // stdout/stderr của worker vào terminal cha để debug
    });

    activeWorkers[profileName] = worker;

    worker.on('message', (msg) => {
        if (!mainWindow) return;
        if (msg.type === 'log') {
            sendLog(msg.msg, profileName);
        } else if (msg.type === 'status') {
            mainWindow.webContents.send('profile-status', { profileName, status: msg.status });
        }
    });

    worker.on('error', (err) => {
        sendLog(`💥 Worker error: ${err.message}`, profileName);
    });

    worker.on('exit', (code, signal) => {
        sendLog(`🏁 Tiến trình kết thúc (code=${code} signal=${signal}). RAM đã giải phóng.`, profileName);
        delete activeWorkers[profileName];
        mainWindow?.webContents.send('profile-status', { profileName, status: 'stopped' });

        // Nếu tất cả đã xong → reset UI (bất kể dừng tự nhiên hay bấm Stop)
        if (Object.keys(activeWorkers).length === 0) {
            isRunning = false;
            mainWindow?.webContents.send('state-change', false);
            sendLog('🎉 TẤT CẢ TIẾN TRÌNH ĐÃ DỪNG!');
        }
    });

    worker.send({ type: 'start', config: workerConfig });
}

// ─────────────────────────────────────────────
//  SHARED HELPERS
// ─────────────────────────────────────────────
function buildProxy(proxyObj) {
    if (!proxyObj || !proxyObj.ip || !proxyObj.port) return undefined;
    const p = { server: `http://${proxyObj.ip}:${proxyObj.port}` };
    if (proxyObj.user && proxyObj.pass) {
        p.username = proxyObj.user;
        p.password = proxyObj.pass;
    }
    return p;
}

function defaultArgs() {
    return [
        '--disable-notifications',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-hang-monitor',
    ];
}