// ==UserScript==
// @name         Clean Reader - 媒体占位 + 阅读模式
// @namespace    http://tampermonkey.net/
// @version      4.1
// @description  媒体自动加载改为右键加载 / Alt+R 阅读模式（Readability + 站点记忆）/ Alt+S 手动选择正文 / Esc 退出
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @require      https://cdn.jsdelivr.net/npm/@mozilla/readability@0.4.4/Readability.js
// @downloadURL  https://raw.githubusercontent.com/HeyAlaia/broswer-script/main/clean-reader.user.js
// @updateURL    https://raw.githubusercontent.com/HeyAlaia/broswer-script/main/clean-reader.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 配置
     * ============================================================ */
    // 这些站点不拦截媒体（图片即内容的文档站）
    const MEDIA_ALLOW_HOSTS = ['paimon.apache.org'];

    const HOST = location.hostname;
    const blockMedia = !MEDIA_ALLOW_HOSTS.includes(HOST);
    // 常见懒加载真实地址属性
    const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src'];

    let readerActive = false;
    let savedBodyOverflow = null;
    let savedBodyCursor = null;

    /* ============================================================
     * 模块一：媒体占位（属性级拦截）
     *
     * 核心原则：绝不替换/删除页面自己的节点。
     * v3.7 及之前用占位 div replaceWith 掉 img，在 React/Vue 水合
     * 站点（Docusaurus 等）会让框架 removeChild 自己创建的 img 时
     * 抛 "not a child of this node" 直接崩页面。
     * 现在只摘除 src/srcset 存进 data-*，占位外观全靠 CSS。
     * ============================================================ */
    const origSetAttr = Element.prototype.setAttribute;

    function hookMediaSrc() {
        const imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
        if (imgDesc && imgDesc.set) {
            Object.defineProperty(HTMLImageElement.prototype, 'src', {
                set(v) {
                    if (this.dataset && this.dataset.phPending && !this.dataset.phAllow) {
                        this.dataset.phPendingSrc = v;
                        return;
                    }
                    imgDesc.set.call(this, v);
                },
                get: imgDesc.get,
                configurable: true,
            });
        }
        const mediaDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        if (mediaDesc && mediaDesc.set) {
            Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                set(v) {
                    if (this.tagName === 'VIDEO' && this.dataset && this.dataset.phPending && !this.dataset.phAllow) {
                        this.dataset.phPendingSrc = v;
                        return;
                    }
                    mediaDesc.set.call(this, v);
                },
                get: mediaDesc.get,
                configurable: true,
            });
        }
        Element.prototype.setAttribute = function (name, value) {
            const n = String(name).toLowerCase();
            if ((this.tagName === 'IMG' || this.tagName === 'VIDEO') &&
                (n === 'src' || n === 'srcset') &&
                this.dataset && this.dataset.phPending && !this.dataset.phAllow) {
                if (n === 'src') this.dataset.phPendingSrc = value;
                else this.dataset.phPendingSrcset = value;
                return;
            }
            return origSetAttr.call(this, name, value);
        };
    }

    function firstSrcsetUrl(srcset) {
        const first = String(srcset).split(',')[0].trim();
        return first ? first.split(/\s+/)[0] : '';
    }

    // 取真实资源地址：已捕获的 pending > 懒加载属性 > <source> 子元素 > src > srcset
    // data: 内嵌图（如 1px 懒加载占位 gif）不算真实地址
    function getRealSrc(el) {
        if (el.dataset.phPendingSrc) return el.dataset.phPendingSrc;
        for (let i = 0; i < LAZY_ATTRS.length; i++) {
            const v = el.getAttribute(LAZY_ATTRS[i]);
            if (v && !v.startsWith('data:')) return v;
        }
        if (el.tagName === 'VIDEO') {
            const s = el.querySelector('source[src]');
            if (s) return s.getAttribute('src');
        }
        const src = el.getAttribute('src');
        if (src && !src.startsWith('data:')) return src;
        const ss = el.getAttribute('srcset');
        if (ss) {
            const u = firstSrcsetUrl(ss);
            if (u && !u.startsWith('data:')) return u;
        }
        return '';
    }

    // 属性级拦截：元素留在原位，只摘地址
    function processMedia(el) {
        if (el.dataset.phProcessed) return;
        const real = el.dataset.phPendingSrc || getRealSrc(el);
        if (!real) return; // 纯 data: 内嵌图或暂无地址：放行不动

        el.dataset.phProcessed = '1';

        /* ── 尺寸三源（必须最先做：此刻还没打 phPending、还没动任何样式，
         *    测到的才是页面自己的真实布局；标记一打，CSS 兜底 min 会污染测量）──
         * 1. 布局实测 getBoundingClientRect —— CSS/JS/属性/flex 的最终结果，最准
         * 2. inline style 宽高 / width/height 属性 —— 未布局时仅有的声明
         */
        const rect = el.getBoundingClientRect();
        let w = rect.width > 5 ? rect.width : 0;
        let h = rect.height > 5 ? rect.height : 0;
        let ar = null;
        if (!w || !h) {
            const sw = parseFloat(el.style.width) || 0;
            const sh = parseFloat(el.style.height) || 0;
            const aw = parseFloat(el.getAttribute('width')) || 0;
            const ah = parseFloat(el.getAttribute('height')) || 0;
            if (!w) w = sw || aw;
            if (!h) h = sh || ah;
            // 属性对完整时推导 aspect-ratio，配合站点自身的响应式规则自动保形
            if ((!rect.width || !rect.height) && aw > 0 && ah > 0) {
                ar = Math.round(aw) + ' / ' + Math.round(ah);
            }
        }
        const measured = w > 0 || h > 0;

        /* ── 现在才拦截 ── */
        el.dataset.phPending = '1';
        el.dataset.phPendingSrc = real;

        const srcset = el.getAttribute('srcset');
        if (srcset) {
            el.dataset.phPendingSrcset = srcset;
            el.removeAttribute('srcset');
            el.removeAttribute('sizes');
        }
        el.removeAttribute('src');
        for (let i = 0; i < LAZY_ATTRS.length; i++) el.removeAttribute(LAZY_ATTRS[i]);

        if (el.tagName === 'VIDEO') {
            // <source> 子元素的 src 也摘掉，否则视频照常加载
            const srcs = [];
            el.querySelectorAll('source').forEach(function (s) {
                srcs.push(s.getAttribute('src') || '');
                s.removeAttribute('src');
            });
            if (srcs.some(Boolean)) el.dataset.phPendingSources = JSON.stringify(srcs);
        } else {
            // <picture> 的 <source srcset> 同理
            const pic = el.closest && el.closest('picture');
            if (pic) {
                const sets = [];
                pic.querySelectorAll('source').forEach(function (s) {
                    sets.push(s.getAttribute('srcset') || '');
                    s.removeAttribute('srcset');
                });
                if (sets.some(Boolean)) el.dataset.phPendingPicSources = JSON.stringify(sets);
            }
        }

        // 尺寸落盘：有实测/声明的写 inline 精确框；什么都不知道的标记 blind 给 CSS 兜底，
        // 变为可见时由共享 IntersectionObserver / 补测实测修正——兜底框不能无差别加，
        // 否则 130px 会把 16px 的头部图标撑大（比实际大的根源）
        if (measured) {
            if (w) el.style.minWidth = Math.round(w) + 'px';
            if (h) el.style.minHeight = Math.round(h) + 'px';
            if (ar) el.style.aspectRatio = ar;
        } else {
            el.dataset.phBlind = '1';
            observeBlind(el);
        }

        // 框太小放不下"右键加载"文字（130×44）→ 降级为笑脸，并暂存清空 alt 防文字挤压
        const mini = (w > 5 && w < 140) || (h > 5 && h < 50);
        if (mini) {
            el.dataset.phMini = '1';
            if (el.hasAttribute('alt')) {
                el.dataset.phAlt = el.getAttribute('alt');
                origSetAttr.call(el, 'alt', '');
            }
        }
    }

    /* ── blind 占位的实测修正 ──
     * blind = 拦截时完全无尺寸信息（隐藏容器里、或布局未发生）。
     * 修正时机：变为可见时（共享 IntersectionObserver，事件驱动零轮询）
     * 或布局稳定后的两次补测。修正前先摘兜底框再测，避免测到被自己撑大的值。 */
    let phIO = null;

    function observeBlind(el) {
        if (typeof IntersectionObserver === 'undefined') return;
        if (!phIO) {
            phIO = new IntersectionObserver(function (entries) {
                entries.forEach(function (en) {
                    if (!en.isIntersecting) return;
                    phIO.unobserve(en.target);
                    fixBlindSize(en.target);
                });
            }, { rootMargin: '100px' });
        }
        phIO.observe(el);
    }

    function fixBlindSize(el) {
        if (!el.dataset.phBlind || el.dataset.phPending !== '1') return;
        el.style.minWidth = '0';
        el.style.minHeight = '0';
        const r = el.getBoundingClientRect(); // 摘兜底后强制重排，读到真实布局
        const w = r.width > 5 ? r.width : 0;
        const h = r.height > 5 ? r.height : 0;
        if (!w && !h) {
            // 仍不可测（如刚被 JS 隐藏）：恢复兜底，等下次触发
            el.style.minWidth = '';
            el.style.minHeight = '';
            observeBlind(el);
            return;
        }
        delete el.dataset.phBlind;
        if (w) el.style.minWidth = Math.round(w) + 'px';
        if (h) el.style.minHeight = Math.round(h) + 'px';
        const mini = (w > 5 && w < 140) || (h > 5 && h < 50);
        if (mini && !el.dataset.phMini) {
            el.dataset.phMini = '1';
            if (el.hasAttribute('alt') && el.getAttribute('alt') !== '') {
                el.dataset.phAlt = el.getAttribute('alt');
                origSetAttr.call(el, 'alt', '');
            }
        }
    }

    // 硬加载时 MutationObserver 在布局前就处理，布局稳定后对 blind 占位统一补测
    function recheckPending() {
        document.querySelectorAll('img[data-ph-pending][data-ph-blind], video[data-ph-pending][data-ph-blind]')
            .forEach(fixBlindSize);
    }

    function restoreMedia(el) {
        if (!el.dataset.phPending) return;
        el.dataset.phAllow = '1';

        if (el.dataset.phPendingSources) {
            // 视频的 <source> src 原样还原（保留多码率）
            const srcs = JSON.parse(el.dataset.phPendingSources);
            el.querySelectorAll('source').forEach(function (s, i) {
                if (srcs[i]) origSetAttr.call(s, 'src', srcs[i]);
            });
        }
        if (el.dataset.phPendingPicSources) {
            const pic = el.closest && el.closest('picture');
            if (pic) {
                const sets = JSON.parse(el.dataset.phPendingPicSources);
                pic.querySelectorAll('source').forEach(function (s, i) {
                    if (sets[i]) origSetAttr.call(s, 'srcset', sets[i]);
                });
            }
        }
        if (el.dataset.phPendingSrcset) {
            origSetAttr.call(el, 'srcset', el.dataset.phPendingSrcset);
        }
        el.src = el.dataset.phPendingSrc; // phAllow 已放行，钩子不拦截
        if (el.tagName === 'VIDEO') el.load();

        // 撤掉占位期间加的尺寸约束，让真身按原始布局规则渲染
        el.style.removeProperty('min-width');
        el.style.removeProperty('min-height');
        el.style.removeProperty('aspect-ratio');
        if (phIO) phIO.unobserve(el); // 已恢复，不再需要可见性修正

        // 小占位还原被清空的 alt 文字
        if (el.dataset.phAlt) {
            origSetAttr.call(el, 'alt', el.dataset.phAlt);
            delete el.dataset.phAlt;
        }
        delete el.dataset.phMini;
        delete el.dataset.phMeasured;
        delete el.dataset.phBlind;
        delete el.dataset.phPending;
        delete el.dataset.phPendingSrc;
        delete el.dataset.phPendingSrcset;
        delete el.dataset.phPendingSources;
        delete el.dataset.phPendingPicSources;
        // 保留 phProcessed，避免已恢复的媒体被重新拦截
    }

    // 文档级委托右键加载：对 SPA 重渲染免疫，无需逐元素绑事件
    document.addEventListener('contextmenu', function (e) {
        const t = e.target && e.target.closest
            ? e.target.closest('img[data-ph-pending], video[data-ph-pending]')
            : null;
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        restoreMedia(t);
    }, true);

    /* ============================================================
     * 占位样式：纯 CSS，不产生任何节点
     * 标签文字用 SVG data URI 背景，被拦截元素自己就是占位框
     * ============================================================ */
    function phLabelSvg(text) {
        const svg =
            "<svg xmlns='http://www.w3.org/2000/svg' width='130' height='44'>" +
            "<rect x='1' y='1' width='128' height='42' rx='5' fill='#f5f5f5' stroke='none'/>" +
            "<text x='65' y='27' font-size='13' font-family='sans-serif' fill='#888' " +
            "text-anchor='middle'>" + text + "</text></svg>";
        return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    // 小占位专用：文字放不下时只显示一个笑脸
    function phSmileSvg() {
        const svg =
            "<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'>" +
            "<circle cx='8' cy='8' r='7' fill='#ffd76e' stroke='#d8b04a' stroke-width='1'/>" +
            "<circle cx='5.4' cy='6.6' r='1.1' fill='#6b5416'/>" +
            "<circle cx='10.6' cy='6.6' r='1.1' fill='#6b5416'/>" +
            "<path d='M4.8 9.6 Q8 12.4 11.2 9.6' stroke='#6b5416' stroke-width='1.3' " +
            "fill='none' stroke-linecap='round'/></svg>";
        return 'data:image/svg+xml,' + encodeURIComponent(svg);
    }

    const MEDIA_CSS = [
        'img[data-ph-pending], video[data-ph-pending] {',
        '  background: #f5f5f5 url("' + phLabelSvg('右键加载') + '") center center no-repeat;',
        '  border: 1px dashed #bbb; border-radius: 4px; box-sizing: border-box;',
        '  cursor: context-menu; color: #888; font-size: 12px;',
        '}',
        // 仅"完全无尺寸信息"的占位给兜底框；可见后由 IO 实测修正，
        // 不能无差别加 130px——会把 16px 的头部图标撑大（占位比实际大的根源）
        'img[data-ph-pending][data-ph-blind], video[data-ph-pending][data-ph-blind] {',
        '  min-width: 130px; min-height: 44px;',
        '}',
        // 放不下文字的小占位：只显示笑脸（alt 已在拦截时暂存清空，恢复时还原）
        'img[data-ph-pending][data-ph-mini], video[data-ph-pending][data-ph-mini] {',
        '  background: #f5f5f5 url("' + phSmileSvg() + '") center center no-repeat;',
        '  background-size: 16px 16px; min-width: 20px; min-height: 20px;',
        '}',
    ].join('\n');

    /* ============================================================
     * 模块二：阅读模式（SPA 安全：覆盖层，不销毁原 DOM）
     * ============================================================ */
    const READER_CSS = [
        '#cr-reader-viewport { position: fixed !important; top: 0; left: 0; right: 0; bottom: 0;',
        '  overflow-y: auto; z-index: 2147483646; background: #fff; }',
        '#cr-reader-view { max-width: 42em; margin: 0 auto; padding: 48px 24px 96px;',
        '  font-size: 17px; line-height: 1.9; color: #2c3e50; background: #fff;',
        '  font-family: Georgia, "Noto Serif SC", "Songti SC", serif; }',
        '#cr-reader-view h1 { font-size: 1.8em; margin: 0 0 0.8em; line-height: 1.4; }',
        '#cr-reader-view h2 { font-size: 1.4em; margin: 1.6em 0 0.8em; }',
        '#cr-reader-view h3 { font-size: 1.2em; margin: 1.4em 0 0.6em; }',
        '#cr-reader-view p  { margin: 1em 0; }',
        '#cr-reader-view img, #cr-reader-view video { max-width: 100%; height: auto;',
        '  border-radius: 4px; margin: 0.5em auto; display: block; }',
        '#cr-reader-view blockquote { border-left: 3px solid #bbb; margin: 1.2em 0;',
        '  padding: 0.2em 1.2em; color: #555; }',
        '#cr-reader-view a { color: #1a5fb4; }',
        '#cr-reader-view pre { background: #f5f5f5; padding: 1em; border-radius: 6px;',
        '  overflow-x: auto; font-size: 14px; }',
        '#cr-reader-view code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }',
        '#cr-reader-view table { border-collapse: collapse; margin: 1em 0; }',
        '#cr-reader-view td, #cr-reader-view th { border: 1px solid #ccc; padding: 6px 10px; }',
        '#cr-reader-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;',
        '  background: rgba(0,0,0,0.75); color: #fff; padding: 10px 16px;',
        '  display: flex; justify-content: space-between; align-items: center; font: 14px sans-serif; }',
        '#cr-reader-bar button { background: transparent; color: #fff; border: 1px solid #888;',
        '  border-radius: 4px; padding: 4px 14px; cursor: pointer; font-size: 13px; }',
        '#cr-reader-bar button:hover { background: #444; }',
    ].join('\n');

    let readerCssAdded = false;

    // 剥离脚本类标签与内联事件，再进 innerHTML
    function sanitize(root) {
        root.querySelectorAll('script, iframe, object, embed, link, meta, form, button, input, select, textarea')
            .forEach(function (n) { n.remove(); });
        root.querySelectorAll('*').forEach(function (n) {
            Array.prototype.forEach.call(n.attributes, function (a) {
                const name = a.name.toLowerCase();
                const val = (a.value || '').trim().toLowerCase();
                if (name.startsWith('on') ||
                    ((name === 'href' || name === 'src' || name === 'xlink:href') && val.startsWith('javascript:'))) {
                    n.removeAttribute(a.name);
                }
            });
        });
    }

    // 在独立文档里预拦截 HTML 字符串中的媒体：
    // innerHTML 赋值时解析器会同步发起图片请求，先在字符串阶段摘掉 src 才能真正不加载
    function preStripHTML(html) {
        let doc;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); }
        catch (e) { return html; }
        doc.querySelectorAll('img, video').forEach(function (el) {
            const src = el.getAttribute('src');
            if (src && !src.startsWith('data:')) {
                el.dataset.phPendingSrc = src;
                el.removeAttribute('src');
            }
            const srcset = el.getAttribute('srcset');
            if (srcset) {
                el.dataset.phPendingSrcset = srcset;
                el.removeAttribute('srcset');
                el.removeAttribute('sizes');
            }
            el.setAttribute('data-ph-pending', '1');
            if (el.tagName === 'VIDEO') {
                const srcs = [];
                el.querySelectorAll('source').forEach(function (s) {
                    srcs.push(s.getAttribute('src') || '');
                    s.removeAttribute('src');
                });
                if (srcs.some(Boolean)) el.dataset.phPendingSources = JSON.stringify(srcs);
            }
        });
        return doc.body.innerHTML;
    }

    // 克隆文档里把被拦截媒体的真实地址还原，供 Readability 提取正文用
    // （克隆文档不是活动文档，设 src 不会发起网络请求）
    function restorePendingInClone(root) {
        root.querySelectorAll('video[data-ph-pending]').forEach(function (el) {
            if (el.dataset.phPendingSources) {
                const srcs = JSON.parse(el.dataset.phPendingSources);
                el.querySelectorAll('source').forEach(function (s, i) {
                    if (srcs[i]) origSetAttr.call(s, 'src', srcs[i]);
                });
            }
        });
        root.querySelectorAll('img[data-ph-pending], video[data-ph-pending]').forEach(function (el) {
            if (el.dataset.phPendingSrcset) origSetAttr.call(el, 'srcset', el.dataset.phPendingSrcset);
            if (el.dataset.phPendingSrc) origSetAttr.call(el, 'src', el.dataset.phPendingSrc);
        });
    }

    function exitReaderMode() {
        const viewport = document.getElementById('cr-reader-viewport');
        if (viewport) viewport.remove();
        if (savedBodyOverflow !== null && document.body) {
            document.body.style.overflow = savedBodyOverflow;
        }
        savedBodyOverflow = null;
        readerActive = false;
    }

    function enterReaderMode(contentHTML, title) {
        if (document.getElementById('cr-reader-viewport')) return;
        readerActive = true;
        if (!readerCssAdded) { GM_addStyle(READER_CSS); readerCssAdded = true; }

        const viewport = document.createElement('div');
        viewport.id = 'cr-reader-viewport';

        const bar = document.createElement('div');
        bar.id = 'cr-reader-bar';
        bar.innerHTML = '<span>📖 阅读模式</span><button id="cr-exit-btn" type="button">退出 (Esc)</button>';
        bar.querySelector('#cr-exit-btn').addEventListener('click', exitReaderMode);

        const view = document.createElement('div');
        view.id = 'cr-reader-view';
        view.innerHTML = preStripHTML(contentHTML); // 字符串阶段摘 src，进入阅读模式零请求
        sanitize(view);
        if (title) {
            const h1 = document.createElement('h1');
            h1.textContent = title; // textContent 防 XSS
            view.insertBefore(h1, view.firstChild);
        }

        viewport.appendChild(bar);
        viewport.appendChild(view);
        document.body.appendChild(viewport);

        savedBodyOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
    }

    function toggleReadability() {
        if (readerActive) { exitReaderMode(); return; }

        // 1) Alt+S 存过的站点选择器优先
        const sel = getSavedSelector();
        if (sel) {
            let node = null;
            try { node = document.querySelector(sel); } catch (e) { /* 选择器失效则回退自动提取 */ }
            if (node) { enterReaderMode(node.innerHTML, document.title); return; }
        }

        // 2) Readability 自动提取
        try {
            const clone = document.cloneNode(true);
            restorePendingInClone(clone); // 先还原真实地址，正文提取才不丢图
            const article = new Readability(clone).parse();
            if (!article || !article.content) {
                alert('未能提取到正文，可尝试 Alt+S 手动选择');
                return;
            }
            enterReaderMode(article.content, article.title);
        } catch (err) {
            alert('提取失败: ' + err.message);
        }
    }

    /* ============================================================
     * 模块三：手动选择器（Alt+S），按站点记忆
     * ============================================================ */
    function getSavedSelectorMap() {
        try { return JSON.parse(GM_getValue('cr-site-selectors', '{}')) || {}; }
        catch (e) { return {}; }
    }
    function getSavedSelector() { return getSavedSelectorMap()[HOST] || null; }

    GM_registerMenuCommand('清除本站正文选择记忆', function () {
        const map = getSavedSelectorMap();
        if (map[HOST]) {
            delete map[HOST];
            GM_setValue('cr-site-selectors', JSON.stringify(map));
            alert(HOST + ' 的正文选择记忆已清除，Alt+R 将回到自动提取');
        } else {
            alert('本站没有保存过正文选择记忆');
        }
    });

    let pickerActive = false;
    let pickerHighlight = null;

    function isOwnUi(el) {
        return !el.closest || !!el.closest('#cr-float-btn, #cr-picker-tip, #cr-reader-bar');
    }

    function cssPath(el) {
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let cur = el;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
            let sel = cur.tagName.toLowerCase();
            if (cur.className && typeof cur.className === 'string') {
                sel += cur.className.trim().split(/\s+/).slice(0, 2)
                    .map(function (s) { return '.' + CSS.escape(s); }).join('');
            }
            const parent = cur.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(function (x) { return x.tagName === cur.tagName; });
                if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(cur) + 1) + ')';
            }
            parts.unshift(sel);
            cur = parent;
        }
        return parts.join(' > ');
    }

    function startPicker() {
        if (readerActive || pickerActive || !document.body) return;
        pickerActive = true;
        savedBodyCursor = document.body.style.cursor;
        document.body.style.cursor = 'crosshair';
        const tip = document.createElement('div');
        tip.id = 'cr-picker-tip';
        tip.textContent = '点击正文区域 · Esc 取消';
        tip.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);' +
            'z-index:2147483647;background:#1a5fb4;color:#fff;padding:8px 18px;' +
            'border-radius:20px;font:14px sans-serif;pointer-events:none;';
        document.body.appendChild(tip);

        document.addEventListener('mouseover', pickerHover, true);
        document.addEventListener('click', pickerClick, true);
        document.addEventListener('keydown', pickerEsc, true);
    }

    function stopPicker() {
        if (!pickerActive) return;
        pickerActive = false;
        if (savedBodyCursor !== null && document.body) {
            document.body.style.cursor = savedBodyCursor;
        }
        savedBodyCursor = null;
        const tip = document.getElementById('cr-picker-tip');
        if (tip) tip.remove();
        if (pickerHighlight) pickerHighlight.style.removeProperty('outline');
        pickerHighlight = null;
        document.removeEventListener('mouseover', pickerHover, true);
        document.removeEventListener('click', pickerClick, true);
        document.removeEventListener('keydown', pickerEsc, true);
    }

    function pickerHover(e) {
        if (!pickerActive || isOwnUi(e.target)) return;
        e.stopPropagation(); e.preventDefault();
        if (pickerHighlight) pickerHighlight.style.removeProperty('outline');
        pickerHighlight = e.target;
        pickerHighlight.style.outline = '3px solid #1a5fb4';
    }
    function pickerEsc(e) { if (e.key === 'Escape') stopPicker(); }

    function pickerClick(e) {
        if (!pickerActive || isOwnUi(e.target)) return;
        e.stopPropagation(); e.preventDefault();
        const target = e.target;
        const saved = getSavedSelectorMap();
        saved[HOST] = cssPath(target);
        GM_setValue('cr-site-selectors', JSON.stringify(saved));
        stopPicker();
        enterReaderMode(target.innerHTML, document.title);
    }

    /* ============================================================
     * 快捷键 + 浮动按钮
     * ============================================================ */
    function isEditable(t) {
        if (!t || t.nodeType !== 1) return false;
        const tag = t.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }

    document.addEventListener('keydown', function (e) {
        // Esc 必须放在 altKey 判断之前，否则纯 Esc 永远无效
        if (e.key === 'Escape') {
            if (readerActive) { e.preventDefault(); exitReaderMode(); }
            return;
        }
        if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
        if (isEditable(e.target)) return; // 不干扰网页编辑器（它们常用 Alt+ 快捷键）
        if (e.code === 'KeyR') {
            e.preventDefault();
            toggleReadability();
        } else if (e.code === 'KeyS') {
            e.preventDefault();
            pickerActive ? stopPicker() : startPicker();
        }
    });

    function addFloatButton() {
        if (document.getElementById('cr-float-btn')) return;
        const btn = document.createElement('div');
        btn.id = 'cr-float-btn';
        btn.textContent = '📖';
        btn.title = '阅读模式 (Alt+R)';
        btn.style.cssText = 'position:fixed;right:16px;bottom:80px;z-index:2147483645;' +
            'width:40px;height:40px;border-radius:50%;background:rgba(26,95,180,0.85);' +
            'color:#fff;font-size:20px;display:flex;align-items:center;justify-content:center;' +
            'cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);user-select:none;';
        btn.addEventListener('click', toggleReadability);
        document.body.appendChild(btn);
    }

    /* ============================================================
     * SPA 路由变化时自动退出阅读模式，避免读到旧页面内容
     * ============================================================ */
    const origPushState = history.pushState;
    history.pushState = function () {
        const r = origPushState.apply(this, arguments);
        if (readerActive) exitReaderMode();
        return r;
    };
    window.addEventListener('popstate', function () {
        if (readerActive) exitReaderMode();
    });

    /* ============================================================
     * 启动逻辑
     * ============================================================ */
    if (blockMedia) {
        hookMediaSrc();
        GM_addStyle(MEDIA_CSS); // 占位样式在 document-start 就位，先于任何图片渲染

        const observer = new MutationObserver(function (muts) {
            muts.forEach(function (m) {
                m.addedNodes.forEach(function (n) {
                    if (n.nodeType !== Node.ELEMENT_NODE) return;
                    if (readerActive) return; // 阅读期间不处理后台 SPA 变更
                    if (n.tagName === 'IMG' || n.tagName === 'VIDEO') processMedia(n);
                    if (n.querySelectorAll) {
                        n.querySelectorAll('img, video').forEach(processMedia);
                    }
                });
            });
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    const init = function () {
        if (blockMedia) {
            document.querySelectorAll('img, video').forEach(processMedia);
            // 两次补测：双帧后（CSS 已应用、布局完成，约 32ms）+ load 后（晚到的样式/字体重排后）
            requestAnimationFrame(function () {
                requestAnimationFrame(recheckPending);
            });
            if (document.readyState === 'complete') setTimeout(recheckPending, 200);
            else window.addEventListener('load', function () { setTimeout(recheckPending, 200); }, { once: true });
        }
        addFloatButton();
    };

    if (document.body) init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
