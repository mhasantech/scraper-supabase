const axios = require('axios');
const https = require('https');
const { execFileSync } = require('child_process');

// ============================================================
// StockPulse - DSE Market Summary Scraper
// DSE NEW WEBSITE: https://dse.com.bd/markets
//
// IMPORTANT:
// The new DSE page is client-rendered. This scraper intentionally
// renders the real DSE /markets page with the Chromium browser
// available on GitHub Actions, then extracts the Market Summary.
// This avoids relying on undocumented/unstable JSON field names.
// ============================================================

const DSE_PAGE_URL = 'https://dse.com.bd/markets';
const TABLE_NAME = 'market_summary';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) throw new Error('SUPABASE_URL environment variable is missing');
if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY environment variable is missing');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const headers = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const supabaseHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

function cleanText(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function numberFrom(value) {
  const m = String(value ?? '').replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function condition(change) {
  if (change > 0) return 'BULLISH';
  if (change < 0) return 'BEARISH';
  return 'FLAT';
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  for (const binary of candidates) {
    try {
      execFileSync(binary, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10000,
      });
      return binary;
    } catch (_) {}
  }

  return null;
}

function renderWithChromium() {
  const browser = findBrowser();

  if (!browser) {
    throw new Error(
      'Chromium/Google Chrome was not found on the GitHub Actions runner.'
    );
  }

  console.log(`🌐 Rendering DSE page with: ${browser}`);

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,2200',
    '--virtual-time-budget=30000',
    '--run-all-compositor-stages-before-draw',
    '--dump-dom',
    DSE_PAGE_URL,
  ];

  const html = execFileSync(browser, args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (!html || html.length < 1000) {
    throw new Error('DSE page rendered an empty/too-small DOM response');
  }

  return html;
}

async function fallbackHttpFetch() {
  console.log('⚠️ Browser render unavailable; trying direct DSE HTML as fallback...');

  const response = await axios.get(DSE_PAGE_URL, {
    httpsAgent,
    headers,
    timeout: 30000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: status => status >= 200 && status < 400,
  });

  if (typeof response.data !== 'string' || response.data.length < 1000) {
    throw new Error('DSE returned an empty/invalid HTML response');
  }

  return response.data;
}

function marketSummaryText(html) {
  // Parse the complete rendered page text. The old implementation truncated
  // after a guessed section heading, which could cut off TURNOVER/VOLUME/TRADES.
  return cleanText(html);
}

function findCardContext(html, label) {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const match = re.exec(html);

  if (!match) return '';

  // The rendered card is normally close to the label in the DOM.
  return html.slice(Math.max(0, match.index - 1000), match.index + 7000);
}

function parseDsex(html, text) {
  // IMPORTANT: parse the visible Market Summary text first.
  // The rendered DSE page currently exposes the card as:
  // DSEX 5,532.75 ▼ 0.82%
  // Looking only at a raw HTML context can accidentally land on a
  // script/component occurrence of "DSEX" that does not contain the
  // visible percentage.
  const visible = String(text || '').match(
    /DSEX\s+([\d,]+(?:\.\d+)?)\s*(?:([▼▲])\s*)?([-+]?\d+(?:\.\d+)?)\s*%/i
  );

  if (visible) {
    const dsex = numberFrom(visible[1]);
    let changePercent = numberFrom(visible[3]);
    const arrow = visible[2] || '';

    if (arrow === '▼') changePercent = -Math.abs(changePercent);
    if (arrow === '▲') changePercent = Math.abs(changePercent);

    // DSE currently displays the percentage but not always the exact
    // absolute index change in the Market Summary card. Derive the
    // previous close and absolute change from the displayed percentage.
    // This is consistent with the rounded percentage shown by DSE.
    const previousClose = dsex / (1 + changePercent / 100);
    const change = dsex - previousClose;

    return {
      dsex,
      change: Number(change.toFixed(5)),
      change_percent: changePercent,
    };
  }

  // Fallback: inspect nearby rendered HTML in case DSE changes the text
  // extraction format while keeping the percentage in the DOM.
  const contextHtml = findCardContext(html, 'DSEX');
  const context = cleanText(contextHtml);

  const pctMatch = context.match(
    /DSEX\s+([\d,]+(?:\.\d+)?)\s*(?:([▼▲])\s*)?([-+]?\d+(?:\.\d+)?)\s*%/i
  );
  const valueMatch = context.match(/DSEX\s+([\d,]+(?:\.\d+)?)/i);

  if (!valueMatch) {
    throw new Error('DSEX value was not found on the rendered DSE /markets page');
  }

  const dsex = numberFrom(valueMatch[1]);

  if (!pctMatch) {
    throw new Error('DSEX percentage change was not found on the rendered DSE page');
  }

  let changePercent = numberFrom(pctMatch[3]);
  const arrow = pctMatch[2] || '';

  if (arrow === '▼') changePercent = -Math.abs(changePercent);
  if (arrow === '▲') changePercent = Math.abs(changePercent);

  const previousClose = dsex / (1 + changePercent / 100);
  const change = dsex - previousClose;

  return {
    dsex,
    change: Number(change.toFixed(5)),
    change_percent: changePercent,
  };
}

function parseSummary(text) {
  // DSE has changed the label/unit order more than once. Accept common variants,
  // but never invent a missing value: a missing critical field remains a clear error.
  const source = String(text || '').replace(/\s+/g, ' ');
  const find = (patterns, label) => {
    for (const re of patterns) {
      const m = source.match(re);
      if (m) {
        const n = numberFrom(m[1]);
        if (n !== null && Number.isFinite(n)) return n;
      }
    }
    throw new Error(`${label} was not found in rendered DSE /markets page. Extracted text sample: ${source.slice(0, 900)}`);
  };
  const total_value = find([
    /TURNOVER\s*(?:\(\s*BDT\s*(?:mn|million)?\s*\))?\s*(?:BDT\s*)?([\d,]+(?:\.\d+)?)\s*(?:mn|million)?/i,
    /(?:TOTAL\s*)?VALUE\s*(?:BDT\s*)?([\d,]+(?:\.\d+)?)\s*(?:mn|million)/i,
    /TURNOVER[^\d]{0,100}([\d,]+(?:\.\d+)?)/i,
  ], 'TURNOVER');
  const total_volume = find([
    /VOLUME\s*([\d,]+(?:\.\d+)?)\s*(?:shares?)?/i,
    /TOTAL\s*VOLUME[^\d]{0,80}([\d,]+(?:\.\d+)?)/i,
  ], 'VOLUME');
  const total_trades = find([
    /TRADES?\s*([\d,]+)\s*(?:executions?|transactions?)?/i,
    /TOTAL\s*TRANSACTIONS?[^\d]{0,80}([\d,]+)/i,
  ], 'TRADES');
  let advanced, declined, unchanged;
  const breadth = source.match(/BREADTH\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/i)
    || source.match(/ADVANC(?:ED|ERS?)\s*[:\-]?\s*(\d+)[\s\S]{0,120}?DECLIN(?:ED|ERS?)\s*[:\-]?\s*(\d+)[\s\S]{0,120}?UNCHANGED\s*[:\-]?\s*(\d+)/i)
    || source.match(/ADV\s*\/\s*DEC\s*\/\s*UNCH\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/i);
  if (breadth) [advanced, declined, unchanged] = breadth.slice(1,4).map(Number);
  else throw new Error(`BREADTH (advancers/decliners/unchanged) was not found in rendered DSE /markets page. Extracted text sample: ${source.slice(0, 900)}`);
  return { total_value, total_volume, total_trades, advanced, declined, unchanged };
}

async function scrapeDse() {
  let html;

  try {
    html = renderWithChromium();
  } catch (browserError) {
    console.log(`⚠️ Chromium render failed: ${browserError.message}`);
    html = await fallbackHttpFetch();
  }

  const text = marketSummaryText(html);

  console.log(`📄 Rendered DSE DOM: ${html.length} bytes`);
  console.log(`📊 Market Summary text: ${text.slice(0, 1200)}`);

  const dsex = parseDsex(html, text);
  const summary = parseSummary(text);

  const data = {
    market_date: getDhakaDate(),
    dsex: dsex.dsex,
    previous_close: Number((dsex.dsex - dsex.change).toFixed(5)),
    change: dsex.change,
    change_percent: dsex.change_percent,
    total_trades: summary.total_trades,
    total_volume: summary.total_volume,
    total_value: summary.total_value,
    advanced: summary.advanced,
    declined: summary.declined,
    unchanged: summary.unchanged,
    market_status: condition(dsex.change),
    scraped_at: new Date().toISOString(),
  };

  // Sanity checks prevent garbage data from being written to Supabase.
  if (!(data.dsex > 0)) throw new Error('Invalid DSEX value');
  if (!(data.total_trades >= 0)) throw new Error('Invalid total trades');
  if (!(data.total_volume >= 0)) throw new Error('Invalid total volume');
  if (!(data.total_value >= 0)) throw new Error('Invalid total value');
  if (data.advanced < 0 || data.declined < 0 || data.unchanged < 0) {
    throw new Error('Invalid market breadth values');
  }

  return data;
}

async function withRetry(label, fn, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); } catch (err) {
      last = err;
      const status = err.response?.status;
      const retryable = !status || status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || i === attempts) break;
      const wait = i * 1200;
      console.warn(`⚠️ ${label} attempt ${i}/${attempts} failed; retrying in ${wait}ms`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
  throw last;
}

async function saveToSupabase(data) {
  const base = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${TABLE_NAME}`;
  const date = encodeURIComponent(data.market_date);

  console.log(`💾 Saving market summary for ${data.market_date}...`);
  console.log(`🔗 Supabase host: ${new URL(SUPABASE_URL).host}`);

  const existing = await withRetry('Supabase market_summary lookup', () => axios.get(
    `${base}?market_date=eq.${date}&select=id`,
    { headers: supabaseHeaders, timeout: 30000 }
  ));

  if (existing.data?.length) {
    await withRetry('Supabase market_summary update', () => axios.patch(`${base}?market_date=eq.${date}`, data, {
      headers: { ...supabaseHeaders, Prefer: 'return=minimal' }, timeout: 30000
    }));

    console.log('✅ Existing market summary updated');
  } else {
    await withRetry('Supabase market_summary insert', () => axios.post(base, data, {
      headers: { ...supabaseHeaders, Prefer: 'return=minimal' }, timeout: 30000
    }));

    console.log('✅ New market summary inserted');
  }
}

async function main() {
  console.log('======================================');
  console.log('📈 DSE MARKET SUMMARY SCRAPER');
  console.log('======================================');
  console.log(`🕐 ${new Date().toISOString()}`);
  console.log(`🌐 Source: ${DSE_PAGE_URL}`);

  const data = await scrapeDse();

  console.log('');
  console.log('📊 MARKET SUMMARY');
  console.log(`DSEX          : ${data.dsex}`);
  console.log(`Change        : ${data.change}`);
  console.log(`Change %      : ${data.change_percent}%`);
  console.log(`Prev Close    : ${data.previous_close}`);
  const volumeCrore = data.total_volume / 10000000;
  const valueCrore = data.total_value / 10; // DSE value is parsed in BDT million

  console.log(`Total Trade   : ${data.total_trades}`);
  console.log(`Total Volume  : ${volumeCrore.toFixed(2)} cr`);
  console.log(`Total Value   : ${valueCrore.toFixed(2)} cr`);
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
