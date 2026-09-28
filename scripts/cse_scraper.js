// scripts/cse_scraper.js
// StockPulse - CSE current market scraper
// CSE current-price page remains server-rendered, so use the official page
// and parse its table instead of the old company-list assumptions.
const axios = require('axios');
const cheerio = require('cheerio');
const { httpsAgent, getDhakaDate, cleanText, numberFrom, normalizeHeader, upsert } = require('./lib/common');

const CSE_LIST_URL = 'https://www.cse.com.bd/market/current_price';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

async function fetchHtml(url) {
  const response = await axios.get(url, {
    httpsAgent,
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    timeout: 30000,
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: s => s >= 200 && s < 400
  });
  return response.data;
}

function parseCurrentPrice(html) {
  const $ = cheerio.load(html);
  const date = getDhakaDate();
  const records = [];

  $('table').each((_, table) => {
    let headers = [];
    const first = $(table).find('tr').first();
    first.find('th,td').each((_, cell) => headers.push(normalizeHeader($(cell).text())));

    const codeIdx = headers.findIndex(x => x === 'stockcode' || x === 'code');
    const ltpIdx = headers.indexOf('ltp');
    const highIdx = headers.indexOf('high');
    const lowIdx = headers.indexOf('low');
    const ycpIdx = headers.indexOf('ycp');
    const tradeIdx = headers.indexOf('trade');
    const valueIdx = headers.findIndex(x => x === 'valuemn' || x === 'value');
    const volumeIdx = headers.indexOf('volume');

    if (codeIdx < 0 || ltpIdx < 0 || highIdx < 0 || lowIdx < 0 || ycpIdx < 0) return;

    $(table).find('tr').slice(1).each((_, tr) => {
      const cells = $(tr).find('td').toArray().map(td => cleanText($(td).text()));
      if (!cells.length) return;
      const code = cleanText(cells[codeIdx]);
      const ltp = numberFrom(cells[ltpIdx]);
      if (!code || ltp === null) return;
      const ycp = numberFrom(cells[ycpIdx]);
      const change = ycp !== null ? ltp - ycp : 0;
      const pct = ycp ? (change / ycp) * 100 : 0;
      records.push({
        code, date, ltp,
        high: numberFrom(cells[highIdx]),
        low: numberFrom(cells[lowIdx]),
        category: null,
        eps: null,
        pe_ratio: null,
        dividend: null,
        record_date: null,
        updated_at: new Date().toISOString(),
        _trade: tradeIdx >= 0 ? numberFrom(cells[tradeIdx]) : null,
        _value: valueIdx >= 0 ? numberFrom(cells[valueIdx]) : null,
        _volume: volumeIdx >= 0 ? numberFrom(cells[volumeIdx]) : null,
        _change: Number(change.toFixed(5)),
        _change_percent: Number(pct.toFixed(5))
      });
    });
  });

  return [...new Map(records.map(r => [r.code, r])).values()];
}

async function getCompanyDetails(code) {
  const url = `https://www.cse.com.bd/index.php?/company/companydetails/${encodeURIComponent(code)}`;
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const info = {};
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td').toArray().map(td => cleanText($(td).text()));
      for (let i = 0; i < cells.length - 1; i++) {
        const label = cells[i].toLowerCase();
        const value = cells[i + 1];
        if (label.includes('market category')) info.category = value;
        else if (label.includes('hy eps') || label === 'eps') info.eps = value;
        else if (label.includes('dividend(%)')) info.dividend = value;
        else if (label.includes('record date')) info.record_date = value;
      }
    });
    return info;
  } catch (_) {
    return {};
  }
}

async function startScraper() {
  console.log('======================================');
  console.log('📈 CSE MARKET SCRAPER');
  console.log('======================================');
  console.log(`🌐 Source: ${CSE_LIST_URL}`);
  console.log(`📅 Market date: ${getDhakaDate()}`);

  const html = await fetchHtml(CSE_LIST_URL);
  const market = parseCurrentPrice(html);
  console.log(`📊 CSE market rows: ${market.length}`);

  if (market.length < 50) {
    throw new Error(`CSE current-price page returned only ${market.length} usable rows; refusing to save partial data.`);
  }

  // Details are fetched with limited concurrency so the CSE server is not hammered.
  const concurrency = 8;
  let saved = 0;
  for (let i = 0; i < market.length; i += concurrency) {
    const chunk = market.slice(i, i + concurrency);
    const enriched = await Promise.all(chunk.map(async r => {
      const d = await getCompanyDetails(r.code);
      const eps = numberFrom(d.eps);
      const pe = eps && eps !== 0 ? Number((r.ltp / eps).toFixed(2)) : null;
      return {
        code: r.code, date: r.date, ltp: r.ltp, high: r.high, low: r.low,
        category: d.category ?? null,
        eps: d.eps ?? null,
        pe_ratio: pe,
        dividend: d.dividend ?? null,
        record_date: d.record_date ?? null,
        updated_at: r.updated_at
      };
    }));
    for (const row of enriched) {
      if (await upsert('cse_market_data', row, 'code,date')) saved++;
    }
    await new Promise(r => setTimeout(r, 300));
    console.log(`📦 CSE progress: ${Math.min(i + chunk.length, market.length)}/${market.length}`);
  }

  console.log(`🎉 CSE scraper completed: ${saved}/${market.length}`);
}

if (require.main === module) startScraper().catch(err => {
  console.error('❌ CSE SCRAPER FAILED');
  console.error(err.response?.data || err.message || err);
  process.exit(1);
});

module.exports = { startScraper, parseCurrentPrice };
