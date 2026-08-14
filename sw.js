// PourOver Lab Service Worker
// App 快取隨版本更新；字型另存一個永不清除的快取，改版時不會被連帶清掉。
const CACHE_NAME = 'pourover-app-v47';
const FONT_CACHE = 'pourover-fonts-v1';

// 少了就等於 App 壞掉的檔案 —— 必須全部成功
const CORE_ASSETS = ['./', './manifest.json'];
// 有更好、沒有也不影響離線使用 —— 逐一加入，失敗不影響 install
const OPTIONAL_ASSETS = ['./icon-192.png', './icon-512.png', './og-image.png', './en/', './en/manifest.json'];

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&family=DM+Sans:wght@400;500;700&family=Space+Mono:wght@400;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,400&display=swap';

const NAV_TIMEOUT = 2500; // 網路超過這個時間就直接用快取，避免弱訊號下白畫面

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache =>
        // 核心必須成功；其餘逐一嘗試，任何一個 404 都不會讓整個 install 失敗
        cache.addAll(CORE_ASSETS)
          .then(() => Promise.all(OPTIONAL_ASSETS.map(u => cache.add(u).catch(() => {}))))
      )
      .then(() => self.skipWaiting())
      // 字型刻意放在 skipWaiting 之後，且不進 waitUntil ——
      // 字型 CDN 若沒有回應（不是 reject 而是 hang），install 仍然會完成。
      .then(() => { caches.open(FONT_CACHE).then(c => c.add(FONT_CSS).catch(() => {})); })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== FONT_CACHE && k.startsWith('pourover-'))
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// 離線時的退路：先找這個網址本身，找不到就退回同語言的 App 外殼。
// 注意 caches.match() 回傳的是 Promise（永遠 truthy），所以不能用 `a || b` 串接 ——
// 那樣第二個 fallback 永遠不會被走到。預快取存的鍵是 './' 與 './en/'，
// 不是 './index.html'，兩者是不同的快取鍵。
function cacheFallback(req) {
  const isEn = new URL(req.url).pathname.includes('/en');
  const shells = isEn ? ['./en/', './en/index.html'] : ['./', './index.html'];
  return caches.match(req, { ignoreSearch: true }).then(c => {
    if (c) return c;
    return shells.reduce(
      (chain, u) => chain.then(hit => hit || caches.match(u)),
      Promise.resolve(null)
    );
  });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // HTML 導覽：network-first（改版立即生效），但加上逾時 ——
  // 訊號差時不再吊著等，2.5 秒就改用快取。
  if (req.mode === 'navigate') {
    e.respondWith(
      new Promise(resolve => {
        let settled = false;
        const done = r => { if (!settled) { settled = true; resolve(r); } };
        const timer = setTimeout(() => { cacheFallback(req).then(c => { if (c) done(c); }); }, NAV_TIMEOUT);
        fetch(req).then(response => {
          clearTimeout(timer);
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          done(response);
        }).catch(() => {
          clearTimeout(timer);
          cacheFallback(req).then(c => done(c || Response.error()));
        });
      })
    );
    return;
  }

  // 靜態資源：cache-first + 背景更新。字型寫進獨立的字型快取。
  const url = new URL(req.url);
  const isFont = url.hostname.startsWith('fonts.');
  const cacheable = url.origin === self.location.origin || isFont;
  const targetCache = isFont ? FONT_CACHE : CACHE_NAME;
  e.respondWith(
    caches.match(req).then(cached => {
      const fetched = fetch(req).then(response => {
        if (cacheable && response && (response.status === 200 || (isFont && response.type === 'opaque'))) {
          const clone = response.clone();
          caches.open(targetCache).then(cache => cache.put(req, clone));
        }
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});
