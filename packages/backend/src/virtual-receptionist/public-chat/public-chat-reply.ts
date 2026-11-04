/**
 * What the public chat endpoint answers: the reply and what the widget needs
 * to carry on, nothing else.
 *
 * The whole internal result used to go out: `toolsExecuted` (each tool's
 * input and full output -- service and professional ids, `isOwner`, raw
 * exception text), the model, the intent, and with the cap reached the
 * salon's `limitInfo` (cap, used, action). The widget used none of it.
 */
export interface PublicChatReply {
  /** The conversation id (or a fixed id for a reply that has none). */
  id: string;
  content: string;
  /** The widget offers the salon's phone when set. */
  requiresHandoff: boolean;
  /** Issued to visitors; sent back with the next message. */
  visitorToken: string;
}

export function publicChatReply(
  reply: { id: string; content: string; requiresHandoff?: boolean },
  visitorToken: string,
): PublicChatReply {
  return {
    id: reply.id,
    content: reply.content,
    requiresHandoff: reply.requiresHandoff === true,
    visitorToken,
  };
}
