import { redirect } from "next/navigation";

/**
 * The salon's own Stripe keys are hidden: the page asked for the live secret
 * key, but no flow uses it (there are no online payments from clients yet),
 * and it said "using the global keys", which is not what happens. The keys
 * already saved stay in the database, encrypted. The form that lived here
 * (and the Pagos tab of Ajustes) is in git history for when online payments
 * are built.
 */
export default function StripeSettingsPage() {
  redirect("/dashboard/settings");
}
