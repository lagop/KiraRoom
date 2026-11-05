import { redirect } from "next/navigation";

/**
 * Services are created in the drawer on the list (`?new=true` opens it).
 * This route stays because the onboarding checklist links here
 * (onboarding-step.seeder.ts, already stored in salons' steps); its old
 * standalone form had drifted from the list's and was otherwise unused.
 */
export default function NewServicePage() {
  redirect("/dashboard/services?new=true");
}
