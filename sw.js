/* Bureau du Courrier — service worker.

   Deux régimes, volontairement séparés :

   - la coquille de l'application (HTML, CSS, JS, polices, icônes) est servie
     depuis le cache, et rafraîchie en arrière-plan : l'application s'ouvre
     instantanément et fonctionne sans réseau ;
   - /api/ n'est JAMAIS mis en cache. Un registre partagé périmé serait pire
     qu'une erreur franche : hors ligne, la requête échoue et l'interface
     bascule d'elle-même sur le stockage local.

   Changer CACHE_VERSION suffit à invalider l'ancien cache au prochain
   chargement. */
'use strict';

const CACHE_VERSION = 'bdc-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/style.css',
  './assets/css/fonts.css',
  './assets/js/util.js',
  './assets/js/store.js',
  './assets/js/notify.js',
  './assets/js/app.js',
  './assets/icons/logo.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png',
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

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(function (cached) {
      const fromNetwork = fetch(request)
        .then(function (response) {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then(function (cache) {
              cache.put(request, copy);
            });
          }
          return response;
        })
        .catch(function () {
          return cached || caches.match('./index.html');
        });

      // Cache d'abord pour l'affichage, réseau en arrière-plan pour la fraîcheur.
      return cached || fromNetwork;
    })
  );
});

// Permet à la page de demander l'activation immédiate d'une version en attente.
self.addEventListener('message', function (event) {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
