// Optional one-time cleanup of the old market-data backup collections.
// Run ONLY if you no longer need the old Firebase market-data copies.
// This reduces Firestore stored data and removes unnecessary old price backups.

const admin = require('firebase-admin');

const FIREBASE_SERVICE_ACCOUNT_KEY = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
if (!FIREBASE_SERVICE_ACCOUNT_KEY) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY environment variable is missing');

let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_KEY);
} catch (err) {
  throw new Error(`FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON: ${err.message}`);
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const LEGACY_COLLECTIONS = [
  'backup_dse_live_data',
  'backup_daily_closing_prices',
  'backup_cse_market_data',
  'backup_market_summary',
  'backup_dsex_index',
  'backup_stock_metadata',
  'backup_history_dse',
];

async function deleteCollection(collectionName) {
  let deleted = 0;
  while (true) {
    const snapshot = await db.collection(collectionName).limit(400).get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    deleted += snapshot.size;
    console.log(`🗑️ ${collectionName}: ${deleted} deleted`);
  }
  return deleted;
}

async function main() {
  console.log('⚠️ Removing legacy market-data backup collections...');
  let total = 0;
  for (const collection of LEGACY_COLLECTIONS) {
    total += await deleteCollection(collection);
  }
  console.log(`✅ Cleanup complete. Total legacy market documents deleted: ${total}`);
}

main().catch(err => {
  console.error('❌ Legacy cleanup failed:', err.stack || err.message || err);
  process.exit(1);
});
