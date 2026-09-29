// sw.js — service worker minimo, solo para que la PWA sea instalable
// (requisito tecnico de Chrome/Safari para el boton "Agregar a pantalla de inicio").
// No hace caching agresivo para evitar que veas datos de mercado viejos.

const CACHE_NAME = 'smc-copilot-pwa-v2';
const APP_SHELL = ['./index.html', './app.js', './styles.css', './manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Solo servimos desde cache el "app shell" (HTML/JS/CSS propios).
  // Las llamadas a las APIs de datos y de Gemini SIEMPRE van a la red,
  // nunca a cache, porque necesitamos precios y analisis frescos.
  const url = new URL(event.request.url);
  if (APP_SHELL.some((f) => url.pathname.endsWith(f.replace('./', '/')))) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
