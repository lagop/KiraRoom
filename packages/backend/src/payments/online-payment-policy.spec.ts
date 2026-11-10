/**
 * What a client may pay online when she books: the four combinations of
 * "señal obligatoria" and "pagar todo por adelantado", who is exempt, and
 * which settings are refused.
 */
import {
  MIN_CHARGE_CENTS,
  chooseOnlinePayment,
  depositCentsFor,
  onlinePaymentOffer,
  onlinePaymentSettingsProblem,
} from './online-payment-policy';

const can = { canCharge: true };

describe('onlinePaymentOffer: the four combinations', () => {
  const base = { priceEuros: 60 };

  it('no señal, no prepayment: she books without paying, as before', () => {
    expect(onlinePaymentOffer(base, can)).toMatchObject({ mode: 'none', depositCents: null, depositRequired: false, canPayFull: false });
  });

  it('no señal, prepayment allowed: she may pay the whole service, nothing is required', () => {
    expect(onlinePaymentOffer({ ...base, allowPrepay: true }, can)).toMatchObject({
      mode: 'optional',
      totalCents: 6000,
      depositCents: null,
      depositRequired: false,
      canPayFull: true,
    });
  });

  it('señal obligatoria only: she must pay the señal to book', () => {
    expect(onlinePaymentOffer({ ...base, depositRequired: true, depositAmount: 15 }, can)).toMatchObject({
      mode: 'deposit',
      depositCents: 1500,
      depositRequired: true,
      canPayFull: false,
    });
  });

  it('señal obligatoria and prepayment: the señal, or all of it', () => {
    expect(onlinePaymentOffer({ ...base, depositRequired: true, depositPercentage: 25, allowPrepay: true }, can)).toMatchObject({
      mode: 'deposit_or_full',
      depositCents: 1500,
      totalCents: 6000,
      depositRequired: true,
      canPayFull: true,
    });
  });
});

describe('onlinePaymentOffer: when nothing is offered', () => {
  const svc = { priceEuros: 60, depositRequired: true, depositAmount: 15, allowPrepay: true };

  it('the salon cannot take payments (not connected, restricted, other mode): nothing, whatever the service says', () => {
    expect(onlinePaymentOffer(svc, { canCharge: false }).mode).toBe('none');
    expect(onlinePaymentOffer(svc, { canCharge: false }).depositCents).toBeNull();
  });

  it('a free service, or one under the minimum Stripe charges, is never charged online', () => {
    expect(onlinePaymentOffer({ ...svc, priceEuros: 0 }, can).mode).toBe('none');
    expect(onlinePaymentOffer({ ...svc, priceEuros: 0.4 }, can).mode).toBe('none');
    expect(onlinePaymentOffer({ ...svc, priceEuros: 0.5 }, can).totalCents).toBe(MIN_CHARGE_CENTS);
  });
});

describe('the señal amount', () => {
  it('a fixed amount in euros, or a percentage of the price, rounded to the cent', () => {
    expect(depositCentsFor({ priceEuros: 36.3, depositRequired: true, depositAmount: '10.00' })).toBe(1000);
    expect(depositCentsFor({ priceEuros: 36.3, depositRequired: true, depositPercentage: 30 })).toBe(1089);
  });

  it('never more than the price, and never under the minimum charge', () => {
    expect(depositCentsFor({ priceEuros: 20, depositRequired: true, depositAmount: 50 })).toBe(2000);
    expect(depositCentsFor({ priceEuros: 20, depositRequired: true, depositPercentage: 1 })).toBe(MIN_CHARGE_CENTS);
  });

  it('not asked for when it is not required, or has no amount (a half-set service never charges by mistake)', () => {
    expect(depositCentsFor({ priceEuros: 20, depositRequired: false, depositAmount: 5 })).toBeNull();
    expect(depositCentsFor({ priceEuros: 20, depositRequired: true })).toBeNull();
    expect(depositCentsFor({ priceEuros: 20, depositRequired: true, depositAmount: 0, depositPercentage: 0 })).toBeNull();
    expect(onlinePaymentOffer({ priceEuros: 20, depositRequired: true }, can).mode).toBe('none');
  });

  it('a fixed amount wins over a percentage when both are stored', () => {
    expect(depositCentsFor({ priceEuros: 100, depositRequired: true, depositAmount: 10, depositPercentage: 50 })).toBe(1000);
  });
});

describe('a client exempt from the señal', () => {
  const svc = { priceEuros: 60, depositRequired: true, depositAmount: 15 };

  it('is not asked for it: she books freely when nothing else is on offer', () => {
    expect(onlinePaymentOffer(svc, { canCharge: true, exempt: true })).toMatchObject({ mode: 'none', depositRequired: false, depositCents: null });
  });

  it('may still pay all of it when the service allows prepayment', () => {
    expect(onlinePaymentOffer({ ...svc, allowPrepay: true }, { canCharge: true, exempt: true })).toMatchObject({
      mode: 'optional',
      depositRequired: false,
      canPayFull: true,
    });
  });
});

describe('onlinePaymentSettingsProblem', () => {
  it('a valid señal, fixed or percentage, is fine; so is nothing', () => {
    expect(onlinePaymentSettingsProblem({ price: 60, depositRequired: true, depositAmount: 15 })).toBeNull();
    expect(onlinePaymentSettingsProblem({ price: 60, depositRequired: true, depositPercentage: 30 })).toBeNull();
    expect(onlinePaymentSettingsProblem({ price: 60 })).toBeNull();
    expect(onlinePaymentSettingsProblem({ price: 0 })).toBeNull();
  });

  it('a señal has to say how much, as one thing only', () => {
    expect(onlinePaymentSettingsProblem({ price: 60, depositRequired: true })).toMatch(/Indica la señal/);
    expect(onlinePaymentSettingsProblem({ price: 60, depositRequired: true, depositAmount: 10, depositPercentage: 20 })).toMatch(/no las dos/);
  });

  it('not more than the price, nor more than 100 %', () => {
    expect(onlinePaymentSettingsProblem({ price: 60, depositRequired: true, depositAmount: 80 })).toMatch(/mayor que el precio/);
    expect(onlinePaymentSettingsProblem({ price: 60, depositRequired: true, depositPercentage: 120 })).toMatch(/100 %/);
  });

  it('a service too cheap to charge cannot ask for money online', () => {
    expect(onlinePaymentSettingsProblem({ price: 0, allowPrepay: true })).toMatch(/0,50/);
    expect(onlinePaymentSettingsProblem({ price: 0.3, depositRequired: true, depositAmount: 0.2 })).toMatch(/0,50/);
  });

  it('settings left over from a service that no longer asks for a señal are not a problem', () => {
    expect(onlinePaymentSettingsProblem({ price: 60, depositRequired: false, depositAmount: 500 })).toBeNull();
  });
});

describe('chooseOnlinePayment: what she is made to pay', () => {
  const offer = (svc: object, ctx = can) => onlinePaymentOffer({ priceEuros: 60, ...svc }, ctx);

  it('nothing on offer: nothing to pay, whatever she asks', () => {
    expect(chooseOnlinePayment(offer({}), 'full')).toBeNull();
    expect(chooseOnlinePayment(offer({ depositRequired: true, depositAmount: 15 }, { canCharge: false }), 'deposit')).toBeNull();
  });

  it('prepayment alone is only charged when she asks for it', () => {
    expect(chooseOnlinePayment(offer({ allowPrepay: true }), undefined)).toBeNull();
    expect(chooseOnlinePayment(offer({ allowPrepay: true }), 'deposit')).toBeNull();
    expect(chooseOnlinePayment(offer({ allowPrepay: true }), 'full')).toEqual({ kind: 'full', cents: 6000 });
  });

  it('a required señal is always charged, and she cannot pay all where the salon did not allow it', () => {
    const o = offer({ depositRequired: true, depositAmount: 15 });
    expect(chooseOnlinePayment(o, undefined)).toEqual({ kind: 'deposit', cents: 1500 });
    expect(chooseOnlinePayment(o, 'full')).toEqual({ kind: 'deposit', cents: 1500 });
  });

  it('señal or all: the señal by default, all when she chooses it', () => {
    const o = offer({ depositRequired: true, depositAmount: 15, allowPrepay: true });
    expect(chooseOnlinePayment(o, undefined)).toEqual({ kind: 'deposit', cents: 1500 });
    expect(chooseOnlinePayment(o, 'deposit')).toEqual({ kind: 'deposit', cents: 1500 });
    expect(chooseOnlinePayment(o, 'full')).toEqual({ kind: 'full', cents: 6000 });
  });

  it('an exempt client is not made to pay a señal, but may still pay all', () => {
    const exempt = { canCharge: true, exempt: true };
    const o = offer({ depositRequired: true, depositAmount: 15, allowPrepay: true }, exempt);
    expect(chooseOnlinePayment(o, undefined)).toBeNull();
    expect(chooseOnlinePayment(o, 'full')).toEqual({ kind: 'full', cents: 6000 });
  });
});
