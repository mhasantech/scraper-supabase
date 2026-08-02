// scripts/update_historical_closing.js
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
// 🕐 বাংলাদেশ সময় (UTC+6)
// ==========================================
function getBangladeshTime() {
    const now = new Date();
    const bdTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    return bdTime.toISOString();
}

// ==========================================
// 📡 Supabase আপসার্ট (on_conflict)
// ==========================================
async function upsertToSupabase(table, record, conflictColumns) {
    const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflictColumns}`;
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
        if ([200, 201, 202, 204].includes(response.status)) {
            return true;
        }
        return false;
    } catch (err) {
        console.error(`❌ আপসার্ট ব্যর্থ (${record.ticker || record.code}):`, err.message);
        if (err.response) console.error('📄 রেসপন্স:', err.response.data);
        return false;
    }
}

// ==========================================
// 📡 আপনার API থেকে হিস্টোরিক্যাল ডেটা আনা
// ==========================================
async function fetchHistoricalData(ticker, isDSE = true) {
    // ⚠️ আপনার API এন্ডপয়েন্ট
    const API_BASE_URL = 'https://bd-stock-api-an3n.vercel.app/v1/dse/historical';
    
    // গত ২ বছরের ডেটা (আপনি চাইলে start/end প্যারামিটার পরিবর্তন করতে পারেন)
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);
    const startDateStr = startDate.toISOString().split('T')[0];

    const url = `${API_BASE_URL}?start=${startDateStr}&end=${endDate}&code=${ticker}`;
    
    try {
        console.log(`📡 ${ticker} -> হিস্টোরি আনা হচ্ছে...`);
        const response = await axios.get(url, { timeout: 30000 });
        
        // API রেসপন্স চেক
        if (!response.data?.success || !response.data?.data) {
            console.log(`⚠️ ${ticker} -> ডেটা পাওয়া যায়নি।`);
            return [];
        }

        const historicalData = response.data.data;
        if (historicalData.length === 0) {
            console.log(`⚠️ ${ticker} -> কোনো রেকর্ড নেই।`);
            return [];
        }

        // ডেটা রূপান্তর (Transform) – API রেসপন্স অনুযায়ী ম্যাপিং
        const records = historicalData.map(item => {
            // DSE-র জন্য টেবিলের নাম হবে 'dse_closing_prices'
            // CSE-র জন্য 'daily_closing_prices'
            // দুই জায়গাতেই ticker/code ফিল্ড থাকবে
            return {
                ticker: item['TRADING CODE'] || ticker,  // DSE
                code: item['TRADING CODE'] || ticker,    // CSE
                date: item['DATE'],                       // "2026-07-30"
                ltp: parseFloat(item['LTP*']) || 0,
                high: parseFloat(item['HIGH']) || 0,
                low: parseFloat(item['LOW']) || 0,
                volume: parseInt(item['VOLUME']) || 0,
                open: parseFloat(item['OPENP*']) || 0,
                ycp: parseFloat(item['YCP']) || 0,
                trade: parseInt(item['TRADE']) || 0,
                value_mn: parseFloat(item['VALUE (mn)']) || 0,
                updated_at: getBangladeshTime()
            };
        });

        console.log(`✅ ${ticker} -> ${records.length}টি রেকর্ড পাওয়া গেছে।`);
        return records;

    } catch (err) {
        console.error(`❌ ${ticker} -> API কল ব্যর্থ:`, err.message);
        return [];
    }
}

// ==========================================
// 📋 সব শেয়ারের তালিকা সংগ্রহ করা
// ==========================================
async function getAllTickers() {
    // DSE তালিকা (ব্যাকআপ)
    const dseTickers = [
        "UTTARABANK", "BDTHAI", "ACI", "BEXIMCO", "BATBC", 
        "GP", "LHBL", "SQURPHARMA", "BRACBANK", "DBH",
        "BSRMLTD", "KPCL", "POWERGRID", "SALAMCRST", "SHAHJABANK",
        "SIBL", "SONARGAON", "STANDARDBANK", "TRUSTBANK", "UNITEDAIR"
    ];

    // CSE তালিকা (ব্যাকআপ)
    const cseTickers = [
        "1JANATAMF", "1STPRIMFMF", "AAMRANET", "AAMRATECH", "ABB1STMF",
        "ABBANK", "ACFL", "ACI", "ACIFORMULA", "ACMELAB"
    ];

    // Supabase থেকে লাইভ তালিকা আনার চেষ্টা (ঐচ্ছিক)
    try {
        // DSE তালিকা (dse_live_data থেকে)
        const dseUrl = `${SUPABASE_URL}/rest/v1/dse_live_data?select=ticker`;
        const dseRes = await axios.get(dseUrl, {
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
            httpsAgent: agent,
            timeout: 10000
        });
        if (dseRes.data && dseRes.data.length > 0) {
            const fetched = dseRes.data.map(row => row.ticker).filter(Boolean);
            if (fetched.length > 0) {
                console.log(`📊 DSE: ${fetched.length}টি টিকার পাওয়া গেছে (Supabase থেকে)`);
                // Supabase থেকে পাওয়া তালিকা ব্যবহার করব, কিন্তু ব্যাকআপের সাথে মিলিয়ে নেব
                // যাতে নতুন কোনো টিকার ডেটা মিস না হয়
                const combined = [...new Set([...fetched, ...dseTickers])];
                return { dse: combined, cse: cseTickers };
            }
        }
    } catch (e) {
        console.warn('⚠️ Supabase থেকে DSE তালিকা পড়া যায়নি, ব্যাকআপ ব্যবহার করছি...');
    }

    return { dse: dseTickers, cse: cseTickers };
}

// ==========================================
// 🚀 মেইন ফাংশন – DSE হিস্টোরি আপডেট
// ==========================================
async function updateDSEHistorical() {
    console.log(`🕐 ${getBangladeshTime()} - DSE হিস্টোরিক্যাল ডেটা আপডেট শুরু...`);
    
    const { dse } = await getAllTickers();
    console.log(`📊 মোট ${dse.length}টি DSE টিকার ডেটা আনা হবে।`);

    let totalRecords = 0;
    let successCount = 0;
    const chunkSize = 3; // API রেট-লিমিট এড়ানোর জন্য

    for (let i = 0; i < dse.length; i += chunkSize) {
        const chunk = dse.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, dse.length)}/${dse.length}`);

        const results = await Promise.all(chunk.map(async (ticker) => {
            const records = await fetchHistoricalData(ticker, true);
            if (records.length === 0) return { ticker, count: 0, saved: 0 };

            let saved = 0;
            for (const record of records) {
                // DSE-র জন্য টেবিল: dse_closing_prices
                // conflict columns: ticker, date
                const success = await upsertToSupabase('dse_closing_prices', record, 'ticker,date');
                if (success) saved++;
            }
            return { ticker, count: records.length, saved };
        }));

        for (const result of results) {
            totalRecords += result.count;
            successCount += result.saved;
            console.log(`${result.ticker}: ${result.saved}/${result.count} সেভ হয়েছে`);
        }

        // API রেট-লিমিট এড়ানোর জন্য বিরতি
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`✅ DSE হিস্টোরি আপডেট সম্পন্ন! মোট: ${totalRecords}, সফল: ${successCount}`);
}

// ==========================================
// 🚀 মেইন ফাংশন – CSE হিস্টোরি আপডেট
// ==========================================
async function updateCSEHistorical() {
    console.log(`🕐 ${getBangladeshTime()} - CSE হিস্টোরিক্যাল ডেটা আপডেট শুরু...`);
    
    const { cse } = await getAllTickers();
    console.log(`📊 মোট ${cse.length}টি CSE টিকার ডেটা আনা হবে।`);

    let totalRecords = 0;
    let successCount = 0;
    const chunkSize = 3;

    for (let i = 0; i < cse.length; i += chunkSize) {
        const chunk = cse.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, cse.length)}/${cse.length}`);

        const results = await Promise.all(chunk.map(async (ticker) => {
            // CSE-র জন্য API-তে code প্যারামিটার পাঠাতে হবে
            // যদি আপনার API CSE সমর্থন করে, তাহলে URL পরিবর্তন করুন
            // অন্যথায় CSE-র জন্য আলাদা API দরকার
            const records = await fetchHistoricalData(ticker, false);
            if (records.length === 0) return { ticker, count: 0, saved: 0 };

            let saved = 0;
            for (const record of records) {
                // CSE-র জন্য টেবিল: daily_closing_prices
                // conflict columns: code, date
                const success = await upsertToSupabase('daily_closing_prices', record, 'code,date');
                if (success) saved++;
            }
            return { ticker, count: records.length, saved };
        }));

        for (const result of results) {
            totalRecords += result.count;
            successCount += result.saved;
            console.log(`${result.ticker}: ${result.saved}/${result.count} সেভ হয়েছে`);
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`✅ CSE হিস্টোরি আপডেট সম্পন্ন! মোট: ${totalRecords}, সফল: ${successCount}`);
}

// ==========================================
// 🔥 রান
// ==========================================
async function start() {
    // DSE আপডেট
    await updateDSEHistorical();
    
    console.log('\n' + '='.repeat(50) + '\n');
    
    // CSE আপডেট (যদি আপনার API CSE সমর্থন করে)
    // await updateCSEHistorical();
    
    console.log('🎉 সব আপডেট সম্পন্ন!');
}

start().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
