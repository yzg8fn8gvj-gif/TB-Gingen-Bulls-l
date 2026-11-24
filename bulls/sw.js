const CACHE = 'tb-bulls-main-teams-v2';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg', './teams.json'];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('tb-bulls-main-teams-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Live team data and calendars must always come directly from the latest deployment.
  if (/\/data\/[^/]+\/(data\.json|calendar\.ics|team-analysis\.html)$/.test(url.pathname)) return;

  // For app navigation and shell files, prefer the network so a normal close/reopen
  // picks up the latest published app without reinstalling the home-screen app.
  const isShellRequest = request.mode === 'navigate'
    || /\/(index\.html|manifest\.webmanifest|teams\.json|icon\.svg|sw\.js)$/.test(url.pathname)
    || url.pathname.endsWith('/');

  if (!isShellRequest) return;

  event.respondWith((async () => {
    try {
      const networkRequest = new Request(request, { cache: 'no-store' });
      const response = await fetch(networkRequest);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      return cached || caches.match('./index.html');
    }
  })());
});
