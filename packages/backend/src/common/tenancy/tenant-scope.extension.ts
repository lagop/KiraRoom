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

export function tenantScopeExtension() {
  return Prisma.defineExtension({
    name: "tenant-scope",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const store = tenantStorage.getStore();
          const tenantId = store?.tenantId;

          if (!store || store.bypass || !tenantId) return query(args);

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
