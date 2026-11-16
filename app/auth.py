"""Single-password login.

Set VL_PASSWORD to turn it on. A signed cookie keeps you signed in for 30 days.
Changing the password signs every device out.
"""
import hashlib
import hmac
import html
import logging
import os
import secrets
import time
from pathlib import Path

from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

log = logging.getLogger("auth")

PASSWORD = os.environ.get("VL_PASSWORD", "")
COOKIE = "vl_session"
MAX_AGE = 30 * 86400
PUBLIC = {"/login", "/logout", "/static/style.css", "/api/health", "/favicon.ico"}

_secret = b""
_fails: dict[str, list[float]] = {}


def init(data_dir: Path):
    global _secret
    key = data_dir / "session.key"
    if not key.exists():
        key.write_bytes(secrets.token_bytes(32))
        key.chmod(0o600)
    _secret = key.read_bytes()
    if not PASSWORD:
        log.warning("VL_PASSWORD is not set: anyone who can reach this server can use it. "
                    "Requests through a Cloudflare tunnel are refused until it's set.")


def _sign(payload: str) -> str:
    # The password is mixed in so that changing it invalidates old sessions.
    key = _secret + hashlib.sha256(PASSWORD.encode()).digest()
    return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()


def _token() -> str:
    exp = str(int(time.time()) + MAX_AGE)
    return f"{exp}.{_sign(exp)}"


def _valid(tok: str | None) -> bool:
    if not tok or "." not in tok:
        return False
    exp, sig = tok.split(".", 1)
    if not exp.isdigit() or int(exp) < time.time():
        return False
    return hmac.compare_digest(sig, _sign(exp))


def client_ip(request: Request) -> str:
    return (request.headers.get("cf-connecting-ip")
            or (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
            or (request.client.host if request.client else "?"))


def _locked(ip: str) -> bool:
    now = time.time()
    recent = [t for t in _fails.get(ip, []) if now - t < 900]
    _fails[ip] = recent
    return len(recent) >= 8


async def middleware(request: Request, call_next):
    path = request.url.path
    if not PASSWORD:
        if request.headers.get("cf-connecting-ip") and path not in PUBLIC:
            return HTMLResponse("<h1>Vocal Lab</h1><p>Set VL_PASSWORD on the server before using it over the internet.</p>",
                                status_code=503)
        return await call_next(request)
    if path in PUBLIC or _valid(request.cookies.get(COOKIE)):
        return await call_next(request)
    if path.startswith(("/api/", "/media/")):
        return JSONResponse({"detail": "Not signed in"}, status_code=401)
    return RedirectResponse("/login", status_code=303)


def login_page(error: str = "", version: str = "") -> HTMLResponse:
    msg = f'<p class="err">{html.escape(error)}</p>' if error else ""
    return HTMLResponse(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#14161c">
<title>Vocal Lab · Sign in</title>
<link rel="stylesheet" href="/static/style.css?v={version}"></head>
<body><main style="max-width:360px;margin:12vh auto">
<h1>Vocal Lab</h1>
<form method="post" action="/login" class="card" style="display:grid;gap:12px">
  <label for="pw" class="dim small">Password</label>
  <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
  {msg}
  <button class="primary">Sign in</button>
</form></main></body></html>""", headers={"Cache-Control": "no-store"})


def handle_login(request: Request, password: str, version: str = ""):
    if not PASSWORD:
        return RedirectResponse("/", status_code=303)
    ip = client_ip(request)
    if _locked(ip):
        return login_page("Too many wrong attempts. Try again in 15 minutes.", version)
    if not hmac.compare_digest(password.encode(), PASSWORD.encode()):
        _fails.setdefault(ip, []).append(time.time())
        log.warning("failed login from %s", ip)
        time.sleep(1)
        return login_page("Wrong password.", version)
    _fails.pop(ip, None)
    resp = RedirectResponse("/", status_code=303)
    resp.set_cookie(COOKIE, _token(), max_age=MAX_AGE, httponly=True, samesite="lax",
                    secure=request.url.scheme == "https")
    return resp


def handle_logout():
    resp = RedirectResponse("/login" if PASSWORD else "/", status_code=303)
    resp.delete_cookie(COOKIE)
    return resp
