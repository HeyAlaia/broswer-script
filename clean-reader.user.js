// ==UserScript==
// @name         Clean Reader - 媒体占位 + 阅读模式
// @namespace    http://tampermonkey.net/
// @version      3.7
// @description  媒体自动加载改为右键加载 / Alt+R 阅读模式（Readability + 站点记忆）/ Alt+S 手动选择正文 / Esc 退出
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @require      https://cdn.jsdelivr.net/npm/@mozilla/readability@0.4.4/Readability.js
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
     * 模块一：媒体占位符（img / video）
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
    // data: 内嵌图（如 1px 懒加载占位 gif）不算真实地址，避免"永久不可见"
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

    function makePlaceholder(el) {
        const realSrc = el.dataset.phPendingSrc || getRealSrc(el);

        let width = el.tagName === 'VIDEO' ? 320 : 300;
        let height = el.tagName === 'VIDEO' ? 180 : 200;
        const rect = el.getBoundingClientRect();
        if (rect.width > 5) width = rect.width;
        if (rect.height > 5) height = rect.height;
        if (el.hasAttribute('width')) width = parseFloat(el.getAttribute('width')) || width;
        if (el.hasAttribute('height')) height = parseFloat(el.getAttribute('height')) || height;

        const ph = document.createElement('div');
        ph.style.cssText = 'width:' + width + 'px;height:' + height + 'px;max-width:100%;max-height:100%;' +
            'background:#f0f0f0;border:1px dashed #ccc;display:inline-flex;align-items:center;' +
            'justify-content:center;cursor:context-menu;color:#666;text-align:center;' +
            'box-sizing:border-box;overflow:hidden;user-select:none;vertical-align:middle;';

        // 记录真实地址：占位 div 序列化进 HTML（阅读模式 / Readability 克隆）后仍能还原
        ph.dataset.phSrc = realSrc;
        ph.dataset.phKind = el.tagName === 'VIDEO' ? 'video' : 'img';
        if (el.dataset.phPendingSrcset) ph.dataset.phSrcset = el.dataset.phPendingSrcset;

        const w = Math.round(width), h = Math.round(height);
        const label = el.tagName === 'VIDEO' ? '视频' : '图片';
        if (w < 80 || h < 40) {
            ph.style.fontSize = '10px';
            ph.innerText = '···';
        } else if (w < 140 || h < 70) {
            ph.style.fontSize = '11px';
            ph.style.whiteSpace = 'nowrap';
            ph.innerText = '加载 (' + w + '×' + h + ')';
        } else {
            ph.style.fontSize = '12px';
            ph.style.whiteSpace = 'nowrap';
            ph.innerHTML = '右键加载' + label +
                '<br><span style="font-size:10px;opacity:.8">(' + w + '×' + h + ')</span>';
        }
        ph.title = '右键加载' + label + ' ' + w + '×' + h;

        ph.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            restoreMedia(el, ph);
        });
        return ph;
    }

    function restoreMedia(el, ph) {
        if (!el.dataset.phPendingSrc && !el.dataset.phPendingSrcset && !el.dataset.phPendingSources) return;
        el.dataset.phAllow = '1';

        if (el.dataset.phPendingSources) {
            // 视频的 <source> 子元素原样还原（保留多码率）
            el.innerHTML = JSON.parse(el.dataset.phPendingSources).join('');
            delete el.dataset.phPendingSources;
        } else if (el.dataset.phPendingSrc) {
            el.src = el.dataset.phPendingSrc; // phAllow 已打上，钩子放行
        }
        if (el.dataset.phPendingSrcset) {
            origSetAttr.call(el, 'srcset', el.dataset.phPendingSrcset);
            delete el.dataset.phPendingSrcset;
        }
        if (el.dataset.phPendingPicSources) {
            // picture 的 <source srcset> 还原（ph 顶替了 el 的位置，父级要用 ph 找）
            const pic = ph.parentElement;
            if (pic) {
                JSON.parse(el.dataset.phPendingPicSources).forEach(function (v, i) {
                    const s = pic.querySelectorAll('source')[i];
                    if (s && v) origSetAttr.call(s, 'srcset', v);
                });
            }
            delete el.dataset.phPendingPicSources;
        }
        if (el.tagName === 'VIDEO') el.load();
        delete el.dataset.phPendingSrc;
        delete el.dataset.phPending;
        ph.replaceWith(el);
    }

    function processMedia(el) {
        if (el.dataset.phProcessed || !el.parentNode) return;

        const real = getRealSrc(el);
        if (!real) return; // 纯 data: 内嵌图或暂无地址：放行不动

        el.dataset.phProcessed = '1';
        el.dataset.phPending = '1';
        el.dataset.phPendingSrc = real;

        const srcset = el.getAttribute('srcset');
        if (srcset) {
            el.dataset.phPendingSrcset = srcset;
            el.removeAttribute('srcset');
            el.removeAttribute('sizes');
        }

        // 此时 src 还在，占位尺寸量得准
        const ph = makePlaceholder(el);

        el.removeAttribute('src');
        for (let i = 0; i < LAZY_ATTRS.length; i++) el.removeAttribute(LAZY_ATTRS[i]);

        if (el.tagName === 'VIDEO') {
            // 不摘 <source> 的话视频照常加载
            const sources = el.querySelectorAll('source');
            if (sources.length) {
                el.dataset.phPendingSources = JSON.stringify(Array.from(sources, function (s) { return s.outerHTML; }));
                sources.forEach(function (s) { s.remove(); });
            }
        } else if (el.parentElement && el.parentElement.tagName === 'PICTURE') {
            // 不摘 picture <source srcset> 的话浏览器仍会请求其资源
            const picSources = el.parentElement.querySelectorAll('source');
            if (picSources.length) {
                el.dataset.phPendingPicSources = JSON.stringify(Array.from(picSources, function (s) { return s.getAttribute('srcset') || ''; }));
                picSources.forEach(function (s) { s.removeAttribute('srcset'); });
            }
        }

        el.parentNode.replaceChild(ph, el);
    }

    // 把序列化到 HTML 里的占位 div 还原成 img/video（Readability 克隆 / 阅读视图注入前调用）
    function restorePlaceholderDivs(root) {
        root.querySelectorAll('div[data-ph-src]').forEach(function (d) {
            const media = document.createElement(d.dataset.phKind === 'video' ? 'video' : 'img');
            media.dataset.phPending = '1'; // 让 processMedia 重新接管
            media.dataset.phPendingSrc = d.dataset.phSrc;
            if (d.dataset.phSrcset) media.dataset.phPendingSrcset = d.dataset.phSrcset;
            // 克隆文档不是活动文档，设置 src 不会发起请求；
            // 活动文档里则只走 dataset（同步交给 processMedia，避免加载竞速）
            if (d.ownerDocument !== document) origSetAttr.call(media, 'src', d.dataset.phSrc);
            d.replaceWith(media);
        });
    }

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
        view.innerHTML = contentHTML;
        sanitize(view);
        restorePlaceholderDivs(view); // 页面上已被替换的图片在这里还原，再按需占位
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

        if (blockMedia) {
            view.querySelectorAll('img, video').forEach(processMedia);
        }
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
            restorePlaceholderDivs(clone); // 先把占位 div 还原成图片，正文才不会丢图
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
        }
        addFloatButton();
    };

    if (document.body) init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
