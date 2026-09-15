const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// ============================================================
// StockPulse - DSE Market Summary Scraper
// Standalone scraper. Does NOT modify or depend on old scrapers.
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DSE_URL = 'https://dsebd.org/index.php';
const TABLE_NAME = 'market_summary';

if (!SUPABASE_URL) {
  throw new Error('SUPABASE_URL environment variable is missing');
}

if (!SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_SERVICE_KEY environment variable is missing');
}

// DSE has historically presented certificate-chain problems.
// Keep this isolated to the DSE request only, just like the existing scraper.
const dseHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

const supabaseHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

const dseHeaders = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'keep-alive',
};

function cleanText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLabel(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[:：]/g, '')
    .trim();
}

function parseNumber(value) {
  const text = cleanText(value).replace(/,/g, '');
  const match = text.match(/[-+]?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parsePercent(value) {
  const text = cleanText(value).replace(/,/g, '');
  const match = text.match(/[-+]?\d+(?:\.\d+)?\s*%?/);
  return match ? Number(match[0].replace('%', '').trim()) : null;
}

function getRows($) {
  const rows = [];

  $('table tr').each((rowIndex, tr) => {
    const cells = [];

    $(tr)
      .find('th, td')
      .each((cellIndex, cell) => {
        const text = cleanText($(cell).text());
        if (text) cells.push(text);
      });

    if (cells.length) {
      rows.push({ rowIndex, cells });
    }
  });

  return rows;
}

function findDsex(rows) {
  for (const row of rows) {
    const index = row.cells.findIndex(
      (cell) => normalizeLabel(cell) === 'dsex index'
    );

    if (index === -1) continue;

    const afterLabel = row.cells.slice(index + 1);
    const numericCells = afterLabel
      .map((cell) => ({ raw: cell, value: parseNumber(cell) }))
      .filter((item) => item.value !== null);

    if (numericCells.length >= 3) {
      return {
        dsex: numericCells[0].value,
        change: numericCells[1].value,
        change_percent: parsePercent(numericCells[2].raw),
      };
    }
  }

  return null;
}

function findValuesBelowHeaders(rows, headerLabels) {
  const normalizedHeaders = headerLabels.map(normalizeLabel);

  for (let i = 0; i < rows.length - 1; i++) {
    const headerRow = rows[i];
    const normalizedCells = headerRow.cells.map(normalizeLabel);

    const foundAll = normalizedHeaders.every((header) =>
      normalizedCells.includes(header)
    );

    if (!foundAll) continue;

    const valueRow = rows[i + 1];
    const values = valueRow.cells
      .map((cell) => parseNumber(cell))
      .filter((value) => value !== null);

    if (values.length >= headerLabels.length) {
      return values.slice(0, headerLabels.length);
    }
  }

  return null;
}

function findSingleValueNearLabel(rows, label) {
  const target = normalizeLabel(label);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const index = row.cells.findIndex(
      (cell) => normalizeLabel(cell) === target
    );

    if (index === -1) continue;

    // Value on the same row after the label.
    for (const cell of row.cells.slice(index + 1)) {
      const value = parseNumber(cell);
      if (value !== null) return value;
    }

    // Or value in the next row.
    if (rows[i + 1]) {
      for (const cell of rows[i + 1].cells) {
        const value = parseNumber(cell);
        if (value !== null) return value;
      }
    }
  }

  return null;
}

function getDhakaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getMarketCondition(change) {
  if (change > 0) return 'BULLISH';
  if (change < 0) return 'BEARISH';
  return 'FLAT';
}

function extractMarketSummary(html) {
  const $ = cheerio.load(html);
  const rows = getRows($);

  const dsex = findDsex(rows);
  if (!dsex) {
    throw new Error('DSEX Index row could not be found on DSE index.php');
  }

  const totals = findValuesBelowHeaders(rows, [
    'Total Trade',
    'Total Volume',
    'Total Value in Taka (mn)',
  ]);

  if (!totals) {
    throw new Error('Market totals row could not be found on DSE index.php');
  }

  const breadth = findValuesBelowHeaders(rows, [
    'Issues Advanced',
    'Issues declined',
    'Issues Unchanged',
  ]);

  if (!breadth) {
    throw new Error('Market breadth row could not be found on DSE index.php');
  }

  const previousClose =
    dsex.change !== null ? Number((dsex.dsex - dsex.change).toFixed(5)) : null;

  return {
    market_date: getDhakaDate(),
    dsex: dsex.dsex,
    previous_close: previousClose,
    change: dsex.change,
    change_percent: dsex.change_percent,
    total_trades: Math.round(totals[0]),
    total_volume: Math.round(totals[1]),
    total_value: totals[2],
    advanced: Math.round(breadth[0]),
    declined: Math.round(breadth[1]),
    unchanged: Math.round(breadth[2]),
    market_status: getMarketCondition(dsex.change),
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
    validateStatus: (status) => status >= 200 && status < 400,
  });

  if (!response.data || typeof response.data !== 'string') {
    throw new Error('DSE returned an empty or invalid HTML response');
  }

  console.log(`✅ DSE page received (${response.data.length} bytes)`);
  return extractMarketSummary(response.data);
}

async function saveToSupabase(data) {
  const baseUrl = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${TABLE_NAME}`;
  const dateFilter = encodeURIComponent(data.market_date);

  console.log(`💾 Saving market summary for ${data.market_date}...`);

  // Update today's row if it already exists. Otherwise insert a new row.
  // This avoids requiring a UNIQUE constraint on market_date.
  const existingResponse = await axios.get(
    `${baseUrl}?market_date=eq.${dateFilter}&select=id`,
    {
      headers: supabaseHeaders,
      timeout: 15000,
    }
  );

  if (existingResponse.data && existingResponse.data.length > 0) {
    await axios.patch(
      `${baseUrl}?market_date=eq.${dateFilter}`,
      data,
      {
        headers: {
          ...supabaseHeaders,
          Prefer: 'return=minimal',
        },
        timeout: 15000,
      }
    );

    console.log('✅ Existing market summary updated');
  } else {
    await axios.post(baseUrl, data, {
      headers: {
        ...supabaseHeaders,
        Prefer: 'return=minimal',
      },
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

  const marketSummary = await scrapeDse();

  console.log('');
  console.log('📊 MARKET SUMMARY');
  console.log(`DSEX          : ${marketSummary.dsex}`);
  console.log(`Change        : ${marketSummary.change}`);
  console.log(`Change %      : ${marketSummary.change_percent}%`);
  console.log(`Prev Close    : ${marketSummary.previous_close}`);
  console.log(`Total Trade   : ${marketSummary.total_trades}`);
  console.log(`Total Volume  : ${marketSummary.total_volume}`);
  console.log(`Total Value   : ${marketSummary.total_value} mn`);
  console.log(`Advanced      : ${marketSummary.advanced}`);
  console.log(`Declined      : ${marketSummary.declined}`);
  console.log(`Unchanged     : ${marketSummary.unchanged}`);
  console.log(`Condition     : ${marketSummary.market_status}`);
  console.log(`Market Date   : ${marketSummary.market_date}`);

  await saveToSupabase(marketSummary);

  console.log('');
  console.log('🎉 MARKET SUMMARY SCRAPER COMPLETED');
}

main().catch((error) => {
  console.error('');
  console.error('❌ MARKET SUMMARY SCRAPER FAILED');
  console.error(error.response?.data || error.message || error);
  process.exit(1);
});
