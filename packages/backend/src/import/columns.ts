import { PHONE_PATTERN, normalizePhone } from "../common/phone";

/**
 * Reading other programs' exports.
 *
 * The importer only understood its own template (firstName, lastName,
 * email...): an export from Booksy, Treatwell, Fresha or a salon's Excel,
 * with "Nombre", "Apellidos", "Móvil", did not import a single row. It also
 * required an email, which most salons do not have for every client, and an
 * E.164 phone, so "600 11 22 33" was invalid.
 *
 * Headers are matched after lower-casing and removing accents, spaces and
 * punctuation, against the usual names in Spanish and English.
 */

export function headerKey(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const CLIENT_ALIASES: Record<string, string[]> = {
  firstName: ["firstname", "nombre", "nombres", "givenname", "primernombre"],
  lastName: ["lastname", "apellido", "apellidos", "surname", "familyname"],
  fullName: ["fullname", "nombrecompleto", "nombreyapellidos", "cliente", "client", "customer", "name"],
  phone: ["phone", "telefono", "telefonomovil", "movil", "mobile", "mobilephone", "celular", "tel", "phonenumber", "numerodetelefono", "whatsapp"],
  email: ["email", "mail", "correo", "correoelectronico", "emailaddress"],
  dateOfBirth: ["dateofbirth", "birthdate", "birthday", "fechadenacimiento", "nacimiento", "cumpleanos", "fechanacimiento"],
  notes: ["notes", "note", "notas", "nota", "observaciones", "comentarios", "comments"],
  gender: ["gender", "genero", "sexo"],
  action: ["action"],
};

const SERVICE_ALIASES: Record<string, string[]> = {
  name: ["name", "nombre", "servicio", "service", "nombredelservicio", "servicename", "tratamiento"],
  duration: ["duration", "duracion", "minutos", "minutes", "tiempo", "duracionmin", "durationmin"],
  price: ["price", "precio", "pvp", "importe", "tarifa", "precioeur", "priceeur"],
  category: ["category", "categoria", "familia", "tipo", "type", "grupo"],
  description: ["description", "descripcion", "detalle", "detalles"],
};

/** Which column of the file holds each field. */
function mapColumns(headers: string[], aliases: Record<string, string[]>): Record<string, string> {
  const found: Record<string, string> = {};
  for (const h of headers) {
    const key = headerKey(h);
    for (const [field, names] of Object.entries(aliases)) {
      if (!found[field] && names.includes(key)) found[field] = h;
    }
  }
  return found;
}

const cell = (row: Record<string, unknown>, col?: string) => (col ? String(row[col] ?? "").trim() : "");

export interface ClientRow {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  gender?: string;
  notes?: string;
  action: "insert" | "update" | "skip";
}

export function readClientRows(rows: Record<string, unknown>[], country = "ES"): ClientRow[] {
  const cols = mapColumns(Object.keys(rows[0] ?? {}), CLIENT_ALIASES);
  // A single "Nombre" column with no "Apellidos" next to it is the full name.
  const fullNameCol = cols.fullName ?? (!cols.lastName ? cols.firstName : undefined);
  return rows.map((row) => {
    let firstName = cell(row, cols.firstName);
    let lastName = cell(row, cols.lastName);
    if (fullNameCol) {
      const parts = cell(row, fullNameCol).split(/\s+/).filter(Boolean);
      firstName = parts.shift() ?? "";
      lastName = parts.join(" ");
    }
    const rawPhone = cell(row, cols.phone);
    const action = cell(row, cols.action).toLowerCase();
    return {
      firstName,
      lastName,
      email: cell(row, cols.email).toLowerCase() || undefined,
      phone: rawPhone ? normalizePhone(rawPhone, country) : undefined,
      dateOfBirth: parseDate(cell(row, cols.dateOfBirth)),
      gender: cell(row, cols.gender) || undefined,
      notes: cell(row, cols.notes) || undefined,
      action: action === "update" || action === "skip" ? action : "insert",
    };
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function clientRowErrors(row: ClientRow, rawDate?: string): { col: string; msg: string }[] {
  const errors: { col: string; msg: string }[] = [];
  if (!row.firstName) errors.push({ col: "nombre", msg: "Falta el nombre" });
  if (!row.phone && !row.email) errors.push({ col: "teléfono", msg: "Hace falta un teléfono o un email" });
  if (row.email && !EMAIL_RE.test(row.email)) errors.push({ col: "email", msg: "Email no válido" });
  if (row.phone && !PHONE_PATTERN.test(row.phone)) errors.push({ col: "teléfono", msg: "Teléfono no válido" });
  if (rawDate && !row.dateOfBirth) errors.push({ col: "fecha de nacimiento", msg: "Fecha no reconocida" });
  return errors;
}

/** yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy or dd.mm.yyyy -> yyyy-mm-dd. */
export function parseDate(value: string): string | undefined {
  if (!value) return undefined;
  let m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += y > 30 ? 1900 : 2000;
  } else return undefined;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return undefined;
  return date.toISOString().slice(0, 10);
}

export interface ServiceRow {
  name: string;
  duration?: number;
  price?: number;
  category: "hair" | "nails" | "facial" | "massage" | "body" | "other";
  description?: string;
}

export function readServiceRows(rows: Record<string, unknown>[]): { row: ServiceRow; raw: { duration: string; price: string } }[] {
  const cols = mapColumns(Object.keys(rows[0] ?? {}), SERVICE_ALIASES);
  return rows.map((r) => {
    const name = cell(r, cols.name);
    const rawDuration = cell(r, cols.duration);
    const rawPrice = cell(r, cols.price);
    return {
      row: {
        name,
        duration: parseDuration(rawDuration),
        price: parsePrice(rawPrice),
        category: categoryFor(`${cell(r, cols.category)} ${name}`),
        description: cell(r, cols.description) || undefined,
      },
      raw: { duration: rawDuration, price: rawPrice },
    };
  });
}

export function serviceRowErrors(row: ServiceRow, raw: { duration: string; price: string }): { col: string; msg: string }[] {
  const errors: { col: string; msg: string }[] = [];
  if (!row.name) errors.push({ col: "nombre", msg: "Falta el nombre del servicio" });
  if (!row.duration || row.duration < 5 || row.duration > 600) {
    errors.push({ col: "duración", msg: raw.duration ? "Duración no reconocida (minutos)" : "Falta la duración" });
  }
  if (row.price === undefined || row.price < 0) {
    errors.push({ col: "precio", msg: raw.price ? "Precio no reconocido" : "Falta el precio" });
  }
  return errors;
}

/** "45", "45 min", "1h", "1 h 30 min", "1:30", "90'" -> minutes. */
export function parseDuration(value: string): number | undefined {
  const v = value.toLowerCase().replace(",", ".").trim();
  if (!v) return undefined;
  let m = v.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const hours = v.match(/(\d+(?:\.\d+)?)\s*h/);
  const mins = v.match(/(\d+)\s*(?:m|min|mins|minutos|minutes|')(?![a-z])/);
  if (hours || mins) return Math.round((hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0));
  m = v.match(/^(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

/** "25", "25,50", "25.50 €", "€ 1.200,00" -> euros. */
export function parsePrice(value: string): number | undefined {
  let v = value.replace(/[€\s]|eur/gi, "");
  if (!v) return undefined;
  if (/,\d{1,2}$/.test(v)) v = v.replace(/\./g, "").replace(",", ".");
  else v = v.replace(/,/g, "");
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
}

const CATEGORY_WORDS: [ServiceRow["category"], RegExp][] = [
  ["nails", /u[nñ]a|manicura|pedicura|nail|gel|semipermanente|acrilic/],
  ["massage", /masaje|massage|drenaje|quiromasaje/],
  ["facial", /facial|cara|rostro|cejas|pesta[nñ]as|limpieza de cutis|microblading|lifting/],
  ["body", /corporal|depila|cera|laser|l[aá]ser|body|presoterapia|anticelul/],
  ["hair", /pelo|cabello|corte|color|tinte|mechas|peinado|brushing|keratina|alisado|barba|hair|balayage|recogido|permanente/],
];

export function categoryFor(text: string): ServiceRow["category"] {
  const t = text.toLowerCase();
  for (const [category, re] of CATEGORY_WORDS) if (re.test(t)) return category;
  return "other";
}

// ---- Appointments -----------------------------------------------------------

const APPOINTMENT_ALIASES: Record<string, string[]> = {
  date: ["date", "fecha", "dia", "day", "fechacita", "fechadelacita", "appointmentdate", "fechayhora", "fechahora", "datetime", "startdate"],
  time: ["time", "hora", "horainicio", "horadeinicio", "inicio", "horacita", "starttime", "start", "desde"],
  fullName: ["cliente", "client", "customer", "nombrecliente", "nombredelcliente", "clientname", "customername", "nombrecompleto", "fullname"],
  firstName: ["nombre", "firstname"],
  lastName: ["apellidos", "apellido", "lastname", "surname"],
  phone: CLIENT_ALIASES.phone,
  email: CLIENT_ALIASES.email,
  service: ["servicio", "service", "servicios", "services", "tratamiento", "nombredelservicio", "servicename"],
  professional: ["profesional", "professional", "empleado", "empleada", "employee", "staff", "estilista", "trabajador", "trabajadora", "recurso", "resource", "atendidopor", "staffmember", "peluquero", "peluquera"],
  duration: SERVICE_ALIASES.duration,
  price: SERVICE_ALIASES.price,
  notes: CLIENT_ALIASES.notes,
  status: ["estado", "status"],
};

export interface AppointmentRow {
  date?: string; // yyyy-mm-dd
  time?: string; // HH:MM
  clientName: string;
  firstName: string;
  lastName: string;
  phone?: string;
  email?: string;
  service: string;
  professional: string;
  duration?: number;
  price?: number;
  notes?: string;
  /** The other program marked it cancelled or a no-show. */
  cancelled: boolean;
}

export function readAppointmentRows(
  rows: Record<string, unknown>[],
  country = "ES",
): { row: AppointmentRow; raw: { date: string; time: string; duration: string; price: string } }[] {
  const cols = mapColumns(Object.keys(rows[0] ?? {}), APPOINTMENT_ALIASES);
  // "Nombre" with no "Apellidos" next to it is the client's full name.
  const fullNameCol = cols.fullName ?? (!cols.lastName ? cols.firstName : undefined);
  return rows.map((r) => {
    let firstName = cell(r, cols.firstName);
    let lastName = cell(r, cols.lastName);
    if (fullNameCol) {
      const parts = cell(r, fullNameCol).split(/\s+/).filter(Boolean);
      firstName = parts.shift() ?? "";
      lastName = parts.join(" ");
    }
    // "05/10/2026 10:30" in one column, or date and time apart.
    const rawDate = cell(r, cols.date);
    const [datePart, ...rest] = rawDate.split(/[\sT]+/);
    const rawTime = cell(r, cols.time) || rest.join(" ");
    const rawPhone = cell(r, cols.phone);
    const rawDuration = cell(r, cols.duration);
    const rawPrice = cell(r, cols.price);
    return {
      row: {
        date: parseDate(datePart ?? ""),
        time: parseTime(rawTime),
        clientName: [firstName, lastName].filter(Boolean).join(" "),
        firstName,
        lastName,
        phone: rawPhone ? normalizePhone(rawPhone, country) : undefined,
        email: cell(r, cols.email).toLowerCase() || undefined,
        service: cell(r, cols.service),
        professional: cell(r, cols.professional),
        duration: parseDuration(rawDuration),
        price: parsePrice(rawPrice),
        notes: cell(r, cols.notes) || undefined,
        cancelled: /cancel|anulad|no.?show|no.?present|no.?vino|ausente/i.test(cell(r, cols.status)),
      },
      raw: { date: rawDate, time: rawTime, duration: rawDuration, price: rawPrice },
    };
  });
}

/** "10:30", "10.30", "10h30", "10:30:00", "9:00 AM", "10 h" -> "HH:MM". */
export function parseTime(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  const m = v.match(/^(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?(?::\d{2})?\s*(am|pm|a\.\s?m\.|p\.\s?m\.)?\s*h?$/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = m[3]?.replace(/[.\s]/g, "");
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Lower case, no accents, single spaces: how names are compared. */
export function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The one item whose name matches: exactly, or else as the only one that
 * contains the text or is contained in it, or else the only one with all its
 * words. Null when none or ambiguous.
 */
export function matchByName<T>(text: string, items: T[], names: (item: T) => string[]): T | null {
  const found = nameCandidates(text, items, names);
  return found.length === 1 ? found[0] : null;
}

/** The items of the first rule that matches any (see matchByName); several = ambiguous. */
export function nameCandidates<T>(text: string, items: T[], names: (item: T) => string[]): T[] {
  const key = nameKey(text);
  if (!key) return [];
  const exact = items.filter((i) => names(i).some((n) => nameKey(n) === key));
  if (exact.length > 0) return exact;
  const partial = items.filter((i) =>
    names(i).some((n) => {
      const k = nameKey(n);
      return k.length >= 3 && key.length >= 3 && (k.includes(key) || key.includes(k));
    }),
  );
  if (partial.length > 0) return partial;
  // Every word, in any order: "Corte mujer" is "Corte de cabello mujer".
  const words = key.split(" ").filter((w) => w.length >= 3);
  if (words.length === 0) return [];
  return items.filter((i) =>
    names(i).some((n) => {
      const other = nameKey(n).split(" ");
      return words.every((w) => other.includes(w));
    }),
  );
}
