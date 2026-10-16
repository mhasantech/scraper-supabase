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
  const sourceText = String(text || '').replace(/\s+/g, ' ').trim();

  // Legacy DSE table: "DSEX Index 5452.05858 22.68731 0.41786%"
  // New DSE card: "DSEX 5,408.90 −0.00 (+0.00%)"
  const oldTable = sourceText.match(
    /DSEX\s+Index\s+([\d,]+(?:\.\d+)?)\s+([-+−–]?\s*[\d,]+(?:\.\d+)?)\s+([-+−–]?\s*\d+(?:\.\d+)?)\s*%/i
  );
  if (oldTable) {
    const dsex = numberFrom(oldTable[1]);
    let change = numberFrom(oldTable[2]);
    let changePercent = numberFrom(oldTable[3]);
    if (/[-−–]/.test(oldTable[2].trim().charAt(0))) change = -Math.abs(change);
    if (/[-−–]/.test(oldTable[3].trim().charAt(0))) changePercent = -Math.abs(changePercent);
    return { dsex, change, change_percent: changePercent };
  }

  // Current site uses a DSEX card. Capture the numeric value and the percent
  // in a bounded section so percentages from unrelated ticker rows are ignored.
  const dsexLabel = /DSEX/i.exec(sourceText);
  if (dsexLabel) {
    const nearby = sourceText.slice(dsexLabel.index, dsexLabel.index + 180);
    const valueMatch = nearby.match(/DSEX(?:\s*·\s*Broad\s+Index)?\s*([\d,]+(?:\.\d+)?)/i);
    if (valueMatch) {
      const dsex = numberFrom(valueMatch[1]);
      const percentMatch = nearby.match(/([-+−–]?\s*\d+(?:\.\d+)?)\s*%/);
      if (percentMatch) {
        let changePercent = numberFrom(percentMatch[1]);
        if (/[-−–]/.test(percentMatch[1].trim().charAt(0))) {
          changePercent = -Math.abs(changePercent);
        } else if (/^\s*\+/.test(percentMatch[1])) {
          changePercent = Math.abs(changePercent);
        }
        // When displayed percent is 0.00, calculate it from the prior day's
        // database record later, rather than assuming the index did not move.
        const change = changePercent === 0
          ? 0
          : Number((dsex - dsex / (1 + changePercent / 100)).toFixed(5));
        return { dsex, change, change_percent: changePercent };
      }
    }
  }

  // HTML fallback: strip tags and try the old index table's label/value row.
  const htmlText = cleanText(findCardContext(html, 'DSEX')).replace(/\s+/g, ' ');
  const oldFallback = htmlText.match(
    /DSEX\s+Index\s+([\d,]+(?:\.\d+)?)\s+([-+−–]?\s*[\d,]+(?:\.\d+)?)\s+([-+−–]?\s*\d+(?:\.\d+)?)\s*%/i
  );
  if (oldFallback) {
    let change = numberFrom(oldFallback[2]);
    let changePercent = numberFrom(oldFallback[3]);
    if (/[-−–]/.test(oldFallback[2].trim().charAt(0))) change = -Math.abs(change);
    if (/[-−–]/.test(oldFallback[3].trim().charAt(0))) changePercent = -Math.abs(changePercent);
    return { dsex: numberFrom(oldFallback[1]), change, change_percent: changePercent };
  }
  throw new Error('DSEX value/change was not found in either the legacy index table or current DSE summary card');
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
    unchanged: breadth[3] == null
      ? Math.max(0, 385 - (numberFrom(breadth[1]) + numberFrom(breadth[2])))
      : numberFrom(breadth[3]),
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

  console.log(`✅ Selected DSE source: ${selectedUrl}`);
  console.log(`📄 Rendered DSE DOM: ${html.length} bytes`);
  console.log(`📊 Market Summary text: ${text.slice(0, 1200)}`);

  const dsex = parseDsex(html, text);
  const summary = parseSummary(text);
  const marketDate = getDhakaDate();

  // If the source reports 0.00% (common when the market is closed or its
  // summary card omits the daily movement), use the previous stored market
  // day's DSEX to calculate the absolute and percentage change.
  let calculatedChange = dsex.change;
  let calculatedPercent = dsex.change_percent;
  let previousClose = dsex.dsex - dsex.change;
  if (Math.abs(calculatedPercent) < 0.0000001) {
    try {
      const previous = await axios.get(
        `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${TABLE_NAME}?market_date=lt.${encodeURIComponent(marketDate)}&select=market_date,dsex&order=market_date.desc&limit=1`,
        { headers: supabaseHeaders, timeout: 30000 }
      );
      const previousDsex = numberFrom(previous.data?.[0]?.dsex);
      if (previousDsex > 0) {
        previousClose = previousDsex;
        calculatedChange = Number((dsex.dsex - previousDsex).toFixed(5));
        calculatedPercent = Number(((calculatedChange / previousDsex) * 100).toFixed(5));
        console.log(`📚 DSEX change calculated against previous stored market date ${previous.data[0].market_date}: ${previousDsex}`);
      } else {
        console.warn('⚠️ No prior DSEX value found; retaining source change of 0.00');
      }
    } catch (err) {
      console.warn(`⚠️ Could not read prior DSEX for change calculation: ${err.message}`);
    }
  }

  const data = {
    market_date: marketDate,
    dsex: dsex.dsex,
    previous_close: Number(previousClose.toFixed(5)),
    change: calculatedChange,
    change_percent: calculatedPercent,
    total_trades: summary.total_trades,
    total_volume: summary.total_volume,
    total_value: summary.total_value,
    advanced: summary.advanced,
    declined: summary.declined,
    unchanged: summary.unchanged,
    market_status: condition(calculatedChange),
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
