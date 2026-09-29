/** Messages sent to the model per turn: enough for a whole booking. */
export const HISTORY_WINDOW = 30;

/**
 * The tail of a conversation the model sees. Bounds the input cost of long
 * conversations -- the job the old "hand off at 20 messages" rule did badly,
 * by ending the conversation. Starts on a client message, since providers
 * expect the history to open with the user's turn.
 */
export function recentHistory<T extends { role?: string }>(messages: T[], window = HISTORY_WINDOW): T[] {
  if (messages.length <= window) return messages;
  const tail = messages.slice(-window);
  const firstUser = tail.findIndex((m) => m.role === 'user');
  return firstUser > 0 ? tail.slice(firstUser) : tail;
}
