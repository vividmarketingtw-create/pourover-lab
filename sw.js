// PourOver Lab Service Worker
//
// 2026-09-26 整個重寫，只留一條規則：「版本 = CACHE_NAME」。
//
// 為什麼重寫：之前三次修「有新版本」一直跳，都是在同一個架構上補丁——
// 網頁用 stale-while-revalidate 從網路抓回來、比 ETag、比內容指紋、再通知頁面。
// 只要任何一環（GitHub Pages 的 ETag 依壓縮不同、瀏覽器 HTTP 快取、帶 ?參數的網址、
// 多分頁、頁面問得比背景 fetch 早……）出一點差，就是永遠消不掉的假警報。
//
// 現在的做法是瀏覽器內建的標準流程，沒有自己比對任何東西：
//   1. 網頁、manifest、圖示在 install 時一次抓齊（強制回伺服器拿，不經 HTTP 快取）。
//   2. 導覽一律直接從這一版的快取回，不再背景重抓、不再比對。
//   3. 「有新版本」只有一種來源：sw.js 的 CACHE_NAME 變了 → 瀏覽器裝新 SW →
//      頁面看到 reg.waiting → 顯示提示。使用者點了 → skipWaiting → controllerchange → reload。
//   4. 版號由 sync.js 在 index.html 有改時自動 +1，不會忘。
//
// 字型另存一個永不清除的快取，改版時不會被連帶清掉。
const CACHE_NAME = 'pourover-app-v80';
const FONT_CACHE = 'pourover-fonts-v2';

// 少了就等於 App 壞掉的檔案 —— 必須全部成功
const CORE_ASSETS = ['./', './manifest.json'];
// 有更好、沒有也不影響離線使用 —— 逐一加入，失敗不影響 install
const OPTIONAL_ASSETS = ['./icon-192.png', './icon-512.png', './icon-512-maskable.png', './en/', './en/manifest.json'];

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Mono:wght@400;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,400&display=swap';

const NAV_TIMEOUT = 2500; // 只有「快取裡沒有這一頁」時才會用到（第一次造訪）

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache =>
        // cache:'reload'：一定要直接回伺服器拿，不能吃瀏覽器 HTTP 快取裡的舊網頁
        cache.addAll(CORE_ASSETS.map(u => new Request(u, { cache: 'reload' })))
          .then(() => Promise.all(OPTIONAL_ASSETS.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      )
      .then(() => { caches.open(FONT_CACHE).then(c => c.add(FONT_CSS).catch(() => {})); })
  );
  // 刻意不 skipWaiting()：正在沖煮時不能被抽換版本，由頁面提示、使用者點了才換。
});

self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'SW_VERSION' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ type: 'sw-version', version: CACHE_NAME });
  }
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

// 導覽頁的快取鑰匙：去掉 ?參數 與 #，index.html 視同資料夾本身，一個頁面只存一份。
// （從 FB／LINE 開的連結會帶 ?fbclid=… 之類的參數，不處理就會多出一份副本。）
function navKey(u) {
  const x = new URL(u); x.search = ''; x.hash = '';
  x.pathname = x.pathname.replace(/index\.html$/, '');
  return x.href;
}

// 離線時的退路：先找這個網址本身，找不到就退回同語言的 App 外殼。
function cacheFallback(req) {
  const isEn = new URL(req.url).pathname.includes('/en');
  const shells = isEn ? ['./en/', './en/index.html'] : ['./', './index.html'];
  return caches.match(navKey(req.url)).then(c => {
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

  // HTML 導覽：cache-first。這一版的快取裡有就直接回，不重抓、不比對。
  // 快取裡沒有（第一次造訪這一頁、或沖法子頁）才走網路，抓到就存進這一版的快取。
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(navKey(req.url)).then(cached => {
        if (cached) return cached;
        const fromNet = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(response => {
          if (response && response.status === 200) {
            const forCache = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(navKey(req.url), forCache));
          }
          return response;
        }).catch(() => null);
        return Promise.race([
          fromNet,
          new Promise(r => setTimeout(() => r(null), NAV_TIMEOUT))
        ]).then(r => r || fromNet).then(r => r || cacheFallback(req).then(c => c || Response.error()));
      })
    );
    return;
  }

  // 靜態資源：cache-first + 背景更新。字型寫進獨立的字型快取。
  const url = new URL(req.url);
  const isFont = url.hostname.startsWith('fonts.') || (url.origin === self.location.origin && url.pathname.includes('/fonts/'));
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
