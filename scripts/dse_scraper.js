// scripts/dse_scraper.js
// StockPulse - DSE latest share-price scraper
// Current DSE site: https://dse.com.bd/markets/latest-share-price
const cheerio = require('cheerio');
const {
  getDhakaDate, cleanText, numberFrom, normalizeHeader,
  condition, upsert, renderPage
} = require('./lib/common');

const DSE_URL = 'https://dse.com.bd/markets/latest-share-price?sort=ltp';

function parseRenderedRows(html) {
  const $ = cheerio.load(html);
  const records = [];
  const date = getDhakaDate();

  $('table').each((_, table) => {
    const headers = [];
    $(table).find('thead tr').first().find('th,td').each((_, cell) => {
      headers.push(normalizeHeader($(cell).text()));
    });
    if (!headers.length) {
      const first = $(table).find('tr').first();
      first.find('th,td').each((_, cell) => headers.push(normalizeHeader($(cell).text())));
    }

    const codeIdx = headers.findIndex(x => ['tradingcode','code','instrumentcode'].includes(x));
    const ltpIdx = headers.findIndex(x => x === 'ltp' || x === 'ltp*');
    const highIdx = headers.findIndex(x => x === 'high');
    const lowIdx = headers.findIndex(x => x === 'low');
    const ycpIdx = headers.findIndex(x => x === 'ycp' || x === 'ycp*' || x === 'yesterdayclosingprice');
    const changeIdx = headers.findIndex(x => x === 'changetk' || x === 'change');
    const pctIdx = headers.findIndex(x => x === 'change' || x === 'changepercent' || x === 'change%');
    const tradeIdx = headers.findIndex(x => x === 'trade' || x === 'trades');
    const valueIdx = headers.findIndex(x => x === 'valuemn' || x === 'value');
    const volumeIdx = headers.findIndex(x => x === 'volume');

    if (codeIdx < 0 || ltpIdx < 0) return;

    $(table).find('tbody tr').each((_, tr) => {
      const cells = $(tr).find('td').toArray().map(td => cleanText($(td).text()));
      if (!cells.length) return;
      const code = cleanText(cells[codeIdx]);
      const ltp = numberFrom(cells[ltpIdx]);
      if (!code || ltp === null || !/^[A-Z0-9&().\-]+$/i.test(code)) return;

      const ycp = ycpIdx >= 0 ? numberFrom(cells[ycpIdx]) : null;
      const change = changeIdx >= 0 ? numberFrom(cells[changeIdx]) : (ycp !== null ? ltp - ycp : null);
      const pct = pctIdx >= 0 ? numberFrom(cells[pctIdx]) : (ycp ? ((ltp-ycp)/ycp)*100 : null);

      records.push({
        ticker: code,
        date,
        ltp,
        high: highIdx >= 0 ? numberFrom(cells[highIdx]) : null,
        low: lowIdx >= 0 ? numberFrom(cells[lowIdx]) : null,
        volume: volumeIdx >= 0 ? Math.round(numberFrom(cells[volumeIdx]) || 0) : 0,
        change: change === null ? 0 : Number(change.toFixed(5)),
        change_percent: pct === null ? 0 : Number(pct.toFixed(5)),
        updated_at: new Date().toISOString()
      });
    });
  });

  const unique = new Map(records.map(r => [r.ticker, r]));
  return [...unique.values()];
}

async function scrapeDSELatestPrices() {
  const html = renderPage(DSE_URL, 18000);
  const records = parseRenderedRows(html);
  console.log(`📊 DSE rendered rows: ${records.length}`);
  if (records.length < 50) {
    throw new Error(`DSE latest-price page returned only ${records.length} usable rows; refusing to save partial data.`);
  }

  let liveSaved = 0, closeSaved = 0;
  for (const r of records) {
    if (await upsert('dse_live_data', r, 'ticker,date')) liveSaved++;

    const close = {
      ticker: r.ticker, date: r.date, ltp: r.ltp,
      high: r.high, low: r.low, volume: r.volume,
      updated_at: r.updated_at
    };
    if (await upsert('dse_closing_prices', close, 'ticker,date')) closeSaved++;
  }

  console.log(`✅ DSE complete: live ${liveSaved}/${records.length}, closing ${closeSaved}/${records.length}`);
  return records;
}

async function startScraper() {
  console.log('======================================');
  console.log('📈 DSE LATEST PRICE SCRAPER');
  console.log('======================================');
  console.log(`🌐 Source: ${DSE_URL}`);
  console.log(`📅 Market date: ${getDhakaDate()}`);
  await scrapeDSELatestPrices();
}

if (require.main === module) startScraper().catch(err => {
  console.error('❌ DSE SCRAPER FAILED');
  console.error(err.response?.data || err.message || err);
  process.exit(1);
});

module.exports = { startScraper, scrapeDSELatestPrices, parseRenderedRows };
