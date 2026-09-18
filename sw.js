const CACHE_NAME = 'bilyi-planner-v2';
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
        caches.keys()
            .then((keys) =>
                Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
            )
            .then(() => self.clients.claim())
    );
});

// Стратегія "мережа спочатку": застосунок завжди тягне свіжу версію файлів,
// поки є інтернет, і кладе її в кеш. Кеш використовується лише як резерв,
// коли мережі немає (офлайн-режим), — так, щоб оновлення (наприклад, нові
// дисципліни чи групи) з'являлись на телефоні одразу, а не залипали
// назавжди у старому кеші, як було раніше.
// Дані (Firestore) тут не кешуються — про офлайн-роботу з даними піклується
// власна offline-persistence Firestore.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return; // не чіпаємо Firebase/Google запити

    event.respondWith(
        fetch(event.request).then((response) => {
            if (response && response.status === 200) {
                const clone = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
            }
            return response;
        }).catch(() => caches.match(event.request))
    );
});
