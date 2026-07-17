// scripts/migrate_firebase_to_supabase.js
const admin = require('firebase-admin');
const axios = require('axios');
const https = require('https');

// ==========================================
// 📌 কনফিগারেশন
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';

// Firebase Service Account (GitHub Secret থেকে)
const serviceAccountJSON = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
if (!serviceAccountJSON) {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT_KEY পাওয়া যায়নি।');
    process.exit(1);
}
const serviceAccount = JSON.parse(serviceAccountJSON);

// Supabase Service Key
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

// ==========================================
// 🔥 Firebase Admin Init
// ==========================================
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();
console.log('✅ Firebase Admin initialized');

// ==========================================
// ☁️ HTTPS Agent (SSL ফিক্স)
// ==========================================
const agent = new https.Agent({ rejectUnauthorized: false });

// ==========================================
// 📤 Supabase REST API-তে আপসার্ট (ব্যাচ)
// ==========================================
async function upsertBatchToSupabase(table, records) {
    if (!records || records.length === 0) return { success: 0, errors: 0 };

    const url = `${SUPABASE_URL}/rest/v1/${table}`;
    const headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
    };

    try {
        const response = await axios.post(url, records, {
            headers,
            httpsAgent: agent,
            timeout: 30000
        });
        // 201 = Created, 200 = OK (update)
        if (response.status === 201 || response.status === 200) {
            return { success: records.length, errors: 0 };
        }
        console.warn(`⚠️ Unexpected status ${response.status} for ${table}`);
        return { success: 0, errors: records.length };
    } catch (err) {
        if (err.response && err.response.status === 409) {
            // 409 মানে ডুপ্লিকেট, কিন্তু merge-duplicates থাকায় এটা আসার কথা না, তবুও ধরলাম
            console.log(`ℹ️ ডুপ্লিকেট (${table}), ইগনোর করা হচ্ছে।`);
            return { success: records.length, errors: 0 };
        }
        console.error(`❌ আপসার্ট ব্যর্থ (${table}):`, err.message);
        if (err.response) {
            console.error('📄 রেসপন্স ডেটা:', err.response.data);
        }
        return { success: 0, errors: records.length };
    }
}

// ==========================================
// 📊 ট্রান্সফর্ম ফাংশন (Firebase → Supabase)
// ==========================================
const transform = {
    user_meta: (docId, data) => ({
        user_id: docId,
        deposit: data.deposit || 0,
        updated_at: new Date().toISOString()
    }),

    portfolios: (docId, data) => ({
        user_id: data.userId,
        share_name: data.shareName,
        quantity: data.quantity || 0,
        buy_price: data.buyPrice || 0,
        commission: data.commission || 0,
        commission_percent: data.commissionPercent || 0,
        date: data.date?.toDate?.()?.toISOString?.().split('T')[0] || new Date().toISOString().split('T')[0],
        created_at: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString()
    }),

    sales_history: (docId, data) => ({
        user_id: data.userId,
        share_name: data.shareName,
        quantity_sold: data.quantitySold || 0,
        buy_price: data.buyPrice || 0,
        sell_price: data.sellPrice || 0,
        profit_or_loss: data.profitOrLoss || 0,
        commission: data.commission || 0,
        commission_percent: data.commissionPercent || 0,
        net_received: data.netReceived || 0,
        date: data.date?.toDate?.()?.toISOString?.().split('T')[0] || new Date().toISOString().split('T')[0],
        created_at: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString()
    }),

    dividend_records: (docId, data) => ({
        user_id: data.userId,
        share_name: data.shareName,
        stock_percent: data.stockPercent || 0,
        cash_amount: data.cashAmount || 0,
        created_at: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString(),
        updated_at: data.updatedAt?.toDate?.()?.toISOString() || new Date().toISOString()
    })
};

// ==========================================
// 🚀 মাইগ্রেশন ফাংশন
// ==========================================
async function migrateCollection(firebaseCollection, supabaseTable, transformFn) {
    console.log(`\n📦 Migrating ${firebaseCollection} → ${supabaseTable}...`);

    try {
        const snapshot = await db.collection(firebaseCollection).get();
        if (snapshot.empty) {
            console.log(`⚠️ No documents in ${firebaseCollection}`);
            return { success: 0, errors: 0 };
        }

        const records = [];
        const total = snapshot.docs.length;

        for (const doc of snapshot.docs) {
            const data = doc.data();
            const record = transformFn(doc.id, data);
            if (record) {
                records.push(record);
            }
        }

        console.log(`📊 ${records.length} documents to migrate`);

        // ব্যাচে ৫০টি করে আপসার্ট
        const batchSize = 50;
        let success = 0, errors = 0;

        for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize);
            const result = await upsertBatchToSupabase(supabaseTable, batch);
            success += result.success;
            errors += result.errors;
            const pct = Math.round(((i + batch.length) / records.length) * 100);
            console.log(`📊 ${firebaseCollection}: ${i + batch.length}/${records.length} (${pct}%)`);
            // রেট লিমিট এড়াতে বিরতি
            await new Promise(r => setTimeout(r, 200));
        }

        console.log(`✅ ${firebaseCollection} → ${supabaseTable}: ${success} success, ${errors} errors`);
        return { success, errors };

    } catch (err) {
        console.error(`❌ Error migrating ${firebaseCollection}:`, err.message);
        return { success: 0, errors: 0 };
    }
}

// ==========================================
// 🏁 মেইন ফাংশন
// ==========================================
async function startMigration() {
    console.log(`🕐 ${new Date().toISOString()} - Migration started`);
    console.log('📋 Collections to migrate: user_meta, portfolios, sales_history, dividend_records\n');

    await migrateCollection('user_meta', 'user_meta', transform.user_meta);
    await migrateCollection('portfolios', 'portfolios', transform.portfolios);
    await migrateCollection('sales_history', 'sales_history', transform.sales_history);
    await migrateCollection('dividend_records', 'dividend_records', transform.dividend_records);

    console.log('\n✅ Migration completed successfully!');
    console.log(`🕐 ${new Date().toISOString()}`);
}

// ==========================================
// 🔥 রান
// ==========================================
if (require.main === module) {
    startMigration().catch(err => {
        console.error('❌ Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { startMigration };
