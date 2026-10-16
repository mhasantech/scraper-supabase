// scripts/update_daily_closing.js
//
// Copies the CSE fundamentals (eps, pe_ratio, dividend, record_date, category) of the latest
// cse_market_data day into public.daily_closing_prices for today's Dhaka date.
//
// Why this version exists:
//  * dse_scraper.js already creates today's daily_closing_prices rows (ticker, date, ltp, high,
//    low, volume). The previous version of this script POSTed a second row for the same
//    (ticker, date); Supabase answered 409 (duplicate), the script ignored it, and eps /
//    pe_ratio were never written. That is why the newest dates had empty EPS and P/E.
//  * It also sent ltp/high/low from CSE (or 0), which would overwrite the DSE prices.
//  Now existing rows are only PATCHed with the fundamentals; a row is inserted (with CSE prices)
//  only when DSE did not create one for that ticker.
const axios = require('axios');
const https = require('https');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://dpdicusxlrdydajkcgev.supabase.co').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
  process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });
const PAGE = 1000;
const CONCURRENCY = 8;

const baseHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

function getDhakaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

async function retry(label, fn, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      const status = err.response?.status;
      const retryable = !status || status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || i === attempts) break;
      await new Promise(resolve => setTimeout(resolve, i * 1200));
    }
  }
  throw last;
}

async function getAll(path) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const sep = path.includes('?') ? '&' : '?';
    const response = await retry(`GET ${path}`, () => axios.get(
      `${SUPABASE_URL}/rest/v1/${path}${sep}limit=${PAGE}&offset=${offset}`,
      { headers: baseHeaders, httpsAgent: agent, timeout: 30000 }
    ));
    const chunk = Array.isArray(response.data) ? response.data : [];
    rows.push(...chunk);
    if (chunk.length < PAGE) break;
  }
  return rows;
}

// null / empty => undefined, so an existing value is never blanked by a missing one
const keep = value => (value === null || value === undefined || String(value).trim() === '' ? undefined : value);

function fundamentalsOf(row) {
  const f = {
    eps: keep(row.eps),
    pe_ratio: keep(row.pe_ratio),
    dividend: keep(row.dividend),
    record_date: keep(row.record_date),
    category: keep(row.category),
  };
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

async function pool(items, worker) {
  let index = 0;
  const results = [];
  async function run() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, run));
  return results;
}

async function updateDailyClosing() {
  const today = getDhakaDate();
  console.log(`📅 CSE দৈনিক ক্লোজিং আপডেট: ${today}`);

  // 1) latest CSE day only (not every historical row)
  const latest = await retry('latest cse date', () => axios.get(
    `${SUPABASE_URL}/rest/v1/cse_market_data?select=date&order=date.desc&limit=1`,
    { headers: baseHeaders, httpsAgent: agent, timeout: 30000 }
  ));
  const latestDate = latest.data?.[0]?.date;
  if (!latestDate) {
    console.log('ℹ️ cse_market_data-তে কোনো ডেটা পাওয়া যায়নি।');
    return { updated: 0, inserted: 0, errors: 0 };
  }
  console.log(`🗓️ CSE ডেটার সর্বশেষ তারিখ: ${latestDate}`);

  const cseRows = await getAll(
    `cse_market_data?select=code,ltp,high,low,eps,pe_ratio,dividend,record_date,category&date=eq.${encodeURIComponent(latestDate)}&order=code.asc`
  );
  const byCode = new Map();
  for (const row of cseRows) if (row.code && !byCode.has(row.code)) byCode.set(row.code, row);
  console.log(`📊 CSE টিকার: ${byCode.size}`);

  // 2) which tickers already have today's row (created by dse_scraper.js)?
  const existingRows = await getAll(`daily_closing_prices?select=ticker&date=eq.${encodeURIComponent(today)}&order=ticker.asc`);
  const existing = new Set(existingRows.map(r => r.ticker));
  console.log(`📦 আজকের বিদ্যমান daily_closing_prices সারি: ${existing.size}`);

  const stamp = new Date().toISOString();
  let updated = 0, inserted = 0, errors = 0;
  const firstErrors = [];

  await pool([...byCode.values()], async row => {
    const ticker = row.code;
    const fundamentals = fundamentalsOf(row);
    try {
      if (existing.has(ticker)) {
        // keep DSE ltp/high/low; only add fundamentals
        if (!Object.keys(fundamentals).length) return;
        await retry(`PATCH ${ticker}`, () => axios.patch(
          `${SUPABASE_URL}/rest/v1/daily_closing_prices?ticker=eq.${encodeURIComponent(ticker)}&date=eq.${encodeURIComponent(today)}`,
          { ...fundamentals, updated_at: stamp },
          { headers: { ...baseHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, httpsAgent: agent, timeout: 30000 }
        ));
        updated++;
      } else {
        // CSE-only ticker: create the row with CSE prices
        await retry(`UPSERT ${ticker}`, () => axios.post(
          `${SUPABASE_URL}/rest/v1/daily_closing_prices?on_conflict=ticker,date`,
          { ticker, date: today, ltp: row.ltp || 0, high: row.high || 0, low: row.low || 0, ...fundamentals, updated_at: stamp },
          { headers: { ...baseHeaders, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, httpsAgent: agent, timeout: 30000 }
        ));
        inserted++;
      }
    } catch (err) {
      errors++;
      if (firstErrors.length < 5) {
        firstErrors.push(`${ticker}: ${err.response?.status || ''} ${JSON.stringify(err.response?.data || err.message)}`.slice(0, 220));
      }
    }
  });

  console.log(`✅ দৈনিক ক্লোজিং আপডেট: fundamentals যোগ ${updated}, নতুন সারি ${inserted}, ব্যর্থ ${errors}`);
  if (errors > 0) {
    firstErrors.forEach(line => console.error(`   ↳ ${line}`));
    throw new Error(`${errors} daily closing writes failed.`);
  }
  return { updated, inserted, errors };
}

async function startScraper() {
  console.log(`🕐 ${new Date().toISOString()} - CSE দৈনিক ক্লোজিং আপডেট শুরু...`);
  await updateDailyClosing();
  console.log('✅ স্ক্রিপ্ট সম্পন্ন!');
}

if (require.main === module) {
  startScraper().catch(err => {
    console.error('❌ Fatal error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { startScraper, updateDailyClosing, fundamentalsOf };
