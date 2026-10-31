import { VirtualReceptionistController } from "./virtual-receptionist.controller";
import {
  CreateConversationBodyDto,
  CreateFaqItemDto,
  CreateLlmProviderConfigDto,
  TestLlmProviderDto,
  UpdateConversationBodyDto,
  UpdateFaqItemDto,
  UpdateLlmProviderConfigDto,
} from "./dto/receptionist-bodies.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

describe("virtual receptionist bodies", () => {
  it("are validated classes, not zod type aliases", () => {
    const C = VirtualReceptionistController;
    expect(bodyMetatype(C, "createFAQ")).toBe(CreateFaqItemDto);
    expect(bodyMetatype(C, "updateFAQ")).toBe(UpdateFaqItemDto);
    expect(bodyMetatype(C, "createConversation")).toBe(CreateConversationBodyDto);
    expect(bodyMetatype(C, "updateConversation")).toBe(UpdateConversationBodyDto);
    expect(bodyMetatype(C, "createLLMConfig")).toBe(CreateLlmProviderConfigDto);
    expect(bodyMetatype(C, "updateLLMConfig")).toBe(UpdateLlmProviderConfigDto);
    expect(bodyMetatype(C, "testLLMProvider")).toBe(TestLlmProviderDto);
  });

  it("a FAQ keeps its fields and drops the salon and id", async () => {
    const parse = bodyParser(VirtualReceptionistController, "createFAQ");
    const faq = { question: "¿Abrís los sábados?", answer: "Sí, de 9 a 14.", category: "horario", keywords: ["sábado"], priority: 3 };
    expect(await parse({ ...faq, salonId: uuid(1), id: "x", isActive: false })).toEqual(faq);
    await expect(parse({ ...faq, priority: 11 })).rejects.toBeDefined();
    await expect(parse({ ...faq, answer: "x".repeat(5001) })).rejects.toBeDefined();
  });

  it("a conversation names a client, never a salon", async () => {
    const parse = bodyParser(VirtualReceptionistController, "createConversation");
    const out = await parse({ clientId: uuid(1), channel: "web", salonId: uuid(2), tenantId: uuid(3) });
    expect(out).toEqual({ clientId: uuid(1), channel: "web" });
    await expect(parse({ clientId: uuid(1), channel: "sms" })).rejects.toBeDefined();
  });

  it("a conversation update takes its status and handoff only", async () => {
    const parse = bodyParser(VirtualReceptionistController, "updateConversation");
    const out = await parse({ status: "handoff", handoffAt: "2026-10-31T10:00:00Z", tenantId: uuid(1), context: {} });
    expect(out).toEqual({ status: "handoff", handoffAt: new Date("2026-10-31T10:00:00Z") });
    await expect(parse({ status: "deleted" })).rejects.toBeDefined();
  });

  it("the controller writes the caller's salon and only the fields sent", async () => {
    const conversations = { createConversation: jest.fn(async (d: any) => d), updateConversation: jest.fn(async () => ({})) };
    const faqs = { updateFAQ: jest.fn(async () => ({})) };
    const c = new VirtualReceptionistController(
      null as any, conversations as any, faqs as any, null as any, null as any, null as any, null as any,
    );
    await c.createConversation({ tenantId: "t1" }, Object.assign(new CreateConversationBodyDto(), { clientId: uuid(1), channel: "web" }));
    expect(conversations.createConversation).toHaveBeenCalledWith(expect.objectContaining({ salonId: "t1", tenantId: "t1" }));
    // In production (ES2022 class fields) every declared field is an own
    // property, undefined when not sent; none of them may reach the merge.
    await c.updateFAQ({ tenantId: "t1" }, "faq-1", Object.assign(new UpdateFaqItemDto(), { question: undefined, answer: "Nueva" }));
    expect(faqs.updateFAQ).toHaveBeenCalledWith("t1", "faq-1", { answer: "Nueva" });
  });

  it("an LLM test names a known provider", async () => {
    const parse = bodyParser(VirtualReceptionistController, "testLLMProvider");
    expect(await parse({ provider: "anthropic", apiKey: "k" })).toEqual({ provider: "anthropic", apiKey: "k" });
    await expect(parse({ provider: "skynet", apiKey: "k" })).rejects.toBeDefined();
  });
});
