import { AsyncLocalStorage } from "async_hooks";

/**
 * AsyncLocalStorage instance carrying the per-request correlation id.
 *
 * Anywhere in the codebase that wants to include the correlation id
 * in a log line, an error report, or a metric label can pull it with:
 *
 *   correlationStorage.getStore()?.requestId
 *
 * The middleware `CorrelationIdMiddleware` populates this on every
 * incoming HTTP request. Works across await boundaries because
 * AsyncLocalStorage propagates the value through the async context.
 */
export interface CorrelationStore {
  requestId: string;
  startedAt: number;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationStore>();
