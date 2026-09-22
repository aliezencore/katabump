'use strict';

/**
 * 工作流静态校验：确认 cron、环境变量透传、行尾一致性都符合预期。
 * 用法：node test/check_workflow.js
 */

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.github', 'workflows', 'kata-renew.yml');
const yml = fs.readFileSync(file, 'utf8');
const problems = [];

function ok(label, cond, detail) {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`);
    if (!cond) problems.push(label);
}

console.log(`\n[workflow] 校验 ${path.basename(file)}\n`);

// 1. cron
const cron = (yml.match(/- cron:\s*['"]([^'"]+)['"]/) || [])[1];
ok('cron 为每 12 小时两次', cron === '20 23,11 * * *', `实际 ${cron}`);

// 2. 环境变量透传（直接按行匹配，避免正则转义问题）
const required = [
    'SITE_TZ',
    'RENEW_CYCLE_HOURS',
    'RENEW_ANCHOR_TIME',
    'RENEW_EARLY_WAIT_MIN',
    'RENEW_RETRY_BUDGET_MIN'
];
const lines = yml.split(/\r?\n/);
for (const name of required) {
    const line = lines.find((l) => l.trim().startsWith(name + ':'));
    ok(`${name} 已透传`, Boolean(line), line ? line.trim() : '缺失');
}

// 3. 仍在跑主脚本
ok('仍调用 node kata_renew.js', /node kata_renew\.js/.test(yml));

// 4. YAML 不允许 Tab 缩进
ok('无 Tab 缩进', !/\t/.test(yml));

// 5. 行尾一致性（GitHub 能处理 CRLF，但混用容易出怪问题）
const crlf = (yml.match(/\r\n/g) || []).length;
const lfOnly = (yml.match(/(?<!\r)\n/g) || []).length;
ok('行尾风格一致', crlf === 0 || lfOnly === 0, `CRLF=${crlf} 纯LF=${lfOnly}`);

// 6. debug 输入仍可用
ok('workflow_dispatch 保留 debug 输入', /debug:/.test(yml) && /inputs\.debug/.test(yml));

console.log(`\n[workflow] 失败 ${problems.length}\n`);
if (problems.length > 0) process.exit(1);
