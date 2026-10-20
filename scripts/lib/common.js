// scripts/lib/common.js
const axios = require('axios');
const https = require('https');
const { execFileSync } = require('child_process');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_SERVICE_KEY environment variable is missing');
}

// Keep TLS certificate verification enabled in production.
const httpsAgent = new https.Agent({ rejectUnauthorized: true });

const browserCandidates = [
  process.env.CHROME_BIN,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

function getDhakaDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberFrom(value) {
  if (value === null || value === undefined || value === '') return null;
  const m = String(value).replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function normalizeHeader(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function condition(change) {
  if (change > 0) return 'BULLISH';
  if (change < 0) return 'BEARISH';
  return 'FLAT';
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function retry(operation, label = 'operation', attempts = 3, baseDelayMs = 1200) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await operation(); }
    catch (err) {
      lastError = err;
      const status = err.response?.status;
      // Retry transient network/server/rate-limit failures only. Do not hide schema/auth errors.
      const retryable = !status || status === 408 || status === 425 || status === 429 || status >= 500;
      if (!retryable || attempt === attempts) break;
      const delay = baseDelayMs * attempt;
      console.warn(`⚠️ ${label} attempt ${attempt}/${attempts} failed (${err.code || status || err.message}); retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function upsert(table, record, conflictColumns) {
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictColumns)}`;
  return retry(async () => {
    const response = await axios.post(url, record, {
      headers: supabaseHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
      httpsAgent,
      timeout: 45000
    });
    if (![200, 201, 202, 204].includes(response.status)) throw new Error(`Supabase ${table} upsert returned HTTP ${response.status}`);
    return true;
  }, `Supabase upsert ${table}`);
}


async function updateOrInsertByDate(table, dateField, date, record) {
  const base = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`;
  const q = `${base}?${encodeURIComponent(dateField)}=eq.${encodeURIComponent(date)}&select=id`;
  const existing = await axios.get(q, { headers: supabaseHeaders(), httpsAgent, timeout: 15000 });
  if (existing.data?.length) {
    await axios.patch(`${base}?${encodeURIComponent(dateField)}=eq.${encodeURIComponent(date)}`, record, {
      headers: supabaseHeaders({ Prefer: 'return=minimal' }),
      httpsAgent, timeout: 30000
    });
    return 'updated';
  }
  await axios.post(base, record, {
    headers: supabaseHeaders({ Prefer: 'return=minimal' }),
    httpsAgent, timeout: 30000
  });
  return 'inserted';
}

function findBrowser() {
  for (const bin of browserCandidates) {
    try {
      execFileSync(bin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
      return bin;
    } catch (_) {}
  }
  return null;
}

function renderPage(url, virtualTimeBudget = 15000) {
  const browser = findBrowser();
  if (!browser) throw new Error('Chromium/Google Chrome was not found on the runner.');
  console.log(`🌐 Rendering: ${url}`);
  const args = [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--disable-software-rasterizer',
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1440,2400',
    `--virtual-time-budget=${virtualTimeBudget}`,
    '--run-all-compositor-stages-before-draw',
    '--dump-dom', url
  ];
  const html = execFileSync(browser, args, {
    encoding: 'utf8', timeout: 120000, maxBuffer: 50 * 1024 * 1024
  });
  if (!html || html.length < 1000) throw new Error('Rendered page is empty/too small.');
  return html;
}

module.exports = {
  axios, httpsAgent, SUPABASE_URL, SUPABASE_SERVICE_KEY,
  getDhakaDate, cleanText, numberFrom, normalizeHeader, condition,
  supabaseHeaders, upsert, retry, updateOrInsertByDate, findBrowser, renderPage
};
