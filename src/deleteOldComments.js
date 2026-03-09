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

    // Scroll xuống vùng comment trước
    try {
        await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'smooth' }));
    } catch (_) {}
    await sleep(rand(800, 1200));

    for (let attempt = 0; attempt < maxDelete; attempt++) {
        try {
            // ── Lấy tọa độ các COMMENT article (article lồng trong article) ──
            // Post article = article ngoài cùng (không có ancestor là article)
            // Comment article = article có ít nhất 1 ancestor cũng là article
            const commentCoords = await page.evaluate(() => {
                const allArticles = Array.from(document.querySelectorAll('div[role="article"]'));
                const results = [];

                for (const art of allArticles) {
                    // Bỏ qua nếu trong Messenger/aside
                    let p = art.parentElement;
                    let skip = false;
                    while (p) {
                        const pg = (p.getAttribute?.('data-pagelet') || '').toLowerCase();
                        if (pg.includes('messenger') || pg.includes('chat') || p.tagName?.toLowerCase() === 'aside') {
                            skip = true; break;
                        }
                        p = p.parentElement;
                    }
                    if (skip) continue;

                    // Chỉ lấy article có ancestor là article khác → là comment
                    let ancestor = art.parentElement;
                    let isComment = false;
                    while (ancestor) {
                        if (ancestor.getAttribute?.('role') === 'article') {
                            isComment = true; break;
                        }
                        ancestor = ancestor.parentElement;
                    }
                    if (!isComment) continue;

                    const rect = art.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

                    results.push({
                        x: rect.left + rect.width / 2,
                        y: rect.top + 20,
                    });
                }
                return results;
            });

            if (commentCoords.length === 0) {
                log(`🗑 Không tìm thấy comment nào trong viewport.`);
                break;
            }

            log(`🗑 Thấy ${commentCoords.length} comment, đang hover tìm nút ⋯ của mình...`);

            // ── Hover từng comment, chờ FB inject nút ⋯ vào DOM ──
            const MY_LABELS = [
                'Hành động với bài viết này',
                'Chỉnh sửa hoặc xóa bình luận này',
                'Actions for this comment',
                'Edit or delete comment',
            ];

            let menuBtn = null;

            for (const coord of commentCoords) {
                await page.mouse.move(coord.x, coord.y, { steps: 5 });
                await sleep(500);

                for (const label of MY_LABELS) {
                    const candidates = page.locator(`[aria-label="${label}"]`);
                    if (await candidates.count() === 0) continue;

                    for (let i = 0; i < await candidates.count(); i++) {
                        const btn = candidates.nth(i);

                        const ok = await btn.evaluate(el => {
                            // Phải visible thật
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

                            // Phải nằm trong comment article (có 2 tầng article)
                            let a = el.parentElement;
                            while (a) {
                                if (a.getAttribute?.('role') === 'article') {
                                    let grandpa = a.parentElement;
                                    while (grandpa) {
                                        if (grandpa.getAttribute?.('role') === 'article') return true;
                                        grandpa = grandpa.parentElement;
                                    }
                                    return false;
                                }
                                a = a.parentElement;
                            }
                            return false;
                        }).catch(() => false);

                        if (ok) { menuBtn = btn; break; }
                    }
                    if (menuBtn) break;
                }
                if (menuBtn) break;
            }

            if (!menuBtn) {
                log(`🗑 Không tìm thấy nút ⋯ của comment mình sau khi hover.`);
                break;
            }

            // ── Click nút ⋯ ──
            await menuBtn.scrollIntoViewIfNeeded();
            await menuBtn.click({ force: true, timeout: 4000 });
            await sleep(rand(700, 1100));

            // ── Click "Xóa" trong menu ──
            const deleteFound = await page.evaluate(() => {
                const KEYWORDS = ['xóa', 'delete'];
                const menus = document.querySelectorAll('[role="menu"], [role="listbox"]');
                for (const menu of menus) {
                    const items = menu.querySelectorAll('[role="menuitem"], [role="option"], li > div[tabindex]');
                    for (const item of items) {
                        const text = item.textContent?.trim().toLowerCase() || '';
                        if (KEYWORDS.some(k => text === k || text.startsWith(k + ' '))) {
                            item.click();
                            return true;
                        }
                    }
                }
                return false;
            });

            if (!deleteFound) {
                await page.keyboard.press('Escape');
                await sleep(300);
                log(`🗑 Menu mở nhưng không có "Xóa" → không phải comment của mình.`);
                break;
            }

            await sleep(rand(500, 900));

            // ── Confirm dialog nếu có ──
            await page.evaluate(() => {
                const KEYWORDS = ['xóa', 'delete', 'xác nhận', 'confirm'];
                for (const btn of document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')) {
                    if (KEYWORDS.some(k => btn.textContent?.trim().toLowerCase().includes(k))) {
                        btn.click(); return;
                    }
                }
            });

            await sleep(rand(1000, 1800));
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
    else log(`🗑 Không xóa được comment nào.`);
    return deleted;
};
