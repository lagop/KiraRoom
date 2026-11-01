/**
 * The salon panel's menu: what each role sees and how it is grouped. Pure,
 * tested in dashboard-nav.spec.ts; the sidebar draws it and maps each `icon`
 * to its lucide component.
 *
 * Daily screens stay at the top level; the rest sits in groups that fold, one
 * open at a time, so the menu fits a laptop screen without scrolling.
 */

export interface NavLink {
  kind: "link";
  id: string;
  href: string;
  /** Translation key. */
  label: string;
  icon: string;
  /** Active only on this exact path (index pages that prefix others). */
  exact?: boolean;
  /** Owner and admin only. */
  managers?: boolean;
  /** Everyone but owner and admin (they find it inside a group). */
  staffOnly?: boolean;
  /** Shows the Pro badge. */
  pro?: boolean;
  /** Shows the Empresa badge (the page itself shows the upgrade card on other plans). */
  empresa?: boolean;
  /** Shows a count the sidebar reads (e.g. requests waiting for an answer). */
  badge?: NavBadge;
}

/** The counts the sidebar can show next to a link. */
export type NavBadge = "time-off-requests";

export interface NavGroup {
  kind: "group";
  id: string;
  label: string;
  icon: string;
  managers?: boolean;
  items: NavLink[];
}

export type NavEntry = NavLink | NavGroup;

const link = (id: string, href: string, label: string, icon: string, opts: Partial<NavLink> = {}): NavLink => ({
  kind: "link",
  id,
  href,
  label,
  icon,
  ...opts,
});

export const DASHBOARD_NAV: NavEntry[] = [
  link("dashboard", "/dashboard", "nav.dashboard", "home", { exact: true }),
  link("appointments", "/dashboard/appointments", "nav.appointments", "calendar"),
  link("clients", "/dashboard/clients", "nav.clients", "users"),
  link("wait-list", "/dashboard/wait-list", "nav.wait_list", "hourglass"),
  // A professional asks for their own time off; the salon answers in Solicitudes de ausencia.
  link("my-time-off", "/dashboard/mis-ausencias", "nav.my_time_off", "calendar-off", { staffOnly: true }),
  {
    kind: "group",
    id: "team",
    label: "nav.group_team",
    icon: "scissors",
    items: [
      link("professionals", "/dashboard/professionals", "nav.professionals", "user-cog", { managers: true }),
      link("time-off-requests", "/dashboard/solicitudes-ausencia", "nav.time_off_requests", "calendar-off", {
        managers: true,
        badge: "time-off-requests",
      }),
      link("services", "/dashboard/services", "nav.services", "scissors", { managers: true }),
      link("commissions", "/dashboard/commissions", "nav.commissions", "dollar", { managers: true }),
    ],
  },
  {
    kind: "group",
    id: "sales",
    label: "nav.group_sales",
    icon: "receipt",
    items: [
      // Exact: the products page below is its own entry.
      link("pos", "/dashboard/pos", "nav.pos", "cart", { exact: true }),
      // What the till sells besides services, and its stock.
      link("pos-products", "/dashboard/pos/products", "nav.pos_products", "package", { managers: true }),
      link("payments", "/dashboard/payments", "nav.payments", "card", { managers: true }),
      // Invoices carry clients' NIFs and the takings: owner and admin (the API agrees).
      link("invoices", "/dashboard/billing/invoices", "invoices.title", "file", { managers: true }),
      link("gift-cards", "/dashboard/gift-cards", "nav.gift_cards", "wallet", { managers: true, pro: true }),
    ],
  },
  {
    kind: "group",
    id: "marketing",
    label: "nav.group_marketing",
    icon: "megaphone",
    items: [
      link("email-campaigns", "/dashboard/email-campaigns", "nav.email_campaigns", "mail", { managers: true }),
      link("whatsapp", "/dashboard/marketing/whatsapp", "nav.whatsapp_campaigns", "message", { managers: true, pro: true }),
      link("promotions", "/dashboard/promotions", "nav.promotions", "tag", { managers: true, pro: true }),
      // Not in Esencial (PLAN_MATRIX, subscriptions.service.ts): the Pro badge, like gift cards.
      link("loyalty", "/dashboard/loyalty", "nav.loyalty", "gift", { managers: true, pro: true }),
      link("reviews", "/dashboard/reviews", "nav.reviews", "star", { managers: true }),
      link("share", "/dashboard/compartir", "nav.share", "qr"),
    ],
  },
  link("analytics", "/dashboard/analytics", "nav.analytics", "chart", { managers: true }),
  {
    kind: "group",
    id: "settings",
    label: "nav.settings",
    icon: "settings",
    managers: true,
    items: [
      link("settings", "/dashboard/settings", "nav.settings_general", "sliders", { exact: true }),
      link("billing", "/dashboard/billing", "nav.billing", "euro", { exact: true }),
      link("salon", "/dashboard/settings/salon", "nav.salon", "store"),
      // Locations and the consolidated report (Empresa), also linked from Analítica.
      link("multi-location", "/dashboard/multi-location", "nav.multi_location", "map-pin", { empresa: true }),
      link("closures", "/dashboard/settings/cierres", "nav.closures", "calendar-off"),
      link("domain", "/dashboard/settings/domain", "nav.domain", "globe"),
      // The booking widget for the salon's own website (also linked from Compartir).
      link("widget", "/dashboard/settings/widget", "nav.widget", "code"),
      link("security", "/dashboard/settings/seguridad", "nav.security", "shield"),
      link("rebooking", "/dashboard/settings/rebooking", "rebooking.settings.title", "repeat", { pro: true }),
      link("fiscal", "/dashboard/settings/fiscal", "invoices.fiscalSettings.title", "scroll", { pro: true }),
      link("accounting", "/dashboard/settings/accounting", "accounting.title", "calculator", { pro: true }),
      link("channels", "/dashboard/settings/channels", "billing.channels.title", "message", { pro: true }),
    ],
  },
  // Staff have no settings group, but their own two-step verification is theirs.
  link("security-staff", "/dashboard/settings/seguridad", "nav.security", "shield", { staffOnly: true }),
];

/**
 * Owner and admin manage the salon. Before the user is read (first render,
 * which must match the server's) nobody counts as one, as before.
 */
export function isManager(role: string | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** The menu for a role: links it may not open removed, empty groups dropped. */
export function navFor(role: string | null | undefined, nav: NavEntry[] = DASHBOARD_NAV): NavEntry[] {
  const manager = isManager(role);
  const visible = (l: { managers?: boolean; staffOnly?: boolean }) =>
    (!l.managers || manager) && (!l.staffOnly || !manager);
  return nav.flatMap((entry): NavEntry[] => {
    if (!visible(entry)) return [];
    if (entry.kind === "link") return [entry];
    const items = entry.items.filter(visible);
    return items.length ? [{ ...entry, items }] : [];
  });
}

export function isActive(item: NavLink, pathname: string): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

/** The badges a menu shows, so the sidebar fetches only those. */
export function badgesIn(nav: NavEntry[]): NavBadge[] {
  const all = nav.flatMap((e) => (e.kind === "link" ? [e] : e.items)).flatMap((l) => (l.badge ? [l.badge] : []));
  return [...new Set(all)];
}

/** The group holding the current page, so it opens by itself; null if none. */
export function activeGroup(nav: NavEntry[], pathname: string): string | null {
  for (const entry of nav) {
    if (entry.kind === "group" && entry.items.some((item) => isActive(item, pathname))) return entry.id;
  }
  return null;
}
