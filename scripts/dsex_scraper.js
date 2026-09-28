// scripts/dsex_scraper.js
// StockPulse - DSE indices scraper
// Current DSE site: https://dse.com.bd/markets
const cheerio = require('cheerio');
const {
  getDhakaDate, cleanText, numberFrom, condition, upsert, renderPage
} = require('./lib/common');

const DSE_MARKETS_URL = 'https://dse.com.bd/markets';

function parseIndexCard(text, name) {
  const re = new RegExp(`${name}\\s+([\\d,]+(?:\\.\\d+)?)\\s*(?:([▼▲])\\s*)?([-+]?\\d+(?:\\.\\d+)?)\\s*%`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const value = numberFrom(m[1]);
  let pct = numberFrom(m[3]);
  if (m[2] === '▼') pct = -Math.abs(pct);
  if (m[2] === '▲') pct = Math.abs(pct);
  const previous = value / (1 + pct / 100);
  const change = value - previous;
  return {
    index_name: name,
    date: getDhakaDate(),
    value,
    change: Number(change.toFixed(5)),
    change_percent: Number(pct.toFixed(5)),
    updated_at: new Date().toISOString()
  };
}

function parseIndexes(html) {
  const $ = cheerio.load(html);
  const text = cleanText($('body').text());
  const out = [];
  for (const name of ['DSEX', 'DS30', 'DSES']) {
    const row = parseIndexCard(text, name);
    if (row) out.push(row);
  }
  return out;
}

async function scrapeDSEIndices() {
  const html = renderPage(DSE_MARKETS_URL, 18000);
  const rows = parseIndexes(html);
  console.log(`📊 DSE indices found: ${rows.map(x => x.index_name).join(', ') || 'none'}`);
  if (rows.length < 3) {
    throw new Error(`Expected DSEX, DS30 and DSES, but only found ${rows.length}. No partial save.`);
  }

  for (const row of rows) {
    await upsert('dsex_index', row, 'index_name,date');
    console.log(`✅ ${row.index_name}: ${row.value} (${row.change_percent}%)`);
  }
  console.log('🎉 DSEX/DS30/DSES scraper completed');
  return rows;
}

async function startScraper() {
  console.log('======================================');
  console.log('📊 DSE INDEX SCRAPER');
  console.log('======================================');
  await scrapeDSEIndices();
}

if (require.main === module) startScraper().catch(err => {
  console.error('❌ DSEX SCRAPER FAILED');
  console.error(err.response?.data || err.message || err);
  process.exit(1);
});

module.exports = { startScraper, scrapeDSEIndices, parseIndexes };
