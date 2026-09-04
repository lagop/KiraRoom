import { redirect } from "next/navigation";

/**
 * P2A-staff-copilot (and general UX): `/admin` is a common admin-URL
 * convention users type. We don't have a real `/admin` route — the
 * SaaS admin lives at `/saas`. Redirect so users land in the right
 * place instead of getting a 404.
 */
export default function AdminIndex() {
  redirect("/saas");
}
