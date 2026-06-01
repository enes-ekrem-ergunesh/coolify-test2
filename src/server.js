const { createApp } = require('./app');
const { openDatabase, initDb } = require('./db');

const config = {
  port: Number.parseInt(process.env.PORT || '3000', 10),
  databasePath: process.env.DATABASE_PATH || './data/budget.db',
  sessionSecret: process.env.SESSION_SECRET,
  secureCookies: process.env.COOKIE_SECURE === 'true',
  openAiApiKey: process.env.OPENAI_API_KEY || '',
  openAiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  openAiBaseUrl: process.env.OPENAI_BASE_URL || '',
};

if (!config.sessionSecret) {
  throw new Error('SESSION_SECRET must be set before starting the app.');
}

const db = openDatabase(config.databasePath);
initDb(db);

const app = createApp({ db, config });
const server = app.listen(config.port, () => {
  console.log(`Budget app listening on http://127.0.0.1:${config.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
