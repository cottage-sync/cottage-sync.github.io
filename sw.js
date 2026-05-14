const CACHE_NAME = 'cottage-v5';
const APP_SHELL_URL = './index.html';
const APP_SHELL_ASSETS = [
  './',
  APP_SHELL_URL,
  './manifest.json',
  './favicon.svg',
  './favicon-96x96.png',
  './favicon.ico',
  './apple-touch-icon.png',
  './web-app-manifest-192x192.png',
  './web-app-manifest-512x512.png',
  'https://unpkg.com/simpledotcss/simple.min.css',
  'https://cdn-uicons.flaticon.com/2.1.0/uicons-regular-rounded/css/uicons-regular-rounded.css',
  'https://unpkg.com/@isomorphic-git/lightning-fs@4.6.2'
];
const STATIC_ORIGINS = new Set([
  self.location.origin,
  'https://unpkg.com',
  'https://cdn-uicons.flaticon.com'
]);

function normalizeAssetUrl(asset) {
  return new URL(asset, self.location.href).toString();
}

function extractAppShellAssets(indexHtml) {
  const assets = new Set(APP_SHELL_ASSETS.map(normalizeAssetUrl));
  const patterns = [
    /(href|src)=['"]([^'"#?]+)['"]/gi,
    /module_or_path:\s*['"]([^'"]+)['"]/gi
  ];

  for (const pattern of patterns) {
    for (const match of indexHtml.matchAll(pattern)) {
      const asset = match[2] || match[1];
      if (!asset) {
        continue;
      }

      const url = new URL(asset, self.location.href);
      if (STATIC_ORIGINS.has(url.origin)) {
        assets.add(url.toString());
      }
    }
  }

  return [...assets];
}

function isCacheableResponse(response) {
  return response && (response.ok || response.type === 'opaque');
}

function shouldCacheRequest(request, url) {
  if (request.method !== 'GET') {
    return false;
  }

  if (!STATIC_ORIGINS.has(url.origin)) {
    return false;
  }

  if (request.mode === 'navigate') {
    return true;
  }

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('.wasm')) {
      return true;
    }

    if (url.pathname.endsWith('.js') || url.pathname.endsWith('.mjs')) {
      return true;
    }
  }

  return [
    'document',
    'script',
    'style',
    'font',
    'image',
    'manifest',
    'worker'
  ].includes(request.destination);
}

async function precacheAppShell() {
  const shellResponse = await fetch(new Request(APP_SHELL_URL, { cache: 'reload' }));
  const cache = await caches.open(CACHE_NAME);
  const shellAssets = extractAppShellAssets(await shellResponse.clone().text());

  if (isCacheableResponse(shellResponse)) {
    await cache.put(normalizeAssetUrl(APP_SHELL_URL), shellResponse.clone());
    await cache.put(normalizeAssetUrl('./'), shellResponse.clone());
  }

  await Promise.allSettled(
    shellAssets.map(async (asset) => {
      const isCrossOrigin = asset.startsWith('http');
      const request = new Request(
        asset,
        isCrossOrigin ? { mode: 'no-cors' } : { cache: 'reload' }
      );

      const existingResponse = asset === normalizeAssetUrl(APP_SHELL_URL)
        || asset === normalizeAssetUrl('./')
        ? await cache.match(asset)
        : null;

      if (existingResponse) {
        return;
      }

      const response = await fetch(request);

      if (isCacheableResponse(response)) {
        await cache.put(request, response);
      }
    })
  );
}

async function cacheResponse(request, response) {
  const cache = await caches.open(CACHE_NAME);
  await cache.put(request, response.clone());
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (!shouldCacheRequest(request, url)) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (isCacheableResponse(response)) {
          event.waitUntil((async () => {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(normalizeAssetUrl(APP_SHELL_URL), response.clone());
            await cache.put(normalizeAssetUrl('./'), response.clone());
          })());
        }
        return response;
      } catch (_error) {
        return (await caches.match(request))
          || (await caches.match(normalizeAssetUrl(APP_SHELL_URL)))
          || (await caches.match(normalizeAssetUrl('./')));
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) {
      event.waitUntil((async () => {
        try {
          const freshResponse = await fetch(request);
          if (isCacheableResponse(freshResponse)) {
            await cacheResponse(request, freshResponse);
          }
        } catch (_error) {
        }
      })());
      return cachedResponse;
    }

    try {
      const response = await fetch(request);
      if (isCacheableResponse(response)) {
        event.waitUntil(cacheResponse(request, response));
      }
      return response;
    } catch (_error) {
      return caches.match(request);
    }
  })());
});
