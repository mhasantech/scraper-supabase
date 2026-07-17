// scripts/migrate_firebase_to_supabase.js
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// 📌 কনফিগারেশন
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';

// 🔥 Service Account JSON (আপনার দেওয়া ফাইল থেকে)
const serviceAccount = {
  type: "service_account",
  project_id: "my-share-market-495aa",
  private_key_id: "0b246ee625121b4107c483bd47b1dbc488762888",
  private_key: `-----BEGIN PRIVATE KEY-----
MIIEuwIBADANBgkqhkiG9w0BAQEFAASCBKUwggShAgEAAoIBAQDL99dmjyWB3pf0
VnU55+883055oX+KG6DQvCONBnn2ohZlZkN9qT4jrACb7taR+k1HBTi1kp68h5wc
dTmuMUl57tTmwmSQvGE8zPgrSvkwxX3v8n9WcQYfcwhvBcSpLKNJzjeYPN7PjUkJ
aFA3mdRusWKHr9T1H7ddS+J9YvOKP/Q91vjGcd0eqbPp2TQGzN9Vumjj0ef7wOAg
DQ4NIEI/veVte7yeO5in647se0n0upkqjjH6feXjB+X6Easfp+9lJdQpsGYQ8aiW
L7zHfPs5uCVt6cnqrV3QGNG8GuQGUNF/HKmNHFC9ix180rd8/t0RTKH3q0001WlT
ymQZwA/pAgMBAAECgf9R55qXlH17QrQonPWpF+As9+VYJYHeWgagMblIG1GrUdGs
f8qaRPV7w/x6oW3uyi3XikE7dT6vQvigdNi0s+LNek2dj6U44AYr/bx22T4EV7A6
qllEw1FLthjgFddJSwngmVTtAFFFbXazg5ZMVxL2+d3KOGrlNwpq0trtGGizgQ+2
B580ZjC8WtdyuwCTmE62IUjWwQFMuKys6NXxruOuj4csXDbXq31o0GMR+6YHpCiP
Otu4dcH1/sPWVfo4LJeX4RV21jAWrTw3n7kUZrQTE8JmRGnHD6JbxnytX3DqPdyf
rzud2d/LBZvhKubg8N6g7qEg+346Ai264b4mRukCgYEA9sT/r80s9Su0gmXJ53/i
1qm0eyCI16NznYTRK8Iaie8ZuoSpF3dSagbMiJAvxGYNgrUfk+ry0kiWn0Nd/hOo
gY+iM+tJSEXO3OQUk1MiuRUKLgKiDDQtamGyo6DfPQGOvwevaseizzARItqx+eMy
KAF3fXukWPSwdCFUMMzoR+MCgYEA05j8zl3S3Sdj0WJC+JZcYJAJ7FibIiQwb+/x
ZaVfSVX+yfQO8NmAwlqjBKgS8hnoYqjCvo7ALHQ1sbby5HE5LKt/8pBIG31HV+m9
rS5Q1l//EKEA/FsrwBU5PenG0CNudOsb69exj2NmjM8C51J4qi41ntqgzGJB1PoH
8vke2sMCgYADY4kvXN31L/h2ofc32qW+1O3JkxTOAUyhKSXGOBAtPL9ZtGCuFdFn
61f7uB8vz0b4OIyKd3uGL8EBxucPii2SOeq8U8rZ1zuUBP3TWBzt9cACCb838697
+oN9g8QNDmxrayuZh8xQlBRoKiCvkdMqgXqmmoATSKjzr1F8qhO2iQKBgQCSzSU3
l2hf/qAF+II2LTtR0xzPWHnoqerg/jsgJieBnaPzQNvMxVnLfU50QJdEWC0dpa/W
vPse3FEURrUlQFhGYYWXJ/qe97+zgnsR13xF/rvbMZiZfDdSQGdCSRqh9LMBcswg
R7jsni3bqxN8oX8NspmI6G1+3vyFYiJ5s9RwOQKBgBEr9oaAvAA3GaNLZ5fo931e
Ou9wCXre9NOlyxoSsmetI7H6X0GrzMrzYak+zruyUpaG3uFst3/lBkfFhQqDO8NK
5mtfxWYf6Ij95iGuV3TJzJLKaN+IuOinM9acZFEy1W2B+2O4Q65Yk5HaVE1dFjOX
E+ub6qQbZmqu5juk4bun
-----END PRIVATE KEY-----\n`,
  client_email: "firebase-adminsdk-fbsvc@my-share-market-495aa.iam.gserviceaccount.com",
  client_id: "104020533171320847131",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: "https://www.googleapis.com/robot/v1/metadata/x509/firebase-adminsdk-fbsvc%40my-share-market-495aa.iam.gserviceaccount.com",
  universe_domain: "googleapis.com"
};

// Supabase Service Key (GitHub Secret থেকে)
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
// ☁️ Supabase Client Init
// ==========================================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { autoConnect: false }
});
console.log('✅ Supabase client initialized');

// ==========================================
// 📊 ট্রান্সফর্ম ফাংশন
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

        let success = 0, errors = 0;
        const batchSize = 50;
        let batch = [];
        let total = snapshot.docs.length;
        let processed = 0;

        for (const doc of snapshot.docs) {
            const data = doc.data();
            const record = transformFn(doc.id, data);
            if (!record) {
                errors++;
                continue;
            }
            batch.push(record);

            if (batch.length >= batchSize) {
                const result = await upsertBatch(supabaseTable, batch);
                success += result.success;
                errors += result.errors;
                processed += batch.length;
                console.log(`📊 ${firebaseCollection}: ${processed}/${total} (${Math.round(processed/total*100)}%)`);
                batch = [];
                await new Promise(r => setTimeout(r, 200));
            }
        }

        if (batch.length > 0) {
            const result = await upsertBatch(supabaseTable, batch);
            success += result.success;
            errors += result.errors;
            console.log(`📊 ${firebaseCollection}: ${total}/${total} (100%)`);
        }

        console.log(`✅ ${firebaseCollection} → ${supabaseTable}: ${success} success, ${errors} errors`);
        return { success, errors };

    } catch (err) {
        console.error(`❌ Error migrating ${firebaseCollection}:`, err.message);
        return { success: 0, errors: 0 };
    }
}

// ==========================================
// 📤 ব্যাচ আপসার্ট
// ==========================================
async function upsertBatch(table, records) {
    try {
        const { error } = await supabase
            .from(table)
            .upsert(records, { onConflict: 'id' });

        if (error) {
            console.error(`❌ Batch upsert error (${table}):`, error.message);
            return { success: 0, errors: records.length };
        }
        return { success: records.length, errors: 0 };
    } catch (err) {
        console.error(`❌ Batch upsert exception (${table}):`, err.message);
        return { success: 0, errors: records.length };
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
