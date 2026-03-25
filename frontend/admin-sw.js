const CACHE_NAME = "grip-admin-v1";

// Files to cache for offline shell
const SHELL_FILES = [
    "/owner.html",
    "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
    "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css",
    "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js",
    "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js",
    "https://cdn.jsdelivr.net/npm/chart.js"
];

// Install: cache app shell
self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(SHELL_FILES).catch(err => {
                console.warn("SW: Some files failed to cache", err);
            });
        })
    );
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch: network-first for API calls, cache-first for static assets
self.addEventListener("fetch", event => {
    const url = new URL(event.request.url);

    // Always go to network for API calls — never serve stale data
    if (url.pathname.startsWith("/api/")) {
        event.respondWith(
            fetch(event.request, { 
                credentials: "include"  // Explicitly include credentials
            }).catch(() =>
                new Response(JSON.stringify({ error: "You are offline. Please check your connection." }), {
                    status: 503,
                    headers: { "Content-Type": "application/json" }
                })
            )
        );
        return;
    }

    // Cache-first for CDN assets (fonts, KaTeX, Chart.js)
    if (url.hostname.includes("cdn.jsdelivr.net") || url.hostname.includes("fonts.googleapis.com") || url.hostname.includes("fonts.gstatic.com")) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                return cached || fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                });
            })
        );
        return;
    }

    // Network-first for everything else (owner.html etc)
    // Only cache GET requests - Cache API doesn't support POST
    if (event.request.method !== "GET") {
        event.respondWith(fetch(event.request));
        return;
    }
    event.respondWith(
        fetch(event.request)
            .then(response => {
                const clone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
