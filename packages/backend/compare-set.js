// Capture full Anthropic replies by running the L1 suite and dumping
// every scenario's final reply to a JSON file.
const http = require('node:http');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

function call(token, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost', port: 3001, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => (chunks += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function setPlatformConfig({ provider, apiKey, defaultModel, baseUrl, workspaceId }) {
  const admin = await prisma.user.findFirst({ where: { role: 'saas_owner' } });
  const originalHash = admin.passwordHash;
  const tempHash = await bcrypt.hash('E2E_pwd_compare', 10);
  await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: tempHash } });

  try {
    const login = await call(null, 'POST', '/api/v1/auth/login', { email: admin.email, password: 'E2E_pwd_compare' });
    const token = login.body.tokens.accessToken;
    const res = await call(token, 'PUT', '/api/v1/platform/llm-config', {
      provider, apiKey, defaultModel, baseUrl: baseUrl ?? null, workspaceId: workspaceId ?? null,
    });
    console.log(`Updated platform config: provider=${provider} model=${defaultModel} ok=${res.status === 200}`);
  } finally {
    await prisma.user.update({ where: { id: admin.id }, data: { passwordHash: originalHash } });
  }
}

async function main() {
  const provider = process.argv[2];
  const key = process.argv[3];
  const model = process.argv[4];

  await setPlatformConfig({
    provider,
    apiKey: key,
    defaultModel: model,
    baseUrl: provider === 'MiniMax' ? 'https://api.minimax.io/anthropic' : null,
  });
  await prisma.$disconnect();
  console.log('OK');
}

main().catch(e => { console.error(e); process.exit(1); });