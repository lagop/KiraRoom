/**
 * Security headers for every page.
 *
 * The app answered with none of them (no HSTS, no nosniff, no frame
 * protection) and announced "X-Powered-By: Next.js". X-Frame-Options leaves
 * out /embed/*: salons put the booking widget in an iframe on their own site.
 */
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  images: {
    domains: ['localhost'],
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1',
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      { source: '/((?!embed/).*)', headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] },
    ]
  },
}

module.exports = nextConfig
