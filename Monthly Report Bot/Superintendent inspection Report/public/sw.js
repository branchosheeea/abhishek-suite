// v3: NeraVeda web shell. Activating this version deletes the previous "sir-shell-v2" cache,
// whose "/" entry was the old report list. Report data is not affected: it lives in IndexedDB.
const CACHE = "neraveda-shell-v3"
const PRECACHE = ["/", "/inspections", "/inspections/report", "/manifest.webmanifest", "/icon.svg"]

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

function offlineShell(pathname) {
  if (pathname.startsWith("/inspections/report")) return "/inspections/report"
  if (pathname.startsWith("/inspections")) return "/inspections"
  return "/"
}

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
        // Old editor links while offline: send them to the new address (the server does this when online).
        if (request.mode === "navigate" && url.pathname === "/report") {
          return Response.redirect(`${url.origin}/inspections/report${url.search}`, 302)
        }
        const cache = await caches.open(CACHE)
        const cached =
          (await cache.match(request)) ||
          (request.mode === "navigate" ? await cache.match(request, { ignoreSearch: true }) : undefined)
        if (cached) return cached
        if (request.mode === "navigate") {
          const shell = await cache.match(offlineShell(url.pathname))
          if (shell) return shell
        }
        return new Response("Offline", { status: 503, statusText: "Offline" })
      }),
  )
})
