// Минимальный service worker — нужен только для того, чтобы браузер
// предложил "Установить приложение". Ничего не кэширует специально,
// чтобы сайт всегда показывал свежие данные (меню, заказы) без сюрпризов.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  // Намеренно ничего не делаем — все запросы идут в сеть как обычно.
});
