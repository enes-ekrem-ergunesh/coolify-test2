const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const { EXPENSE_CATEGORIES, INCOME_CATEGORIES, categoryOptions } = require('./categories');
const { parseMessage } = require('./parser');

function createApp({ db, config }) {
  const app = express();
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.path === '/healthz',
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  const adminUsername = 'admin';
  const normalizedAdminPassword = String(config.adminPassword || '').replace(/[\r\n]+$/, '');
  const secureStringEqual = (left, right) => {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
  };
  const renderAdminDashboard = (req, res) => {
    const pendingUsers = db
      .prepare(
        `SELECT id, email, created_at
         FROM users
         WHERE is_verified = 0
         ORDER BY created_at ASC, id ASC`,
      )
      .all();
    const verifiedUsers = db
      .prepare(
        `SELECT id, email, created_at, verified_at
         FROM users
         WHERE is_verified = 1
         ORDER BY verified_at DESC, id DESC
         LIMIT 100`,
      )
      .all();
    return res.render('admin', {
      pendingUsers,
      verifiedUsers,
    });
  };
  const requireAdmin = (req, res) => {
    if (req.session.isAdmin) return true;
    req.session.flash = { type: 'error', message: 'Admin access is required.' };
    res.status(403).redirect('/');
    return false;
  };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      name: 'budget_chat_session',
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.secureCookies,
      },
    }),
  );
  app.use(generalLimiter);

  app.use((req, res, next) => {
    if (!req.session.csrfToken) {
      req.session.csrfToken = crypto.randomUUID();
    }
    res.locals.flash = req.session.flash || null;
    res.locals.csrfToken = req.session.csrfToken;
    delete req.session.flash;
    res.locals.userId = req.session.userId || null;
    res.locals.isAdmin = req.session.isAdmin === true;
    res.locals.pendingCount = 0;
    res.locals.plural = (n, singular, pluralForm) => n === 1 ? singular : (pluralForm || `${singular}s`);
    if (req.session.userId) {
      const row = db.prepare("SELECT COUNT(*) AS cnt FROM entries WHERE user_id = ? AND status = 'manual' AND deleted_at IS NULL").get(req.session.userId);
      res.locals.pendingCount = row ? row.cnt : 0;
    }
    next();
  });

  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return next();
    }

    const csrfToken = String(req.body?.csrfToken || '');
    if (!csrfToken || csrfToken !== req.session.csrfToken) {
      req.session.flash = { type: 'error', message: 'Your form expired. Please try again.' };
      return res.status(403).redirect('/');
    }

    const protocol = req.get('x-forwarded-proto') || req.protocol;
    const expectedOrigin = `${protocol}://${req.get('host')}`;
    const origin = req.get('origin');
    const referer = req.get('referer');
    if ((origin && origin !== expectedOrigin) || (!origin && referer && !referer.startsWith(expectedOrigin))) {
      req.session.flash = { type: 'error', message: 'Cross-site form submissions are not allowed.' };
      return res.status(403).redirect('/');
    }

    return next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/', (req, res) => {
    if (req.session.isAdmin) {
      return renderAdminDashboard(req, res);
    }
    if (!req.session.userId) {
      return res.render('auth', { email: '' });
    }

    const balances = db
      .prepare(
        `SELECT currency,
                ROUND(SUM(CASE WHEN type = 'income' AND status = 'complete' THEN amount ELSE 0 END), 2) AS income_total,
                ROUND(SUM(CASE WHEN type = 'expense' AND status = 'complete' THEN amount ELSE 0 END), 2) AS expense_total
         FROM entries
         WHERE user_id = ? AND deleted_at IS NULL
         GROUP BY currency
         ORDER BY currency ASC`,
      )
      .all(req.session.userId)
      .map((row) => ({
        ...row,
        balance: Number((row.income_total - row.expense_total).toFixed(2)),
      }));

    const thisMonth = db
      .prepare(
        `SELECT currency,
                ROUND(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 2) AS month_income,
                ROUND(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 2) AS month_expense
         FROM entries
         WHERE user_id = ? AND status = 'complete' AND deleted_at IS NULL
           AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
         GROUP BY currency
         ORDER BY currency ASC`,
      )
      .all(req.session.userId);

    const statsRow = db
      .prepare(
        `SELECT
           COUNT(CASE WHEN type = 'income' THEN 1 END) AS total_income_count,
           COUNT(CASE WHEN type = 'expense' THEN 1 END) AS total_expense_count
         FROM entries
         WHERE user_id = ? AND status = 'complete' AND deleted_at IS NULL`,
      )
      .get(req.session.userId);

    const topCatRow = db
      .prepare(
        `SELECT category FROM entries
         WHERE user_id = ? AND status = 'complete' AND type = 'expense' AND deleted_at IS NULL
         GROUP BY category
         ORDER BY SUM(amount) DESC
         LIMIT 1`,
      )
      .get(req.session.userId);

    const stats = {
      total_income_count: statsRow ? statsRow.total_income_count : 0,
      total_expense_count: statsRow ? statsRow.total_expense_count : 0,
      top_expense_category: topCatRow ? topCatRow.category : null,
    };

    const recentEntries = db
      .prepare(
        `SELECT id, message, type, category, amount, currency, description, status, parser_source, created_at
         FROM entries
        WHERE user_id = ? AND status = 'complete' AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 12`,
      )
      .all(req.session.userId);

    const todayExpenses = db
      .prepare(
        `SELECT id, category, amount, currency, description, created_at
        FROM entries
        WHERE user_id = ? AND status = 'complete' AND type = 'expense' AND deleted_at IS NULL
          AND strftime('%Y-%m-%d', created_at) = strftime('%Y-%m-%d', 'now')
        ORDER BY created_at DESC, id DESC`,
      )
      .all(req.session.userId);

    const walletByCurrency = balances.map((row) => ({
      currency: row.currency,
      amount: row.balance,
    }));
    const todayExpenseTotalsByCurrency = [];
    for (const row of todayExpenses) {
      const existing = todayExpenseTotalsByCurrency.find((item) => item.currency === row.currency);
      if (existing) {
        existing.total = Number((existing.total + row.amount).toFixed(2));
      } else {
        todayExpenseTotalsByCurrency.push({ currency: row.currency, total: Number(row.amount.toFixed(2)) });
      }
    }

    return res.render('dashboard', {
      balances,
      walletByCurrency,
      thisMonth,
      stats,
      todayExpenses,
      todayExpenseTotalsByCurrency,
      recentEntries,
      activePage: 'home',
    });
  });

  app.get('/admin', (req, res) => {
    if (!requireAdmin(req, res)) return undefined;
    return renderAdminDashboard(req, res);
  });

  app.get('/incomes', (req, res) => {
    if (!req.session.userId) return res.status(401).redirect('/');

    const entries = db
      .prepare(
        `SELECT id, type, category, amount, currency, description, created_at
         FROM entries
         WHERE user_id = ? AND status = 'complete' AND type = 'income' AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all(req.session.userId);

    return res.render('incomes', { entries, activePage: 'incomes' });
  });

  app.get('/expenses', (req, res) => {
    if (!req.session.userId) return res.status(401).redirect('/');

    const entries = db
      .prepare(
        `SELECT id, type, category, amount, currency, description, created_at
         FROM entries
         WHERE user_id = ? AND status = 'complete' AND type = 'expense' AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all(req.session.userId);

    return res.render('expenses', { entries, activePage: 'expenses' });
  });

  app.get('/categories', (req, res) => {
    if (!req.session.userId) return res.status(401).redirect('/');

    const rawTotals = db
      .prepare(
        `SELECT type, category, currency, ROUND(SUM(amount), 2) AS total, COUNT(*) AS count
         FROM entries
         WHERE user_id = ? AND status = 'complete' AND deleted_at IS NULL
         GROUP BY type, category, currency
         ORDER BY total DESC, category ASC`,
      )
      .all(req.session.userId);

    // Compute percentage relative to max within type+currency for a progress bar
    const maxByTypeCurrency = {};
    for (const row of rawTotals) {
      const key = `${row.type}:${row.currency}`;
      if (!maxByTypeCurrency[key] || row.total > maxByTypeCurrency[key]) {
        maxByTypeCurrency[key] = row.total;
      }
    }
    const categoryTotals = rawTotals.map((row) => ({
      ...row,
      pct: maxByTypeCurrency[`${row.type}:${row.currency}`]
        ? Math.round((row.total / maxByTypeCurrency[`${row.type}:${row.currency}`]) * 100)
        : 0,
    }));

    return res.render('categories', { categoryTotals, activePage: 'categories' });
  });

  app.get('/review', (req, res) => {
    if (!req.session.userId) return res.status(401).redirect('/');

    const manualEntries = db
      .prepare(
        `SELECT id, message, type, category, amount, currency, description, parser_reason, created_at
         FROM entries
         WHERE user_id = ? AND status = 'manual' AND deleted_at IS NULL
         ORDER BY created_at DESC, id DESC`,
      )
      .all(req.session.userId);

    return res.render('review', {
      manualEntries,
      incomeCategories: INCOME_CATEGORIES,
      expenseCategories: EXPENSE_CATEGORIES,
      activePage: 'review',
    });
  });

  app.get('/entries/:id/edit', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).redirect('/');
    }

    const entryId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(entryId) || entryId <= 0) {
      req.session.flash = { type: 'error', message: 'Entry not found.' };
      return res.status(404).redirect('/');
    }

    const entry = db
      .prepare(
        `SELECT id, type, category, amount, currency, description
         FROM entries
         WHERE id = ? AND user_id = ? AND status = 'complete' AND deleted_at IS NULL`,
      )
      .get(entryId, req.session.userId);

    if (!entry) {
      req.session.flash = { type: 'error', message: 'Entry not found.' };
      return res.status(404).redirect('/');
    }

    return res.render('edit-entry', {
      entry,
      incomeCategories: INCOME_CATEGORIES,
      expenseCategories: EXPENSE_CATEGORIES,
      activePage: entry.type === 'income' ? 'incomes' : 'expenses',
    });
  });

  app.get('/report', (req, res) => {
    if (!req.session.userId) return res.status(401).redirect('/');

    const availableMonths = db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m', created_at) AS month
         FROM entries
         WHERE user_id = ? AND status = 'complete' AND deleted_at IS NULL
         ORDER BY month DESC`,
      )
      .all(req.session.userId)
      .map((r) => r.month);

    const currentMonth = new Date().toISOString().slice(0, 7);
    const rawMonth = String(req.query.month || '').trim();
    const selectedMonth = /^\d{4}-\d{2}$/.test(rawMonth)
      ? rawMonth
      : (availableMonths[0] || currentMonth);

    const monthlySummary = db
      .prepare(
        `SELECT currency,
                ROUND(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 2) AS income_total,
                ROUND(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 2) AS expense_total
         FROM entries
         WHERE user_id = ? AND status = 'complete' AND deleted_at IS NULL
           AND strftime('%Y-%m', created_at) = ?
         GROUP BY currency
         ORDER BY currency ASC`,
      )
      .all(req.session.userId, selectedMonth);

    const rawBreakdown = db
      .prepare(
        `SELECT type, category, currency, ROUND(SUM(amount), 2) AS total, COUNT(*) AS count
         FROM entries
        WHERE user_id = ? AND status = 'complete' AND deleted_at IS NULL
           AND strftime('%Y-%m', created_at) = ?
         GROUP BY type, category, currency
         ORDER BY type ASC, total DESC`,
      )
      .all(req.session.userId, selectedMonth);

    const [year, month] = selectedMonth.split('-').map((part) => Number.parseInt(part, 10));
    const monthStart = `${selectedMonth}-01`;
    const monthEnd = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    const monthlyWallet = db
      .prepare(
       `SELECT currency,
               ROUND(SUM(CASE WHEN created_at < ? AND type = 'income' AND status = 'complete' THEN amount ELSE 0 END), 2) AS opening_income,
               ROUND(SUM(CASE WHEN created_at < ? AND type = 'expense' AND status = 'complete' THEN amount ELSE 0 END), 2) AS opening_expense,
               ROUND(SUM(CASE WHEN created_at < ? AND type = 'income' AND status = 'complete' THEN amount ELSE 0 END), 2) AS closing_income,
               ROUND(SUM(CASE WHEN created_at < ? AND type = 'expense' AND status = 'complete' THEN amount ELSE 0 END), 2) AS closing_expense
        FROM entries
        WHERE user_id = ? AND deleted_at IS NULL
        GROUP BY currency
        ORDER BY currency ASC`,
      )
      .all(monthStart, monthStart, monthEnd, monthEnd, req.session.userId)
      .map((row) => ({
       currency: row.currency,
       startMoney: Number((row.opening_income - row.opening_expense).toFixed(2)),
       endMoney: Number((row.closing_income - row.closing_expense).toFixed(2)),
      }));

    const maxByTypeCurrency = {};
    for (const row of rawBreakdown) {
      const key = `${row.type}:${row.currency}`;
      if (!maxByTypeCurrency[key] || row.total > maxByTypeCurrency[key]) {
        maxByTypeCurrency[key] = row.total;
      }
    }
    const categoryBreakdown = rawBreakdown.map((row) => ({
      ...row,
      pct: maxByTypeCurrency[`${row.type}:${row.currency}`]
        ? Math.round((row.total / maxByTypeCurrency[`${row.type}:${row.currency}`]) * 100)
        : 0,
    }));

    return res.render('report', {
      availableMonths,
      selectedMonth,
      monthlySummary,
      monthlyWallet,
      categoryBreakdown,
      activePage: 'report',
    });
  });

  app.get('/trash', (req, res) => {
    if (!req.session.userId) return res.status(401).redirect('/');

    const deletedEntries = db
      .prepare(
        `SELECT id, message, type, category, amount, currency, description, status, created_at, deleted_at
         FROM entries
         WHERE user_id = ? AND deleted_at IS NOT NULL
         ORDER BY deleted_at DESC, id DESC`,
      )
      .all(req.session.userId);

    return res.render('trash', { deletedEntries, activePage: 'trash' });
  });

  app.post('/register', authLimiter, async (req, res) => {
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

    const passwordHash = await bcrypt.hash(password, 12);
    db.prepare('INSERT INTO users(email, password_hash, is_verified) VALUES(?, ?, 0)').run(email, passwordHash);
    req.session.flash = { type: 'warning', message: 'Registration received. Please wait for admin verification before signing in.' };
    return res.redirect('/');
  });

  app.post('/admin/login', authLimiter, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!normalizedAdminPassword || username !== adminUsername || !secureStringEqual(password, normalizedAdminPassword)) {
      req.session.flash = { type: 'error', message: 'Invalid admin credentials.' };
      return res.status(401).redirect('/');
    }

    return req.session.regenerate((error) => {
      if (error) {
        req.session.flash = { type: 'error', message: 'Unable to create admin session.' };
        return res.status(500).redirect('/');
      }
      req.session.isAdmin = true;
      req.session.flash = { type: 'success', message: 'Admin signed in successfully.' };
      return res.redirect('/admin');
    });
  });

  app.post('/login', authLimiter, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT id, password_hash, is_verified FROM users WHERE email = ?').get(email);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      req.session.flash = { type: 'error', message: 'Invalid email or password.' };
      return res.status(401).redirect('/');
    }
    if (user.is_verified !== 1) {
      req.session.flash = { type: 'warning', message: 'Your account is pending admin verification.' };
      return res.status(403).redirect('/');
    }

    return req.session.regenerate((error) => {
      if (error) {
        req.session.flash = { type: 'error', message: 'Unable to create session.' };
        return res.status(500).redirect('/');
      }
      req.session.userId = user.id;
      req.session.flash = { type: 'success', message: 'Signed in successfully.' };
      return res.redirect('/');
    });
  });

  app.post('/admin/users/:id/verify', (req, res) => {
    if (!requireAdmin(req, res)) return undefined;

    const userId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      req.session.flash = { type: 'error', message: 'Invalid user.' };
      return res.status(400).redirect('/admin');
    }

    const result = db
      .prepare(
        `UPDATE users
         SET is_verified = 1, verified_at = CURRENT_TIMESTAMP
         WHERE id = ? AND is_verified = 0`,
      )
      .run(userId);

    req.session.flash = result.changes > 0
      ? { type: 'success', message: 'User verified successfully.' }
      : { type: 'warning', message: 'User not found or already verified.' };
    return res.redirect('/admin');
  });

  app.post('/admin/users/:id/dismiss', (req, res) => {
    if (!requireAdmin(req, res)) return undefined;

    const userId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(userId) || userId <= 0) {
      req.session.flash = { type: 'error', message: 'Invalid user.' };
      return res.status(400).redirect('/admin');
    }

    const result = db
      .prepare('DELETE FROM users WHERE id = ? AND is_verified = 0')
      .run(userId);

    req.session.flash = result.changes > 0
      ? { type: 'success', message: 'Pending registration dismissed.' }
      : { type: 'warning', message: 'User not found or already verified.' };
    return res.redirect('/admin');
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
    let type = req.body.type === 'income' ? 'income' : 'expense';
    if (INCOME_CATEGORIES.includes(category)) {
      type = 'income';
    } else if (EXPENSE_CATEGORIES.includes(category)) {
      type = 'expense';
    }
    const allowedCategories = categoryOptions(type);

    const existing = db.prepare('SELECT id FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(entryId, req.session.userId);
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
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    ).run(type, category, amount, currency, description, entryId, req.session.userId);

    req.session.flash = { type: 'success', message: 'Entry finalized successfully.' };
    return res.redirect('/review');
  });

  app.post('/entries/:id/dismiss', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).redirect('/');
    }

    const entryId = Number.parseInt(req.params.id, 10);
    const existing = db
     .prepare("SELECT id FROM entries WHERE id = ? AND user_id = ? AND status = 'manual' AND deleted_at IS NULL")
      .get(entryId, req.session.userId);

    if (!existing) {
      req.session.flash = { type: 'error', message: 'Entry not found.' };
      return res.status(404).redirect('/review');
    }

    db.prepare('UPDATE entries SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(entryId, req.session.userId);
    req.session.flash = { type: 'success', message: 'Entry moved to trash.' };
    return res.redirect('/review');
  });

  app.post('/entries/:id/archive', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).redirect('/');
    }

    const entryId = Number.parseInt(req.params.id, 10);
    const existing = db
      .prepare("SELECT id, type FROM entries WHERE id = ? AND user_id = ? AND status = 'complete' AND deleted_at IS NULL")
      .get(entryId, req.session.userId);

    if (!existing) {
      req.session.flash = { type: 'error', message: 'Entry not found.' };
      return res.status(404).redirect('/');
    }

    db.prepare('UPDATE entries SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?').run(entryId, req.session.userId);
    req.session.flash = { type: 'success', message: 'Entry moved to trash.' };
    return res.redirect(existing.type === 'income' ? '/incomes' : '/expenses');
  });

  app.post('/entries/:id/edit', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).redirect('/');
    }

    const entryId = Number.parseInt(req.params.id, 10);
    const type = req.body.type === 'income' ? 'income' : 'expense';
    const category = String(req.body.category || '').trim();
    const amount = Number.parseFloat(String(req.body.amount || '').trim());
    const currency = String(req.body.currency || 'USD').trim().toUpperCase() || 'USD';
    const description = String(req.body.description || '').trim();
    const allowedCategories = categoryOptions(type);

    const existing = db
      .prepare("SELECT id FROM entries WHERE id = ? AND user_id = ? AND status = 'complete' AND deleted_at IS NULL")
      .get(entryId, req.session.userId);

    if (!existing) {
      req.session.flash = { type: 'error', message: 'Entry not found.' };
      return res.status(404).redirect('/');
    }

    if (!allowedCategories.includes(category) || !Number.isFinite(amount) || amount <= 0 || !description) {
      req.session.flash = { type: 'error', message: 'Use a valid type, category, amount, and description to update the entry.' };
      return res.status(400).redirect(`/entries/${entryId}/edit`);
    }

    db.prepare(
      `UPDATE entries
       SET type = ?, category = ?, amount = ?, currency = ?, description = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND status = 'complete' AND deleted_at IS NULL`,
    ).run(type, category, amount, currency, description, entryId, req.session.userId);

    req.session.flash = { type: 'success', message: 'Entry updated successfully.' };
    return res.redirect(type === 'income' ? '/incomes' : '/expenses');
  });

  app.post('/entries/:id/delete', (req, res) => {
    if (!req.session.userId) {
      return res.status(401).redirect('/');
    }

    const entryId = Number.parseInt(req.params.id, 10);
    const existing = db
      .prepare('SELECT id FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
      .get(entryId, req.session.userId);

    if (!existing) {
      req.session.flash = { type: 'error', message: 'Deleted entry not found.' };
      return res.status(404).redirect('/trash');
    }

    db.prepare('DELETE FROM entries WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL').run(entryId, req.session.userId);
    req.session.flash = { type: 'success', message: 'Entry permanently deleted.' };
    return res.redirect('/trash');
  });

  return app;
}

module.exports = {
  createApp,
};
