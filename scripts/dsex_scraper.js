// scripts/dsex_scraper.js
// StockPulse - DSE index history scraper (DSEX / DSES / DS30)
//
// SOURCE: DSE "Recent Market Information" page (server-rendered table)
//   https://old.dsebd.org/recent_market_information.php
//
// The table has a TWO-ROW header with merged cells (colspan / rowspan) and dates written
// as DD-MM-YYYY, e.g.
//   Date | Total Trade | Total Volume | Total Value in Taka (mn) | Market Capitalization ... | DSEX | DSES | DS30
//   15-10-2026 | 162437 | 162107049 | 4996.899 | ... | 5452.05858 | 1077.95857 | 2096.50979
//
// The parser is dependency-free (no cheerio) so it can be unit-tested offline. It therefore:
//   * expands colspan/rowspan into a real grid,
//   * finds the DSEX / DSES / DS30 columns BY HEADER NAME (not by position),
//   * understands DD-MM-YYYY and YYYY-MM-DD dates,
//   * computes change / change % from the previous trading day in the table.

const fs = require('fs');
const path = require('path');

const DSE_RECENT_MARKET_URLS = [
  'https://old.dsebd.org/recent_market_information.php',
  'https://www.dsebd.org/recent_market_information.php',
  'https://new.dsebd.org/recent-market-information',
  'https://www.dse.com.bd/recent-market-information',
];

const INDEX_NAMES = ['DSEX', 'DSES', 'DS30'];

// ------------------------------------------------------------
// Pure parsing helpers (no network, no Supabase) — unit-tested in test_dsex_recent.js
// ------------------------------------------------------------
function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[\u2212\u2013]/g, '-').replace(/,/g, '').replace(/\s+/g, '');
  if (text === '' || text === '-' || /^n\/?a$/i.test(text)) return null;
  const m = text.match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function isoDate(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// DD-MM-YYYY (DSE's format), YYYY-MM-DD, DD Mon YYYY
function parseDate(value) {
  const s = String(value || '').trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return isoDate(m[3], m[2], m[1]);
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return isoDate(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return isoDate(m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], m[1]);
  return null;
}

function decodeEntities(v) {
  return String(v)
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
}

function cellText(raw) {
  return decodeEntities(String(raw).replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ''))
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function spanOf(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(attrs || '');
  return m ? Math.max(1, parseInt(m[1], 10)) : 1;
}

// Splits the page into tables -> rows -> cells { text, colspan, rowspan }.
// Nested tables are handled with a stack: a nested table's text never leaks into its parent cell.
function extractTables(html) {
  const src = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');

  const tagRe = /<(\/?)(table|tr|td|th)\b([^>]*)>/gi;
  const tables = [];
  const stack = [];
  let last = 0;
  let m;

  const finishCell = (t) => {
    if (t.cell) {
      t.row = t.row || [];
      t.row.push({ text: cellText(t.cell.raw), colspan: t.cell.colspan, rowspan: t.cell.rowspan });
      t.cell = null;
    }
  };
  const finishRow = (t) => {
    if (t.row && t.row.length) t.rows.push(t.row);
    t.row = null;
  };

  while ((m = tagRe.exec(src)) !== null) {
    const top = stack[stack.length - 1];
    if (top && top.cell) top.cell.raw += src.slice(last, m.index);
    last = tagRe.lastIndex;

    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();

    if (tag === 'table') {
      if (!closing) {
        stack.push({ rows: [], row: null, cell: null });
      } else {
        const t = stack.pop();
        if (t) { finishCell(t); finishRow(t); tables.push(t.rows); }
      }
      continue;
    }

    if (!top) continue;

    if (tag === 'tr') {
      finishCell(top); finishRow(top);
      if (!closing) top.row = [];
    } else { // td / th
      finishCell(top);
      if (!closing) {
        if (!top.row) top.row = [];
        top.cell = { raw: '', colspan: spanOf(m[3], 'colspan'), rowspan: spanOf(m[3], 'rowspan') };
      }
    }
  }
  return tables;
}

// Expand colspan/rowspan so every logical column has a header text and every data row is aligned.
function rowsToGrid(rows) {
  const grid = [];
  const carry = []; // carry[col] = { remaining, text }

  for (const cells of rows) {
    const row = [];
    let col = 0;
    const fillCarry = () => {
      while (carry[col] && carry[col].remaining > 0) {
        row[col] = carry[col].text;
        carry[col].remaining -= 1;
        col += 1;
      }
    };

    fillCarry();
    for (const cell of cells) {
      fillCarry();
      for (let i = 0; i < cell.colspan; i++) {
        if (cell.rowspan > 1) carry[col] = { remaining: cell.rowspan - 1, text: cell.text };
        row[col] = cell.text;
        col += 1;
      }
    }
    fillCarry();
    grid.push(row);
  }
  return grid;
}

function findColumn(headerTexts, wanted) {
  // wanted: 'dsex' | 'dses' | 'ds30' | 'date'
  for (let c = 0; c < headerTexts.length; c++) {
    const h = headerTexts[c];
    if (wanted === 'date') {
      if (h === 'date' || h.endsWith('date')) return c;
    } else if (h.includes(wanted)) {
      return c;
    }
  }
  return -1;
}

function parseRecentMarketRows(html) {
  const candidates = [];
  const diagnostics = [];

  for (const tableRows of extractTables(html)) {
    const grid = rowsToGrid(tableRows);
    if (grid.length < 2) continue;

    // First data row = first row whose first non-empty cell is a date.
    const firstDataIdx = grid.findIndex(r => parseDate(r.find(cell => cell && cell.trim()) || ''));
    if (firstDataIdx < 1) {
      continue; // no header or no dated rows
    }

    const headerRows = grid.slice(0, firstDataIdx);
    const width = Math.max(...grid.map(r => r.length));
    const headerTexts = [];
    for (let c = 0; c < width; c++) {
      const parts = [];
      for (const hr of headerRows) {
        const t = hr[c];
        if (t && parts[parts.length - 1] !== t) parts.push(t);
      }
      headerTexts.push(normalizeHeader(parts.join(' ')));
    }

    diagnostics.push(headerTexts.join(' | '));

    const cols = {
      date: findColumn(headerTexts, 'date'),
      DSEX: findColumn(headerTexts, 'dsex'),
      DSES: findColumn(headerTexts, 'dses'),
      DS30: findColumn(headerTexts, 'ds30'),
    };
    if (cols.date < 0) cols.date = 0;
    if (cols.DSEX < 0) continue;

    const parsed = [];
    for (const row of grid.slice(firstDataIdx)) {
      const date = parseDate(row[cols.date]);
      if (!date) continue;
      const dsex = parseNumber(row[cols.DSEX]);
      if (!(dsex >= 1000 && dsex <= 30000)) continue;

      const entry = { date, DSEX: dsex };
      for (const name of ['DSES', 'DS30']) {
        if (cols[name] >= 0) {
          const v = parseNumber(row[cols[name]]);
          if (v > 0) entry[name] = v;
        }
      }
      parsed.push(entry);
    }
    if (parsed.length) candidates.push(parsed);
  }

  if (!candidates.length) {
    const seen = diagnostics.length ? ` Header rows seen: ${diagnostics.slice(0, 3).join(' || ')}` : ' No table with dated rows was found.';
    throw new Error(`DSE Recent Market Information table not found or has no DSEX column.${seen}`);
  }

  // De-duplicate dates, keep the largest candidate table, sort oldest -> newest.
  const best = candidates.sort((a, b) => b.length - a.length)[0];
  const byDate = new Map();
  for (const r of best) if (!byDate.has(r.date)) byDate.set(r.date, r);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function makeIndexRows(marketRows) {
  const out = [];
  const now = new Date().toISOString();

  for (let i = 0; i < marketRows.length; i++) {
    const current = marketRows[i];
    const previous = marketRows[i - 1] || null;

    for (const name of INDEX_NAMES) {
      const value = current[name];
      if (!(value > 0)) continue;

      const row = { index_name: name, date: current.date, value, updated_at: now };
      const previousValue = previous ? previous[name] : null;

      // The oldest row of the window has no previous day: leave change fields out so an
      // existing (correct) change value in the database is not overwritten with null.
      if (previousValue > 0) {
        const change = Number((value - previousValue).toFixed(5));
        row.change = change;
        row.change_percent = Number(((change / previousValue) * 100).toFixed(5));
      }
      out.push(row);
    }
  }
  return out;
}

// ------------------------------------------------------------
// Network + Supabase (only loaded when the scraper actually runs)
// ------------------------------------------------------------
const DEBUG_DIR = path.join(process.cwd(), 'debug');

function saveDebug(name, html) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEBUG_DIR, name), html || '');
  } catch (_) {}
}

async function fetchRecentMarketPage(url, common) {
  const { axios, httpsAgent } = common;
  const response = await axios.get(url, {
    httpsAgent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 30000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: status => status >= 200 && status < 400,
  });

  if (typeof response.data !== 'string' || response.data.length < 1000) {
    throw new Error('DSE Recent Market Information returned empty/invalid HTML.');
  }
  return response.data;
}

async function scrapeDSEIndices(common) {
  let marketRows = null;
  const errors = [];
  let n = 0;

  for (const url of DSE_RECENT_MARKET_URLS) {
    n += 1;
    console.log(`🌐 Trying DSE index source: ${url}`);

    // 1) plain HTTP (the old DSE page is server-rendered, so this is fast)
    try {
      const html = await fetchRecentMarketPage(url, common);
      try {
        marketRows = parseRecentMarketRows(html);
      } catch (parseError) {
        saveDebug(`dsex-source-${n}.html`, html);
        throw parseError;
      }
      break;
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      console.warn(`⚠️ DSE index source failed (HTTP): ${url} — ${err.message}`);
    }

    // 2) same URL rendered in Chromium (handles script-built tables / bot pages)
    try {
      const html = common.renderPage(url, 15000);
      try {
        marketRows = parseRecentMarketRows(html);
      } catch (parseError) {
        saveDebug(`dsex-source-${n}-rendered.html`, html);
        throw parseError;
      }
      break;
    } catch (err) {
      errors.push(`${url} (browser): ${err.message}`);
      console.warn(`⚠️ DSE index source failed (browser): ${url} — ${err.message}`);
    }
  }

  if (!marketRows) {
    throw new Error(`No DSE index table found on any source. ${errors.join(' | ')}`);
  }

  if (marketRows.length < 2) {
    throw new Error('Expected at least two market dates for index change calculation.');
  }

  const rows = makeIndexRows(marketRows);
  const dates = [...new Set(rows.map(row => row.date))];
  console.log(`📊 Recent market dates parsed: ${dates.length} (${dates[0]} → ${dates[dates.length - 1]})`);
  console.log(`📊 Index rows to save: ${rows.length}`);

  // Saves all recent dates returned by DSE: refreshes today's value and repairs missed days.
  let saved = 0;
  for (const row of rows) {
    await common.upsert('dsex_index', row, 'index_name,date');
    saved += 1;
  }

  const latestDate = dates[dates.length - 1];
  console.log(`✅ Latest DSE index date: ${latestDate}`);
  for (const row of rows.filter(r => r.date === latestDate)) {
    console.log(`   ${row.index_name}: ${row.value} | change ${row.change ?? 'n/a'} | ${row.change_percent ?? 'n/a'}%`);
  }
  console.log(`🎉 DSEX scraper completed. ${saved} rows upserted.`);
  return rows;
}

async function startScraper() {
  const common = require('./lib/common'); // requires SUPABASE_SERVICE_KEY
  console.log('======================================');
  console.log('📊 DSE INDEX SCRAPER');
  console.log('======================================');
  console.log(`📅 Runner Dhaka date: ${common.getDhakaDate()}`);
  await scrapeDSEIndices(common);
}

if (require.main === module) {
  startScraper().catch(err => {
    console.error('❌ DSEX SCRAPER FAILED');
    console.error(err.response?.data || err.stack || err.message || err);
    process.exit(1);
  });
}

module.exports = {
  startScraper,
  scrapeDSEIndices,
  parseRecentMarketRows,
  extractTables,
  makeIndexRows,
  parseDate,
  parseNumber,
};
