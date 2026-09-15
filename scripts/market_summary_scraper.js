const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// ============================================================
// StockPulse - DSE Market Summary Scraper
// Standalone scraper. Old scrapers are NOT modified.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DSE_URL = 'https://dsebd.org/index.php';
const TABLE_NAME = 'market_summary';

if (!SUPABASE_URL) throw new Error('SUPABASE_URL environment variable is missing');
if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY environment variable is missing');

const dseHttpsAgent = new https.Agent({ rejectUnauthorized: false });

const dseHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const supabaseHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalize(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[：:]/g, '')
    .trim();
}

function numberFrom(value) {
  const m = cleanText(value).replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function numbersFrom(text) {
  return cleanText(text)
    .replace(/,/g, '')
    .match(/[-+]?\d+(?:\.\d+)?/g)?.map(Number) || [];
}

function getDhakaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function condition(change) {
  if (change > 0) return 'BULLISH';
  if (change < 0) return 'BEARISH';
  return 'FLAT';
}

function getRows($) {
  const rows = [];
  $('table tr').each((i, tr) => {
    const cells = [];
    $(tr).find('th,td').each((_, cell) => {
      const text = cleanText($(cell).text());
      if (text) cells.push(text);
    });
    if (cells.length) rows.push(cells);
  });
  return rows;
}

function findDsex(rows) {
  for (const cells of rows) {
    const idx = cells.findIndex(c => normalize(c) === 'dsex index');
    if (idx < 0) continue;

    const after = cells.slice(idx + 1);
    const candidates = [];
    for (const cell of after) {
      const n = numberFrom(cell);
      if (n !== null) candidates.push({ n, raw: cell });
    }

    if (candidates.length >= 3) {
      return {
        dsex: candidates[0].n,
        change: candidates[1].n,
        change_percent: candidates[2].n,
      };
    }
  }
  return null;
}

// DSE's totals/breadth tables can have nested tables and extra text nodes.
// Instead of assuming one exact row layout, locate the header block and
// select a plausible numeric triplet by its market-data ranges.
function findTripletByHeader(pageText, headerPattern, validator) {
  const match = headerPattern.exec(pageText);
  if (!match) return null;

  const tail = pageText.slice(match.index + match[0].length, match.index + match[0].length + 500);
  const nums = numbersFrom(tail);

  for (let i = 0; i <= nums.length - 3; i++) {
    const triple = nums.slice(i, i + 3);
    if (validator(triple)) return triple;
  }
  return null;
}

function parseFromPageText(html) {
  const $ = cheerio.load(html);
  const pageText = cleanText($('body').text());

  // Example current DSE block:
  // DSEX Index 5472.46437 93.46158 1.73753%
  const dsexMatch = pageText.match(
    /DSEX\s+Index\s+([-+]?\d[\d,]*(?:\.\d+)?)\s+([-+]?\d[\d,]*(?:\.\d+)?)\s+([-+]?\d[\d,]*(?:\.\d+)?)\s*%/i
  );

  const dsex = dsexMatch ? {
    dsex: numberFrom(dsexMatch[1]),
    change: numberFrom(dsexMatch[2]),
    change_percent: numberFrom(dsexMatch[3]),
  } : null;

  // Expected ranges make this robust against the page's "Sep 15, 2026"
  // date appearing immediately before the market values in the DOM text.
  const totals = findTripletByHeader(
    pageText,
    /Total\s+Trade\s+Total\s+Volume\s+Total\s+Value\s+in\s+Taka\s*\(mn\)/i,
    ([trade, volume, value]) =>
      Number.isInteger(trade) && trade >= 100 && trade <= 10000000 &&
      Number.isInteger(volume) && volume >= trade && volume <= 10000000000 &&
      value > 0 && value < 1000000
  );

  const breadth = findTripletByHeader(
    pageText,
    /Issues\s+Advanced\s+Issues\s+declined\s+Issues\s+Unchanged/i,
    ([advanced, declined, unchanged]) =>
      Number.isInteger(advanced) && advanced >= 0 && advanced <= 2000 &&
      Number.isInteger(declined) && declined >= 0 && declined <= 2000 &&
      Number.isInteger(unchanged) && unchanged >= 0 && unchanged <= 2000
  );

  return { dsex, totals, breadth };
}

function extractMarketSummary(html) {
  const $ = cheerio.load(html);
  const rows = getRows($);

  let dsex = findDsex(rows);
  const fallback = parseFromPageText(html);

  if (!dsex) dsex = fallback.dsex;
  const totals = fallback.totals;
  const breadth = fallback.breadth;

  if (!dsex) throw new Error('DSEX Index data could not be found on DSE index.php');
  if (!totals) throw new Error('Market totals data could not be found on DSE index.php');
  if (!breadth) throw new Error('Market breadth data could not be found on DSE index.php');

  const previousClose = Number((dsex.dsex - dsex.change).toFixed(5));

  return {
    market_date: getDhakaDate(),
    dsex: dsex.dsex,
    previous_close: previousClose,
    change: dsex.change,
    change_percent: dsex.change_percent,
    total_trades: totals[0],
    total_volume: totals[1],
    total_value: totals[2],
    advanced: breadth[0],
    declined: breadth[1],
    unchanged: breadth[2],
    market_status: condition(dsex.change),
    scraped_at: new Date().toISOString(),
  };
}

async function scrapeDse() {
  console.log(`📡 Scraping: ${DSE_URL}`);

  const response = await axios.get(DSE_URL, {
    httpsAgent: dseHttpsAgent,
    headers: dseHeaders,
    timeout: 20000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: status => status >= 200 && status < 400,
  });

  if (typeof response.data !== 'string' || !response.data.length) {
    throw new Error('DSE returned an empty HTML response');
  }

  console.log(`✅ DSE page received (${response.data.length} bytes)`);
  return extractMarketSummary(response.data);
}

async function saveToSupabase(data) {
  const base = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${TABLE_NAME}`;
  const date = encodeURIComponent(data.market_date);

  console.log(`💾 Saving market summary for ${data.market_date}...`);
  console.log(`🔗 Supabase host: ${new URL(SUPABASE_URL).host}`);

  const existing = await axios.get(`${base}?market_date=eq.${date}&select=id`, {
    headers: supabaseHeaders,
    timeout: 15000,
  });

  if (existing.data?.length) {
    await axios.patch(`${base}?market_date=eq.${date}`, data, {
      headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
      timeout: 15000,
    });
    console.log('✅ Existing market summary updated');
  } else {
    await axios.post(base, data, {
      headers: { ...supabaseHeaders, Prefer: 'return=minimal' },
      timeout: 15000,
    });
    console.log('✅ New market summary inserted');
  }
}

async function main() {
  console.log('======================================');
  console.log('📈 DSE MARKET SUMMARY SCRAPER');
  console.log('======================================');
  console.log(`🕐 ${new Date().toISOString()}`);

  const data = await scrapeDse();

  console.log('');
  console.log('📊 MARKET SUMMARY');
  console.log(`DSEX          : ${data.dsex}`);
  console.log(`Change        : ${data.change}`);
  console.log(`Change %      : ${data.change_percent}%`);
  console.log(`Prev Close    : ${data.previous_close}`);
  console.log(`Total Trade   : ${data.total_trades}`);
  console.log(`Total Volume  : ${data.total_volume}`);
  console.log(`Total Value   : ${data.total_value} mn`);
  console.log(`Advanced      : ${data.advanced}`);
  console.log(`Declined      : ${data.declined}`);
  console.log(`Unchanged     : ${data.unchanged}`);
  console.log(`Condition     : ${data.market_status}`);
  console.log(`Market Date   : ${data.market_date}`);

  await saveToSupabase(data);

  console.log('');
  console.log('🎉 MARKET SUMMARY SCRAPER COMPLETED');
}

main().catch(error => {
  console.error('❌ MARKET SUMMARY SCRAPER FAILED');
  console.error(error.response?.data || error.message || error);
  process.exit(1);
});
