/**
 * DSE Market Summary Scraper
 *
 * Standalone scraper.
 * Existing scrapers are NOT modified.
 */

const axios = require("axios");
const cheerio = require("cheerio");
const https = require("https");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const DSE_URL = "https://www.dsebd.org/";

if (!SUPABASE_URL) {
  throw new Error("❌ SUPABASE_URL environment variable is missing");
}

if (!SUPABASE_SERVICE_KEY) {
  throw new Error("❌ SUPABASE_SERVICE_KEY environment variable is missing");
}

// DSE's SSL certificate chain may not verify correctly
// from GitHub Actions. This agent is used ONLY for DSE.
const dseHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberFromText(value) {
  if (value === null || value === undefined) return null;

  const text = String(value)
    .replace(/,/g, "")
    .replace(/%/g, "")
    .trim();

  const match = text.match(/-?\d+(?:\.\d+)?/);

  if (!match) return null;

  const number = Number(match[0]);

  return Number.isFinite(number) ? number : null;
}

function normalizeLabel(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[:：]/g, "")
    .replace(/\s+/g, " ");
}

function isValidDsex(value) {
  return (
    value !== null &&
    Number.isFinite(value) &&
    value >= 1000 &&
    value <= 10000
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// --------------------------------------------------
// Scrape DSE
// --------------------------------------------------

async function scrapeDSE() {
  console.log(`📡 Scraping: ${DSE_URL}`);

  const response = await axios.get(DSE_URL, {
    timeout: 30000,

    // Fix DSE SSL certificate verification problem
    httpsAgent: dseHttpsAgent,

    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",

      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",

      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  const $ = cheerio.load(response.data);

  const rows = [];

  $("tr").each((_, tr) => {
    const cells = [];

    $(tr)
      .find("th, td")
      .each((_, cell) => {
        const text = cleanText($(cell).text());

        if (text) {
          cells.push(text);
        }
      });

    if (cells.length > 0) {
      rows.push(cells);
    }
  });

  console.log(`📊 Found ${rows.length} table rows`);

  return rows;
}

// --------------------------------------------------
// Find values
// --------------------------------------------------

function findValue(rows, labels) {
  const normalizedLabels = labels.map(normalizeLabel);

  for (const row of rows) {
    const normalizedRow = row.map(normalizeLabel);

    for (let i = 0; i < normalizedRow.length; i++) {
      if (!normalizedLabels.includes(normalizedRow[i])) {
        continue;
      }

      if (row[i + 1]) {
        const value = numberFromText(row[i + 1]);

        if (value !== null) {
          return value;
        }
      }
    }
  }

  return null;
}

// --------------------------------------------------
// Find DSEX
// --------------------------------------------------

function findDSEX(rows) {
  const candidates = [];

  for (const row of rows) {
    const rowText = row.join(" ");

    if (!/\bDSEX\b/i.test(rowText)) {
      continue;
    }

    for (const cell of row) {
      const value = numberFromText(cell);

      if (isValidDsex(value)) {
        candidates.push(value);
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  return candidates[0];
}

// --------------------------------------------------
// Build summary
// --------------------------------------------------

function buildMarketSummary(rows) {
  const dsex = findDSEX(rows);

  let previousClose = findValue(rows, [
    "Previous Close",
    "Prev. Close",
    "Prev Close",
  ]);

  let change = findValue(rows, [
    "Change",
    "DSEX Change",
    "Index Change",
    "Change (Point)",
  ]);

  let changePercent = findValue(rows, [
    "Change %",
    "Change%",
    "Change Percent",
    "% Change",
    "Percentage Change",
  ]);

  const totalTrades = findValue(rows, [
    "Total Trades",
    "Total Trade",
    "Trades",
    "Trade",
  ]);

  const totalVolume = findValue(rows, [
    "Total Volume",
    "Volume",
  ]);

  const totalValue = findValue(rows, [
    "Total Value",
    "Value",
    "Turnover",
  ]);

  const advanced = findValue(rows, [
    "Advanced",
    "Advancing",
    "Advance",
    "Gainers",
  ]);

  const declined = findValue(rows, [
    "Declined",
    "Declining",
    "Decline",
    "Losers",
  ]);

  const unchanged = findValue(rows, [
    "Unchanged",
    "Unchange",
  ]);

  // ------------------------------------------------
  // Calculate change from DSEX + previous close
  // ------------------------------------------------

  if (
    dsex !== null &&
    previousClose !== null &&
    previousClose > 0
  ) {
    const calculatedChange = dsex - previousClose;

    if (
      change === null ||
      Math.abs(change) > dsex * 0.25
    ) {
      change = calculatedChange;
    }

    if (
      changePercent === null ||
      Math.abs(changePercent) > 25
    ) {
      changePercent =
        (calculatedChange / previousClose) * 100;
    }
  }

  // ------------------------------------------------
  // Market status
  // ------------------------------------------------

  let marketStatus = "FLAT";

  if (change !== null) {
    if (change > 0) {
      marketStatus = "BULLISH";
    } else if (change < 0) {
      marketStatus = "BEARISH";
    }
  }

  return {
    market_date: todayISO(),

    dsex:
      dsex !== null
        ? Number(dsex.toFixed(5))
        : null,

    previous_close:
      previousClose !== null
        ? Number(previousClose.toFixed(5))
        : null,

    change:
      change !== null
        ? Number(change.toFixed(5))
        : null,

    change_percent:
      changePercent !== null
        ? Number(changePercent.toFixed(5))
        : null,

    total_trades:
      totalTrades !== null
        ? Math.round(totalTrades)
        : null,

    total_volume:
      totalVolume !== null
        ? totalVolume
        : null,

    total_value:
      totalValue !== null
        ? totalValue
        : null,

    advanced:
      advanced !== null
        ? Math.round(advanced)
        : null,

    declined:
      declined !== null
        ? Math.round(declined)
        : null,

    unchanged:
      unchanged !== null
        ? Math.round(unchanged)
        : null,

    market_status: marketStatus,

    scraped_at: new Date().toISOString(),
  };
}

// --------------------------------------------------
// Save to Supabase
// --------------------------------------------------

async function saveToSupabase(data) {
  const endpoint = `${SUPABASE_URL}/rest/v1/market_summary`;

  console.log("💾 Saving to Supabase...");

  const response = await axios.post(
    endpoint,
    data,
    {
      timeout: 30000,

      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
    }
  );

  return response.data;
}

// --------------------------------------------------
// Main
// --------------------------------------------------

async function main() {
  try {
    console.log("");
    console.log("======================================");
    console.log("📈 DSE MARKET SUMMARY SCRAPER");
    console.log("======================================");
    console.log(`🕐 ${new Date().toISOString()}`);
    console.log("");

    const rows = await scrapeDSE();

    const summary = buildMarketSummary(rows);

    console.log("");
    console.log("📊 MARKET SUMMARY");
    console.log("--------------------------------------");
    console.log(JSON.stringify(summary, null, 2));
    console.log("--------------------------------------");
    console.log("");

    if (summary.dsex === null) {
      throw new Error(
        "❌ DSEX value could not be detected. Data was NOT saved."
      );
    }

    await saveToSupabase(summary);

    console.log("✅ Market summary saved successfully.");
    console.log("");
  } catch (error) {
    console.error("");
    console.error("❌ MARKET SUMMARY SCRAPER FAILED");
    console.error("--------------------------------------");

    if (error.response) {
      console.error(
        `HTTP ${error.response.status}:`,
        error.response.data
      );
    } else {
      console.error(error.message);
    }

    console.error("--------------------------------------");
    console.error("");

    process.exit(1);
  }
}

main();
