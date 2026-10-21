// scripts/dse_dividend_history_scraper.js
// Scrapes historical cash/stock dividend percentages from DSE legacy company pages
// and upserts one row per ticker into Supabase public.dse_dividend_data.
//
// Speed: the old version fetched one ticker at a time, and because the DSE certificate chain is
// incomplete ("unable to verify the first certificate") every direct request failed and every
// ticker fell back to a full Chromium launch (about 5-10 s each). Now:
//   * public DSE pages are fetched with the market-data TLS agent, so the plain HTTP request works;
//   * several tickers are processed in parallel (DIVIDEND_CONCURRENCY, default 6);
//   * Chromium is only a capped last resort (DIVIDEND_MAX_BROWSER_FALLBACKS, default 15 per run);
//   * each page is parsed once.
const cheerio = require('cheerio');
const {
  axios, httpsAgent, externalHttpsAgent, SUPABASE_URL,
  cleanText, supabaseHeaders, retry, renderPage
} = require('./lib/common');

const DSE_COMPANY_URL = 'https://old.dsebd.org/displayCompany.php?name=';
const YEARS = Array.from({ length: 2035 - 1990 + 1 }, (_, i) => 1990 + i);
const DELAY_MS = Number(process.env.DIVIDEND_SCRAPE_DELAY_MS || 120);
const CONCURRENCY = Math.max(1, Number(process.env.DIVIDEND_CONCURRENCY || 6));
const MAX_BROWSER_FALLBACKS = Number(process.env.DIVIDEND_MAX_BROWSER_FALLBACKS || 15);

function parseDividendEntries(text) {
  const out = {};
  const normalized = cleanText(text).replace(/[–—]/g, '-');
  // The legacy page usually prints values like "10% 2024, 11% 2023".
  const re = /(\d+(?:\.\d+)?)\s*%\s*(?:,?\s*)((?:19|20)\d{2})/g;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const pct = Number(m[1]);
    const year = Number(m[2]);
    if (year >= 1990 && year <= 2035 && Number.isFinite(pct)) out[year] = pct;
  }
  return out;
}

function getRowValue($, label) {
  let found = '';
  $('tr').each((_, tr) => {
    const cells = $(tr).find('th,td');
    if (cells.length < 2) return;
    const key = cleanText($(cells[0]).text()).toLowerCase();
    if (key.includes(label.toLowerCase())) {
      // Do not pass dividend text to $() as a selector; strings like '% 2022'
      // are invalid CSS selectors and caused every ticker to fail.
      found = cleanText(cells.slice(1).map((_, cell) => $(cell).text()).get().join(' '));
    }
  });
  return found;
}

function parseCompanyPage(html, ticker) {
  const $ = cheerio.load(html);
  const text = cleanText($('body').text());
  const cashText = getRowValue($, 'Cash Dividend');
  const stockText = getRowValue($, 'Bonus Issue') || getRowValue($, 'Stock Dividend');
  const cash = parseDividendEntries(cashText);
  const stock = parseDividendEntries(stockText);

  // Fallback for legacy layouts where labels/values aren't in a normal two-cell row.
  if (!Object.keys(cash).length || !Object.keys(stock).length) {
    const lines = text.split(/(?=Cash Dividend|Bonus Issue|Stock Dividend)/i);
    for (const line of lines) {
      if (!Object.keys(cash).length && /Cash Dividend/i.test(line)) Object.assign(cash, parseDividendEntries(line.slice(0, 700)));
      if (!Object.keys(stock).length && /(Bonus Issue|Stock Dividend)/i.test(line)) Object.assign(stock, parseDividendEntries(line.slice(0, 700)));
    }
  }

  const record = {
    code: ticker,
    date: new Date().toISOString().slice(0, 10),
    listing_year: null,
    share_category: null,
    record_date: null,
    source_url: DSE_COMPANY_URL + encodeURIComponent(ticker),
    updated_at: new Date().toISOString()
  };

  // Try common company-profile labels, but leave missing values null rather than guessing.
  const listing = getRowValue($, 'Listing Year');
  const category = getRowValue($, 'Category');
  const recordDate = getRowValue($, 'Record Date');
  if (listing) record.listing_year = listing;
  if (category) record.share_category = category;
  if (recordDate) record.record_date = recordDate;

  for (const year of YEARS) {
    record[`cash_dividend_${year}`] = Object.prototype.hasOwnProperty.call(cash, year) ? cash[year] : null;
    record[`stock_dividend_${year}`] = Object.prototype.hasOwnProperty.call(stock, year) ? stock[year] : null;
  }
  return { record, cash, stock, cashCount: Object.keys(cash).length, stockCount: Object.keys(stock).length, pageTextLength: text.length };
}

const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml'
};

let browserFallbacksLeft = MAX_BROWSER_FALLBACKS;

async function fetchCompanyPage(ticker) {
  const url = DSE_COMPANY_URL + encodeURIComponent(ticker);
  try {
    return await retry(async () => {
      const response = await axios.get(url, {
        httpsAgent: externalHttpsAgent,
        timeout: 20000,
        headers: PAGE_HEADERS,
        responseType: 'text',
        validateStatus: status => status === 200
      });
      const html = String(response.data);
      if (html.length < 1000) throw new Error('DSE returned a too-small page');
      return html;
    }, `DSE page ${ticker}`, 3, 1500);
  } catch (e) {
    // Chromium is slow, so it is a capped last resort rather than the normal path.
    if (browserFallbacksLeft > 0) {
      browserFallbacksLeft--;
      console.warn(`⚠️ Direct fetch failed for ${ticker}: ${e.message}; trying Chromium (${browserFallbacksLeft} fallbacks left)`);
      return renderPage(url, 10000);
    }
    throw new Error(`Direct fetch failed (${e.message}); Chromium fallback limit reached`);
  }
}

async function fetchTickers() {
  const base = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/dse_live_data`;
  const all = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${base}?select=ticker&order=ticker.asc&limit=${pageSize}&offset=${offset}`;
    const { data } = await retry(async () => axios.get(url, {
      headers: supabaseHeaders(), httpsAgent, timeout: 30000
    }), `Fetch DSE ticker list offset ${offset}`);
    all.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  const tickers = [...new Set(all.map(x => cleanText(x.ticker).toUpperCase()).filter(Boolean))];
  if (!tickers.length) throw new Error('No tickers found in Supabase dse_live_data. Check table data and API permissions.');
  console.log(`📚 Loaded ${tickers.length} unique tickers across paginated results.`);
  return tickers;
}

async function upsertDividend(record) {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/dse_dividend_data?on_conflict=code`;
  return retry(async () => {
    const res = await axios.post(url, record, {
      headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      httpsAgent,
      timeout: 30000
    });
    if (![200, 201, 202, 204].includes(res.status)) throw new Error(`Supabase returned HTTP ${res.status}`);
    return true;
  }, `Upsert dividend ${record.code}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Only actual parsed years are sent, so absent values never erase older values during the merge-upsert.
function buildPayload(parsed) {
  const payload = {
    code: parsed.record.code,
    date: parsed.record.date,
    listing_year: parsed.record.listing_year,
    share_category: parsed.record.share_category,
    record_date: parsed.record.record_date,
    source_url: parsed.record.source_url,
    updated_at: parsed.record.updated_at
  };
  for (const [year, value] of Object.entries(parsed.cash)) payload[`cash_dividend_${year}`] = value;
  for (const [year, value] of Object.entries(parsed.stock)) payload[`stock_dividend_${year}`] = value;
  return payload;
}

// Dependency-injected so the worker pool can be tested without network access.
async function processTickers(tickers, deps = {}) {
  const fetchPage = deps.fetchPage || fetchCompanyPage;
  const parsePage = deps.parsePage || parseCompanyPage;
  const save = deps.save || upsertDividend;
  const concurrency = deps.concurrency || CONCURRENCY;
  const delayMs = deps.delayMs === undefined ? DELAY_MS : deps.delayMs;
  const log = deps.log || console;

  const stats = { saved: 0, empty: 0, failed: 0, failures: [] };
  let next = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tickers.length) return;
      const ticker = tickers[i];
      try {
        const html = await fetchPage(ticker);
        const parsed = parsePage(html, ticker);
        if (parsed.pageTextLength < 500 || (!parsed.cashCount && !parsed.stockCount)) {
          stats.empty++;
          log.warn(`⚠️ ${ticker}: page loaded but no historical dividend entries parsed; skipping to avoid overwriting existing data.`);
        } else {
          await save(buildPayload(parsed));
          stats.saved++;
          log.log(`✅ ${ticker}: cash=${parsed.cashCount}, stock=${parsed.stockCount}`);
        }
      } catch (e) {
        stats.failed++;
        const message = e.response?.data?.message || e.message;
        stats.failures.push(`${ticker}: ${message}`);
        log.error(`❌ ${ticker}: ${message}`);
      }
      done++;
      if (done % 50 === 0) log.log(`⏱️ Progress: ${done}/${tickers.length}`);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tickers.length) }, worker));
  return stats;
}

async function run() {
  const started = Date.now();
  console.log('📚 StockPulse DSE dividend-history scraper');
  console.log(`🌐 Source: ${DSE_COMPANY_URL}<TICKER>`);
  const tickers = process.env.DIVIDEND_TICKERS
    ? process.env.DIVIDEND_TICKERS.split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
    : await fetchTickers();
  console.log(`🔎 Tickers queued: ${tickers.length} (parallel workers: ${CONCURRENCY}, delay per worker: ${DELAY_MS} ms)`);

  const { saved, empty, failed, failures } = await processTickers(tickers);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n📊 Result: saved=${saved}, no-data=${empty}, failed=${failed}, total=${tickers.length} in ${seconds}s`);
  if (failures.length) console.log(failures.slice(0, 30).join('\n') + (failures.length > 30 ? `\n... and ${failures.length - 30} more` : ''));
  if (tickers.length && (saved === 0 || failed > tickers.length * 0.25)) process.exitCode = 1;
}

if (require.main === module) run().catch(err => {
  console.error('❌ Dividend scraper failed:', err.response?.data || err.message || err);
  process.exit(1);
});
module.exports = { parseDividendEntries, parseCompanyPage, buildPayload, processTickers, run };
