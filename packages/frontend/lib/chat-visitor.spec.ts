/**
 * The public chat's visitor token and refusal messages.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/chat-visitor.spec.ts
 */
import { CHAT_MAX_MESSAGE, chatErrorText, readVisitorToken, rememberVisitorToken, visitorTokenKey } from "./chat-visitor";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
};

check("no token before the first answer", readVisitorToken(storage, "salon-a") === undefined);
rememberVisitorToken(storage, "salon-a", "v1.salon-a.x.mac");
check("the answer's token is kept", readVisitorToken(storage, "salon-a") === "v1.salon-a.x.mac");
check("per salon: another salon's chat does not reuse it", readVisitorToken(storage, "salon-b") === undefined);
rememberVisitorToken(storage, "salon-a", undefined);
check("an answer without a token (a signed-in client) keeps the stored one", readVisitorToken(storage, "salon-a") === "v1.salon-a.x.mac");
check("key names the salon", visitorTokenKey("abc") === "kira_chat_token:abc");

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};
check("blocked storage is not an error", readVisitorToken(throwing, "s") === undefined);
rememberVisitorToken(throwing, "s", "t");
check("blocked storage on write is not an error either", true);

const limit = { status: 429, message: "Has llegado al máximo de mensajes de hoy con la recepcionista. Puedes reservar desde esta página o llamar al salón." };
check("the daily limit is explained in the server's words", chatErrorText(limit) === limit.message);
check(
  "the per-minute limit says to wait",
  /espera un momento/i.test(chatErrorText({ status: 429, message: "ThrottlerException: Too Many Requests" })),
);
check(
  "anything else is the plain apology, without the server's details",
  chatErrorText({ status: 500, message: "Prisma error at ..." }).startsWith("Lo sentimos"),
);
check("same limit as the API", CHAT_MAX_MESSAGE === 1000);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
