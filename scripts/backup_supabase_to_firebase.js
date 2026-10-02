// StockPulse - Supabase -> Firebase Firestore USER/BUSINESS backup
//
// Architecture:
//   Supabase = primary database for all app data + market data.
//   Firebase Firestore = backup/fallback for USER/BUSINESS data only.
//
// IMPORTANT: Stock prices, DSEX history, CSE/DSE market history and stock
// metadata are intentionally NOT backed up to Firebase. They can be scraped
// again from the market source and remain in Supabase as the canonical source.
//
// Run with BACKUP_MODE=daily (default) or BACKUP_MODE=full.

const axios = require('axios');
const https = require('https');
const admin = require('firebase-admin');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://dpdicusxlrdydajkcgev.supabase.co').replace(/\/$/, '');
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FIREBASE_SERVICE_ACCOUNT_KEY = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
const BACKUP_MODE = (process.env.BACKUP_MODE || 'daily').toLowerCase();
const PAGE_SIZE = 1000;
const FIRESTORE_BATCH_SIZE = 400;
const crypto = require('crypto');

if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY environment variable is missing');
if (!FIREBASE_SERVICE_ACCOUNT_KEY) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is missing');
if (!['daily', 'full'].includes(BACKUP_MODE)) throw new Error('BACKUP_MODE must be daily or full');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function firebaseInit() {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_KEY);
  } catch (err) {
    throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON: ${err.message}`);
  }

  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin.firestore();
}

const db = firebaseInit();

const supabaseHeaders = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
};

// ONLY user/business data belongs here.
// Market-price/history tables are deliberately excluded.
const TABLES = [
  { table: 'user_registry', orderField: null, keyField: 'user_id' },
  { table: 'user_meta', orderField: null, keyField: 'user_id' },
  { table: 'subscriptions', orderField: null, keyField: 'user_id' },
  { table: 'portfolios', orderField: null, keyField: 'firebase_id' },
  { table: 'sales_history', orderField: null, keyField: 'id' },
  { table: 'dividend_records', orderField: null, keyField: 'id' },
  { table: 'admin_users', orderField: null, keyField: 'user_id' },
];

function backupCollection(table) {
  return `backup_${table}`;
}

async function fetchPage(table, orderField, offset) {
  const query = new URLSearchParams();
  query.set('select', '*');
  if (orderField) query.set('order', `${orderField}.asc`);
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String(offset));

  const url = `${SUPABASE_URL}/rest/v1/${table}?${query.toString()}`;
  const response = await axios.get(url, {
    headers: supabaseHeaders,
    httpsAgent,
    timeout: 30000,
  });
  return Array.isArray(response.data) ? response.data : [];
}

async function fetchAll(cfg) {
  const rows = [];
  let offset = 0;

  while (true) {
    const page = await fetchPage(cfg.table, cfg.orderField, offset);
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += page.length;
  }

  return rows;
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);
}

function documentId(cfg, row) {
  const value = row[cfg.keyField];
  if (value !== undefined && value !== null && String(value) !== '') {
    return String(value);
  }

  // Some older Supabase user/business rows may not have a populated numeric id.
  // Never stop the entire backup for that reason; build a deterministic fallback
  // from stable business fields. This prevents duplicate docs between runs.
  let fallback;
  if (cfg.table === 'portfolios') {
    fallback = {
      user_id: row.user_id ?? row.userId ?? '',
      firebase_id: row.firebase_id ?? '',
      share_name: row.share_name ?? row.shareName ?? '',
      date: row.date ?? '',
      buy_price: row.buy_price ?? row.buyPrice ?? '',
      quantity: row.quantity ?? ''
    };
  } else if (cfg.table === 'sales_history') {
    fallback = {
      user_id: row.user_id ?? row.userId ?? '',
      firebase_id: row.firebase_id ?? '',
      share_name: row.share_name ?? row.shareName ?? '',
      date: row.date ?? '',
      sell_price: row.sell_price ?? row.sellPrice ?? '',
      quantity_sold: row.quantity_sold ?? row.quantitySold ?? ''
    };
  } else if (cfg.table === 'dividend_records') {
    fallback = {
      user_id: row.user_id ?? '',
      share_name: row.share_name ?? '',
      created_at: row.created_at ?? '',
      stock_percent: row.stock_percent ?? '',
      cash_amount: row.cash_amount ?? ''
    };
  } else {
    fallback = row;
  }

  const hasUsefulValue = Object.values(fallback).some(v => v !== '' && v !== null && v !== undefined);
  if (hasUsefulValue) {
    return `fallback_${cfg.table}_${stableHash(fallback)}`;
  }

  throw new Error(`Cannot determine stable document ID for ${cfg.table}`);
}

function normalizeForFirestore(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== undefined) out[key] = value;
  }
  out._backup_at = admin.firestore.FieldValue.serverTimestamp();
  out._backup_source = 'supabase';
  return out;
}

async function writeRows(collectionName, cfg, rows) {
  if (!rows.length) return 0;

  const writer = db.bulkWriter({ maxOpsPerBatch: FIRESTORE_BATCH_SIZE });
  let completed = 0;

  writer.onWriteError((error) => {
    const retryable = [
      'ABORTED',
      'UNAVAILABLE',
      'DEADLINE_EXCEEDED',
      'RESOURCE_EXHAUSTED',
      'INTERNAL',
    ].includes(error.code);

    if (retryable && error.failedAttempts < 6) {
      console.warn(
        `   Firestore retry ${error.failedAttempts}/5 for ${collectionName} ` +
        `(code=${error.code})`
      );
      return true;
    }
    return false;
  });

  for (const row of rows) {
    const ref = db.collection(collectionName).doc(documentId(cfg, row));
    writer.set(ref, normalizeForFirestore(row)).then(() => {
      completed += 1;
      if (completed % 100 === 0 || completed === rows.length) {
        console.log(`   Firebase ${collectionName}: ${completed}/${rows.length}`);
      }
    });
  }

  await writer.close();
  return completed;
}

async function backupTable(cfg) {
  const rows = await fetchAll(cfg);
  console.log(`📦 ${cfg.table}: ${rows.length} rows selected`);

  const written = await writeRows(backupCollection(cfg.table), cfg, rows);
  console.log(`✅ ${cfg.table}: ${written} backup rows written`);
  return written;
}

async function main() {
  console.log('=====================================================');
  console.log('🔥 STOCKPULSE USER/BUSINESS SUPABASE → FIREBASE BACKUP');
  console.log('=====================================================');
  console.log(`Mode: ${BACKUP_MODE}`);
  console.log('Market price/history backup: DISABLED');
  console.log('User/business backup: ENABLED');
  console.log('');

  let total = 0;
  for (const cfg of TABLES) {
    try {
      total += await backupTable(cfg);
    } catch (err) {
      console.error(`❌ Backup failed for ${cfg.table}: ${err.response?.data || err.message}`);
      throw err;
    }
  }

  console.log('');
  console.log(`🎉 Backup completed. Total user/business rows written: ${total}`);
  console.log('ℹ️ Stock price/history tables were intentionally skipped.');
}

main().catch(err => {
  console.error('❌ SUPABASE → FIREBASE USER/BUSINESS BACKUP FAILED');
  console.error(err.stack || err.message || err);
  process.exit(1);
});
