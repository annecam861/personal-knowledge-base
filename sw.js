// Service worker: lets the installed app open without a connection.
// Pages are network-first (always fresh when online); art, fonts and icons are
// cache-first. Notion calls, sign-in and the status API are never cached.
const CACHE = 'brain-v1';
const SHELL = ['/', '/manifest.webmanifest', '/assets/vendor/phosphor/duotone.css', '/assets/vendor/phosphor/bold.css'];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    const sameOrigin = url.origin === self.location.origin;
    if (sameOrigin && /^\/(notion|api|login|logout)(\/|$)/.test(url.pathname)) return;

    // App page: network first, fall back to the cached copy offline
    if (req.mode === 'navigate') {
        event.respondWith(fetch(req).then(res => {
            // Don't cache the sign-in page in place of the app
            if (res.ok && !res.redirected && res.headers.get('content-type')?.includes('text/html')) {
                res.clone().text().then(html => {
                    if (!html.includes('action="/login"')) caches.open(CACHE).then(c => c.put('/', new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
                });
            }
            return res;
        }).catch(() => caches.match('/')));
        return;
    }

    // Static assets (own art/icons/icon font, Google Fonts): cache first
    const cacheable = (sameOrigin && /^\/(assets|icons)\//.test(url.pathname)) || /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
    if (cacheable) {
        event.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
            if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
            return res;
        })));
    }
});
