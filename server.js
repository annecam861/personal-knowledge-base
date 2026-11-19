// Server for "Your Brain, Externalized".
//
// - Serves the app (index.html, assets, icons, manifest, service worker).
// - Proxies /notion/* to https://api.notion.com/v1/* — Notion's API does not
//   allow direct browser requests (no CORS), so every call goes through here.
//
// Two modes:
//   Local  (default)   bound to 127.0.0.1, no passcode. `node server.js`
//   Hosted (PORT set)  bound to 0.0.0.0 and LOCKED behind APP_PASSCODE.
//                      Without APP_PASSCODE it refuses to serve anything.
//
// Environment (.env locally, the host's environment variables when hosted):
//   NOTION_TOKEN     Notion integration token, kept server-side only
//   APP_PASSCODE     passcode for the hosted app (required when hosted)
//   SESSION_SECRET   optional extra secret for sign-in cookies
//   HOST / PORT      optional overrides

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

// Minimal .env loader (no dependencies)
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
}

const HOSTED = Boolean(process.env.PORT) || process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1');
// Reachable by others, or a passcode was set → passcode required
const LOCKED = (HOST !== '127.0.0.1' && HOST !== 'localhost') || Boolean(process.env.APP_PASSCODE);
const PASSCODE = process.env.APP_PASSCODE || '';
const SESSION_DAYS = 180;
const COOKIE = 'pkb_session';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
};

// Only these files/folders are ever served
const PUBLIC_FILES = new Set(['/index.html', '/manifest.webmanifest', '/sw.js']);
const PUBLIC_DIRS = ['/assets/', '/icons/'];
// Reachable before signing in (so the login page and home-screen icon work)
const OPEN_PATHS = new Set(['/login', '/manifest.webmanifest']);
const OPEN_DIRS = ['/icons/'];

/* ---------- helpers ---------- */

function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'Content-Type': type, ...extra });
    res.end(body);
}
const sendJSON = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (LOCKED) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
}

function clientIp(req) {
    return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); }
            else chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// Requests to the proxy must come from this app's own pages
function isSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // same-origin GETs omit Origin
    try {
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

/* ---------- passcode sessions ---------- */

const secretKey = crypto.createHash('sha256').update(`${PASSCODE}::${process.env.SESSION_SECRET || 'pkb'}`).digest();
const sign = value => crypto.createHmac('sha256', secretKey).update(value).digest('base64url');

function makeSession() {
    const expires = Date.now() + SESSION_DAYS * 86400000;
    return `${expires}.${sign(String(expires))}`;
}

function hasSession(req) {
    const raw = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
    if (!raw) return false;
    const [expires, mac] = raw.slice(COOKIE.length + 1).split('.');
    if (!expires || !mac || Number(expires) < Date.now()) return false;
    const expected = sign(expires);
    return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
}

function cookieHeader(value, maxAge) {
    return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${LOCKED ? '; Secure' : ''}`;
}

function passcodeMatches(attempt) {
    const a = crypto.createHash('sha256').update(String(attempt)).digest();
    const b = crypto.createHash('sha256').update(PASSCODE).digest();
    return crypto.timingSafeEqual(a, b);
}

// 8 wrong tries per IP per 15 minutes
const attempts = new Map();
function tooManyAttempts(ip) {
    const now = Date.now();
    const list = (attempts.get(ip) || []).filter(t => now - t < 15 * 60000);
    attempts.set(ip, list);
    return list.length >= 8;
}
function recordFailure(ip) { attempts.get(ip)?.push(Date.now()) ?? attempts.set(ip, [Date.now()]); }

function page(title, inner) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title><meta name="theme-color" content="#221B3D">
<link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<style>
*{box-sizing:border-box;margin:0}body{min-height:100vh;display:grid;place-items:center;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#F2EFFB;
background:radial-gradient(500px 300px at 80% 10%,rgba(185,166,255,.35),transparent 70%),radial-gradient(400px 300px at 10% 90%,rgba(255,121,176,.22),transparent 70%),linear-gradient(140deg,#3A2A80,#150F2E)}
.card{width:100%;max-width:380px;background:rgba(26,22,48,.82);border:1px solid rgba(255,255,255,.12);border-radius:26px;padding:30px 26px;text-align:center;backdrop-filter:blur(12px);box-shadow:0 30px 70px rgba(0,0,0,.45)}
img{width:96px;height:96px;margin:0 auto 10px;display:block;border-radius:24px}
h1{font-family:Georgia,serif;font-size:1.6rem;margin-bottom:6px}p{color:#CBC5E3;font-size:.95rem;margin-bottom:20px;line-height:1.5}
input{width:100%;padding:14px 16px;border-radius:14px;border:1px solid #3a3360;background:#120f24;color:#fff;font-size:1.05rem;text-align:center;letter-spacing:.08em}
input:focus{outline:none;border-color:#B9A6FF;box-shadow:0 0 0 4px rgba(185,166,255,.25)}
button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:14px;font-size:1rem;font-weight:700;color:#fff;cursor:pointer;background:linear-gradient(180deg,#7B52FF,#6538F5);box-shadow:0 3px 0 #3A1C9E}
.err{color:#FF9DC4;font-size:.9rem;margin-top:12px}code{background:#120f24;padding:2px 6px;border-radius:6px}
</style></head><body><main class="card">${inner}</main></body></html>`;
}

function loginPage(error = '') {
    return page('Sign in · Your Brain', `
        <img src="/icons/icon-192.png" alt="">
        <h1>Your Brain, Externalized</h1>
        <p>Enter your passcode to open your notes.</p>
        <form method="POST" action="/login">
            <input type="password" name="passcode" autocomplete="current-password" autofocus required aria-label="Passcode" placeholder="Passcode">
            <button type="submit">Unlock</button>
            ${error ? `<div class="err">${error}</div>` : ''}
        </form>`);
}

const setupPage = page('Almost there', `
    <h1>Almost there</h1>
    <p>This app is locked until a passcode is set.<br>In hPanel, open this website's <strong>Node.js</strong> settings → <strong>Environment variables</strong> and add <code>APP_PASSCODE</code> (and <code>NOTION_TOKEN</code>). The app restarts on its own.</p>`);

async function handleLogin(req, res) {
    if (req.method === 'GET') return send(res, 200, loginPage(), MIME['.html'], { 'Cache-Control': 'no-store' });
    if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) return send(res, 429, loginPage('Too many tries. Wait 15 minutes and try again.'), MIME['.html']);
    let attempt = '';
    try { attempt = new URLSearchParams((await readBody(req, 4096)).toString()).get('passcode') || ''; } catch { /* ignore */ }
    if (!passcodeMatches(attempt)) {
        recordFailure(ip);
        return send(res, 401, loginPage('That’s not it. Try again.'), MIME['.html']);
    }
    attempts.delete(ip);
    res.writeHead(303, { Location: '/', 'Set-Cookie': cookieHeader(makeSession(), SESSION_DAYS * 86400), 'Cache-Control': 'no-store' });
    res.end();
}

/* ---------- Notion proxy ---------- */

async function proxyToNotion(req, res, notionPath) {
    if (!isSameOrigin(req)) return sendJSON(res, 403, { message: 'Proxy only accepts requests from this app.' });

    // Hosted: only the server's token is used. Local: a token from the app's settings also works.
    const token = (!LOCKED && (req.headers['x-notion-token'] || '').trim()) || process.env.NOTION_TOKEN;
    if (!token) {
        return sendJSON(res, 401, { code: 'missing_token', message: LOCKED ? 'NOTION_TOKEN is not set on the server yet.' : 'No Notion token. Add NOTION_TOKEN to .env or enter it in the app settings.' });
    }

    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, e.status || 400, { message: e.message }); }

    const upstream = https.request({
        hostname: 'api.notion.com',
        path: '/v1' + notionPath,
        method: req.method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Notion-Version': req.headers['notion-version'] || '2022-06-28',
            'Content-Type': 'application/json',
            ...(body.length ? { 'Content-Length': body.length } : {})
        }
    }, upRes => {
        res.writeHead(upRes.statusCode, { 'Content-Type': upRes.headers['content-type'] || 'application/json', 'Cache-Control': 'no-store' });
        upRes.pipe(res);
    });
    upstream.on('error', err => sendJSON(res, 502, { code: 'proxy_error', message: `Could not reach Notion: ${err.message}` }));
    if (body.length) upstream.write(body);
    upstream.end();
}

/* ---------- static files ---------- */

function serveStatic(req, res, urlPath) {
    let rel;
    try { rel = decodeURIComponent(urlPath); } catch { return send(res, 400, 'Bad request'); }
    if (rel === '/') rel = '/index.html';
    const allowed = PUBLIC_FILES.has(rel) || PUBLIC_DIRS.some(d => rel.startsWith(d));
    const filePath = path.normalize(path.join(ROOT, rel));
    if (!allowed || !filePath.startsWith(ROOT + path.sep) || path.basename(filePath).startsWith('.')) return send(res, 404, 'Not found');

    fs.readFile(filePath, (err, data) => {
        if (err) return send(res, 404, 'Not found');
        const ext = path.extname(filePath).toLowerCase();
        const longCache = rel.startsWith('/assets/') || rel.startsWith('/icons/');
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': longCache ? 'public, max-age=604800' : 'no-cache',
            ...(rel === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {})
        });
        res.end(data);
    });
}

/* ---------- router ---------- */

http.createServer(async (req, res) => {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (LOCKED) {
        if (!PASSCODE) return send(res, 503, setupPage, MIME['.html'], { 'Cache-Control': 'no-store' });
        if (p === '/login') return handleLogin(req, res);
        if (p === '/logout') {
            res.writeHead(303, { Location: '/login', 'Set-Cookie': cookieHeader('', 0) });
            return res.end();
        }
        const open = OPEN_PATHS.has(p) || OPEN_DIRS.some(d => p.startsWith(d));
        if (!open && !hasSession(req)) {
            if (p.startsWith('/notion/') || p.startsWith('/api/')) return sendJSON(res, 401, { code: 'login_required', message: 'Please sign in again.' });
            if (p === '/' || p === '/index.html') return send(res, 200, loginPage(), MIME['.html'], { 'Cache-Control': 'no-store' });
            return send(res, 401, 'Sign in first');
        }
    }

    if (p === '/api/status') return sendJSON(res, 200, { proxy: true, serverToken: Boolean(process.env.NOTION_TOKEN), locked: LOCKED }, { 'Cache-Control': 'no-store' });
    if (p.startsWith('/notion/')) return proxyToNotion(req, res, p.slice('/notion'.length) + url.search);
    serveStatic(req, res, p);
}).listen(PORT, HOST, () => {
    console.log(`Your Brain, Externalized → http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  Mode: ${LOCKED ? `hosted, passcode ${PASSCODE ? 'set' : 'MISSING (app is locked)'}` : 'local (this computer only)'}`);
    console.log(`  Notion token on server: ${process.env.NOTION_TOKEN ? 'yes' : 'no'}`);
});
