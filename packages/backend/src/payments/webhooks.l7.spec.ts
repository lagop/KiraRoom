import { WebhooksController } from './webhooks.controller';

/**
 * L-7: a successful `invoice.paid` event reactivates past_due /
 * suspended tenants and otherwise leaves the rest of the system
 * intact. The fiscal path is decoupled (it runs in
 * InvoiceService.create / InvoiceService.reSend on the server),
 * and the static analysis in `fiscal-invariant.spec.ts` locks the
 * invariant that the fiscal dispatcher is NEVER called from a
 * plan-gated branch. This spec asserts the "reactivate but otherwise
 * do nothing" contract for the `invoice.paid` path.
 */
describe('WebhooksController L-7 (invoice.paid reactivation rules)', () => {
  function makeController(tenant: any) {
    const configService = { get: () => 'whsec_test' } as any;
    const prisma = {
      tenant: {
        findFirst: jest.fn().mockResolvedValue(tenant),
        findUnique: jest.fn().mockResolvedValue(tenant),
        update: jest.fn().mockImplementation(async ({ where, data }) => {
          Object.assign(tenant, data);
          return tenant;
        }),
      },
    } as any;
    const stripe = { webhooks: { constructEvent: jest.fn() } } as any;
    const addonsService = {} as any;
    const subscriptionsService = {} as any;
    const billingService = { syncInvoice: jest.fn() } as any;
    const fiscalService = { dispatchInvoice: jest.fn(), anulateInvoice: jest.fn() } as any;
    const complianceService = {} as any;
    const auditLogService = { log: jest.fn() } as any;
    const rebookingService = { rebookForRescheduled: jest.fn() } as any;
    const rebookingCadenceService = {} as any;
    const messageBundles = { consumeCredit: jest.fn() } as any;

    const c = Object.create(WebhooksController.prototype) as any;
    c.logger = { log: () => {}, warn: () => {}, error: () => {} };
    c.configService = configService;
    c.stripe = stripe;
    c.addonsService = addonsService;
    c.subscriptionsService = subscriptionsService;
    c.billingService = billingService;
    c.fiscalService = fiscalService;
    c.complianceService = complianceService;
    c.auditLogService = auditLogService;
    c.rebookingService = rebookingService;
    c.rebookingCadenceService = rebookingCadenceService;
    c.messageBundles = messageBundles;
    c.prisma = prisma;

    return { c, prisma, tenant };
  }

  function paidEvent(customerId: string) {
    return {
      id: 'in_test',
      customer: customerId,
      amount_paid: 5000,
      currency: 'eur',
      metadata: {},
      status: 'paid',
    };
  }

  it('reactivates a past_due tenant (plan recovery is OK)', async () => {
    const tenant = { id: 't-pd', name: 'A', subscriptionStatus: 'past_due', stripeCustomerId: 'cus_1' };
    const { c, prisma } = makeController(tenant);
    await c['handleInvoicePaid'](paidEvent('cus_1') as any);
    expect(prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 't-pd' },
        data: expect.objectContaining({ subscriptionStatus: 'active' }),
      }),
    );
    expect(tenant.subscriptionStatus).toBe('active');
  });

  it('reactivates a suspended tenant (no plan gate on the recovery)', async () => {
    const tenant = { id: 't-sus', name: 'A', subscriptionStatus: 'suspended', stripeCustomerId: 'cus_1' };
    const { c } = makeController(tenant);
    await c['handleInvoicePaid'](paidEvent('cus_1') as any);
    expect(tenant.subscriptionStatus).toBe('active');
  });

  it('does NOT touch a cancelled tenant (preserve the SaaS-admin decision)', async () => {
    const tenant = { id: 't-can', name: 'A', subscriptionStatus: 'cancelled', stripeCustomerId: 'cus_1' };
    const { c, prisma } = makeController(tenant);
    await c['handleInvoicePaid'](paidEvent('cus_1') as any);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(tenant.subscriptionStatus).toBe('cancelled');
  });

  it('does NOT touch a trialing tenant (preserve fresh trial state)', async () => {
    const tenant = { id: 't-tri', name: 'A', subscriptionStatus: 'trialing', stripeCustomerId: 'cus_1' };
    const { c, prisma } = makeController(tenant);
    await c['handleInvoicePaid'](paidEvent('cus_1') as any);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(tenant.subscriptionStatus).toBe('trialing');
  });
});
