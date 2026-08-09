/* Bureau du Courrier — service worker.

   Trois régimes, volontairement séparés :

   - le code (HTML, CSS, JS) part du RÉSEAU, avec le cache en secours. Servir
     le code depuis le cache d'abord fige l'application sur une version
     ancienne, et pire, laisse dériver le HTML et le JavaScript l'un par
     rapport à l'autre : une page d'hier avec un script d'aujourd'hui cherche
     des éléments qui n'existent pas encore et meurt en silence ;
   - les ressources immuables (polices, icônes) viennent du cache d'abord :
     elles ne changent qu'avec leur nom de fichier, et pèsent l'essentiel ;
   - /api/ n'est JAMAIS mis en cache. Un registre partagé périmé serait pire
     qu'une erreur franche : hors ligne, la requête échoue et l'interface
     bascule d'elle-même sur le stockage local.

   Hors ligne, tout retombe sur le cache : l'application reste utilisable.
   Changer CACHE_VERSION invalide l'ancien cache au prochain chargement. */
'use strict';

const CACHE_VERSION = 'bdc-v19';

/** Le code doit toujours être cohérent avec lui-même : réseau d'abord. */
function isCode(url) {
  return /\.(?:html|js|css|webmanifest)$/.test(url.pathname) || url.pathname === '/' || url.pathname === '';
}

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/style.css',
  './assets/css/fonts.css',
  './assets/js/util.js',
  './assets/js/attente.js',
  './assets/js/roles.js',
  './assets/js/domiciliation.js',
  './assets/js/appels.js',
  './assets/js/codebarres.js',
  './assets/js/xlsx.js',
  './assets/js/store.js',
  './assets/js/notify.js',
  './assets/js/ui/noyau.js',
  './assets/js/ui/impression.js',
  './assets/js/app.js',
  './assets/icons/logo.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
  './assets/fonts/bricolage-grotesque-latin.woff2',
  './assets/fonts/bricolage-grotesque-latin-ext.woff2',
  './assets/fonts/instrument-sans-latin.woff2',
  './assets/fonts/instrument-sans-latin-ext.woff2',
  './assets/fonts/source-serif-4-latin.woff2',
  './assets/fonts/source-serif-4-latin-ext.woff2',
  './assets/fonts/special-elite-latin.woff2',
  './assets/fonts/special-elite-latin-ext.woff2',
  './assets/fonts/jetbrains-mono-latin.woff2',
  './assets/fonts/jetbrains-mono-latin-ext.woff2'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then(function (cache) {
        // addAll échoue en bloc si une seule ressource manque : on préfère
        // mettre en cache ce qui répond et laisser le reste au réseau.
        return Promise.all(
          SHELL.map(function (url) {
            return cache.add(url).catch(function () {
              console.warn('[sw] non mis en cache :', url);
            });
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (key) {
              return key !== CACHE_VERSION;
            })
            .map(function (key) {
              return caches.delete(key);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // toujours le réseau, jamais le cache

  const remember = function (response) {
    if (response && response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_VERSION).then(function (cache) {
        cache.put(request, copy);
      });
    }
    return response;
  };

  if (isCode(url) || request.mode === 'navigate') {
    // Réseau d'abord : la version en ligne fait foi tant qu'elle est joignable.
    event.respondWith(
      fetch(request)
        .then(remember)
        .catch(function () {
          return caches.match(request, { ignoreSearch: true }).then(function (cached) {
            return cached || caches.match('./index.html');
          });
        })
    );
    return;
  }

  // Ressources immuables : cache d'abord, réseau en secours.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(function (cached) {
      return cached || fetch(request).then(remember);
    })
  );
});

// Permet à la page de demander l'activation immédiate d'une version en attente.
self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
