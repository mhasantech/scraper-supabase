// scripts/dse_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// ==========================================
// 📌 সঠিক Supabase URL (হার্ডকোডেড)
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

console.log(`✅ Supabase URL: ${SUPABASE_URL}`);

const agent = new https.Agent({ rejectUnauthorized: false });

// ==========================================
// 🕐 ট্রেডিং আওয়ার চেক
// ==========================================
function isWithinTradingHours() {
    const now = new Date();
    const bdTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const hours = bdTime.getUTCHours();
    const minutes = bdTime.getUTCMinutes();
    const start = 9 * 60 + 50;
    const end = 14 * 60 + 30;
    const current = hours * 60 + minutes;
    return current >= start && current <= end;
}

// ==========================================
// 📡 Supabase REST API আপসার্ট
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
        console.error(`❌ আপসার্ট ব্যর্থ (${record.code || record.ticker}):`, err.message);
        return false;
    }
}

// ==========================================
// 📡 DSEX ইনডেক্স
// ==========================================
async function scrapeDSEIndices(todayDate) {
    console.log("📊 DSEX ইনডেক্স সংগ্রহ...");
    const homeUrl = "https://dsebd.org/index.php";
    try {
        const { data } = await axios.get(homeUrl, {
            httpsAgent: agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        const $ = cheerio.load(data);
        $('tr, .index-box, div.bg-blue-light').each((i, el) => {
            const text = $(el).text();
            if (text.includes('DSEX') || text.includes('DSES') || text.includes('D30')) {
                const cols = $(el).find('td');
                if (cols.length >= 3) {
                    let name = $(cols[0]).text().trim();
                    let value = $(cols[1]).text().trim();
                    if (name.includes('DSEX')) name = 'DSEX';
                    else if (name.includes('DSES')) name = 'DSES';
                    else if (name.includes('D30')) name = 'D30';
                    const num = parseFloat(value);
                    if (!isNaN(num) && num > 0) {
                        upsertToSupabase('dsex_index', { date: todayDate, value: num })
                            .then(success => {
                                if (success) console.log(`✅ DSEX ${name}: ${value}`);
                            });
                    }
                }
            }
        });
    } catch (err) {
        console.error('❌ DSEX স্ক্র্যাপ ব্যর্থ:', err.message);
    }
}

// ==========================================
// 📡 DSE API থেকে ডিভিডেন্ড
// ==========================================
async function fetchFromDSEApi(companyCode, todayDate) {
    const apiUrl = `https://dse-scrape.vercel.app/api/scrape?action=all&tradingCode=${companyCode}`;
    try {
        const response = await axios.get(apiUrl, { timeout: 15000 });
        if (response.data?.success && response.data?.data?.details) {
            const details = response.data.data.details;
            const record = {
                code: companyCode,
                date: todayDate,
                listing_year: details.listingYear || "N/A",
                share_category: details.shareCategory || "N/A",
                cash_dividend: details.cashDividend || "N/A",
                stock_dividend: details.stockDividend || "N/A",
                updated_at: new Date().toISOString()
            };
            const success = await upsertToSupabase('dse_dividend_data', record);
            if (success) console.log(`✅ DSE DIV: ${companyCode} সেভ হয়েছে`);
        }
    } catch (err) {
        console.error(`❌ DSE API ব্যর্থ (${companyCode}):`, err.message);
    }
}

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================
async function startScraper() {
    if (!isWithinTradingHours()) {
        console.log(`⏳ ট্রেডিং আওয়ারের বাইরে। স্কিপ করছি।`);
        process.exit(0);
    }
    console.log(`🕐 ${new Date().toISOString()} - DSE স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    await scrapeDSEIndices(todayDate);
    await new Promise(r => setTimeout(r, 2000));

    // CSE ডেটা থেকে কোম্পানি তালিকা
    let companies = [];
    try {
        const url = `${SUPABASE_URL}/rest/v1/cse_market_data?select=code&date=eq.${todayDate}`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };
        const response = await axios.get(url, { headers, httpsAgent: agent, timeout: 15000 });
        if (response.data) companies = response.data.map(row => row.code);
    } catch (e) {}

    if (companies.length === 0) {
        console.warn("⚠️ CSE তালিকা পাওয়া যায়নি, ব্যাকআপ ব্যবহার করছি...");
        companies = ["UTTARABANK", "BDTHAI", "ACI", "BEXIMCO", "BATBC", "GP", "LHBL", "SQURPHARMA"];
    }

    console.log(`📊 মোট ${companies.length}টি কোম্পানির ডিভিডেন্ড আনা হচ্ছে...`);
    const chunkSize = 5;
    for (let i = 0; i < companies.length; i += chunkSize) {
        const chunk = companies.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, companies.length)}/${companies.length}`);
        await Promise.all(chunk.map(code => fetchFromDSEApi(code, todayDate)));
        await new Promise(r => setTimeout(r, 1000));
    }
    console.log('✅ DSE সম্পন্ন!');
}

startScraper();
