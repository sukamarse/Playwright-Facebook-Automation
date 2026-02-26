const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

let isRunning = true;

function sendLog(msg) {
    process.send({ type: 'log', msg: msg });
}

async function smartSleep(ms) {
    let elapsed = 0;
    while (elapsed < ms && isRunning) {
        await new Promise(r => setTimeout(r, 500));
        elapsed += 500;
    }
}

process.on('message', async (message) => {
    if (message.type === 'start') {
        await runBot(message.config);
    } else if (message.type === 'stop') {
        isRunning = false;
        process.exit(0);
    }
});

process.on('uncaughtException', (err) => {
    sendLog(`[LỖI NGHIÊM TRỌNG]: ${err.message}`);
    process.exit(1);
});

async function runBot(config) {
    const { profileName, proxyObj, profileImage, webAppUrl, minPost, maxPost, BASE_DATA_FOLDER } = config;

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

    let cycle = 1;

    while (isRunning) {
        sendLog(`🔄 Đang kéo Data từ Google Sheet (Vòng ${cycle})...`);
        let sheetData;
        
        try {
            const response = await fetch(webAppUrl);
            if (!response.ok) throw new Error("Lỗi mạng");
            sheetData = await response.json();
        } catch (e) {
            sendLog(`❌ Mất kết nối tới Sheet. Ngủ 2 phút rồi thử lại...`);
            await smartSleep(120000);
            continue; 
        }

        const links = sheetData.profiles[profileName] || [];
        const commonComments = sheetData.comments || [];

        if (links.length === 0) {
            sendLog(`📭 Chưa có Link mới. Ngủ 5 phút chờ Data...`);
            await smartSleep(300000);
            continue;
        }

        sendLog(`📥 Đã tải ${links.length} Link.`);

        let browser;
        try {
            sendLog(`🌐 Đang khởi động trình duyệt...`);
            browser = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                channel: 'chrome',
                args: [
                    '--disable-notifications',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding'
                ],
                proxy: playwrightProxy
            });

            const page = browser.pages()[0];
            try { await page.goto("https://facebook.com", { timeout: 60000 }); } catch (e) { } 
            await smartSleep(4000);

            for (let i = 0; i < links.length; i++) {
                if (!isRunning) break;
                let link = links[i];

                try {
                    sendLog(`-> Link ${i+1}/${links.length}: ${link}`);
                    try { await page.goto(link, { timeout: 60000 }); } catch(e) { } 
                    
                    // Cuộn nhẹ xuống để Facebook render khung comment
                    await page.evaluate(() => window.scrollBy(0, 400));
                    await smartSleep(Math.floor(Math.random() * 3000) + 4000);
                    if (!isRunning) break;

                    const closeBtns = await page.$$('div[aria-label="Đóng đoạn chat"]');
                    for (let btn of closeBtns) await btn.click({ force: true }).catch(() => {});

                    let mode = "TEXT";
                    if (profileImage && commonComments.length > 0) {
                        mode = (Math.random() * 100 <= 10) ? (Math.random() > 0.5 ? "IMG" : "BOTH") : "TEXT";
                    } else if (profileImage) mode = "IMG";

                    if (mode === "IMG" || mode === "BOTH") {
                        try {
                            const fileInput = page.locator("input[type='file']").last();
                            await fileInput.setInputFiles(profileImage, { timeout: 10000 });
                            sendLog(`📸 Đang up ảnh...`);
                            await smartSleep(8000);
                        } catch (e) { sendLog(`⚠️ Lỗi up ảnh (Có thể bài khóa ảnh)`); }
                    }

                    if (!isRunning) break;

                    if (mode === "TEXT" || mode === "BOTH") {
                        const comment = commonComments[Math.floor(Math.random() * commonComments.length)];
                        
                        // ==============================================================
                        // LOGIC BẮT Ô COMMENT CHUẨN TỪ CODE PYTHON
                        // ==============================================================
                        let targetBox = null;

                        // Bước 1: Thử click nút comment để kích hoạt box (y hệt bản Python)
                        const commentBtnSelectors = [
                            'div[aria-label="Viết bình luận"]',
                            'div[aria-label="Bình luận"]',
                            'div[aria-label="Comment"]'
                        ];
                        for (const btnSel of commentBtnSelectors) {
                            try {
                                const btn = page.locator(btnSel).last();
                                if (await btn.isVisible({ timeout: 2000 })) {
                                    await btn.click({ timeout: 2000 });
                                    await smartSleep(1000);
                                    break;
                                }
                            } catch(e) {}
                        }

                        // Bước 2: Tìm ô comment bằng mảng Selector
                        const selectors = [
                            'div[role="textbox"][aria-label*="Viết bình luận"]',
                            'div[role="textbox"][aria-label*="Write a comment"]',
                            'div[role="textbox"][contenteditable="true"]'
                        ];

                        for (const sel of selectors) {
                            try {
                                // Luôn lấy thẻ cuối cùng khớp điều kiện
                                const box = page.locator(sel).last();
                                await box.waitFor({ state: "visible", timeout: 5000 });
                                
                                // Scroll đến box y hệt Python (scrollIntoView)
                                await box.scrollIntoViewIfNeeded();
                                
                                targetBox = box;
                                break; // Tìm thấy thì bẻ gãy vòng lặp ngay
                            } catch (e) {
                                continue; // Không thấy thì thử selector tiếp theo
                            }
                        }

                        if (!targetBox) {
                            throw new Error("Không tìm thấy ô comment!");
                        }

                        // Bước 3: Focus và gửi
                        try {
                            await targetBox.click(); // Click để kích hoạt con trỏ chuột
                            await smartSleep(1000);
                            
                            if(comment) await targetBox.fill(comment);
                            sendLog(`✍️ Đã nhập comment.`);
                            await smartSleep(1000);
                            
                            await page.keyboard.press("Enter");
                            await smartSleep(2000);

                            // Backup: Nút gửi (mũi tên xanh)
                            const sendBtn = page.locator('div[aria-label="Bình luận"], div[aria-label="Comment"]').last();
                            if (await sendBtn.isVisible({ timeout: 2000 })) {
                                await sendBtn.click({ force: true });
                            }
                            sendLog(`✅ Xong.`);
                        } catch (error) { 
                            sendLog(`⚠️ Bỏ qua: Lỗi trong quá trình nhập liệu.`); 
                        }
                    }
                    
                    if (i < links.length - 1 && isRunning) {
                        const waitTime = Math.floor(Math.random() * (maxPost - minPost + 1) + minPost) * 60;
                        sendLog(`⏳ Nghỉ ${waitTime}s...`);
                        await smartSleep(waitTime * 1000);
                    }
                } catch (e) { sendLog(`Err Link ${i+1}: ${e.message}`); }
            }

        } catch (e) {
            sendLog(`LỖI TRÌNH DUYỆT: ${e.message}`);
        } finally {
            if (browser) {
                sendLog(`🧹 Đang đóng Chrome để giải phóng RAM...`);
                await browser.close().catch(() => {});
            }
        }

        if (!isRunning) break;
        
        const loopWait = Math.floor(Math.random() * (120 - 60 + 1) + 60) * 60; 
        sendLog(`💤 Xong vòng ${cycle}. Ngủ ${Math.floor(loopWait/60)} phút...`);
        await smartSleep(loopWait * 1000);
        cycle++;
    }

    process.exit(0);
}