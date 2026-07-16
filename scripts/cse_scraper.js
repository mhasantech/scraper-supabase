// scripts/cse_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');  // 👈 গুরুত্বপূর্ণ
const https = require('https');

// ==========================================
// 📌 কনফিগারেশন ও ক্লায়েন্ট সেটআপ
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_URL বা SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

// ✅ WebSocket ফিক্স সহ Supabase ক্লায়েন্ট
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: {
        transport: WebSocket,
        autoConnect: false
    }
});

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==========================================
// 🕐 বাংলাদেশ সময় চেক (শুধু ৯:৫০ AM – ২:৩০ PM)
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
// 📡 সিঙ্গেল কোম্পানি স্ক্র্যাপ
// ==========================================
async function scrapeSingleCompany(companyCode, todayDate) {
    const detailUrl = `https://www.cse.com.bd/index.php?/company/companydetails/${companyCode}`;
    try {
        const { data } = await axios.get(detailUrl, {
            httpsAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(data);

        let companyInfo = {
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
                    companyInfo.ltp = $(td).next('td').text().trim();
                } else if (text.includes("day's range")) {
                    const range = $(td).next('td').text().trim();
                    if (range && range.includes('-')) {
                        const parts = range.split('-');
                        companyInfo.low = parts[0].trim();
                        companyInfo.high = parts[1].trim();
                    }
                } else if (text.includes('market category')) {
                    companyInfo.category = $(td).next('td').text().trim();
                } else if (text.includes('hy eps') || (text === 'eps' && companyInfo.eps === "N/A")) {
                    companyInfo.eps = $(td).next('td').text().trim();
                } else if (text.includes('dividend(%)')) {
                    companyInfo.dividend = $(td).next('td').text().trim();
                } else if (text.includes('record date')) {
                    companyInfo.record_date = $(td).next('td').text().trim();
                }
            });
        });

        const ltpNum = parseFloat(companyInfo.ltp);
        const epsNum = parseFloat(companyInfo.eps);
        if (!isNaN(ltpNum) && !isNaN(epsNum) && epsNum !== 0) {
            companyInfo.pe_ratio = (ltpNum / epsNum).toFixed(2);
        }

        const { error } = await supabase
            .from('cse_market_data')
            .upsert({
                code: companyInfo.code,
                date: companyInfo.date,
                ltp: companyInfo.ltp,
                high: companyInfo.high,
                low: companyInfo.low,
                category: companyInfo.category,
                eps: companyInfo.eps,
                pe_ratio: companyInfo.pe_ratio,
                dividend: companyInfo.dividend,
                record_date: companyInfo.record_date,
                updated_at: companyInfo.updated_at
            }, { onConflict: 'code, date' });

        if (error) {
            console.error(`❌ Supabase আপসার্ট ব্যর্থ (${companyCode}):`, error.message);
        } else {
            console.log(`✅ CSE: ${companyCode} -> LTP: ${companyInfo.ltp}`);
        }

    } catch (err) {
        console.error(`❌ CSE স্ক্র্যাপ ব্যর্থ (${companyCode}):`, err.message);
    }
}

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================
async function startScraper() {
    if (!isWithinTradingHours()) {
        console.log(`⏳ বর্তমান সময় ট্রেডিং আওয়ারের বাইরে। স্কিপ করছি।`);
        process.exit(0);
    }

    console.log(`🕐 ${new Date().toISOString()} - CSE স্ক্র্যাপিং শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];
    const listUrl = "https://www.cse.com.bd/market/current_price";

    try {
        const { data } = await axios.get(listUrl, {
            httpsAgent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const $ = cheerio.load(data);
        let companies = [];

        $('table tr').each((index, element) => {
            if (index === 0) return;
            const cols = $(element).find('td');
            if (cols.length >= 2) {
                const companyCode = $(cols[1]).text().trim().replace(/[/\\.#$/[\]]/g, "-");
                if (companyCode && companyCode !== "" && !companies.includes(companyCode)) {
                    companies.push(companyCode);
                }
            }
        });

        console.log(`📊 মোট ${companies.length}টি কোম্পানি পাওয়া গেছে।`);

        const chunkSize = 10;
        for (let i = 0; i < companies.length; i += chunkSize) {
            const chunk = companies.slice(i, i + chunkSize);
            console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, companies.length)}/${companies.length}`);
            await Promise.all(chunk.map(code => scrapeSingleCompany(code, todayDate)));
            await delay(500);
        }

        console.log('✅ CSE স্ক্র্যাপিং সম্পন্ন!');

    } catch (error) {
        console.error('❌ CSE তালিকা স্ক্র্যাপ ব্যর্থ:', error.message);
        process.exit(1);
    }
}

startScraper();
