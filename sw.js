// アプリ本体をキャッシュして、オフラインでも開けるようにする。
// 問題PDFと音声は IndexedDB にあるので、ここでは扱わない。
const VERSION = 'v2';
const SHELL = [
  './', 'index.html', 'style.css', 'app.js', 'data.js', 'manifest.webmanifest',
  'vendor/pdf.min.mjs', 'vendor/pdf.worker.min.mjs',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// まずネットワークから取り、失敗したらキャッシュを使う（更新がすぐ反映され、オフラインでも動く）
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/materials/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
