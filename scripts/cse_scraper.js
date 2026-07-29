// scripts/cse_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
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
// 📡 Supabase REST API-তে আপসার্ট (on_conflict + সঠিক স্ট্যাটাস হ্যান্ডলিং)
// ==========================================
async function upsertToSupabase(table, record) {
    // cse_market_data টেবিলের unique key হলো (code, date)
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

        // Supabase ২০০, ২০১, ২০২, ২০৪ – সবগুলোই সফল রেসপন্স
        if ([200, 201, 202, 204].includes(response.status)) {
            return true;
        }

        // অজানা স্ট্যাটাস পেলে সতর্কতা
        console.warn(`⚠️ অজানা স্ট্যাটাস ${response.status} (${table})`);
        return false;

    } catch (err) {
        // on_conflict থাকায় ৪০৯ আসার কথা না, তবু এসে থাকলে সেটা এরর
        if (err.response && err.response.status === 409) {
            console.error(`❌ কনফ্লিক্ট! on_conflict কাজ করছে না (${record.code})`);
            return false;
        }

        // অন্যান্য এরর লগ করুন
        console.error(`❌ আপসার্ট ব্যর্থ (${record.code}):`, err.message);
        if (err.response) {
            console.error('📄 রেসপন্স ডেটা:', err.response.data);
        }
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
        } else {
            console.log(`❌ CSE: ${companyCode} -> আপসার্ট ব্যর্থ`);
        }

    } catch (err) {
        console.error(`❌ CSE স্ক্র্যাপ ব্যর্থ (${companyCode}):`, err.message);
    }
}

// ==========================================
// 📡 CSE তালিকা থেকে কোম্পানি আনা
// ==========================================
async function getCSECompanyList() {
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
                if (code && !companies.includes(code)) {
                    companies.push(code);
                }
            }
        });

        return companies;
    } catch (err) {
        console.error("❌ CSE তালিকা আনা ব্যর্থ:", err.message);
        return [];
    }
}

// ==========================================
// 📡 ব্যাকআপ লিস্ট
// ==========================================
function getBackupList() {
    return [
        "1JANATAMF", "1STPRIMFMF", "AAMRANET", "AAMRATECH", "ABB1STMF",
        "ABBANK", "ACFL", "ACI", "ACIFORMULA", "ACMELAB",
        "ACTIVEFINE", "ADNTEL", "ADVENT", "AFCAGRO", "AFTABAUTO",
        "AGNISYSL", "AGRANINS", "AIBL1STIMF", "AIL", "AL-HAJTEX",
        "ALARABANK", "ALIF", "ALLTEX", "AMANFEED", "AMBEEPHA",
        "ANLIMAYARN", "ANWARGALV", "APEXFOODS", "APEXFOOT", "APEXSPINN"
    ];
}

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================
async function startScraper() {
    console.log(`🕐 ${new Date().toISOString()} - CSE স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    let companies = await getCSECompanyList();
    if (companies.length === 0) {
        console.log("⚠️ CSE তালিকা পাওয়া যায়নি, ব্যাকআপ লিস্ট ব্যবহার করছি...");
        companies = getBackupList();
    }

    console.log(`📊 মোট ${companies.length}টি কোম্পানি পাওয়া গেছে।`);

    const chunkSize = 10;
    for (let i = 0; i < companies.length; i += chunkSize) {
        const chunk = companies.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, companies.length)}/${companies.length}`);
        await Promise.all(chunk.map(code => scrapeSingleCompany(code, todayDate)));
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('✅ CSE স্ক্র্যাপিং সম্পন্ন!');
}

// ==========================================
// 🔥 রান
// ==========================================
startScraper().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
