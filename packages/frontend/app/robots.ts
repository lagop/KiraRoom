import type { MetadataRoute } from "next";
import { appBaseUrl } from "@/lib/salon-seo";

/**
 * robots.txt: salons' public pages are for search engines; the panel, the
 * platform console and sign-in screens are not. (The clients' private area
 * is gone: its old addresses redirect to the booking page.)
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/sites/"],
        disallow: [
          "/dashboard",
          "/saas",
          "/admin",
          "/login",
          "/signup",
          "/forgot-password",
          "/reset-password",
          "/verify-email",
          "/accept-invite",
          "/embed",
          "/test-chat",
          "/example-booking",
          "/public/r/",
          "/public/baja/",
          "/public/lista-espera/",
        ],
      },
    ],
    sitemap: `${appBaseUrl()}/sitemap.xml`,
  };
}
