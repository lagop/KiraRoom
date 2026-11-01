import "reflect-metadata";
import { ArgumentMetadata, ValidationPipe } from "@nestjs/common";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { FEATURE_KEY_METADATA } from "../common/decorators/feature.decorator";
import { GiftCardsController } from "./gift-cards.controller";
import { CreateGiftCardDto } from "./dto/create-gift-card.dto";
import { ListGiftCardsQueryDto } from "./dto/list-gift-cards-query.dto";

const handler = (name: keyof GiftCardsController) => (GiftCardsController.prototype as any)[name];
const roles = (name: keyof GiftCardsController) => Reflect.getMetadata(ROLES_KEY, handler(name));
const feature = (name: keyof GiftCardsController) =>
  Reflect.getMetadata(FEATURE_KEY_METADATA, handler(name)) ??
  Reflect.getMetadata(FEATURE_KEY_METADATA, GiftCardsController);

describe("GiftCardsController access", () => {
  it("the till (whole team) looks cards up and redeems them, whatever the plan", () => {
    for (const name of ["lookup", "redeem"] as const) {
      expect(roles(name)).toEqual(["owner", "admin", "staff"]);
      // Clients paid for their cards: a downgrade must not block spending them.
      expect(feature(name)).toBeUndefined();
    }
  });

  it("listing, detail, issuing, editing and deactivating are for managers on a plan with gift cards", () => {
    for (const name of ["findAll", "findOne", "create", "update", "remove"] as const) {
      expect(roles(name)).toEqual(["owner", "admin"]);
      expect(feature(name)).toBe("gift_cards");
    }
  });
});

describe("gift card request validation", () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
  const query = (value: Record<string, string>) =>
    pipe.transform(value, { type: "query", metatype: ListGiftCardsQueryDto } as ArgumentMetadata);
  const body = (value: Record<string, unknown>) =>
    pipe.transform(value, { type: "body", metatype: CreateGiftCardDto } as ArgumentMetadata);

  it("parses good paging", async () => {
    await expect(query({ page: "2", limit: "50", isActive: "false" })).resolves.toEqual(
      expect.objectContaining({ page: 2, limit: 50, isActive: false }),
    );
  });

  it.each([
    [{ page: "abc" }],
    [{ page: "0" }],
    [{ page: "1.5" }],
    [{ limit: "101" }],
    [{ limit: "-1" }],
    [{ isActive: "maybe" }],
  ])("a bad query %j is a 400, not a 500", async (q) => {
    await expect(query(q)).rejects.toMatchObject({ status: 400 });
  });

  it("the create body takes the email checkbox and a date", async () => {
    await expect(
      body({ initialAmount: 2500, recipientEmail: "a@b.es", sendEmail: false, expiresAt: "2027-01-31" }),
    ).resolves.toEqual(expect.objectContaining({ sendEmail: false, expiresAt: "2027-01-31" }));
    await expect(body({ initialAmount: 50 })).rejects.toMatchObject({ status: 400 });
    await expect(body({ initialAmount: 2500, sendEmail: "yes" })).rejects.toMatchObject({ status: 400 });
  });
});
