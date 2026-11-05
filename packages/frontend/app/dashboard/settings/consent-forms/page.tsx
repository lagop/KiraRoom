import { redirect } from "next/navigation";

/**
 * Consent forms are hidden until there is a way to sign them: no screen asks
 * a client to sign, so the page promised RGPD compliance it did not give.
 * The forms and any signatures stay in the database (a form with signatures
 * can't be deleted, consent.service.ts deleteForm). The editor that lived
 * here is in git history (before this change) for when signing is built.
 */
export default function ConsentFormsPage() {
  redirect("/dashboard/settings");
}
