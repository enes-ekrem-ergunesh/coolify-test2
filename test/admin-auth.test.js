const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { openDatabase, initDb } = require('../src/db');

test('admin login accepts password when env value has trailing newline', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coolify-admin-auth-'));
  const db = openDatabase(path.join(tempDir, 'admin-auth-test.db'));
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

test('admin can dismiss a pending registration', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coolify-admin-dismiss-'));
  const db = openDatabase(path.join(tempDir, 'admin-dismiss-test.db'));
  initDb(db);
  db.prepare('INSERT INTO users(email, password_hash, is_verified) VALUES(?, ?, 0)').run('pending@example.com', 'hashed-password');

  const app = createApp({
    db,
    config: {
      sessionSecret: 'test-session-secret',
      adminPassword: 'top-secret',
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
  const authHtml = await authPageResponse.text();
  const initialSessionCookie = authPageResponse.headers.get('set-cookie')?.split(';')[0];
  const initialCsrfToken = authHtml.match(/name="csrfToken" type="hidden" value="([^"]+)"/)?.[1];

  assert.ok(initialSessionCookie, 'expected initial session cookie');
  assert.ok(initialCsrfToken, 'expected initial csrf token');

  const loginResponse = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: initialSessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrfToken: initialCsrfToken,
      username: 'admin',
      password: 'top-secret',
    }),
  });

  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), '/admin');

  const adminSessionCookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
  assert.ok(adminSessionCookie, 'expected admin session cookie');

  const adminPageResponse = await fetch(`${baseUrl}/admin`, {
    headers: {
      cookie: adminSessionCookie,
    },
  });
  const adminHtml = await adminPageResponse.text();
  const dismissCsrfToken = adminHtml.match(/name="csrfToken" type="hidden" value="([^"]+)"/)?.[1];

  assert.equal(adminPageResponse.status, 200);
  assert.match(adminHtml, /pending@example\.com/);
  assert.match(adminHtml, /\/admin\/users\/\d+\/dismiss/);
  assert.ok(dismissCsrfToken, 'expected admin csrf token');

  const pendingUser = db.prepare('SELECT id FROM users WHERE email = ?').get('pending@example.com');
  assert.ok(pendingUser, 'expected pending user');

  const dismissResponse = await fetch(`${baseUrl}/admin/users/${pendingUser.id}/dismiss`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: adminSessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrfToken: dismissCsrfToken,
    }),
  });

  assert.equal(dismissResponse.status, 302);
  assert.equal(dismissResponse.headers.get('location'), '/admin');

  const dismissedUser = db.prepare('SELECT id FROM users WHERE email = ?').get('pending@example.com');
  assert.equal(dismissedUser, undefined);
});
