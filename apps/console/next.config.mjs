import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CONSOLE_EXPORT=1 builds a static site that the API serves itself (single-service test deployments).
const staticExport = process.env.CONSOLE_EXPORT === '1';

/** @type {import('next').NextConfig} */
const nextConfig = staticExport
  ? { reactStrictMode: true, output: 'export', trailingSlash: true, images: { unoptimized: true } }
  : {
      reactStrictMode: true,
      // Self-contained server bundle for the Docker image.
      output: 'standalone',
      outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      poweredByHeader: false,
      async headers() {
        return [
          {
            source: '/:path*',
            headers: [
              { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
              { key: 'X-Content-Type-Options', value: 'nosniff' },
              { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
              { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
            ],
          },
        ];
      },
    };
export default nextConfig;
