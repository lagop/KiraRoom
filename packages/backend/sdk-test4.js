const Anthropic = require('@anthropic-ai/sdk').default;
const KEY = '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';

const client = new Anthropic({ apiKey: KEY });

const SYSTEM_PROMPT = `Eres el Recepcionista Virtual de Kira Studio Test, un asistente inteligente,
amable y profesional especializado en atención al cliente para salones de
belleza y peluquerías.

## TU IDENTIDAD
- Tu nombre es Kira.
- Representas a Kira Studio Test en cada interacción.
- Tu personalidad es: cálida, empática, eficiente y profesional.
- Hablas en el idioma del cliente.`;

(async () => {
  // Try 1: temperature=1, max_tokens=1500 (the exact harness config)
  try {
    const r = await client.messages.create({
      model: 'claude-haiku-4-5',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: '¡Hola! ¿En qué puedo ayudarte hoy?\n\nUsuario: hola' }],
      max_tokens: 1500,
      temperature: 1,
    });
    console.log('OK 1:', r.content[0]?.text?.slice(0, 80));
  } catch (e) {
    console.log('ERR 1:', e.message);
  }

  // Try 2: same but with top_p=0.95 (the env value)
  try {
    const r = await client.messages.create({
      model: 'claude-haiku-4-5',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: '¡Hola! ¿En qué puedo ayudarte hoy?\n\nUsuario: hola' }],
      max_tokens: 1500,
      temperature: 1,
      top_p: 0.95,
    });
    console.log('OK 2:');
  } catch (e) {
    console.log('ERR 2:', e.message);
  }
})();