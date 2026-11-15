import React from "react";
import { ChatInline, parseChatMarkdown } from "@/lib/chat-markdown";

function Inline({ parts }: { parts: ChatInline[] }) {
  return (
    <>
      {parts.map((p, i) => (p.bold ? <strong key={i}>{p.text}</strong> : <React.Fragment key={i}>{p.text}</React.Fragment>))}
    </>
  );
}

/**
 * An AI reply with its bold, line breaks and lists (see lib/chat-markdown),
 * built as React elements, never as HTML. Shared by the virtual
 * receptionist's widget and the salon copilot, which showed "**…**" as typed.
 */
export function ChatMarkdownText({ text, className = "text-sm space-y-2 break-words" }: { text: string; className?: string }) {
  return (
    <div className={className}>
      {parseChatMarkdown(text).map((block, i) => {
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={i} start={block.ordered ? block.start : undefined} className={`${block.ordered ? "list-decimal" : "list-disc"} pl-5 space-y-0.5`}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <Inline parts={item} />
                </li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                <Inline parts={line} />
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
