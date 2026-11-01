import { Logger } from "@nestjs/common";

/**
 * "This account's sessions just ended": told by whoever bumps an account's
 * tokenVersion or switches it off (a team member deactivated or their access
 * removed, a password changed or reset, a logout everywhere, a client
 * blocked or erased), heard by whatever holds live connections.
 *
 * Every HTTP request already checks the token's version and the account
 * against the database (JwtStrategy), so a revoked access token fails on its
 * next request. A websocket, though, is checked once, when it connects, and
 * then stays open: a professional removed from the team kept receiving the
 * salon's live notifications until they closed the tab. The notifications
 * gateway listens here and disconnects the account's sockets at once; it also
 * re-checks its sockets periodically, for any path that ends sessions
 * without saying so here.
 *
 * In-process: the backend runs as one instance. With several, each would
 * still drop its own sockets within the periodic re-check.
 */
export interface SessionRevocation {
  /** A panel user (owner, admin, professional). */
  userId?: string;
  /** A salon's client (the booking site's account). */
  clientId?: string;
}

type Listener = (revocation: SessionRevocation) => void | Promise<void>;

class SessionRevocationBus {
  private readonly listeners = new Set<Listener>();
  private readonly logger = new Logger("SessionRevocations");

  /** Listen; returns the function that stops listening. */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The account's sessions ended. Never throws: what failed to disconnect is
   * caught by the listener's own periodic re-check, and the change that
   * ended the sessions is already saved.
   */
  revoke(revocation: SessionRevocation): void {
    if (!revocation.userId && !revocation.clientId) return;
    for (const listener of this.listeners) {
      try {
        const done = listener(revocation);
        if (done && typeof (done as Promise<void>).catch === "function") {
          (done as Promise<void>).catch((err) =>
            this.logger.warn(`Live sessions not ended: ${(err as Error).message}`),
          );
        }
      } catch (err) {
        this.logger.warn(`Live sessions not ended: ${(err as Error).message}`);
      }
    }
  }
}

export const sessionRevocations = new SessionRevocationBus();
