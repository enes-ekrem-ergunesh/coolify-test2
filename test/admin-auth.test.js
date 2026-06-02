const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { openDatabase, initDb } = require('../src/db');

test('admin login accepts password when env value has trailing newline', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coolify-admin-auth-'));
  const db = openDatabase(path.join(tempDir, 'budget.db'));
  initDb(db);
  const app = createApp({
    db,
    config: {
      sessionSecret: 'test-session-secret',
      adminPassword: 'top-secret\n',
      trustProxy: 1,
      secureCookies: false,
      openAiApiKey: '',
      openAiModel: 'gpt-4o-mini',
      openAiBaseUrl: '',
    },
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const authPageResponse = await fetch(`${baseUrl}/`);
  const html = await authPageResponse.text();
  const sessionCookie = authPageResponse.headers.get('set-cookie')?.split(';')[0];
  const csrfToken = html.match(/name="csrfToken" type="hidden" value="([^"]+)"/)?.[1];

  assert.ok(sessionCookie, 'expected session cookie');
  assert.ok(csrfToken, 'expected csrf token');

  const loginResponse = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrfToken,
      username: 'admin',
      password: 'top-secret',
    }),
  });

  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), '/admin');
});
