import { COPILOT_REFUSAL_REPLY, approvalObservation } from './assistant.service';

describe('approvalObservation (Copilot audit M8/M9): the model learns what became of an action', () => {
  it('says nothing while the action is pending', () => {
    expect(approvalObservation('Mover la cita de Ana', 'pending', null)).toBeNull();
    expect(approvalObservation('Mover la cita de Ana', undefined, null)).toBeNull();
  });

  it('done, with the coupon code', () => {
    const text = approvalObservation('Crear un cupón del 10 %', 'executed', { ok: true, code: 'AB12CD' })!;
    expect(text).toContain('aprobada y hecha');
    expect(text).toContain('código AB12CD');
    expect(text).toContain('Crear un cupón del 10 %');
  });

  it('done, with what the tool said', () => {
    expect(approvalObservation('Avisar a la lista de espera', 'executed', { message: 'Avisadas 2 clientas.' })).toContain(
      'Avisadas 2 clientas.',
    );
  });

  it('a failure, a refusal for permission, a cancel and an expiry are told apart', () => {
    expect(approvalObservation('x', 'rejected', { error: 'tool_failure', message: 'sin hueco' })).toContain('no se hizo (sin hueco)');
    expect(approvalObservation('x', 'rejected', { error: 'forbidden' })).toContain('no tiene permiso');
    expect(approvalObservation('x', 'rejected', null)).toContain('cancelada por la usuaria');
    expect(approvalObservation('x', 'expired', null)).toContain('caducada');
  });

  it('is kept short', () => {
    expect(approvalObservation('x'.repeat(2000), 'executed', null)!.length).toBeLessThanOrEqual(600);
  });
});

describe('B14: a refusal is not answered with the receptionist line', () => {
  it('the Copilot has its own words', () => {
    expect(COPILOT_REFUSAL_REPLY).not.toMatch(/por aquí/);
  });
});
