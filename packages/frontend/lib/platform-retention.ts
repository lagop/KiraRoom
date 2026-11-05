/**
 * What the platform console's "Retención de datos" page shows (the switch of
 * the job that anonymises the data of salons that left). Pure, so it is
 * tested without the browser (platform-retention.spec.ts).
 */
import type { PlatformRetentionConfig } from "./api";

/**
 * - dry_run: off, the job only lists what it would do.
 * - on: turned on from the console.
 * - on_env: forced on by the server's RETENTION_ANONYMIZE_ENABLED=true; the switch cannot turn it off.
 */
export type RetentionView = "dry_run" | "on" | "on_env";

export function retentionView(cfg: PlatformRetentionConfig): RetentionView {
  if (!cfg.effective) return "dry_run";
  return cfg.enabled ? "on" : "on_env";
}

/** Turning ON is irreversible for the salons it reaches, so it asks first; turning OFF does not. */
export function needsConfirmation(cfg: PlatformRetentionConfig): boolean {
  return !cfg.enabled;
}
