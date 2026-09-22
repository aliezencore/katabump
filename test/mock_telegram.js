'use strict';

/**
 * 本地 mock Telegram：记录脚本实际发出的通知，用于验证「同一窗口周期只通知一次」。
 * 用法：node test/mock_telegram.js <port> <outfile>
 */

const http = require('http');
const fs = require('fs');

const port = Number(process.argv[2] || 8799);
const outFile = process.argv[3] || 'tg_calls.json';
const calls = [];

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
        const isPhoto = req.url.includes('sendPhoto');
        let text = body;
        try {
            const parsed = JSON.parse(body);
            text = parsed.text || parsed.caption || body;
        } catch (e) { /* multipart，保留原文 */ }
        calls.push({ url: req.url, kind: isPhoto ? 'photo' : 'message', text });
        fs.writeFileSync(outFile, JSON.stringify(calls, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
    });
});

server.listen(port, '127.0.0.1', () => {
    console.log(`[mock-tg] listening on http://127.0.0.1:${port} -> ${outFile}`);
});
