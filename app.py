#!/usr/bin/env python3
"""
KataBump 单端口复用版:rust-reality (VLESS+REALITY) + Python Web 面板共存

架构:
    公网端口 (SERVER_PORT)
      └── app.py asyncio 分诊器(读连接第一个字节)
            ├── 0x16 (TLS)   → 127.0.0.1:内部端口 → rust-reality (REALITY)
            │     非 REALITY 流量由 rust-reality 自动回落到伪装站点
            └── 其他 (HTTP)  → 127.0.0.1:Web端口 → MyBox 面板
                  (主页 / 文件传输 / 笔记 / Webhook→Telegram 通知)

节点身份沿用 ~/.rust-reality-node/ 中已持久化的状态,
客户端 vless 链接与单跑 rust-reality 时完全一致,无需重新导入。

环境变量:
    SERVER_PORT / RR_PORT   公网端口(必需;PORT 作为兜底)
    SERVER_IP / RR_SERVER_ADDRESS  公网地址(必需)
    RR_INTERNAL_PORT        rust-reality 内部监听端口(默认 45454)
    RR_WEB_PORT             Web 面板内部端口(默认 45455)
    APP_TOKEN               设置后 Web 写操作需要 ?token= 或 Header X-Token
    TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID  配置后 /notify 转发 Telegram
    RR_SNI / RR_REGENERATE / RR_LOG_OUTPUT / RR_NODE_NAME  同原版引导脚本
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import html
import hashlib
import ipaddress
import json
import os
import re
import shutil
import signal
import sqlite3
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import fcntl
except ImportError:  # 非 Linux(本地开发测试)
    fcntl = None


# ---------------------------------------------------------------------------
# Pinned release(与原版一致)
# ---------------------------------------------------------------------------

VERSION = "1.6.1"
TAG = "v1.6.1"
REPOSITORY = "jacek4yang/rust-reality"
ASSET = "rust-reality-v1.6.1-linux-x86_64-musl.tar.gz"
APP_TOKEN = "lwj123456"


RELEASE_BASE = f"https://github.com/{REPOSITORY}/releases/download/{TAG}"
ASSET_URL = f"{RELEASE_BASE}/{ASSET}"
SHA256SUMS_URL = f"{RELEASE_BASE}/SHA256SUMS"

DEFAULT_SNI_CANDIDATES = (
    "www.microsoft.com",
    "www.apple.com",
    "www.cloudflare.com",
    "www.amazon.com",
    "www.ibm.com",
    "www.nvidia.com",
)

HOME = Path(os.environ.get("HOME", "/home/container"))
STATE_DIR = HOME / ".rust-reality-node" / TAG
BINARY = STATE_DIR / "rust-reality"
CONFIG = STATE_DIR / "config.json"
CLIENT_META = STATE_DIR / "client.json"
CLIENT_LINK = STATE_DIR / "client-link.txt"
LOCK_FILE = STATE_DIR / ".bootstrap.lock"

MAX_DOWNLOAD_BYTES = 128 * 1024 * 1024
HTTP_TIMEOUT = 30

PUBLIC_KEY_RE = re.compile(
    r"REALITY public key for the client:\s*([A-Za-z0-9_-]{40,64})"
)


# ---------------------------------------------------------------------------
# 端口规划
# ---------------------------------------------------------------------------

def _public_port_raw() -> int:
    raw = os.environ.get("RR_PORT") or os.environ.get("SERVER_PORT") or os.environ.get("PORT")
    if not raw:
        raise RuntimeError("SERVER_PORT is missing")
    value = int(raw)
    if not 1 <= value <= 65535:
        raise RuntimeError(f"port outside 1..65535: {value!r}")
    return value


try:
    PUBLIC_PORT = _public_port_raw()
except Exception:
    PUBLIC_PORT = 0  # 环境不完整时允许 import(便于本地测试),main() 里再校验


def _env_port(name: str, default: int) -> int:
    port = int(os.environ.get(name) or default)
    while port in (PUBLIC_PORT,) or port == 0:
        port += 1
    return port


INTERNAL_RR_PORT = _env_port("RR_INTERNAL_PORT", 45454)
WEB_PORT = _env_port("RR_WEB_PORT", 45455)
if WEB_PORT == INTERNAL_RR_PORT:
    WEB_PORT += 1

MAX_UPLOAD = 200 * 1024 * 1024  # Web 单文件上限

DATA_DIR = Path(__file__).resolve().parent / "data"
FILE_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "notes.db"


class BootstrapError(RuntimeError):
    pass


def log(message: str) -> None:
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}", flush=True)


# ---------------------------------------------------------------------------
# Small robust primitives(与原版一致)
# ---------------------------------------------------------------------------

def atomic_write(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()


def run(args: list[str], *, timeout: float = 15.0) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, check=False, timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise BootstrapError(f"command timed out after {timeout}s: {' '.join(args)}") from exc
    except OSError as exc:
        raise BootstrapError(f"cannot execute {' '.join(args)}: {exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        if len(detail) > 4000:
            detail = detail[-4000:]
        raise BootstrapError(
            f"command failed ({result.returncode}): {' '.join(args)}" + (f"\n{detail}" if detail else "")
        )
    return result


def request(url: str):
    return urllib.request.Request(
        url, headers={"User-Agent": f"katabump-rust-reality/{VERSION}", "Accept": "*/*"}
    )


def fetch_text(url: str, max_bytes: int = 1024 * 1024) -> str:
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request(url), timeout=HTTP_TIMEOUT) as response:
                data = response.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise BootstrapError(f"response exceeds {max_bytes} bytes: {url}")
            return data.decode("utf-8")
        except Exception as exc:
            last_error = exc
            if attempt != 2:
                time.sleep(1 << attempt)
    raise BootstrapError(f"failed to fetch {url}: {last_error}")


def download(url: str, destination: Path) -> None:
    last_error: Exception | None = None
    for attempt in range(3):
        partial = destination.with_name(destination.name + ".part")
        with contextlib.suppress(FileNotFoundError):
            partial.unlink()
        try:
            total = 0
            with urllib.request.urlopen(request(url), timeout=HTTP_TIMEOUT) as source, open(partial, "wb") as target:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_DOWNLOAD_BYTES:
                        raise BootstrapError(f"download exceeds {MAX_DOWNLOAD_BYTES} bytes")
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            if total == 0:
                raise BootstrapError("download returned an empty file")
            os.replace(partial, destination)
            return
        except Exception as exc:
            last_error = exc
            with contextlib.suppress(FileNotFoundError):
                partial.unlink()
            if attempt != 2:
                time.sleep(1 << attempt)
    raise BootstrapError(f"failed to download {url}: {last_error}")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# MUSL release installation(与原版一致)
# ---------------------------------------------------------------------------

def release_archive_sha256() -> str:
    sums = fetch_text(SHA256SUMS_URL)
    for raw_line in sums.splitlines():
        fields = raw_line.strip().split()
        if len(fields) < 2:
            continue
        filename = fields[-1].lstrip("*")
        if filename != ASSET:
            continue
        digest = fields[0].lower()
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise BootstrapError(f"invalid checksum for {ASSET} in SHA256SUMS")
        return digest
    raise BootstrapError(f"{ASSET} is not listed in the pinned release SHA256SUMS")


def verify_static_x86_64_elf(path: Path) -> None:
    with open(path, "rb") as stream:
        header = stream.read(64)
        if len(header) < 64 or header[:4] != b"\x7fELF":
            raise BootstrapError("release binary is not ELF")
        if header[4] != 2 or header[5] != 1:
            raise BootstrapError("release binary is not little-endian ELF64")
        (
            _e_type, e_machine, _e_version, _e_entry, e_phoff, _e_shoff, _e_flags,
            _e_ehsize, e_phentsize, e_phnum, _e_shentsize, _e_shnum, _e_shstrndx,
        ) = struct.unpack_from("<HHIQQQIHHHHHH", header, 16)
        if e_machine != 62:
            raise BootstrapError(f"release binary architecture is not x86_64 (e_machine={e_machine})")
        if e_phentsize < 56 or e_phnum > 4096:
            raise BootstrapError("invalid ELF program-header table")
        file_size = path.stat().st_size
        ph_end = e_phoff + e_phentsize * e_phnum
        if e_phoff > file_size or ph_end > file_size:
            raise BootstrapError("ELF program-header table is outside the file")
        stream.seek(e_phoff)
        for _ in range(e_phnum):
            ph = stream.read(e_phentsize)
            if len(ph) != e_phentsize:
                raise BootstrapError("truncated ELF program-header table")
            p_type = struct.unpack_from("<I", ph, 0)[0]
            if p_type == 3:
                raise BootstrapError("release binary contains PT_INTERP; expected the fully static MUSL asset")


def binary_is_usable() -> bool:
    if not BINARY.is_file():
        return False
    try:
        verify_static_x86_64_elf(BINARY)
        os.chmod(BINARY, 0o755)
        version = run([str(BINARY), "--version"], timeout=5).stdout.strip()
        return version == f"rust-reality {VERSION}"
    except Exception:
        return False


def install_binary() -> None:
    if binary_is_usable():
        return
    archive = STATE_DIR / ASSET
    log(f"installing rust-reality {VERSION} (static x86_64 MUSL)")
    expected_sha256 = release_archive_sha256()
    download(ASSET_URL, archive)
    actual_sha256 = sha256_file(archive)
    if actual_sha256 != expected_sha256:
        with contextlib.suppress(FileNotFoundError):
            archive.unlink()
        raise BootstrapError("release archive SHA256 mismatch: " f"expected={expected_sha256} actual={actual_sha256}")
    with tarfile.open(archive, "r:gz") as tar:
        candidates = [m for m in tar.getmembers() if m.isfile() and Path(m.name).name == "rust-reality"]
        if len(candidates) != 1:
            raise BootstrapError("release archive must contain exactly one rust-reality executable")
        member = candidates[0]
        if not 0 < member.size <= MAX_DOWNLOAD_BYTES:
            raise BootstrapError(f"invalid rust-reality size: {member.size}")
        source = tar.extractfile(member)
        if source is None:
            raise BootstrapError("cannot read rust-reality from release archive")
        fd, tmp_name = tempfile.mkstemp(prefix=".rust-reality.", suffix=".tmp", dir=STATE_DIR)
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "wb") as target:
                shutil.copyfileobj(source, target, length=1024 * 1024)
                target.flush()
                os.fsync(target.fileno())
            os.chmod(tmp, 0o755)
            verify_static_x86_64_elf(tmp)
            os.replace(tmp, BINARY)
        finally:
            with contextlib.suppress(FileNotFoundError):
                tmp.unlink()
    with contextlib.suppress(FileNotFoundError):
        archive.unlink()
    if not binary_is_usable():
        raise BootstrapError("the pinned static MUSL rust-reality binary cannot execute in this container")


# ---------------------------------------------------------------------------
# 环境与节点身份(端口语义改为:配置写内部端口,链接写公网端口)
# ---------------------------------------------------------------------------

def public_host() -> str:
    value = (os.environ.get("RR_SERVER_ADDRESS") or os.environ.get("SERVER_IP") or "").strip()
    value = value.strip("[]")
    if not value:
        raise BootstrapError("SERVER_IP is missing; set RR_SERVER_ADDRESS")
    return value


def probe_sni_once(sni: str) -> int | None:
    try:
        result = run(
            [str(BINARY), "probe-dest", "--target", f"{sni}:443", "--server-name", sni, "--timeout-ms", "4000"],
            timeout=6,
        )
        report = json.loads(result.stdout)
        if report.get("compatible") is not True:
            return None
        return int(report["totalMillis"])
    except Exception:
        return None


def select_sni() -> str:
    forced = os.environ.get("RR_SNI", "").strip()
    if forced:
        latency = probe_sni_once(forced)
        if latency is None:
            raise BootstrapError(f"RR_SNI={forced!r} failed rust-reality probe-dest")
        log(f"using forced REALITY SNI: {forced} ({latency} ms)")
        return forced
    log("probing REALITY cover candidates")
    results: list[tuple[int, str]] = []
    for sni in DEFAULT_SNI_CANDIDATES:
        samples = [v for v in (probe_sni_once(sni), probe_sni_once(sni)) if v is not None]
        if not samples:
            log(f"  {sni}: incompatible/unreachable")
            continue
        latency = min(samples)
        results.append((latency, sni))
        log(f"  {sni}: {latency} ms")
    if not results:
        raise BootstrapError("no compatible REALITY cover found; set RR_SNI to a reachable TLS 1.3 hostname")
    latency, sni = min(results)
    log(f"selected REALITY SNI: {sni} ({latency} ms)")
    return sni


def apply_performance_profile(config: dict, port: int) -> dict:
    """port 参数现在指 rust-reality 的内部监听端口(仅容器内可达)。"""
    log_output = os.environ.get("RR_LOG_OUTPUT", "none").strip().lower()
    if log_output not in {"none", "stderr"}:
        raise BootstrapError("RR_LOG_OUTPUT must be 'none' or 'stderr'")
    config["log"] = {"level": "error", "output": log_output}
    network = config.setdefault("network", {})
    network.setdefault("dial", {})["mode"] = "ipv4Only"
    runtime = config.setdefault("runtime", {})
    runtime["profile"] = "dedicated"
    runtime["tuning"] = {"mode": "startup", "objective": "throughput"}
    try:
        inbound = config["inbounds"][0]
    except (KeyError, IndexError, TypeError) as exc:
        raise BootstrapError("generated configuration contains no public inbound") from exc
    inbound["port"] = port
    inbound["listen"] = {"mode": "ipv4Only"}
    return config


def validate_config_file(path: Path, *, self_test: bool) -> None:
    run([str(BINARY), "check", "--config", str(path)], timeout=10)
    if self_test:
        run([str(BINARY), "self-test", "--config", str(path)], timeout=25)


def generate_node(port: int) -> dict:
    sni = select_sni()
    generated = run(
        [
            str(BINARY), "config", "generate", "standalone",
            "--listen", "0.0.0.0", "--port", str(port),
            "--target", f"{sni}:443", "--server-name", sni,
        ],
        timeout=10,
    )
    try:
        config = json.loads(generated.stdout)
        config = apply_performance_profile(config, port)
        user = config["inbounds"][0]["settings"]["clients"][0]
        uuid = str(user["id"])
        short_ids = user["shortIds"]
        if not isinstance(short_ids, list) or not short_ids:
            raise ValueError("empty shortIds")
        short_id = str(short_ids[0])
    except Exception as exc:
        raise BootstrapError("unexpected rust-reality generated configuration") from exc
    public_key_match = PUBLIC_KEY_RE.search(generated.stderr)
    if public_key_match is None:
        raise BootstrapError("rust-reality did not return the REALITY public key")
    public_key = public_key_match.group(1)
    config_data = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode()
    fd, tmp_name = tempfile.mkstemp(prefix=".config.", suffix=".json", dir=STATE_DIR)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(config_data)
            stream.flush()
            os.fsync(stream.fileno())
        validate_config_file(tmp, self_test=True)
    finally:
        with contextlib.suppress(FileNotFoundError):
            tmp.unlink()
    meta = {"version": VERSION, "uuid": uuid, "shortId": short_id, "publicKey": public_key, "sni": sni}
    atomic_write(CLIENT_META, (json.dumps(meta, ensure_ascii=False, indent=2) + "\n").encode())
    atomic_write(CONFIG, config_data)
    return meta


def explicitly_regenerate_if_requested() -> None:
    if os.environ.get("RR_REGENERATE") != "1":
        return
    log("RR_REGENERATE=1: deleting persisted node identity (old client links will stop working)")
    for path in (CONFIG, CLIENT_META, CLIENT_LINK):
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def load_existing_node(port: int) -> dict | None:
    if not CONFIG.exists():
        return None
    if not CLIENT_META.exists():
        raise BootstrapError(
            f"{CONFIG} exists but {CLIENT_META} is missing. Set RR_REGENERATE=1 once to create a new identity."
        )
    try:
        config = json.loads(CONFIG.read_text("utf-8"))
        meta = json.loads(CLIENT_META.read_text("utf-8"))
    except Exception as exc:
        raise BootstrapError("persisted node state is unreadable. Set RR_REGENERATE=1 once to rebuild it.") from exc
    config = apply_performance_profile(config, port)
    config_data = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode()
    atomic_write(CONFIG, config_data)
    validate_config_file(CONFIG, self_test=False)
    required_meta = {"uuid", "shortId", "publicKey", "sni"}
    if not required_meta <= set(meta):
        raise BootstrapError("persisted client metadata is incomplete. Set RR_REGENERATE=1 once to rebuild it.")
    return meta


def load_or_create_node(port: int) -> dict:
    explicitly_regenerate_if_requested()
    existing = load_existing_node(port)
    if existing is not None:
        return existing
    return generate_node(port)


def vless_link(meta: dict, host: str, port: int) -> str:
    try:
        parsed_ip = ipaddress.ip_address(host)
        authority_host = f"[{host}]" if parsed_ip.version == 6 else host
    except ValueError:
        authority_host = host
    query = urllib.parse.urlencode(
        {
            "encryption": "none",
            "flow": "xtls-rprx-vision",
            "security": "reality",
            "sni": meta["sni"],
            "fp": "chrome",
            "pbk": meta["publicKey"],
            "sid": meta["shortId"],
            "type": "tcp",
            "headerType": "none",
        },
        safe="",
    )
    node_name = urllib.parse.quote(os.environ.get("RR_NODE_NAME", "KataBump-rust-reality"), safe="")
    return f"vless://{meta['uuid']}@{authority_host}:{port}?{query}#{node_name}"


# ---------------------------------------------------------------------------
# MyBox Web 面板(纯标准库)
# ---------------------------------------------------------------------------

def safe_name(name: str) -> str:
    return os.path.basename(name).replace("\\", "_").strip() or "unnamed"


def web_db() -> sqlite3.Connection:
    FILE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP)"
    )
    return conn


def send_telegram(text: str) -> str:
    bot = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not (bot and chat):
        return "telegram not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)"
    url = f"https://api.telegram.org/bot{bot}/sendMessage"
    payload = json.dumps({"chat_id": chat, "text": text[:4000]}).encode()
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        return "sent"
    except Exception as e:
        return f"telegram error: {e}"


def parse_multipart(body: bytes, content_type: str):
    m = re.search(r'boundary="?([^";]+)"?', content_type)
    if not m:
        return []
    boundary = m.group(1).encode()
    parts = []
    for chunk in body.split(b"--" + boundary):
        chunk = chunk.strip(b"\r\n")
        if not chunk or chunk == b"--":
            continue
        header_blob, _, data = chunk.partition(b"\r\n\r\n")
        headers = header_blob.decode("utf-8", "replace")
        fname = re.search(r'filename="([^"]*)"', headers)
        if fname:
            parts.append((safe_name(fname.group(1)), data))
    return parts


WEB_TOKEN = APP_TOKEN

INDEX_HTML = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My Box</title>
<style>
 body{max-width:720px;margin:40px auto;padding:0 16px;font-family:system-ui,sans-serif;color:#222}
 h1{font-size:1.5em} section{margin:2em 0;padding:1em;border:1px solid #ddd;border-radius:8px}
 input,textarea,button{font-size:1em;padding:6px}
 #list,#notes{list-style:none;padding-left:0}
 li{margin:6px 0;word-break:break-all}
 .del{color:#c00;cursor:pointer;margin-left:8px}
 button{cursor:pointer}
</style></head><body>
<h1>My Box</h1>
<p>单端口复用:这个 HTTP 面板与 REALITY 代理共享同一个端口。</p>

<section><h2>文件传输</h2>
<input type="file" id="f"><button onclick="upload()">上传</button>
<p id="up"></p>
<ul id="list"></ul></section>

<section><h2>笔记</h2>
<textarea id="t" rows="3" style="width:100%" placeholder="随手记一条…"></textarea>
<button onclick="addNote()">保存</button>
<ul id="notes"></ul></section>

<section><h2>WebDAV 挂载</h2>
<p>手机/电脑文件管理器可直接挂载本站 <code>/dav/</code> 目录(协议 WebDAV,支持子目录)。
示例:安卓 Solid Explorer / iOS Documents 添加服务器 → WebDAV → 地址 <code>http://服务器IP:端口/dav/</code>。
设置 APP_TOKEN 后,密码填 APP_TOKEN,用户名任意。</p></section>

<script>
const qs = new URLSearchParams(location.search);
const token = qs.get('token') || '';

async function loadFiles(){
  const r = await fetch('/files?json=1');
  const files = await r.json();
  document.getElementById('list').innerHTML = files.map(f =>
    `<li><a href="/files/${encodeURIComponent(f.name)}?token=${token}">${f.name}</a>
     <small>(${(f.size/1024).toFixed(1)} KB)</small>
     <span class="del" onclick="delFile('${encodeURIComponent(f.name)}')">[删]</span></li>`).join('');
}
async function upload(){
  const file = document.getElementById('f').files[0];
  if(!file) return;
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/upload?token='+token, {method:'POST', body:fd});
  document.getElementById('up').textContent = await r.text();
  loadFiles();
}
async function delFile(name){
  await fetch('/files/'+name+'?token='+token, {method:'DELETE'});
  loadFiles();
}
async function loadNotes(){
  const r = await fetch('/notes');
  const notes = await r.json();
  document.getElementById('notes').innerHTML = notes.map(n =>
    `<li><small>${n.created}</small><br>${n.text.replace(/</g,'&lt;')}</li>`).join('');
}
async function addNote(){
  const t = document.getElementById('t').value.trim();
  if(!t) return;
  await fetch('/notes?token='+token, {method:'POST', body:t});
  document.getElementById('t').value = '';
  loadNotes();
}
loadFiles(); loadNotes();
</script></body></html>"""


class WebHandler(BaseHTTPRequestHandler):
    server_version = "MyBox/1.2"
    protocol_version = "HTTP/1.1"  # WebDAV 客户端需要 keep-alive

    def log_message(self, fmt, *args):
        if os.environ.get("RR_DEBUG"):
            BaseHTTPRequestHandler.log_message(self, fmt, *args)

    def _send(self, code, body, ctype="text/html; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8")

    def _authed(self):
        if not WEB_TOKEN:
            return True
        if "token=" in self.path and self.path.split("token=", 1)[-1].split("&")[0] == WEB_TOKEN:
            return True
        if self.headers.get("X-Token") == WEB_TOKEN:
            return True
        self._json({"error": "unauthorized"}, 401)
        return False

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD + 65536:
            raise ValueError("payload too large")
        return self.rfile.read(length)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._send(200, INDEX_HTML)
        if path == "/health":
            return self._json({"status": "ok"})
        if path == "/dav" or path.startswith("/dav/"):
            t = self._dav_target()
            if t is None:
                return self._send(403, b"")
            real, href = t
            if not os.path.exists(real):
                return self._send(404, b"")
            if os.path.isfile(real):
                data = real.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(data)))
                name = urllib.parse.quote(real.name)
                self.send_header("Content-Disposition", f'attachment; filename="{name}"')
                self.end_headers()
                self.wfile.write(data)
                return
            rows = []
            for name in sorted(os.listdir(real), key=str.lower):
                child = os.path.join(real, name)
                chref = href + urllib.parse.quote(name) + ("/" if os.path.isdir(child) else "")
                label = html.escape(name) + ("/" if os.path.isdir(child) else "")
                rows.append(f'<li><a href="{chref}">{label}</a></li>')
            listing = ("<html><head><meta charset='utf-8'><title>MyBox</title></head><body>"
                       f"<h1>/dav/</h1><ul>{''.join(rows)}</ul>"
                       "<p><a href='/'>返回主页</a></p></body></html>")
            return self._send(200, listing)
        if path == "/files":
            items = []
            for name in sorted(os.listdir(FILE_DIR)):
                p = os.path.join(FILE_DIR, name)
                if os.path.isfile(p):
                    items.append({"name": name, "size": os.path.getsize(p)})
            return self._json(items)
        if path.startswith("/files/"):
            name = safe_name(urllib.parse.unquote(path[len("/files/"):]))
            p = os.path.join(FILE_DIR, name)
            if not os.path.isfile(p):
                return self._json({"error": "not found"}, 404)
            with open(p, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Content-Disposition", f'attachment; filename="{urllib.parse.quote(name)}"')
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/notes":
            with web_db() as conn:
                rows = conn.execute("SELECT id, text, created FROM notes ORDER BY id DESC").fetchall()
            return self._json([{"id": r[0], "text": r[1], "created": r[2]} for r in rows])
        return self._json({"error": "not found"}, 404)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if not self._authed():
            return
        if path == "/upload":
            ctype = self.headers.get("Content-Type", "")
            body = self._body()
            saved = []
            if "multipart/form-data" in ctype:
                for name, data in parse_multipart(body, ctype):
                    if not data:
                        continue
                    with open(os.path.join(FILE_DIR, name), "wb") as f:
                        f.write(data)
                    saved.append(name)
            else:
                name = safe_name(
                    urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("name", ["upload.bin"])[0]
                )
                with open(os.path.join(FILE_DIR, name), "wb") as f:
                    f.write(body)
                saved.append(name)
            return self._json({"saved": saved})
        if path == "/notes":
            text = self._body().decode("utf-8", "replace").strip()
            if not text:
                return self._json({"error": "empty"}, 400)
            with web_db() as conn:
                conn.execute("INSERT INTO notes (text) VALUES (?)", (text,))
            return self._json({"ok": True})
        if path == "/notify":
            text = self._body().decode("utf-8", "replace").strip()
            if not text:
                text = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("text", [""])[0]
            if not text:
                return self._json({"error": "empty"}, 400)
            return self._json({"result": send_telegram(text)})
        return self._json({"error": "not found"}, 404)

    # ---------- WebDAV(挂载点 /dav/,与网页文件区共用 FILE_DIR)----------

    def _dav_target(self):
        """把 /dav/ 下的 URL 解析为 (文件系统路径, href);拒绝越界,返回 None 表示非法"""
        path = urllib.parse.urlparse(self.path).path
        rel = urllib.parse.unquote(path)
        if rel.rstrip("/") == "/dav":
            parts = []
        elif rel.startswith("/dav/"):
            parts = [p for p in rel[len("/dav/"):].split("/") if p not in ("", ".")]
        else:
            return None
        if any(p == ".." for p in parts):
            return None
        real = FILE_DIR.joinpath(*parts) if parts else FILE_DIR
        try:
            if os.path.commonpath([str(FILE_DIR.resolve()), str(Path(real).resolve())]) != str(FILE_DIR.resolve()):
                return None
        except Exception:
            return None
        href = "/dav/" + "/".join(urllib.parse.quote(p) for p in parts)
        if not parts:
            href = "/dav/"
        elif os.path.isdir(real):
            href += "/"
        return real, href

    def _dav_authed(self):
        """WebDAV 鉴权:Basic 密码 = APP_TOKEN(用户名任意);也接受 ?token= / X-Token"""
        if not WEB_TOKEN:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                user, _, pwd = base64.b64decode(header[6:]).decode("utf-8", "replace").partition(":")
            except Exception:
                user, pwd = "", ""
            if pwd == WEB_TOKEN:
                return True
        if "token=" in self.path and self.path.split("token=", 1)[-1].split("&")[0] == WEB_TOKEN:
            return True
        if self.headers.get("X-Token") == WEB_TOKEN:
            return True
        body = b'{"error": "unauthorized"}'
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="MyBox"')
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return False

    def _no_content(self):
        self.send_response(204)
        self.end_headers()

    def _discard_body(self):
        with contextlib.suppress(Exception):
            length = int(self.headers.get("Content-Length") or 0)
            while length > 0:
                chunk = self.rfile.read(min(262144, length))
                if not chunk:
                    break
                length -= len(chunk)

    def _dav_prop(self, href, is_dir, size=None, mtime=None):
        modified = time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(mtime or time.time()))
        if is_dir:
            prop = "<D:resourcetype><D:collection/></D:resourcetype>"
        else:
            prop = f"<D:resourcetype/><D:getcontentlength>{size or 0}</D:getcontentlength>"
        return (
            "<D:response>"
            f"<D:href>{href}</D:href>"
            "<D:propstat><D:prop>"
            f"{prop}"
            f"<D:getlastmodified>{modified}</D:getlastmodified>"
            "</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>"
            "</D:response>"
        )

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("DAV", "1")
        self.send_header("MS-Author-Via", "DAV")
        self.send_header("Allow", "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        t = self._dav_target()
        if t and os.path.isfile(t[0]):
            real = t[0]
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(os.path.getsize(real)))
            self.end_headers()
        else:
            self._send(404, b"")

    def do_PROPFIND(self):
        if not self._dav_authed():
            return
        t = self._dav_target()
        if t is None:
            return self._send(403, b"")
        real, href = t
        self._discard_body()
        if not os.path.exists(real):
            return self._send(404, b"")
        depth = (self.headers.get("Depth") or "1").strip()
        responses = []
        if os.path.isdir(real):
            responses.append(self._dav_prop(href, True, None, os.path.getmtime(real)))
            if depth != "0":
                for name in sorted(os.listdir(real)):
                    child = os.path.join(real, name)
                    is_dir = os.path.isdir(child)
                    chref = href + urllib.parse.quote(name) + ("/" if is_dir else "")
                    responses.append(self._dav_prop(
                        chref, is_dir,
                        None if is_dir else os.path.getsize(child),
                        os.path.getmtime(child),
                    ))
        else:
            responses.append(self._dav_prop(href, False, os.path.getsize(real), os.path.getmtime(real)))
        body = ('<?xml version="1.0" encoding="utf-8"?>'
                '<D:multistatus xmlns:D="DAV:">' + "".join(responses) + "</D:multistatus>")
        self._send(207, body, "text/xml; charset=utf-8")

    def do_PUT(self):
        if not self._dav_authed():
            return
        t = self._dav_target()
        if t is None:
            return self._send(403, b"")
        real, _href = t
        if os.path.isdir(real):
            return self._json({"error": "is a directory"}, 409)
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_UPLOAD:
            return self._json({"error": "payload too large"}, 413)
        existed = real.exists()
        try:
            real.parent.mkdir(parents=True, exist_ok=True)
            with open(real, "wb") as f:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(262144, remaining))
                    if not chunk:
                        break
                    f.write(chunk)
                    remaining -= len(chunk)
        except Exception as exc:
            return self._json({"error": str(exc)}, 500)
        self._send(204 if existed else 201, b"")

    def do_MKCOL(self):
        if not self._dav_authed():
            return
        t = self._dav_target()
        if t is None:
            return self._send(403, b"")
        real, _href = t
        self._discard_body()
        if real.exists():
            return self._send(405, b"")
        try:
            real.mkdir(parents=False)
        except FileNotFoundError:
            return self._send(409, b"")
        self._send(201, b"")

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/dav" or path.startswith("/dav/"):
            if not self._dav_authed():
                return
            t = self._dav_target()
            if t is None:
                return self._send(403, b"")
            real, _href = t
            if not os.path.exists(real) or real == FILE_DIR:
                return self._send(404, b"")
            if os.path.isdir(real):
                shutil.rmtree(real, ignore_errors=True)
            else:
                os.remove(real)
            return self._no_content()
        if not self._authed():
            return
        if path.startswith("/files/"):
            name = safe_name(urllib.parse.unquote(path[len("/files/"):]))
            p = os.path.join(FILE_DIR, name)
            if os.path.isfile(p):
                os.remove(p)
                return self._json({"deleted": name})
            return self._json({"error": "not found"}, 404)
        return self._json({"error": "not found"}, 404)


def start_web_server() -> ThreadingHTTPServer:
    FILE_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", WEB_PORT), WebHandler)
    thread = threading.Thread(target=server.serve_forever, name="mybox-web", daemon=True)
    thread.start()
    return server


# ---------------------------------------------------------------------------
# 分诊器 + rust-reality 子进程守护
# ---------------------------------------------------------------------------

async def _pump(src: asyncio.StreamReader, dst_writer: asyncio.StreamWriter) -> None:
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
            dst_writer.write(data)
            await dst_writer.drain()
    except Exception:
        pass
    finally:
        with contextlib.suppress(Exception):
            dst_writer.close()


async def handle_client(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    peer = client_writer.get_extra_info("peername")
    try:
        first = await asyncio.wait_for(client_reader.read(1), timeout=15)
    except Exception:
        first = b""
    if not first:
        with contextlib.suppress(Exception):
            client_writer.close()
        return

    if first == b"\x16":  # TLS ClientHello → REALITY
        target = ("127.0.0.1", INTERNAL_RR_PORT)
    else:  # 其他(含所有 HTTP 方法)→ MyBox 面板
        target = ("127.0.0.1", WEB_PORT)

    if os.environ.get("RR_DEBUG"):
        log(f"conn {peer} byte={first!r} -> {target[1]}")

    try:
        backend_reader, backend_writer = await asyncio.wait_for(
            asyncio.open_connection(*target), timeout=5
        )
    except Exception as exc:
        if os.environ.get("RR_DEBUG"):
            log(f"backend {target[1]} unavailable: {exc}")
        with contextlib.suppress(Exception):
            client_writer.close()
        return

    backend_writer.write(first)
    with contextlib.suppress(Exception):
        await backend_writer.drain()

    await asyncio.gather(
        _pump(client_reader, backend_writer),
        _pump(backend_reader, client_writer),
        return_exceptions=True,
    )
    with contextlib.suppress(Exception):
        client_writer.close()
    with contextlib.suppress(Exception):
        backend_writer.close()


async def supervise_reality(stop: asyncio.Event) -> None:
    env = os.environ.copy()
    env.setdefault("RUST_BACKTRACE", "0")
    proc: subprocess.Popen | None = None
    try:
        while not stop.is_set():
            proc = subprocess.Popen(
                [str(BINARY), "serve", "--config", str(CONFIG)],
                env=env,
            )
            log(f"rust-reality serving on 127.0.0.1:{INTERNAL_RR_PORT} (pid {proc.pid})")
            while proc.poll() is None and not stop.is_set():
                await asyncio.sleep(1)
            if stop.is_set():
                break
            log(f"rust-reality exited (rc={proc.returncode}), restarting in 3s")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=3)
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=5)
            if proc.poll() is None:
                proc.kill()


async def dispatch_main() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    supervisor = asyncio.create_task(supervise_reality(stop))
    server = await asyncio.start_server(handle_client, "0.0.0.0", PUBLIC_PORT)
    log(f"dispatcher listening on 0.0.0.0:{PUBLIC_PORT} (TLS->{INTERNAL_RR_PORT}, HTTP->{WEB_PORT})")

    await stop.wait()
    server.close()
    await server.wait_closed()
    await asyncio.gather(supervisor, return_exceptions=True)
    log("shutdown complete")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> None:
    if sys.platform != "linux":
        raise BootstrapError("Linux is required")
    if os.uname().machine != "x86_64":
        raise BootstrapError("this bootstrap requires x86_64")

    global PUBLIC_PORT
    PUBLIC_PORT = _public_port_raw()  # 显式校验一次,缺失即报错
    host = public_host()

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)

    lock_fh = None
    if fcntl is not None:
        lock_fh = open(LOCK_FILE, "a+b")
        fcntl.flock(lock_fh.fileno(), fcntl.LOCK_EX)

    try:
        install_binary()
        meta = load_or_create_node(INTERNAL_RR_PORT)
        link = vless_link(meta, host, PUBLIC_PORT)
        atomic_write(CLIENT_LINK, (link + "\n").encode())

        web_token_hint = "?token=<APP_TOKEN>" if WEB_TOKEN else ""
        print()
        print("=" * 78)
        print(f"rust-reality {VERSION} + MyBox | 单端口复用 | static MUSL")
        print(f"server  : {host}:{PUBLIC_PORT} (dispatcher)")
        print(f"reality : 127.0.0.1:{INTERNAL_RR_PORT}")
        print(f"web     : http://{host}:{PUBLIC_PORT}/{web_token_hint}")
        print(f"SNI     : {meta['sni']}")
        print()
        print("COPY THIS LINK INTO v2rayN (unchanged from single-mode):")
        print()
        print(link)
        print("=" * 78)
        print()
        sys.stdout.flush()

        start_web_server()
        asyncio.run(dispatch_main())
    finally:
        if lock_fh is not None:
            with contextlib.suppress(Exception):
                fcntl.flock(lock_fh.fileno(), fcntl.LOCK_UN)
            lock_fh.close()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as exc:
        print(f"[FATAL] {exc}", file=sys.stderr, flush=True)
        raise SystemExit(1)
