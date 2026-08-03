const CACHE_NAME = 'pourover-lab-v25';
const LOCAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './og-image.png',
  './en/',
  './en/index.html',
  './en/manifest.json'
];
const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&family=DM+Sans:wght@400;500;700&family=Space+Mono:wght@400;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,400&display=swap';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // Local assets are required; the Google Fonts stylesheet is best-effort so an
      // unreachable fonts CDN can never block offline support for the app itself.
      .then(cache => cache.addAll(LOCAL_ASSETS).then(() => cache.add(FONT_CSS).catch(() => {})))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // HTML navigations: network-first so deploys show up immediately;
  // fall back to cache when offline (language-aware, query-string tolerant).
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(response => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() =>
        caches.match(req, { ignoreSearch: true }).then(c =>
          c || caches.match(new URL(req.url).pathname.includes('/en') ? './en/index.html' : './index.html')
        )
      )
    );
    return;
  }

  // Static assets: cache-first with background refresh.
  // Only cache same-origin assets and Google Fonts responses.
  const url = new URL(req.url);
  const cacheable = url.origin === self.location.origin || url.hostname.startsWith('fonts.');
  e.respondWith(
    caches.match(req).then(cached => {
      const fetched = fetch(req).then(response => {
        const isFont = url.hostname.startsWith('fonts.');
        if (cacheable && response && (response.status === 200 || (isFont && response.type === 'opaque'))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
