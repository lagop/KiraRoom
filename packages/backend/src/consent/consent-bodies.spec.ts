import { ConsentController, ConsentFormsController } from "./consent.controller";
import { CreateConsentFormDto, RevokeConsentDto, SignConsentDto, UpdateConsentFormDto } from "./consent.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

const uuid = (first: number) => `${first}f1c2a9e-8b7d-4c6e-9a5f-1b2c3d4e5f60`;

/** What app/dashboard/settings/consent-forms/page.tsx saves. */
const panelForm = {
  name: "Tinte: prueba de alergia",
  description: "",
  fields: [
    { id: "f_1", type: "info", label: "Información legal", required: false },
    { id: "f_2", type: "boolean", label: "He hecho la prueba de alergia", required: true },
    { id: "f_3", type: "select", label: "Tipo de piel", options: ["Normal", "Sensible"] },
  ],
  serviceIds: [uuid(1)],
};

describe("consent bodies", () => {
  it("are validated classes, not any", () => {
    expect(bodyMetatype(ConsentFormsController, "create")).toBe(CreateConsentFormDto);
    expect(bodyMetatype(ConsentFormsController, "update")).toBe(UpdateConsentFormDto);
    expect(bodyMetatype(ConsentController, "sign")).toBe(SignConsentDto);
    expect(bodyMetatype(ConsentController, "revoke")).toBe(RevokeConsentDto);
  });

  it("keeps the panel's form and drops the rest", async () => {
    const create = bodyParser(ConsentFormsController, "create");
    expect(await create(panelForm)).toEqual(panelForm);
    const out = await create({ ...panelForm, tenantId: uuid(2), purpose: "marketing", version: 99, isActive: false });
    expect([out.tenantId, out.purpose, out.version, out.isActive]).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("refuses bad fields and service ids", async () => {
    const create = bodyParser(ConsentFormsController, "create");
    await expect(create({ ...panelForm, fields: [] })).rejects.toBeDefined();
    await expect(create({ ...panelForm, fields: [{ id: "f", type: "script", label: "x" }] })).rejects.toBeDefined();
    await expect(create({ ...panelForm, fields: "nope" })).rejects.toBeDefined();
    await expect(create({ ...panelForm, serviceIds: ["svc"] })).rejects.toBeDefined();
    await expect(create({ ...panelForm, name: "x".repeat(201) })).rejects.toBeDefined();
  });

  it("an edit takes any subset", async () => {
    const update = bodyParser(ConsentFormsController, "update");
    expect(await update({ name: "Nuevo nombre" })).toEqual({ name: "Nuevo nombre" });
  });

  it("a public signature names ids, not filters, and a real signature", async () => {
    const sign = bodyParser(ConsentController, "sign");
    const body = {
      tenantId: uuid(1),
      clientId: uuid(2),
      formId: uuid(3),
      responses: { f_2: true },
      signatureName: "Ana López",
    };
    expect(await sign(body)).toEqual(body);
    await expect(sign({ ...body, clientId: { not: "" } })).rejects.toBeDefined();
    await expect(sign({ ...body, signatureName: "A" })).rejects.toBeDefined();
    await expect(sign({ ...body, responses: "yes" })).rejects.toBeDefined();
  });

  it("a revocation reason is capped", async () => {
    const revoke = bodyParser(ConsentController, "revoke");
    expect(await revoke({ reason: "Lo pidió la clienta" })).toEqual({ reason: "Lo pidió la clienta" });
    expect(await revoke(undefined)).toEqual({});
    await expect(revoke({ reason: "x".repeat(2001) })).rejects.toBeDefined();
  });
});
