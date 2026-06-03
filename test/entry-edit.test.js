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

test('user can edit their own complete entry', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coolify-entry-edit-'));
  const db = openDatabase(path.join(tempDir, 'entry-edit-test.db'));
  initDb(db);

  const passwordHash = await bcrypt.hash('password123', 12);
  const userInsert = db.prepare('INSERT INTO users(email, password_hash, is_verified) VALUES(?, ?, 1)').run('user@example.com', passwordHash);
  const entryInsert = db.prepare(
    `INSERT INTO entries(user_id, message, type, category, amount, currency, description, status)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'complete')`,
  ).run(userInsert.lastInsertRowid, 'salary 2000', 'income', 'salary', 2000, 'USD', 'June salary');

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

  const editPageResponse = await fetch(`${baseUrl}/entries/${entryInsert.lastInsertRowid}/edit`, {
    headers: {
      cookie: sessionCookie,
    },
  });
  const editHtml = await editPageResponse.text();
  const editCsrfToken = editHtml.match(/name="csrfToken" type="hidden" value="([^"]+)"/)?.[1];

  assert.equal(editPageResponse.status, 200);
  assert.match(editHtml, /Edit entry/);
  assert.ok(editCsrfToken, 'expected edit csrf token');

  const updateResponse = await fetch(`${baseUrl}/entries/${entryInsert.lastInsertRowid}/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: sessionCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrfToken: editCsrfToken,
      type: 'expense',
      category: 'groceries',
      amount: '42.50',
      currency: 'EUR',
      description: 'Weekly groceries',
    }),
  });

  assert.equal(updateResponse.status, 302);
  assert.equal(updateResponse.headers.get('location'), '/expenses');

  const updatedEntry = db.prepare('SELECT type, category, amount, currency, description FROM entries WHERE id = ?').get(entryInsert.lastInsertRowid);
  assert.equal(updatedEntry.type, 'expense');
  assert.equal(updatedEntry.category, 'groceries');
  assert.equal(updatedEntry.amount, 42.5);
  assert.equal(updatedEntry.currency, 'EUR');
  assert.equal(updatedEntry.description, 'Weekly groceries');
});

test('user cannot edit another user entry', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'coolify-entry-edit-owner-'));
  const db = openDatabase(path.join(tempDir, 'entry-edit-owner-test.db'));
  initDb(db);

  const passwordHash = await bcrypt.hash('password123', 12);
  const ownerInsert = db.prepare('INSERT INTO users(email, password_hash, is_verified) VALUES(?, ?, 1)').run('owner@example.com', passwordHash);
  db.prepare('INSERT INTO users(email, password_hash, is_verified) VALUES(?, ?, 1)').run('intruder@example.com', passwordHash);
  const entryInsert = db.prepare(
    `INSERT INTO entries(user_id, message, type, category, amount, currency, description, status)
     VALUES(?, ?, ?, ?, ?, ?, ?, 'complete')`,
  ).run(ownerInsert.lastInsertRowid, 'salary 1500', 'income', 'salary', 1500, 'USD', 'Owner salary');

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
  const intruderCookie = await login(baseUrl, 'intruder@example.com', 'password123');

  const editPageResponse = await fetch(`${baseUrl}/entries/${entryInsert.lastInsertRowid}/edit`, {
    headers: {
      cookie: intruderCookie,
    },
    redirect: 'manual',
  });
  assert.equal(editPageResponse.status, 302);
  assert.equal(editPageResponse.headers.get('location'), '/');

  const homepageResponse = await fetch(`${baseUrl}/`, {
    headers: {
      cookie: intruderCookie,
    },
  });
  const homepageHtml = await homepageResponse.text();
  const csrfToken = homepageHtml.match(/name="csrfToken" type="hidden" value="([^"]+)"/)?.[1];
  assert.ok(csrfToken, 'expected csrf token');

  const updateResponse = await fetch(`${baseUrl}/entries/${entryInsert.lastInsertRowid}/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie: intruderCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrfToken,
      type: 'expense',
      category: 'groceries',
      amount: '1.00',
      currency: 'USD',
      description: 'Intruder edit',
    }),
  });

  assert.equal(updateResponse.status, 302);
  assert.equal(updateResponse.headers.get('location'), '/');

  const unchangedEntry = db.prepare('SELECT type, category, amount, description FROM entries WHERE id = ?').get(entryInsert.lastInsertRowid);
  assert.equal(unchangedEntry.type, 'income');
  assert.equal(unchangedEntry.category, 'salary');
  assert.equal(unchangedEntry.amount, 1500);
  assert.equal(unchangedEntry.description, 'Owner salary');
});
