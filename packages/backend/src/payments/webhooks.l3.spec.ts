import { WebhooksController } from './webhooks.controller';

/**
 * L-3: WebhooksController must route
 * `customer.subscription.{created,updated,deleted}` events with
 * `metadata.kind === 'addon'` to AddOnsService (provisionFromStripe /
 * cancelFromStripe). This locks the contract; if a future refactor
 * drops the routing, the add-on's tenant_add_ons row will never get
 * created/cancelled.
 */
describe('WebhooksController L-3 (addon metadata routing)', () => {
  function makeStripeEvent(opts: {
    type:
      | 'customer.subscription.created'
      | 'customer.subscription.updated'
      | 'customer.subscription.deleted';
    tenantId?: string;
    addOnKey?: string;
    status?: string;
    currentPeriodEnd?: number;
  }) {
    const metadata: Record<string, string> = {};
    if (opts.tenantId) metadata.tenantId = opts.tenantId;
    if (opts.addOnKey) metadata.addOnKey = opts.addOnKey;
    if (opts.addOnKey) metadata.kind = 'addon';
    return {
      type: opts.type,
      data: {
        object: {
          id: 'sub_test',
          status: opts.status ?? 'active',
          current_period_end: opts.currentPeriodEnd ?? Math.floor(Date.now() / 1000) + 86400,
          metadata,
          items: opts.addOnKey
            ? {
                data: [
                  {
                    id: 'si_test_123',
                    metadata: { addOnKey: opts.addOnKey },
                  },
                ],
              }
            : { data: [] },
        },
      },
    };
  }

  function buildController() {
    const tenantAddOns: any[] = [];
    const addonsService = {
      provisionFromStripe: jest.fn().mockImplementation(async (args: any) => {
        const existing = tenantAddOns.find(
          (x) => x.tenantId === args.tenantId && x.addOnKey === args.addOnKey,
        );
        if (existing) {
          existing.status = args.status;
          existing.currentPeriodEnd = args.currentPeriodEnd;
        } else {
          tenantAddOns.push({
            tenantId: args.tenantId,
            addOnKey: args.addOnKey,
            status: args.status,
            currentPeriodEnd: args.currentPeriodEnd,
          });
        }
        return tenantAddOns.find(
          (x) => x.tenantId === args.tenantId && x.addOnKey === args.addOnKey,
        );
      }),
      cancelFromStripe: jest.fn().mockImplementation(async (args: any) => {
        const row = tenantAddOns.find(
          (x) => x.tenantId === args.tenantId && x.addOnKey === args.addOnKey,
        );
        if (!row) return false;
        row.status = 'cancelled';
        return true;
      }),
    } as any;

    const c = Object.create(WebhooksController.prototype);
    c.logger = { log: () => {}, warn: () => {}, error: () => {} };
    c.configService = { get: () => 'whsec_test' } as any;
    c.stripe = {
      webhooks: { constructEvent: jest.fn() },
    } as any;
    c.addonsService = addonsService;
    c.subscriptionsService = { cancelSubscription: jest.fn() } as any;
    c.billingService = { syncInvoice: jest.fn() } as any;
    c.fiscalService = { dispatchInvoice: jest.fn() } as any;
    c.complianceService = {} as any;
    c.auditLogService = { log: jest.fn() } as any;
    c.rebookingService = { rebookForRescheduled: jest.fn() } as any;
    c.rebookingCadenceService = {} as any;
    c.messageBundles = { consumeCredit: jest.fn() } as any;
    c.prisma = {} as any;

    // Bypass signature verification by calling the private router
    // directly with a mocked event.
    c.handleEvent = async (event: any) =>
      (c as any)['handleSubscriptionLifecycle'](
        event.data.object,
        event.type === 'customer.subscription.deleted' ? 'deleted' :
        event.type === 'customer.subscription.updated' ? 'updated' : 'created',
      );

    return { c, addonsService, tenantAddOns };
  }

  it('routes customer.subscription.created with kind=addon to provisionFromStripe', async () => {
    const { c, addonsService, tenantAddOns } = buildController();
    const event = makeStripeEvent({
      type: 'customer.subscription.created',
      tenantId: 't1',
      addOnKey: 'ai_expansion',
    });
    await c.handleEvent(event);
    expect(addonsService.provisionFromStripe).toHaveBeenCalledTimes(1);
    expect(tenantAddOns).toHaveLength(1);
    expect(tenantAddOns[0]).toEqual(
      expect.objectContaining({ tenantId: 't1', addOnKey: 'ai_expansion', status: 'active' }),
    );
  });

  it('routes customer.subscription.deleted with kind=addon to cancelFromStripe', async () => {
    const { c, addonsService, tenantAddOns } = buildController();
    tenantAddOns.push({ tenantId: 't1', addOnKey: 'ai_expansion', status: 'active' });
    const event = makeStripeEvent({
      type: 'customer.subscription.deleted',
      tenantId: 't1',
      addOnKey: 'ai_expansion',
    });
    await c.handleEvent(event);
    expect(addonsService.cancelFromStripe).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', addOnKey: 'ai_expansion' }),
    );
    expect(tenantAddOns[0].status).toBe('cancelled');
  });

  it('falls back to legacy plan-subscription path when kind is missing', async () => {
    const { c, addonsService } = buildController();
    const event = makeStripeEvent({
      type: 'customer.subscription.created',
      tenantId: 't1',
      // addOnKey + kind omitted -> legacy path
    });
    await c.handleEvent(event);
    expect(addonsService.provisionFromStripe).not.toHaveBeenCalled();
  });
});
