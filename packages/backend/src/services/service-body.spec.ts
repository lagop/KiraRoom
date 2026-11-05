import "reflect-metadata";
import { ArgumentMetadata, BadRequestException, ValidationPipe } from "@nestjs/common";
import { CreateServiceDto, UpdateServiceDto } from "./dto";

/**
 * The bodies of `POST /services` and `PUT /services/:id`, through the
 * ValidationPipe as main.ts configures it.
 *
 * Prisma returns a service's price (a Decimal column) as a string, and the
 * panel sent it back as it came: every edit that did not retype the price
 * was a 400. And nothing bounded the numbers: 0 or 7.5 minutes, a negative
 * price, a 500 % deposit or a currency nothing else handles were all saved.
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });

const parse = (metatype: any, body: unknown) =>
  pipe.transform(body, { type: "body", metatype } as ArgumentMetadata);

async function messages(metatype: any, body: unknown): Promise<string[]> {
  try {
    await parse(metatype, body);
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse()["message"] as string[];
  }
  throw new Error("expected a 400");
}

const VALID = { name: "Corte", category: "hair", duration: 30, price: 20 };

describe("PUT /services/:id body", () => {
  it("takes the price as Prisma returns it, a decimal string", async () => {
    const out = await parse(UpdateServiceDto, { name: "Corte", price: "25.00", duration: "45" });
    expect(out).toMatchObject({ name: "Corte", price: 25, duration: 45 });
  });

  it("leaves out what was not sent", async () => {
    const out = await parse(UpdateServiceDto, { isActive: false });
    expect(out).toEqual(expect.objectContaining({ isActive: false }));
    expect(out.price).toBeUndefined();
    expect(out.name).toBeUndefined();
  });

  it("refuses an empty or blank name", async () => {
    expect(await messages(UpdateServiceDto, { name: "" })).toContain("Escribe el nombre del servicio");
    expect(await messages(UpdateServiceDto, { name: "   " })).toContain("Escribe el nombre del servicio");
  });

  it("refuses null for a column that cannot be empty", async () => {
    // @IsOptional() let null through to a NOT NULL column: a 500.
    await messages(UpdateServiceDto, { price: null });
    await messages(UpdateServiceDto, { duration: null });
    await messages(UpdateServiceDto, { name: null });
  });

  it("still lets null clear the nullable deposit fields", async () => {
    const out = await parse(UpdateServiceDto, { depositAmount: null, depositPercentage: null });
    expect(out).toMatchObject({ depositAmount: null, depositPercentage: null });
  });

  it("applies the same limits as creating", async () => {
    await messages(UpdateServiceDto, { duration: 0 });
    await messages(UpdateServiceDto, { price: -1 });
    await messages(UpdateServiceDto, { currency: "USD" });
  });
});

describe("POST /services body", () => {
  it("accepts a normal service and trims its name", async () => {
    const out = await parse(CreateServiceDto, { ...VALID, name: "  Corte  ", currency: "EUR" });
    expect(out).toMatchObject({ ...VALID, currency: "EUR" });
  });

  it("refuses a blank name", async () => {
    expect(await messages(CreateServiceDto, { ...VALID, name: "   " })).toContain("Escribe el nombre del servicio");
  });

  it("bounds the duration: whole minutes, from 5 to 600", async () => {
    expect(await messages(CreateServiceDto, { ...VALID, duration: 0 })).toContain("La duración mínima es de 5 minutos");
    await messages(CreateServiceDto, { ...VALID, duration: 7.5 });
    await messages(CreateServiceDto, { ...VALID, duration: 601 });
    await expect(parse(CreateServiceDto, { ...VALID, duration: 5 })).resolves.toBeDefined();
    await expect(parse(CreateServiceDto, { ...VALID, duration: 600 })).resolves.toBeDefined();
  });

  it("bounds the price: not negative, cents at most", async () => {
    expect(await messages(CreateServiceDto, { ...VALID, price: -10 })).toContain("El precio no puede ser negativo");
    await messages(CreateServiceDto, { ...VALID, price: 10.005 });
    await messages(CreateServiceDto, { ...VALID, price: "" });
    await expect(parse(CreateServiceDto, { ...VALID, price: 0 })).resolves.toBeDefined();
    await expect(parse(CreateServiceDto, { ...VALID, price: 19.99 })).resolves.toBeDefined();
  });

  it("only takes euros", async () => {
    expect(await messages(CreateServiceDto, { ...VALID, currency: "XYZ" })).toContain(
      "La única moneda disponible es EUR",
    );
  });

  it("bounds the buffer, the booking window and the deposit", async () => {
    await messages(CreateServiceDto, { ...VALID, bufferTime: -30 });
    await messages(CreateServiceDto, { ...VALID, bufferTime: 2.5 });
    await messages(CreateServiceDto, { ...VALID, minAdvanceBooking: -1 });
    await messages(CreateServiceDto, { ...VALID, maxAdvanceBooking: 0 });
    await messages(CreateServiceDto, { ...VALID, depositPercentage: 500 });
    await messages(CreateServiceDto, { ...VALID, depositPercentage: -5 });
    await messages(CreateServiceDto, { ...VALID, depositAmount: -5 });
    await expect(
      parse(CreateServiceDto, {
        ...VALID,
        bufferTime: 0,
        minAdvanceBooking: 0,
        maxAdvanceBooking: 60,
        depositPercentage: 100,
      }),
    ).resolves.toBeDefined();
  });
});
