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
// 📡 DSE হিস্টোরিক্যাল ডেটা (শুধু DSE)
// ==========================================
async function fetchDSEHistorical(ticker) {
    const API_BASE_URL = 'https://bd-stock-api-an3n.vercel.app/v1/dse/historical';
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date();
    startDate.setFullYear(startDate.getFullYear() - 2);
    const startDateStr = startDate.toISOString().split('T')[0];

    const url = `${API_BASE_URL}?start=${startDateStr}&end=${endDate}&code=${ticker}`;
    
    try {
        console.log(`📡 ${ticker} -> হিস্টোরি আনা হচ্ছে...`);
        const response = await axios.get(url, { timeout: 30000 });
        
        if (!response.data?.success || !response.data?.data) {
            console.log(`⚠️ ${ticker} -> ডেটা পাওয়া যায়নি।`);
            return [];
        }

        const historicalData = response.data.data;
        if (historicalData.length === 0) {
            console.log(`⚠️ ${ticker} -> কোনো রেকর্ড নেই।`);
            return [];
        }

        // DSE রেকর্ড – শুধু ticker ব্যবহার করছি (code বাদ)
        const records = historicalData.map(item => ({
            ticker: item['TRADING CODE'] || ticker,
            date: item['DATE'],
            ltp: parseFloat(item['LTP*']) || 0,
            high: parseFloat(item['HIGH']) || 0,
            low: parseFloat(item['LOW']) || 0,
            volume: parseInt(item['VOLUME']) || 0,
            open: parseFloat(item['OPENP*']) || 0,
            ycp: parseFloat(item['YCP']) || 0,
            trade: parseInt(item['TRADE']) || 0,
            value_mn: parseFloat(item['VALUE (mn)']) || 0,
            updated_at: getBangladeshTime()
        }));

        console.log(`✅ ${ticker} -> ${records.length}টি রেকর্ড পাওয়া গেছে।`);
        return records;

    } catch (err) {
        console.error(`❌ ${ticker} -> API কল ব্যর্থ:`, err.message);
        return [];
    }
}

// ==========================================
// 📋 সব DSE টিকার তালিকা (Supabase অথবা ব্যাকআপ)
// ==========================================
async function getDSETickers() {
    try {
        const url = `${SUPABASE_URL}/rest/v1/dse_live_data?select=ticker`;
        const res = await axios.get(url, {
            headers: {
                'apikey': SUPABASE_SERVICE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
            },
            httpsAgent: agent,
            timeout: 10000
        });
        if (res.data && res.data.length > 0) {
            const tickers = res.data.map(row => row.ticker).filter(Boolean);
            console.log(`📊 DSE: ${tickers.length}টি টিকার পাওয়া গেছে (Supabase থেকে)`);
            return tickers;
        }
    } catch (e) {
        console.warn('⚠️ Supabase থেকে DSE তালিকা পড়া যায়নি, ব্যাকআপ ব্যবহার করছি...');
    }
    // ব্যাকআপ তালিকা
    return ["UTTARABANK", "BDTHAI", "ACI", "BEXIMCO", "BATBC", "GP", "LHBL", "SQURPHARMA"];
}

// ==========================================
// 🚀 DSE হিস্টোরি আপডেট
// ==========================================
async function updateDSEHistorical() {
    console.log(`🕐 ${getBangladeshTime()} - DSE হিস্টোরিক্যাল ডেটা আপডেট শুরু...`);
    
    const tickers = await getDSETickers();
    console.log(`📊 মোট ${tickers.length}টি DSE টিকার ডেটা আনা হবে।`);

    let totalRecords = 0;
    let successCount = 0;
    const chunkSize = 3;

    for (let i = 0; i < tickers.length; i += chunkSize) {
        const chunk = tickers.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, tickers.length)}/${tickers.length}`);

        for (const ticker of chunk) {
            const records = await fetchDSEHistorical(ticker);
            if (records.length === 0) continue;

            let saved = 0;
            for (const record of records) {
                // DSE টেবিলের জন্য conflict columns: ticker, date
                const success = await upsertToSupabase('dse_closing_prices', record, 'ticker,date');
                if (success) saved++;
            }
            totalRecords += records.length;
            successCount += saved;
            console.log(`${ticker}: ${saved}/${records.length} সেভ হয়েছে`);
            
            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`✅ DSE হিস্টোরি আপডেট সম্পন্ন! মোট: ${totalRecords}, সফল: ${successCount}`);
}

// ==========================================
// 🔥 রান
// ==========================================
async function start() {
    await updateDSEHistorical();
    console.log('🎉 সব আপডেট সম্পন্ন!');
}

start().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
