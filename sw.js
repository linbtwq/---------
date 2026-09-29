/*
блок 1
настройка кэша приложения
и список файлов для офлайн режима
*/
importScripts('./version.js');

const CACHE_NAME = `coffee-meters-v${APP_VERSION}`;

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './manifest.json',
    './version.js',
    './javascript/config.js',
    './javascript/auth.js',
    './javascript/script.js'
];

/*
блок 2
установка сервиса и очистка старых версий кэша
*/
self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.allSettled(ASSETS.map((url) => cache.add(url)))
        )
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

/*
блок 3
обработка запросов и офлайн логика
приоритет отдаётся сети и запасному кэшу
*/
self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.includes('/siteapi/')) return;
    e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
    const cached = await caches.match(req, { ignoreSearch: true });
    try {
        const res = cached
            ? await Promise.race([
                fetch(req),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000))
              ])
            : await fetch(req);

        if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return res;
    } catch (err) {
        if (cached) return cached;
        if (req.mode === 'navigate') {
            const page = await caches.match('./index.html');
            if (page) return page;
        }
        return new Response('', { status: 504, statusText: 'Offline' });
    }
}