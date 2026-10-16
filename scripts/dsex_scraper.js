// scripts/dsex_scraper.js
// StockPulse - DSE index history scraper
//
// The live /markets page is client-rendered and was returning no index cards
// in GitHub Actions.  DSE's Recent Market Information page is server-rendered
// and contains DSEX, DSES and DS30 in a stable table, so use that source.

const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');
const { getDhakaDate, numberFrom, upsert } = require('./lib/common');

const DSE_RECENT_MARKET_URLS = [
  // User-confirmed legacy page: this is the source to try first.
  'https://old.dsebd.org/recent_market_information.php',
  'https://old.dsebd.org/recent-market-information.php',
  'https://new.dsebd.org/recent-market-information',
  'https://old.dsebd.org/recent-market-information',
  'https://www.dse.com.bd/recent-market-information',
];
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function normalizeHeader(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseDate(value) {
  const m = String(value || '').match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  return numberFrom(String(value).replace(/,/g, ''));
}

function expandTableRows($, table) {
  // Expand colspan/rowspan so multi-level legacy DSE table headers line up
  // with the data cells. This matters because index columns sit under grouped
  // market-capitalization headings on the legacy page.
  const grid = [];
  const rows = $(table).find('tr').toArray();
  rows.forEach((row, r) => {
    grid[r] = grid[r] || [];
    let c = 0;
    $(row).find('th,td').toArray().forEach(cell => {
      while (grid[r][c] !== undefined) c++;
      const text = $(cell).text().replace(/\s+/g, ' ').trim();
      const colspan = Math.max(1, Number($(cell).attr('colspan')) || 1);
      const rowspan = Math.max(1, Number($(cell).attr('rowspan')) || 1);
      for (let rr = r; rr < r + rowspan; rr++) {
        grid[rr] = grid[rr] || [];
        for (let cc = c; cc < c + colspan; cc++) {
          if (grid[rr][cc] === undefined) grid[rr][cc] = text;
        }
      }
      c += colspan;
    });
  });
  return grid.map(row => row || []);
}

function parseRecentMarketRows(html) {
  const $ = cheerio.load(html);
  const tables = $('table').toArray();
  const candidates = [];

  for (const table of tables) {
    const grid = expandTableRows($, table);
    if (grid.length < 2) continue;

    // Inspect the first several rows as a combined header. Legacy DSE uses
    // grouped headers, so the header labels can span multiple rows.
    const headerEnd = Math.min(5, grid.length - 1);
    const width = Math.max(...grid.slice(0, headerEnd).map(r => r.length), 0);
    const headers = [];
    for (let c = 0; c < width; c++) {
      headers[c] = normalizeHeader(grid.slice(0, headerEnd).map(r => r[c] || '').join(' '));
    }
    const dateIndex = headers.findIndex(h => h.includes('date'));
    const dsexIndex = headers.findIndex(h => h.includes('dsex'));
    const dsesIndex = headers.findIndex(h => h.includes('dses'));
    const ds30Index = headers.findIndex(h => h.includes('ds30'));
    if ([dateIndex, dsexIndex, dsesIndex, ds30Index].some(i => i < 0)) continue;

    const parsed = [];
    for (const cells of grid.slice(headerEnd)) {
      if (cells.length <= Math.max(dateIndex, dsexIndex, dsesIndex, ds30Index)) continue;
      const date = parseDate(cells[dateIndex]);
      const dsex = parseNumber(cells[dsexIndex]);
      const dses = parseNumber(cells[dsesIndex]);
      const ds30 = parseNumber(cells[ds30Index]);
      if (!date || dsex === null || dses === null || ds30 === null) continue;
      parsed.push({ date, DSEX: dsex, DSES: dses, DS30: ds30 });
    }
    if (parsed.length) candidates.push(parsed);
  }

  if (!candidates.length) {
    // Helpful, bounded diagnostics: the failure log will reveal table headings
    // instead of dumping the full page or failing without context.
    const $ = cheerio.load(html);
    const preview = $('table').toArray().slice(0, 8).map((t, i) =>
      `table${i + 1}: ${$(t).find('tr').first().text().replace(/\s+/g, ' ').trim().slice(0, 180)}`
    ).join(' | ');
    throw new Error(`DSE Recent Market Information table with Date/DSEX/DSES/DS30 rows not found. ${preview}`);
  }

  // The Recent Market Information table contains the most daily rows.
  return candidates.sort((a, b) => b.length - a.length)[0]
    .sort((a, b) => a.date.localeCompare(b.date));
}

function makeIndexRows(marketRows) {
  const out = [];
  const names = ['DSEX', 'DSES', 'DS30'];

  for (let i = 0; i < marketRows.length; i++) {
    const current = marketRows[i];
    const previous = marketRows[i - 1] || null;

    for (const name of names) {
      const value = current[name];
      const previousValue = previous ? previous[name] : null;
      const change = previousValue === null || previousValue === undefined
        ? null
        : Number((value - previousValue).toFixed(5));
      const changePercent = previousValue === null || previousValue === undefined || previousValue === 0
        ? null
        : Number(((change / previousValue) * 100).toFixed(5));

      out.push({
        index_name: name,
        date: current.date,
        value,
        change,
        change_percent: changePercent,
        updated_at: new Date().toISOString(),
      });
    }
  }

  return out;
}

async function fetchRecentMarketPage(url) {
  const response = await axios.get(url, {
    httpsAgent,
    headers: HEADERS,
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

async function scrapeDSEIndices() {
  let html = null;
  let marketRows = null;
  const errors = [];
  for (const url of DSE_RECENT_MARKET_URLS) {
    try {
      console.log(`🌐 Trying DSE index source: ${url}`);
      const candidateHtml = await fetchRecentMarketPage(url);
      const candidateRows = parseRecentMarketRows(candidateHtml);
      if (candidateRows.length) { html = candidateHtml; marketRows = candidateRows; break; }
    } catch (err) {
      errors.push(`${url}: ${err.message}`);
      console.warn(`⚠️ DSE index source failed: ${url} — ${err.message}`);
    }
  }
  if (!marketRows) throw new Error(`No DSE index table found on primary or fallback sources. ${errors.join(' | ')}`);
  const rows = makeIndexRows(marketRows);

  const dates = [...new Set(rows.map(row => row.date))];
  console.log(`📊 Recent market dates parsed: ${dates.length}`);
  console.log(`📊 DSEX/DS30/DSES rows parsed: ${rows.length}`);

  if (marketRows.length < 2 || rows.length < 6) {
    throw new Error('Expected at least two market dates for index change calculation.');
  }

  // Save all recent dates returned by DSE. This both refreshes today's value
  // and repairs a small number of missed days from prior runs.
  let saved = 0;
  for (const row of rows) {
    await upsert('dsex_index', row, 'index_name,date');
    saved += 1;
  }

  const latestDate = dates[dates.length - 1];
  const latest = rows.filter(r => r.date === latestDate);
  console.log(`✅ Latest DSE index date: ${latestDate}`);
  for (const row of latest) {
    console.log(`   ${row.index_name}: ${row.value} | change ${row.change} | ${row.change_percent}%`);
  }
  console.log(`🎉 DSEX scraper completed. ${saved} rows upserted.`);
  return rows;
}

async function startScraper() {
  console.log('======================================');
  console.log('📊 DSE INDEX SCRAPER');
  console.log('======================================');
  console.log(`📅 Runner Dhaka date: ${getDhakaDate()}`);
  await scrapeDSEIndices();
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
  makeIndexRows,
};
