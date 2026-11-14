import { buildCopilotSystemPrompt, CopilotPromptContext } from './copilot-system-prompt';

/**
 * Copilot audit B8: the prompt promised what no tool gives (low stock to a
 * professional, income to the owner). It must describe only what the tools
 * do for each role, in both languages.
 */
const base = (role: CopilotPromptContext['role'], language: 'es' | 'en' = 'es'): string =>
  buildCopilotSystemPrompt({ salonName: 'Salón Rosa', assistantName: 'Kira', role, availableWriteTools: [], language });

describe('copilot system prompt (B8)', () => {
  it('does not tell a professional she sees the low stock or anyone’s spend', () => {
    const es = base('staff');
    expect(es).not.toMatch(/el stock bajo/i);
    expect(es).toMatch(/No ves el stock/);
    const en = base('staff', 'en');
    expect(en).toMatch(/do not see stock/);
    expect(en).not.toMatch(/Solo ves/); // the English prompt has its own role text
  });

  it('tells the owner, admin and manager that the salon’s income is not available, in both languages', () => {
    for (const role of ['owner', 'admin', 'manager', 'saas_owner'] as const) {
      expect(base(role)).toMatch(/NO tienes los ingresos|tampoco tienes los ingresos/);
      expect(base(role, 'en')).toMatch(/do NOT have|no income figures/);
    }
    expect(base('owner')).not.toMatch(/profesionales, ingresos/);
  });

  it('never promises notes or products bought, and explains that drafts are for the user to send', () => {
    for (const lang of ['es', 'en'] as const) {
      const p = base('owner', lang);
      expect(p).toMatch(lang === 'es' ? /notas internas, productos comprados/ : /internal notes, products bought/);
      expect(p).toMatch(/draft_follow_up_message/);
      expect(p).toMatch(lang === 'es' ? /lo copie y lo envíe ella/ : /copy and send herself/);
      expect(p).toMatch(/send_message/);
    }
  });
});
