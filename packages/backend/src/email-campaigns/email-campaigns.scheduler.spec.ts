import { EmailCampaignsScheduler } from "./email-campaigns.scheduler";

/**
 * The re-engagement email's placeholders. The salon writes the template; the
 * values come from data (a client's name from sign-up or an import), so in
 * the HTML they are escaped. They used to be inserted as they were.
 */
describe("EmailCampaignsScheduler re-engagement content", () => {
  const scheduler = new EmailCampaignsScheduler({} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const build = (campaign: any, client: any, now = new Date("2026-11-02T10:00:00Z")) =>
    (scheduler as any).buildReengagementEmailContent(campaign, client, now);

  const promotion = { code: "VUELVE10", type: "FIXED", value: 10, isActive: true, endDate: null, maxUses: null, usedCount: 0 };
  const campaign = {
    subject: "{{clientName}}, te echamos de menos en {{salonName}}",
    content: "<p>Hola {{clientName}}, vuelve a {{salonName}} con {{discountValue}} ({{discountCode}})</p>",
    tenant: { name: "Ana & Eva" },
    linkedPromotion: promotion,
  };

  it("escapes the values in the HTML and leaves the subject as plain text", () => {
    const out = build(campaign, { firstName: '<b title="x">Ana</b>', lastName: "Ruiz" });
    expect(out.html).not.toContain("<b ");
    expect(out.html).toContain("Hola &lt;b title=&quot;x&quot;&gt;Ana&lt;/b&gt; Ruiz");
    // 10 € the Spanish way: "10,00 €" (with a no-break space).
    expect(out.html).toMatch(/vuelve a Ana &amp; Eva con 10,00\s€ \(VUELVE10\)/);
    expect(out.subject).toBe('<b title="x">Ana</b> Ruiz, te echamos de menos en Ana & Eva');
  });

  it("inserts a value with replacement patterns ($&) as typed", () => {
    const out = build(campaign, { firstName: "$&$'", lastName: "" });
    expect(out.subject.startsWith("$&$', te echamos")).toBe(true);
    expect(out.html).toContain("Hola $&amp;$&#39;,");
  });

  describe("a promotion that can no longer be used", () => {
    const content =
      "<h1>¡Hola {{clientName}}!</h1><p>Hace tiempo que no te vemos.</p><p>Usa el código <b>{{discountCode}}</b> y llévate {{discountValue}}.</p><p>Te esperamos.</p>";
    const withPromo = (linkedPromotion: any) => ({
      ...campaign,
      subject: "¡Te echamos de menos! {{discountCode}}",
      content,
      linkedPromotion,
    });
    const cases: Array<[string, any]> = [
      ["deleted (the link is empty)", null],
      ["switched off", { ...promotion, isActive: false }],
      ["past its end date", { ...promotion, endDate: new Date("2026-10-31T00:00:00Z") }],
      ["used up", { ...promotion, maxUses: 5, usedCount: 5 }],
    ];
    for (const [label, linked] of cases) {
      it(`drops the promotion block when it is ${label}`, () => {
        const out = build(withPromo(linked), { firstName: "Ana", lastName: "Ruiz" });
        expect(out.html).not.toContain("{{");
        expect(out.html).not.toContain("VUELVE10");
        expect(out.html).not.toContain("Usa el código");
        expect(out.html).toContain("<h1>¡Hola Ana Ruiz!</h1><p>Hace tiempo que no te vemos.</p><p>Te esperamos.</p>");
        expect(out.subject).toBe("¡Te echamos de menos!");
      });
    }

    it("keeps the code on its last day", () => {
      const lastDay = { ...promotion, endDate: new Date("2026-11-02T00:00:00Z") };
      const out = build(withPromo(lastDay), { firstName: "Ana", lastName: "Ruiz" }, new Date("2026-11-02T20:00:00Z"));
      expect(out.html).toContain("<b>VUELVE10</b>");
      expect(out.subject).toBe("¡Te echamos de menos! VUELVE10");
    });
  });
});
