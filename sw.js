// PourOver Lab Service Worker
// App 快取隨版本更新；字型另存一個永不清除的快取，改版時不會被連帶清掉。
const CACHE_NAME = 'pourover-app-v56';
const FONT_CACHE = 'pourover-fonts-v1';

// 少了就等於 App 壞掉的檔案 —— 必須全部成功
const CORE_ASSETS = ['./', './manifest.json'];
// 有更好、沒有也不影響離線使用 —— 逐一加入，失敗不影響 install
// og-image.png 拿掉了：只有社群爬蟲會抓，App 執行期永遠用不到，白佔 install 時間。
// icon-512-maskable.png 補上：manifest 有列，之前漏掉。
const OPTIONAL_ASSETS = ['./icon-192.png', './icon-512.png', './icon-512-maskable.png', './en/', './en/manifest.json'];

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@300;400;500;700&family=DM+Sans:wght@400;500;700&family=Space+Mono:wght@400;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,400&display=swap';

const NAV_TIMEOUT = 2500; // 只有「快取裡沒有這一頁」時才會用到（第一次造訪）

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache =>
        // 核心必須成功；其餘逐一嘗試，任何一個 404 都不會讓整個 install 失敗
        cache.addAll(CORE_ASSETS)
          .then(() => Promise.all(OPTIONAL_ASSETS.map(u => cache.add(u).catch(() => {}))))
      )
      // 字型刻意不進 waitUntil ——
      // 字型 CDN 若沒有回應（不是 reject 而是 hang），install 仍然會完成。
      .then(() => { caches.open(FONT_CACHE).then(c => c.add(FONT_CSS).catch(() => {})); })
  );
  // 這裡刻意「不」呼叫 skipWaiting()：
  // 舊版沒等使用者同意就換掉 Service Worker，可能在正在沖煮時被抽換。
  // 改成由頁面顯示「有新版本」提示，使用者點了才送 SKIP_WAITING 過來。
});

// 頁面剛載入時來不及收到訊息（導覽的 fetch 通常比頁面的 JS 先跑完），
// 所以除了主動推播，也讓頁面自己問一次。
let updateReady = false;

self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data.type === 'CHECK_UPDATE' && e.source) {
    e.source.postMessage({ type: updateReady ? 'update-ready' : 'up-to-date' });
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

function tellClients(msg) {
  return self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(c => c.postMessage(msg)));
}

// 用 ETag / Last-Modified 判斷線上是不是換了新版 —— 比比對 550KB 的 HTML 內容便宜太多
function stamp(res) {
  if (!res) return null;
  return res.headers.get('etag') || res.headers.get('last-modified') || null;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // HTML 導覽：stale-while-revalidate。
  // 快取裡有就「立刻」回（實測 0ms 顯示），同時在背景抓新版存起來。
  // 舊版是 network-first + 2.5 秒逾時，訊號差但連得上（lie-fi，手機最常見的狀態）
  // 時要等滿 2.56 秒才看得到畫面，而完整的離線副本其實就躺在快取裡。
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(cached => {
        const fromNet = fetch(req).then(response => {
          if (response && response.status === 200) {
            const before = stamp(cached);
            const after = stamp(response);
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
            // 有快取、而且線上版本確實變了 → 記下來並通知頁面顯示「有新版本」
            const changed = !!(cached && before && after && before !== after);
            updateReady = changed;                       // 相同就順便把旗標清掉
            if (changed) tellClients({ type: 'update-ready' });
          }
          return response;
        }).catch(() => null);

        if (cached) return cached;

        // 第一次造訪（快取裡沒有這一頁）才需要逾時保護
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
