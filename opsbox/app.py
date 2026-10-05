"""opsbox 运维工作台 = 文件管理 + 资源监控（filebrowser + resmon 合并版，端口 8002）。

文件 API：/api/list read save mkdir touch delete rename copy move upload
         download preview unarchive search
监控 API：/api/stats（后台 1s 采样线程：CPU/内存/网络/磁盘IO/Top进程/分区）
鉴权：同一密码登录，HMAC token（复用原 filebrowser .secret，旧 token 继续有效）。
"""
import hashlib
import hmac
import json
import mimetypes
import os
import platform
import re
import secrets
import shutil
import signal
import tarfile
import tempfile
import threading
import time
import zipfile
from collections import deque
from pathlib import Path

import psutil
from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _load_password() -> str:
    """口令不写入仓库：环境变量优先，其次共享的本地口令文件，最后占位值。"""
    for env in ("OPS_PASSWORD", "FB_PASSWORD", "RM_PASSWORD", "CONSOLE_PASSWORD"):
        v = os.environ.get(env)
        if v:
            return v
    candidates = [
        os.environ.get("OPENBROWSER_USER_DATA"),
        "/home/openbrowser/.config/openbrowser",
        os.path.expanduser("~/.config/openbrowser"),
    ]
    for base in candidates:
        if not base:
            continue
        try:
            with open(os.path.join(base, "console-password.txt"), "r", encoding="utf-8") as f:
                v = f.read().strip()
            if v:
                return v
        except OSError:
            continue
    return "change-me"


PASSWORD = _load_password()
MAX_EDIT = 5 * 1024 * 1024
MAX_ARCHIVES = 4 * 1024 * 1024 * 1024
TOKEN_TTL = 7 * 24 * 3600
HIST_MAX = 900

SECRET_FILE = os.path.join(BASE_DIR, ".secret")


def _secret() -> bytes:
    try:
        with open(SECRET_FILE, "rb") as f:
            return f.read()
    except FileNotFoundError:
        s = secrets.token_bytes(32)
        with open(SECRET_FILE, "wb") as f:
            f.write(s)
        os.chmod(SECRET_FILE, 0o600)
        return s


SECRET = _secret()
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

# ===== 鉴权 =====


class LoginBody(BaseModel):
    password: str = ""


class PathBody(BaseModel):
    path: str


class SaveBody(BaseModel):
    path: str
    content: str
    encoding: str = "utf-8"


class DeleteBody(BaseModel):
    paths: list[str]


class RenameBody(BaseModel):
    path: str
    new_name: str


class TransferBody(BaseModel):
    srcs: list[str]
    dest: str


class UnarchiveBody(BaseModel):
    path: str
    dest: str = ""


class SearchBody(BaseModel):
    dir: str
    q: str
    limit: int = 300


def _make_token() -> str:
    exp = str(int(time.time()) + TOKEN_TTL)
    sig = hmac.new(SECRET, exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def _auth(request: Request):
    token = request.headers.get("x-auth-token") or request.query_params.get("token")
    if not token or "." not in token:
        raise HTTPException(401, "未登录")
    exp, sig = token.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        raise HTTPException(401, "登录已过期")
    good = hmac.new(SECRET, exp.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, good):
        raise HTTPException(401, "凭证无效")


_failures: list = []


@app.post("/api/login")
async def login(body: LoginBody):
    now = time.time()
    global _failures
    _failures = [t for t in _failures if now - t < 60]
    if len(_failures) >= 10:
        raise HTTPException(429, "尝试过于频繁，请稍后再试")
    if hmac.compare_digest(body.password.encode(), PASSWORD.encode()):
        _failures.clear()
        return {"token": _make_token()}
    _failures.append(now)
    time.sleep(1.0)
    raise HTTPException(401, "密码错误")


@app.get("/")
async def index():
    with open(os.path.join(BASE_DIR, "index.html"), encoding="utf-8") as f:
        return HTMLResponse(f.read())


# ===== 文件管理 =====


def _abs(p: str) -> str:
    if not p or not p.strip():
        raise HTTPException(400, "路径为空")
    return os.path.realpath(os.path.abspath(p))


def _check_exists(p: str):
    if not os.path.exists(p):
        raise HTTPException(404, f"不存在: {p}")


def _fail(msg: str):
    raise HTTPException(400, msg)


@app.get("/api/list")
async def api_list(request: Request, path: str = "/"):
    _auth(request)
    p = _abs(path)
    _check_exists(p)
    if not os.path.isdir(p):
        _fail(f"不是目录: {p}")
    entries = []
    try:
        names = os.listdir(p)
    except PermissionError:
        raise HTTPException(403, f"权限不足: {p}")
    for name in names:
        full = os.path.join(p, name)
        try:
            st = os.lstat(full)
            entries.append({
                "name": name,
                "is_dir": os.path.isdir(full) and not os.path.islink(full),
                "is_link": os.path.islink(full),
                "size": 0 if os.path.isdir(full) else st.st_size,
                "mtime": int(st.st_mtime),
                "mode": __import__("stat").filemode(st.st_mode),
            })
        except (PermissionError, OSError):
            entries.append({"name": name, "is_dir": False, "is_link": False,
                            "size": 0, "mtime": 0, "mode": "???", "error": True})
    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return {"path": p, "entries": entries}


@app.get("/api/read")
async def api_read(request: Request, path: str):
    _auth(request)
    p = _abs(path)
    _check_exists(p)
    if os.path.isdir(p):
        _fail("这是目录")
    st = os.stat(p)
    if st.st_size > MAX_EDIT:
        return {"path": p, "binary": True, "too_big": True, "size": st.st_size}
    with open(p, "rb") as f:
        data = f.read(MAX_EDIT + 1)
    if b"\0" in data[:8192]:
        return {"path": p, "binary": True, "size": st.st_size}
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            text = data.decode(enc)
            return {"path": p, "binary": False, "content": text,
                    "encoding": enc, "size": st.st_size, "mtime": int(st.st_mtime)}
        except (UnicodeDecodeError, ValueError):
            continue
    return {"path": p, "binary": True, "size": st.st_size}


@app.post("/api/save")
async def api_save(request: Request, body: SaveBody):
    _auth(request)
    p = _abs(body.path)
    _check_exists(os.path.dirname(p))
    if body.encoding not in ("utf-8", "gbk", "latin-1"):
        _fail("不支持的编码")
    tmp = p + ".fbtmp"
    with open(tmp, "wb") as f:
        f.write(body.content.encode(body.encoding, errors="replace"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, p)
    return {"ok": True, "path": p, "size": os.path.getsize(p)}


@app.post("/api/mkdir")
async def api_mkdir(request: Request, body: PathBody):
    _auth(request)
    p = _abs(body.path)
    if os.path.exists(p):
        _fail("已存在")
    os.makedirs(p)
    return {"ok": True, "path": p}


@app.post("/api/touch")
async def api_touch(request: Request, body: PathBody):
    _auth(request)
    p = _abs(body.path)
    if os.path.exists(p):
        _fail("已存在")
    Path(p).touch()
    return {"ok": True, "path": p}


@app.post("/api/delete")
async def api_delete(request: Request, body: DeleteBody):
    _auth(request)
    if not body.paths:
        _fail("未选择")
    done, errors = [], []
    for raw in body.paths:
        p = _abs(raw)
        if p == "/":
            errors.append({"path": raw, "error": "拒绝删除根目录"})
            continue
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            else:
                os.remove(p)
            done.append(p)
        except Exception as e:
            errors.append({"path": raw, "error": str(e)})
    return {"ok": len(errors) == 0, "deleted": done, "errors": errors}


@app.post("/api/rename")
async def api_rename(request: Request, body: RenameBody):
    _auth(request)
    p = _abs(body.path)
    _check_exists(p)
    new_name = body.new_name.strip()
    if not new_name or "/" in new_name or new_name in (".", ".."):
        _fail("非法名称")
    np = os.path.join(os.path.dirname(p), new_name)
    if os.path.exists(np):
        _fail("目标已存在")
    os.rename(p, np)
    return {"ok": True, "path": np}


def _unique_dest(dest_dir: str, name: str) -> str:
    target = os.path.join(dest_dir, name)
    if not os.path.exists(target):
        return target
    base, ext = os.path.splitext(name)
    i = 1
    while os.path.exists(os.path.join(dest_dir, f"{base}({i}){ext}")):
        i += 1
    return os.path.join(dest_dir, f"{base}({i}){ext}")


@app.post("/api/copy")
async def api_copy(request: Request, body: TransferBody):
    _auth(request)
    dest = _abs(body.dest)
    if not os.path.isdir(dest):
        _fail(f"目标目录不存在: {dest}")
    done, errors = [], []
    for raw in body.srcs:
        src = _abs(raw)
        _check_exists(src)
        if src == dest or dest.startswith(src + os.sep):
            errors.append({"path": raw, "error": "不能复制到自身内部"})
            continue
        target = _unique_dest(dest, os.path.basename(src))
        try:
            if os.path.isdir(src) and not os.path.islink(src):
                shutil.copytree(src, target, symlinks=True)
            else:
                shutil.copy2(src, target, follow_symlinks=False)
            done.append(target)
        except Exception as e:
            errors.append({"path": raw, "error": str(e)})
    return {"ok": len(errors) == 0, "copied": done, "errors": errors}


@app.post("/api/move")
async def api_move(request: Request, body: TransferBody):
    _auth(request)
    dest = _abs(body.dest)
    if not os.path.isdir(dest):
        _fail(f"目标目录不存在: {dest}")
    done, errors = [], []
    for raw in body.srcs:
        src = _abs(raw)
        _check_exists(src)
        if src == dest or dest.startswith(src + os.sep):
            errors.append({"path": raw, "error": "不能移动到自身内部"})
            continue
        target = _unique_dest(dest, os.path.basename(src))
        try:
            shutil.move(src, target)
            done.append(target)
        except Exception as e:
            errors.append({"path": raw, "error": str(e)})
    return {"ok": len(errors) == 0, "moved": done, "errors": errors}


@app.post("/api/upload")
async def api_upload(request: Request, dest: str = Form(...), file: UploadFile = File(...)):
    _auth(request)
    d = _abs(dest)
    if not os.path.isdir(d):
        _fail(f"目标目录不存在: {d}")
    target = _unique_dest(d, os.path.basename(file.filename or "upload.bin"))
    size = 0
    with open(target, "wb") as out:
        while chunk := await file.read(1024 * 1024):
            out.write(chunk)
            size += len(chunk)
    return {"ok": True, "path": target, "size": size}


@app.get("/api/download")
async def api_download(request: Request, path: str, background: BackgroundTasks):
    _auth(request)
    p = _abs(path)
    _check_exists(p)
    if os.path.isfile(p):
        return FileResponse(p, filename=os.path.basename(p))
    if not os.path.isdir(p):
        _fail("不支持的对象类型")
    tmp = tempfile.mktemp(prefix="fb-dl-", suffix=".zip", dir="/tmp/opencode")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(p):
            for fn in files:
                full = os.path.join(root, fn)
                zf.write(full, os.path.relpath(full, os.path.dirname(p)))
    background.add_task(os.remove, tmp)
    return FileResponse(tmp, filename=os.path.basename(p) + ".zip")


@app.get("/api/preview")
async def api_preview(request: Request, path: str):
    _auth(request)
    p = _abs(path)
    _check_exists(p)
    mime, _ = mimetypes.guess_type(p)
    if not mime or not mime.startswith(("image/", "video/", "audio/", "application/pdf")):
        _fail("不支持的预览类型")
    return FileResponse(p, media_type=mime)


ARCHIVE_SUFFIXES = (".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz")


@app.post("/api/unarchive")
async def api_unarchive(request: Request, body: UnarchiveBody):
    _auth(request)
    p = _abs(body.path)
    _check_exists(p)
    lower = p.lower()
    if not lower.endswith(ARCHIVE_SUFFIXES):
        _fail("不支持的压缩格式")
    dest = _abs(body.dest) if body.dest else os.path.join(
        os.path.dirname(p), os.path.basename(p).split(".")[0] or "extracted")
    os.makedirs(dest, exist_ok=True)
    try:
        if lower.endswith(".zip"):
            with zipfile.ZipFile(p) as zf:
                for m in zf.namelist():
                    t = os.path.realpath(os.path.join(dest, m))
                    if not t.startswith(dest + os.sep) and t != dest:
                        _fail("压缩包含不安全路径")
                zf.extractall(dest)
        else:
            with tarfile.open(p) as tf:
                for m in tf.getmembers():
                    t = os.path.realpath(os.path.join(dest, m.name))
                    if not t.startswith(dest + os.sep) and t != dest:
                        _fail("压缩包含不安全路径")
                tf.extractall(dest)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"解压失败: {e}")
    return {"ok": True, "dest": dest}


SKIP_DIRS = {"/proc", "/sys", "/dev", "/run"}


@app.post("/api/search")
async def api_search(request: Request, body: SearchBody):
    _auth(request)
    root = _abs(body.dir)
    _check_exists(root)
    q = body.q.strip().lower()
    if not q:
        _fail("关键词为空")
    limit = max(1, min(body.limit, 1000))
    deadline = time.time() + 4.0
    results = []

    def walk(d):
        if len(results) >= limit or time.time() > deadline:
            return
        try:
            with os.scandir(d) as it:
                for e in it:
                    if len(results) >= limit or time.time() > deadline:
                        return
                    if q in e.name.lower():
                        try:
                            st = e.stat(follow_symlinks=False)
                            results.append({
                                "path": e.path, "name": e.name,
                                "is_dir": e.is_dir(follow_symlinks=False),
                                "size": 0 if e.is_dir(follow_symlinks=False) else st.st_size,
                                "mtime": int(st.st_mtime)})
                        except OSError:
                            pass
                    if e.is_dir(follow_symlinks=False):
                        if e.path not in SKIP_DIRS and not e.path.startswith(tuple(s + "/" for s in SKIP_DIRS)):
                            walk(e.path)
        except (PermissionError, OSError):
            pass

    walk(root)
    return {"ok": True, "results": results, "truncated": len(results) >= limit}


# ===== 资源监控（原 resmon 合并）=====

hist = deque(maxlen=HIST_MAX)
hist_lock = threading.Lock()
_proc_cache: dict = {}


def _proc_mem_bytes() -> int:
    total = 0
    for p in psutil.process_iter():
        try:
            total += p.memory_full_info().pss
        except Exception:
            try:
                total += p.memory_info().rss
            except Exception:
                pass
    return total


def _mem():
    vm = psutil.virtual_memory()
    sm = psutil.swap_memory()
    used = _proc_mem_bytes()
    return {
        "total": vm.total, "used": used,
        "avail": max(0, vm.total - used),
        "os_avail": vm.available,
        "pct": round(used / vm.total * 100, 1) if vm.total else 0.0,
        "swap_total": sm.total, "swap_used": sm.used, "swap_pct": sm.percent,
    }


def _sample_procs():
    alive = set()
    for p in psutil.process_iter(["pid", "name", "username", "memory_percent", "status"]):
        try:
            alive.add(p.pid)
            c = _proc_cache.get(p.pid)
            if c is None:
                c = {"proc": p, "cpu": 0.0}
                _proc_cache[p.pid] = c
                p.cpu_percent(interval=None)
            else:
                c["cpu"] = p.cpu_percent(interval=None)
            c["info"] = p.info
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
    for pid in [k for k in _proc_cache if k not in alive]:
        _proc_cache.pop(pid, None)


def _sample_loop():
    psutil.cpu_percent(interval=None, percpu=True)
    net = psutil.net_io_counters()
    disk = psutil.disk_io_counters()
    last = (time.time(), net, disk)
    while True:
        time.sleep(1.0)
        now = time.time()
        net = psutil.net_io_counters()
        disk = psutil.disk_io_counters()
        dt = now - last[0]
        s = {
            "ts": int(now),
            "cpu": psutil.cpu_percent(interval=None),
            "cores": psutil.cpu_percent(interval=None, percpu=True),
            "load": [round(x, 2) for x in os.getloadavg()],
            "mem": _mem(),
            "net_recv": max(0.0, (net.bytes_recv - last[1].bytes_recv) / dt) if net and last[1] else 0.0,
            "net_sent": max(0.0, (net.bytes_sent - last[1].bytes_sent) / dt) if net and last[1] else 0.0,
            "net_total_recv": net.bytes_recv if net else 0,
            "net_total_sent": net.bytes_sent if net else 0,
            "disk_read": max(0.0, (disk.read_bytes - last[2].read_bytes) / dt) if disk and last[2] else 0.0,
            "disk_write": max(0.0, (disk.write_bytes - last[2].write_bytes) / dt) if disk and last[2] else 0.0,
        }
        last = (now, net, disk)
        with hist_lock:
            hist.append(s)
        _sample_procs()


def _top_procs(n=20):
    by_cpu, by_mem = [], []
    for c in _proc_cache.values():
        info = c.get("info") or {}
        pid = info.get("pid")
        name = info.get("name") or "?"
        item = {
            "pid": pid,
            "name": name,
            "tag": _proc_tag(pid, name) if pid else "",
            "user": info.get("username") or "?",
            "cpu": round(c.get("cpu", 0.0), 1),
            "mem": round(info.get("memory_percent") or 0.0, 1),
            "rss": 0,
            "status": info.get("status") or "",
        }
        try:
            item["rss"] = c["proc"].memory_info().rss
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
        by_cpu.append(item)
        by_mem.append(item)
    by_cpu.sort(key=lambda x: -x["cpu"])
    by_mem.sort(key=lambda x: -x["mem"])
    return by_cpu[:n], by_mem[:n]


def _disks():
    out = []
    for part in psutil.disk_partitions(all=False):
        if part.fstype in ("squashfs", "tmpfs", "devtmpfs", "overlay", "iso9660"):
            continue
        try:
            u = psutil.disk_usage(part.mountpoint)
            out.append({"mount": part.mountpoint, "dev": part.device,
                        "total": u.total, "used": u.used, "free": u.free,
                        "pct": u.percent})
        except (PermissionError, OSError):
            continue
    out.sort(key=lambda x: x["mount"])
    return out


def _cpu_model():
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if "model name" in line:
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown"


@app.get("/api/stats")
async def stats(request: Request):
    _auth(request)
    with hist_lock:
        snap = list(hist)
    cur = snap[-1] if snap else None
    top_cpu, top_mem = _top_procs(40)
    nconn = -1
    try:
        nconn = len(psutil.net_connections(kind="inet"))
    except Exception:
        pass
    return {
        "sys": {
            "hostname": platform.node(),
            "platform": f"{platform.system()} {platform.release()}",
            "python": platform.python_version(),
            "boot": int(psutil.boot_time()),
            "uptime": int(time.time() - psutil.boot_time()),
            "cpu_count": psutil.cpu_count(logical=True),
            "cpu_model": _cpu_model(),
            "nconn": nconn,
        },
        "cur": cur,
        "hist": {
            "ts": [s["ts"] for s in snap],
            "cpu": [s["cpu"] for s in snap],
            "mem": [s["mem"]["pct"] for s in snap],
            "net_recv": [round(s["net_recv"]) for s in snap],
            "net_sent": [round(s["net_sent"]) for s in snap],
            "disk_read": [round(s["disk_read"]) for s in snap],
            "disk_write": [round(s["disk_write"]) for s in snap],
        },
        "disks": _disks(),
        "top_cpu": top_cpu,
        "top_mem": top_mem,
    }


threading.Thread(target=_sample_loop, daemon=True).start()


# ===== 进程管理（结束进程 / 进程名映射）=====

KILL_WHITELIST = (
    "openbrowser", "OpenBrowser", "Browserapp", "browser-profiles-v2",
    "desktop-shell", "webconsole", "opsbox", "chrome-stable",
)
ROLE_CN = {
    "renderer": "渲染进程", "gpu-process": "GPU进程", "utility": "服务进程",
    "zygote": "zygote", "crashpad-handler": "崩溃上报", "network": "网络服务",
    "storage": "存储服务", "audio": "音频服务",
}


def _proc_cmdline(pid: int) -> str:
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return f.read().replace(b"\x00", b" ").decode("utf-8", "replace").strip()
    except (OSError, ValueError):
        return ""


def _proc_cwd(pid: int) -> str:
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except (OSError, ValueError):
        return ""


def _user_data_base() -> str:
    for base in (
        os.environ.get("OPENBROWSER_USER_DATA"),
        "/home/openbrowser/.config/openbrowser",
        os.path.expanduser("~/.config/openbrowser"),
    ):
        if base and os.path.isdir(base):
            return base
    return ""


_prof_names_cache: dict = {"map": {}, "ts": 0.0}


def _profile_names() -> dict:
    """实例 id -> {number, name}，读引擎档案库（30s 缓存），供进程列表显示可识别名称。"""
    now = time.time()
    if now - _prof_names_cache["ts"] > 30:
        base = _user_data_base()
        if base:
            try:
                with open(os.path.join(base, "openbrowser-engine.json"), "r", encoding="utf-8") as f:
                    data = json.load(f)
                _prof_names_cache["map"] = {
                    p.get("id"): {
                        "number": str(p.get("number") or ""),
                        "name": p.get("name") or p.get("title") or "",
                    }
                    for p in data.get("profiles", []) if p.get("id")
                }
                _prof_names_cache["ts"] = now
            except (OSError, ValueError):
                pass
    return _prof_names_cache["map"]


def _proc_tag(pid: int, name: str) -> str:
    """把进程映射为实例语义名：实例名·主进程 / 实例名·渲染进程 / 桌面客户端 / Web控制台"""
    cl = _proc_cmdline(pid)
    if not cl:
        return ""
    prof = ""
    if "--user-data-dir=" in cl:
        udd = cl.split("--user-data-dir=", 1)[1].split(" ")[0].split("\t")[0].rstrip("/")
        if "browser-profiles-v2" in udd:
            prof = udd.split("/")[-1]
    if prof:
        m = re.search(r"--type=([a-z-]+)", cl)
        role = ROLE_CN.get(m.group(1), "主进程") if m else "主进程"
        info = _profile_names().get(prof) or {}
        if info.get("name"):
            label = info["name"]
        elif info.get("number"):
            label = f"实例{info['number']}"
        else:
            label = prof
        return f"{label}·{role}"
    if "desktop-shell" in cl:
        m = re.search(r"--type=([a-z-]+)", cl)
        return "桌面客户端·" + (ROLE_CN.get(m.group(1), m.group(1)) if m else "主进程")
    if "webconsole/server.js" in cl:
        return "Web控制台"
    if "opsbox" in _proc_cwd(pid) or "uvicorn" in cl:
        return "运维工作台"
    return ""


class KillBody(BaseModel):
    pid: int


@app.post("/api/proc/kill")
async def api_proc_kill(request: Request, body: KillBody):
    _auth(request)
    pid = body.pid
    if pid in (1, os.getpid(), os.getppid()):
        raise HTTPException(400, "拒绝结束该进程")
    cl = _proc_cmdline(pid)
    if not cl:
        raise HTTPException(404, "进程不存在或已退出")
    if not any(pat in cl for pat in KILL_WHITELIST) and "opsbox" not in _proc_cwd(pid):
        raise HTTPException(403, "仅允许结束 OpenBrowser 相关进程")
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        raise HTTPException(403, "权限不足")
    return {"ok": True, "pid": pid, "name": cl[:80]}


@app.post("/api/mem/cleanup")
async def api_mem_cleanup(request: Request):
    """内存清理：sync + 释放页缓存/目录项/inode 缓存（需要 root 运行）"""
    _auth(request)
    before = psutil.virtual_memory().available
    os.sync()
    try:
        with open("/proc/sys/vm/drop_caches", "w") as f:
            f.write("3")
    except (OSError, ValueError) as e:
        raise HTTPException(500, f"清理失败（需要 root 权限运行）: {e}")
    time.sleep(0.6)
    after = psutil.virtual_memory().available
    freed = max(0, after - before)
    return {
        "ok": True,
        "before_avail": before,
        "after_avail": after,
        "freed": freed,
        "message": f"已释放缓存，可用内存 {before // 1048576}MB → {after // 1048576}MB（+{freed // 1048576}MB）",
    }
