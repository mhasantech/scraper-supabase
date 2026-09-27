const axios = require('axios');
const https = require('https');

// ============================================================
// StockPulse - DSE Market Summary Scraper
// Updated for the redesigned DSE site (JSON API)
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TABLE_NAME = 'market_summary';

const DSE_BASE_URLS = [
  'https://dsebd.org',
  'https://dse.com.bd',
];

const DSE_API = {
  market: '/api/live/market',
  prices: '/api/live/prices',
  recentMarketInfo: '/api/live/recent-market-info',
};

if (!SUPABASE_URL) throw new Error('SUPABASE_URL environment variable is missing');
if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY environment variable is missing');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const dseHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://dsebd.org/',
};

const supabaseHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function cleanText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function numberFrom(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const s = cleanText(value).replace(/,/g, '');
  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function getDhakaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const p = Object.fromEntries(
    parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value])
  );

  return `${p.year}-${p.month}-${p.day}`;
}

function condition(change) {
  if (change > 0) return 'BULLISH';
  if (change < 0) return 'BEARISH';
  return 'FLAT';
}

function keyNorm(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function allObjects(value, out = []) {
  if (!value || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    for (const item of value) allObjects(item, out);
    return out;
  }

  out.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') allObjects(child, out);
  }
  return out;
}

function findKeyValue(obj, aliases) {
  const wanted = new Set(aliases.map(keyNorm));

  for (const [key, value] of Object.entries(obj || {})) {
    if (wanted.has(keyNorm(key))) {
      const n = numberFrom(value);
      if (n !== null) return n;
    }
  }

  return null;
}

function findTextKey(obj, aliases) {
  const wanted = new Set(aliases.map(keyNorm));

  for (const [key, value] of Object.entries(obj || {})) {
    if (wanted.has(keyNorm(key)) && value !== null && value !== undefined) {
      return cleanText(value);
    }
  }

  return null;
}

function findDsex(root) {
  const objects = allObjects(root);

  // Preferred: an object whose name/label/index identifies DSEX.
  for (const obj of objects) {
    const identity =
      findTextKey(obj, ['name', 'label', 'index', 'indexName', 'index_name', 'symbol', 'code']);

    if (!identity || !/dsex/i.test(identity)) continue;

    const dsex =
      findKeyValue(obj, ['value', 'current', 'currentValue', 'indexValue', 'index_value', 'close', 'ltp']);
    const change =
      findKeyValue(obj, ['change', 'netChange', 'net_change', 'changeValue', 'change_value']);
    const changePercent =
      findKeyValue(obj, ['changePercent', 'change_percentage', 'changePct', 'percentChange', 'percentageChange']);

    if (dsex !== null) {
      return {
        dsex,
        change: change ?? 0,
        change_percent: changePercent,
      };
    }
  }

  // Fallback: look for a DSEX key directly.
  for (const obj of objects) {
    for (const [key, value] of Object.entries(obj)) {
      if (/dsex/i.test(key) && value && typeof value === 'object') {
        const dsex =
          findKeyValue(value, ['value', 'current', 'currentValue', 'indexValue', 'close', 'ltp']);
        const change =
          findKeyValue(value, ['change', 'netChange', 'changeValue']);
        const changePercent =
          findKeyValue(value, ['changePercent', 'changePct', 'percentChange']);

        if (dsex !== null) {
          return { dsex, change: change ?? 0, change_percent: changePercent };
        }
      }
    }
  }

  return null;
}

function findMarketTotals(root) {
  const objects = allObjects(root);

  const candidates = [
    ['totalTrades', 'totalTrade', 'trades', 'total_trade'],
    ['totalVolume', 'volume', 'total_volume'],
    ['totalValue', 'totalValueInTaka', 'turnover', 'value', 'total_value'],
  ];

  // Prefer an object that contains at least two of the three market-total concepts.
  for (const obj of objects) {
    const trade = findKeyValue(obj, candidates[0]);
    const volume = findKeyValue(obj, candidates[1]);
    const value = findKeyValue(obj, candidates[2]);

    if (trade !== null && volume !== null && value !== null) {
      return [trade, volume, value];
    }
  }

  return null;
}

function findBreadth(root) {
  const objects = allObjects(root);

  for (const obj of objects) {
    const advanced = findKeyValue(obj, [
      'advanced', 'advances', 'issuesAdvanced', 'issues_advanced', 'gainers'
    ]);
    const declined = findKeyValue(obj, [
      'declined', 'declines', 'issuesDeclined', 'issues_declined', 'losers'
    ]);
    const unchanged = findKeyValue(obj, [
      'unchanged', 'issuesUnchanged', 'issues_unchanged', 'noChange', 'nochange'
    ]);

    if (advanced !== null && declined !== null && unchanged !== null) {
      return [advanced, declined, unchanged];
    }
  }

  return null;
}

function findPriceRows(root) {
  const arrays = [];

  function walk(value) {
    if (!value || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      if (value.length && value.some(x => x && typeof x === 'object')) {
        arrays.push(value);
      }
      for (const item of value) walk(item);
      return;
    }

    for (const child of Object.values(value)) walk(child);
  }

  walk(root);

  // Choose the largest array containing recognizable price/trade fields.
  let best = [];
  for (const arr of arrays) {
    const score = arr.reduce((s, row) => {
      if (!row || typeof row !== 'object') return s;
      const keys = Object.keys(row).map(keyNorm);
      const hasSymbol = keys.some(k => ['symbol', 'code', 'tradingsymbol'].includes(k));
      const hasPrice = keys.some(k => ['ltp', 'close', 'ycp', 'price'].includes(k));
      const hasVolume = keys.some(k => ['volume', 'vol'].includes(k));
      return s + (hasSymbol ? 2 : 0) + (hasPrice ? 2 : 0) + (hasVolume ? 1 : 0);
    }, 0);

    if (score > best.score) best = { score, rows: arr };
  }

  return best.rows || [];
}

function calculateFromPrices(root) {
  const rows = findPriceRows(root);
  if (!rows.length) return null;

  let totalTrades = 0;
  let totalVolume = 0;
  let totalValue = 0;
  let advanced = 0;
  let declined = 0;
  let unchanged = 0;
  let valid = 0;

  for (const row of rows) {
    const trade = findKeyValue(row, ['trade', 'trades', 'numberOfTrades', 'noOfTrade']);
    const volume = findKeyValue(row, ['volume', 'vol']);
    const value = findKeyValue(row, ['value', 'tradeValue', 'turnover']);
    const change = findKeyValue(row, ['change', 'netChange']);

    const ltp = findKeyValue(row, ['ltp', 'lastPrice', 'currentPrice', 'price', 'close']);
    const ycp = findKeyValue(row, ['ycp', 'previousClose', 'prevClose']);

    if (trade !== null) totalTrades += trade;
    if (volume !== null) totalVolume += volume;
    if (value !== null) totalValue += value;

    let direction = change;
    if (direction === null && ltp !== null && ycp !== null) {
      direction = ltp - ycp;
    }

    if (direction !== null) {
      valid++;
      if (direction > 0) advanced++;
      else if (direction < 0) declined++;
      else unchanged++;
    }
  }

  if (!valid && !totalTrades && !totalVolume && !totalValue) return null;

  return {
    totals: [totalTrades, totalVolume, totalValue],
    breadth: valid ? [advanced, declined, unchanged] : null,
  };
}

async function getJson(url) {
  const response = await axios.get(url, {
    httpsAgent,
    headers: dseHeaders,
    timeout: 20000,
    maxRedirects: 5,
    responseType: 'json',
    validateStatus: status => status >= 200 && status < 400,
  });

  if (!response.data || typeof response.data !== 'object') {
    throw new Error(`DSE API returned non-JSON data from ${url}`);
  }

  return response.data;
}

async function getDseData() {
  const errors = [];

  for (const base of DSE_BASE_URLS) {
    for (const [name, path] of Object.entries(DSE_API)) {
      try {
        console.log(`📡 DSE API: ${base}${path}`);
        const data = await getJson(`${base}${path}`);
        console.log(`✅ ${name} API received`);

        if (name === 'market') {
          return { market: data, prices: null, source: `${base}${path}` };
        }

        if (name === 'prices') {
          return { market: null, prices: data, source: `${base}${path}` };
        }
      } catch (error) {
        errors.push(`${base}${path}: ${error.response?.status || error.message}`);
      }
    }
  }

  throw new Error(`All DSE API endpoints failed:\n${errors.join('\n')}`);
}

async function scrapeDse() {
  const errors = [];
  let market = null;
  let prices = null;
  let recent = null;

  for (const base of DSE_BASE_URLS) {
    for (const [name, path] of Object.entries(DSE_API)) {
      try {
        console.log(`📡 Scraping DSE JSON: ${base}${path}`);
        const data = await getJson(`${base}${path}`);

        if (name === 'market') market = data;
        if (name === 'prices') prices = data;
        if (name === 'recentMarketInfo') recent = data;
      } catch (error) {
        errors.push(`${base}${path}: ${error.response?.status || error.message}`);
      }
    }

    if (market || prices || recent) break;
  }

  if (!market && !prices && !recent) {
    throw new Error(`DSE JSON API unavailable:\n${errors.join('\n')}`);
  }

  const combined = { market, prices, recent };

  const dsex = findDsex(combined);
  let totals = findMarketTotals(combined);
  let breadth = findBreadth(combined);

  // If the market endpoint doesn't expose aggregate totals, calculate them
  // from the live price rows.
  if (!totals || !breadth) {
    const calculated = calculateFromPrices(prices || combined);
    if (calculated) {
      if (!totals) totals = calculated.totals;
      if (!breadth) breadth = calculated.breadth;
    }
  }

  if (!dsex) {
    throw new Error(
      'DSEX data not found in DSE JSON API. The API response format may have changed again.'
    );
  }

  if (!totals) {
    throw new Error(
      'Market totals not found in DSE JSON API. Total trades/volume/value fields may have changed.'
    );
  }

  if (!breadth) {
    throw new Error(
      'Market breadth not found in DSE JSON API. Advanced/declined/unchanged fields may have changed.'
    );
  }

  const previousClose = Number((dsex.dsex - (dsex.change || 0)).toFixed(5));

  return {
    market_date: getDhakaDate(),
    dsex: dsex.dsex,
    previous_close: previousClose,
    change: dsex.change || 0,
    change_percent:
      dsex.change_percent !== null
        ? dsex.change_percent
        : previousClose
          ? Number((((dsex.dsex - previousClose) / previousClose) * 100).toFixed(5))
          : 0,
    total_trades: Math.round(totals[0]),
    total_volume: Math.round(totals[1]),
    total_value: totals[2],
    advanced: Math.round(breadth[0]),
    declined: Math.round(breadth[1]),
    unchanged: Math.round(breadth[2]),
    market_status: condition(dsex.change || 0),
    scraped_at: new Date().toISOString(),
  };
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
