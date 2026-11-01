import {
  plainTextPart,
  promotionUsable,
  subjectWithoutPromotion,
  usablePromotionWhere,
  withPreheader,
  withoutPromotion,
} from "./campaign-content";
import { htmlToText } from "../common/html-to-text";

describe("promotionUsable", () => {
  const now = new Date("2026-11-02T10:00:00Z");
  const base = { isActive: true, endDate: null, maxUses: null, usedCount: 0 };

  it("is false when missing, switched off or used up", () => {
    expect(promotionUsable(null, now)).toBe(false);
    expect(promotionUsable(undefined, now)).toBe(false);
    expect(promotionUsable({ ...base, isActive: false }, now)).toBe(false);
    expect(promotionUsable({ ...base, maxUses: 3, usedCount: 3 }, now)).toBe(false);
    expect(promotionUsable({ ...base, maxUses: 3, usedCount: 2 }, now)).toBe(true);
  });

  it("counts the end date as a whole day", () => {
    expect(promotionUsable({ ...base, endDate: "2026-11-02T00:00:00.000Z" }, now)).toBe(true);
    expect(promotionUsable({ ...base, endDate: "2026-11-01T00:00:00.000Z" }, now)).toBe(false);
    expect(promotionUsable({ ...base, endDate: null }, now)).toBe(true);
  });

  it("has the same rule as a database filter", () => {
    expect(usablePromotionWhere(now)).toEqual({
      isActive: true,
      OR: [{ endDate: null }, { endDate: { gt: new Date("2026-11-01T10:00:00Z") } }],
    });
  });
});

describe("withoutPromotion", () => {
  it("removes the innermost element that mentions the code, and only it", () => {
    const html =
      '<div class="card"><p>Hola</p><p>Tu código: <strong>{{discountCode}}</strong></p><p>Hasta pronto</p></div>';
    expect(withoutPromotion(html)).toBe('<div class="card"><p>Hola</p><p>Hasta pronto</p></div>');
  });

  it("removes list items, headings and cells with a placeholder", () => {
    expect(withoutPromotion("<ul><li>Corte</li><li>{{discountValue}} de descuento</li></ul>")).toBe("<ul><li>Corte</li></ul>");
    expect(withoutPromotion("<h2>{{discountValue}} para ti</h2><p>Vuelve</p>")).toBe("<p>Vuelve</p>");
    expect(withoutPromotion("<table><tr><td>{{discountCode}}</td></tr></table>")).toBe("<table><tr></tr></table>");
  });

  it("does not take a placeholder outside a paragraph as part of the paragraphs around it", () => {
    const html = "<p>Hola</p>\nCódigo {{discountCode}}\n<p>Adiós</p>";
    expect(withoutPromotion(html)).toBe("<p>Hola</p>\n<p>Adiós</p>");
  });

  it("removes a plain-text line, and any placeholder left anywhere", () => {
    expect(withoutPromotion("Hola\nTu código es {{ discountCode }}\nAdiós")).toBe("Hola\nAdiós");
    expect(withoutPromotion('<img alt="{{discountCode}}" src="x.png">')).not.toContain("{{");
  });

  it("leaves an email without placeholders alone", () => {
    const html = "<p>Hola {{clientName}}</p>";
    expect(withoutPromotion(html)).toBe(html);
  });
});

describe("subjectWithoutPromotion", () => {
  it("drops the placeholder and the separator it leaves", () => {
    expect(subjectWithoutPromotion("¡Te echamos de menos! {{discountCode}}")).toBe("¡Te echamos de menos!");
    expect(subjectWithoutPromotion("Vuelve - {{discountValue}}")).toBe("Vuelve");
    expect(subjectWithoutPromotion("Vuelve ({{discountCode}}) cuando quieras")).toBe("Vuelve cuando quieras");
    expect(subjectWithoutPromotion("{{discountValue}}: vuelve")).toBe("vuelve");
  });
});

describe("withPreheader", () => {
  it("puts the preview text, hidden and escaped, at the top of the body", () => {
    const out = withPreheader("<html><body><p>Hola</p></body></html>", "Un 10 % <solo> hoy");
    expect(out).toMatch(/^<html><body><div style="display:none[^"]*">Un 10 % &lt;solo&gt; hoy<\/div><p>Hola<\/p>/);
  });

  it("prepends it to a fragment, and adds nothing without a preview text", () => {
    expect(withPreheader("<p>Hola</p>", "Hoy")).toMatch(/^<div style="display:none[^"]*">Hoy<\/div><p>Hola<\/p>$/);
    expect(withPreheader("<p>Hola</p>", "  ")).toBe("<p>Hola</p>");
    expect(withPreheader("<p>Hola</p>", null)).toBe("<p>Hola</p>");
  });
});

describe("plain-text part", () => {
  it("turns the salon's HTML into readable text, links with their address", () => {
    const html =
      "<html><head><style>p{color:red}</style></head><body>" +
      "<h1>Ofertas de otoño</h1><p>Hola&nbsp;Ana, tenemos <b>novedades</b>.</p>" +
      '<ul><li>Corte</li><li>Color &amp; mechas</li></ul>' +
      '<p><a href="https://salon.example.test/reservar?a=1&amp;b=2">Reserva aquí</a></p>' +
      '<div style="display:none">oculto</div></body></html>';
    expect(plainTextPart(html)).toBe(
      "Ofertas de otoño\n\nHola Ana, tenemos novedades.\n\n- Corte\n- Color & mechas\n\nReserva aquí (https://salon.example.test/reservar?a=1&b=2)",
    );
  });

  it("keeps line breaks and decodes numeric entities", () => {
    expect(htmlToText("Línea 1<br>Línea&#160;2<br/>&#x20AC;5")).toBe("Línea 1\nLínea 2\n€5");
  });

  it("does not repeat a link whose text is its address", () => {
    expect(htmlToText('<a href="https://x.example.test">https://x.example.test</a>')).toBe("https://x.example.test");
  });
});
