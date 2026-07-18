// scripts/fill_missing_portfolios.js
const admin = require('firebase-admin');
const axios = require('axios');
const https = require('https');

// ==========================================
// 📌 কনফিগারেশন
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FIREBASE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

if (!SUPABASE_SERVICE_KEY || !FIREBASE_ACCOUNT) {
    console.error('❌ Missing environment variables');
    process.exit(1);
}

// Firebase Admin Init
const serviceAccount = JSON.parse(FIREBASE_ACCOUNT);
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// HTTPS Agent (SSL ফিক্স)
const agent = new https.Agent({ rejectUnauthorized: false });

// ==========================================
// 📤 Supabase REST API আপসার্ট
// ==========================================
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
        // 201 Created বা 200 OK সফল
        if (response.status === 201 || response.status === 200) {
            return true;
        }
        console.warn(`⚠️ Unexpected status ${response.status}`);
        return false;
    } catch (err) {
        // 409 Conflict মানে ডুপ্লিকেট, সেটা ইগনোর করলে হবে
        if (err.response && err.response.status === 409) {
            console.log(`ℹ️ Duplicate record, skipping.`);
            return true;
        }
        console.error(`❌ Upsert error:`, err.message);
        if (err.response) {
            console.error('📄 Response data:', err.response.data);
        }
        return false;
    }
}

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================
async function fillMissing() {
    const userId = 'DEdpyCbT51NUpeftzZvZSR4MIU62';
    console.log(`🔍 Fetching Firebase portfolios for ${userId}...`);
    const fbSnap = await db.collection('portfolios').where('userId', '==', userId).get();
    console.log(`📦 Firebase records: ${fbSnap.size}`);

    console.log(`🔍 Fetching Supabase portfolios for ${userId}...`);
    // Supabase থেকে firebase_id গুলো পড়ি
    const url = `${SUPABASE_URL}/rest/v1/portfolios?select=firebase_id&user_id=eq.${userId}`;
    const headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    };
    let sbData = [];
    try {
        const response = await axios.get(url, { headers, httpsAgent: agent });
        sbData = response.data || [];
    } catch (err) {
        console.error('❌ Supabase fetch failed:', err.message);
        // যদি টেবিলে firebase_id কলাম না থাকে, তাহলে পুরো ডেটা নিয়ে filter করব
        // কিন্তু আমরা আগেই কলাম যোগ করেছি, তাই ধরে নিচ্ছি আছে
        // fallback: all records without firebase_id filter
        try {
            const fallbackUrl = `${SUPABASE_URL}/rest/v1/portfolios?user_id=eq.${userId}`;
            const resp = await axios.get(fallbackUrl, { headers, httpsAgent: agent });
            sbData = resp.data || [];
            // firebase_id না থাকলে ডুপ্লিকেট এড়ানোর জন্য আমরা ID তুলনা করব না
            // তাহলে সব রেকর্ড আবার আপসার্ট করব (ডুপ্লিকেট ইগনোর হবে)
        } catch (e2) {
            console.error('❌ Fallback fetch also failed:', e2.message);
            process.exit(1);
        }
    }

    // Supabase-এ ইতিমধ্যে থাকা firebase_id গুলোর সেট
    const existingIds = new Set(sbData.map(r => r.firebase_id).filter(Boolean));

    // Firebase থেকে সেই ডকুমেন্টগুলো বের করি যাদের firebase_id Supabase-এ নেই
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
        // Firebase টাইমস্ট্যাম্পকে ISO স্ট্রিং-এ রূপান্তর
        const formatDate = (val) => {
            if (!val) return new Date().toISOString().split('T')[0];
            if (typeof val === 'string') return val.split('T')[0];
            if (val.toDate) return val.toDate().toISOString().split('T')[0];
            if (val instanceof Date) return val.toISOString().split('T')[0];
            return new Date().toISOString().split('T')[0];
        };
        const record = {
            firebase_id: data.id,
            user_id: data.userId,
            share_name: data.shareName,
            quantity: data.quantity || 0,
            buy_price: data.buyPrice || 0,
            commission: data.commission || 0,
            commission_percent: data.commissionPercent || 0,
            date: formatDate(data.date),
            created_at: data.createdAt?.toDate?.()?.toISOString() || new Date().toISOString()
        };

        const ok = await upsertToSupabase('portfolios', record);
        if (ok) success++; else errors++;
        console.log(`📊 Progress: ${success + errors}/${missingDocs.length}`);
    }

    console.log(`✅ Done. Added: ${success}, Failed: ${errors}`);
}

// ==========================================
// 🔥 রান
// ==========================================
fillMissing().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
