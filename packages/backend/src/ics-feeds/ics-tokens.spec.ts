import { BadRequestException } from "@nestjs/common";
import { IcsController } from "./ics.controller";

/**
 * The calendar-feeds page handed out ?token=REEMPLAZAR_CON_TOKEN and pointed
 * at GET /ics/tokens as "coming soon". The endpoint now exists; its tokens
 * must be exactly what the public feeds accept.
 */

const SECRET = "ics-secret";

function build() {
  const prisma: any = {
    tenant: { findUnique: async ({ where }: any) => (where.id === "t1" ? { slug: "salon-ana" } : null) },
    professional: {
      findMany: async ({ where }: any) =>
        where.tenantId === "t1" ? [{ id: "pro-1", firstName: "Ana", lastName: "López" }] : [],
    },
  };
  const config: any = { get: (k: string) => (k === "ICS_TOKEN_SECRET" ? SECRET : undefined) };
  return new IcsController(prisma, config);
}

describe("GET /ics/tokens", () => {
  it("signs the caller's salon and professionals", async () => {
    const out = await build().tokens({ user: { tenantId: "t1" } });

    expect(out.salon).toEqual({
      slug: "salon-ana",
      token: IcsController.signToken("salon:salon-ana", SECRET),
    });
    expect(out.professionals).toEqual([
      { id: "pro-1", name: "Ana López", token: IcsController.signToken("professional:pro-1", SECRET) },
    ]);
  });

  it("issues tokens the feeds accept, and only those", () => {
    const controller = build() as any;
    const good = IcsController.signToken("salon:salon-ana", SECRET);

    expect(() => controller.verifyToken("salon:salon-ana", good)).not.toThrow();
    expect(() => controller.verifyToken("salon:salon-ana", "REEMPLAZAR_CON_TOKEN")).toThrow(BadRequestException);
    expect(() => controller.verifyToken("salon:other", good)).toThrow(BadRequestException);
  });
});
