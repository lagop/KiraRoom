import { ForbiddenException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { tenantStorage } from "./tenant.context";

/**
 * Prisma client extension that injects `tenantId` into every query on
 * a tenant-owned model, using the per-request tenant context.
 *
 * Why this exists: tenant isolation was enforced by hand in each
 * service, and several endpoints simply forgot -- `/admin/clients`
 * listed every client on the platform, `/clients/:id` read and wrote
 * across tenants, and the whole `appointment-services` module had no
 * tenant context at all. Patching those four is necessary but does
 * not stop the fifth from being written next month. This makes the
 * filter structural.
 *
 * Prisma 5 accepts non-unique filters alongside the unique key in
 * `findUnique` / `update` / `delete` (extended `where`, GA since 5.0),
 * so the same injection works for every operation.
 *
 * Not covered, on purpose:
 *   - Nested writes (`data: { x: { create: ... } }`) inherit their
 *     parent relation, and the parent is scoped.
 *   - `$queryRaw` / `$executeRaw` bypass the extension entirely.
 *     Raw SQL on tenant tables must filter by hand.
 */

const TENANT_MODELS: ReadonlySet<string> = new Set(
  Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "tenantId"))
    .map((m) => m.name),
);

/**
 * Models that carry no `tenantId` of their own but belong to a tenant
 * through a required to-one relation. `AppointmentService`, for
 * instance, reaches its tenant through both `appointment` and
 * `service`. Those are filtered with `where: { <relation>: { tenantId } }`.
 *
 * When there are several candidate parents the first one in field
 * order is used. Filtering on any single one is sound: in a consistent
 * database every required parent of a row belongs to the same tenant,
 * so one is enough to decide ownership.
 *
 * Derived from the datamodel rather than hand-listed, so a model added
 * later is covered automatically.
 */
const RELATION_SCOPED_MODELS: ReadonlyMap<string, string> = new Map(
  Prisma.dmmf.datamodel.models
    .filter((m) => !TENANT_MODELS.has(m.name))
    .map((m) => {
      const parent = m.fields.find(
        (f) =>
          f.kind === "object" &&
          !f.isList &&
          f.isRequired &&
          TENANT_MODELS.has(f.type),
      );
      return parent ? ([m.name, parent.name] as [string, string]) : null;
    })
    .filter((entry): entry is [string, string] => entry !== null),
);

/** Operations whose `args.where` scopes the rows they touch. */
const WHERE_OPERATIONS: ReadonlySet<string> = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

function assertSameTenant(model: string, given: unknown, tenantId: string): void {
  if (typeof given === "string" && given !== tenantId) {
    throw new ForbiddenException(
      `Cross-tenant ${model} access denied: request is scoped to another tenant.`,
    );
  }
}

/** Merge the tenant filter into a `where` clause. */
function scopeWhere(
  model: string,
  where: Record<string, any> | undefined,
  tenantId: string,
): Record<string, any> {
  if (where && "tenantId" in where) {
    assertSameTenant(model, where.tenantId, tenantId);
  }
  return { ...(where ?? {}), tenantId };
}

/** Stamp the tenant onto created rows, rejecting a mismatched explicit one. */
function scopeData(
  model: string,
  data: Record<string, any> | Record<string, any>[] | undefined,
  tenantId: string,
): unknown {
  if (Array.isArray(data)) {
    return data.map((row) => scopeData(model, row, tenantId));
  }
  if (!data) return { tenantId };
  if ("tenantId" in data) {
    assertSameTenant(model, data.tenantId, tenantId);
  }
  // A nested relation connect (`tenant: { connect: ... }`) already sets
  // the owner; do not fight it.
  if ("tenant" in data) return data;
  return { ...data, tenantId };
}

/**
 * Relation fields of every model: field name -> the model it points to.
 */
const RELATIONS: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map(
  Prisma.dmmf.datamodel.models.map((m) => [
    m.name,
    new Map(m.fields.filter((f) => f.kind === "object").map((f) => [f.name, f.type])),
  ]),
);

/**
 * Models a tenant request may never write through another model's
 * relation. An endpoint that writes a request body as it comes would
 * otherwise let it change the salon (plan, status) or its users (role,
 * password) through a nested update. The application never writes the
 * salon or its users that way, so the whole path is closed here,
 * whatever the next endpoint forgets to validate.
 */
const PROTECTED_MODELS: ReadonlySet<string> = new Set(["Tenant", "User"]);

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Refuse writes into protected models and into other tenants, at any depth. */
function guardData(model: string, data: unknown, tenantId: string): void {
  if (Array.isArray(data)) {
    for (const row of data) guardData(model, row, tenantId);
    return;
  }
  if (!isRecord(data)) return;
  if ("tenantId" in data) assertSameTenant(model, data.tenantId, tenantId);
  const relations = RELATIONS.get(model);
  if (!relations) return;
  for (const [field, value] of Object.entries(data)) {
    const target = relations.get(field);
    if (!target || !isRecord(value)) continue;
    if (PROTECTED_MODELS.has(target)) {
      guardProtectedRelation(model, field, target, value, tenantId);
      continue;
    }
    guardRelationOps(target, value, tenantId);
  }
}

/** Only a plain `connect` (to this tenant, for the salon) is allowed. */
function guardProtectedRelation(
  model: string,
  field: string,
  target: string,
  ops: Record<string, any>,
  tenantId: string,
): void {
  const keys = Object.keys(ops);
  const onlyConnect = keys.length === 1 && keys[0] === "connect";
  const sameTenant = target !== "Tenant" || ops.connect?.id === tenantId;
  if (!onlyConnect || !sameTenant) {
    throw new ForbiddenException(`Writing ${target} through ${model}.${field} is not allowed.`);
  }
}

/** Walk the data of a nested relation write (`create`, `update`, ...). */
function guardRelationOps(target: string, ops: Record<string, any>, tenantId: string): void {
  for (const [op, arg] of Object.entries(ops)) {
    for (const item of Array.isArray(arg) ? arg : [arg]) {
      if (!isRecord(item)) continue;
      switch (op) {
        case "create":
          guardData(target, item, tenantId);
          break;
        case "createMany":
          guardData(target, item.data, tenantId);
          break;
        case "update":
        case "updateMany":
          // To-many: `{ where, data }`. To-one: the data itself, or `{ data }`.
          guardData(target, "data" in item ? item.data : item, tenantId);
          break;
        case "upsert":
          guardData(target, item.create, tenantId);
          guardData(target, item.update, tenantId);
          break;
        case "connectOrCreate":
          guardData(target, item.create, tenantId);
          break;
        default:
          break;
      }
    }
  }
}

const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "upsert",
]);

/**
 * Throws when a write in a tenant request reaches the salon or its users
 * through a relation, or names another tenant anywhere in its data.
 */
export function assertSafeWrite(model: string, operation: string, args: unknown, tenantId: string): void {
  if (!WRITE_OPERATIONS.has(operation) || !isRecord(args)) return;
  guardData(model, args.data, tenantId);
  guardData(model, args.create, tenantId);
  guardData(model, args.update, tenantId);
}

export function tenantScopeExtension() {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const store = tenantStorage.getStore();
          const tenantId = store?.tenantId;

          if (!store || store.bypass || !tenantId) return query(args);

          assertSafeWrite(model, operation, args, tenantId);

          // Models whose tenant is reached through a parent relation are
          // filtered on reads and writes-by-where only. Their `create`
          // needs no stamp: the parent id it references is itself read
          // back through a scoped query by the calling service.
          const viaRelation = RELATION_SCOPED_MODELS.get(model);
          if (viaRelation) {
            if (!WHERE_OPERATIONS.has(operation)) return query(args);
            const relArgs: Record<string, any> = { ...((args as any) ?? {}) };
            relArgs.where = {
              ...(relArgs.where ?? {}),
              [viaRelation]: {
                ...((relArgs.where ?? {})[viaRelation] ?? {}),
                tenantId,
              },
            };
            return query(relArgs as typeof args);
          }

          if (!TENANT_MODELS.has(model)) return query(args);

          const next: Record<string, any> = { ...((args as any) ?? {}) };

          if (WHERE_OPERATIONS.has(operation)) {
            next.where = scopeWhere(model, next.where, tenantId);
            return query(next as typeof args);
          }

          if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
            next.data = scopeData(model, next.data, tenantId);
            return query(next as typeof args);
          }

          if (operation === "upsert") {
            next.where = scopeWhere(model, next.where, tenantId);
            next.create = scopeData(model, next.create, tenantId);
            return query(next as typeof args);
          }

          return query(args);
        },
      },
    },
  });
}
