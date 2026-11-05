/**
 * Sharing the salon page: the message and links, the address each QR code
 * opens, and the printable formats.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/share-page.spec.ts
 */
import {
  displayUrl,
  emailShareUrl,
  isPrintFormat,
  PRINT_FORMATS,
  printHeadline,
  printedCodesNote,
  qrServices,
  qrTargetUrl,
  shareFileName,
  shareMessage,
  whatsappShareUrl,
} from "./share-page";

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

const URL_ = "https://salon-lucia.kiraroom.net";
const msg = shareMessage("Salón Lucía", URL_);
check("the message names the salon and carries the link", msg.includes("Salón Lucía") && msg.endsWith(URL_), msg);

const wa = whatsappShareUrl("Salón Lucía", URL_);
check("WhatsApp gets the message, encoded", wa.startsWith("https://wa.me/?text=") && decodeURIComponent(wa.split("text=")[1]) === msg, wa);

const mail = emailShareUrl("Salón Lucía", URL_);
check("the email has a subject and the link in the body", mail.startsWith("mailto:?subject=") && decodeURIComponent(mail).includes(URL_), mail);

check("a QR for the salon opens its page", qrTargetUrl(URL_) === `${URL_}/`, qrTargetUrl(URL_));
check(
  "a QR for a professional opens it with her chosen",
  qrTargetUrl(URL_, { professionalId: "p-1" }) === `${URL_}/?professionalId=p-1`,
  qrTargetUrl(URL_, { professionalId: "p-1" }),
);
check(
  "and on the old address, the filter goes after the path",
  qrTargetUrl("https://app.kiraroom.net/sites/salon-lucia", { serviceId: "s-1" }) ===
    "https://app.kiraroom.net/sites/salon-lucia?serviceId=s-1",
  qrTargetUrl("https://app.kiraroom.net/sites/salon-lucia", { serviceId: "s-1" }),
);

check("the printed address drops the scheme", displayUrl(`${URL_}/`) === "salon-lucia.kiraroom.net", displayUrl(`${URL_}/`));

check("four printable formats", PRINT_FORMATS.length === 4);
check("cards come 10 to a sheet, stickers 12", PRINT_FORMATS.find((f) => f.id === "tarjetas")?.perSheet === 10 && PRINT_FORMATS.find((f) => f.id === "pegatinas")?.perSheet === 12);
check("an unknown format is refused", !isPrintFormat("poster") && isPrintFormat("cartel-a4"));

check("headline for the salon", printHeadline({}) === "Reserva tu cita");
check("headline for a professional", printHeadline({ professional: "Ana" }) === "Reserva tu cita con Ana");
check("headline for a service", printHeadline({ service: "Corte de pelo" }) === "Reserva Corte de pelo");

check("file names are plain", shareFileName("Salón-Lucía", "qr", "png", "Ana García") === "qr-salon-lucia-ana-garcia.png", shareFileName("Salón-Lucía", "qr", "png", "Ana García"));
check("and without a suffix", shareFileName("salon-lucia", "redes", "png") === "redes-salon-lucia.png");

check(
  "QR codes only for services bookable online",
  qrServices([
    { id: "a", isActive: true, isOnlineBookable: true },
    { id: "b", isActive: true, isOnlineBookable: false },
    { id: "c", isActive: false, isOnlineBookable: true },
    { id: "d" },
  ])
    .map((s: any) => s.id)
    .join() === "a,d",
);
check(
  "own domain: printed codes depend on keeping it",
  /mientras mantengas ese dominio/.test(printedCodesNote({ url: "https://reservas.salonlucia.es", ownDomain: true })),
);
check(
  "KiraRoom address: printed codes keep working",
  /seguirán funcionando/.test(printedCodesNote({ url: "https://salon-lucia.kiraroom.net", ownDomain: false })),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
