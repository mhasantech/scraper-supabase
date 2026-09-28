// scripts/manual_scrape.js
// One-command manual scrape for StockPulse / Pipedream.
// Runs CSE + DSE prices + DSEX/DS30/DSES sequentially.
const { startScraper: cse } = require('./cse_scraper');
const { startScraper: dse } = require('./dse_scraper');
const { startScraper: dsex } = require('./dsex_scraper');

async function main() {
  console.log('======================================');
  console.log('🚀 STOCKPULSE MANUAL MARKET SCRAPE');
  console.log('======================================');

  const jobs = [
    ['CSE', cse],
    ['DSE', dse],
    ['DSEX', dsex]
  ];

  const results = {};
  for (const [name, fn] of jobs) {
    const started = Date.now();
    console.log(`\n▶️ ${name} scrape started`);
    try {
      await fn();
      results[name] = 'success';
      console.log(`✅ ${name} scrape completed in ${((Date.now()-started)/1000).toFixed(1)}s`);
    } catch (err) {
      results[name] = 'failed';
      console.error(`❌ ${name} scrape failed:`, err.response?.data || err.message || err);
    }
  }

  console.log('\n📋 MANUAL SCRAPE RESULT');
  console.log(JSON.stringify(results, null, 2));

  if (Object.values(results).some(v => v === 'failed')) {
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main };
