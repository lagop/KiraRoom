import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { tenantScopeExtension } from '../tenancy/tenant-scope.extension';

/**
 * Properties that must resolve against the BASE client rather than the
 * tenant-scoped one: lifecycle hooks, connection management, and the
 * deliberate escape hatch.
 */
const PASSTHROUGH = new Set<string | symbol>([
  'onModuleInit',
  'onModuleDestroy',
  'enableShutdownHooks',
  'unscoped',
  '$connect',
  '$disconnect',
  '$on',
  '$use',
]);

/**
 * Prisma client with tenant isolation applied at the client level.
 *
 * `$extends` returns a NEW client rather than mutating `this`, so the
 * constructor returns a Proxy: model delegates (`prisma.client`,
 * `prisma.appointment`, ...) and `$transaction` resolve against the
 * scoped client, while lifecycle and connection methods stay on the
 * base. Every existing call site keeps working unchanged.
 *
 * See `common/tenancy/tenant-scope.extension.ts` for what the filter
 * does and what it deliberately does not cover.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * The un-scoped client, for code that must cross tenants on purpose.
   * Reach for `runUnscoped()` from `common/tenancy/tenant.context` first;
   * this is the lower-level door.
   */
  readonly unscoped: PrismaClient;

  constructor() {
    super();

    const base = this;
    this.unscoped = base;

    const scoped = this.$extends(tenantScopeExtension()) as unknown as PrismaClient;

    return new Proxy(this, {
      get(target, prop) {
        if (PASSTHROUGH.has(prop)) {
          const own = Reflect.get(target, prop, target);
          return typeof own === 'function' ? own.bind(target) : own;
        }
        const value = (scoped as any)[prop];
        if (value === undefined) {
          const own = Reflect.get(target, prop, target);
          return typeof own === 'function' ? own.bind(target) : own;
        }
        return typeof value === 'function' ? value.bind(scoped) : value;
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  async enableShutdownHooks(app: any) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}
