import { COPILOT_REFUSAL_REPLY, approvalObservation, copilotHistoryForLlm } from './assistant.service';

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

describe('copilotHistoryForLlm: a resolved card is told after the reply that proposed it', () => {
  const card = (status: string, result: unknown = null) => ({
    role: 'approval',
    content: 'Crear un cupón del 10 %',
    pendingAction: { status, resultSnapshot: result },
  });

  it('the turn as stored (card before the reply) reads card result after the reply', () => {
    const out = copilotHistoryForLlm([
      { role: 'user', content: 'Crea un cupón' },
      card('executed', { ok: true, code: 'JX8SJN' }),
      { role: 'assistant', content: 'Está pendiente de tu aprobación.' },
      { role: 'user', content: '¿Se ha creado?' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(out[1].content).toBe('Está pendiente de tu aprobación.');
    expect(out[2].content).toContain('código JX8SJN');
    expect(out[3].content).toBe('¿Se ha creado?');
  });

  it('a pending card says nothing; a card with no reply is told before the next question', () => {
    expect(copilotHistoryForLlm([{ role: 'user', content: 'a' }, card('pending'), { role: 'assistant', content: 'b' }])).toHaveLength(2);
    const out = copilotHistoryForLlm([{ role: 'user', content: 'a' }, card('rejected'), { role: 'user', content: 'c' }]);
    expect(out.map((m) => m.content)).toEqual(['a', expect.stringContaining('cancelada'), 'c']);
  });
});
