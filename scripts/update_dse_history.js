// scripts/update_dse_history.js
// StockPulse - DSE historical updater
//
// The old implementation depended on bd-stock-api-an3n.vercel.app and that
// endpoint was returning HTTP 500 for many tickers.  This version uses the
// maintained bdshare DSE historical scraper through a small Python helper,
// then writes the normalized rows into Supabase history_dse.

const axios = require('axios');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
  process.exit(1);
}
if (!SUPABASE_URL) {
  console.error('❌ SUPABASE_URL পাওয়া যায়নি।');
  process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });

function getBangladeshDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function getBangladeshTime() {
  return new Date().toISOString();
}

function subtractDays(dateString, days) {
  const d = new Date(`${dateString}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function getLastDate() {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/history_dse?select=date&order=date.desc&limit=1`;
  try {
    const res = await axios.get(url, {
      headers: supabaseHeaders(),
      httpsAgent: agent,
      timeout: 15000
    });
    if (Array.isArray(res.data) && res.data.length) {
      console.log(`📅 history_dse সর্বশেষ তারিখ: ${res.data[0].date}`);
      return res.data[0].date;
    }
  } catch (err) {
    console.warn(`⚠️ history_dse শেষ তারিখ পড়া যায়নি: ${err.message}`);
  }
  return null;
}

function runPythonFetcher(startDate, endDate, outputFile) {
  const script = path.join(__dirname, 'dse_history_fetch.py');
  if (!fs.existsSync(script)) {
    throw new Error(`Missing Python helper: ${script}`);
  }

  // GitHub Actions uses Ubuntu and python3. Local/manual runs can override it.
  const pythonBin = process.env.PYTHON_BIN || 'python3';
  console.log(`🐍 Running ${pythonBin} scripts/dse_history_fetch.py ${startDate} ${endDate}`);

  execFileSync(pythonBin, [script, startDate, endDate, outputFile], {
    stdio: 'inherit',
    timeout: 50 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    env: process.env,
  });
}

async function batchUpsert(records) {
  if (!records.length) return 0;

  const table = 'history_dse';
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?on_conflict=ticker,date`;

  const response = await axios.post(url, records, {
    headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    httpsAgent: agent,
    timeout: 60000
  });

  if (![200, 201, 202, 204].includes(response.status)) {
    throw new Error(`Supabase history upsert returned HTTP ${response.status}`);
  }
  return records.length;
}

async function saveNdjson(outputFile) {
  const stream = fs.createReadStream(outputFile, { encoding: 'utf8' });
  let buffer = '';
  let batch = [];
  let total = 0;
  let lastLog = 0;

  const flush = async () => {
    if (!batch.length) return;
    const current = batch;
    batch = [];
    const saved = await batchUpsert(current);
    total += saved;
    if (total - lastLog >= 1000) {
      console.log(`💾 Supabase history saved: ${total} rows`);
      lastLog = total;
    }
  };

  for await (const chunk of stream) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      batch.push(JSON.parse(line));
      if (batch.length >= 500) await flush();
    }
  }

  if (buffer.trim()) {
    batch.push(JSON.parse(buffer));
  }
  await flush();

  return total;
}

async function updateDSEHistory() {
  console.log('======================================');
  console.log('📚 STOCKPULSE DSE HISTORY UPDATER');
  console.log('======================================');
  console.log(`🕐 ${getBangladeshTime()}`);

  const today = getBangladeshDate();
  const lastDate = await getLastDate();

  let startDate;
  if (!lastDate) {
    const twoYearsAgo = subtractDays(today, 730);
    startDate = twoYearsAgo;
    console.log(`🆕 history_dse খালি: ${startDate} → ${today}`);
  } else {
    // Re-fetch a small recent window instead of only lastDate+1. This repairs
    // partial/missing ticker rows from previous runs and handles corrections.
    startDate = subtractDays(lastDate, 7);
    console.log(`🔄 recent refresh window: ${startDate} → ${today}`);
  }

  const outputFile = path.join(os.tmpdir(), `stockpulse-dse-history-${process.pid}.ndjson`);

  try {
    runPythonFetcher(startDate, today, outputFile);

    const stats = fs.statSync(outputFile);
    if (stats.size < 10) {
      throw new Error('Historical fetch produced an empty NDJSON file.');
    }

    const saved = await saveNdjson(outputFile);
    if (saved <= 0) {
      throw new Error('No historical rows were saved to Supabase.');
    }

    console.log(`✅ DSE history update completed: ${saved} rows upserted.`);
    console.log(`📅 Window: ${startDate} → ${today}`);
    console.log('ℹ️ Source dependency changed: bd-stock-api removed; bdshare/DSE archive used.');
  } finally {
    try { fs.unlinkSync(outputFile); } catch (_) {}
  }
}

updateDSEHistory().catch(err => {
  console.error('❌ DSE HISTORY UPDATE FAILED');
  console.error(err.response?.data || err.stack || err.message || err);
  process.exit(1);
});
