// PourOver Lab Service Worker
// App 快取隨版本更新；字型另存一個永不清除的快取，改版時不會被連帶清掉。
const CACHE_NAME = 'pourover-app-v70';
const FONT_CACHE = 'pourover-fonts-v2'; // v2：自架 Noto Sans TC 子集也放這裡（fonts/ 路徑），改版不清

// 少了就等於 App 壞掉的檔案 —— 必須全部成功
const CORE_ASSETS = ['./', './manifest.json'];
// 有更好、沒有也不影響離線使用 —— 逐一加入，失敗不影響 install
// og-image.png 拿掉了：只有社群爬蟲會抓，App 執行期永遠用不到，白佔 install 時間。
// icon-512-maskable.png 補上：manifest 有列，之前漏掉。
const OPTIONAL_ASSETS = ['./icon-192.png', './icon-512.png', './icon-512-maskable.png', './en/', './en/manifest.json'];

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=Space+Mono:wght@400;700&family=Cormorant+Garamond:ital,wght@0,300;0,400;1,400&display=swap';

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
//
// 這裡記的是「線上那一版的戳記」，不是一個 true/false 旗標（2026-09-09 修）。
// 舊版用布林值：設成 true 之後，只能等下一次背景 fetch 回來才會被清掉。
// 使用者點了「更新」→ 重新載入 → 頁面在 1.2 秒時問 SW，這個詢問常常比背景
// fetch 更早到，於是拿到的還是上一次留下的 true，同一個提示就一直冒出來、
// 怎麼點都消不掉。改成記戳記之後，只要送給頁面的快取副本已經是新版，
// 在導覽的當下就會立刻清掉，不再有這個時間差。
let pendingKey = null;   // 線上那一版的 ETag（正規化過）
let pendingFp = null;    // 線上那一版的內容指紋 —— 頁面拿它當「這個版本我已經按過了」的鑰匙

self.addEventListener('message', e => {
  if (!e.data) return;
  if (e.data.type === 'SKIP_WAITING') self.skipWaiting();
  // 使用者已經按下「更新」—— 先收下，避免重載途中又被問到而重複提示
  if (e.data.type === 'UPDATE_TAKEN') { pendingKey = null; pendingFp = null; }
  // 頁面問「你是哪一版」—— 用來認出等待中的 Service Worker 是不是同一個
  if (e.data.type === 'SW_VERSION' && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ type: 'sw-version', version: CACHE_NAME });
  }
  if (e.data.type === 'CHECK_UPDATE' && e.source) {
    e.source.postMessage({ type: pendingFp ? 'update-ready' : 'up-to-date', build: pendingFp });
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

/* 用 ETag / Last-Modified 判斷線上是不是換了新版 —— 比比對 550KB 的 HTML 內容便宜太多。
   ★ 2026-09-09 修：ETag 一定要正規化，而且不能只信它。
   GitHub Pages 對「同一份檔案」會依內容編碼給不同的 ETag：
     Accept-Encoding 含 gzip → W/"6aa1ae45-a78f0"（弱標記）
     沒有壓縮            → "6aa1ae45-a78f0"（強標記）
   只要快取裡那份與背景 fetch 拿到的落在不同編碼，兩個字串就永遠不相等，
   「有新版本」會每次載入都冒出來、而且怎麼點都消不掉（V 在 iPhone 上遇到的就是這個）。
   所以：(1) 去掉 W/ 與引號再比；(2) 比出不同時，一定要用內容指紋再確認一次才通知。 */
function stampKey(res) {
  if (!res) return null;
  const v = res.headers.get('etag') || res.headers.get('last-modified');
  return v ? v.replace(/^W\//i, '').replace(/"/g, '').trim() : null;
}
/* 內容指紋：長度 + FNV-1a 32bit。與編碼、ETag 格式都無關，是最後的仲裁者。
   只在 ETag 比出不同時才會算到，正常情況不花這個成本。 */
function fingerprint(res) {
  if (!res) return Promise.resolve(null);
  return res.text().then(t => {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return t.length + '-' + h.toString(16);
  }).catch(() => null);
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
        const beforeKey = stampKey(cached);
        // 這一次送出去的快取副本就是先前通知過的那一版 → 更新已經生效，旗標當場清掉
        if (pendingKey && beforeKey === pendingKey) { pendingKey = null; pendingFp = null; }
        // 先留一份副本 —— 等一下算內容指紋要用，而原本那份會被頁面讀掉
        const cachedCopy = cached ? cached.clone() : null;

        // cache:'no-cache' 是必要的：GitHub Pages 給 max-age=600，
        // 直接 fetch(req) 有機會拿到瀏覽器 HTTP 快取裡的舊回應，戳記一新一舊來回跳，
        // 「有新版本」就會反覆出現。強制回伺服器驗證，命中時只是一個 304，很便宜。
        const fromNet = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(response => {
          if (response && response.status === 200) {
            const afterKey = stampKey(response);
            const forCache = response.clone();
            const forHash = cachedCopy ? response.clone() : null;
            caches.open(CACHE_NAME).then(cache => cache.put(req, forCache));
            if (!cachedCopy || (beforeKey && afterKey && beforeKey === afterKey)) {
              pendingKey = null; pendingFp = null;       // 戳記一樣就一定沒換版
            } else {
              // 戳記不同不代表真的換版（同一份檔案壓縮與否會給不同 ETag），
              // 一定要用內容指紋確認過再通知，否則就是永遠消不掉的假警報
              Promise.all([fingerprint(cachedCopy), fingerprint(forHash)]).then(fps => {
                if (fps[0] && fps[1] && fps[0] !== fps[1]) {
                  pendingKey = afterKey; pendingFp = fps[1];
                  tellClients({ type: 'update-ready', build: fps[1] });
                } else { pendingKey = null; pendingFp = null; }
              });
            }
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
