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

// Try the legacy site first; if its page/data is incomplete, fall back to the
// current DSE site shown in the user's screenshots.
const DSE_PAGE_URLS = ['https://old.dsebd.org/', 'https://new.dsebd.org/'];
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

function renderWithChromium(url) {
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
    url,
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

async function fallbackHttpFetch(url) {
  console.log('⚠️ Browser render unavailable; trying direct DSE HTML as fallback...');

  const response = await axios.get(url, {
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
  // The current DSE site may render the index card as:
  // "DSEX 5,408.90 −0.00 · 0.00%" or "DSEX 5,408.90 ▲ 0.25%".
  // Do not require the arrow/change value to be adjacent to the percentage.
  const sourceText = String(text || '');
  const label = /DSEX/i.exec(sourceText);
  if (label) {
    const nearby = sourceText.slice(label.index, label.index + 500);
    const valueMatch = nearby.match(/DSEX\s*([\d,]+(?:\.\d+)?)/i);
    if (valueMatch) {
      const dsex = numberFrom(valueMatch[1]);
      // Prefer a percent explicitly near the DSEX card; the new site may put
      // an absolute change (e.g. "−0.00") before the percentage.
      const percentMatches = [...nearby.matchAll(/([-+−–]?\s*\d+(?:\.\d+)?)\s*%/g)];
      if (percentMatches.length) {
        const last = percentMatches[percentMatches.length - 1];
        let changePercent = numberFrom(last[1]);
        const prefix = nearby.slice(Math.max(0, last.index - 30), last.index);
        if (/[▼↓−–-]\s*$/.test(prefix) && changePercent !== 0) {
          changePercent = -Math.abs(changePercent);
        } else if (/[▲↑+]\s*$/.test(prefix)) {
          changePercent = Math.abs(changePercent);
        } else if (/[−–-]\s*\d+(?:\.\d+)?\s*[·•]\s*$/.test(prefix)) {
          // The displayed absolute change is negative; the percent follows
          // after a separator, so preserve its sign.
          changePercent = -Math.abs(changePercent);
        }
        const previousClose = changePercent === 0
          ? dsex
          : dsex / (1 + changePercent / 100);
        const change = dsex - previousClose;
        return {
          dsex,
          change: Number(change.toFixed(5)),
          change_percent: changePercent,
        };
      }
    }
  }

  // Fallback to rendered HTML around the first DSEX card label.
  const context = cleanText(findCardContext(html, 'DSEX')).slice(0, 2500);
  const valueMatch = context.match(/DSEX\s*([\d,]+(?:\.\d+)?)/i);
  const percentMatches = [...context.matchAll(/([-+−–]?\s*\d+(?:\.\d+)?)\s*%/g)];
  if (!valueMatch) {
    throw new Error('DSEX value was not found on the rendered DSE /markets page');
  }
  if (!percentMatches.length) {
    throw new Error('DSEX percentage change was not found near the DSEX card on the rendered DSE page');
  }

  const dsex = numberFrom(valueMatch[1]);
  const last = percentMatches[percentMatches.length - 1];
  let changePercent = numberFrom(last[1]);
  const prefix = context.slice(Math.max(0, last.index - 30), last.index);
  if (/[▼↓−–-]\s*$/.test(prefix) && changePercent !== 0) {
    changePercent = -Math.abs(changePercent);
  } else if (/[▲↑+]\s*$/.test(prefix)) {
    changePercent = Math.abs(changePercent);
  }
  const previousClose = changePercent === 0 ? dsex : dsex / (1 + changePercent / 100);
  return {
    dsex,
    change: Number((dsex - previousClose).toFixed(5)),
    change_percent: changePercent,
  };
}

function parseSummary(text) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();

  // Legacy DSE renders the three activity labels in one table header row,
  // then places their numeric values together in the next row. Therefore the
  // number does NOT necessarily follow "Total Volume" immediately.
  const activityRow = source.match(
    /Total\s+Trade\s+Total\s+Volume\s+Total\s+Value\s+in\s+Taka\s*\(mn\)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)/i
  );

  const turnover = source.match(/TURNOVER\s+(?:BDT\s*)?([\d,]+(?:\.\d+)?)\s*mn/i)
    || source.match(/Total Value in Taka\s*\(mn\)\s*([\d,]+(?:\.\d+)?)/i);
  const volume = source.match(/VOLUME\s+([\d,]+)(?:\s+shares)?/i)
    || source.match(/Total Volume\s*([\d,]+)/i);
  const trades = source.match(/TRADES\s+([\d,]+)(?:\s+executions)?/i)
    || source.match(/Total Trade\s*([\d,]+)/i);

  const breadthRow = source.match(
    /Issues\s+Advanced\s+Issues\s+declined\s+Issues\s+Unchanged\s+([\d,]+)\s+([\d,]+)\s+([\d,]+)/i
  );
  const breadth = source.match(/BREADTH\s+(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/i)
    || source.match(/BREADTH\s+(\d+)\s*\/\s*(\d+)/i)
    || breadthRow;

  const totalTrades = activityRow ? numberFrom(activityRow[1]) : (trades ? numberFrom(trades[1]) : null);
  const totalVolume = activityRow ? numberFrom(activityRow[2]) : (volume ? numberFrom(volume[1]) : null);
  const totalValue = activityRow ? numberFrom(activityRow[3]) : (turnover ? numberFrom(turnover[1]) : null);

  if (totalValue == null) throw new Error('TURNOVER / Total Value was not found');
  if (totalVolume == null) throw new Error('VOLUME / Total Volume was not found');
  if (totalTrades == null) throw new Error('TRADES / Total Trade was not found');
  if (!breadth) throw new Error('BREADTH / Issues Advanced-Declined was not found');

  return {
    total_value: totalValue,
    total_volume: totalVolume,
    total_trades: totalTrades,
    advanced: numberFrom(breadth[1]),
    declined: numberFrom(breadth[2]),
    unchanged: breadth[3] == null ? null : numberFrom(breadth[3]),
  };
}

async function scrapeDse() {
  let html;
  let selectedUrl = null;
  let lastError = null;

  // Preferred source order: legacy DSE first, current DSE as fallback.
  for (const url of DSE_PAGE_URLS) {
    try {
      console.log(`🌐 Trying DSE source: ${url}`);
      try {
        html = renderWithChromium(url);
      } catch (browserError) {
        console.warn(`⚠️ Browser render failed for ${url}: ${browserError.message}`);
        html = await fallbackHttpFetch(url);
      }
      const candidateText = marketSummaryText(html);
      const candidateSummary = parseSummary(candidateText);
      parseDsex(html, candidateText);
      // Require the three core activity values from a source before selecting it.
      // Breadth's unchanged count is optional because the new DSE page omits it.
      if (!(candidateSummary.total_value >= 0) ||
          !(candidateSummary.total_volume >= 0) ||
          !(candidateSummary.total_trades >= 0)) {
        throw new Error('Source is missing one or more core market activity values');
      }
      selectedUrl = url;
      break;
    } catch (err) {
      lastError = err;
      console.warn(`⚠️ Source did not provide complete market summary (${url}): ${err.message}`);
    }
  }

  if (!selectedUrl || !html) {
    throw new Error(`No DSE source provided complete market summary. Last error: ${lastError?.message || 'unknown'}`);
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
  if (data.advanced < 0 || data.declined < 0 ||
      (data.unchanged != null && data.unchanged < 0)) {
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
  console.log(`🌐 Sources (priority order): ${DSE_PAGE_URLS.join(" -> ")}`);

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
  console.log(`Unchanged     : ${data.unchanged == null ? 'not provided by source' : data.unchanged}`);
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
