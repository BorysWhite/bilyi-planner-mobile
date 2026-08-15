const CACHE_NAME = 'bilyi-planner-v1';
const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './sync.js',
    './firebase-config.js',
    './manifest.webmanifest',
    './vendor/bootstrap.min.css',
    './vendor/bootstrap.bundle.min.js',
    './vendor/fullcalendar.min.js',
    './vendor/firebase-app-compat.js',
    './vendor/firebase-auth-compat.js',
    './vendor/firebase-firestore-compat.js',
    './assets/app-icon-192.png',
    './assets/app-icon-512.png',
    './assets/knuba-logo.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Кеш-шелл для статичних файлів застосунку. Дані (Firestore) не кешуються тут —
// про офлайн-роботу з даними піклується власна offline-persistence Firestore.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return; // не чіпаємо Firebase/Google запити

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => cached);
        })
    );
});
