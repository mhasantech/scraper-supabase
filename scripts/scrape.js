// scripts/scrape.js
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 📌 কনফিগারেশন
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SCRAPER_API = process.env.SCRAPER_API || 'https://dse-scraper.vercel.app/api';
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 10;
const DRY_RUN = process.argv.includes('--dry-run');

// 📌 স্টক লিস্ট লোড (আপনার dseStocks অ্যারে)
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

// 📌 Supabase ক্লায়েন্ট
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in environment');
    process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ==========================================
// 📡 স্ক্র্যাপার ফাংশন
// ==========================================

async function fetchStockData(ticker) {
    try {
        const url = `${SCRAPER_API}?symbol=${encodeURIComponent(ticker)}`;
        const response = await axios.get(url, { timeout: 10000 });
        const data = response.data;

        if (!data || !data.ltp || parseFloat(data.ltp) <= 0) {
            console.warn(`⚠️ No valid data for ${ticker}`);
            return null;
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
        console.warn(`⚠️ Failed to fetch ${ticker}:`, err.message);
        return null;
    }
}

async function fetchDSEXIndex() {
    try {
        // DSEX ইনডেক্স ডেটা আনতে পারেন dse-scraper API থেকে, অথবা অন্য কোনো সোর্স
        // যদি API না থাকে, তাহলে আমরা ডেটাবেস থেকে সর্বশেষ মানও ব্যবহার করতে পারি
        const response = await axios.get(`${SCRAPER_API}/index`, { timeout: 10000 });
        if (response.data && response.data.dsex) {
            return {
                date: new Date().toISOString().split('T')[0],
                value: parseFloat(response.data.dsex) || 0,
                updated_at: new Date().toISOString()
            };
        }
        return null;
    } catch (err) {
        console.warn('⚠️ Failed to fetch DSEX index:', err.message);
        return null;
    }
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

async function upsertDSEX(record) {
    if (DRY_RUN) {
        console.log('🔍 DRY RUN: Would upsert DSEX:', record);
        return { success: record ? 1 : 0, errors: 0 };
    }

    if (!record) return { success: 0, errors: 0 };

    try {
        const { error } = await supabase
            .from('dsex_index')
            .upsert(record, {
                onConflict: 'date',
                ignoreDuplicates: false
            });

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
// 🚀 মেইন ফাংশন (রান)
// ==========================================

async function runScraper() {
    console.log(`🕐 ${new Date().toISOString()} - Starting DSE scraper...`);
    console.log(`📊 Total stocks: ${stockList.length}`);

    let totalSuccess = 0;
    let totalErrors = 0;
    const results = [];

    // 📌 স্টক ডেটা ব্যাচে প্রসেস
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

        // রেট লিমিট এড়াতে ১ সেকেন্ড বিরতি
        if (i + BATCH_SIZE < stockList.length) {
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    // 📌 DSEX ইনডেক্স (যদি পাওয়া যায়)
    console.log('📈 Fetching DSEX index...');
    const dsexData = await fetchDSEXIndex();
    if (dsexData) {
        const dsexResult = await upsertDSEX(dsexData);
        totalSuccess += dsexResult.success;
        totalErrors += dsexResult.errors;
    } else {
        console.log('ℹ️ No DSEX data fetched (skipping)');
    }

    // 📊 সারাংশ
    console.log('✅ Scrape completed!');
    console.log(`📊 Success: ${totalSuccess}, Errors: ${totalErrors}`);
    console.log(`🕐 ${new Date().toISOString()}`);

    if (totalErrors > 0) {
        process.exit(1); // GitHub Actions-এ ফেইল দেখাতে
    }
}

// ==========================================
// 🔥 রান
// ==========================================

runScraper().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
