// scripts/update_dse_history.js
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
// 📡 Supabase আপসার্ট (history_dse)
// ==========================================
async function upsertToSupabase(record) {
    const table = 'history_dse';
    const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=ticker,date`;
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
        console.error(`❌ আপসার্ট ব্যর্থ (${record.ticker}):`, err.message);
        if (err.response) console.error('📄 রেসপন্স:', err.response.data);
        return false;
    }
}

// ==========================================
// 📡 শেষ তারিখ খুঁজে বের করা (history_dse থেকে)
// ==========================================
async function getLastDate() {
    try {
        const url = `${SUPABASE_URL}/rest/v1/history_dse?select=date&order=date.desc&limit=1`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };
        const res = await axios.get(url, { headers, httpsAgent: agent, timeout: 10000 });
        if (res.data && res.data.length > 0) {
            const lastDate = res.data[0].date;
            console.log(`📅 সর্বশেষ রেকর্ডের তারিখ: ${lastDate}`);
            return lastDate;
        }
    } catch (e) {
        console.warn('⚠️ শেষ তারিখ পড়া যায়নি (সম্ভবত টেবিল খালি)');
    }
    return null;
}

// ==========================================
// 📡 API থেকে হিস্টোরিক্যাল ডেটা আনা
// ==========================================
async function fetchDSEHistorical(ticker, startDate, endDate) {
    const API_BASE_URL = 'https://bd-stock-api-an3n.vercel.app/v1/dse/historical';
    const url = `${API_BASE_URL}?start=${startDate}&end=${endDate}&code=${ticker}`;

    try {
        console.log(`📡 ${ticker} -> ${startDate} থেকে ${endDate} পর্যন্ত আনা হচ্ছে...`);
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

        // history_dse টেবিলের জন্য সব ফিল্ড ম্যাপিং
        const records = historicalData.map(item => ({
            ticker: item['TRADING CODE'] || ticker,
            date: item['DATE'],
            ltp: parseFloat(item['LTP*']) || 0,
            high: parseFloat(item['HIGH']) || 0,
            low: parseFloat(item['LOW']) || 0,
            open: parseFloat(item['OPENP*']) || 0,
            ycp: parseFloat(item['YCP']) || 0,
            volume: parseInt(item['VOLUME']) || 0,
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
// 📋 সব DSE টিকার তালিকা (Supabase থেকে)
// ==========================================
async function getDSETickers() {
    try {
        const url = `${SUPABASE_URL}/rest/v1/dse_live_data?select=ticker`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };
        const res = await axios.get(url, { headers, httpsAgent: agent, timeout: 10000 });
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
// 🚀 মেইন ফাংশন – স্মার্ট আপডেট
// ==========================================
async function updateDSEHistory() {
    console.log(`🕐 ${getBangladeshTime()} - DSE হিস্টোরি আপডেট শুরু...`);

    const today = new Date().toISOString().split('T')[0];
    const lastDate = await getLastDate();

    let startDate;
    let isFullHistory = false;

    if (!lastDate) {
        // 🔥 প্রথমবার: গত ২ বছরের ডেটা আনবে
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        startDate = twoYearsAgo.toISOString().split('T')[0];
        isFullHistory = true;
        console.log(`🆕 টেবিল খালি। গত ২ বছরের ডেটা আনা হবে (${startDate} থেকে)`);
    } else {
        // 🔄 পরবর্তী রান: শেষ তারিখের পরের দিন থেকে আজ পর্যন্ত
        const nextDay = new Date(lastDate);
        nextDay.setDate(nextDay.getDate() + 1);
        startDate = nextDay.toISOString().split('T')[0];

        if (startDate > today) {
            console.log(`✅ ইতিমধ্যে আপ-টু-ডেট। (সর্বশেষ: ${lastDate}, আজ: ${today})`);
            return;
        }
        console.log(`🔄 নতুন ডেটা আনা হবে (${startDate} থেকে ${today} পর্যন্ত)`);
    }

    const tickers = await getDSETickers();
    console.log(`📊 মোট ${tickers.length}টি টিকার ডেটা আনা হবে।`);

    let totalRecords = 0;
    let successCount = 0;
    const chunkSize = 3;

    for (let i = 0; i < tickers.length; i += chunkSize) {
        const chunk = tickers.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, tickers.length)}/${tickers.length}`);

        for (const ticker of chunk) {
            const records = await fetchDSEHistorical(ticker, startDate, today);
            if (records.length === 0) continue;

            let saved = 0;
            for (const record of records) {
                const success = await upsertToSupabase(record);
                if (success) saved++;
            }
            totalRecords += records.length;
            successCount += saved;
            console.log(`${ticker}: ${saved}/${records.length} সেভ হয়েছে`);

            await new Promise(r => setTimeout(r, 500));
        }
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log(`✅ DSE হিস্টোরি আপডেট সম্পন্ন!`);
    console.log(`📊 মোট রেকর্ড: ${totalRecords}, সফল: ${successCount}`);
    if (isFullHistory) {
        console.log(`🎉 প্রথমবারের মতো সম্পূর্ণ ইতিহাস সেভ হয়েছে।`);
    } else {
        console.log(`📅 আজকের ডেটা আপডেট হয়েছে।`);
    }
}

// ==========================================
// 🔥 রান
// ==========================================
updateDSEHistory().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
