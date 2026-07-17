// scripts/migrate_firebase_to_supabase.js
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

// Firebase Admin (আপনার সার্ভিস অ্যাকাউন্ট JSON)
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// Supabase
const supabase = createClient(
    'https://dpdicusxlrdydajkcgev.supabase.co',
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
);

async function migrateCollection(firebaseCollection, supabaseTable, transformFn) {
    console.log(`🔄 Migrating ${firebaseCollection} -> ${supabaseTable}...`);
    const snapshot = await db.collection(firebaseCollection).get();
    if (snapshot.empty) { console.log(`⚠️ No data in ${firebaseCollection}`); return; }

    let count = 0;
    for (const doc of snapshot.docs) {
        const data = doc.data();
        const record = transformFn(doc.id, data);
        if (!record) continue;
        const { error } = await supabase.from(supabaseTable).upsert(record, { onConflict: 'id' });
        if (error) console.error(`❌ ${doc.id} error:`, error.message);
        else count++;
    }
    console.log(`✅ ${count} records migrated to ${supabaseTable}`);
}

// ট্রান্সফর্ম ফাংশন (Firebase ফিল্ড → Supabase ফিল্ড)
const transform = {
    user_meta: (id, data) => ({ user_id: id, deposit: data.deposit || 0 }),
    portfolios: (id, data) => ({
        user_id: data.userId,
        share_name: data.shareName,
        quantity: data.quantity,
        buy_price: data.buyPrice,
        commission: data.commission || 0,
        commission_percent: data.commissionPercent || 0,
        date: data.date?.toDate?.()?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0]
    }),
    sales_history: (id, data) => ({
        user_id: data.userId,
        share_name: data.shareName,
        quantity_sold: data.quantitySold,
        buy_price: data.buyPrice,
        sell_price: data.sellPrice,
        profit_or_loss: data.profitOrLoss,
        commission: data.commission || 0,
        net_received: data.netReceived || 0,
        date: data.date?.toDate?.()?.toISOString().split('T')[0] || new Date().toISOString().split('T')[0]
    }),
    dividend_records: (id, data) => ({
        user_id: data.userId,
        share_name: data.shareName,
        stock_percent: data.stockPercent || 0,
        cash_amount: data.cashAmount || 0
    })
};

async function start() {
    await migrateCollection('user_meta', 'user_meta', transform.user_meta);
    await migrateCollection('portfolios', 'portfolios', transform.portfolios);
    await migrateCollection('sales_history', 'sales_history', transform.sales_history);
    await migrateCollection('dividend_records', 'dividend_records', transform.dividend_records);
    console.log('🎉 Migration complete!');
}
start();
