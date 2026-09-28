// scripts/dse_company_scraper.js
// Backward-compatible entry point kept for StockPulse/Pipedream/manual callers.
// The old script was actually a duplicate DSE market-summary parser using the
// retired dsebd.org HTML. It now delegates to the current DSE latest-price scraper.
const { startScraper, scrapeDSELatestPrices } = require('./dse_scraper');

if (require.main === module) {
  startScraper().catch(err => {
    console.error('❌ DSE COMPANY/PRICE SCRAPER FAILED');
    console.error(err.response?.data || err.message || err);
    process.exit(1);
  });
}

module.exports = { startScraper, scrapeDSELatestPrices };
