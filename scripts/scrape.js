// scripts/scrape.js
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ==========================================
// 📌 কনফিগারেশন
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 10;
const DRY_RUN = process.argv.includes('--dry-run');

// 🔁 মাল্টিপল API এন্ডপয়েন্ট (একটা কাজ না করলে অন্যটা চেষ্টা করবে)
const API_ENDPOINTS = [
    process.env.SCRAPER_API || 'https://dse-scraper.vercel.app/api',
    'https://dse-scraper.vercel.app/api',  // ফ্যালব্যাক
];

// ==========================================
// 📌 স্টক লিস্ট লোড
// ==========================================
const STOCKS_FILE = path.join(__dirname, '../data/stocks.json');
let stockList = [];

try {
    if (fs.existsSync(STOCKS_FILE)) {
        const raw = fs.readFileSync(STOCKS_FILE, 'utf8');
        stockList = JSON.parse(raw);
        console.log(`✅ ${stockList.length} stocks loaded from ${STOCKS_FILE}`);
    } else {
        console.error(`❌ Stocks file not found: ${STOCKS_FILE}`);
        process.exit(1);
    }
} catch (err) {
    console.error('❌ Error loading stocks:', err.message);
    process.exit(1);
}

// ==========================================
// 📌 Supabase ক্লায়েন্ট (WebSocket ফিক্স সহ)
// ==========================================
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
}

// WebSocket সমর্থন নাই বলে সরাসরি REST API ব্যবহার করছি
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { enabled: false }  // 👈 WebSocket বন্ধ করে দিচ্ছি
});

// ==========================================
// 📡 স্ক্র্যাপার ফাংশন (Retry সহ)
// ==========================================

async function fetchWithRetry(url, options = {}, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(url, { 
                timeout: 15000,
                ...options,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    ...options.headers
                }
            });
            
            // চেক করুন response JSON কিনা
            if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE')) {
                throw new Error('Received HTML instead of JSON - API may be down');
            }
            
            return response;
        } catch (err) {
            console.warn(`⚠️ Attempt ${i+1}/${retries} failed:`, err.message);
            if (i === retries - 1) throw err;
            // ব্যাকঅফ: ১সে, ২সে, ৩সে
            await new Promise(r => setTimeout(r, (i+1) * 1000));
        }
    }
}

async function fetchStockData(ticker) {
    let lastError = null;

    // সব API এন্ডপয়েন্ট চেষ্টা করি
    for (const baseUrl of API_ENDPOINTS) {
        try {
            const url = `${baseUrl}?symbol=${encodeURIComponent(ticker)}`;
            const response = await fetchWithRetry(url);
            const data = response.data;

            if (!data || !data.ltp || parseFloat(data.ltp) <= 0) {
                console.warn(`⚠️ No valid data for ${ticker} from ${baseUrl}`);
                continue;
            }

            return {
                ticker: ticker,
                date: new Date().toISOString().split('T')[0],
                ltp: parseFloat(data.ltp) || 0,
                high: parseFloat(data.high) || 0,
                low: parseFloat(data.low) || 0,
                volume: parseInt(data.volume) || 0,
                category: data.category || null,
                dividend: data.dividend || null,
                record_date: data.record_date || null,
                updated_at: new Date().toISOString()
            };
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ Failed to fetch ${ticker} from ${baseUrl}:`, err.message);
        }
    }

    // সব চেষ্টা ব্যর্থ হলে null রিটার্ন
    console.warn(`❌ All attempts failed for ${ticker}`);
    return null;
}

async function fetchDSEXIndex() {
    for (const baseUrl of API_ENDPOINTS) {
        try {
            // চেষ্টা ১: /index এন্ডপয়েন্ট
            const url1 = `${baseUrl}/index`;
            const response1 = await fetchWithRetry(url1, {}, 2);
            if (response1.data && response1.data.dsex) {
                return {
                    date: new Date().toISOString().split('T')[0],
                    value: parseFloat(response1.data.dsex) || 0,
                    updated_at: new Date().toISOString()
                };
            }
        } catch (err) {
            console.warn('⚠️ DSEX /index failed, trying alternative...', err.message);
        }

        try {
            // চেষ্টা ২: main API থেকে dsex বের করা (যদি থাকে)
            const url2 = `${baseUrl}?symbol=DSEX`;
            const response2 = await fetchWithRetry(url2, {}, 2);
            if (response2.data && response2.data.ltp) {
                return {
                    date: new Date().toISOString().split('T')[0],
                    value: parseFloat(response2.data.ltp) || 0,
                    updated_at: new Date().toISOString()
                };
            }
        } catch (err) {
            console.warn('⚠️ DSEX alternative failed:', err.message);
        }
    }
    
    console.warn('⚠️ Could not fetch DSEX index from any source');
    return null;
}

async function upsertMarketData(records) {
    if (DRY_RUN) {
        console.log('🔍 DRY RUN: Would upsert', records.length, 'records');
        return { success: records.length, errors: 0 };
    }

    if (records.length === 0) return { success: 0, errors: 0 };

    try {
        const { error } = await supabase
            .from('market_prices')
            .upsert(records, {
                onConflict: 'ticker, date',
                ignoreDuplicates: false
            });

        if (error) {
            console.error('❌ Upsert error:', error.message);
            return { success: 0, errors: records.length };
        }

        return { success: records.length, errors: 0 };
    } catch (err) {
        console.error('❌ Upsert exception:', err.message);
        return { success: 0, errors: records.length };
    }
}

// ==========================================
// 🚀 মেইন ফাংশন
// ==========================================

async function runScraper() {
    console.log(`🕐 ${new Date().toISOString()} - Starting DSE scraper...`);
    console.log(`📊 Total stocks: ${stockList.length}`);
    console.log(`🔗 Using API endpoints: ${API_ENDPOINTS.join(', ')}`);

    let totalSuccess = 0;
    let totalErrors = 0;

    // স্টক ডেটা ব্যাচে প্রসেস
    for (let i = 0; i < stockList.length; i += BATCH_SIZE) {
        const batch = stockList.slice(i, i + BATCH_SIZE);
        console.log(`📡 Fetching batch ${Math.floor(i/BATCH_SIZE)+1}/${Math.ceil(stockList.length/BATCH_SIZE)} (${batch.length} stocks)`);

        const promises = batch.map(ticker => fetchStockData(ticker));
        const batchResults = await Promise.allSettled(promises);

        const validRecords = [];
        for (const result of batchResults) {
            if (result.status === 'fulfilled' && result.value !== null) {
                validRecords.push(result.value);
            } else {
                totalErrors++;
            }
        }

        if (validRecords.length > 0) {
            const upsertResult = await upsertMarketData(validRecords);
            totalSuccess += upsertResult.success;
            totalErrors += upsertResult.errors;
        }

        if (i + BATCH_SIZE < stockList.length) {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }

    // DSEX ইনডেক্স
    console.log('📈 Fetching DSEX index...');
    const dsexData = await fetchDSEXIndex();
    if (dsexData) {
        const dsexResult = await upsertDSEX(dsexData);
        totalSuccess += dsexResult.success;
        totalErrors += dsexResult.errors;
    } else {
        console.log('ℹ️ No DSEX data fetched (skipping)');
    }

    console.log('✅ Scrape completed!');
    console.log(`📊 Success: ${totalSuccess}, Errors: ${totalErrors}`);
    console.log(`🕐 ${new Date().toISOString()}`);

    if (totalErrors > 0) {
        process.exit(1);
    }
}

async function upsertDSEX(record) {
    if (DRY_RUN) {
        console.log('🔍 DRY RUN: Would upsert DSEX:', record);
        return { success: record ? 1 : 0, errors: 0 };
    }
    if (!record) return { success: 0, errors: 0 };

    try {
        const { error } = await supabase
            .from('dsex_index')
            .upsert(record, { onConflict: 'date' });

        if (error) {
            console.error('❌ DSEX upsert error:', error.message);
            return { success: 0, errors: 1 };
        }
        return { success: 1, errors: 0 };
    } catch (err) {
        console.error('❌ DSEX upsert exception:', err.message);
        return { success: 0, errors: 1 };
    }
}

// ==========================================
// 🔥 রান
// ==========================================

runScraper().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
