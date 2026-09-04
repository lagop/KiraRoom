/**
 * Re-export so `import { AppointmentDrawer } from "./components/appointment-drawer"`
 * (in `app/dashboard/appointments/page.tsx:22`) keeps resolving to
 * the new module structure under `./appointment-drawer/`.
 *
 * The orchestrator itself lives in `./appointment-drawer/appointment-drawer.tsx`;
 * the 4 hooks it composes are under `./appointment-drawer/hooks/`;
 * the 1 primitive + 4 section components are under
 * `./appointment-drawer/{primitives,sections}/`.
 */
export { AppointmentDrawer } from "./appointment-drawer";
export type { AppointmentDrawerProps } from "./types";
