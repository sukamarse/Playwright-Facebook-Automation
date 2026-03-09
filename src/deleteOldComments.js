'use strict';

/**
 * deleteOldComments.js
 * Xóa tối đa N comment cũ của chính mình trên trang FB hiện tại.
 *
 * Cách dùng:
 *   const deleteOldComments = require('./deleteOldComments');
 *   await deleteOldComments(page, log, rand, sleep, 2);
 *
 * Params:
 *   page        – Playwright page object
 *   log         – hàm log(msg) của worker
 *   rand        – hàm rand(min, max) của worker
 *   sleep       – hàm sleep(ms) của worker
 *   maxDelete   – số comment tối đa cần xóa (default 2)
 */

module.exports = async function deleteOldComments(page, log, rand, sleep, maxDelete = 2) {
    log(`🗑 Đang tìm comment cũ cần xóa (tối đa ${maxDelete})...`);
    let deleted = 0;

    // ── Label nút ⋯ của comment của mình ──
    const MY_LABELS = [
        'Chỉnh sửa hoặc xóa bình luận này',
        'Edit or delete comment',
        'Actions for this comment',
        'Hành động với bình luận này',
    ];

    // ── Scroll xuống vùng comment trước ──
    try {
        await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'smooth' }));
    } catch (_) {}
    await sleep(rand(800, 1200));

    for (let attempt = 0; attempt < maxDelete; attempt++) {
        try {
            let menuBtn = null;

            // ── BƯỚC 1: Lấy tọa độ tất cả ô comment trong DOM ──
            // Dùng nhiều selector vì FB thay đổi cấu trúc thường xuyên
            const commentZones = await page.evaluate(() => {
                const results = [];

                // Cách 1: tìm các div chứa text của comment (có data-testid hoặc role=article lồng)
                // Ưu tiên dùng cấu trúc phổ biến nhất của FB: ul > li chứa comment
                const candidates = [
                    // Comment list items (FB dùng ul/ol để chứa comment)
                    ...Array.from(document.querySelectorAll('ul li, ol li')),
                    // Fallback: tất cả article (cả post lẫn comment)
                    ...Array.from(document.querySelectorAll('div[role="article"]')),
                ];

                const seen = new Set();
                for (const el of candidates) {
                    // Bỏ qua Messenger/chat
                    let p = el;
                    let skip = false;
                    while (p) {
                        const pg = (p.getAttribute?.('data-pagelet') || '').toLowerCase();
                        const tag = p.tagName?.toLowerCase() || '';
                        if (pg.includes('messenger') || pg.includes('chat') || tag === 'aside') {
                            skip = true; break;
                        }
                        p = p.parentElement;
                    }
                    if (skip) continue;

                    const rect = el.getBoundingClientRect();
                    if (rect.width < 50 || rect.height < 10) continue;
                    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

                    // Tránh trùng tọa độ
                    const key = `${Math.round(rect.left)}_${Math.round(rect.top)}`;
                    if (seen.has(key)) continue;
                    seen.add(key);

                    results.push({
                        x: rect.left + Math.min(rect.width * 0.3, 100),
                        y: rect.top + rect.height / 2,
                    });
                }

                return results;
            });

            log(`🗑 Tìm thấy ${commentZones.length} vùng để hover tìm nút ⋯...`);

            if (commentZones.length === 0) {
                log(`🗑 Không tìm thấy vùng comment nào trong viewport.`);
                // Thử scroll thêm rồi thử lại
                try {
                    await page.evaluate(() => window.scrollBy({ top: 400, behavior: 'smooth' }));
                } catch (_) {}
                await sleep(800);
                continue;
            }

            // ── BƯỚC 2: Hover từng vùng, chờ nút ⋯ xuất hiện ──
            for (const coord of commentZones) {
                // Di chuột vào vùng comment
                await page.mouse.move(coord.x, coord.y, { steps: 8 });
                await sleep(rand(400, 700));

                // Kiểm tra nút ⋯ xuất hiện (FB inject vào DOM khi hover)
                for (const label of MY_LABELS) {
                    const candidates = page.locator(`[aria-label="${label}"]`);
                    const count = await candidates.count();
                    if (count === 0) continue;

                    for (let i = 0; i < count; i++) {
                        const btn = candidates.nth(i);

                        // Kiểm tra visible thật sự và không nằm trong Messenger
                        const ok = await btn.evaluate(el => {
                            const s = window.getComputedStyle(el);
                            if (s.display === 'none' || s.visibility === 'hidden') return false;
                            if (parseFloat(s.opacity) < 0.1) return false;

                            // Không nằm trong Messenger/aside
                            let p = el;
                            while (p) {
                                const pg = (p.getAttribute?.('data-pagelet') || '').toLowerCase();
                                if (pg.includes('messenger') || pg.includes('chat')) return false;
                                if (p.tagName?.toLowerCase() === 'aside') return false;
                                p = p.parentElement;
                            }

                            // Phải có kích thước hợp lệ
                            const rect = el.getBoundingClientRect();
                            if (rect.width === 0 || rect.height === 0) return false;

                            return true;
                        }).catch(() => false);

                        if (ok) {
                            menuBtn = btn;
                            break;
                        }
                    }
                    if (menuBtn) break;
                }
                if (menuBtn) break;
            }

            // ── BƯỚC 3: Nếu không tìm thấy, thử scroll thêm ──
            if (!menuBtn) {
                log(`🗑 Chưa thấy nút ⋯ trong viewport hiện tại, thử scroll thêm...`);
                try {
                    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
                } catch (_) {}
                await sleep(600);

                // Thử trực tiếp bằng locator không cần hover (đôi khi nút đã có sẵn)
                for (const label of MY_LABELS) {
                    const allBtns = page.locator(`[aria-label="${label}"]`);
                    const count = await allBtns.count();
                    for (let i = 0; i < count; i++) {
                        const btn = allBtns.nth(i);
                        const visible = await btn.isVisible({ timeout: 500 }).catch(() => false);
                        if (!visible) continue;

                        const notMessenger = await btn.evaluate(el => {
                            let p = el;
                            while (p) {
                                const pg = (p.getAttribute?.('data-pagelet') || '').toLowerCase();
                                if (pg.includes('messenger') || pg.includes('chat')) return false;
                                if (p.tagName?.toLowerCase() === 'aside') return false;
                                p = p.parentElement;
                            }
                            return true;
                        }).catch(() => false);

                        if (notMessenger) { menuBtn = btn; break; }
                    }
                    if (menuBtn) break;
                }
            }

            if (!menuBtn) {
                log(`🗑 Không tìm thấy nút ⋯ của comment mình. Có thể không còn comment cũ.`);
                break;
            }

            // ── BƯỚC 4: Click nút ⋯ ──
            log(`🗑 Đã thấy nút ⋯, đang mở menu...`);
            await menuBtn.scrollIntoViewIfNeeded();
            await sleep(200);
            await menuBtn.click({ force: true, timeout: 5000 });
            await sleep(rand(800, 1200));

            // ── BƯỚC 5: Click "Xóa" trong menu FB ──
            // Tìm element lá có text chính xác "Xóa", không nằm bên phải viewport (Messenger)
            const deleteCoord = await page.evaluate(() => {
                const KEYWORDS = ['xóa', 'delete', 'xóa bình luận', 'delete comment'];

                // Lấy tất cả text nodes / leaf elements trên trang có text khớp
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_ELEMENT,
                    {
                        acceptNode(node) {
                            // Chỉ lấy node lá (không có element con) để text chính xác
                            if (node.children.length > 0) return NodeFilter.FILTER_SKIP;
                            const t = (node.textContent?.trim() || '').toLowerCase();
                            return KEYWORDS.some(k => t === k) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                        }
                    }
                );

                let node;
                while ((node = walker.nextNode())) {
                    // Kiểm tra node (hoặc ancestor gần) visible
                    const rect = node.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

                    const vpW = window.innerWidth;
                    // Loại element bên phải viewport (Messenger dock thường > 72%)
                    if (rect.left > vpW * 0.72) continue;

                    // Không nằm trong Messenger/aside
                    let p = node.parentElement;
                    let skip = false;
                    while (p) {
                        const pg = (p.getAttribute?.('data-pagelet') || '').toLowerCase();
                        if (pg.includes('messenger') || pg.includes('chat')) { skip = true; break; }
                        if (p.tagName?.toLowerCase() === 'aside') { skip = true; break; }
                        p = p.parentElement;
                    }
                    if (skip) continue;

                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                }
                return null;
            });

            if (deleteCoord) {
                log(`🗑 Click "Xóa" tại tọa độ (${Math.round(deleteCoord.x)}, ${Math.round(deleteCoord.y)})`);
                await page.mouse.click(deleteCoord.x, deleteCoord.y);
            } else {
                // Chiến lược 2: Keyboard – Tab qua các menu item, Enter khi focus vào "Xóa"
                log(`🗑 Thử keyboard navigation (Tab → Enter)...`);
                let keyClicked = false;
                for (let t = 0; t < 6; t++) {
                    await page.keyboard.press('Tab');
                    await sleep(120);
                    const focusText = await page.evaluate(() =>
                        (document.activeElement?.textContent?.trim() || '').toLowerCase()
                    );
                    if (['xóa', 'delete', 'xóa bình luận', 'delete comment'].includes(focusText)) {
                        await page.keyboard.press('Enter');
                        keyClicked = true;
                        log(`🗑 Keyboard: đã Enter vào "${focusText}"`);
                        break;
                    }
                }
                if (!keyClicked) {
                    await page.keyboard.press('Escape');
                    await sleep(300);
                    log(`🗑 Không click được "Xóa" − xem DEBUG log phía trên để biết DOM structure.`);
                    break;
                }
            }

            await sleep(rand(500, 900));

            // ── BƯỚC 6: Confirm dialog "Bạn có muốn xóa bình luận này không?" ──
            // FB dùng span (không phải button) trong confirm dialog → dùng evaluate tìm tọa độ
            const confirmCoord = await page.evaluate(() => {
                const KEYWORDS = ['xóa', 'delete'];
                const vpW = window.innerWidth;
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
                    acceptNode(node) {
                        if (node.children.length > 0) return NodeFilter.FILTER_SKIP;
                        const t = (node.textContent?.trim() || '').toLowerCase();
                        return KEYWORDS.some(k => t === k) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
                    }
                });
                let node;
                while ((node = walker.nextNode())) {
                    const rect = node.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
                    if (rect.left > vpW * 0.72) continue;
                    // Phải nằm trong dialog/alertdialog
                    let p = node.parentElement; let inDialog = false;
                    while (p) {
                        const role = (p.getAttribute?.('role') || '').toLowerCase();
                        if (role === 'dialog' || role === 'alertdialog') { inDialog = true; break; }
                        p = p.parentElement;
                    }
                    if (!inDialog) continue;
                    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                }
                return null;
            });
            if (confirmCoord) {
                log(`🗑 Confirm dialog: click "Xóa" tại (${Math.round(confirmCoord.x)}, ${Math.round(confirmCoord.y)})`);
                await page.mouse.click(confirmCoord.x, confirmCoord.y);
            }

            await sleep(rand(1200, 2000));
            deleted++;
            log(`🗑 Đã xóa comment cũ #${deleted}.`);

        } catch (e) {
            log(`⚠️ Lỗi xóa comment cũ (attempt ${attempt + 1}): ${e.message}`);
            await page.keyboard.press('Escape').catch(() => {});
            await sleep(500);
            break;
        }
    }

    if (deleted > 0) log(`🗑 Xóa xong ${deleted} comment cũ.`);
    else log(`🗑 Không xóa được comment nào (không tìm thấy comment của mình trong viewport).`);
    return deleted;
};
