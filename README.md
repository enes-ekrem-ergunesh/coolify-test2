# Budget Chat Compose App

A small Docker Compose app for personal budget tracking with:

- email/password registration
- a single natural-language message field for entry creation
- OpenAI-assisted parsing for income and expense entries
- a manual review queue for anything the parser cannot confidently understand
- soft delete (trash) and permanent delete flow for entries
- basic budget analytics (balances and category totals)
- wallet balance visibility and monthly start/end money reporting
- SQLite persistence
- a Docker health check for the main app

## Tech stack

- Node.js + Express
- EJS server-rendered UI
- SQLite via `better-sqlite3`
- OpenAI API for message understanding
- Docker Compose for local deployment

## Supported categories

### Income types (5)

- salary
- freelance
- bonus
- gift
- investment

### Expense types (10)

- groceries
- dining
- transport
- utilities
- rent
- shopping
- health
- entertainment
- education
- travel

## Environment variables

Required or useful environment variables used by this app:

- `PORT` *(optional, default: `8542`)* — app listen port inside the container
- `APP_PORT` *(optional, default: `8542`)* — host port exposed on `127.0.0.1`
- `SESSION_SECRET` *(required)* — session signing secret; set a long random value before starting the app
- `ADMIN_PASSWORD` *(required)* — admin login password for username `admin`
- `DATABASE_PATH` *(optional, default in container: `/app/data/budget.db`)* — SQLite database path
- `OPENAI_API_KEY` *(optional but required for AI parsing)* — OpenAI API key
- `OPENAI_MODEL` *(optional, default: `gpt-4o-mini`)* — OpenAI model name
- `OPENAI_BASE_URL` *(optional)* — alternate OpenAI-compatible base URL
- `COOKIE_SECURE` *(optional, default: `false`)* — set to `true` only when serving the app over HTTPS

If `OPENAI_API_KEY` is not set, the app falls back to a simple built-in parser and sends uncertain messages to the manual review queue.

## Run with Docker Compose

```bash
export SESSION_SECRET='replace-with-a-long-random-secret'
export ADMIN_PASSWORD='replace-with-a-strong-admin-password'
docker compose up --build
```

Then open:

- `http://127.0.0.1:8542` by default
- or `http://127.0.0.1:${APP_PORT}` if you override the port

Only the main HTTP app is exposed outside the compose network. Persistence is stored in the `app-data` Docker volume.

## Health check

The `app` service includes a Docker health check that calls:

- `GET /healthz`

The provided `Dockerfile` uses Node.js 24, so the health check can rely on the built-in `fetch()` runtime.

## Local development

```bash
npm install
npm test
npm start
```

## Example messages

- `got salary 2k dollars`
- `market 5 USD`
- `bought a t-shirt for 5 bucks`
- `received freelance payment 400 EUR`
- `paid internet bill 45 USD`

## Manual review flow

If the parser cannot confidently extract a structured entry, the message is still saved. The user can then complete the missing fields from the **Manual review queue** in the dashboard.

## User verification flow

- New users can register but are created in a pending state.
- Only the admin account (`admin` + `ADMIN_PASSWORD`) can verify pending users from the admin dashboard.
- Pending users cannot log in until they are verified.
