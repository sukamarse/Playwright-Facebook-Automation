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

function checkTimeAllowed(startStr, endStr) {
    if (!startStr || !endStr) return true; 
    
    const now = new Date();
    const currentMins = now.getHours() * 60 + now.getMinutes();
    
    const [sH, sM] = startStr.split(':').map(Number);
    const startMins = sH * 60 + sM;
    
    const [eH, eM] = endStr.split(':').map(Number);
    const endMins = eH * 60 + eM;
    
    if (startMins <= endMins) {
        return currentMins >= startMins && currentMins <= endMins;
    } else {
        return currentMins >= startMins || currentMins <= endMins;
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
    const { profileName, proxyObj, profileImage, webAppUrl, startTime, endTime, minPost, maxPost, BASE_DATA_FOLDER } = config;

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
        if (!checkTimeAllowed(startTime, endTime)) {
            sendLog(`🌙 Ngoài giờ hoạt động (${startTime} - ${endTime}). Ngủ 10 phút...`);
            await smartSleep(600000); 
            continue;
        }

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
                
                if (!checkTimeAllowed(startTime, endTime)) {
                    sendLog(`⏳ Tới giờ nghỉ ngơi. Tạm dừng việc comment lại.`);
                    break; 
                }

                let link = links[i];

                try {
                    sendLog(`-> Link ${i+1}/${links.length}: ${link}`);
                    try { await page.goto(link, { timeout: 60000 }); } catch(e) { } 
                    
                    await smartSleep(2000); 
                    
                    const scrollTimes = Math.floor(Math.random() * 3) + 2; 
                    for(let step = 0; step < scrollTimes; step++) {
                        let scrollY = Math.floor(Math.random() * 400) + 200;
                        try { await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), scrollY); } catch(e){}
                        await smartSleep(Math.floor(Math.random() * 2000) + 1000);
                    }
                    if (Math.random() < 0.3) { 
                        try { await page.evaluate(() => window.scrollBy({ top: -300, behavior: 'smooth' })); } catch(e){}
                        await smartSleep(1500);
                    }
                    
                    if (!isRunning) break;

                    const closeChatSelectors = [
                        'div[aria-label="Đóng đoạn chat"]', 
                        'div[aria-label="Close chat"]'
                    ];
                    for (let sel of closeChatSelectors) {
                        try {
                            const btns = await page.$$(sel);
                            for (let btn of btns) await btn.click({ force: true }).catch(() => {});
                        } catch (e) {}
                    }
                    await smartSleep(1000);

                    // XÁC ĐỊNH CHẾ ĐỘ COMMENT
                    let mode = "TEXT";
                    if (profileImage && commonComments.length > 0) {
                        mode = (Math.random() * 100 <= 10) ? (Math.random() > 0.5 ? "IMG" : "BOTH") : "TEXT";
                    } else if (profileImage) mode = "IMG";

                    // 1. UP ẢNH (NẾU CÓ)
                    if (mode === "IMG" || mode === "BOTH") {
                        try {
                            const fileInput = page.locator("input[type='file']").last();
                            await fileInput.setInputFiles(profileImage, { timeout: 10000 });
                            sendLog(`📸 Đang up ảnh...`);
                            await smartSleep(8000);
                        } catch (e) { sendLog(`⚠️ Lỗi up ảnh (Có thể bài khóa ảnh)`); }
                    }

                    if (!isRunning) break;

                    // 2. LUÔN LUÔN TÌM Ô COMMENT ĐỂ SUBMIT (Dù là TEXT hay IMG)
                    const comment = commonComments.length > 0 ? commonComments[Math.floor(Math.random() * commonComments.length)] : "";
                    let targetBox = null;

                    const commentBtnSelectors = ['div[aria-label="Viết bình luận"]', 'div[aria-label="Bình luận"]', 'div[aria-label="Comment"]'];
                    for (const btnSel of commentBtnSelectors) {
                        try {
                            const btn = page.locator(btnSel).last();
                            if (await btn.isVisible({ timeout: 2000 })) { await btn.click({ timeout: 2000 }); await smartSleep(1000); break; }
                        } catch(e) {}
                    }

                    const selectors = [
                        'div[role="textbox"][aria-label*="Viết bình luận"]', 
                        'div[role="textbox"][aria-label*="Write a comment"]', 
                        'div[role="textbox"][contenteditable="true"]:not([aria-label*="Tin nhắn"]):not([aria-label*="Message"])'
                    ];
                    
                    for (const sel of selectors) {
                        try {
                            const box = page.locator(sel).last();
                            await box.waitFor({ state: "visible", timeout: 5000 });
                            await box.scrollIntoViewIfNeeded();
                            targetBox = box;
                            break;
                        } catch (e) { continue; }
                    }

                    if (!targetBox) throw new Error("Không tìm thấy ô comment!");

                    try {
                        await targetBox.click();
                        await smartSleep(1000);
                        
                        // CHỈ GÕ CHỮ NẾU MODE KHÔNG PHẢI LÀ "CHỈ ẢNH"
                        if (mode !== "IMG" && comment) {
                            sendLog(`✍️ Đang gõ comment...`);
                            const typingDelay = Math.floor(Math.random() * (120 - 40 + 1)) + 40;
                            await targetBox.pressSequentially(comment, { delay: typingDelay });
                            await smartSleep(1000);
                        }
                        
                        // LUÔN LUÔN NHẤN ENTER ĐỂ GỬI (Bất kể có gõ chữ hay không)
                        await page.keyboard.press("Enter");
                        await smartSleep(2000);

                        // Backup: Click nút Gửi
                        const sendBtn = page.locator('div[aria-label="Bình luận"], div[aria-label="Comment"]').last();
                        if (await sendBtn.isVisible({ timeout: 2000 })) await sendBtn.click({ force: true });
                        sendLog(`✅ Xong.`);
                    } catch (error) { sendLog(`⚠️ Bỏ qua: Lỗi trong quá trình nhập liệu/gửi bài.`); }
                    
                    if (i < links.length - 1 && isRunning) {
                        const waitTime = Math.floor(Math.random() * (maxPost - minPost + 1) + minPost);
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