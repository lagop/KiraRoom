/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/chat-markdown.spec.ts
 *
 * The chat widget showed the receptionist's replies as raw text: asterisks
 * around "Lunes a viernes:" and a list of times run together on one line.
 */

import { parseChatMarkdown, parseInline } from "./chat-markdown";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

console.log("\n=== bold ===");

check("double asterisks", parseInline("**Lunes a viernes:** 9:00 a 18:00"), [
  { text: "Lunes a viernes:", bold: true },
  { text: " 9:00 a 18:00" },
]);
check("single asterisks, as on WhatsApp", parseInline("📋 *Resumen de tu cita:*"), [
  { text: "📋 " },
  { text: "Resumen de tu cita:", bold: true },
]);
check("several in one line", parseInline("**15:00** | 15:30 | **17:30**"), [
  { text: "15:00", bold: true },
  { text: " | 15:30 | " },
  { text: "17:30", bold: true },
]);
check("a lone asterisk stays", parseInline("5 * 3 = 15"), [{ text: "5 * 3 = 15" }]);
check("an unclosed pair stays", parseInline("**sin cerrar"), [{ text: "**sin cerrar" }]);
check("plain text", parseInline("Hola"), [{ text: "Hola" }]);

console.log("\n=== lines and paragraphs ===");

check("line breaks are kept", parseChatMarkdown("Hola, Clara.\n¿Qué día te va bien?"), [
  { type: "paragraph", lines: [[{ text: "Hola, Clara." }], [{ text: "¿Qué día te va bien?" }]] },
]);
check("a blank line starts a paragraph", parseChatMarkdown("Uno\n\nDos").length, 2);
check("windows line endings", parseChatMarkdown("Uno\r\nDos"), [
  { type: "paragraph", lines: [[{ text: "Uno" }], [{ text: "Dos" }]] },
]);
check("a heading is a bold line", parseChatMarkdown("## Horario"), [
  { type: "paragraph", lines: [[{ text: "Horario", bold: true }]] },
]);

console.log("\n=== lists ===");

const hours = parseChatMarkdown(
  "Nuestro horario es:\n- **Lunes a viernes:** 9:00 a 18:00\n- **Sábados:** 9:00 a 14:00\n- **Domingos:** Cerrado\n¿Algo más?",
);
check("text, list, text", hours.map((b) => b.type), ["paragraph", "list", "paragraph"]);
check("three items", (hours[1] as any).items.length, 3);
check("items keep their bold", (hours[1] as any).items[0], [
  { text: "Lunes a viernes:", bold: true },
  { text: " 9:00 a 18:00" },
]);
check("bullets with • and *", (parseChatMarkdown("• uno\n* dos")[0] as any).items.length, 2);
check("numbered list", parseChatMarkdown("1. Masaje Relajante\n2) Masaje Descontracturante")[0], {
  type: "list",
  ordered: true,
  start: 1,
  items: [[{ text: "Masaje Relajante" }], [{ text: "Masaje Descontracturante" }]],
});
// Seen in the widget: a description between the items restarted at 1.
const split = parseChatMarkdown(
  "1. **Masaje Relajante**\nSuave, con aceites.\n\n2. **Masaje Descontracturante**\nProfundo.",
);
check(
  "a list broken by a description keeps counting",
  split.filter((b) => b.type === "list").map((b: any) => b.start),
  [1, 2],
);
check("a bold line is not a bullet", parseChatMarkdown("*Resumen:*")[0].type, "paragraph");
check("empty text", parseChatMarkdown(""), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(failures.join("\n"));
  process.exit(1);
}
