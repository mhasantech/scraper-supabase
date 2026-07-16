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
        if (err.response && err.response.status === 409) {
            console.log(`ℹ️ ডুপ্লিকেট (${record.ticker}), ইগনোর।`);
            return true;
        }
        console.error(`❌ আপসার্ট ব্যর্থ:`, err.message);
        return false;
    }
}

// ==========================================
// 📡 DSE লেটেস্ট শেয়ার প্রাইস স্ক্র্যাপ
// ==========================================
async function scrapeDSELatestPrices() {
    const url = 'https://dsebd.org/latest_share_price_scroll_l.php';
    console.log(`📡 স্ক্র্যাপিং: ${url}`);

    try {
        const { data } = await axios.get(url, {
            httpsAgent: agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 20000
        });

        const $ = cheerio.load(data);
        const todayDate = new Date().toISOString().split('T')[0];
        let records = [];
        let successCount = 0;

        // 🔍 টেবিলের সারি খোঁজা (screenshot অনুযায়ী)
        // টেবিলের হেডার: TRADING CODE, LTP, HIGH, LOW, CLOSEP, YCP
        $('table tr').each((index, element) => {
            // হেডার বাদ দিন (প্রথম সারি)
            if (index === 0) return;

            const cols = $(element).find('td');
            if (cols.length >= 6) {
                const ticker = $(cols[1]).text().trim(); // TRADING CODE
                const ltp = parseFloat($(cols[2]).text().trim()) || 0;
                const high = parseFloat($(cols[3]).text().trim()) || 0;
                const low = parseFloat($(cols[4]).text().trim()) || 0;
                const close = parseFloat($(cols[5]).text().trim()) || 0;
                const ycp = parseFloat($(cols[6]).text().trim()) || 0;

                if (ticker && ltp > 0) {
                    const record = {
                        ticker: ticker,
                        date: todayDate,
                        ltp: ltp,
                        high: high,
                        low: low,
                        close: close,
                        ycp: ycp,
                        updated_at: new Date().toISOString()
                    };
                    records.push(record);
                }
            }
        });

        // 📊 যদি কোনো ডেটা না পাওয়া যায়, তাহলে অন্য সিলেক্টর চেষ্টা
        if (records.length === 0) {
            console.log('🔄 প্রথম সিলেক্টরে ডেটা পাওয়া যায়নি, ব্যাকআপ সিলেক্টর চেষ্টা...');
            $('tr').each((index, element) => {
                if (index === 0) return;
                const cols = $(element).find('td');
                if (cols.length >= 6) {
                    const ticker = $(cols[0]).text().trim();
                    const ltp = parseFloat($(cols[1]).text().trim()) || 0;
                    if (ticker && ltp > 0) {
                        records.push({
                            ticker: ticker,
                            date: todayDate,
                            ltp: ltp,
                            high: parseFloat($(cols[2]).text().trim()) || 0,
                            low: parseFloat($(cols[3]).text().trim()) || 0,
                            close: parseFloat($(cols[4]).text().trim()) || 0,
                            ycp: parseFloat($(cols[5]).text().trim()) || 0,
                            updated_at: new Date().toISOString()
                        });
                    }
                }
            });
        }

        console.log(`📊 মোট ${records.length}টি রেকর্ড পাওয়া গেছে।`);

        // 💾 Supabase-এ সেভ (dse_live_data ও dse_closing_prices)
        for (const record of records) {
            // ১. লাইভ ডেটা
            const liveRecord = {
                ticker: record.ticker,
                date: record.date,
                ltp: record.ltp,
                high: record.high,
                low: record.low,
                volume: 0,
                change: record.ltp - record.ycp,
                change_percent: record.ycp > 0 ? ((record.ltp - record.ycp) / record.ycp) * 100 : 0,
                updated_at: record.updated_at
            };
            const liveSaved = await upsertToSupabase('dse_live_data', liveRecord);
            if (liveSaved) {
                console.log(`✅ DSE Live: ${record.ticker} -> LTP: ${record.ltp}`);
                successCount++;
            }

            // ২. ক্লোজিং ডেটা (শুধু LTP, High, Low)
            const closingRecord = {
                ticker: record.ticker,
                date: record.date,
                ltp: record.ltp,
                high: record.high,
                low: record.low,
                volume: 0,
                updated_at: record.updated_at
            };
            await upsertToSupabase('dse_closing_prices', closingRecord);
        }

        console.log(`✅ DSE স্ক্র্যাপ সম্পন্ন! সফল: ${successCount}/${records.length}`);
        return records;

    } catch (err) {
        console.error('❌ DSE স্ক্র্যাপ ব্যর্থ:', err.message);
        if (err.response) {
            console.error('📄 রেসপন্স স্ট্যাটাস:', err.response.status);
        }
        return [];
    }
}

// ==========================================
// 📡 DSEX ইনডেক্স (আগের মতো)
// ==========================================
async function scrapeDSEIndices(todayDate) {
    console.log("📊 DSEX ইনডেক্স সংগ্রহ...");
    try {
        const homeUrl = "https://dsebd.org/index.php";
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
// 🚀 মেইন ফাংশন
// ==========================================
async function startScraper() {
    const isManual = process.argv.includes('--manual');
    console.log(`🕐 ${new Date().toISOString()} - DSE স্ক্র্যাপ শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    // ১. DSEX ইনডেক্স
    await scrapeDSEIndices(todayDate);
    await new Promise(r => setTimeout(r, 1000));

    // ২. লেটেস্ট শেয়ার প্রাইস
    await scrapeDSELatestPrices();

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
