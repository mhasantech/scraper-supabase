// StockPulse ticker coverage audit (read-only).
// Compares the app's canonical core.js list with tickers present in Supabase tables.
// Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY. Optional: APP_CORE_JS path.
const fs = require('fs');
const path = require('path');
const { fetchDistinctColumn, isLikelyNonEquityCode } = require('./lib/tickers');
const root = path.resolve(__dirname, '..');
// APP_CORE_JS wins; otherwise try common sibling layouts (app repo next to this scraper repo).
const appCoreCandidates = [
  process.env.APP_CORE_JS,
  path.resolve(root, '../My-Stock-main/core.js'),
  path.resolve(root, '../My-Stock/core.js'),
  path.resolve(root, '../My-Stock-main/My-Stock-main/core.js'),
  path.resolve(root, 'core.js')
].filter(Boolean);
const appCore = appCoreCandidates.find(f => fs.existsSync(f)) || appCoreCandidates[0];
// Date-keyed tables are read for their latest day only (fast). AUDIT_ALL_ROWS=1 scans every row,
// which also reveals delisted symbols that only exist in history.
const allRows = process.env.AUDIT_ALL_ROWS === '1';

function extractAppTickers(file) {
  if (!fs.existsSync(file)) throw new Error(`Cannot find core.js at ${file}. Set APP_CORE_JS to its path.`);
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/const\s+dseStocks\s*=\s*\[([\s\S]*?)\];/);
  if (!match) throw new Error('Could not parse const dseStocks = [...] from core.js');
  const tickers = [...match[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1].trim().toUpperCase()).filter(Boolean);
  return [...new Set(tickers)].sort();
}

function csvCell(value) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }

async function main() {
  const appTickers = extractAppTickers(appCore);
  // [table, column, dated]  (dated = table has a `date` column, so latest-day mode applies)
  const sources = [
    ['dse_live_data', 'ticker', true],
    ['history_dse', 'ticker', true],
    ['daily_closing_prices', 'ticker', true],
    ['stock_metadata', 'ticker', false],
    ['cse_market_data', 'code', true],
    ['dse_dividend_data', 'code', false]
  ];
  const db = {};
  const errors = [];
  for (const [table, column, dated] of sources) {
    try { db[table] = await fetchDistinctColumn(table, column, { dated, allRows }); }
    catch (error) {
      db[table] = new Set();
      errors.push(`${table}: ${error.response?.data?.message || error.message}`);
      console.warn(`⚠️ ${errors[errors.length - 1]}`);
    }
  }
  const appSet = new Set(appTickers);
  const dbUniverse = new Set();
  for (const [table] of sources) for (const ticker of db[table]) dbUniverse.add(ticker);
  const rows = [];
  for (const ticker of [...new Set([...appSet, ...dbUniverse])].sort()) {
    const row = { ticker, in_app_core: appSet.has(ticker) };
    for (const [table] of sources) row[table] = db[table].has(ticker);
    row.status = !row.in_app_core ? (isLikelyNonEquityCode(ticker) ? 'DATABASE_ONLY_GOVT_SECURITY_FILTERED' : 'DATABASE_ONLY_NOT_IN_APP') : sources.some(([table]) => db[table].has(ticker)) ? 'COVERED' : 'APP_ONLY_NO_DB_ROWS';
    rows.push(row);
  }
  const outDir = path.resolve(process.env.TICKER_AUDIT_OUT || path.join(root, 'ticker-audit-output'));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'ticker_coverage_audit.csv'), [
    Object.keys(rows[0] || { ticker: '', in_app_core: '', status: '' }).join(','),
    ...rows.map(row => Object.values(row).map(csvCell).join(','))
  ].join('\n') + '\n');
  const summary = {
    generated_at: new Date().toISOString(), app_core_path: appCore,
    app_ticker_count: appSet.size, mode: allRows ? 'all-rows' : 'latest-day',
    db_counts: Object.fromEntries(sources.map(([table]) => [table, db[table].size])),
    database_only_not_in_app: rows.filter(r => r.status === 'DATABASE_ONLY_NOT_IN_APP').map(r => r.ticker),
    app_only_no_db_rows: rows.filter(r => r.status === 'APP_ONLY_NO_DB_ROWS').map(r => r.ticker),
    source_errors: errors
  };
  fs.writeFileSync(path.join(outDir, 'ticker_coverage_summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ ...summary, report_directory: outDir }, null, 2));
  if (errors.length) process.exitCode = 1;
}
main().catch(error => { console.error('Ticker coverage audit failed:', error.response?.data || error.message || error); process.exit(1); });
