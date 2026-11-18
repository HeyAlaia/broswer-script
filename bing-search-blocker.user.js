// ==UserScript==
// @name         搜索结果屏蔽器（Bing + DuckDuckGo）
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  必应 / DDG 双重屏蔽：搜索词自动追加 -site: 二次防护（服务端过滤）+ 结果页 DOM 隐藏；悬停一键"屏蔽此站"，名单随时编辑
// @match        *://*.bing.com/search*
// @match        *://*.duckduckgo.com/*
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @downloadURL  https://raw.githubusercontent.com/HeyAlaia/broswer-script/main/bing-search-blocker.user.js
// @updateURL    https://raw.githubusercontent.com/HeyAlaia/broswer-script/main/bing-search-blocker.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
     * 默认屏蔽名单（自动匹配所有子域：csdn.net 覆盖 blog.csdn.net 等）
     * 想增删：Tampermonkey 菜单 → 编辑屏蔽域名列表
     * ============================================================ */
    const DEFAULT_HOSTS = [
        'csdn.net',    // CSDN（含 huaweicloud.csdn.net、download.csdn.net 等）
        'baidu.com',   // 百度系全部（知道/经验/文库/百科/百家号/贴吧/翻译…）
        'hao123.com',  // 百度旗下 hao123
        '51cto.com',   // 51CTO 博客
        'jb51.net',    // 脚本之家
        'jianshu.com', // 简书
        'php.cn',      // PHP 中文网
        '360doc.com',  // 个人图书馆
    ];

    const STORE_KEY = 'bsb-hosts';
    let showBlocked = false;

    /* ============================================================
     * 引擎适配：新增搜索引擎在这里加一项即可
     * ============================================================ */
    const ENGINES = [
        {
            name: 'bing',
            tests: function () { return /(^|\.)bing\.com$/.test(location.hostname); },
            // b_algo 只含自然结果，广告在 li.b_ad 里不会命中
            items: function () { return document.querySelectorAll('#b_results li.b_algo'); },
            // 提示条插在整个结果列表前面
            anchor: function () { return document.getElementById('b_results'); },
            linkIn: function (item) {
                return item.querySelector('h2 a[href]');
            },
        },
        {
            name: 'ddg',
            tests: function () { return /(^|\.)duckduckgo\.com$/.test(location.hostname); },
            // 新版 React 版式 + 经典版式（含 html.duckduckgo.com）
            items: function () {
                return document.querySelectorAll(
                    'article[data-testid="result"], #links .result__body');
            },
            anchor: function () {
                return document.querySelector(
                    'article[data-testid="result"], #links .result__body');
            },
            linkIn: function (item) {
                return item.querySelector(
                    'a[data-testid="result-title-a"], a.result__a, .result__title a[href], h2 a[href]');
            },
            isAd: function (item) {
                return !!item.closest('.result--ad, [data-testid="ad"]');
            },
        },
    ];

    function getEngine() {
        return ENGINES.find(function (e) { return e.tests(); }) || null;
    }

    /* ============================================================
     * URL 解析：还原各家跳转链接里的真实地址
     * ============================================================ */
    function realUrlFrom(href) {
        try {
            const u = new URL(href, location.href);
            // Bing：/ck/a?...&u=a1<base64url>
            if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.indexOf('/ck/') === 0) {
                const p = u.searchParams.get('u') || '';
                let b64 = p.indexOf('a1') === 0 ? p.slice(2) : p;
                b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
                while (b64.length % 4) b64 += '=';
                const bytes = Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
                return new TextDecoder('utf-8').decode(bytes);
            }
            // DDG：/l/?uddg=<encodeURIComponent 真实地址>
            if (/(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname.indexOf('/l/') === 0) {
                const target = u.searchParams.get('uddg');
                if (target) return target;
            }
            return u.href;
        } catch (e) { return href; }
    }

    function hostOfItem(item, engine) {
        const a = engine.linkIn(item);
        if (!a) return '';
        try {
            const url = realUrlFrom(a.getAttribute('href') || '');
            return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        } catch (e) { return ''; }
    }

    /* ============================================================
     * 扫描结果：命中的隐藏，未命中的还原
     * ============================================================ */
    function scan() {
        const engine = getEngine();
        if (!engine) return;
        const items = engine.items();
        if (!items.length) {
            const bar = document.getElementById('crsb-bar');
            if (bar) bar.remove();
            return;
        }

        const hosts = getHosts().map(function (h) { return h.toLowerCase(); });
        const hits = {};
        let blockedCount = 0;

        items.forEach(function (item) {
            if (engine.isAd && engine.isAd(item)) return;
            const host = hostOfItem(item, engine);
            if (!host) return;
            addBlockButton(item, host);

            const blocked = hosts.some(function (h) {
                return host === h || host.endsWith('.' + h);
            });
            if (blocked) {
                blockedCount++;
                hits[host] = (hits[host] || 0) + 1;
                item.dataset.crsbTouched = '1';
                item.style.display = showBlocked ? '' : 'none';
                item.classList.toggle('crsb-shown', showBlocked);
            } else if (item.dataset.crsbTouched) {
                item.style.display = '';
                item.classList.remove('crsb-shown');
            }
        });

        updateBar(blockedCount, hits, engine);
    }

    /* ============================================================
     * 顶部提示条：🚫 已屏蔽 N 条（明细）· 临时显示/重新隐藏
     * ============================================================ */
    function updateBar(count, hits, engine) {
        let bar = document.getElementById('crsb-bar');
        if (count === 0) { if (bar) bar.remove(); return; }

        const anchor = engine.anchor && engine.anchor();
        if (!anchor || !anchor.parentNode) return;

        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'crsb-bar';
        }
        // 引擎前端重渲染后 bar 可能被移除/挪位，确保它始终在锚点前面
        if (bar.nextElementSibling !== anchor) {
            anchor.parentNode.insertBefore(bar, anchor);
        }

        // 内容没变就不动 DOM，避免和 MutationObserver 互相触发死循环
        const detail = Object.keys(hits).map(function (h) { return h + '×' + hits[h]; }).join('、');
        const state = count + '|' + detail + '|' + showBlocked;
        if (bar.dataset.state === state) return;
        bar.dataset.state = state;

        while (bar.firstChild) bar.removeChild(bar.firstChild);
        const span = document.createElement('span');
        span.textContent = '🚫 已屏蔽 ' + count + ' 条结果（' + detail + '）';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = showBlocked ? '重新隐藏' : '临时显示';
        btn.addEventListener('click', function () {
            showBlocked = !showBlocked;
            scan();
        });
        bar.appendChild(span);
        bar.appendChild(btn);
    }

    /* ============================================================
     * 每条结果右上角的"屏蔽此站"按钮（悬停可见）
     * ============================================================ */
    function addBlockButton(item, host) {
        const old = item.querySelector('.crsb-site-btn');
        if (old) { old.dataset.host = host; return; }

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'crsb-site-btn';
        btn.textContent = '⛔ 屏蔽此站';
        btn.title = '将 ' + host + ' 加入屏蔽名单';
        btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const list = getHosts();
            if (list.indexOf(host) === -1) list.push(host);
            setHosts(list);
            scan();
        });
        item.appendChild(btn);
    }

    /* ============================================================
     * 名单存取 + 菜单
     * ============================================================ */
    function getHosts() {
        const raw = GM_getValue(STORE_KEY, null);
        if (raw == null || raw === '') return DEFAULT_HOSTS.slice();
        try {
            const list = JSON.parse(raw);
            return Array.isArray(list) ? list : DEFAULT_HOSTS.slice();
        } catch (e) { return DEFAULT_HOSTS.slice(); }
    }
    function setHosts(list) { GM_setValue(STORE_KEY, JSON.stringify(list)); }

    GM_registerMenuCommand('编辑屏蔽域名列表', function () {
        const input = prompt(
            '每行一个域名（自动匹配所有子域；清空并确定 = 恢复默认，完全不屏蔽请直接停用脚本）：',
            getHosts().join('\n')
        );
        if (input === null) return; // 取消
        const parsed = input
            .split(/[\s,，;；]+/)
            .map(function (s) { return s.trim().toLowerCase().replace(/^www\./, ''); })
            .filter(Boolean);
        GM_setValue(STORE_KEY, parsed.length ? JSON.stringify(parsed) : '');
        scan();
    });

    GM_registerMenuCommand('恢复默认屏蔽列表', function () {
        GM_setValue(STORE_KEY, '');
        scan();
        alert('已恢复默认：' + DEFAULT_HOSTS.join('、'));
    });

    /* ============================================================
     * 二次防护：自动给搜索词追加 -site:xxx（服务端就不返回这些站）
     * 在 document-start 阶段改写 URL 重定向，页面渲染前完成
     * ============================================================ */
    const AUTO_EXCLUDE_KEY = 'bsb-auto-exclude';

    function autoExcludeEnabled() { return GM_getValue(AUTO_EXCLUDE_KEY, true); }

    function hasSiteToken(q, host) {
        // 匹配用户已写的 site:host / -site:host（正反都算已处理，尊重手动过滤）
        const re = new RegExp('(^|[\\s])[-+]?site:' +
            host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[\\s])', 'i');
        return re.test(q);
    }

    function autoExclude() {
        if (!autoExcludeEnabled()) return;
        let u;
        try { u = new URL(location.href); } catch (e) { return; }
        const q = u.searchParams.get('q');
        if (!q || !q.trim()) return;

        const missing = getHosts().filter(function (h) {
            return !hasSiteToken(q, h.toLowerCase());
        });
        if (!missing.length) return; // 已带全屏蔽词，避免重定向死循环

        u.searchParams.set('q', q.trim() + ' ' + missing.map(function (h) {
            return '-site:' + h.toLowerCase();
        }).join(' '));
        location.replace(u.href);
    }

    GM_registerMenuCommand('切换：搜索词自动追加 -site: 屏蔽', function () {
        const next = !autoExcludeEnabled();
        GM_setValue(AUTO_EXCLUDE_KEY, next);
        alert(next
            ? '已开启二次防护：下次搜索自动在关键词后追加 -site:csdn.net 等屏蔽词，下次搜索生效'
            : '已关闭二次防护：仅用页面隐藏。想专门搜索 CSDN/百度站内内容时可临时关闭本开关');
    });

    /* ============================================================
     * 样式（中性配色，DDG 深色模式下也可用）
     * ============================================================ */
    GM_addStyle([
        '#b_results li.b_algo, article[data-testid="result"], #links .result__body { position: relative; }',
        '.crsb-site-btn { position: absolute; top: 6px; right: 8px; z-index: 9;',
        '  opacity: 0; transition: opacity .15s; background: rgba(0,0,0,.55); color: #fff;',
        '  border: none; border-radius: 4px; padding: 3px 8px; font: 12px sans-serif;',
        '  cursor: pointer; }',
        '#b_results li.b_algo:hover .crsb-site-btn, article[data-testid="result"]:hover .crsb-site-btn,',
        '#links .result__body:hover .crsb-site-btn { opacity: 1; }',
        '.crsb-site-btn:hover { background: #c42b1c !important; }',
        '#crsb-bar { display: flex; align-items: center; gap: 12px; margin: 0 0 8px 0;',
        '  padding: 8px 12px; background: rgba(125,125,125,.12); color: inherit;',
        '  border: 1px solid rgba(125,125,125,.35); border-radius: 6px; font: 13px sans-serif; }',
        '#crsb-bar button { background: transparent; color: inherit;',
        '  border: 1px solid rgba(125,125,125,.5); border-radius: 4px; padding: 2px 10px;',
        '  cursor: pointer; font-size: 12px; }',
        '.crsb-shown { opacity: .55; outline: 1px dashed #c42b1c; }',
    ].join('\n'));

    /* ============================================================
     * 启动：二次防护先行（document-start，渲染前重定向），DOM 层等 body
     * ============================================================ */
    autoExclude();

    function startDomLayer() {
        let timer = null;
        function scheduleScan() {
            if (timer) return;
            timer = setTimeout(function () { timer = null; scan(); }, 120);
        }
        const observer = new MutationObserver(scheduleScan);
        observer.observe(document.body, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ['href'], // 有时 href 是后填的
        });
        scan();
    }

    if (document.body) startDomLayer();
    else document.addEventListener('DOMContentLoaded', startDomLayer, { once: true });
})();
