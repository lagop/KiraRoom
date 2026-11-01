/**
 * Does a WhatsApp message ask to stop the salon's promotions?
 *
 * It used to match only a body that was exactly "baja", "stop" or
 * "unsubscribe": "Baja", "BAJA." or "quiero darme de baja" went to the
 * receptionist and the client kept getting promotions. Now the text is
 * folded (case, accents, punctuation) and the words are looked for anywhere,
 * as whole words: "bajada" and "rebaja" are not "baja".
 *
 * "Estoy de baja" and "baja médica / laboral / por maternidad" are sick or
 * parental leave in Spain -- a reason to move an appointment, not to
 * unsubscribe -- and are not taken as a request.
 *
 * `only` says the message is just the request ("Baja", "quiero darme de baja
 * por favor"): anything else in it (a question about an appointment) still
 * goes to the receptionist.
 */
const STOP_WORDS = new Set(["baja", "stop", "unsubscribe"]);

/** Leave, not unsubscribing: "baja medica", "baja laboral", "baja por maternidad". */
const LEAVE_AFTER = new Set(["medica", "laboral", "maternal", "maternidad", "paternidad", "temporal", "por"]);

/** "Estoy de baja", "sigo de baja", "está de baja": on leave. */
const LEAVE_BEFORE = new Set(["estoy", "esta", "estas", "estamos", "estan", "estar", "estado", "sigo", "sigue", "seguir"]);

/** Words that can sit around the request without adding a question. */
const FILLER = new Set([
  "hola", "buenas", "buenos", "dias", "tardes", "noches",
  "quiero", "quisiera", "queria", "me", "darme", "dar", "dame", "dadme", "denme", "de", "la", "el", "los", "las",
  "por", "favor", "porfa", "porfavor", "please", "gracias", "ya", "no", "mas",
  "mensajes", "promociones", "publicidad", "ofertas", "whatsapp", "lista", "todo", "todos",
  "y", "a", "esto", "estos", "este", "eso", "sms", "ok",
]);

export function foldText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function optOutIntent(body: string | null | undefined): { optOut: boolean; only: boolean } {
  const words = foldText(body ?? "").split(" ").filter(Boolean);
  let optOut = false;
  words.forEach((word, i) => {
    if (!STOP_WORDS.has(word)) return;
    if (word === "baja") {
      const before = words[i - 1] === "de" ? words[i - 2] : words[i - 1];
      if (LEAVE_BEFORE.has(before ?? "")) return;
      if (LEAVE_AFTER.has(words[i + 1] ?? "")) {
        // "baja por favor" is a request; "baja por maternidad" is leave.
        if (words[i + 1] !== "por" || !["favor", "fa"].includes(words[i + 2] ?? "")) return;
      }
    }
    optOut = true;
  });
  if (!optOut) return { optOut: false, only: false };
  const only = words.every((w) => STOP_WORDS.has(w) || FILLER.has(w));
  return { optOut, only };
}
