'use strict';

/**
 * 等待路径集成验证：证明「窗口即将开启时，作业内等待到窗口开启再续期」真的生效。
 *
 * 做法：把 playwright-extra / stealth 换成桩件，并在 9222 端口伪造 CDP 就绪，
 * 让脚本走完「预检 → launchChrome → 连接 → 用户循环 → 等待」的真实代码路径；
 * 页面首次导航时抛错即停（不会访问真实站点）。
 *
 * 断言：
 *   1. 日志出现 [等待] 且窗口时刻正确
 *   2. 从进程启动到首次导航的耗时 ≥ 窗口等待时长（证明真的等了，而不是提前跑）
 *
 * 用法：node test/harness_wait_path.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, '.tmp-wait');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
process.chdir(TMP);

const W = require(path.join(ROOT, 'lib', 'renew_window.js'));
const SITE_TZ = 'Asia/Shanghai';

const START = Date.now();
const WINDOW_AT = START + 1500;           // 1.5 秒后开启 → decide 返回 wait（waitMs ≈ 31.5s）
const GRACE_MS = 30 * 1000;

// 伪造窗口状态：窗口马上开启
fs.writeFileSync(path.join(TMP, 'renew_dates.json'), JSON.stringify({
    'a***m': {
        v: 2,
        date: W.formatInTz(WINDOW_AT, SITE_TZ).slice(0, 10),
        windowAt: WINDOW_AT,
        renewedAt: WINDOW_AT - 96 * 3600 * 1000,
        cycleHours: 96,
        skipNotifiedFor: null,
        lastCheckedAt: null,
        raw: null
    }
}, null, 2));

process.env.USERS_JSON = '[{"username":"a@b.com","password":"x","serverId":"1"}]';
process.env.TG_BOT_TOKEN = 'test:token';
process.env.TG_CHAT_ID = '123';
process.env.TG_API_BASE = 'http://127.0.0.1:8799';

// --- 桩件：playwright-extra / stealth ---
let firstGotoAt = null;
const navAttempts = [];

function makePage() {
    return {
        setDefaultTimeout() {},
        async setViewportSize() {},
        async addInitScript() {},
        async goto(url) {
            navAttempts.push({ url, at: Date.now() });
            if (firstGotoAt === null) firstGotoAt = Date.now();
            throw new Error('HARNESS_STOP: 桩件不访问真实站点');
        },
        async waitForTimeout() {},
        async close() {},
        isClosed() { return false; },
        url() { return 'about:blank'; },
        async screenshot() {},
        frames() { return []; },
        async evaluate() { return null; },
        async innerText() { return ''; },
        async reload() {},
        mouse: { async move() {} },
        locator() {
            const self = {
                count: async () => 0,
                first: () => self,
                filter: () => self,
                evaluateAll: async () => false,
                isVisible: async () => false,
                waitFor: async () => {},
                boundingBox: async () => null,
                scrollIntoViewIfNeeded: async () => {}
            };
            return self;
        },
        getByRole() {
            const self = {
                first: () => self,
                waitFor: async () => {},
                fill: async () => {},
                click: async () => {},
                isVisible: async () => false
            };
            return self;
        },
        getByText() {
            return { isVisible: async () => false, innerText: async () => '' };
        }
    };
}

const context = {
    async clearCookies() {},
    async newPage() { return makePage(); },
    pages() { return []; },
    async route() {},
    async close() {}
};
const fakeBrowser = { contexts: () => [context], async close() {} };

const fakeChromium = {
    use() {},
    async connectOverCDP() { return fakeBrowser; }
};

require.cache[require.resolve('playwright-extra')] = {
    id: 'playwright-extra', filename: 'playwright-extra', loaded: true,
    exports: { chromium: fakeChromium }
};
require.cache[require.resolve('puppeteer-extra-plugin-stealth')] = {
    id: 'stealth', filename: 'stealth', loaded: true,
    exports: () => ({})
};

// --- 伪造 CDP 就绪（9222/json/version），让 launchChrome 直接通过 ---
const cdp = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ Browser: 'harness', 'Protocol-Version': '1.3' }));
});
cdp.listen(9222, '127.0.0.1', () => {
    console.log('[harness] 伪造 CDP 已就绪 @9222，窗口开启于',
        W.formatInTz(WINDOW_AT, SITE_TZ), `(T+${((WINDOW_AT - START) / 1000).toFixed(1)}s)`);

    // 抓取日志用于断言
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); origLog(...args); };

    process.on('exit', () => {
        const waitLine = logs.find(l => l.includes('[等待]') && l.includes('即将开启'));
        const openLine = logs.find(l => l.includes('窗口已开启'));
        const elapsedToNav = firstGotoAt === null ? null : firstGotoAt - START;
        const expectedWait = WINDOW_AT - START + GRACE_MS;

        console.log('\n================ harness 断言 ================');
        console.log(`导航尝试次数        : ${navAttempts.length}`);
        console.log(`首次导航耗时        : ${elapsedToNav === null ? 'N/A' : (elapsedToNav / 1000).toFixed(2) + 's'}`);
        console.log(`期望等待时长(含宽限): ${(expectedWait / 1000).toFixed(2)}s`);
        console.log(`[等待] 日志         : ${waitLine ? '有' : '无'}`);
        console.log(`窗口已开启日志      : ${openLine ? '有' : '无'}`);

        const problems = [];
        if (!waitLine) problems.push('未出现 [等待] 日志：窗口临近时没有在作业内等待');
        if (!openLine) problems.push('未出现「窗口已开启」日志：等待后没有继续执行');
        if (elapsedToNav === null) problems.push('从未尝试导航，流程未走到续期阶段');
        else if (elapsedToNav < expectedWait * 0.85) {
            problems.push(`提前执行：耗时 ${(elapsedToNav / 1000).toFixed(2)}s 明显短于期望 ${(expectedWait / 1000).toFixed(2)}s`);
        }

        if (problems.length) {
            console.log('\n❌ 失败：');
            problems.forEach(p => console.log('   - ' + p));
            process.exitCode = 1;
        } else {
            console.log('\n✅ 通过：窗口临近时作业内等待，开启后才进入续期流程');
        }
        console.log('==============================================\n');
        cdp.close();
    });

    require(path.join(ROOT, 'kata_renew.js'));
});
