'use strict';

/**
 * renew_window.js —— 续期窗口时间逻辑（零依赖，可单独测试）
 *
 * 解决的问题（原实现的两个叠加缺陷）：
 *   1. renew_dates.json 只存「日期」不存「时刻」，而跳过判断用 `new Date("2026-09-10")`，
 *      Node 会按 UTC 零点解析。runner 是 UTC、站点/用户在北京时间，于是
 *      「北京 09-10 07:20」那次运行看到的 now 还是 UTC 09-09 23:20，仍判「未到」→ 白等一天，
 *      真正执行时已经错过窗口。
 *   2. 窗口时刻应当锚定在「上一次续期成功的那一刻 + 周期(96h)」，而不是裸日期的零点。
 *
 * 本模块只做纯计算：不读环境、不发网络请求、不写文件。所有函数对入参显式求值，
 * 结果与 runner 自身的 TZ 无关（时区换算一律走 Intl 显式 timeZone）。
 */

const DEFAULT_SITE_TZ = 'Asia/Shanghai';
const DEFAULT_CYCLE_HOURS = 96;          // 站点每 4 天一次
const DEFAULT_ANCHOR_TIME = '07:30';     // 无 renewedAt 可用时，窗口默认开启时刻（站点时区）
const DEFAULT_EARLY_WAIT_MIN = 240;      // 距窗口 ≤4 小时时，在作业内等待而不是跳过
const DEFAULT_POST_WINDOW_GRACE_MS = 30 * 1000; // 窗口开启后再等 30 秒，确保站点已放行
const MS_PER_DAY = 24 * 3600 * 1000;

function num(value, fallback) {
    // 注意 Number(null)===0、Number('')===0，会把「缺失」误当成合法数值，必须显式挡掉
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// 时区换算（不依赖进程 TZ）
// ---------------------------------------------------------------------------

function tzFormatter(timeZone) {
    return new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** 某 UTC 瞬间在指定时区的字段值 */
function partsInTz(ms, timeZone = DEFAULT_SITE_TZ) {
    const parts = tzFormatter(timeZone).formatToParts(new Date(ms));
    const pick = (type) => {
        const found = parts.find((p) => p.type === type);
        return found ? Number(found.value) : NaN;
    };
    return {
        year: pick('year'),
        month: pick('month'),
        day: pick('day'),
        hour: pick('hour'),
        minute: pick('minute'),
        second: pick('second')
    };
}

/** 指定时区相对 UTC 的偏移（毫秒，东八区 = +8h） */
function tzOffsetMs(ms, timeZone = DEFAULT_SITE_TZ) {
    const p = partsInTz(ms, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    // formatToParts 只到秒，抹掉毫秒再比较
    return asUtc - Math.floor(ms / 1000) * 1000;
}

/** 把「某时区的墙上时间」换算成 epoch 毫秒（迭代两次以正确处理夏令时边界） */
function zonedToUtc(year, month, day, hour, minute, second = 0, timeZone = DEFAULT_SITE_TZ) {
    const naive = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = naive;
    for (let i = 0; i < 3; i++) {
        const offset = tzOffsetMs(guess, timeZone);
        const next = naive - offset;
        if (next === guess) break;
        guess = next;
    }
    return guess;
}

/** 解析 "HH:MM"，失败回落 07:30 */
function parseTimeOfDay(text, fallback = DEFAULT_ANCHOR_TIME) {
    const m = String(text || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return parseTimeOfDay(fallback, '07:30');
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return parseTimeOfDay(fallback, '07:30');
    return { hour: hh, minute: mm };
}

/** 人类可读（站点时区），仅用于日志与通知 */
function formatInTz(ms, timeZone = DEFAULT_SITE_TZ) {
    if (!Number.isFinite(ms)) return '未知';
    const p = partsInTz(ms, timeZone);
    const pad = (n) => String(n).padStart(2, '0');
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** 两个瞬间是否落在站点时区的同一天 */
function isSameSiteDay(msA, msB, timeZone = DEFAULT_SITE_TZ) {
    if (!Number.isFinite(msA) || !Number.isFinite(msB)) return false;
    const a = partsInTz(msA, timeZone);
    const b = partsInTz(msB, timeZone);
    return a.year === b.year && a.month === b.month && a.day === b.day;
}

// ---------------------------------------------------------------------------
// 日期/时长文本解析（站点提示可能是「日期」也可能是「还剩多久」）
// ---------------------------------------------------------------------------

const MONTHS = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
    september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

function monthFromName(name) {
    return MONTHS[String(name || '').toLowerCase()] || null;
}

/** 从文本里提取绝对日期（可选带时刻），返回 {year,month,day,hour,minute} 或 null */
function extractAbsoluteDate(text) {
    const raw = String(text || '');

    // 2026-09-10 / 2026-09-10 07:30
    let m = raw.match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) {
        return {
            year: Number(m[1]), month: Number(m[2]), day: Number(m[3]),
            hour: m[4] === undefined ? null : Number(m[4]),
            minute: m[5] === undefined ? null : Number(m[5])
        };
    }

    // 10 September 2026 / 10 Sep 2026 07:30，以及站点实际返回的「无年份」形式 25 September
    m = raw.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?(?:[ ,]+(\d{1,2}):(\d{2}))?/);
    if (m && monthFromName(m[2])) {
        return {
            year: m[3] === undefined ? null : Number(m[3]),
            month: monthFromName(m[2]), day: Number(m[1]),
            hour: m[4] === undefined ? null : Number(m[4]),
            minute: m[5] === undefined ? null : Number(m[5])
        };
    }

    // September 10, 2026 / Sep 10 2026 07:30，以及无年份的 September 10
    m = raw.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:[ ,]+(\d{1,2}):(\d{2}))?/);
    if (m && monthFromName(m[1])) {
        return {
            year: m[3] === undefined ? null : Number(m[3]),
            month: monthFromName(m[1]), day: Number(m[2]),
            hour: m[4] === undefined ? null : Number(m[4]),
            minute: m[5] === undefined ? null : Number(m[5])
        };
    }

    return null;
}

/** 无年份日期 → 推断年份：取站点时区中「下一个」该月日 */
function resolveYearForMonthDay(month, day, nowMs, timeZone, anchor) {
    const nowParts = partsInTz(nowMs, timeZone);
    let windowAt = zonedToUtc(nowParts.year, month, day, anchor.hour, anchor.minute, 0, timeZone);
    // 已过去超过一天 → 视为明年的同一天（站点提示总是未来日期）
    if (windowAt < nowMs - MS_PER_DAY) {
        windowAt = zonedToUtc(nowParts.year + 1, month, day, anchor.hour, anchor.minute, 0, timeZone);
    }
    return windowAt;
}

/** 解析 "in 3 days, 22 hours" 这类相对时长，返回毫秒或 null */
function parseRelativeDuration(text) {
    const raw = String(text || '');
    const re = /(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;
    let total = 0;
    let matched = false;
    let m;
    while ((m = re.exec(raw)) !== null) {
        matched = true;
        const value = Number(m[1]);
        const unit = m[2].toLowerCase();
        if (unit.startsWith('day')) total += value * MS_PER_DAY;
        else if (unit.startsWith('hour') || unit.startsWith('hr')) total += value * 3600 * 1000;
        else if (unit.startsWith('min')) total += value * 60 * 1000;
        else total += value * 1000;
    }
    if (!matched || total <= 0) return null;
    // 纯秒级/分钟级多半是无关文本（如 "in 30 seconds" 的重试提示），不当作窗口
    return total;
}

/**
 * 解析站点「暂不能续期」提示，得到窗口开启时刻。
 * @returns {{kind:'absolute'|'relative'|'none', windowAt:number|null, raw:string, dateText:string|null}}
 */
function parseWindowHint(text, options = {}) {
    const timeZone = options.timeZone || DEFAULT_SITE_TZ;
    const nowMs = num(options.nowMs, Date.now());
    const anchor = parseTimeOfDay(options.anchorTimeOfDay, DEFAULT_ANCHOR_TIME);
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return { kind: 'none', windowAt: null, raw, dateText: null };

    const abs = extractAbsoluteDate(raw);
    if (abs) {
        const hour = abs.hour === null ? anchor.hour : abs.hour;
        const minute = abs.minute === null ? anchor.minute : abs.minute;
        let year = abs.year;
        let windowAt;

        if (year === null) {
            // 站点常返回无年份形式（如 "25 September"），按站点时区推断到下一个该月日
            windowAt = resolveYearForMonthDay(abs.month, abs.day, nowMs, timeZone, { hour, minute });
            year = partsInTz(windowAt, timeZone).year;
        } else {
            windowAt = zonedToUtc(year, abs.month, abs.day, hour, minute, 0, timeZone);
            // 年份翻转：解析出的日期已过去半年以上，说明站点指的是下一年
            if (windowAt < nowMs - 180 * MS_PER_DAY) {
                year = year + 1;
                windowAt = zonedToUtc(year, abs.month, abs.day, hour, minute, 0, timeZone);
            }
        }

        const dateText = `${year}-${String(abs.month).padStart(2, '0')}-${String(abs.day).padStart(2, '0')}`;
        return { kind: 'absolute', windowAt, raw, dateText };
    }

    const rel = parseRelativeDuration(raw);
    if (rel !== null) {
        return { kind: 'relative', windowAt: nowMs + rel, raw, dateText: null };
    }

    return { kind: 'none', windowAt: null, raw, dateText: null };
}

// ---------------------------------------------------------------------------
// 状态：兼容旧的「裸日期字符串」条目
// ---------------------------------------------------------------------------

/** 上次成功续期 + 周期 = 下次窗口开启时刻 */
function computeWindowAt(renewedAtMs, cycleHours = DEFAULT_CYCLE_HOURS) {
    if (!Number.isFinite(renewedAtMs)) return null;
    return renewedAtMs + num(cycleHours, DEFAULT_CYCLE_HOURS) * 3600 * 1000;
}

/**
 * 把 renew_dates.json 里的任意条目迁移为状态对象。
 * 旧格式："2026-09-10"（站点提示的日期，按站点时区的 07:30 视为窗口开启）
 */
function migrateState(rawValue, options = {}) {
    const timeZone = options.timeZone || DEFAULT_SITE_TZ;
    const nowMs = num(options.nowMs, Date.now());
    const anchor = parseTimeOfDay(options.anchorTimeOfDay, DEFAULT_ANCHOR_TIME);
    const cycleHours = num(options.cycleHours, DEFAULT_CYCLE_HOURS);

    if (rawValue == null) return null;

    if (typeof rawValue === 'object') {
        const windowAt = num(rawValue.windowAt, NaN);
        const renewedAt = num(rawValue.renewedAt, NaN);
        const resolved = Number.isFinite(windowAt)
            ? windowAt
            : computeWindowAt(renewedAt, num(rawValue.cycleHours, cycleHours));
        if (!Number.isFinite(resolved)) return null;
        return {
            v: 2,
            date: rawValue.date || formatInTz(resolved, timeZone).slice(0, 10),
            windowAt: resolved,
            renewedAt: Number.isFinite(renewedAt) ? renewedAt : null,
            cycleHours: num(rawValue.cycleHours, cycleHours),
            skipNotifiedFor: num(rawValue.skipNotifiedFor, NaN) || null,
            lastCheckedAt: num(rawValue.lastCheckedAt, NaN) || null,
            raw: rawValue.raw || null
        };
    }

    const text = String(rawValue).trim();
    if (!text) return null;

    const hint = parseWindowHint(text, { timeZone, nowMs, anchorTimeOfDay: `${anchor.hour}:${String(anchor.minute).padStart(2, '0')}` });
    if (hint.windowAt === null) return null;
    return {
        v: 2,
        date: hint.dateText || text,
        windowAt: hint.windowAt,
        renewedAt: null,          // 旧数据不知道确切续期瞬间
        cycleHours,
        skipNotifiedFor: null,
        lastCheckedAt: null,
        raw: text
    };
}

// ---------------------------------------------------------------------------
// 决策
// ---------------------------------------------------------------------------

/**
 * 本次运行该做什么。
 * @returns {{action:'run'|'wait'|'skip', reason:string, windowAt?:number, waitMs?:number, daysLeft?:number}}
 */
function decide(state, nowMs, options = {}) {
    const earlyWaitMs = num(options.earlyWaitMin, DEFAULT_EARLY_WAIT_MIN) * 60 * 1000;
    const graceMs = num(options.graceMs, DEFAULT_POST_WINDOW_GRACE_MS);
    const now = num(nowMs, Date.now());

    if (!state || !Number.isFinite(state.windowAt)) {
        return { action: 'run', reason: 'no-window-known' };
    }

    const windowAt = state.windowAt;
    const delta = windowAt - now;

    if (delta <= 0) {
        return {
            action: 'run',
            reason: delta < -graceMs ? 'window-overdue' : 'window-open',
            windowAt,
            deltaMs: delta
        };
    }

    if (delta <= earlyWaitMs) {
        return { action: 'wait', reason: 'window-imminent', windowAt, deltaMs: delta, waitMs: delta + graceMs };
    }

    return {
        action: 'skip',
        reason: 'too-early',
        windowAt,
        deltaMs: delta,
        daysLeft: daysUntil(windowAt, now)
    };
}

/** 剩余天数（向上取整，按绝对时长而非日历天） */
function daysUntil(windowAt, nowMs) {
    if (!Number.isFinite(windowAt)) return null;
    return Math.max(0, Math.ceil((windowAt - num(nowMs, Date.now())) / MS_PER_DAY));
}

/** 同一次运行内，是否值得继续轮询等窗口（仅当窗口就在本次作业预算内开启） */
function nextRetryDelayMs(windowAt, nowMs, options = {}) {
    const budgetMs = num(options.retryBudgetMs, 20 * 60 * 1000);
    const intervalMs = num(options.retryIntervalMs, 3 * 60 * 1000);
    const graceMs = num(options.graceMs, DEFAULT_POST_WINDOW_GRACE_MS);
    if (!Number.isFinite(windowAt)) return null;
    const delta = windowAt - num(nowMs, Date.now());
    if (delta <= 0) return 0;
    if (delta > budgetMs) return null;
    return Math.min(delta + graceMs, budgetMs) || intervalMs;
}

module.exports = {
    DEFAULT_SITE_TZ,
    DEFAULT_CYCLE_HOURS,
    DEFAULT_ANCHOR_TIME,
    DEFAULT_EARLY_WAIT_MIN,
    DEFAULT_POST_WINDOW_GRACE_MS,
    MS_PER_DAY,
    partsInTz,
    tzOffsetMs,
    zonedToUtc,
    parseTimeOfDay,
    formatInTz,
    isSameSiteDay,
    extractAbsoluteDate,
    parseRelativeDuration,
    parseWindowHint,
    computeWindowAt,
    migrateState,
    decide,
    daysUntil,
    nextRetryDelayMs
};
