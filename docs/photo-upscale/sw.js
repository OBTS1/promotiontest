// オフライン用：アプリのファイル（端末内 AI のモデルを含む）を端末に保存し、ネットが無くても開けるようにする。
// 表示はいつも保存済みのものを先に出し、つながっていれば裏で最新版に入れ替える。Gemini への通信（別サイト）は対象外。
var CACHE = 'photo-upscale-6606cb1667a8';
var FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png',
  './vendor/tf.min.js', './models/x2/model.json', './models/x2/group1-shard1of1.bin',
  './models/x4/model.json', './models/x4/group1-shard1of1.bin'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('photo-upscale-') === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: true }).then(function (hit) {
      var update = fetch(req).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit; });
      return hit || update;
    });
  }));
});
