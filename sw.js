// Кеш програми для роботи без інтернету. Спершу мережа (щоб оновлення доходили одразу),
// без мережі — з кешу. Номер версії змінюється при кожній збірці.
const VERSION = 'sufler-20260925165230';
const FILES = [
    './', 'index.html', 'prompter.html', 'styles.css', 'prompter.css',
    'renderer.js', 'prompter.js', 'voice-tracker.js', 'sync-core.js', 'pwa-api.js',
    'web-voice.js', 'syl-worklet.js', 'recorder.js', 'defaults.js', 'firebase-config.js',
    'vendor/firebase-app-compat.js', 'vendor/firebase-auth-compat.js', 'vendor/firebase-firestore-compat.js',
    'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
        .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (e.request.method !== 'GET' || url.origin !== location.origin) return;
    e.respondWith(
        fetch(e.request)
            .then(res => {
                const copy = res.clone();
                caches.open(VERSION).then(c => c.put(e.request, copy));
                return res;
            })
            .catch(() => caches.match(e.request, { ignoreSearch: true }))
    );
});
