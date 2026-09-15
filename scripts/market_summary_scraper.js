// scripts/market_summary_scraper.js
// StockPulse - DSE Market Summary scraper
//
// Collects the public DSE market snapshot and stores the latest snapshots
// in Supabase. The StockPulse frontend can read the table through the
// normal Supabase REST API; no separate public scraper API is required.

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
  process.exit(1);
}

// Kept consistent with the existing scraper project.
const agent = new https.Agent({ rejectUnauthorized: false });

const DSE_URL = 'https://www.dsebd.org/';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const s = cleanText(value).replace(/,/g, '').replace(/৳/g, '');
  const match = s.match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeKey(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[:\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find a numeric value in a row containing a known label.
 * This is intentionally tolerant because DSE page markup can change.
 */
function findRowValue($, labels) {
  let result = null;

  $('tr').each((_, tr) => {
    if (result !== null) return;

    const cells = $(tr).find('th,td').map((i, el) => cleanText($(el).text())).get();
    if (!cells.length) return;

    const rowText = normalizeKey(cells.join(' '));

    for (const label of labels) {
      if (rowText.includes(normalizeKey(label))) {
        // Prefer a cell that is not the label itself.
        for (let i = cells.length - 1; i >= 0; i--) {
          const n = parseNumber(cells[i]);
          if (n !== null && !normalizeKey(cells[i]).includes(normalizeKey(label))) {
            result = n;
            return;
          }
        }
      }
    }
  });

  return result;
}

/**
 * Search the complete page text for a label followed reasonably closely
 * by a number. Used as a fallback if the table structure changes.
 */
function findTextValue(pageText, labels) {
  const text = cleanText(pageText);

  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `${escaped}\\s*[:\\-]?\\s*([+-]?\\d[\\d,]*(?:\\.\\d+)?)`,
      'i'
    );
    const match = text.match(re);
    if (match) return parseNumber(match[1]);
  }

  return null;
}

function firstNonNull(...values) {
  return values.find(v => v !== null && v !== undefined);
}

async function fetchDsePage() {
  console.log(`📡 স্ক্র্যাপিং: ${DSE_URL}`);

  const response = await axios.get(DSE_URL, {
    httpsAgent: agent,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    timeout: 25000
  });

  return response.data;
}

function extractSummary(html) {
  const $ = cheerio.load(html);
  const pageText = cleanText($('body').text());

  // DSE labels vary slightly across page versions, so multiple aliases are used.
  const dsex = firstNonNull(
    findRowValue($, ['DSEX Index', 'DSEX']),
    findTextValue(pageText, ['DSEX Index', 'DSEX'])
  );

  const previousClose = firstNonNull(
    findRowValue($, ['Previous Close', 'Prev. Close', 'Previous']),
    findTextValue(pageText, ['Previous Close', 'Prev. Close'])
  );

  const totalTrades = firstNonNull(
    findRowValue($, ['Total Trade', 'Total Trades', 'Trade']),
    findTextValue(pageText, ['Total Trade', 'Total Trades'])
  );

  const totalVolume = firstNonNull(
    findRowValue($, ['Total Volume', 'Volume']),
    findTextValue(pageText, ['Total Volume'])
  );

  const totalValue = firstNonNull(
    findRowValue($, ['Total Value', 'Total Value in Taka', 'Turnover', 'Value']),
    findTextValue(pageText, ['Total Value', 'Total Value in Taka', 'Turnover'])
  );

  const advanced = firstNonNull(
    findRowValue($, ['Advanced', 'Advances', 'Advanced Issues']),
    findTextValue(pageText, ['Advanced', 'Advances'])
  );

  const declined = firstNonNull(
    findRowValue($, ['Declined', 'Declines', 'Declined Issues']),
    findTextValue(pageText, ['Declined', 'Declines'])
  );

  const unchanged = firstNonNull(
    findRowValue($, ['Unchanged', 'Unchanged Issues']),
    findTextValue(pageText, ['Unchanged'])
  );

  // Prefer DSE's displayed change when present.
  let change = firstNonNull(
    findRowValue($, ['Change']),
    findTextValue(pageText, ['Change'])
  );

  let changePercent = firstNonNull(
    findRowValue($, ['Change %', 'Change (%)', 'Percent Change']),
    findTextValue(pageText, ['Change %', 'Change (%)', 'Percent Change'])
  );

  // If change is not exposed separately, calculate it from current/previous.
  if ((change === null || change === undefined) && dsex !== null && previousClose) {
    change = dsex - previousClose;
  }

  if (
    (changePercent === null || changePercent === undefined) &&
    dsex !== null &&
    previousClose
  ) {
    changePercent = ((dsex - previousClose) / previousClose) * 100;
  }

  const now = new Date();

  // Do not silently save an all-zero/all-null record.
  const essentialFound = [dsex, totalTrades, totalVolume, totalValue, advanced, declined, unchanged]
    .some(v => v !== null && v !== undefined);

  if (!essentialFound) {
    throw new Error(
      'DSE market summary fields পাওয়া যায়নি। DSE page markup পরিবর্তিত হতে পারে।'
    );
  }

  return {
    market_date: now.toISOString().slice(0, 10),
    dsex,
    previous_close: previousClose,
    change,
    change_percent: changePercent,
    total_trades: totalTrades,
    total_volume: totalVolume,
    total_value: totalValue,
    advanced,
    declined,
    unchanged,
    market_status: 'UNKNOWN',
    scraped_at: now.toISOString()
  };
}

async function insertSummary(record) {
  const url = `${SUPABASE_URL}/rest/v1/market_summary`;
  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal'
  };

  const response = await axios.post(url, record, {
    headers,
    httpsAgent: agent,
    timeout: 15000
  });

  if (![200, 201, 202, 204].includes(response.status)) {
    throw new Error(`Supabase status: ${response.status}`);
  }
}

async function startScraper() {
  console.log(`🕐 ${new Date().toISOString()} - Market Summary scrape শুরু...`);

  const html = await fetchDsePage();
  const summary = extractSummary(html);

  console.log('📊 Market Summary:', JSON.stringify(summary, null, 2));

  await insertSummary(summary);

  console.log('✅ Market Summary Supabase-এ সেভ হয়েছে।');
}

if (require.main === module) {
  startScraper().catch(err => {
    console.error('❌ Market Summary scraper ব্যর্থ:', err.message);
    if (err.response) {
      console.error('📄 HTTP status:', err.response.status);
      console.error('📄 Response:', err.response.data);
    }
    process.exit(1);
  });
}

module.exports = { startScraper, extractSummary };
