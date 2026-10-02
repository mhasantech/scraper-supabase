# StockPulse Scraper — Supabase Primary + Firebase User Backup

StockPulse uses **Supabase as the primary database** and **Firebase Authentication** for login/authentication.

## Backup policy

Firebase Firestore is used only as a backup/fallback for user/business data:

- `user_registry`
- `user_meta`
- `subscriptions`
- `portfolios`
- `sales_history`
- `dividend_records`
- `admin_users`

The backup intentionally does **not** copy stock-price/history data such as:

- `dse_live_data`
- `daily_closing_prices`
- `cse_market_data`
- `dsex_index`
- `market_summary`
- `history_dse`
- `stock_metadata`

Market data remains in Supabase and can be scraped again from the source when needed.

## GitHub Secrets

Set these repository secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` — Supabase server/secret key only; never expose it in the frontend.
- `FIREBASE_SERVICE_ACCOUNT_KEY` — complete Firebase Admin SDK service-account JSON.

## Backup

Daily scheduled backup:

```bash
npm run backup:firebase
```

Manual full user/business backup:

```bash
BACKUP_MODE=full npm run backup:firebase
```

Both modes intentionally skip market-price/history tables.

## One-time legacy cleanup

The previous backup implementation may have created old market-data collections in Firestore. If those old copies are no longer needed, run:

```bash
npm run cleanup:firebase-market-backups
```

This deletes only these old collections:

- `backup_dse_live_data`
- `backup_daily_closing_prices`
- `backup_cse_market_data`
- `backup_market_summary`
- `backup_dsex_index`
- `backup_stock_metadata`
- `backup_history_dse`

Do this only after confirming the old market-data backups are no longer required.

## Pre-calculated indicators
`precompute_indicators.js` reads `history_dse`, calculates the latest technical-indicator snapshot for each ticker, and stores it in `stock_metadata.indicators`. It also keeps `stock_metadata.rsi` and `stock_metadata.psar` populated for compatibility. The app reads this snapshot first for fast scanner/indicator results and falls back to historical calculation only when the snapshot is unavailable.

Run once in Supabase SQL Editor:
`stock_metadata_migration.sql`

## DSE history + index scraper (fixed)

The historical updater no longer depends on `bd-stock-api-an3n.vercel.app`. It installs `bdshare`, fetches DSE historical OHLCV data with retry/fallback support, and writes normalized rows into `history_dse`. The updater refreshes the last 7 days on every run so a partially missed ticker/day can be repaired.

The DSEX updater no longer renders `/markets` in Chromium. It reads DSEX, DSES and DS30 from DSE's server-rendered **Recent Market Information** table and calculates daily absolute/percentage changes from consecutive DSE index values.

Run `stockpulse_history_constraints.sql` once in Supabase SQL Editor before the first fixed history run. This creates the `(ticker,date)` unique index required for safe PostgREST upserts.

Python requirement for history updater:

```bash
pip install -r requirements.txt
node scripts/update_dse_history.js
```
