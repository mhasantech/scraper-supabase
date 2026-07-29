// scripts/dse_company_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });

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

const IS_MANUAL_RUN = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';

// ==========================================
// 📡 আপসার্ট (on_conflict code,date)
// ==========================================
async function upsertToSupabase(table, record) {
    const conflictColumns = 'code,date';
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
        console.warn(`⚠️ অজানা স্ট্যাটাস ${response.status} (${table})`);
        return false;
    } catch (err) {
        if (err.response && err.response.status === 409) {
            console.error(`❌ কনফ্লিক্ট! on_conflict কাজ করছে না (${record.code})`);
            return false;
        }
        console.error(`❌ আপসার্ট ব্যর্থ (${record.code}):`, err.message);
        if (err.response) console.error('📄 রেসপন্স:', err.response.data);
        return false;
    }
}

function parseDividendHistory(text, type) {
    const result = {};
    if (!text || text === "N/A" || text === "-") return result;
    const parts = text.split(',');
    parts.forEach(part => {
        const trimmed = part.trim();
        const yearMatch = trimmed.match(/\b(19|20)\d{2}\b/);
        if (yearMatch) {
            const year = yearMatch[0];
            const rate = trimmed.replace(year, '').trim();
            if (rate) {
                result[`${type}_${year}`] = rate;
            }
        }
    });
    return result;
}

async function fetchDSECompanyData(companyCode, todayDate) {
    const apiUrl = `https://dse-scrape.vercel.app/api/scrape?action=all&tradingCode=${companyCode}`;
    try {
        const response = await axios.get(apiUrl, { timeout: 20000 });
        if (response.data?.success && response.data?.data?.details) {
            const details = response.data.data.details;
            const cashDiv = parseDividendHistory(details.cashDividend || "", "cash");
            const stockDiv = parseDividendHistory(details.stockDividend || "", "stock");

            const record = {
                code: companyCode,
                date: todayDate,
                listing_year: details.listingYear || "N/A",
                share_category: details.shareCategory || "N/A",
                market_category: details.marketCategory || "N/A",
                ...cashDiv,
                ...stockDiv,
                updated_at: new Date().toISOString()
            };

            const success = await upsertToSupabase('dse_company_data', record);
            if (success) {
                console.log(`✅ DSE: ${companyCode} -> সেভ হয়েছে`);
            } else {
                console.log(`❌ DSE: ${companyCode} -> সেভ ব্যর্থ`);
            }
            return success;
        }
        return false;
    } catch (err) {
        console.error(`❌ DSE API ব্যর্থ (${companyCode}):`, err.message);
        return false;
    }
}

async function startScraper() {
    if (!IS_MANUAL_RUN && !isWithinTradingHours()) {
        console.log(`⏳ ট্রেডিং আওয়ারের বাইরে। অটো রান স্কিপ করছি।`);
        process.exit(0);
    }

    if (IS_MANUAL_RUN) {
        console.log(`🔧 ম্যানুয়াল রান সনাক্ত করা হয়েছে। ট্রেডিং আওয়ার চেক বাইপাস।`);
    }

    console.log(`🕐 ${new Date().toISOString()} - DSE কোম্পানি স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    let companies = [];
    try {
        const url = `${SUPABASE_URL}/rest/v1/cse_market_data?select=code&date=eq.${todayDate}`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };
        const response = await axios.get(url, { headers, httpsAgent: agent, timeout: 15000 });
        if (response.data) {
            companies = response.data.map(row => row.code);
        }
    } catch (e) {
        console.warn("⚠️ CSE ডেটা থেকে তালিকা পড়া যায়নি, ব্যাকআপ ব্যবহার করছি...");
    }

    if (companies.length === 0) {
        companies = ["UTTARABANK", "BDTHAI", "ACI", "BEXIMCO", "BATBC", "GP", "LHBL", "SQURPHARMA"];
    }

    console.log(`📊 মোট ${companies.length}টি কোম্পানির DSE ডেটা আনা হচ্ছে...`);

    const chunkSize = 5;
    let successCount = 0;
    for (let i = 0; i < companies.length; i += chunkSize) {
        const chunk = companies.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, companies.length)}/${companies.length}`);
        const results = await Promise.all(chunk.map(code => fetchDSECompanyData(code, todayDate)));
        successCount += results.filter(r => r === true).length;
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`✅ DSE স্ক্র্যাপ সম্পন্ন! সফল: ${successCount}, মোট: ${companies.length}`);
}

startScraper().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
