// scripts/lib/tickers.js
// Shared helpers for building ticker lists from Supabase without downloading whole history tables.
const { axios, httpsAgent, SUPABASE_URL, supabaseHeaders, retry } = require('./common');

// Government securities (treasury bonds / bills) share the DSE price table with equities but have no
// company page, EPS or dividend history. Mirrors the filter in the app's core.js.
// Heuristic: it only removes clearly recognisable government-security codes (e.g. TB5Y1130, T10Y0128,
// BGTB...). Mutual funds, debentures and other listed instruments are intentionally kept.
const NON_EQUITY_CODE = /^(?:T(?:B)?\d{1,2}Y\d{3,4}|BGTB.*)$/i;
function isLikelyNonEquityCode(code) {
  return NON_EQUITY_CODE.test(String(code || '').trim());
}

const restBase = table => `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`;

async function getLatestDate(table) {
  const url = `${restBase(table)}?select=date&order=date.desc&limit=1`;
  const { data } = await retry(() => axios.get(url, { headers: supabaseHeaders(), httpsAgent, timeout: 30000 }), `Latest date of ${table}`);
  return data && data[0] ? data[0].date : null;
}

// Distinct values of `column`.
//  - default: only rows of the table's latest `date` (one day = about one row per ticker, cheap even
//    when the table holds years of history);
//  - allRows=true (or table without a date column): every row, paginated.
async function fetchDistinctColumn(table, column, { allRows = false, dated = true } = {}) {
  const values = new Set();
  let filter = '';
  if (dated && !allRows) {
    const latest = await getLatestDate(table);
    if (!latest) return values;
    filter = `&date=eq.${encodeURIComponent(latest)}`;
  }
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const url = `${restBase(table)}?select=${encodeURIComponent(column)}${filter}&order=${encodeURIComponent(column)}.asc&limit=${pageSize}&offset=${offset}`;
    const { data } = await retry(() => axios.get(url, { headers: supabaseHeaders(), httpsAgent, timeout: 30000 }), `Fetch ${table}.${column} offset ${offset}`);
    for (const row of data || []) {
      const v = String(row[column] ?? '').trim().toUpperCase();
      if (v) values.add(v);
    }
    if (!data || data.length < pageSize) break;
  }
  return values;
}

module.exports = { isLikelyNonEquityCode, getLatestDate, fetchDistinctColumn };
