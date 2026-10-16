const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  htmlToLegacyText, parsePageDate, parseLegacyDsex, parseLegacySummary,
} = require('./lib/dse_legacy');

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
// old.dsebd.org is server-rendered HTML, so a plain HTTP request is tried first (fast,
// stable, no browser noise). Chromium is the backup for it. new.dsebd.org is rendered by
// JavaScript, so Chromium comes first there.
const SOURCE_STRATEGIES = {
  'old.dsebd.org': ['http', 'browser'],
  'new.dsebd.org': ['browser', 'http'],
};
const DEBUG_DIR = 'debug';
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
    '--disable-extensions',
    '--disable-sync',
    '--disable-component-update',
    '--mute-audio',
    '--log-level=3',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,2200',
    '--virtual-time-budget=30000',
    '--run-all-compositor-stages-before-draw',
    '--dump-dom',
    url,
  ];

  // stderr is ignored on purpose: headless Chrome on GitHub runners prints harmless
  // dbus / GCM "ERROR" lines that only clutter the log.
  const html = execFileSync(browser, args, {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (!html || html.length < 1000) {
    throw new Error('DSE page rendered an empty/too-small DOM response');
  }

  return html;
}

function sameHostFrameUrls(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const base = new URL(pageUrl);
  const urls = [];
  $('iframe[src], frame[src]').each((_, frame) => {
    const src = String($(frame).attr('src') || '').trim();
    if (!src || src.startsWith('javascript:') || src.startsWith('data:') || src === 'about:blank') return;
    try {
      const resolved = new URL(src, base);
      if (resolved.protocol.startsWith('http') && resolved.hostname === base.hostname && !urls.includes(resolved.href)) {
        urls.push(resolved.href);
      }
    } catch (_) {}
  });
  return urls.slice(0, 4);
}

async function renderDseDocuments(url) {
  // Legacy DSE has used frames/iframes for parts of its market tables. Chrome's
  // --dump-dom only dumps the top document, not each frame's document, so also
  // render same-host frames as top-level pages and combine their DOMs.
  let mainHtml;
  try {
    mainHtml = renderWithChromium(url);
  } catch (browserError) {
    console.warn(`⚠️ Browser render failed for ${url}: ${browserError.message}`);
    mainHtml = await fallbackHttpFetch(url);
  }

  const documents = [mainHtml];
  const frameUrls = sameHostFrameUrls(mainHtml, url);
  for (const frameUrl of frameUrls) {
    try {
      console.log(`🪟 Checking legacy DSE frame: ${frameUrl}`);
      let frameHtml;
      try {
        frameHtml = renderWithChromium(frameUrl);
      } catch (browserError) {
        console.warn(`⚠️ Frame browser render failed (${frameUrl}): ${browserError.message}`);
        frameHtml = await fallbackHttpFetch(frameUrl);
      }
      if (frameHtml && frameHtml.length > 1000) documents.push(frameHtml);
    } catch (err) {
      console.warn(`⚠️ Could not read DSE frame ${frameUrl}: ${err.message}`);
    }
  }

  // Keep table markup from every document available to Cheerio parsers.
  return documents.map(doc => {
    const $doc = cheerio.load(doc);
    return $doc('body').html() || doc;
  }).join('\n<!-- STOCKPULSE DSE FRAME -->\n');
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

function numericCells(cells) {
  return cells.map(cell => cleanText(cell).replace(/\u2212/g, '-'))
    .map(value => value.match(/[-+]?\s*[\d,]+(?:\.\d+)?\s*%?/))
    .map(match => match ? match[0].trim() : null);
}

function legacyTableRows(html) {
  const $ = cheerio.load(html || '');
  const rows = [];
  $('tr').each((_, tr) => {
    const cells = $(tr).find('th, td').map((__, cell) => $(cell).text().replace(/\s+/g, ' ').trim()).get();
    if (cells.length >= 2) rows.push(cells);
  });
  return rows;
}

function signedNumber(value) {
  if (value == null) return null;
  const normalized = String(value).replace(/\u2212/g, '-').replace(/,/g, '').replace(/\s+/g, '');
  const n = numberFrom(normalized);
  if (n == null) return null;
  return /^-/.test(normalized) ? -Math.abs(n) : n;
}

function parseDsex(html, text) {
  // Legacy page (old.dsebd.org): label, index value, point change and percent come from the
  // dedicated tolerant parser (see scripts/lib/dse_legacy.js).
  let legacyError = null;
  try {
    const legacy = parseLegacyDsex(html);
    console.log(`🧩 Parsed legacy DSEX row (${legacy.mode}): value=${legacy.dsex}, change=${legacy.change}, percent=${legacy.change_percent}, sign=${legacy.direction || 'unproven'}`);
    return legacy;
  } catch (err) {
    legacyError = err;
  }

  const sourceText = String(text || '').replace(/\s+/g, ' ').trim();
  const rows = legacyTableRows(html);

  // Prefer the actual legacy table cells. The old DSE page keeps the label,
  // index value, point change and percentage in separate cells, so flattening
  // all HTML into one string is fragile (icons and nested spans break regexes).
  for (const cells of rows) {
    // Old DSE sometimes wraps table cells in nested tables. In that case the
    // label is not necessarily cells[0], so locate it anywhere in the row.
    const labelIndex = cells.findIndex(cell =>
      /^DSEX\s*Index$/i.test(cleanText(cell).replace(/\s+/g, ' ').trim())
    );
    if (labelIndex < 0) continue;

    const nums = numericCells(cells.slice(labelIndex + 1)).filter(Boolean);
    if (nums.length >= 3) {
      const dsex = numberFrom(nums[0]);
      const change = signedNumber(nums[1]);
      const changePercent = signedNumber(nums[2].replace(/%/g, ''));
      if (dsex > 0 && change != null && changePercent != null) {
        console.log(`🧩 Parsed legacy DSEX row: value=${dsex}, change=${change}, percent=${changePercent}`);
        return { dsex, change, change_percent: changePercent };
      }
    }

    // Some legacy layouts place the label and one or more values in the same
    // cell or expose nested cells in an unusual order. Parse the row text too.
    const rowText = cleanText(cells.join(' ')).replace(/\u2212/g, '-');
    const rowMatch = rowText.match(/DSEX\s*Index\s*([\d,]+(?:\.\d+)?)\s+([-+−–]?\s*[\d,]+(?:\.\d+)?)\s+([-+−–]?\s*\d+(?:\.\d+)?)\s*%/i);
    if (rowMatch) {
      const dsex = numberFrom(rowMatch[1]);
      const change = signedNumber(rowMatch[2]);
      const changePercent = signedNumber(rowMatch[3]);
      if (dsex > 0 && change != null && changePercent != null) {
        console.log(`🧩 Parsed legacy DSEX row text: value=${dsex}, change=${change}, percent=${changePercent}`);
        return { dsex, change, change_percent: changePercent };
      }
    }
  }

  // Flattened legacy-table fallback for pages whose table markup is unusual.
  const oldTable = sourceText.match(
    /DSEX\s*Index\s*([\d,]+(?:\.\d+)?)\s+([-+−–]?\s*[\d,]+(?:\.\d+)?)\s+([-+−–]?\s*\d+(?:\.\d+)?)\s*%/i
  );
  if (oldTable) {
    return {
      dsex: numberFrom(oldTable[1]),
      change: signedNumber(oldTable[2]),
      change_percent: signedNumber(oldTable[3]),
    };
  }

  // Current DSE card fallback.
  const dsexLabel = /DSEX/i.exec(sourceText);
  if (dsexLabel) {
    const nearby = sourceText.slice(dsexLabel.index, dsexLabel.index + 180);
    const valueMatch = nearby.match(/DSEX(?:\s*·\s*Broad\s+Index)?\s*([\d,]+(?:\.\d+)?)/i);
    if (valueMatch) {
      const dsex = numberFrom(valueMatch[1]);
      const percentMatch = nearby.match(/([-+−–]?\s*\d+(?:\.\d+)?)\s*%/);
      if (percentMatch) {
        const changePercent = signedNumber(percentMatch[1]);
        const change = changePercent === 0
          ? 0
          : Number((dsex - dsex / (1 + changePercent / 100)).toFixed(5));
        return { dsex, change, change_percent: changePercent };
      }
    }
  }
  throw new Error(`DSEX value/change was not found in the legacy DSEX Index table or current DSE summary card (${legacyError ? legacyError.message : 'no detail'})`);
}

function parseSummary(text, html = '') {
  try {
    return parseLegacySummary(html);
  } catch (_) {
    // not the legacy layout: continue with the current-site / generic parsers below
  }

  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const rows = legacyTableRows(html);
  let activityValues = null;
  let breadthValues = null;

  // Read legacy DSE table rows cell-by-cell: header and values are separate
  // rows in the page shown by the user.
  for (let i = 0; i < rows.length; i++) {
    const normalized = rows[i].map(v => cleanText(v).toLowerCase().replace(/\s+/g, ' ').trim());
    if (normalized.some(v => /total\s*trade/.test(v)) &&
        normalized.some(v => /total\s*volume/.test(v)) &&
        normalized.some(v => /total\s*value\s*in\s*taka/.test(v))) {
      const next = rows[i + 1] || [];
      const nums = numericCells(next).filter(Boolean);
      if (nums.length >= 3) activityValues = nums.slice(0, 3).map(numberFrom);
    }
    if (normalized.some(v => /issues\s*advanced/.test(v)) &&
        normalized.some(v => /issues\s*declined/.test(v)) &&
        normalized.some(v => /issues\s*unchanged/.test(v))) {
      const next = rows[i + 1] || [];
      const nums = numericCells(next).filter(Boolean);
      if (nums.length >= 3) breadthValues = nums.slice(0, 3).map(numberFrom);
    }
  }

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

  const totalTrades = activityValues ? activityValues[0] : (activityRow ? numberFrom(activityRow[1]) : (trades ? numberFrom(trades[1]) : null));
  const totalVolume = activityValues ? activityValues[1] : (activityRow ? numberFrom(activityRow[2]) : (volume ? numberFrom(volume[1]) : null));
  const totalValue = activityValues ? activityValues[2] : (activityRow ? numberFrom(activityRow[3]) : (turnover ? numberFrom(turnover[1]) : null));
  const advanced = breadthValues ? breadthValues[0] : (breadth ? numberFrom(breadth[1]) : null);
  const declined = breadthValues ? breadthValues[1] : (breadth ? numberFrom(breadth[2]) : null);
  let unchanged = breadthValues ? breadthValues[2] : (breadth && breadth[3] != null ? numberFrom(breadth[3]) : null);

  // New DSE provides advanced/declined but may omit unchanged. Infer it from
  // the currently expected 385 listed issues only when the source lacks it.
  if (unchanged == null && advanced != null && declined != null) {
    unchanged = Math.max(0, 385 - (advanced + declined));
  }

  if (totalValue == null) throw new Error('TURNOVER / Total Value was not found');
  if (totalVolume == null) throw new Error('VOLUME / Total Volume was not found');
  if (totalTrades == null) throw new Error('TRADES / Total Trade was not found');
  if (advanced == null || declined == null) throw new Error('BREADTH / Issues Advanced-Declined was not found');

  return {
    total_value: totalValue,
    total_volume: totalVolume,
    total_trades: totalTrades,
    advanced,
    declined,
    unchanged,
  };
}

function saveDebug(label, html) {
  try {
    if (!html) return;
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `${label.replace(/[^a-z0-9.]+/gi, '_')}.html`);
    fs.writeFileSync(file, String(html).slice(0, 3 * 1024 * 1024));
    console.log(`🧪 Saved debug copy of the page: ${file}`);
  } catch (err) {
    console.warn(`⚠️ Could not save debug page: ${err.message}`);
  }
}

async function scrapeDse() {
  let picked = null;
  const failures = [];

  // Source order: old DSE first, new DSE only as fallback.
  for (const url of DSE_PAGE_URLS) {
    const host = new URL(url).hostname;
    const strategies = SOURCE_STRATEGIES[host] || ['browser', 'http'];

    for (const strategy of strategies) {
      const label = `${host} via ${strategy}`;
      let html = '';
      try {
        console.log(`🌐 Trying DSE source: ${url} (${strategy})`);
        html = strategy === 'http'
          ? await withRetry(`HTTP ${host}`, () => fallbackHttpFetch(url), 2)
          : await renderDseDocuments(url);

        const text = marketSummaryText(html);
        const summary = parseSummary(text, html);
        const dsex = parseDsex(html, text);

        // The three core activity values are required; "unchanged" is optional (new DSE omits it).
        if (!(summary.total_value >= 0) || !(summary.total_volume >= 0) || !(summary.total_trades >= 0)) {
          throw new Error('Source is missing one or more core market activity values');
        }
        picked = { url, host, strategy, html, text, summary, dsex };
        break;
      } catch (err) {
        failures.push(`${label}: ${err.message}`);
        console.warn(`⚠️ Source did not provide complete market summary (${label}): ${err.message}`);
        saveDebug(label, html);
      }
    }
    if (picked) break;
  }

  if (!picked) {
    throw new Error(`No DSE source provided complete market summary. ${failures.join(' | ')}`);
  }

  const { url: selectedUrl, strategy, html, text, summary, dsex } = picked;
  console.log(`✅ Selected DSE source: ${selectedUrl} (${strategy})`);
  console.log(`📄 Page size: ${html.length} bytes`);
  console.log(`📊 Market Summary text: ${htmlToLegacyText(html).slice(0, 600)}`);

  // Use the date printed on the page ("Last update on Oct 15, 2026 ...") so a run on a
  // Friday/Saturday/holiday stores the real trading day instead of creating a row for today.
  const pageDate = parsePageDate(htmlToLegacyText(html)) || parsePageDate(text);
  const marketDate = pageDate || getDhakaDate();
  console.log(`📅 Market date: ${marketDate} (${pageDate ? 'from the DSE page' : 'Dhaka calendar date; page date not found'})`);

  // The change is already provided by the legacy page. Only when a source reports 0.00%
  // (market closed / card without movement) or when the sign could not be proven from the
  // page, use the previous stored market day to work out the direction/change.
  let calculatedChange = dsex.change;
  let calculatedPercent = dsex.change_percent;
  let previousClose = dsex.dsex - dsex.change;
  const zeroMove = Math.abs(calculatedPercent) < 0.0000001;
  const unsignedMove = dsex.direction === null && !zeroMove;

  if (zeroMove || unsignedMove) {
    try {
      const previous = await withRetry('Supabase previous DSEX lookup', () => axios.get(
        `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${TABLE_NAME}?market_date=lt.${encodeURIComponent(marketDate)}&select=market_date,dsex&order=market_date.desc&limit=1`,
        { headers: supabaseHeaders, timeout: 30000 }
      ));
      const previousDsex = numberFrom(previous.data?.[0]?.dsex);
      if (previousDsex > 0 && zeroMove) {
        previousClose = previousDsex;
        calculatedChange = Number((dsex.dsex - previousDsex).toFixed(5));
        calculatedPercent = Number(((calculatedChange / previousDsex) * 100).toFixed(5));
        console.log(`📚 DSEX change calculated against previous stored market date ${previous.data[0].market_date}: ${previousDsex}`);
      } else if (previousDsex > 0 && unsignedMove) {
        const sign = dsex.dsex >= previousDsex ? 1 : -1;
        calculatedChange = sign * Math.abs(dsex.change);
        calculatedPercent = sign * Math.abs(dsex.change_percent);
        previousClose = dsex.dsex - calculatedChange;
        console.log(`📚 DSEX direction (${sign > 0 ? 'up' : 'down'}) confirmed against previous stored market date ${previous.data[0].market_date}: ${previousDsex}`);
      } else {
        console.warn('⚠️ No prior DSEX value found; keeping the change reported by the source');
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

if (require.main === module) {
  main().catch(error => {
    console.error('❌ MARKET SUMMARY SCRAPER FAILED');
    console.error(error.response?.data || error.message || error);
    process.exit(1);
  });
}

module.exports = { parseDsex, parseSummary, marketSummaryText, cleanText, numberFrom, scrapeDse };
