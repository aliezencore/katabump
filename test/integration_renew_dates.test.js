'use strict';

/**
 * 集成校验：用仓库里「真实的」renew_dates.json 走一遍新的窗口逻辑。
 * 目的：证明旧数据（裸日期字符串）能被正确迁移，并且四个 cron 时刻的决策符合预期。
 * 零依赖：node test/integration_renew_dates.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/renew_window');

const SITE_TZ = 'Asia/Shanghai';
const CYCLE_HOURS = 96;
const ANCHOR = '07:30';
const EARLY_WAIT_MIN = 25;

const file = path.join(__dirname, '..', 'renew_dates.json');
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const keys = Object.keys(raw);

console.log(`\n[integration] 读取真实 ${path.basename(file)}：${keys.length} 个条目\n`);

let failed = 0;
function check(label, fn) {
    try {
        fn();
        console.log(`  ok   ${label}`);
    } catch (e) {
        failed++;
        console.log(`  FAIL ${label}\n       ${e.message}`);
    }
}

check('条目均为非空', () => {
    assert.ok(keys.length > 0, 'renew_dates.json 不应为空');
    for (const k of keys) assert.ok(raw[k], `空值条目: ${k}`);
});

// 迁移：旧字符串 → 状态对象，且窗口时刻必须落在站点时区的 07:30
const migrated = {};
for (const k of keys) {
    const state = W.migrateState(raw[k], {
        timeZone: SITE_TZ,
        nowMs: Date.parse('2026-09-01T00:00:00Z'),
        cycleHours: CYCLE_HOURS,
        anchorTimeOfDay: ANCHOR
    });
    migrated[k] = state;

    check(`迁移 ${k}: ${JSON.stringify(raw[k])} → 窗口 ${state ? W.formatInTz(state.windowAt, SITE_TZ) : 'null'} (${SITE_TZ})`, () => {
        assert.ok(state, '迁移结果不应为 null');
        assert.strictEqual(state.v, 2, '版本应为 2');
        const p = W.partsInTz(state.windowAt, SITE_TZ);
        assert.strictEqual(p.hour, 7, `窗口小时应为站点时区 07，实际 ${p.hour}`);
        assert.strictEqual(p.minute, 30, `窗口分钟应为 30，实际 ${p.minute}`);
        // 关键回归：绝不能退化成裸日期的 UTC 零点
        const utcMidnight = Date.parse(`${state.date}T00:00:00Z`);
        assert.notStrictEqual(state.windowAt, utcMidnight, '窗口不应等于裸日期的 UTC 零点（原缺陷）');
        assert.strictEqual(state.windowAt, utcMidnight - 30 * 60 * 1000, '窗口应为该日期站点时区 07:30 = UTC 前一日 23:30');
    });
}

// 四个 cron 时刻的决策表（以第一个条目为样本）
const sampleKey = keys[0];
const state = migrated[sampleKey];
if (state) {
    const day = W.partsInTz(state.windowAt, SITE_TZ);
    const pad = (n) => String(n).padStart(2, '0');
    const dateStr = `${day.year}-${pad(day.month)}-${pad(day.day)}`;
    const instants = [
        { label: `前一日 19:20 (北京)`, iso: new Date(state.windowAt - 12 * 3600 * 1000).toISOString(), expect: 'skip' },
        { label: `窗口当日 07:20 (北京)`, iso: new Date(state.windowAt - 10 * 60 * 1000).toISOString(), expect: 'wait' },
        { label: `窗口当日 07:30:30 (北京)`, iso: new Date(state.windowAt + 30 * 1000).toISOString(), expect: 'run' },
        { label: `窗口当日 19:20 (北京)`, iso: new Date(state.windowAt + 12 * 3600 * 1000).toISOString(), expect: 'run' }
    ];

    console.log(`\n[integration] 决策表（样本 ${sampleKey}，窗口 ${dateStr} 07:30 ${SITE_TZ}）`);
    for (const it of instants) {
        const nowMs = Date.parse(it.iso);
        const d = W.decide(state, nowMs, { earlyWaitMin: EARLY_WAIT_MIN });
        const at = W.formatInTz(nowMs, SITE_TZ);
        console.log(`  ${d.action.padEnd(4)} | 运行时刻 ${at} (${it.label}) | reason=${d.reason}`);
        check(`决策 ${it.label} → ${it.expect}`, () => {
            assert.strictEqual(d.action, it.expect, `期望 ${it.expect}，实际 ${d.action}`);
        });
    }

    // 续期成功后窗口推进 96h，当天晚些的 cron 应重新变为 skip
    check('续期成功后窗口推进 96h，当晚 19:20 变回 skip', () => {
        const afterRenew = W.migrateState(
            { renewedAt: state.windowAt, cycleHours: CYCLE_HOURS },
            { timeZone: SITE_TZ, cycleHours: CYCLE_HOURS }
        );
        assert.strictEqual(afterRenew.windowAt, state.windowAt + 96 * 3600 * 1000, '窗口应推进 96h');
        const d = W.decide(afterRenew, state.windowAt + 12 * 3600 * 1000, { earlyWaitMin: EARLY_WAIT_MIN });
        assert.strictEqual(d.action, 'skip', `期望 skip，实际 ${d.action}`);
    });
}

// 写回格式校验：脚本写入的必须是合法 JSON 且能被再次读回
check('状态对象 JSON 往返无损', () => {
    const roundTrip = JSON.parse(JSON.stringify(migrated));
    for (const k of keys) {
        const back = W.migrateState(roundTrip[k], { timeZone: SITE_TZ, cycleHours: CYCLE_HOURS });
        assert.strictEqual(back.windowAt, migrated[k].windowAt, `${k} 往返后 windowAt 变化`);
    }
});

console.log(`\n[integration] 失败 ${failed}\n`);
if (failed > 0) process.exit(1);
