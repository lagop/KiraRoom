import { INTERCEPTORS_METADATA } from "@nestjs/common/constants";
import { ProductService } from "./product.service";
import { PosController } from "./pos.controller";
import { ScrubSecretsInterceptor } from "../appointments/appointment-response";

describe("the till never hands out the salon's secrets", () => {
  it("a product is read without its salon", async () => {
    const findUnique = jest.fn().mockResolvedValue({ id: "p1", name: "Champú" });
    const service = new ProductService({ product: { findUnique } } as any, {} as any, {} as any);
    const product = await service.getProduct("p1");
    expect(findUnique).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect((product as any).tenant).toBeUndefined();
  });

  it("every POS route goes through ScrubSecretsInterceptor", () => {
    const interceptors = Reflect.getMetadata(INTERCEPTORS_METADATA, PosController) ?? [];
    expect(interceptors).toContain(ScrubSecretsInterceptor);
  });
});
