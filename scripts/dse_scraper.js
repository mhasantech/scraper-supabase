// scripts/dse_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

// ==========================================
// 📌 কনফিগারেশন
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

// এখানে ম্যানুয়াল রান চেক করার জন্য ফ্ল্যাগ
const IS_MANUAL_RUN = process.argv.includes('--manual');

const agent = new https.Agent({ rejectUnauthorized: false });
const delay = ms => new Promise(r => setTimeout(r, ms));

// ==========================================
// 🕐 ট্রেডিং আওয়ার চেক (শুধু অটো রানের জন্য)
// ==========================================
function isTradingHours() {
    if (IS_MANUAL_RUN) return true; // ম্যানুয়াল রানে সব সময় রান করবে

    const now = new Date();
    const bdTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const hours = bdTime.getUTCHours();
    const minutes = bdTime.getUTCMinutes();
    const currentMinutes = hours * 60 + minutes;
    const startMinutes = 9 * 60 + 30;
    const endMinutes = 15 * 60 + 0; // ৩:০০ PM

    // রবি (0) থেকে বৃহস্পতি (4)
    const day = bdTime.getUTCDay();
    const isWeekday = day >= 0 && day <= 4;

    return isWeekday && currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

// ==========================================
// 📡 Supabase REST API-তে আপসার্ট
// ==========================================
async function upsertToSupabase(table, record, conflictKey = null) {
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
        console.warn(`⚠️ অপ্রত্যাশিত স্ট্যাটাস (${table}):`, response.status);
        return false;
    } catch (err) {
        console.error(`❌ আপসার্ট ব্যর্থ (${table}):`, err.message);
        return false;
    }
}

// ==========================================
// 📡 DSEX ইনডেক্স স্ক্র্যাপ
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
        let saved = 0;
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
                                if (success) { console.log(`✅ DSEX ${name}: ${value}`); saved++; }
                            });
                    }
                }
            }
        });
        if (saved === 0) console.warn('⚠️ DSEX পাওয়া যায়নি।');
    } catch (err) {
        console.error('❌ DSEX স্ক্র্যাপ ব্যর্থ:', err.message);
    }
}

// ==========================================
// 📡 DSE-র লাইভ ডেটা (একটি টিকার জন্য)
// ==========================================
async function scrapeDSELiveData(ticker, todayDate) {
    const url = `https://dsebd.org/displayCompany.php?name=${ticker}`;
    try {
        const { data } = await axios.get(url, {
            httpsAgent: agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });

        const $ = cheerio.load(data);
        let info = {
            ticker: ticker,
            date: todayDate,
            ltp: null,
            high: null,
            low: null,
            volume: null,
            change: null,
            change_percent: null,
            updated_at: new Date().toISOString()
        };

        // DSE ওয়েবসাইটের টেবিল পার্সিং
        $('table tr').each((i, el) => {
            const cols = $(el).find('td');
            if (cols.length >= 2) {
                const label = $(cols[0]).text().trim().toLowerCase();
                const value = $(cols[1]).text().trim();
                if (label.includes('ltp') || label.includes('last trade price')) {
                    info.ltp = parseFloat(value) || null;
                } else if (label.includes('high')) {
                    info.high = parseFloat(value) || null;
                } else if (label.includes('low')) {
                    info.low = parseFloat(value) || null;
                } else if (label.includes('volume')) {
                    info.volume = parseInt(value.replace(/,/g, '')) || null;
                } else if (label.includes('change')) {
                    const changeParts = value.split('(');
                    info.change = changeParts[0].trim();
                    if (changeParts.length > 1) {
                        info.change_percent = changeParts[1].replace(')', '').trim();
                    }
                }
            }
        });

        // dse_daily_data-তে আপসার্ট (লাইভ ডেটা)
        const success = await upsertToSupabase('dse_daily_data', info);
        if (success) {
            console.log(`✅ DSE Live: ${ticker} -> LTP: ${info.ltp}`);
        }

        // যদি ক্লোজিং টাইম (বিকাল ৩:০০) হয়, তাহলে dse_closing_prices-এ সেভ করুন
        const now = new Date();
        const bdTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
        const hours = bdTime.getUTCHours();
        const minutes = bdTime.getUTCMinutes();
        // ৩:০০ টা বা তার পরে (শেষ স্ক্র্যাপ)
        if (hours >= 15 && minutes >= 0 && info.ltp) {
            const closingInfo = {
                ticker: ticker,
                date: todayDate,
                ltp: info.ltp,
                high: info.high,
                low: info.low,
                volume: info.volume,
                change: info.change,
                change_percent: info.change_percent,
                updated_at: new Date().toISOString()
            };
            await upsertToSupabase('dse_closing_prices', closingInfo);
            console.log(`✅ DSE Closing: ${ticker} -> LTP: ${info.ltp}`);
        }

    } catch (err) {
        console.error(`❌ DSE স্ক্র্যাপ ব্যর্থ (${ticker}):`, err.message);
    }
}

// ==========================================
// 📡 DSE API থেকে ডিভিডেন্ড (ইতিমধ্যে আছে)
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
// 📡 DSE কোম্পানি লিস্ট ফেচ
// ==========================================
async function fetchDSECompanyList() {
    console.log("📡 DSE ওয়েবসাইট থেকে কোম্পানির তালিকা আনা হচ্ছে...");
    const listUrl = "https://dsebd.org/listed_companies.php";
    try {
        const { data } = await axios.get(listUrl, {
            httpsAgent: agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        const $ = cheerio.load(data);
        const tickers = [];
        $('table tr').each((i, el) => {
            if (i === 0) return;
            const cols = $(el).find('td');
            if (cols.length >= 2) {
                const ticker = $(cols[1]).text().trim();
                if (ticker && !tickers.includes(ticker)) {
                    tickers.push(ticker);
                }
            }
        });
        if (tickers.length === 0) throw new Error('No tickers found');
        return tickers;
    } catch (err) {
        console.error("❌ DSE কোম্পানি তালিকা আনা ব্যর্থ:", err.message);
        console.log("⚠️ ব্যাকআপ লিস্ট ব্যবহার করছি...");
        return ["ACI", "BEXIMCO", "BATBC", "GP", "SQURPHARMA", "ROBI", "UNILEVERCL", "IFIC", "ISLAMIBANK", "PUBALIBANK"];
    }
}

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================
async function startScraper() {
    // অটো রানে ট্রেডিং আওয়ার চেক করুন
    if (!IS_MANUAL_RUN && !isTradingHours()) {
        console.log(`⏳ অটো রান ট্রেডিং আওয়ারের বাইরে। স্কিপ করছি।`);
        process.exit(0);
    }

    console.log(`🕐 ${new Date().toISOString()} - DSE স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    // ১. DSEX ইনডেক্স
    await scrapeDSEIndices(todayDate);
    await delay(2000);

    // ২. কোম্পানি লিস্ট
    const tickers = await fetchDSECompanyList();
    console.log(`📊 মোট ${tickers.length}টি টিকার পাওয়া গেছে।`);

    // ৩. লাইভ ডেটা স্ক্র্যাপ
    const chunkSize = 10;
    for (let i = 0; i < tickers.length; i += chunkSize) {
        const chunk = tickers.slice(i, i + chunkSize);
        console.log(`📡 DSE লাইভ প্রসেসিং ${i+1}-${Math.min(i+chunkSize, tickers.length)}/${tickers.length}`);
        await Promise.all(chunk.map(ticker => scrapeDSELiveData(ticker, todayDate)));
        await delay(500);
    }

    // ৪. ডিভিডেন্ড ডেটা (শুধু কয়েকটি টিকার জন্য)
    console.log("📡 DSE ডিভিডেন্ড তথ্য সংগ্রহ...");
    const divCompanies = tickers.slice(0, 20); // সীমিত সংখ্যক
    const divChunkSize = 5;
    for (let i = 0; i < divCompanies.length; i += divChunkSize) {
        const chunk = divCompanies.slice(i, i + divChunkSize);
        console.log(`⏳ [${i+1}-${Math.min(i+divChunkSize, divCompanies.length)}/${divCompanies.length}]`);
        await Promise.all(chunk.map(code => fetchFromDSEApi(code, todayDate)));
        await delay(1000);
    }

    console.log('✅ DSE স্ক্র্যাপিং সম্পন্ন!');
}

// ==========================================
// 🔥 রান
// ==========================================
startScraper().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
