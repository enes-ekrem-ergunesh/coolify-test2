const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { createApp } = require('../src/app');
const { openDatabase, initDb } = require('../src/db');

async function login(baseUrl, email, password) {
  const authPageResponse = await fetch(`${baseUrl}/`);
  const authHtml = await authPageResponse.text();
  const initialSessionCookie = authPageResponse.headers.get('set-cookie')?.split(';')[0];
  const csrfToken = authHtml.match(/name="csrfToken" type="hidden" value="([^"]+)"/)?.[1];

  assert.ok(initialSessionCookie, 'expected initial session cookie');
  assert.ok(csrfToken, 'expected csrf token');

  const loginResponse = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: initialSessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrfToken,
      email,
      password,
    }),
  });

  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), '/');

  return loginResponse.headers.get('set-cookie')?.split(';')[0] || initialSessionCookie;
}

test('dashboard shows only today expenses in today section', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coolify-dashboard-today-expenses-'));
  const db = openDatabase(path.join(tempDir, 'dashboard-today-expenses-test.db'));
  initDb(db);

  const passwordHash = await bcrypt.hash('password123', 12);
  const userInsert = db.prepare('INSERT INTO users(email, password_hash, is_verified) VALUES(?, ?, 1)').run('user@example.com', passwordHash);
  const userId = userInsert.lastInsertRowid;

  db.prepare(
    `INSERT INTO entries(user_id, message, type, category, amount, currency, description, status)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'complete')`,
  ).run(userId, 'today groceries', 'expense', 'groceries', 18.75, 'USD', 'Today groceries');

  db.prepare(
    `INSERT INTO entries(user_id, message, type, category, amount, currency, description, status, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'complete', datetime('now', '-1 day'))`,
  ).run(userId, 'yesterday coffee', 'expense', 'dining', 4.5, 'USD', 'Yesterday coffee');

  db.prepare(
    `INSERT INTO entries(user_id, message, type, category, amount, currency, description, status)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'complete')`,
  ).run(userId, 'today salary', 'income', 'salary', 3000, 'USD', 'Today salary');

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
  const sessionCookie = await login(baseUrl, 'user@example.com', 'password123');

  const dashboardResponse = await fetch(`${baseUrl}/`, {
    headers: {
      cookie: sessionCookie,
    },
  });

  assert.equal(dashboardResponse.status, 200);
  const dashboardHtml = await dashboardResponse.text();
  assert.match(dashboardHtml, /Today's expenses/);
  assert.match(dashboardHtml, /Today groceries/);
  assert.match(dashboardHtml, /18\.75/);
  const todaySection = dashboardHtml.match(/<h2>Today's expenses<\/h2>[\s\S]*?<h2>Recent entries<\/h2>/)?.[0] || '';
  assert.ok(todaySection, 'expected today expenses section');
  assert.doesNotMatch(todaySection, /Yesterday coffee/);
});
