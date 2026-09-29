import { FAQService } from "./faq.service";

/**
 * The FAQ service seeded eight invented FAQs under salonId "default" and gave
 * every salon those plus any FAQ anyone created (also filed under "default").
 * Once FAQs reached the system prompt, every salon's receptionist told its
 * clients 9:00-18:00 opening hours, Visa / Mastercard / American Express,
 * discounts for regulars and a "(555) 123-4567" phone number -- none of it
 * the salon's.
 */
describe("FAQService", () => {
  const FAQ = { question: "¿Tenéis parking?", answer: "Sí, en la plaza.", category: "otros", keywords: ["parking"], priority: 1 };

  it("starts with no FAQs: nothing invented reaches a salon", async () => {
    const faqs = new FAQService();
    expect(await faqs.getFAQs("salon-a")).toEqual([]);
  });

  it("gives a salon only its own FAQs", async () => {
    const faqs = new FAQService();
    await faqs.createFAQ("salon-a", FAQ as any);

    expect((await faqs.getFAQs("salon-a")).map((f) => f.question)).toEqual(["¿Tenéis parking?"]);
    expect(await faqs.getFAQs("salon-b")).toEqual([]);
  });

  it("files a FAQ under the caller's salon, whatever the body says", async () => {
    const faqs = new FAQService();
    await faqs.createFAQ("salon-a", { ...FAQ, salonId: "default" } as any);

    expect(await faqs.getFAQs("salon-b")).toEqual([]);
    expect(await faqs.getFAQs("salon-a")).toHaveLength(1);
  });

  it("does not let another salon read, change or delete it", async () => {
    const faqs = new FAQService();
    const { id } = await faqs.createFAQ("salon-a", FAQ as any);

    expect(await faqs.getFAQ("salon-b", id)).toBeNull();
    expect(await faqs.updateFAQ("salon-b", id, { answer: "No." } as any)).toBeNull();
    expect(await faqs.deleteFAQ("salon-b", id)).toBe(false);
    expect((await faqs.getFAQ("salon-a", id))?.answer).toBe("Sí, en la plaza.");
  });

  it("keeps the salon when a FAQ is updated", async () => {
    const faqs = new FAQService();
    const { id } = await faqs.createFAQ("salon-a", FAQ as any);

    await faqs.updateFAQ("salon-a", id, { answer: "Ya no.", salonId: "default" } as any);

    expect(await faqs.getFAQs("salon-b")).toEqual([]);
    expect((await faqs.getFAQ("salon-a", id))?.answer).toBe("Ya no.");
  });
});
