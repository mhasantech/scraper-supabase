// scripts/fill_missing_portfolios.js
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FIREBASE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

if (!SUPABASE_SERVICE_KEY || !FIREBASE_ACCOUNT) {
    console.error('❌ Missing environment variables');
    process.exit(1);
}

const serviceAccount = JSON.parse(FIREBASE_ACCOUNT);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { autoConnect: false }
});

const agent = new https.Agent({ rejectUnauthorized: false });

async function upsertToSupabase(table, record) {
    const url = `${SUPABASE_URL}/rest/v1/${table}`;
    const headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
    };
    try {
        const response = await axios.post(url, record, {
            headers,
            httpsAgent: agent,
            timeout: 15000
        });
        return response.status === 201 || response.status === 200;
    } catch (err) {
        if (err.response?.status === 409) return true; // ডুপ্লিকেট ইগনোর
        console.error(`❌ আপসার্ট ব্যর্থ:`, err.message);
        return false;
    }
}

async function fillMissing() {
    const userId = 'DEdpyCbT51NUpeftzZvZSR4MIU62';
    console.log(`🔍 Fetching Firebase portfolios for ${userId}...`);
    const fbSnap = await db.collection('portfolios').where('userId', '==', userId).get();
    console.log(`📦 Firebase records: ${fbSnap.size}`);

    console.log(`🔍 Fetching Supabase portfolios for ${userId}...`);
    const { data: sbData, error: sbError } = await supabase
        .from('portfolios')
        .select('firebase_id')
        .eq('user_id', userId);
    if (sbError) throw sbError;
    const existingIds = new Set(sbData.map(r => r.firebase_id).filter(Boolean));
    console.log(`📦 Supabase records: ${sbData.length}`);

    const missingDocs = [];
    fbSnap.forEach(doc => {
        if (!existingIds.has(doc.id)) {
            missingDocs.push({ id: doc.id, ...doc.data() });
        }
    });

    if (missingDocs.length === 0) {
        console.log('✅ No missing records found!');
        return;
    }

    console.log(`📋 ${missingDocs.length} records missing. Adding them...`);

    let success = 0, errors = 0;
    for (const data of missingDocs) {
        const record = {
            firebase_id: data.id,
            user_id: data.userId,
            share_name: data.shareName,
            quantity: data.quantity || 0,
            buy_price: data.buyPrice || 0,
            commission: data.commission || 0,
            commission_percent: data.commissionPercent || 0,
            date: data.date?.toDate?.()?.toISOString?.().split('T')[0] || new Date().toISOString().split('T')[0],
            created_at: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString()
        };
        const ok = await upsertToSupabase('portfolios', record);
        if (ok) success++; else errors++;
        console.log(`📊 Progress: ${success + errors}/${missingDocs.length}`);
    }

    console.log(`✅ Done. Added: ${success}, Failed: ${errors}`);
}

fillMissing().catch(console.error);
