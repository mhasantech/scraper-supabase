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

const DSE_RECENT_MARKET_URL = 'https://www.dse.com.bd/recent-market-information';
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

function parseRecentMarketRows(html) {
  const $ = cheerio.load(html);
  const tables = $('table').toArray();
  const candidates = [];

  for (const table of tables) {
    const rows = $(table).find('tr').toArray();
    if (rows.length < 2) continue;

    const headerCells = $(rows[0]).find('th,td').toArray();
    const headers = headerCells.map(cell => normalizeHeader($(cell).text()));

    const dateIndex = headers.findIndex(h => h === 'date');
    const dsexIndex = headers.findIndex(h => h === 'dsex');
    const dsesIndex = headers.findIndex(h => h === 'dses');
    const ds30Index = headers.findIndex(h => h === 'ds30');

    if (dateIndex < 0 || dsexIndex < 0 || dsesIndex < 0 || ds30Index < 0) continue;

    const parsed = [];
    for (const row of rows.slice(1)) {
      const cells = $(row).find('td,th').toArray().map(cell => $(cell).text().trim());
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
    throw new Error('DSE Recent Market Information table not found or returned no index rows.');
  }

  // Prefer the candidate with the most rows.
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

async function fetchRecentMarketPage() {
  const response = await axios.get(DSE_RECENT_MARKET_URL, {
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
  console.log(`🌐 Fetching: ${DSE_RECENT_MARKET_URL}`);
  const html = await fetchRecentMarketPage();
  const marketRows = parseRecentMarketRows(html);
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
