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
// 📡 Supabase REST API-তে আপসার্ট (409 হ্যান্ডেল সহ)
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
        if (err.response && err.response.status === 409) {
            console.log(`ℹ️ ডুপ্লিকেট পাওয়া গেছে (${record.code || record.ticker}), ইগনোর করা হচ্ছে।`);
            return true;
        }
        console.error(`❌ আপসার্ট ব্যর্থ (${table}):`, err.message);
        return false;
    }
}

// ==========================================
// 📡 DSE-র টিকার লিস্ট আনা (বিকল্প পদ্ধতি)
// ==========================================
async function getDSETickerList() {
    // পদ্ধতি ১: মূল লিস্টিং পেজ (যা 404 দিচ্ছে)
    try {
        const listUrl = "https://dsebd.org/listed_companies.php";
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
        if (tickers.length > 0) return tickers;
    } catch (e) {
        console.warn('⚠️ লিস্টিং পেজ ব্যর্থ, ব্যাকআপ ব্যবহার করছি...');
    }

    // পদ্ধতি ২: DSE API থেকে ডায়নামিক লিস্ট (যদি থাকে)
    try {
        const apiUrl = "https://dsebd.org/api/listed_securities";
        const { data } = await axios.get(apiUrl, { timeout: 10000 });
        if (data && data.length > 0) {
            return data.map(item => item.tradingCode || item.code).filter(Boolean);
        }
    } catch (e) {}

    // পদ্ধতি ৩: ব্যাকআপ লিস্ট (সব DSE টিকার)
    console.log('📋 ব্যাকআপ লিস্ট ব্যবহার করছি...');
    return [
        "ACI", "BATBC", "BEXIMCO", "GP", "ROBI", "SQURPHARMA",
        "UNILEVERCL", "IFIC", "PUBALIBANK", "ISLAMIBANK", "BRACBANK",
        "CITYBANK", "DUTCHBANGL", "EBL", "MTB", "NCCBANK",
        "NRBBANK", "UCB", "UTTARABANK", "IDLC", "IPDC",
        "BSRMSTEEL", "SSSTEEL", "MEGHNACEM", "HEIDELBCEM",
        "BERGERPBL", "MARICO", "RENATA", "BEACONPHAR", "IBNSINA"
    ];
}

// ==========================================
// 📡 DSE লাইভ ডেটা স্ক্র্যাপ (সঠিক URL ও পার্সিং)
// ==========================================
async function scrapeDSELiveData(ticker, todayDate) {
    // DSE-র কোম্পানি ডিটেইল পেজ (সঠিক URL)
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
            ltp: 0,
            high: 0,
            low: 0,
            volume: 0,
            change: 0,
            change_percent: 0,
            updated_at: new Date().toISOString()
        };

        // DSE পেজের HTML থেকে ডেটা বের করা (নির্দিষ্ট ক্লাস অনুযায়ী)
        // উদাহরণ: "Last Trade Price", "High", "Low" ইত্যাদি
        $('table tr').each((i, el) => {
            const cols = $(el).find('td');
            if (cols.length >= 2) {
                const label = $(cols[0]).text().trim().toLowerCase();
                const value = $(cols[1]).text().trim().replace(/,/g, '');
                if (label.includes('last trade price') || label.includes('ltp')) {
                    info.ltp = parseFloat(value) || 0;
                } else if (label.includes('high')) {
                    info.high = parseFloat(value) || 0;
                } else if (label.includes('low')) {
                    info.low = parseFloat(value) || 0;
                } else if (label.includes('volume')) {
                    info.volume = parseInt(value) || 0;
                } else if (label.includes('change')) {
                    const clean = value.replace(/[()%]/g, '').trim();
                    const parts = clean.split(' ');
                    info.change = parseFloat(parts[0]) || 0;
                    if (parts.length > 1) {
                        info.change_percent = parseFloat(parts[1]) || 0;
                    }
                }
            }
        });

        // যদি LTP না পাওয়া যায়, তাহলে HTML-এর অন্য অংশে খোঁজা
        if (info.ltp === 0) {
            $('span').each((i, el) => {
                const text = $(el).text().trim();
                if (text.includes('LTP') || text.includes('Last Trade')) {
                    const parent = $(el).parent();
                    const val = parent.find('span:last-child').text().trim().replace(/,/g, '');
                    info.ltp = parseFloat(val) || 0;
                }
            });
        }

        // আপসার্ট (dse_live_data)
        const success = await upsertToSupabase('dse_live_data', info);
        if (success && info.ltp > 0) {
            console.log(`✅ DSE Live: ${ticker} -> LTP: ${info.ltp}`);
        } else if (success) {
            console.log(`ℹ️ DSE Live: ${ticker} -> LTP পাওয়া যায়নি (০)`);
        }

        // 🆕 আজকের ক্লোজিং ডেটা সেভ করার জন্য (শুধু যদি LTP > 0)
        if (info.ltp > 0) {
            const closingRecord = {
                ticker: ticker,
                date: todayDate,
                ltp: info.ltp,
                high: info.high,
                low: info.low,
                volume: info.volume,
                updated_at: new Date().toISOString()
            };
            await upsertToSupabase('dse_closing_prices', closingRecord);
        }

    } catch (err) {
        console.error(`❌ DSE লাইভ স্ক্র্যাপ ব্যর্থ (${ticker}):`, err.message);
    }
}

// ==========================================
// 📡 DSEX ইনডেক্স স্ক্র্যাপ (আগের মতো)
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
// 📡 DSE API থেকে ডিভিডেন্ড (409 ফিক্স সহ)
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
    const isManual = process.argv.includes('--manual');
    console.log(`🕐 ${new Date().toISOString()} - DSE স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    // ১. DSEX ইনডেক্স
    await scrapeDSEIndices(todayDate);
    await new Promise(r => setTimeout(r, 2000));

    // ২. টিকার লিস্ট
    const tickers = await getDSETickerList();
    console.log(`📊 মোট ${tickers.length}টি টিকার পাওয়া গেছে।`);

    // ৩. লাইভ ডেটা স্ক্র্যাপ (ব্যাচে)
    const chunkSize = isManual ? 3 : 10;
    for (let i = 0; i < tickers.length; i += chunkSize) {
        const chunk = tickers.slice(i, i + chunkSize);
        console.log(`📡 DSE লাইভ প্রসেসিং ${i+1}-${Math.min(i+chunkSize, tickers.length)}/${tickers.length}`);
        await Promise.all(chunk.map(ticker => scrapeDSELiveData(ticker, todayDate)));
        await new Promise(r => setTimeout(r, isManual ? 2000 : 500));
    }

    // ৪. ডিভিডেন্ড ডেটা (শুধু প্রথম ২০টি, সময় বাঁচাতে)
    const divCompanies = tickers.slice(0, 20);
    console.log(`📡 DSE ডিভিডেন্ড তথ্য সংগ্রহ (${divCompanies.length}টি)...`);
    const divChunk = isManual ? 2 : 5;
    for (let i = 0; i < divCompanies.length; i += divChunk) {
        const chunk = divCompanies.slice(i, i + divChunk);
        console.log(`⏳ [${i+1}-${Math.min(i+divChunk, divCompanies.length)}/${divCompanies.length}]`);
        await Promise.all(chunk.map(code => fetchFromDSEApi(code, todayDate)));
        await new Promise(r => setTimeout(r, isManual ? 2000 : 1000));
    }

    console.log('✅ DSE স্ক্র্যাপিং সম্পন্ন!');
}

// ==========================================
// 🔥 রান
// ==========================================
if (require.main === module) {
    startScraper().catch(err => {
        console.error('❌ Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { startScraper };
