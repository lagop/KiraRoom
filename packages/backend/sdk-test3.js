// Try to reproduce the orchestrator's request shape exactly.
const Anthropic = require('@anthropic-ai/sdk').default;
const KEY = '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';

const client = new Anthropic({ apiKey: KEY });

// Copy the system prompt from buildSystemPrompt.
// Simplified — just to test if the prompt length matters.
const systemPrompt = `Eres el Recepcionista Virtual de Kira Room Test. Tu nombre es Kira. Test placeholder prompt for length testing purposes only.`;

(async () => {
  // Test 1: with tools
  try {
    const r = await client.messages.create({
      model: 'claude-haiku-4-5',
      system: systemPrompt,
      max_tokens: 1500,
      temperature: 1,
      messages: [{ role: 'user', content: 'hola' }],
      tools: [
        { name: 'list_services', description: 'List services.', input_schema: { type: 'object', properties: { audience: { type: 'string', enum: ['male', 'female', 'child'] } } } },
        { name: 'get_service', description: 'Get service.', input_schema: { type: 'object', properties: { serviceId: { type: 'string' } }, required: ['serviceId'] } },
        { name: 'list_professionals', description: 'List professionals.', input_schema: { type: 'object', properties: { specialty: { type: 'string' } } } },
        { name: 'check_availability', description: 'Check availability.', input_schema: { type: 'object', properties: { serviceId: { type: 'string' }, date: { type: 'string' } }, required: ['serviceId', 'date'] } },
        { name: 'get_salon_info', description: 'Get salon info.', input_schema: { type: 'object', properties: {} } },
      ],
      tool_choice: { type: 'auto' },
    });
    console.log('OK:', r.content.map(b => b.type).join(','));
  } catch (e) {
    console.log('ERR:', e.message);
    console.log('  status:', e.status);
    console.log('  body:', JSON.stringify(e.error?.body ?? e));
  }

  // Test 2: same but use top_p + temperature together to confirm bug
  try {
    const r = await client.messages.create({
      model: 'claude-haiku-4-5',
      system: systemPrompt,
      max_tokens: 1500,
      temperature: 1,
      top_p: 0.95,
      messages: [{ role: 'user', content: 'hola' }],
    });
    console.log('OK temp+top_p:', r.content[0]?.text?.slice(0, 80));
  } catch (e) {
    console.log('ERR temp+top_p:', e.message.slice(0, 200));
  }

  // Test 3: with the FULL chat message from orchestrator
  try {
    const r = await client.messages.create({
      model: 'claude-haiku-4-5',
      system: systemPrompt,
      max_tokens: 1500,
      temperature: 1,
      messages: [{ role: 'user', content: '¡Hola! Bienvenido/a a Kira Room Test. ¿En qué puedo ayudarte hoy? ✨' }],
      tools: [
        { name: 'list_services', description: 'List services.', input_schema: { type: 'object', properties: { audience: { type: 'string', enum: ['male', 'female', 'child'] } } } },
      ],
    });
    console.log('OK:', r.content[0]?.text?.slice(0, 80));
  } catch (e) {
    console.log('ERR:', e.message.slice(0, 300));
  }
})();