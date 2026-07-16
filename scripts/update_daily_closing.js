// scripts/update_daily_closing.js
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('❌ Missing Supabase credentials');
    process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
    realtime: { autoConnect: false },
    fetch: (url, options) => fetch(url, { ...options, agent })
});

const today = new Date().toISOString().split('T')[0];

async function updateDailyClosing() {
    console.log(`📅 Updating daily closing prices for ${today}...`);

    // ১. আজকের সর্বশেষ ডেটা Supabase থেকে নিন (প্রতিটি টিকারের জন্য)
    const { data: latestData, error } = await supabase
        .from('cse_market_data')
        .select('code, ltp, high, low, volume, category, eps, pe_ratio, dividend, record_date')
        .order('date', { ascending: false });

    if (error) {
        console.error('❌ Error fetching latest data:', error);
        process.exit(1);
    }

    // ২. প্রতিটি টিকারের জন্য শুধু সর্বশেষ এন্ট্রি নিন (একাধিক থাকলে)
    const seen = new Set();
    const closingData = [];
    for (const row of latestData) {
        if (!seen.has(row.code)) {
            seen.add(row.code);
            closingData.push({
                ticker: row.code,
                date: today,
                ltp: row.ltp || 0,
                high: row.high || 0,
                low: row.low || 0,
                volume: row.volume || 0,
                category: row.category || null,
                eps: row.eps || null,
                pe_ratio: row.pe_ratio || null,
                dividend: row.dividend || null,
                record_date: row.record_date || null,
                updated_at: new Date().toISOString()
            });
        }
    }

    if (closingData.length === 0) {
        console.log('ℹ️ No data found for today.');
        return;
    }

    console.log(`📊 ${closingData.length} stocks will be saved as closing prices.`);

    // ৩. daily_closing_prices টেবিলে আপসার্ট করুন (ব্যাচে)
    const batchSize = 50;
    let success = 0, errors = 0;

    for (let i = 0; i < closingData.length; i += batchSize) {
        const batch = closingData.slice(i, i + batchSize);
        const { error: upsertError } = await supabase
            .from('daily_closing_prices')
            .upsert(batch, { onConflict: 'ticker, date' });

        if (upsertError) {
            console.error('❌ Upsert error:', upsertError);
            errors += batch.length;
        } else {
            success += batch.length;
        }
    }

    console.log(`✅ Daily closing update complete. Success: ${success}, Errors: ${errors}`);
}

updateDailyClosing().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
