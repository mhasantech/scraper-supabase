// scripts/update_daily_closing.js
const axios = require('axios');
const https = require('https');

// ==========================================
// 📌 Supabase কনফিগারেশন
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });

// ==========================================
// 📡 Supabase REST API-তে আপসার্ট
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
        if (response.status === 201 || response.status === 200) {
            return true;
        }
        return false;
    } catch (err) {
        if (err.response && err.response.status === 409) {
            console.log(`ℹ️ ডুপ্লিকেট (${record.ticker}), ইগনোর।`);
            return true;
        }
        console.error(`❌ আপসার্ট ব্যর্থ:`, err.message);
        return false;
    }
}

// ==========================================
// 📡 CSE-র দৈনিক ক্লোজিং ডেটা আপডেট
// ==========================================
async function updateDailyClosing() {
    const today = new Date().toISOString().split('T')[0];
    console.log(`📅 CSE দৈনিক ক্লোজিং আপডেট: ${today}`);

    try {
        // ১. আজকের সর্বশেষ ডেটা Supabase থেকে নিন (প্রতিটি টিকারের)
        const url = `${SUPABASE_URL}/rest/v1/cse_market_data?select=code,ltp,high,low,eps,pe_ratio,dividend,record_date,category&order=date.desc`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        const response = await axios.get(url, {
            headers,
            httpsAgent: agent,
            timeout: 15000
        });

        const data = response.data;
        if (!data || data.length === 0) {
            console.log('ℹ️ আজকের কোনো ডেটা পাওয়া যায়নি।');
            return;
        }

        // ২. প্রতিটি টিকারের জন্য শুধু সর্বশেষ এন্ট্রি নিন (একাধিক থাকলে)
        const seen = new Set();
        const closingData = [];
        for (const row of data) {
            if (!seen.has(row.code)) {
                seen.add(row.code);
                closingData.push({
                    ticker: row.code,
                    date: today,
                    ltp: row.ltp || 0,
                    high: row.high || 0,
                    low: row.low || 0,
                    category: row.category || null,
                    eps: row.eps || null,
                    pe_ratio: row.pe_ratio || null,
                    dividend: row.dividend || null,
                    record_date: row.record_date || null,
                    updated_at: new Date().toISOString()
                });
            }
        }

        console.log(`📊 ${closingData.length}টি টিকার ক্লোজিং ডেটা সেভ হবে।`);

        // ৩. daily_closing_prices টেবিলে আপসার্ট (ব্যাচে)
        const batchSize = 50;
        let success = 0, errors = 0;

        for (let i = 0; i < closingData.length; i += batchSize) {
            const batch = closingData.slice(i, i + batchSize);
            // ব্যাচ আপসার্ট (একাধিক রেকর্ড একসাথে)
            for (const record of batch) {
                const saved = await upsertToSupabase('daily_closing_prices', record);
                if (saved) {
                    success++;
                } else {
                    errors++;
                }
            }
            console.log(`📦 ব্যাচ ${Math.floor(i/batchSize)+1} সম্পন্ন (${success}/${i+batch.length})`);
        }

        console.log(`✅ দৈনিক ক্লোজিং আপডেট সম্পন্ন! সফল: ${success}, ব্যর্থ: ${errors}`);

    } catch (err) {
        console.error('❌ দৈনিক ক্লোজিং আপডেট ব্যর্থ:', err.message);
        if (err.response) {
            console.error('📄 রেসপন্স স্ট্যাটাস:', err.response.status);
        }
    }
}

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================
async function startScraper() {
    console.log(`🕐 ${new Date().toISOString()} - CSE দৈনিক ক্লোজিং আপডেট শুরু...`);
    await updateDailyClosing();
    console.log('✅ স্ক্রিপ্ট সম্পন্ন!');
}

// ==========================================
// 🔥 রান
// ==========================================
if (require.main === module) {
    startScraper().catch(err => {
        console.error('❌ Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { startScraper, updateDailyClosing };
