import type { Metadata } from "next";
import RootLanding from "./components/root-landing";

/**
 * app.kiraroom.net/: the app's own front page. The public website is
 * kiraroom.com, so this one stays out of Google (it competed with it in the
 * results); links on it are still followed.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: true },
};

export default function Page() {
  return <RootLanding />;
}
