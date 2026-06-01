const path = require('node:path');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const { EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoryOptions } = require('./categories');
const { parseMessage } = require('./parser');

function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
      },
    }),
  );

  app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    res.locals.userId = req.session.userId || null;
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/', (req, res) => {
    if (!req.session.userId) {
      return res.render('auth', { email: '' });
    }

    const balances = db
      .prepare(
        `SELECT currency,
                ROUND(SUM(CASE WHEN type = 'income' AND status = 'complete' THEN amount ELSE 0 END), 2) AS income_total,
                ROUND(SUM(CASE WHEN type = 'expense' AND status = 'complete' THEN amount ELSE 0 END), 2) AS expense_total
         FROM entries
         WHERE user_id = ?
         GROUP BY currency
         ORDER BY currency ASC`,
      )
      .all(req.session.userId)
      .map((row) => ({
        ...row,
        balance: Number((row.income_total - row.expense_total).toFixed(2)),
      }));

    const recentEntries = db
      .prepare(
        `SELECT id, message, type, category, amount, currency, description, status, parser_source, created_at
         FROM entries
         WHERE user_id = ? AND status = 'complete'
         ORDER BY created_at DESC, id DESC
         LIMIT 12`,
      )
      .all(req.session.userId);

    const manualEntries = db
      .prepare(
        `SELECT id, message, type, category, amount, currency, description, parser_reason, created_at
         FROM entries
         WHERE user_id = ? AND status = 'manual'
         ORDER BY created_at DESC, id DESC`,
      )
      .all(req.session.userId);

    const categoryTotals = db
      .prepare(
        `SELECT type, category, currency, ROUND(SUM(amount), 2) AS total
         FROM entries
         WHERE user_id = ? AND status = 'complete'
         GROUP BY type, category, currency
         ORDER BY total DESC, category ASC`,
      )
      .all(req.session.userId);

    return res.render('dashboard', {
      balances,
      recentEntries,
      manualEntries,
      categoryTotals,
      incomeCategories: INCOME_CATEGORIES,
      expenseCategories: EXPENSE_CATEGORIES,
    });
  });

  app.post('/register', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password || password.length < 8) {
      req.session.flash = { type: 'error', message: 'Use a valid email and a password with at least 8 characters.' };
      return res.status(400).redirect('/');
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      req.session.flash = { type: 'error', message: 'An account with that email already exists.' };
      return res.status(409).redirect('/');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users(email, password_hash) VALUES(?, ?)').run(email, passwordHash);
    req.session.userId = result.lastInsertRowid;
    req.session.flash = { type: 'success', message: 'Welcome! Your account is ready.' };
    return res.redirect('/');
  });

  app.post('/login', async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      req.session.flash = { type: 'error', message: 'Invalid email or password.' };
      return res.status(401).redirect('/');
    }

    req.session.userId = user.id;
    req.session.flash = { type: 'success', message: 'Signed in successfully.' };
    return res.redirect('/');
  });

  app.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.redirect('/');
    });
  });

  app.post('/entries', async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).redirect('/');
    }

    const message = String(req.body.message || '').trim();
    if (!message) {
      req.session.flash = { type: 'error', message: 'Enter a message before saving.' };
      return res.status(400).redirect('/');
    }

    const parsed = await parseMessage(message, {
      apiKey: config.openAiApiKey,
      model: config.openAiModel,
      baseUrl: config.openAiBaseUrl,
    });

    db.prepare(
      `INSERT INTO entries(user_id, message, type, category, amount, currency, description, status, parser_source, parser_reason)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      req.session.userId,
      parsed.message,
      parsed.type,
      parsed.category,
      parsed.amount,
      parsed.currency,
      parsed.description,
      parsed.status,
      parsed.parserSource,
      parsed.reason,
    );

    req.session.flash = parsed.status === 'complete'
      ? { type: 'success', message: `Saved ${parsed.type} entry in ${parsed.category}.` }
      : { type: 'warning', message: 'Saved the message for manual review because the parser was not confident.' };

    return res.redirect('/');
  });

  app.post('/entries/:id/resolve', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).redirect('/');
    }

    const entryId = Number.parseInt(req.params.id, 10);
    const category = String(req.body.category || '').trim();
    const amount = Number.parseFloat(String(req.body.amount || '').trim());
    const currency = String(req.body.currency || 'USD').trim().toUpperCase() || 'USD';
    const description = String(req.body.description || '').trim();
    const type = INCOME_CATEGORIES.includes(category)
      ? 'income'
      : EXPENSE_CATEGORIES.includes(category)
        ? 'expense'
        : req.body.type === 'income'
          ? 'income'
          : 'expense';
    const allowedCategories = categoryOptions(type);

    const existing = db.prepare('SELECT id FROM entries WHERE id = ? AND user_id = ?').get(entryId, req.session.userId);
    if (!existing) {
      req.session.flash = { type: 'error', message: 'Entry not found.' };
      return res.status(404).redirect('/');
    }

    if (!allowedCategories.includes(category) || !Number.isFinite(amount) || amount <= 0) {
      req.session.flash = { type: 'error', message: 'Use a valid type, category, and amount to finalize the entry.' };
      return res.status(400).redirect('/');
    }

    db.prepare(
      `UPDATE entries
       SET type = ?, category = ?, amount = ?, currency = ?, description = ?, status = 'complete', parser_reason = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ?`,
    ).run(type, category, amount, currency, description, entryId, req.session.userId);

    req.session.flash = { type: 'success', message: 'Entry finalized successfully.' };
    return res.redirect('/');
  });

  return app;
}

module.exports = {
  createApp,
};
