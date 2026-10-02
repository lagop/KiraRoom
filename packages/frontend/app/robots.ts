import type { MetadataRoute } from "next";
import { appBaseUrl } from "@/lib/salon-seo";

/**
 * robots.txt: salons' public pages are for search engines; the panel, the
 * platform console, sign-in screens and each client's private area are not.
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
          "/accept-invite",
          "/embed",
          "/test-chat",
          "/example-booking",
          "/public/r/",
          "/sites/*/account",
          // The same private area on a salon's own domain.
          "/account",
        ],
      },
    ],
    sitemap: `${appBaseUrl()}/sitemap.xml`,
  };
}
