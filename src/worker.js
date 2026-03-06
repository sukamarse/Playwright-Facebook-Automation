'use strict';

/**
 * Ver26_06.03
 * WORKER.JS – chạy trong tiến trình con riêng biệt (fork)
 * Mỗi profile = 1 worker riêng, hoàn toàn độc lập.
 *
 * Cải tiến so với v1:
 *  ✅ Auto-detect session hết hạn / bị checkpoint
 *  ✅ Smart comment-box finder (4 lớp loại trừ Messenger)
 *  ✅ Retry thông minh với backoff (không loop mãi mãi khi lỗi)
 *  ✅ fetch() có timeout 30s
 *  ✅ Validate schema response từ Google Sheet
 *  ✅ Pause / Resume support
 *  ✅ Graceful shutdown (gửi 'stop' → tự exit clean)
 */

const { chromium } = require('playwright');
const path = require('path');
const fs   = require('fs');

// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
let isRunning = true;
let isPaused  = false;

// ─────────────────────────────────────────────
//  MESSAGING
// ─────────────────────────────────────────────
function log(msg) {
    process.send({ type: 'log', msg });
}

let _currentStatus = '';
function setStatus(status) {
    if (status === _currentStatus) return; // Không gửi IPC nếu status không đổi
    _currentStatus = status;
    process.send({ type: 'status', status });
}

// ─────────────────────────────────────────────
//  SLEEP  – interruptible bởi stop/pause
// ─────────────────────────────────────────────
// sleep() – chunk 500ms: dùng cho các wait ngắn trong khi browser đang chạy
// cần responsive để check isRunning thường xuyên hơn
async function sleep(ms) {
    const chunk = 500;
    let elapsed = 0;
    while (elapsed < ms && isRunning) {
        if (isPaused) {
            await new Promise(r => setTimeout(r, chunk));
            continue;
        }
        await new Promise(r => setTimeout(r, chunk));
        elapsed += chunk;
    }
}

// sleepLong() – chunk 30s: dùng cho các quãng ngủ dài (chờ giờ, chờ vòng tiếp)
// không cần responsive – giảm 60x số lần wake-up so với chunk 500ms
// vẫn check isRunning mỗi 30s để có thể dừng khi cần
async function sleepLong(ms) {
    const chunk = 30_000; // wake-up mỗi 30 giây thay vì 500ms
    let elapsed = 0;
    while (elapsed < ms && isRunning) {
        const remaining = ms - elapsed;
        const wait = Math.min(chunk, remaining);
        await new Promise(r => setTimeout(r, wait));
        elapsed += wait;
    }
}

function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─────────────────────────────────────────────
//  TIME GUARD
// ─────────────────────────────────────────────
function isTimeAllowed(startStr, endStr) {
    if (!startStr || !endStr) return true;
    const now  = new Date();
    const cur  = now.getHours() * 60 + now.getMinutes();
    const [sH, sM] = startStr.split(':').map(Number);
    const [eH, eM] = endStr.split(':').map(Number);
    const s = sH * 60 + sM;
    const e = eH * 60 + eM;
    return s <= e ? (cur >= s && cur <= e) : (cur >= s || cur <= e);
}

// ─────────────────────────────────────────────
//  FETCH WITH TIMEOUT
// ─────────────────────────────────────────────
async function fetchWithTimeout(url, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

// ─────────────────────────────────────────────
//  GHI TIMESTAMP LÊN GOOGLE SHEET (cột I1)
// ─────────────────────────────────────────────
async function reportFetchTime(webAppUrl, profileName) {
    try {
        const ts = new Date().toLocaleString('vi-VN', {
            timeZone: 'Asia/Ho_Chi_Minh',
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const url = `${webAppUrl}?action=report&profile=${encodeURIComponent(profileName)}&ts=${encodeURIComponent(ts)}`;
        // fire-and-forget, không cần đợi response
        fetchWithTimeout(url, 10_000).catch(() => {});
    } catch (_) {}
}

// ─────────────────────────────────────────────
//  GHI FAIL STATUS LÊN GOOGLE SHEET (cột B)
// ─────────────────────────────────────────────
async function reportLinkFail(webAppUrl, profileName, link) {
    try {
        const url = `${webAppUrl}?action=fail`
                  + `&profile=${encodeURIComponent(profileName)}`
                  + `&link=${encodeURIComponent(link)}`;
        fetchWithTimeout(url, 10_000).catch(() => {});
    } catch (_) {}
}

// ─────────────────────────────────────────────
//  PROXY BUILDER
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

// ─────────────────────────────────────────────
//  SESSION CHECK  –  phát hiện đăng xuất / checkpoint
// ─────────────────────────────────────────────
async function checkSession(page) {
    const url = page.url();

    // URL rõ ràng là trang login
    if (url.includes('/login') || url.includes('/checkpoint') ||
        url.includes('login.php') || url.includes('recover')) {
        return false;
    }

    // Kiểm tra thêm qua DOM: có form login không?
    try {
        const hasLoginForm = await page.evaluate(() => {
            return !!(
                document.getElementById('email') ||
                document.getElementById('pass') ||
                document.querySelector('input[name="email"]') ||
                document.querySelector('form[action*="login"]')
            );
        });
        if (hasLoginForm) return false;
    } catch (_) {}

    return true;
}

// ─────────────────────────────────────────────
//  HIDE MESSENGER DOCK  –  lớp bảo vệ 1
// ─────────────────────────────────────────────
async function hideMessengerDock(page) {
    try {
        await page.evaluate(() => {
            const targets = [
                '[data-pagelet="MMessengerDock"]',
                '[data-pagelet="MessengerDock"]',
                'aside[role="complementary"]',
                'div[aria-label="Messenger"]',
                'div[aria-label="Chat"]',
            ];
            targets.forEach(sel => {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.setProperty('display', 'none', 'important');
                });
            });
        });
    } catch (_) {}
    await sleep(300);
}

// ─────────────────────────────────────────────
//  ĐÓNG CÁC ĐOẠN CHAT ĐANG MỞ
// ─────────────────────────────────────────────
async function closeOpenChats(page) {
    const selectors = [
        'div[aria-label="Đóng đoạn chat"]',
        'div[aria-label="Close chat"]',
    ];
    let closed = 0;
    for (const sel of selectors) {
        try {
            const btns = await page.$$(sel);
            for (const btn of btns) {
                await btn.click({ force: true }).catch(() => {});
                closed++;
            }
        } catch (_) {}
    }
    if (closed > 0) log(`💬 Đã đóng ${closed} cửa sổ chat.`);
    await sleep(500);
}

// ─────────────────────────────────────────────
//  SMART COMMENT BOX FINDER  –  viết lại không dùng context constraint
// ─────────────────────────────────────────────
async function findCommentBox(page) {

    // ── Bước 1: Ẩn Messenger dock ──
    await hideMessengerDock(page);

    // ── Bước 2: Scroll xuống vùng comment ──
    try {
        await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
    } catch (_) {}
    await sleep(800);

    // ── Bước 3: Click nút trigger để mở ô comment ──
    // Tìm toàn trang, không giới hạn context
    const triggerLabels = [
        'Bình luận', 'Viết bình luận', 'Comment', 'Write a comment',
    ];
    for (const label of triggerLabels) {
        try {
            const btns = page.locator(`[aria-label="${label}"]`);
            const count = await btns.count();
            // Lấy button đầu tiên KHÔNG nằm trong Messenger
            for (let i = 0; i < count; i++) {
                const btn = btns.nth(i);
                if (!await btn.isVisible({ timeout: 500 })) continue;
                const inMessenger = await btn.evaluate(el => {
                    let p = el;
                    while (p) {
                        const pg = p.getAttribute?.('data-pagelet') || '';
                        if (pg.toLowerCase().includes('messenger') || pg.toLowerCase().includes('chat')) return true;
                        if (p.tagName?.toLowerCase() === 'aside') return true;
                        p = p.parentElement;
                    }
                    return false;
                });
                if (!inMessenger) {
                    await btn.scrollIntoViewIfNeeded();
                    await btn.click({ timeout: 2000 }).catch(() => {});
                    await sleep(800);
                    break;
                }
            }
            break;
        } catch (_) {}
    }

    // ── Bước 4: Tìm tất cả textbox trên trang, chọn cái hợp lệ ──
    // Dùng page.evaluate để lấy toàn bộ candidates rồi filter trong DOM
    // Không phụ thuộc vào selector context của Playwright
    const TEXTBOX_SELECTORS = [
        'div[role="textbox"][aria-label*="Viết bình luận"]',
        'div[role="textbox"][aria-label*="Write a comment"]',
        'div[role="textbox"][aria-label*="Bình luận"]',
        'div[role="textbox"][aria-label*="comment" i]',
        'div[role="textbox"][contenteditable="true"]',
    ];

    const vpWidth = page.viewportSize()?.width || 1280;

    for (const sel of TEXTBOX_SELECTORS) {
        try {
            const boxes = page.locator(sel);
            const count = await boxes.count();
            if (count === 0) continue;

            // Duyệt từng box, lấy cái đầu tiên hợp lệ (không phải Messenger)
            for (let i = 0; i < count; i++) {
                const box = boxes.nth(i);
                if (!await box.isVisible({ timeout: 1000 })) continue;

                const valid = await box.evaluate((el, vpW) => {
                    // DOM traversal: loại trừ nếu nằm trong Messenger/Chat/aside
                    let p = el;
                    while (p) {
                        const pagelet = (p.getAttribute?.('data-pagelet') || '').toLowerCase();
                        const ariaLabel = (p.getAttribute?.('aria-label') || '').toLowerCase();
                        const tag = p.tagName?.toLowerCase() || '';
                        if (
                            pagelet.includes('messenger') ||
                            pagelet.includes('chat') ||
                            ariaLabel === 'messenger' ||
                            ariaLabel === 'chats' ||
                            tag === 'aside'
                        ) return false;
                        p = p.parentElement;
                    }
                    // Loại trừ nếu nằm quá bên phải (vị trí Messenger dock)
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) return false; // hidden
                    if (rect.left > vpW * 0.72) return false;
                    return true;
                }, vpWidth);

                if (valid) {
                    await box.scrollIntoViewIfNeeded();
                    return box;
                }
            }
        } catch (_) { continue; }
    }

    throw new Error('Không tìm được ô comment hợp lệ (đã loại trừ Messenger)');
}

// ─────────────────────────────────────────────
//  HUMAN-LIKE SCROLL
// ─────────────────────────────────────────────
async function humanScroll(page) {
    const steps = rand(2, 4);
    for (let i = 0; i < steps; i++) {
        const y = rand(200, 500);
        try { await page.evaluate(y => window.scrollBy({ top: y, behavior: 'smooth' }), y); }
        catch (_) {}
        await sleep(rand(800, 2000));
    }
    // Đôi khi scroll lên lại
    if (Math.random() < 0.3) {
        try { await page.evaluate(() => window.scrollBy({ top: -250, behavior: 'smooth' })); }
        catch (_) {}
        await sleep(rand(500, 1200));
    }
}

// ─────────────────────────────────────────────
//  DO COMMENT  – logic thực sự đăng comment
// ─────────────────────────────────────────────
async function doComment(page, { link, profileImage, comments, minPost, maxPost }, idx, total) {
    log(`→ [${idx+1}/${total}] ${link}`);

    // Flush DOM trang trước → GC hint trước khi load trang mới
    await page.goto('about:blank', { waitUntil: 'commit' }).catch(() => {});

    // Navigate tới link thật
    try {
        await page.goto(link, { timeout: 60_000, waitUntil: 'domcontentloaded' });
    } catch (e) {
        log(`⚠️ Timeout load trang, thử tiếp...`);
    }

    await sleep(rand(1800, 3000));
    await humanScroll(page);
    await closeOpenChats(page);

    // Xác định mode
    const hasImage    = !!(profileImage && fs.existsSync(profileImage));
    const hasComments = comments.length > 0;
    // Debug: log khi ảnh được set nhưng không tìm thấy file
    if (profileImage && !hasImage) {
        log(`⚠️ Ảnh không tìm thấy tại path: ${profileImage}`);
    }
    let mode = 'TEXT';
    if (hasImage && hasComments) {
        const r = Math.random() * 100;
        mode = r < 5 ? 'IMG' : r < 10 ? 'BOTH' : 'TEXT';
    } else if (hasImage) {
        mode = 'IMG';
    } else if (!hasComments) {
        log(`⚠️ Không có comment text lẫn ảnh, bỏ qua link này.`);
        return false;
    }

    // Upload ảnh trước (nếu cần)
    if (mode === 'IMG' || mode === 'BOTH') {
        try {
            // Giống code cũ: setInputFiles thẳng, không click nút ảnh trước
            // Toàn trang + .last() – đúng như code v1 đã hoạt động
            const fileInput = page.locator("input[type='file']").last();
            await fileInput.setInputFiles(profileImage, { timeout: 10_000 });
            log(`📸 Đang up ảnh...`);
            await sleep(rand(6000, 10000));
        } catch (e) {
            log(`⚠️ Không up được ảnh (bài có thể khóa ảnh): ${e.message}`);
            if (mode === 'IMG') return false;
            mode = 'TEXT';
        }
    }

    // Tìm ô comment
    let box;
    try {
        box = await findCommentBox(page);
    } catch (e) {
        log(`⚠️ ${e.message}`);
        return false;
    }

    // Click vào ô comment – force:true vì FB hay có overlay sau khi attach ảnh
    try {
        await box.click({ force: true, timeout: 4000 });
        await sleep(rand(500, 1000));
    } catch (e) {
        log(`⚠️ Không click được ô comment: ${e.message}`);
        return false;
    }

    // Gõ text
    const commentText = hasComments ? comments[rand(0, comments.length - 1)] : '';
    if (mode !== 'IMG' && commentText) {
        log(`✍️ Đang gõ comment...`);
        const delay = rand(40, 130);
        try {
            await box.pressSequentially(commentText, { delay });
        } catch (e) {
            log(`⚠️ Lỗi khi gõ text: ${e.message}`);
            return false;
        }
        await sleep(rand(600, 1200));
    }

    // Gửi
    try {
        await page.keyboard.press('Enter');
        await sleep(rand(1500, 2500));

        // Backup: click nút submit nếu Enter chưa gửi
        const submitBtn = page.locator('div[role="main"]')
            .locator('[aria-label="Bình luận"], [aria-label="Comment"]')
            .last();
        if (await submitBtn.isVisible({ timeout: 1500 })) {
            await submitBtn.click({ force: true });
            await sleep(1000);
        }

        log(`✅ Comment thành công.`);
        return true;
    } catch (e) {
        log(`⚠️ Lỗi khi submit: ${e.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────
//  MAIN BOT LOOP
// ─────────────────────────────────────────────
async function runBot(config) {
    const {
        profileName, proxyObj, profileImage,
        webAppUrl, startTime, endTime,
        minPost, maxPost, userDataDir
    } = config;

    if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

    const playwrightProxy = buildProxy(proxyObj);
    const MAX_API_RETRIES = 5;

    let cycle = 1;
    let apiRetries = 0;

    // failMemory: { [link]: cycle_fail_lần_đầu }
    // Chỉ ghi FAIL lên Sheet khi link fail 2 vòng liền kề
    let failMemory = {};
    let lastLinkSnapshot = ''; // hash để detect data mới từ Sheet

    // Jitter nhỏ khi khởi động: tránh nhiều worker rush vào Chrome/fetch cùng lúc
    // gây spike CPU (bổ sung cho stagger 30s bên main.js)
    const jitter = rand(0, 8000);
    log(`⏱ Khởi động sau ${(jitter/1000).toFixed(1)}s...`);
    await sleep(jitter);

    setStatus('running');

    while (isRunning) {
        // ── Pause gate ──
        if (isPaused) {
            setStatus('paused');
            await sleep(2000);
            continue;
        }

        // ── Time guard ──
        if (!isTimeAllowed(startTime, endTime)) {
            setStatus('sleeping');
            log(`🌙 Ngoài khung giờ (${startTime}–${endTime}). Ngủ 10 phút...`);
            await sleepLong(600_000);
            continue;
        }

        // ── Fetch data từ Google Sheet ──
        log(`🔄 Kéo data từ Google Sheet (Vòng ${cycle})...`);
        let sheetData;
        try {
            const res = await fetchWithTimeout(webAppUrl, 30_000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            sheetData = await res.json();

            // Validate schema
            if (!sheetData || typeof sheetData !== 'object' || !sheetData.profiles) {
                throw new Error('Response không đúng format (thiếu .profiles)');
            }
            apiRetries = 0; // reset khi thành công
            // Ghi timestamp lên Sheet – fire and forget
            reportFetchTime(webAppUrl, profileName);
        } catch (e) {
            apiRetries++;
            const waitMin = Math.min(2 * apiRetries, 30); // backoff: 2, 4, 6, ... tối đa 30 phút
            log(`❌ Lỗi fetch Sheet (lần ${apiRetries}/${MAX_API_RETRIES}): ${e.message}. Ngủ ${waitMin} phút...`);

            if (apiRetries >= MAX_API_RETRIES) {
                log(`🛑 Đã thử ${MAX_API_RETRIES} lần liên tiếp mà không được. Thoát tiến trình.`);
                setStatus('error');
                process.exit(1);
            }
            await sleepLong(waitMin * 60_000);
            continue;
        }

        const links    = sheetData.profiles[profileName] || [];
        const comments = sheetData.comments || [];

        // Nếu danh sách link thay đổi so với lần fetch trước → coi như vòng đầu tiên
        const currentSnapshot = links.join('|');
        if (currentSnapshot !== lastLinkSnapshot) {
            if (lastLinkSnapshot !== '') log(`🔄 Data mới từ Sheet – reset bộ nhớ fail.`);
            failMemory = {};
            lastLinkSnapshot = currentSnapshot;
        }

        if (links.length === 0) {
            log(`📭 Không có link nào cho profile này. Ngủ 5 phút...`);
            await sleepLong(300_000);
            continue;
        }

        log(`📥 Tải được ${links.length} link.`);

        // ── Mở trình duyệt ──
        let browser;
        try {
            log(`🌐 Khởi động Chrome...`);
            setStatus('running');
            browser = await chromium.launchPersistentContext(userDataDir, {
                headless: false,
                channel:  'chrome',
                args: [
                    '--disable-notifications',
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-background-timer-throttling',
                    '--disable-backgrounding-occluded-windows',
                    '--disable-renderer-backgrounding',
                    '--disable-hang-monitor',
                    '--disable-gpu-compositing',
                    '--disable-software-rasterizer',
                    '--js-flags=--max-old-space-size=384', // 384MB – đủ cho FB React, tránh OOM
                    '--aggressive-cache-discard',           // discard cache trang cũ ngay khi rời đi
                    '--disable-cache',                      // không giữ HTTP cache trong RAM
                ],
                proxy: playwrightProxy
            });

            const page = browser.pages()[0] || await browser.newPage();

            // Mở FB để check session
            try {
                await page.goto('https://www.facebook.com', { timeout: 60_000, waitUntil: 'domcontentloaded' });
            } catch (_) {}
            await sleep(rand(3000, 5000));

            // ── Check session ──
            const loggedIn = await checkSession(page);
            if (!loggedIn) {
                log(`🔐 SESSION HẾT HẠN hoặc bị Checkpoint! Cần đăng nhập lại thủ công.`);
                log(`👆 Nhấn "🌐 Mở" để đăng nhập, sau đó chạy lại.`);
                setStatus('error');
                await browser.close().catch(() => {});
                process.exit(2);
            }
            log(`✅ Session hợp lệ.`);

            // ── Vòng lặp qua từng link ──
            let successCount = 0;
            let failCount    = 0;

            for (let i = 0; i < links.length; i++) {
                if (!isRunning) break;

                while (isPaused && isRunning) {
                    setStatus('paused');
                    await sleep(2000);
                }
                if (!isRunning) break;

                if (!isTimeAllowed(startTime, endTime)) {
                    log(`⏰ Tới giờ nghỉ, dừng vòng này.`);
                    break;
                }

                const link = links[i];
                const ok = await doComment(page, {
                    link,
                    profileImage,
                    comments,
                    minPost,
                    maxPost
                }, i, links.length).catch(e => {
                    log(`💥 Lỗi không xử lý được link ${i+1}: ${e.message}`);
                    return false;
                });

                if (ok) {
                    successCount++;
                    delete failMemory[link];
                } else {
                    failCount++;
                    if (failMemory[link] !== undefined && failMemory[link] === cycle - 1) {
                        log(`🚫 Link fail 2 vòng liên tiếp, ghi FAIL lên Sheet...`);
                        reportLinkFail(webAppUrl, profileName, link);
                        delete failMemory[link];
                    } else {
                        failMemory[link] = cycle;
                        log(`⚠️ Link fail lần 1 (vòng ${cycle}), chờ xác nhận vòng sau.`);
                    }
                }

                if (i < links.length - 1 && isRunning) {
                    const wait = rand(minPost, maxPost);
                    log(`⏳ Nghỉ ${wait}s...`);
                    await sleep(wait * 1000);
                }
            }

            log(`📊 Vòng ${cycle} hoàn thành: ✅ ${successCount} OK | ❌ ${failCount} lỗi`);

        } catch (e) {
            log(`💥 Lỗi trình duyệt: ${e.message}`);
        } finally {
            if (browser) {
                log(`🧹 Đóng Chrome, giải phóng RAM...`);
                try { await browser.close(); } catch (_) {}
            }
        }

        if (!isRunning) break;

        const loopWait = rand(60, 120) * 60; // 60–120 phút
        log(`💤 Xong vòng ${cycle}. Ngủ ${Math.round(loopWait/60)} phút rồi chạy lại...`);
        setStatus('sleeping');
        await sleepLong(loopWait * 1000);
        cycle++;
    }

    log('👋 Worker kết thúc.');
    setStatus('stopped');
    process.exit(0);
}

// ─────────────────────────────────────────────
//  IPC FROM PARENT
// ─────────────────────────────────────────────
process.on('message', async (msg) => {
    switch (msg.type) {
        case 'start':
            await runBot(msg.config);
            break;
        case 'stop':
            isRunning = false;
            isPaused  = false;
            break;
        case 'pause':
            isPaused = true;
            break;
        case 'resume':
            isPaused  = false;
            isRunning = true;
            break;
    }
});

process.on('uncaughtException', (err) => {
    process.send?.({ type: 'log', msg: `💥 [UNCAUGHT] ${err.message}\n${err.stack}` });
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    process.send?.({ type: 'log', msg: `💥 [UNHANDLED REJECTION] ${reason}` });
});