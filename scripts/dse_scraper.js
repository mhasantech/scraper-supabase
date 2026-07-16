// scripts/dse_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');
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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { autoConnect: false }
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
// 📡 DSEX ইনডেক্স স্ক্র্যাপ
// ==========================================
async function scrapeDSEIndices(todayDate) {
    console.log("📊 DSEX ইনডেক্স সংগ্রহ করা হচ্ছে...");
    const homeUrl = "https://dsebd.org/index.php";

    try {
        const { data } = await axios.get(homeUrl, {
            httpsAgent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(data);
        let savedCount = 0;

        $('tr, .index-box, div.bg-blue-light').each((index, element) => {
            const rowText = $(element).text();
            if (rowText.includes('DSEX') || rowText.includes('DSES') || rowText.includes('D30')) {
                const cols = $(element).find('td');
                if (cols.length >= 3) {
                    let name = $(cols[0]).text().trim();
                    let value = $(cols[1]).text().trim();
                    let change = $(cols[2]).text().trim();
                    let changePercent = cols.length >= 4 ? $(cols[3]).text().trim() : "0.0%";

                    if (name.includes('DSEX')) name = 'DSEX';
                    else if (name.includes('DSES')) name = 'DSES';
                    else if (name.includes('D30')) name = 'D30';

                    if (value && !isNaN(parseFloat(value))) {
                        const record = {
                            index_name: name,
                            date: todayDate,
                            value: value,
                            change: change,
                            change_percent: changePercent,
                            updated_at: new Date().toISOString()
                        };

                        supabase
                            .from('dsex_index')
                            .upsert({ date: todayDate, value: parseFloat(value) }, { onConflict: 'date' })
                            .then(({ error }) => {
                                if (!error) {
                                    console.log(`✅ DSEX ${name}: ${value}`);
                                    savedCount++;
                                }
                            });
                    }
                }
            }
        });

        if (savedCount === 0) {
            console.warn("⚠️ DSEX ইনডেক্স পাওয়া যায়নি।");
        }

    } catch (err) {
        console.error("❌ DSEX স্ক্র্যাপ ব্যর্থ:", err.message);
    }
}

// ==========================================
// 📡 DSE API থেকে ডিভিডেন্ড তথ্য
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

            const { error } = await supabase
                .from('dse_dividend_data')
                .upsert(record, { onConflict: 'code, date' });

            if (error) {
                console.error(`❌ DSE API আপসার্ট ব্যর্থ (${companyCode}):`, error.message);
            } else {
                console.log(`✅ DSE DIV: ${companyCode} -> সেভ হয়েছে`);
            }
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
        console.log(`⏳ বর্তমান সময় ট্রেডিং আওয়ারের বাইরে। স্কিপ করছি।`);
        process.exit(0);
    }

    console.log(`🕐 ${new Date().toISOString()} - DSE স্ক্র্যাপিং শুরু...`);
    const todayDate = new Date().toISOString().split('T')[0];

    // DSEX ইনডেক্স
    await scrapeDSEIndices(todayDate);
    await delay(2000);

    // কোম্পানি তালিকা (CSE ডেটা থেকে বা ব্যাকআপ)
    let companies = [];
    try {
        const { data, error } = await supabase
            .from('cse_market_data')
            .select('code')
            .eq('date', todayDate);

        if (!error && data) {
            companies = data.map(row => row.code);
        }
    } catch (e) {}

    if (companies.length === 0) {
        console.warn("⚠️ আজকের CSE তালিকা পাওয়া যায়নি, ব্যাকআপ লিস্ট ব্যবহার করছি...");
        companies = ["UTTARABANK", "BDTHAI", "ACI", "BEXIMCO", "BATBC", "GP", "LHBL", "SQURPHARMA"];
    }

    console.log(`📊 মোট ${companies.length}টি কোম্পানির ডিভিডেন্ড আনা হচ্ছে...`);

    const chunkSize = 5;
    for (let i = 0; i < companies.length; i += chunkSize) {
        const chunk = companies.slice(i, i + chunkSize);
        console.log(`📡 প্রসেসিং ${i+1}-${Math.min(i+chunkSize, companies.length)}/${companies.length}`);
        await Promise.all(chunk.map(code => fetchFromDSEApi(code, todayDate)));
        await delay(1000);
    }

    console.log('✅ DSE স্ক্র্যাপিং সম্পন্ন!');
}

startScraper();
