import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { VirtualReceptionistController } from './virtual-receptionist/virtual-receptionist.controller';
import { ChannelsConfigController } from './virtual-receptionist/controllers/channels-config.controller';
import { PaymentsController } from './payments/payments.controller';

/**
 * Routes that answered as if they worked and did not, removed rather than
 * left to be called again:
 *
 *  - /virtual-receptionist/config[/:salonId]: GET returned the same fixed
 *    settings for every salon ("gpt-4", 09:00-18:00...), POST/PUT echoed the
 *    body back without saving it.
 *  - /virtual-receptionist/channels/metrics: process-wide counters (every
 *    salon, since the last restart) shown to each salon as its own.
 *  - /payments/wallet/:clientId/points/earn|redeem: moved
 *    ClientWallet.loyaltyPoints, which nothing reads since loyalty is the
 *    LoyaltyTransaction ledger (#120).
 */
function routes(cls: any): string[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '');
  return Object.getOwnPropertyNames(cls.prototype).flatMap((name) => {
    const handler = cls.prototype[name];
    if (typeof handler !== 'function' || Reflect.getMetadata(METHOD_METADATA, handler) === undefined) return [];
    return [`${base}/${Reflect.getMetadata(PATH_METADATA, handler)}`];
  });
}

describe('removed fake routes', () => {
  it('the receptionist has no fixed config endpoints; its stats stay', () => {
    const r = routes(VirtualReceptionistController);
    expect(r.filter((p) => /\/config(\/|$)/.test(p))).toEqual([]);
    expect(r).toContain('virtual-receptionist/stats');
  });

  it('the channels page has no process-wide metrics endpoint', () => {
    expect(routes(ChannelsConfigController)).not.toContain('virtual-receptionist/channels/metrics');
  });

  it('the wallet no longer moves loyalty points', () => {
    expect(routes(PaymentsController).filter((p) => p.includes('/points/'))).toEqual([]);
  });
});
