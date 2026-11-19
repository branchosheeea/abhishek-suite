/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  poweredByHeader: false,
  async headers() {
    // Another localhost page (any other local port) must not frame or probe this app.
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    }]
  },
  async redirects() {
    // The editor moved under /inspections; keep old links and bookmarks (?id=…) working.
    // Temporary (307) so browsers do not cache it permanently.
    return [{ source: "/report", destination: "/inspections/report", permanent: false }]
  },
}

export default nextConfig
