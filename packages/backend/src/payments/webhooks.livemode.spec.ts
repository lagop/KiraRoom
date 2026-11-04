import { WebhooksController, unverifiedLivemode } from './webhooks.controller';

/**
 * Audit 8 P1 + P8: KiraRoom's Stripe webhook and the two modes.
 * - An event of the other mode than the secret key in force is acknowledged
 *   (200) and never applied: a test payment cannot activate a plan while live
 *   keys are in force, and the other way round.
 * - Test and live events are signed with different secrets: both are
 *   accepted, the one of the event's mode tried first.
 */
const k = (...parts: string[]) => parts.join('_');
const skTest = k('sk', 'test', 'fictitious0123456789');
const whsecTest = k('whsec', 'fictitiousTestMode01');
const whsecLive = k('whsec', 'fictitiousLiveMode01');

function buildController(mode: 'test' | 'live' | 'none', constructEvent: jest.Mock) {
  const c = Object.create(WebhooksController.prototype) as any;
  c.logger = { log: () => {}, warn: jest.fn(), error: jest.fn() };
  c.platformStripe = {
    client: () => ({ webhooks: { constructEvent } }),
    current: () => ({ secretKey: skTest, webhookSecret: whsecTest, otherWebhookSecret: whsecLive }),
    mode: () => mode,
  };
  c.prisma = { stripeWebhookEvent: { create: jest.fn().mockResolvedValue({}), delete: jest.fn() } };
  c.routeStripeEvent = jest.fn().mockResolvedValue(undefined);
  return c;
}

describe('Stripe webhook: test and live modes', () => {
  it('acknowledges a live event while test keys are in force, without applying it', async () => {
    const event = { id: 'evt_1', type: 'checkout.session.completed', livemode: true, data: { object: {} } };
    const constructEvent = jest.fn().mockReturnValue(event);
    const c = buildController('test', constructEvent);
    const res = await c.handleStripeWebhook('sig', event, { rawBody: Buffer.from(JSON.stringify(event)) });
    expect(res).toEqual({ received: true, ignored: 'other_mode' });
    expect(c.routeStripeEvent).not.toHaveBeenCalled();
    expect(c.prisma.stripeWebhookEvent.create).not.toHaveBeenCalled();
    expect(c.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/live mode.*test mode/));
  });

  it('applies an event of the mode in force', async () => {
    const event = { id: 'evt_2', type: 'invoice.paid', livemode: false, data: { object: {} } };
    const c = buildController('test', jest.fn().mockReturnValue(event));
    const res = await c.handleStripeWebhook('sig', event, { rawBody: Buffer.from(JSON.stringify(event)) });
    expect(res).toEqual({ received: true });
    expect(c.routeStripeEvent).toHaveBeenCalledWith(event);
  });

  it('verifies a live event with the live secret first, and falls back to the other', async () => {
    const event = { id: 'evt_3', type: 'invoice.paid', livemode: true };
    const constructEvent = jest.fn().mockImplementation((_raw: string, _sig: string, secret: string) => {
      if (secret !== whsecLive) throw new Error('No signatures found');
      return event;
    });
    const c = buildController('test', constructEvent);
    await c.handleStripeWebhook('sig', event, { rawBody: Buffer.from(JSON.stringify(event)) });
    expect(constructEvent.mock.calls.map((call) => call[2])).toEqual([whsecLive]);

    // A payload that claims test mode but is signed with the live secret:
    // both are tried, and the verified event's own livemode decides.
    constructEvent.mockClear();
    const res = await c.handleStripeWebhook('sig', event, { rawBody: Buffer.from('{"livemode":false}') });
    expect(constructEvent.mock.calls.map((call) => call[2])).toEqual([whsecTest, whsecLive]);
    expect(res).toEqual({ received: true, ignored: 'other_mode' });
  });

  it('refuses an event that no secret verifies (400)', async () => {
    const c = buildController('test', jest.fn().mockImplementation(() => {
      throw new Error('No signatures found');
    }));
    await expect(c.handleStripeWebhook('sig', {}, { rawBody: Buffer.from('{}') })).rejects.toMatchObject({ status: 400 });
  });

  it('reads livemode from the raw payload, else the parsed body', () => {
    expect(unverifiedLivemode('{"livemode":true}', {})).toBe(true);
    expect(unverifiedLivemode('not json', { livemode: false })).toBe(false);
    expect(unverifiedLivemode('{}', {})).toBeNull();
  });
});
