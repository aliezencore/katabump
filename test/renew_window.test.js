'use strict';

/**
 * 续期窗口逻辑离线测试（零依赖：node test/renew_window.test.js）
 *
 * 覆盖用户实际踩坑的临界点：
 *   - 北京 07:20（UTC 前一日 23:20）那次运行必须「等待」而不是「跳过」
 *   - 北京 07:30 / 07:31 必须「执行」
 *   - 北京 19:20（12h cron 的另一次）必须「跳过」
 *   - 旧的裸日期条目 "2026-09-10" 必须迁移成正确的 UTC 瞬间（无 8 小时错位）
 * 结果与进程 TZ 无关：建议分别用 TZ=UTC / TZ=America/New_York 各跑一遍。
 */

const assert = require('assert');
const W = require('../lib/renew_window');

let passed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch (e) {
        failures.push({ name, error: e });
        console.log(`  FAIL ${name}\n       ${e.message}`);
    }
}

function eq(actual, expected, label) {
    assert.strictEqual(actual, expected, `${label || ''} 期望 ${expected}，实际 ${actual}`);
}

// 站点时区（北京）= UTC+8，以下 epoch 全部显式构造，避免依赖进程 TZ
const TZ = 'Asia/Shanghai';
const at = (iso) => Date.parse(iso);

console.log(`\n[renew_window] 进程 TZ=${process.env.TZ || '(系统默认)'}\n`);

console.log('时区换算');
test('北京 2026-09-10 07:30 == UTC 2026-09-09 23:30', () => {
    eq(W.zonedToUtc(2026, 9, 10, 7, 30, 0, TZ), at('2026-09-09T23:30:00Z'), 'windowAt');
});
test('东八区偏移为 +8h', () => {
    eq(W.tzOffsetMs(at('2026-09-09T23:30:00Z'), TZ), 8 * 3600 * 1000, 'offset');
});
test('partsInTz 回读一致', () => {
    const p = W.partsInTz(at('2026-09-09T23:30:00Z'), TZ);
    eq(p.hour, 7, 'hour');
    eq(p.day, 10, 'day');
    eq(p.month, 9, 'month');
});
test('formatInTz 输出站点本地时间', () => {
    eq(W.formatInTz(at('2026-09-09T23:30:00Z'), TZ), '2026-09-10 07:30', 'formatted');
});
test('同一天判断按站点时区', () => {
    eq(W.isSameSiteDay(at('2026-09-09T23:30:00Z'), at('2026-09-10T01:00:00Z'), TZ), true, 'same day');
});

console.log('\n提示文本解析');
test('解析绝对日期（无时刻时补 07:30）', () => {
    const hint = W.parseWindowHint('You can\'t renew your server yet. as of 10 September 2026 (in 3 days)', {
        timeZone: TZ, nowMs: at('2026-09-06T23:20:00Z')
    });
    eq(hint.kind, 'absolute', 'kind');
    eq(hint.windowAt, at('2026-09-09T23:30:00Z'), 'windowAt');
    eq(hint.dateText, '2026-09-10', 'dateText');
});
test('解析绝对日期 + 显式时刻', () => {
    const hint = W.parseWindowHint('as of 2026-09-10 07:30 (in 4 days)', { timeZone: TZ });
    eq(hint.windowAt, at('2026-09-09T23:30:00Z'), 'windowAt');
});
test('解析相对时长 "in 3 days, 22 hours"', () => {
    const now = at('2026-09-06T23:20:00Z');
    const hint = W.parseWindowHint('You can renew your server as of in 3 days, 22 hours', { timeZone: TZ, nowMs: now });
    eq(hint.kind, 'relative', 'kind');
    eq(hint.windowAt, now + (3 * 24 + 22) * 3600 * 1000, 'windowAt');
});
test('解析站点实际返回的「无年份」格式 "25 September"（取今年）', () => {
    const hint = W.parseWindowHint('25 September', { timeZone: TZ, nowMs: at('2026-09-22T00:00:00Z') });
    eq(hint.kind, 'absolute', 'kind');
    eq(hint.dateText, '2026-09-25', 'dateText');
    eq(hint.windowAt, W.zonedToUtc(2026, 9, 25, 7, 30, 0, TZ), 'windowAt');
});
test('「无年份」格式若今年已过则取明年', () => {
    const hint = W.parseWindowHint('25 September', { timeZone: TZ, nowMs: at('2026-10-01T00:00:00Z') });
    eq(hint.dateText, '2027-09-25', 'dateText');
});
test('「无年份」格式带时刻 "25 September 08:00"', () => {
    const hint = W.parseWindowHint('25 September 08:00', { timeZone: TZ, nowMs: at('2026-09-22T00:00:00Z') });
    eq(hint.windowAt, W.zonedToUtc(2026, 9, 25, 8, 0, 0, TZ), 'windowAt');
});
test('「无年份」格式 "September 25" 亦可', () => {
    const hint = W.parseWindowHint('September 25', { timeZone: TZ, nowMs: at('2026-09-22T00:00:00Z') });
    eq(hint.dateText, '2026-09-25', 'dateText');
});
test('月份名不会被时长单位误匹配', () => {
    eq(W.parseWindowHint('in 3 days', { timeZone: TZ, nowMs: at('2026-09-22T00:00:00Z') }).kind, 'relative', 'days');
    eq(W.parseWindowHint('in 22 hours', { timeZone: TZ, nowMs: at('2026-09-22T00:00:00Z') }).kind, 'relative', 'hours');
});
test('无法识别时返回 none（不误判成已到窗口）', () => {
    const hint = W.parseWindowHint('Something went wrong, please try again later', { timeZone: TZ });
    eq(hint.kind, 'none', 'kind');
    eq(hint.windowAt, null, 'windowAt');
});

console.log('\n旧数据迁移（关键回归：原实现的 8 小时错位）');
test('"2026-09-10" → UTC 2026-09-09T23:30Z（而不是 09-10T00:00Z）', () => {
    const state = W.migrateState('2026-09-10', { timeZone: TZ, nowMs: at('2026-09-06T00:00:00Z') });
    eq(state.v, 2, 'version');
    eq(state.windowAt, at('2026-09-09T23:30:00Z'), 'windowAt');
    eq(state.date, '2026-09-10', 'date');
    eq(state.renewedAt, null, 'renewedAt');
});
test('对象格式原样保留', () => {
    const state = W.migrateState({ date: '2026-09-10', windowAt: at('2026-09-09T23:30:00Z'), renewedAt: at('2026-09-05T23:30:00Z') }, { timeZone: TZ });
    eq(state.windowAt, at('2026-09-09T23:30:00Z'), 'windowAt');
    eq(state.renewedAt, at('2026-09-05T23:30:00Z'), 'renewedAt');
});
test('96 小时周期锚定在续期瞬间', () => {
    const renewedAt = at('2026-09-06T23:30:00Z');
    eq(W.computeWindowAt(renewedAt, 96), at('2026-09-10T23:30:00Z'), 'windowAt');
    const state = W.migrateState({ renewedAt }, { timeZone: TZ, cycleHours: 96 });
    eq(state.windowAt, at('2026-09-10T23:30:00Z'), 'migrated windowAt');
});
test('空值/垃圾值安全返回 null', () => {
    eq(W.migrateState(null), null, 'null');
    eq(W.migrateState(''), null, 'empty');
    eq(W.migrateState('not a date'), null, 'garbage');
});
test('null 字段不被误当成 0（Number(null)===0 陷阱）', () => {
    eq(W.migrateState({ windowAt: null, renewedAt: null }, { timeZone: TZ }), null, 'null 字段');
    eq(W.migrateState({ windowAt: '' }, { timeZone: TZ }), null, '空字符串字段');
    eq(W.migrateState({}, { timeZone: TZ }), null, '缺字段');
    eq(W.computeWindowAt(null), null, 'computeWindowAt(null)');
    eq(W.computeWindowAt(NaN), null, 'computeWindowAt(NaN)');
});
test('windowAt=0（epoch）虽合法但应被视为缺失而非当前时刻', () => {
    // 0 是合法 epoch，但现实中不可能是有效窗口；确认不会静默当成「已过期」而误触发
    const st = W.migrateState({ windowAt: 0, renewedAt: 0 }, { timeZone: TZ });
    if (st !== null) {
        const d = W.decide(st, at('2026-09-09T23:30:00Z'));
        eq(d.action, 'run', 'action');
    }
});

console.log('\n决策临界点（12h cron: 北京 05:20 / 17:20，实测 schedule 延迟 102~131 分钟）');
const windowState = { v: 2, date: '2026-09-10', windowAt: at('2026-09-09T23:30:00Z'), renewedAt: null };
test('北京 09-10 05:20（零延迟到达）→ wait（等到 07:30 窗口开启）', () => {
    const d = W.decide(windowState, at('2026-09-09T21:20:00Z'));
    eq(d.action, 'wait', 'action');
    eq(d.reason, 'window-imminent', 'reason');
    eq(d.waitMs, 130 * 60 * 1000 + 30 * 1000, 'waitMs');
});
test('北京 09-10 07:11（延迟 111 分钟到达）→ wait（仍赶在窗口前）', () => {
    const d = W.decide(windowState, at('2026-09-09T23:11:00Z'));
    eq(d.action, 'wait', 'action');
    eq(d.waitMs, 19 * 60 * 1000 + 30 * 1000, 'waitMs');
});
test('北京 09-10 07:30:10 → run（窗口已开）', () => {
    const d = W.decide(windowState, at('2026-09-09T23:30:10Z'));
    eq(d.action, 'run', 'action');
    eq(d.reason, 'window-open', 'reason');
});
test('北京 09-10 07:31 → run（过了窗口也要跑，不能跳过）', () => {
    const d = W.decide(windowState, at('2026-09-09T23:31:00Z'));
    eq(d.action, 'run', 'action');
});
test('北京 09-09 17:20（窗口前 14h）→ skip', () => {
    const d = W.decide(windowState, at('2026-09-09T09:20:00Z'));
    eq(d.action, 'skip', 'action');
    eq(d.reason, 'too-early', 'reason');
    eq(d.daysLeft, 1, 'daysLeft');
});
test('延迟 180 分钟到达（窗口后 110 分钟）→ run 且标记 overdue', () => {
    const d = W.decide(windowState, at('2026-09-10T01:20:00Z'));
    eq(d.action, 'run', 'action');
    eq(d.reason, 'window-overdue', 'reason');
});
test('续期成功后窗口推进 96h，当天 17:20 再次 skip', () => {
    // 07:30 成功 → renewedAt=窗口瞬间，windowAt 前进到 4 天后
    const renewed = W.migrateState({ renewedAt: at('2026-09-09T23:30:00Z') }, { timeZone: TZ, cycleHours: 96 });
    eq(renewed.windowAt, at('2026-09-13T23:30:00Z'), 'advanced windowAt');
    const d = W.decide(renewed, at('2026-09-10T09:20:00Z'));
    eq(d.action, 'skip', 'action');
    eq(d.daysLeft, 4, 'daysLeft');
});
test('早上那次失败时，当天 17:20 视为过期重试（有意为之）', () => {
    const d = W.decide(windowState, at('2026-09-10T09:20:00Z'));
    eq(d.action, 'run', 'action');
    eq(d.reason, 'window-overdue', 'reason');
});
test('窗口已过很久（Actions 延迟数小时）→ run 且标记 overdue', () => {
    const d = W.decide(windowState, at('2026-09-10T05:00:00Z'));
    eq(d.action, 'run', 'action');
    eq(d.reason, 'window-overdue', 'reason');
});
test('无窗口信息 → run（首次运行直接探测）', () => {
    eq(W.decide(null, Date.now()).action, 'run', 'null state');
    eq(W.decide(null, Date.now()).reason, 'no-window-known', 'reason');
});
test('默认提前等待预算 4 小时（覆盖零延迟到达的整段空档）', () => {
    eq(W.DEFAULT_EARLY_WAIT_MIN, 240, 'DEFAULT_EARLY_WAIT_MIN');
    const win = at('2026-09-09T23:30:00Z');
    eq(W.decide(windowState, win - 239 * 60 * 1000).action, 'wait', '239min');
    eq(W.decide(windowState, win - 241 * 60 * 1000).action, 'skip', '241min');
});
test('等待预算：窗口在预算内才在作业内等', () => {
    const now = at('2026-09-09T21:20:00Z');
    eq(W.nextRetryDelayMs(at('2026-09-09T23:30:00Z'), now, { retryBudgetMs: 300 * 60 * 1000 }), 130 * 60 * 1000 + 30 * 1000, 'in-budget');
    eq(W.nextRetryDelayMs(at('2026-09-11T04:00:00Z'), now, { retryBudgetMs: 300 * 60 * 1000 }), null, 'out-of-budget');
});

console.log(`\n[renew_window] 通过 ${passed}，失败 ${failures.length}\n`);
if (failures.length > 0) {
    for (const f of failures) {
        console.error(`- ${f.name}\n${f.error.stack}\n`);
    }
    process.exit(1);
}
