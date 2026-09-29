// scripts/dsex_scraper.js
// StockPulse - DSE indices scraper
// Uses the current dedicated DSE index pages instead of /markets.
const cheerio = require('cheerio');
const {
  getDhakaDate, cleanText, numberFrom, upsert, renderPage
} = require('./lib/common');

const INDEX_URLS = {
  DSEX: 'https://www.dse.com.bd/indices/DSEX',
  DS30: 'https://www.dse.com.bd/indices/DS30',
  DSES: 'https://www.dse.com.bd/indices/DSES'
};

function extractAfterLabel(text, label) {
  const re = new RegExp(`${label}\\s*([\\d,]+(?:\\.\\d+)?)`, 'i');
  const m = text.match(re);
  return m ? numberFrom(m[1]) : null;
}

function parseIndexPage(html, name) {
  const $ = cheerio.load(html);
  const text = cleanText($('body').text());

  // The dedicated DSE index page exposes the current value and previous close
  // as "Level" and "Prev close". This is more stable than parsing the /markets
  // summary cards, which are loaded asynchronously.
  const level = extractAfterLabel(text, 'Level');
  const prevClose = extractAfterLabel(text, 'Prev\\s+close');

  if (level === null) return null;

  let change = null;
  let changePercent = null;
  if (prevClose !== null) {
    change = level - prevClose;
    changePercent = prevClose !== 0 ? (change / prevClose) * 100 : null;
  }

  // Also try the visible change percentage when available in the rendered DOM.
  const pctMatch = text.match(/(?:Change|Level)[^%]{0,100}?(?:▼|▲)?\\s*[-+]?\\d+(?:\\.\\d+)?\\s*([-+]?\\d+(?:\\.\\d+)?)%/i);
  if (pctMatch) {
    const parsedPct = numberFrom(pctMatch[1]);
    if (parsedPct !== null) changePercent = parsedPct;
  }

  return {
    index_name: name,
    date: getDhakaDate(),
    value: Number(level.toFixed(5)),
    change: change === null ? null : Number(change.toFixed(5)),
    change_percent: changePercent === null ? null : Number(changePercent.toFixed(5)),
    updated_at: new Date().toISOString()
  };
}

function parseIndexesFromPages(pageMap) {
  const rows = [];
  for (const [name, html] of Object.entries(pageMap)) {
    const row = parseIndexPage(html, name);
    if (row) rows.push(row);
  }
  return rows;
}

async function scrapeDSEIndices() {
  const pageMap = {};

  for (const [name, url] of Object.entries(INDEX_URLS)) {
    try {
      console.log(`🌐 ${name}: ${url}`);
      pageMap[name] = renderPage(url, 22000);
    } catch (err) {
      console.error(`⚠️ ${name} page failed: ${err.message}`);
    }
  }

  const rows = parseIndexesFromPages(pageMap);
  console.log(`📊 DSE indices found: ${rows.map(x => x.index_name).join(', ') || 'none'}`);

  if (!rows.length) {
    throw new Error('No DSE index data could be read from the dedicated index pages. No partial save.');
  }

  for (const row of rows) {
    await upsert('dsex_index', row, 'index_name,date');
    console.log(`✅ ${row.index_name}: ${row.value} (${row.change_percent ?? 'n/a'}%)`);
  }

  if (rows.length < 3) {
    console.warn(`⚠️ Only ${rows.length}/3 index pages returned usable data; saved the usable rows and did not fabricate missing values.`);
  } else {
    console.log('🎉 DSEX/DS30/DSES scraper completed');
  }

  return rows;
}

async function startScraper() {
  console.log('======================================');
  console.log('📊 DSE INDEX SCRAPER');
  console.log('======================================');
  console.log('📌 Source: dedicated DSE index pages');
  await scrapeDSEIndices();
}

if (require.main === module) startScraper().catch(err => {
  console.error('❌ DSEX SCRAPER FAILED');
  console.error(err.response?.data || err.message || err);
  process.exit(1);
});

module.exports = { startScraper, scrapeDSEIndices, parseIndexesFromPages, parseIndexPage };
