const CACHE = "sir-shell-v2"
const PRECACHE = ["/", "/report", "/manifest.webmanifest", "/icon.svg"]

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// Network-first for same-origin GETs (pages, JS, CSS, fonts), falling back to cache when offline.
// API calls are never cached: the app keeps its data in IndexedDB and syncs explicitly.
self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith("/api/") || url.pathname.includes("webpack-hmr") || url.pathname.includes("__nextjs")) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(async () => {
        const cache = await caches.open(CACHE)
        const cached =
          (await cache.match(request)) ||
          (request.mode === "navigate" ? await cache.match(request, { ignoreSearch: true }) : undefined)
        if (cached) return cached
        if (request.mode === "navigate") {
          const shell = await cache.match(url.pathname.startsWith("/report") ? "/report" : "/")
          if (shell) return shell
        }
        return new Response("Offline", { status: 503, statusText: "Offline" })
      }),
  )
})
