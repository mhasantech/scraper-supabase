// scripts/dse_scraper.js
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
// 📡 Supabase REST API-তে আপসার্ট
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
// 📡 DSE-র লাইভ মার্কেট ডেটা স্ক্র্যাপ (প্রতিটি কোম্পানির)
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
            ltp: "N/A",
            high: "N/A",
            low: "N/A",
            volume: "N/A",
            change: "N/A",
            change_percent: "N/A",
            updated_at: new Date().toISOString()
        };

        // DSE ওয়েবসাইটের টেবিল পার্সিং (নির্দিষ্ট ক্লাস/আইডি অনুযায়ী)
        $('table tr').each((i, el) => {
            const cols = $(el).find('td');
            if (cols.length >= 2) {
                const label = $(cols[0]).text().trim().toLowerCase();
                const value = $(cols[1]).text().trim();
                if (label.includes('ltp') || label.includes('last trade price')) {
                    info.ltp = value;
                } else if (label.includes('high')) {
                    info.high = value;
                } else if (label.includes('low')) {
                    info.low = value;
                } else if (label.includes('volume')) {
                    info.volume = value;
                } else if (label.includes('change')) {
                    const changeParts = value.split('(');
                    info.change = changeParts[0].trim();
                    if (changeParts.length > 1) {
                        info.change_percent = changeParts[1].replace(')', '').trim();
                    }
                }
            }
        });

        const success = await upsertToSupabase('dse_live_data', info);
        if (success) {
            console.log(`✅ DSE Live: ${ticker} -> LTP: ${info.ltp}`);
        }

    } catch (err) {
        console.error(`❌ DSE লাইভ স্ক্র্যাপ ব্যর্থ (${ticker}):`, err.message);
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
// 🚀 মেইন ফাংশন
// ==========================================
async function startScraper() {
    // বাংলাদেশ সময় চেক (ট্রেডিং আওয়ারের মধ্যে)
    const now = new Date();
    const bdTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    const hours = bdTime.getUTCHours();
    const minutes = bdTime.getUTCMinutes();
    const currentMinutes = hours * 60 + minutes;
    const startMinutes = 9 * 60 + 50;
    const endMinutes = 14 * 60 + 30;

    if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
        console.log(`⏳ ট্রেডিং আওয়ারের বাইরে। স্কিপ করছি।`);
        process.exit(0);
    }

    console.log(`🕐 ${new Date().toISOString()} - DSE স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    // ১. DSEX ইনডেক্স
    await scrapeDSEIndices(todayDate);
    await new Promise(r => setTimeout(r, 2000));

    // ২. DSE লাইভ ডেটা (DSE সাইট থেকে টিকার লিস্ট আনা)
    console.log("📡 DSE ওয়েবসাইট থেকে কোম্পানির তালিকা আনা হচ্ছে...");
    let tickers = [];
    try {
        const listUrl = "https://dsebd.org/listed_companies.php";
        const { data } = await axios.get(listUrl, {
            httpsAgent: agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 15000
        });
        const $ = cheerio.load(data);
        // ধরে নিচ্ছি টিকার নাম টেবিলের দ্বিতীয় কলামে আছে
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
    } catch (err) {
        console.error("❌ DSE কোম্পানি তালিকা আনা ব্যর্থ:", err.message);
        console.log("⚠️ ব্যাকআপ লিস্ট ব্যবহার করছি...");
        tickers = ["ACI", "BEXIMCO", "BATBC", "GP", "SQURPHARMA", "ROBI", "UNILEVERCL"]; // ব্যাকআপ
    }

    console.log(`📊 মোট ${tickers.length}টি টিকার পাওয়া গেছে।`);

    // ৩. লাইভ ডেটা স্ক্র্যাপ
    const chunkSize = 10;
    for (let i = 0; i < tickers.length; i += chunkSize) {
        const chunk = tickers.slice(i, i + chunkSize);
        console.log(`📡 DSE লাইভ প্রসেসিং ${i+1}-${Math.min(i+chunkSize, tickers.length)}/${tickers.length}`);
        await Promise.all(chunk.map(ticker => scrapeDSELiveData(ticker, todayDate)));
        await new Promise(r => setTimeout(r, 500));
    }

    // ৪. ডিভিডেন্ড ডেটা (ইতিমধ্যে আছে)
    console.log("📡 DSE ডিভিডেন্ড তথ্য সংগ্রহ...");
    let companies = [];
    try {
        // CSE ডেটা থেকে কোম্পানি নেওয়া (অথবা উপরের টিকার লিস্ট ব্যবহার)
        companies = tickers.slice(0, 20); // ডিভিডেন্ড API-তে বেশি টিকার জন্য সময় লাগতে পারে, তাই ২০টি নিলাম
    } catch (e) {
        companies = ["ACI", "BEXIMCO", "BATBC", "GP", "SQURPHARMA", "ROBI", "UNILEVERCL"];
    }

    console.log(`📊 মোট ${companies.length}টি কোম্পানির ডিভিডেন্ড আনা হচ্ছে...`);
    const divChunkSize = 5;
    for (let i = 0; i < companies.length; i += divChunkSize) {
        const chunk = companies.slice(i, i + divChunkSize);
        console.log(`⏳ [${i+1}-${Math.min(i+divChunkSize, companies.length)}/${companies.length}]`);
        await Promise.all(chunk.map(code => fetchFromDSEApi(code, todayDate)));
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log('✅ DSE স্ক্র্যাপিং সম্পন্ন!');
}

startScraper();
