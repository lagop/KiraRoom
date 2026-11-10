/**
 * The webhook for connected accounts: refused without a signing secret, with
 * a forged signature, or without a signature; verified with the secret of the
 * event's mode (the other as a fallback); never processes an unsigned event.
 */
import { BadRequestException, HttpException } from '@nestjs/common';
import { ConnectWebhooksController } from './connect-webhooks.controller';

const body = (livemode: boolean) => ({ id: 'evt_1', type: 'account.updated', livemode, data: { object: {} } });
const reqOf = (b: unknown) => ({ rawBody: Buffer.from(JSON.stringify(b)) }) as any;

function build(opts: { secrets?: (live: boolean | null) => string[]; hasClient?: boolean; valid?: string[] } = {}) {
  const construct = jest.fn((_raw: string, _sig: string, secret: string) => {
    if (!(opts.valid ?? []).includes(secret)) throw new Error('No signatures found matching the expected signature');
    return { id: 'evt_1', type: 'account.updated', livemode: false, data: { object: {} } };
  });
  const platform = {
    connectWebhookSecrets: jest.fn(opts.secrets ?? (() => [])),
    client: () => (opts.hasClient === false ? null : { webhooks: { constructEvent: construct } }),
  };
  const events = { handle: jest.fn(async () => ({ received: true })) };
  const controller = new ConnectWebhooksController(platform as any, events as any);
  (controller as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { controller, platform, events, construct };
}

describe('ConnectWebhooksController', () => {
  it('without a signing secret in the console it answers 503 so Stripe retries, and processes nothing', async () => {
    const { controller, events } = build({ secrets: () => [] });
    await expect(controller.handle('sig', body(false), reqOf(body(false)))).rejects.toBeInstanceOf(HttpException);
    expect(events.handle).not.toHaveBeenCalled();
  });

  it('without Stripe keys it answers 503 too', async () => {
    const { controller } = build({ secrets: () => ['whsec_a'], hasClient: false });
    await expect(controller.handle('sig', body(false), reqOf(body(false)))).rejects.toMatchObject({ status: 503 });
  });

  it('never processes an unsigned event, even outside production', async () => {
    const { controller, events } = build({ secrets: () => ['whsec_a'], valid: ['whsec_a'] });
    await expect(controller.handle(undefined as any, body(false), reqOf(body(false)))).rejects.toBeInstanceOf(BadRequestException);
    expect(events.handle).not.toHaveBeenCalled();
  });

  it('a forged signature is refused with 400', async () => {
    const { controller, events } = build({ secrets: () => ['whsec_a'], valid: [] });
    await expect(controller.handle('forged', body(false), reqOf(body(false)))).rejects.toBeInstanceOf(BadRequestException);
    expect(events.handle).not.toHaveBeenCalled();
  });

  it("a valid event is handed on, verified with the secret of the event's mode", async () => {
    const { controller, events, platform, construct } = build({ secrets: (live) => (live ? ['whsec_live'] : ['whsec_test', 'whsec_live']), valid: ['whsec_test'] });
    await controller.handle('sig', body(false), reqOf(body(false)));
    expect(platform.connectWebhookSecrets).toHaveBeenCalledWith(false);
    expect(construct.mock.calls[0][2]).toBe('whsec_test');
    expect(events.handle).toHaveBeenCalledTimes(1);
  });

  it('falls back to the other secret when the first does not match', async () => {
    const { controller, construct, events } = build({ secrets: () => ['whsec_test', 'whsec_live'], valid: ['whsec_live'] });
    await controller.handle('sig', body(true), reqOf(body(true)));
    expect(construct.mock.calls.map((c) => c[2])).toEqual(['whsec_test', 'whsec_live']);
    expect(events.handle).toHaveBeenCalled();
  });
});
