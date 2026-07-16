// scripts/cse_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// ==========================================
// 📌 কনফিগারেশন – সঠিক URL দিন
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

console.log(`🔗 Supabase URL: ${SUPABASE_URL}`);

const agent = new https.Agent({ rejectUnauthorized: false });

// ==========================================
// 🕐 বাংলাদেশ সময় চেক
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
// 📡 Supabase-এ আপসার্ট (REST API)
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
        console.warn(`⚠️ অপ্রত্যাশিত স্ট্যাটাস ${response.status} for ${record.code}`);
        return false;
    } catch (err) {
        console.error(`❌ আপসার্ট ব্যর্থ (${record.code}):`, err.message);
        return false;
    }
}

// ==========================================
// 📡 একক কোম্পানি স্ক্র্যাপ
// ==========================================
async function scrapeSingleCompany(companyCode, todayDate) {
    const detailUrl = `https://www.cse.com.bd/index.php?/company/companydetails/${companyCode}`;
    try {
        const { data } = await axios.get(detailUrl, {
            httpsAgent: agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });

        const $ = cheerio.load(data);
        let info = {
            code: companyCode,
            date: todayDate,
            ltp: "N/A",
            high: "N/A",
            low: "N/A",
            category: "N/A",
            eps: "N/A",
            pe_ratio: "N/A",
            dividend: "N/A",
            record_date: "N/A",
            updated_at: new Date().toISOString()
        };

        $('table tr').each((i, el) => {
            const cols = $(el).find('td');
            cols.each((index, td) => {
                const text = $(td).text().trim().toLowerCase();
                if (text.includes('last trade price (ltp)')) {
                    info.ltp = $(td).next('td').text().trim();
                } else if (text.includes("day's range")) {
                    const range = $(td).next('td').text().trim();
                    if (range && range.includes('-')) {
                        const parts = range.split('-');
                        info.low = parts[0].trim();
                        info.high = parts[1].trim();
                    }
                } else if (text.includes('market category')) {
                    info.category = $(td).next('td').text().trim();
                } else if (text.includes('hy eps') || (text === 'eps' && info.eps === "N/A")) {
                    info.eps = $(td).next('td').text().trim();
                } else if (text.includes('dividend(%)')) {
                    info.dividend = $(td).next('td').text().trim();
                } else if (text.includes('record date')) {
                    info.record_date = $(td).next('td').text().trim();
                }
            });
        });

        const ltpNum = parseFloat(info.ltp);
        const epsNum = parseFloat(info.eps);
        if (!isNaN(ltpNum) && !isNaN(epsNum) && epsNum !== 0) {
            info.pe_ratio = (ltpNum / epsNum).toFixed(2);
        }

        const success = await upsertToSupabase('cse_market_data', info);
        if (success) {
            console.log(`✅ CSE: ${companyCode} -> LTP: ${info.ltp}`);
        }

    } catch (err) {
        console.error(`❌ স্ক্র্যাপ ব্যর্থ (${companyCode}):`, err.message);
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

    console.log(`🕐 ${new Date().toISOString()} - CSE স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];
    const listUrl = "https://www.cse.com.bd/market/current_price";

    try {
        const { data } = await axios.get(listUrl, {
            httpsAgent: agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            timeout: 15000
        });

        const $ = cheerio.load(data);
        let companies = [];

        $('table tr').each((index, element) => {
            if (index === 0) return;
            const cols = $(element).find('td');
            if (cols.length >= 2) {
                const code = $(cols[1]).text().trim().replace(/[/\\.#$/[\]]/g, "-");
                if (code && !companies.includes(code)) companies.push(code);
            }
        });

        console.log(`📊 মোট ${companies.length}টি কোম্পানি পাওয়া গেছে।`);

        const chunkSize = 10;
        for (let i = 0; i < companies.length; i += chunkSize) {
            const chunk = companies.slice(i, i + chunkSize);
            console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, companies.length)}/${companies.length}`);
            await Promise.all(chunk.map(code => scrapeSingleCompany(code, todayDate)));
            await new Promise(r => setTimeout(r, 500));
        }

        console.log('✅ CSE সম্পন্ন!');

    } catch (error) {
        console.error('❌ CSE তালিকা ব্যর্থ:', error.message);
        process.exit(1);
    }
}

startScraper();
