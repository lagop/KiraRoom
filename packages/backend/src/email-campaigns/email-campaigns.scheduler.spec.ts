import { EmailCampaignsScheduler } from "./email-campaigns.scheduler";

/**
 * The re-engagement email's placeholders. The salon writes the template; the
 * values come from data (a client's name from sign-up or an import), so in
 * the HTML they are escaped. They used to be inserted as they were.
 */
describe("EmailCampaignsScheduler re-engagement content", () => {
  const scheduler = new EmailCampaignsScheduler({} as any, {} as any, {} as any, {} as any, {} as any);
  const build = (campaign: any, client: any) => (scheduler as any).buildReengagementEmailContent(campaign, client);

  const campaign = {
    subject: "{{clientName}}, te echamos de menos en {{salonName}}",
    content: "<p>Hola {{clientName}}, vuelve a {{salonName}} con {{discountValue}} ({{discountCode}})</p>",
    tenant: { name: "Ana & Eva" },
    linkedPromotion: { code: "VUELVE10", type: "FIXED", value: 10 },
  };

  it("escapes the values in the HTML and leaves the subject as plain text", () => {
    const out = build(campaign, { firstName: '<b title="x">Ana</b>', lastName: "Ruiz" });
    expect(out.html).not.toContain("<b ");
    expect(out.html).toContain("Hola &lt;b title=&quot;x&quot;&gt;Ana&lt;/b&gt; Ruiz");
    expect(out.html).toContain("vuelve a Ana &amp; Eva con 10 € (VUELVE10)");
    expect(out.subject).toBe('<b title="x">Ana</b> Ruiz, te echamos de menos en Ana & Eva');
  });

  it("inserts a value with replacement patterns ($&) as typed", () => {
    const out = build(campaign, { firstName: "$&$'", lastName: "" });
    expect(out.subject.startsWith("$&$', te echamos")).toBe(true);
    expect(out.html).toContain("Hola $&amp;$&#39;,");
  });

  it("leaves the discount placeholders when there is no promotion", () => {
    const out = build({ ...campaign, linkedPromotion: null }, { firstName: "Ana", lastName: "Ruiz" });
    expect(out.html).toContain("{{discountValue}} ({{discountCode}})");
  });
});
