/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The frontend calls our own /api/proxy route, which forwards to the Deno backend.
  // No need to allow-list any external image hosts — no images are rendered.
};

module.exports = nextConfig;
