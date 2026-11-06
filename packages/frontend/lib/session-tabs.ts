/** Whether the `user` entry now names another person or salon (or none): the page on screen is stale. */
export function sessionChangedAcrossTabs(oldValue: string | null, newValue: string | null): boolean {
  if (!oldValue) return false; // signing in from nothing: this tab was not showing a session
  const identity = (raw: string | null) => {
    try {
      const u = JSON.parse(raw ?? "null");
      return u ? `${u.id ?? ""}|${u.tenantId ?? ""}` : null;
    } catch {
      return null;
    }
  };
  return identity(oldValue) !== identity(newValue);
}
