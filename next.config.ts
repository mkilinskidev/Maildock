import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Uploads bypass the proxy clone and stream into LocalBlobStorage. All
  // proxied bodies retain a finite ceiling above the 3,100,000-byte compose
  // wire limit. The pinned Next patch rejects overflow instead of truncating.
  experimental: { proxyClientMaxBodySize: 10 * 1024 * 1024 },
  serverExternalPackages: ["@node-rs/argon2", "pg-boss", "postgres"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
