// Bypass the SDK entirely. Send the EXACT request body the harness sent.
const https = require('node:https');

const KEY = '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';

const body = JSON.stringify({
  model: 'claude-haiku-4-5',
  system: 'Eres el Recepcionista Virtual de Kira Studio Test, un asistente inteligente, amable y profesional.',
  messages: [{ role: 'user', content: '¡Hola! ¿En qué puedo ayudarte hoy?\n\nUsuario: hola' }],
  max_tokens: 1500,
  temperature: 1,
});

console.log('Body length:', body.length);

const req = https.request({
  hostname: 'api.anthropic.com',
  path: '/v1/messages',
  method: 'POST',
  headers: {
    'x-api-key': KEY,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  },
}, res => {
  let chunks = '';
  res.on('data', c => chunks += c);
  res.on('end', () => {
    console.log('status:', res.statusCode);
    console.log('body:', chunks.slice(0, 400));
  });
});
req.write(body);
req.end();