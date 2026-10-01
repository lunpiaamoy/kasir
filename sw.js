// Service worker supaya kasir bisa dipasang di layar utama HP/tablet.
// Selalu ambil versi terbaru dari internet dulu; salinan tersimpan hanya dipakai saat
// offline, supaya tampilan tetap terbuka. Data (Supabase) dan CDN tidak disentuh.
const CACHE = 'lunpia-kasir-v20';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // cache: 'no-cache' = selalu tanya server apakah ada versi baru (cache browser GitHub Pages 10 menit)
  e.respondWith(
    fetch(req.url, { cache: 'no-cache' })   // lewat URL: permintaan halaman (navigate) tidak boleh diberi opsi
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
