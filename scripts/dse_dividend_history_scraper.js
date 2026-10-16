// scripts/dse_dividend_history_scraper.js
// Scrapes historical cash/stock dividend percentages from DSE legacy company pages
// and upserts one row per ticker into Supabase public.dse_dividend_data.
const cheerio = require('cheerio');
const {
  axios, httpsAgent, SUPABASE_URL, SUPABASE_SERVICE_KEY,
  cleanText, numberFrom, supabaseHeaders, retry, renderPage
} = require('./lib/common');

const DSE_COMPANY_URL = 'https://old.dsebd.org/displayCompany.php?name=';
const YEARS = Array.from({ length: 2035 - 1990 + 1 }, (_, i) => 1990 + i);
const DELAY_MS = Number(process.env.DIVIDEND_SCRAPE_DELAY_MS || 350);

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
  return { record, cashCount: Object.keys(cash).length, stockCount: Object.keys(stock).length, pageTextLength: text.length };
}

async function fetchCompanyPage(ticker) {
  const url = DSE_COMPANY_URL + encodeURIComponent(ticker);
  try {
    const response = await axios.get(url, {
      httpsAgent,
      timeout: 25000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (response.status === 200 && String(response.data).length > 1000) return String(response.data);
    throw new Error(`Unexpected DSE response: HTTP ${response.status}`);
  } catch (e) {
    // Chromium fallback is useful if the legacy site blocks basic HTTP clients.
    console.warn(`⚠️ Direct fetch failed for ${ticker}: ${e.message}; trying Chromium`);
    return renderPage(url, 10000);
  }
}

async function fetchTickers() {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/dse_live_data?select=ticker&order=ticker.asc&limit=1000`;
  const { data } = await retry(async () => axios.get(url, {
    headers: supabaseHeaders(),
    httpsAgent,
    timeout: 30000
  }), 'Fetch DSE ticker list');
  const tickers = [...new Set((data || []).map(x => cleanText(x.ticker).toUpperCase()).filter(Boolean))];
  if (!tickers.length) throw new Error('No tickers found in Supabase dse_live_data. Check table data and API permissions.');
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

async function run() {
  console.log('📚 StockPulse DSE dividend-history scraper');
  console.log(`🌐 Source: ${DSE_COMPANY_URL}<TICKER>`);
  const tickers = process.env.DIVIDEND_TICKERS
    ? process.env.DIVIDEND_TICKERS.split(',').map(x => x.trim().toUpperCase()).filter(Boolean)
    : await fetchTickers();
  console.log(`🔎 Tickers queued: ${tickers.length}`);
  let saved = 0, empty = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    try {
      const html = await fetchCompanyPage(ticker);
      const parsed = parseCompanyPage(html, ticker);
      if (parsed.pageTextLength < 500 || (!parsed.cashCount && !parsed.stockCount)) {
        empty++;
        console.warn(`⚠️ ${ticker}: page loaded but no historical dividend entries parsed; skipping to avoid overwriting existing data.`);
      } else {
        // Only send actual parsed years so absent values don't erase older values during merge-upsert.
        const payload = {
          code: parsed.record.code,
          date: parsed.record.date,
          listing_year: parsed.record.listing_year,
          share_category: parsed.record.share_category,
          record_date: parsed.record.record_date,
          source_url: parsed.record.source_url,
          updated_at: parsed.record.updated_at
        };
        const $ = cheerio.load(html);
        const cashText = getRowValue($, 'Cash Dividend');
        const stockText = getRowValue($, 'Bonus Issue') || getRowValue($, 'Stock Dividend');
        const cash = parseDividendEntries(cashText);
        const stock = parseDividendEntries(stockText);
        if (!Object.keys(cash).length || !Object.keys(stock).length) {
          const text = cleanText($('body').text());
          const lines = text.split(/(?=Cash Dividend|Bonus Issue|Stock Dividend)/i);
          for (const line of lines) {
            if (!Object.keys(cash).length && /Cash Dividend/i.test(line)) Object.assign(cash, parseDividendEntries(line.slice(0, 700)));
            if (!Object.keys(stock).length && /(Bonus Issue|Stock Dividend)/i.test(line)) Object.assign(stock, parseDividendEntries(line.slice(0, 700)));
          }
        }
        for (const [year, value] of Object.entries(cash)) payload[`cash_dividend_${year}`] = value;
        for (const [year, value] of Object.entries(stock)) payload[`stock_dividend_${year}`] = value;
        await upsertDividend(payload);
        saved++;
        console.log(`✅ ${ticker}: cash=${Object.keys(cash).length}, stock=${Object.keys(stock).length}`);
      }
    } catch (e) {
      failed++;
      failures.push(`${ticker}: ${e.response?.data?.message || e.message}`);
      console.error(`❌ ${ticker}: ${e.response?.data?.message || e.message}`);
    }
    if (i < tickers.length - 1) await sleep(DELAY_MS);
  }
  console.log(`\n📊 Result: saved=${saved}, no-data=${empty}, failed=${failed}, total=${tickers.length}`);
  if (failures.length) console.log(failures.join('\n'));
  if (failed && saved === 0) process.exitCode = 1;
}

if (require.main === module) run().catch(err => {
  console.error('❌ Dividend scraper failed:', err.response?.data || err.message || err);
  process.exit(1);
});
module.exports = { parseDividendEntries, parseCompanyPage, run };
