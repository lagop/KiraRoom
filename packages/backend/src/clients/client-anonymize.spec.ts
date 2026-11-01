import { Prisma } from "@prisma/client";
import { SYSTEM_CONSENT_PURPOSES } from "../consent/marketing-consent";
import {
  ANONYMIZED_FIRST_NAME,
  ANONYMIZED_LAST_NAME,
  ANONYMIZED_NAME,
  CLIENT_COLUMN_ON_ERASURE,
  CLIENT_LINKED_MODELS_KEPT,
  anonymizeClients,
  anonymizedClientData,
  whatsappVisitorKeys,
} from "./client-anonymize";
import { CLIENT_HEALTH_COLUMNS, CLIENT_SECRET_COLUMNS } from "./client-select";

/** Models that reference a client: a clientId column or a to-one relation. */
function clientLinkedModels(): string[] {
  return Prisma.dmmf.datamodel.models
    .filter((m) => m.name !== "Client")
    .filter((m) =>
      m.fields.some(
        (f) => f.name === "clientId" || (f.kind === "object" && f.type === "Client" && !f.isList),
      ),
    )
    .map((m) => m.name);
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

interface Call {
  model: string;
  method: string;
  args: any;
}

/** A transaction client that records every call; findMany answers from `rows`. */
function recordingTx(rows: Record<string, any[]> = {}) {
  const calls: Call[] = [];
  const tx: any = new Proxy(
    {},
    {
      get(_t, model: string) {
        return new Proxy(
          {},
          {
            get(_m, method: string) {
              return async (args: any) => {
                calls.push({ model, method, args });
                if (method === "findMany") return rows[model] ?? [];
                if (method === "updateMany" && model === "client") return { count: (rows.client ?? []).length };
                return { count: 0 };
              };
            },
          },
        );
      },
    },
  );
  return { tx, calls };
}

describe("client columns on erasure", () => {
  const columns = Object.values(Prisma.ClientScalarFieldEnum) as string[];
  const erased = Object.entries(CLIENT_COLUMN_ON_ERASURE)
    .filter(([, how]) => how === "erased")
    .map(([column]) => column);

  it("every Client column has a decision, and only real columns are listed", () => {
    expect(columns.filter((c) => !(c in CLIENT_COLUMN_ON_ERASURE))).toEqual([]);
    expect(Object.keys(CLIENT_COLUMN_ON_ERASURE).filter((c) => !columns.includes(c))).toEqual([]);
  });

  it("anonymizedClientData resets exactly the erased columns", () => {
    expect(Object.keys(anonymizedClientData()).sort()).toEqual([...erased].sort());
  });

  it("sign-in secrets and health data are always erased", () => {
    for (const column of [...CLIENT_SECRET_COLUMNS, ...CLIENT_HEALTH_COLUMNS]) {
      expect(CLIENT_COLUMN_ON_ERASURE[column]).toBe("erased");
    }
  });

  it("what an anonymised client looks like", () => {
    const data = anonymizedClientData();
    expect(`${data.firstName} ${data.lastName}`).toBe(ANONYMIZED_NAME);
    expect(data).toMatchObject({
      email: null,
      phone: null,
      taxId: null,
      dateOfBirth: null,
      profileImage: null,
      allergies: [],
      medicalConditions: [],
      notes: null,
      tags: [],
      communicationPreferences: {},
      passwordHash: null,
      passwordResetToken: null,
      status: "inactive",
      tokenVersion: { increment: 1 },
    });
  });
});

describe("whatsappVisitorKeys", () => {
  it("matches the keys the WhatsApp receptionist stores", () => {
    expect(whatsappVisitorKeys("+34 600 11 22 33")).toEqual(["whatsapp-34600112233"]);
    expect(whatsappVisitorKeys("0034600112233")).toEqual(["whatsapp-34600112233"]);
    expect(whatsappVisitorKeys("600112233")).toEqual(["whatsapp-600112233", "whatsapp-34600112233"]);
    expect(whatsappVisitorKeys(null)).toEqual([]);
    expect(whatsappVisitorKeys("12")).toEqual([]);
  });
});

describe("anonymizeClients", () => {
  const TENANT = "tenant-1";
  const her = { id: "client-1", email: "Ana@Example.com", phone: "600112233" };

  async function run(rows: Record<string, any[]> = { client: [her] }, ids = [her.id]) {
    const { tx, calls } = recordingTx(rows);
    const summary = await anonymizeClients(tx, TENANT, ids);
    return { calls, summary };
  }

  it("every model linked to a client is either cleaned here or explicitly kept", async () => {
    const { calls } = await run();
    const touched = new Set(
      calls.filter((c) => c.method !== "findMany").map((c) => c.model),
    );
    const kept = new Set<string>(CLIENT_LINKED_MODELS_KEPT);
    const unhandled = clientLinkedModels().filter((m) => !touched.has(lowerFirst(m)) && !kept.has(m));
    expect(unhandled).toEqual([]);
    // And nothing listed as kept is touched after all.
    for (const m of CLIENT_LINKED_MODELS_KEPT) expect(touched.has(lowerFirst(m))).toBe(false);
  });

  it("every query is limited to the salon", async () => {
    const { calls } = await run();
    for (const call of calls) {
      if (call.model === "authSession") continue; // keyed by the client ids found in the salon
      const where = call.args.where;
      const scoped = where.tenantId === TENANT || where.campaign?.tenantId === TENANT;
      expect({ call: `${call.model}.${call.method}`, scoped }).toEqual({ call: `${call.model}.${call.method}`, scoped: true });
    }
  });

  it("only acts on the clients of the salon it found", async () => {
    const { calls, summary } = await run({ client: [] }, ["other-salon-client"]);
    expect(summary.clients).toBe(0);
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual(["client.findMany"]);
  });

  it("erases the profile and ends her sessions", async () => {
    const { calls, summary } = await run();
    expect(summary.clients).toBe(1);
    const update = calls.find((c) => c.model === "client" && c.method === "updateMany")!;
    expect(update.args.where).toEqual({ tenantId: TENANT, id: { in: [her.id] } });
    expect(update.args.data).toEqual(anonymizedClientData());
    expect(update.args.data.firstName).toBe(ANONYMIZED_FIRST_NAME);
    expect(update.args.data.lastName).toBe(ANONYMIZED_LAST_NAME);
    const sessions = calls.find((c) => c.model === "authSession")!;
    expect(sessions.args.where).toMatchObject({ subjectType: "client", subjectId: { in: [her.id] }, revokedAt: null });
  });

  it("deletes marketing choices and empties signed consents", async () => {
    const { calls } = await run();
    const deleted = calls.find((c) => c.model === "consent" && c.method === "deleteMany")!;
    expect(deleted.args.where.form).toEqual({ purpose: { in: SYSTEM_CONSENT_PURPOSES } });
    const updated = calls.find((c) => c.model === "consent" && c.method === "updateMany")!;
    expect(updated.args.data).toEqual({ responses: {}, signatureName: ANONYMIZED_NAME, signatureIpHash: "" });
  });

  it("deletes her receptionist chats, including WhatsApp ones not linked to her", async () => {
    const { calls } = await run();
    const chats = calls.filter((c) => c.model === "chatConversation" && c.method === "deleteMany");
    expect(chats[0].args.where).toEqual({ tenantId: TENANT, clientId: { in: [her.id] } });
    expect(chats[1].args.where.OR).toEqual([
      { context: { path: ["visitorKey"], equals: "whatsapp-600112233" } },
      { context: { path: ["visitorKey"], equals: "whatsapp-34600112233" } },
    ]);
  });

  it("matches her email as stored and lower-cased for campaign events and gift cards", async () => {
    const { calls } = await run();
    const events = calls.find((c) => c.model === "emailCampaignAnalytics")!;
    expect(events.args.where.email.in).toEqual(["Ana@Example.com", "ana@example.com"]);
    const cards = calls.find((c) => c.model === "giftCard")!;
    expect(cards.args.data).toEqual({ recipientName: null, recipientEmail: null, message: null });
  });

  it("keeps appointments but clears the free text about her", async () => {
    const { calls } = await run();
    const appts = calls.filter((c) => c.model === "appointment");
    expect(appts.map((c) => c.method)).toEqual(["updateMany"]);
    expect(appts[0].args.data).toEqual({ notes: null, internalNotes: null, address: null, review: null, feedback: {} });
    // Invoices are never touched: they keep their own recipient snapshot.
    expect(calls.some((c) => c.model === "invoice")).toBe(false);
  });

  it("a client with no phone or email skips the lookups by them", async () => {
    const { calls } = await run({ client: [{ id: "c2", email: null, phone: null }] }, ["c2"]);
    expect(calls.filter((c) => c.model === "chatConversation")).toHaveLength(1);
    expect(calls.some((c) => c.model === "emailCampaignAnalytics")).toBe(false);
  });
});
