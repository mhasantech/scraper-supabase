# StockPulse Market Scrapers

This package contains the production scraper set used by StockPulse.

## Current sources
- DSE prices: `https://dse.com.bd/markets/latest-share-price`
- DSE indices: `https://dse.com.bd/markets`
- DSE market summary: `https://dse.com.bd/markets`
- CSE prices: `https://www.cse.com.bd/market/current_price`

The retired `dsebd.org` HTML endpoints are no longer used by the DSE price/index/summary scrapers.

## Manual run
`npm run manual-scrape`

This runs CSE + DSE prices + DSEX/DS30/DSES in sequence. The individual commands remain available:
- `npm run cse`
- `npm run dse`
- `npm run dsex`
- `npm run market-summary`

The existing Supabase table names and core record shapes are preserved so the StockPulse app can continue reading the same data.

Note: Pipedream configuration is not present in this repository, so no Pipedream URL or authentication contract was invented. The individual scripts and `manual_scrape.js` are kept as stable command entry points for an existing Pipedream workflow.
