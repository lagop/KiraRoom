/**
 * A service's category is checked against the database's list, so a wrong
 * one is a 400 saying what is allowed instead of a 500 from Postgres.
 */
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ServiceCategory } from "@prisma/client";
import { CreateServiceDto } from "./dto/create-service.dto";
import { UpdateServiceDto } from "./dto/update-service.dto";

const base = { name: "Corte", duration: 30, price: 20 };

function categoryErrors(cls: any, body: object): string[] {
  return validateSync(plainToInstance(cls, body))
    .filter((e) => e.property === "category")
    .flatMap((e) => Object.values(e.constraints ?? {}));
}

describe("service category", () => {
  it("accepts every category the database has", () => {
    for (const category of Object.values(ServiceCategory)) {
      expect(categoryErrors(CreateServiceDto, { ...base, category })).toEqual([]);
      expect(categoryErrors(UpdateServiceDto, { category })).toEqual([]);
    }
  });

  it("refuses an unknown one, naming the allowed values", () => {
    const [message] = categoryErrors(CreateServiceDto, { ...base, category: "Cabello" });
    expect(message).toContain("hair");
    expect(message).toContain("other");
    expect(categoryErrors(UpdateServiceDto, { category: "Cabello" })).toHaveLength(1);
  });

  it("is required to create a service, optional to change one", () => {
    expect(categoryErrors(CreateServiceDto, base)).not.toEqual([]);
    expect(categoryErrors(UpdateServiceDto, { name: "Corte largo" })).toEqual([]);
  });
});
