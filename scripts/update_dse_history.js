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
// 📡 ব্যাচ আপসার্ট – এক টিকার সব রেকর্ড একসাথে
// ==========================================
async function batchUpsert(ticker, records) {
    if (records.length === 0) return 0;

    const table = 'history_dse';
    const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=ticker,date`;
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
        if ([200, 201, 202, 204].includes(response.status)) {
            return records.length;
        }
        return 0;
    } catch (err) {
        console.error(`❌ ব্যাচ আপসার্ট ব্যর্থ (${ticker}):`, err.message);
        if (err.response) console.error('📄 রেসপন্স:', err.response.data);
        return 0;
    }
}

// ==========================================
// 📡 API থেকে এক টিকার ডেটা আনা
// ==========================================
async function fetchTickerData(ticker, startDate, endDate) {
    const API_BASE_URL = 'https://bd-stock-api-an3n.vercel.app/v1/dse/historical';
    const url = `${API_BASE_URL}?start=${startDate}&end=${endDate}&code=${ticker}`;

    try {
        const response = await axios.get(url, { timeout: 30000 });
        if (!response.data?.success || !response.data?.data) {
            return [];
        }

        const historicalData = response.data.data;
        if (historicalData.length === 0) return [];

        return historicalData.map(item => ({
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

    } catch (err) {
        console.error(`❌ ${ticker} -> API কল ব্যর্থ:`, err.message);
        return [];
    }
}

// ==========================================
// 🔍 ফিল্টার: শুধু শেয়ার (Equity) বাছাই করা
// ==========================================
function isEquity(ticker) {
    if (!ticker) return false;
    const upper = ticker.toUpperCase();
    // মিউচুয়াল ফান্ড (MF), বন্ড (BOND), ট্রেজারি বিল (T-BILL), হাইফেন (-) বাদ
    if (upper.includes('MF') || upper.includes('BOND') || upper.includes('T-BILL') || upper.includes('-')) {
        return false;
    }
    return true;
}

// ==========================================
// 📋 সব DSE টিকার তালিকা (Supabase থেকে) + ফিল্টার
// ==========================================
async function getDSETickers() {
    let tickers = [];
    try {
        const url = `${SUPABASE_URL}/rest/v1/dse_live_data?select=ticker`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };
        const res = await axios.get(url, { headers, httpsAgent: agent, timeout: 10000 });
        if (res.data && res.data.length > 0) {
            const all = res.data.map(row => row.ticker).filter(Boolean);
            // 🔥 ফিল্টার প্রয়োগ
            tickers = all.filter(t => isEquity(t));
            console.log(`📊 DSE: মোট ${all.length}টি সিকিউরিটি থেকে ${tickers.length}টি শেয়ার বাছাই করা হয়েছে।`);
            return tickers;
        }
    } catch (e) {
        console.warn('⚠️ Supabase থেকে তালিকা পড়া যায়নি, ব্যাকআপ ব্যবহার করছি...');
    }

    // 🔥 ব্যাকআপ তালিকা (শুধু শেয়ার)
    const backup = ["UTTARABANK", "BDTHAI", "ACI", "BEXIMCO", "BATBC", "GP", "LHBL", "SQURPHARMA"];
    return backup.filter(t => isEquity(t));
}

// ==========================================
// 📅 সর্বশেষ তারিখ খুঁজে বের করা
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
// 🚀 মেইন ফাংশন
// ==========================================
async function updateDSEHistory() {
    console.log(`🕐 ${getBangladeshTime()} - DSE হিস্টোরি আপডেট শুরু... (শুধু শেয়ার)`);

    const today = new Date().toISOString().split('T')[0];
    const lastDate = await getLastDate();

    let startDate;
    let isFullHistory = false;

    if (!lastDate) {
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        startDate = twoYearsAgo.toISOString().split('T')[0];
        isFullHistory = true;
        console.log(`🆕 টেবিল খালি। গত ২ বছরের ডেটা আনা হবে (${startDate} থেকে)`);
    } else {
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
    console.log(`📊 মোট ${tickers.length}টি শেয়ারের ডেটা আনা হবে।`);

    const concurrency = 5;
    let totalRecords = 0;
    let successCount = 0;

    for (let i = 0; i < tickers.length; i += concurrency) {
        const chunk = tickers.slice(i, i + concurrency);
        console.log(`📡 প্রসেসিং ব্যাচ ${Math.floor(i/concurrency) + 1}/${Math.ceil(tickers.length/concurrency)} (${i+1}-${Math.min(i+concurrency, tickers.length)})`);

        const fetchPromises = chunk.map(ticker => fetchTickerData(ticker, startDate, today));
        const results = await Promise.all(fetchPromises);

        const upsertPromises = chunk.map((ticker, index) => {
            const records = results[index];
            if (records.length === 0) return Promise.resolve(0);
            return batchUpsert(ticker, records);
        });

        const savedCounts = await Promise.all(upsertPromises);

        for (let j = 0; j < chunk.length; j++) {
            const ticker = chunk[j];
            const records = results[j];
            const saved = savedCounts[j];
            totalRecords += records.length;
            successCount += saved;
            console.log(`${ticker}: ${saved}/${records.length} সেভ হয়েছে`);
        }

        await new Promise(r => setTimeout(r, 1000));
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
