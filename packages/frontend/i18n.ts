// i18n.ts — Disabled. The codebase uses lib/use-translation.ts (a local
// implementation that reads messages/*.json directly). The next-intl
// integrations are removed until we migrate fully to App Router + i18n.
// This file is kept as a placeholder so importing it returns an empty
// object instead of crashing on a missing package.
export const locales = ["en", "es"] as const;
export const defaultLocale = "es";

// Stub `Link` / `usePathname` / `useRouter` / `redirect` to satisfy the
// (formerly) Next-intl surface. They fall through to the project-wide
// stubs in next/navigation if anything needs them.
export const Link = undefined as unknown as any;
export const redirect = undefined as unknown as any;
export const usePathname = undefined as unknown as any;
export const useRouter = undefined as unknown as any;

export function useI18n() {
  return null;
}
