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

/**
 * Keeps the built @kira/shared out of the React Refresh loader in `next dev`.
 *
 * @kira/shared is CommonJS in packages/shared/dist, and the workspace symlink
 * makes webpack see it there rather than under node_modules. Next 14.2 adds
 * the Refresh loader to every browser module outside node_modules, so it
 * appended `import.meta.webpackHot` to that CommonJS file and every page
 * importing @kira/shared failed with "Cannot use 'import.meta' outside a
 * module". transpilePackages doesn't help: its exclusion also only matches
 * node_modules paths. `next build` never adds the loader, so this is dev-only.
 */
const sharedDist = /[\\/]packages[\\/]shared[\\/]dist[\\/]/

function excludeSharedFromReactRefresh(config) {
  for (const rule of config.module.rules) {
    const loaders = Array.isArray(rule?.use) ? rule.use : []
    const refreshOnly =
      loaders.length > 0 &&
      loaders.every((l) => typeof l === 'string' && l.includes('react-refresh-utils'))
    if (refreshOnly) rule.exclude = [].concat(rule.exclude ?? [], sharedDist)
  }
}

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
  webpack(config, { dev, isServer }) {
    if (dev && !isServer) excludeSharedFromReactRefresh(config)
    return config
  },
}

module.exports = nextConfig
