import "reflect-metadata";
import { ArgumentMetadata, ValidationPipe } from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants";
import { RouteParamtypes } from "@nestjs/common/enums/route-paramtypes.enum";

/**
 * For specs: runs a handler's `@Body()` through the same ValidationPipe the
 * app installs globally (main.ts), using the type the controller declares.
 *
 * An interface, inline object type or type alias reaches the pipe as
 * `Object`, which it lets through unvalidated and unstripped. Reading the
 * metatype from the controller is what proves the handler is protected:
 * a spec that validates the DTO class on its own would still pass if the
 * controller went back to an interface.
 */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });

export function bodyMetatype(controller: { prototype: object }, method: string): unknown {
  const args: Record<string, { index: number }> =
    Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {};
  const key = Object.keys(args).find((k) => k.split(":")[0] === String(RouteParamtypes.BODY));
  if (!key) throw new Error(`${method} has no @Body()`);
  const types: unknown[] = Reflect.getMetadata("design:paramtypes", controller.prototype, method) ?? [];
  return types[args[key].index];
}

export function bodyParser(controller: { prototype: object }, method: string) {
  const metatype = bodyMetatype(controller, method);
  return (body: unknown): Promise<any> =>
    pipe.transform(body, { type: "body", metatype: metatype as any } as ArgumentMetadata);
}
