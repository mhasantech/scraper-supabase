// scripts/dsex_scraper.js
const axios = require('axios');
const cheerio = require('cheerio');
const https = require('https');

const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });

// ==========================================
// 📡 DSEX আপসার্ট (on_conflict index_name,date)
// ==========================================
async function upsertToSupabase(table, record) {
    const conflictColumns = 'index_name,date';
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
        if ([200, 201, 202, 204].includes(response.status)) {
            return true;
        }
        console.warn(`⚠️ অজানা স্ট্যাটাস ${response.status} (${table})`);
        return false;
    } catch (err) {
        if (err.response && err.response.status === 409) {
            console.error(`❌ কনফ্লিক্ট! on_conflict কাজ করছে না (${record.index_name})`);
            return false;
        }
        console.error(`❌ আপসার্ট ব্যর্থ (${table}):`, err.message);
        if (err.response) console.error('📄 রেসপন্স:', err.response.data);
        return false;
    }
}

// ==========================================
// 📡 DSEX ইনডেক্স স্ক্র্যাপ
// ==========================================
async function scrapeDSEIndices() {
    const url = 'https://www.dsebd.org/';
    console.log(`📡 স্ক্র্যাপিং: ${url}`);

    try {
        const { data } = await axios.get(url, {
            httpsAgent: agent,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            },
            timeout: 20000
        });

        const $ = cheerio.load(data);
        const todayDate = new Date().toISOString().split('T')[0];
        let results = [];

        $('table tr').each((index, element) => {
            const cols = $(element).find('td');
            if (cols.length >= 2) {
                const label = $(cols[0]).text().trim();
                const value = $(cols[1]).text().trim();

                if (label.includes('DSEX Index') || label.includes('DSEX')) {
                    const num = parseFloat(value) || 0;
                    if (num > 0) results.push({ name: 'DSEX', value: num });
                } else if (label.includes('DSES Index') || label.includes('DSES')) {
                    const num = parseFloat(value) || 0;
                    if (num > 0) results.push({ name: 'DSES', value: num });
                } else if (label.includes('DS30 Index') || label.includes('DS30')) {
                    const num = parseFloat(value) || 0;
                    if (num > 0) results.push({ name: 'DS30', value: num });
                }
            }
        });

        if (results.length === 0) {
            console.log('🔄 টেবিলে পাওয়া যায়নি, ডিভ বা স্প্যান সিলেক্টর চেষ্টা...');
            $('div, span, p').each((index, element) => {
                const text = $(element).text().trim();
                if (text.includes('DSEX') && text.includes('Index')) {
                    const match = text.match(/DSEX\s*Index\s*[:.]?\s*([\d,]+\.?[\d]*)/i);
                    if (match) {
                        const num = parseFloat(match[1].replace(/,/g, ''));
                        if (num > 0 && !results.find(r => r.name === 'DSEX')) {
                            results.push({ name: 'DSEX', value: num });
                        }
                    }
                }
                if (text.includes('DSES') && text.includes('Index')) {
                    const match = text.match(/DSES\s*Index\s*[:.]?\s*([\d,]+\.?[\d]*)/i);
                    if (match) {
                        const num = parseFloat(match[1].replace(/,/g, ''));
                        if (num > 0 && !results.find(r => r.name === 'DSES')) {
                            results.push({ name: 'DSES', value: num });
                        }
                    }
                }
                if (text.includes('DS30') && text.includes('Index')) {
                    const match = text.match(/DS30\s*Index\s*[:.]?\s*([\d,]+\.?[\d]*)/i);
                    if (match) {
                        const num = parseFloat(match[1].replace(/,/g, ''));
                        if (num > 0 && !results.find(r => r.name === 'DS30')) {
                            results.push({ name: 'DS30', value: num });
                        }
                    }
                }
            });
        }

        let changeData = {};
        $('td, div, span').each((index, element) => {
            const text = $(element).text().trim();
            if (text.includes('DSEX') && text.includes('(') && text.includes('%)')) {
                const match = text.match(/DSEX.*?([+-]?[\d,]+\.?[\d]*)\s*\(([+-]?[\d,]+\.?[\d]*)%\)/i);
                if (match) {
                    changeData.point = parseFloat(match[1].replace(/,/g, ''));
                    changeData.percent = parseFloat(match[2].replace(/,/g, ''));
                }
            }
        });
        if (!changeData.point) {
            $('td, div, span').each((index, element) => {
                const text = $(element).text().trim();
                if (text.includes('DSEX') && /[+-]?\d+\.?\d*/.test(text)) {
                    const match = text.match(/DSEX.*?([+-]?[\d,]+\.?[\d]*)/i);
                    if (match && !text.includes('%')) {
                        changeData.point = parseFloat(match[1].replace(/,/g, ''));
                    }
                }
            });
        }

        console.log(`📊 পাওয়া গেছে: ${results.length}টি ইনডেক্স`);

        for (const item of results) {
            const record = {
                index_name: item.name,
                date: todayDate,
                value: item.value,
                change: changeData.point || 0,
                change_percent: changeData.percent || 0,
                updated_at: new Date().toISOString()
            };

            const success = await upsertToSupabase('dsex_index', record);
            if (success) {
                console.log(`✅ DSEX: ${item.name} -> ${item.value} (Change: ${changeData.point || 0}, ${changeData.percent || 0}%)`);
            } else {
                console.log(`❌ DSEX: ${item.name} -> সেভ ব্যর্থ`);
            }
        }

        return results;

    } catch (err) {
        console.error('❌ DSEX স্ক্র্যাপ ব্যর্থ:', err.message);
        if (err.response) {
            console.error('📄 রেসপন্স স্ট্যাটাস:', err.response.status);
        }
        return [];
    }
}

async function startScraper() {
    console.log(`🕐 ${new Date().toISOString()} - DSEX স্ক্র্যাপ শুরু...`);
    await scrapeDSEIndices();
    console.log('✅ DSEX স্ক্র্যাপিং সম্পন্ন!');
}

if (require.main === module) {
    startScraper().catch(err => {
        console.error('❌ Fatal error:', err);
        process.exit(1);
    });
}

module.exports = { startScraper, scrapeDSEIndices };
