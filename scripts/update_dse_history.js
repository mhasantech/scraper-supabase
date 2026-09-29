// scripts/update_dse_history.js
// StockPulse - DSE historical updater
//
// IMPORTANT:
// The old bd-stock-api endpoint started returning HTTP 500 for historical
// requests. Do not let that external API failure stop the daily history job.
// Primary source remains the API for speed; on 5xx/invalid responses we
// automatically fall back to DSE's legacy Day End Archive.
//
// The legacy DSE archive currently lives on old.dsebd.org / old.dse.com.bd.
// It accepts startDate, endDate, inst and archive=data query parameters.

const axios = require('axios');
const https = require('https');
const cheerio = require('cheerio');

// ==========================================
// Supabase configuration
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

const agent = new https.Agent({ rejectUnauthorized: false });

const HTTP_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache'
};

// ==========================================
// Bangladesh date
// ==========================================
function getBangladeshDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());

    const p = Object.fromEntries(
        parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}`;
}

function getBangladeshTime() {
    return new Date().toLocaleString('sv-SE', {
        timeZone: 'Asia/Dhaka',
        hour12: false
    }).replace(' ', 'T') + '+06:00';
}

function parseNumber(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).replace(/,/g, '').trim();
    if (!s || s === '-' || s === '--' || s.toLowerCase() === 'n/a') return null;
    const m = s.match(/[-+]?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
}

function cleanText(value) {
    return String(value ?? '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeHeader(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isTradingDayDate(date) {
    // DSE trades Sunday-Thursday. Friday/Saturday can be skipped immediately.
    const d = new Date(`${date}T00:00:00+06:00`);
    const day = d.getDay(); // 0=Sun ... 5=Fri, 6=Sat
    return day >= 0 && day <= 4;
}

function nextDate(date) {
    const d = new Date(`${date}T00:00:00+06:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
}

function formatArchiveDate(date) {
    // DSE archive query accepts ISO date strings.
    return date;
}

// ==========================================
// Your ticker list
// ==========================================
const TICKERS = [

    "1JANATAMF", "1STPRIMFMF", "AAMRANET", "AAMRATECH", "ABB1STMF", "ABBANK", "ACFL", "ACI", "ACIFORMULA", "ACMELAB",
    "ACTIVEFINE", "ADNTEL", "ADVENT", "AFCAGRO", "AFTABAUTO", "AGNISYSL", "AGRANINS", "AIBL1STIMF", "AIL", "AL-HAJTEX",
    "ALARABANK", "ALIF", "ALLTEX", "AMANFEED", "AMBEEPHA", "ANLIMAYARN", "ANWARGALV", "APEXFOODS", "APEXFOOT", "APEXSPINN",
    "APOLOISPAT", "ARAMIT", "ARAMITCEM", "ARGONDENIM", "ASIAPACINS", "ATCSLGF", "ATLASBANG", "AZIZPIPES", "BANGAS", "BANKASIA",
    "BATASHOE", "BATBC", "BAYLEASING", "BBS", "BCC", "BDCOM", "BDFINANCE", "BDLAMPS", "BDTHAI", "BDTHAIFOOD",
    "BDWELDING", "BEACHHATCH", "BEACONPHAR", "BENGALWTL", "BERGERPBL", "BEXGSUKUK", "BEXIMCO", "BGIC", "BIFC", "BNICL",
    "BPML", "BPPL", "BRACBANK", "BSC", "BSCCL", "BSRMLTD", "BSRMSTEEL", "BXPHARMA", "CAPMBDBLMF", "CAPMIBBLMF", "BESTHLDNG",
    "CENTRALINS", "CENTRALPHL", "CITYBANK", "CNATEX", "CONFIDCEM", "CONTININS", "COPPERTECH", "CROWNCEMNT", "CVOPRL", "DACCADYE",
    "DAFODILCOM", "DBH", "DBH1STMF", "DELTALIFE", "DELTASPINN", "DESCO", "DESHBANDHU", "DHAKABANK", "DOMINAGE", "DOREENPWR",
    "DSSL", "Dulamiacot", "DUTCHBANGL", "EASTLAND", "EASTRNLUB", "EBL", "EBL1STMF", "EBLNRBMF", "ECABLES", "EGEN",
    "EMERALDOIL", "ENVOYTEX", "EPGL", "ESQUIRENIT", "ETL", "EXIM1STMF", "EXIMBANK", "FAMILYTEX", "FARCHEM", "FAREASTLIF", "FAREASTFIN",
    "FASFIN", "FBFIF", "FEDERALINS", "FEKDIL", "FINEFOODS", "FIRSTFIN", "FIRSTSBANK", "FORTUNE", "FUWANGCER",
    "FUWANGFOOD", "GBBPOWER", "GEMINISEA", "GENEXIL", "GENNEXT", "GHAIL", "GHCL", "GIB", "GLAXOSMITH", "GLOBALINS",
    "GOLDENSON", "GP", "GPHISPAT", "GQBALLPEN", "GSPFINANCE", "GRAMEENS2", "GREENDELT", "HAKKANIPUL", "HEIDELBCEM", "HFL", "HRTEX",
    "HWAWELLTEX", "IBNSINA", "IBP", "ICB", "ICB3RDNRB", "ICBAGRANI1", "ICBAMCL2ND", "ICBEPMF1S1", "IDLC", "IFADAUTOS", "ICICL",
    "IFIC", "IFIC1STMF", "IFILISLMF1", "ILFSL", "INDEXAGRO", "INTECH", "INTRACO", "IPDC", "ISLAMIBANK", "ISLAMICFIN", "ICBEPMF1S1",
    "ISNLTD", "ITC", "JAMUNABANK", "JAMUNAOIL", "JANATAINS", "JHRML", "JMISMDL", "JUTESPINN", "KARNAPHULI", "KAY&QUE",
    "KBPPWBIL", "KDSALTD", "KEYACOSMET", "KPCL", "KPPL", "LANKABAFIN", "LEGACYFOOT", "LHBL", "LIBRAINFU", "LINDEBD",
    "LOVELLO", "LRBDL", "MARICO", "MATINSPINN", "MBL1STMF", "MEGCONMILK", "MEGHNACEM", "MEGHNALIFE", "MEGHNAPET", "MERCANBANK",
    "MERCINS", "METROSPIN", "MHSML", "MIDASFIN", "MIRACLEIND", "MIRAKHTER", "MONNOAGML", "MONNOCERA", "MONNOFABR", "MONOSPOOL", "MALEKSPIN", "MPETROLEUM", "MTB", "MIDLANDBNK", "NAHEEACP", "NATLIFEINS", "NAVANACNG", "NAVANAPHAR", "NBL", "NCCBANK", "NCCBLMF1", "NEWLINE",
    "NITOLINS", "NORTHERN", "NORTHRNINS", "NPOLYMER", "NRBBANK", "NTLTUBES", "OAL", "NHFIL", "OIMEX", "OLYMPIC", "ONEBANKPLC",
    "ORIONINFU", "ORIONPHARM", "PADMALIFE", "PADMAOIL", "PARAMOUNT", "PDL", "PENINSULA", "PEOPLESINS", "PF1STMF", "PHARMAID",
    "PHENIXINS", "PHOENIXFIN", "PIONEERINS", "PLFSL", "POPULAR1MF", "POPULARLIF", "POWERGRID", "PRAGATIINS", "PRAGATILIF", "PREMIERBAN",
    "PREMIERCEM", "PREMIERLEA", "PRIME1ICBA", "PRIMEBANK", "PRIMEFIN", "PRIMEINSUR", "PRIMELIFE", "PROGRESLIF", "PROVATIINS", "PTL",
    "PUBALIBANK", "PURABIGEN", "QUASEMIND", "QUEENSOUTH", "RAHIMAFOOD", "RAKCERAMIC", "RANFOUNDRY", "RDFOOD", "RECKITTBEN", "REGENTTEX",
    "RELIANCE1", "RENATA", "REPUBLIC", "RINGSHINE", "ROBI", "RSRMSTEEL", "RUNNERAUTO", "RUPALIBANK", "RUPALIINS", "SAFKOSPINN",
    "SAIFPOWER", "SAIHAMCOT", "SAIHAMTEX", "SALAMCRST", "SALVOCHEM", "SAMATALETH", "SAMORITA", "SANDHANINS", "SAPORTL", "SAVAREFR",
    "SEAPEARL", "SEMLFBSLGF", "SEMLIBBLSF", "SEMLLECMF", "SHAHJABANK", "SHASHADNIM", "SHEPHERD", "SHURWID", "SHYAMPSUG", "SIBL",
    "SICL", "SILCOPHL", "SILVAPHL", "SIMTEX", "SINOBANGLA", "SKICL", "SONALIANSH", "SONALILIFE", "SONALIPAPR", "SONARBAINS",
    "SOUTHEASTB", "SPCERAMICS", "SQURPHARMA", "SSSTEEL", "STANCERAM", "STANDARINS", "STANDBANKL", "STYLECRAFT", "SUMITPOWER", "SUNLIFEINS",
    "TAKAFULINS", "TALLUSPIN", "TAMIJTEX", "TECHNODRUG", "TILIL", "TITASGAS", "TOSRIFA", "TRUSTBANK", "TUNGHAI", "UCB",
    "UNILEVERCL", "UNIONBANK", "UNIONCAP", "UNIONINS", "UNIQUEHRL", "UNITEDFIN", "UNITEDINS", "UPGDCL", "USMANIAGL", "UTTARABANK",
    "UTTARAFIN", "VAMLBDMF1", "VAMLRBBF", "VFSTDL", "WALTONHIL", "WATACHEM", "WMSHIPYARD", "YPL", "ZAHEENSPIN", "ZAHINTEX"
];

// ==========================================
// Supabase batch upsert
// ==========================================
async function batchUpsert(ticker, records) {
    if (!records.length) return 0;

    const url = `${SUPABASE_URL}/rest/v1/history_dse?on_conflict=ticker,date`;
    const headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
    };

    try {
        const response = await axios.post(url, records, {
            headers,
            httpsAgent: agent,
            timeout: 30000
        });

        if ([200, 201, 202, 204].includes(response.status)) {
            return records.length;
        }

        console.error(`❌ Supabase upsert status ${response.status} (${ticker})`);
        return 0;
    } catch (err) {
        console.error(`❌ Supabase batch upsert ব্যর্থ (${ticker}):`, err.message);
        if (err.response?.data) {
            console.error('📄 Supabase response:', JSON.stringify(err.response.data));
        }
        return 0;
    }
}

// ==========================================
// 1) Existing API source
// ==========================================
async function fetchTickerDataFromApi(ticker, startDate, endDate) {
    const API_BASE_URL = 'https://bd-stock-api-an3n.vercel.app/v1/dse/historical';
    const url = `${API_BASE_URL}?start=${encodeURIComponent(startDate)}&end=${encodeURIComponent(endDate)}&code=${encodeURIComponent(ticker)}`;

    const response = await axios.get(url, {
        timeout: 30000,
        headers: HTTP_HEADERS
    });

    if (!response.data?.success || !Array.isArray(response.data?.data)) {
        throw new Error('API response format invalid');
    }

    return response.data.data.map(item => ({
        ticker: item['TRADING CODE'] || ticker,
        date: item['DATE'],
        ltp: parseNumber(item['LTP*']) ?? parseNumber(item['CLOSEP*']) ?? 0,
        high: parseNumber(item['HIGH']) ?? 0,
        low: parseNumber(item['LOW']) ?? 0,
        open: parseNumber(item['OPENP*']) ?? 0,
        ycp: parseNumber(item['YCP']) ?? 0,
        volume: Math.round(parseNumber(item['VOLUME']) ?? 0),
        trade: Math.round(parseNumber(item['TRADE']) ?? 0),
        value_mn: parseNumber(item['VALUE (mn)']) ?? 0,
        updated_at: getBangladeshTime()
    })).filter(r => r.date);
}

// ==========================================
// 2) Direct DSE legacy archive fallback
// ==========================================
function parseDseArchiveHtml(html, requestedTicker) {
    const $ = cheerio.load(html);
    const records = [];

    $('table').each((_, table) => {
        let headers = [];

        $(table).find('tr').first().find('th,td').each((_, cell) => {
            headers.push(normalizeHeader($(cell).text()));
        });

        const dateIdx = headers.findIndex(x => x === 'date');
        const codeIdx = headers.findIndex(x =>
            ['tradingcode', 'code', 'instrumentcode'].includes(x)
        );

        if (dateIdx < 0 || codeIdx < 0) return;

        const idx = name => headers.findIndex(x => x === name);
        const ltpIdx = headers.findIndex(x => ['ltp', 'ltpstar'].includes(x));
        const highIdx = idx('high');
        const lowIdx = idx('low');
        const openIdx = headers.findIndex(x => ['openp', 'openpstar', 'open'].includes(x));
        const closeIdx = headers.findIndex(x => ['closep', 'closepstar', 'close'].includes(x));
        const ycpIdx = headers.findIndex(x => ['ycp', 'ycpstar'].includes(x));
        const tradeIdx = headers.findIndex(x => x === 'trade' || x === 'trades');
        const valueIdx = headers.findIndex(x => x === 'valuemn' || x === 'value');
        const volumeIdx = headers.findIndex(x => x === 'volume');

        $(table).find('tr').slice(1).each((_, tr) => {
            const cells = $(tr).find('td').toArray().map(td => cleanText($(td).text()));
            if (!cells.length) return;

            const code = cells[codeIdx];
            if (!code || code.toUpperCase() !== requestedTicker.toUpperCase()) return;

            const date = cells[dateIdx];
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

            const close = closeIdx >= 0 ? parseNumber(cells[closeIdx]) : null;
            const ltp = ltpIdx >= 0 ? parseNumber(cells[ltpIdx]) : close;

            records.push({
                ticker: requestedTicker,
                date,
                ltp: ltp ?? 0,
                high: highIdx >= 0 ? (parseNumber(cells[highIdx]) ?? 0) : 0,
                low: lowIdx >= 0 ? (parseNumber(cells[lowIdx]) ?? 0) : 0,
                open: openIdx >= 0 ? (parseNumber(cells[openIdx]) ?? 0) : 0,
                ycp: ycpIdx >= 0 ? (parseNumber(cells[ycpIdx]) ?? 0) : 0,
                volume: volumeIdx >= 0 ? Math.round(parseNumber(cells[volumeIdx]) ?? 0) : 0,
                trade: tradeIdx >= 0 ? Math.round(parseNumber(cells[tradeIdx]) ?? 0) : 0,
                value_mn: valueIdx >= 0 ? (parseNumber(cells[valueIdx]) ?? 0) : 0,
                updated_at: getBangladeshTime()
            });
        });
    });

    // de-duplicate by date
    return [...new Map(records.map(r => [r.date, r])).values()];
}

async function fetchDseArchiveForDay(date) {
    const hosts = ['https://old.dsebd.org', 'https://old.dse.com.bd'];
    let lastError = null;

    for (const host of hosts) {
        const url =
            `${host}/day_end_archive.php` +
            `?startDate=${encodeURIComponent(formatArchiveDate(date))}` +
            `&endDate=${encodeURIComponent(formatArchiveDate(date))}` +
            `&archive=data`;

        try {
            const response = await axios.get(url, {
                timeout: 60000,
                headers: HTTP_HEADERS,
                httpsAgent: agent,
                maxContentLength: 50 * 1024 * 1024
            });

            const records = parseDseArchiveHtmlAll(response.data);

            if (records.length) {
                return records;
            }

            lastError = new Error(`DSE archive returned 0 rows for ${date}`);
        } catch (err) {
            lastError = err;
            console.error(`⚠️ DSE archive host failed ${host}: ${err.message}`);
        }
    }

    throw lastError || new Error(`DSE archive unavailable for ${date}`);
}

function parseDseArchiveHtmlAll(html) {
    const $ = cheerio.load(html);
    const records = [];

    $('table').each((_, table) => {
        let headers = [];

        $(table).find('tr').first().find('th,td').each((_, cell) => {
            headers.push(normalizeHeader($(cell).text()));
        });

        const dateIdx = headers.findIndex(x => x === 'date');
        const codeIdx = headers.findIndex(x =>
            ['tradingcode', 'code', 'instrumentcode'].includes(x)
        );

        if (dateIdx < 0 || codeIdx < 0) return;

        const ltpIdx = headers.findIndex(x => ['ltp', 'ltpstar'].includes(x));
        const highIdx = headers.indexOf('high');
        const lowIdx = headers.indexOf('low');
        const openIdx = headers.findIndex(x => ['openp', 'openpstar', 'open'].includes(x));
        const closeIdx = headers.findIndex(x => ['closep', 'closepstar', 'close'].includes(x));
        const ycpIdx = headers.findIndex(x => ['ycp', 'ycpstar'].includes(x));
        const tradeIdx = headers.findIndex(x => x === 'trade' || x === 'trades');
        const valueIdx = headers.findIndex(x => x === 'valuemn' || x === 'value');
        const volumeIdx = headers.indexOf('volume');

        $(table).find('tr').slice(1).each((_, tr) => {
            const cells = $(tr).find('td').toArray().map(td => cleanText($(td).text()));
            if (!cells.length) return;

            const code = cleanText(cells[codeIdx]);
            const date = cleanText(cells[dateIdx]);

            if (!code || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

            const close = closeIdx >= 0 ? parseNumber(cells[closeIdx]) : null;
            const ltp = ltpIdx >= 0 ? parseNumber(cells[ltpIdx]) : close;

            records.push({
                ticker: code,
                date,
                ltp: ltp ?? 0,
                high: highIdx >= 0 ? (parseNumber(cells[highIdx]) ?? 0) : 0,
                low: lowIdx >= 0 ? (parseNumber(cells[lowIdx]) ?? 0) : 0,
                open: openIdx >= 0 ? (parseNumber(cells[openIdx]) ?? 0) : 0,
                ycp: ycpIdx >= 0 ? (parseNumber(cells[ycpIdx]) ?? 0) : 0,
                volume: volumeIdx >= 0 ? Math.round(parseNumber(cells[volumeIdx]) ?? 0) : 0,
                trade: tradeIdx >= 0 ? Math.round(parseNumber(cells[tradeIdx]) ?? 0) : 0,
                value_mn: valueIdx >= 0 ? (parseNumber(cells[valueIdx]) ?? 0) : 0,
                updated_at: getBangladeshTime()
            });
        });
    });

    return [...new Map(records.map(r => [`${r.ticker}|${r.date}`, r])).values()];
}

// ==========================================
// Fetch with automatic fallback
// ==========================================
async function fetchTickerData(ticker, startDate, endDate) {
    try {
        const records = await fetchTickerDataFromApi(ticker, startDate, endDate);

        // If the API silently returns no data for a period where DSE should
        // have data, use the direct archive as well.
        if (records.length) return records;

        console.warn(`⚠️ ${ticker} -> API returned 0 rows; using DSE archive fallback...`);
    } catch (err) {
        const status = err.response?.status;
        console.error(
            `❌ ${ticker} -> API ${status ? `HTTP ${status}` : 'call'} ব্যর্থ: ${err.message}`
        );
        if (status >= 500) {
            console.log(`↩️ ${ticker} -> Direct DSE archive fallback চালু হচ্ছে...`);
        }
    }

    try {
        const records = await fetchTickerDataFromDseArchive(ticker, startDate, endDate);
        console.log(`✅ ${ticker} -> DSE archive থেকে ${records.length} rows পাওয়া গেছে`);
        return records;
    } catch (err) {
        console.error(`❌ ${ticker} -> DSE archive fallback-ও ব্যর্থ: ${err.message}`);
        return [];
    }
}

// ==========================================
// Latest date from history_dse
// ==========================================
async function getLastDate() {
    try {
        const url = `${SUPABASE_URL}/rest/v1/history_dse?select=date&order=date.desc&limit=1`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };

        const res = await axios.get(url, {
            headers,
            httpsAgent: agent,
            timeout: 10000
        });

        if (res.data?.length) {
            const lastDate = res.data[0].date;
            console.log(`📅 সর্বশেষ history_dse তারিখ: ${lastDate}`);
            return lastDate;
        }
    } catch (e) {
        console.warn('⚠️ history_dse থেকে শেষ তারিখ পড়া যায়নি:', e.message);
    }

    return null;
}

// ==========================================
// Main
// ==========================================
async function updateDSEHistory() {
    const today = getBangladeshDate();

    console.log(`🕐 ${getBangladeshTime()} - DSE history update শুরু`);
    console.log(`📊 Target tickers: ${TICKERS.length}`);

    const lastDate = await getLastDate();

    let startDate;
    if (!lastDate) {
        const d = new Date(`${today}T00:00:00+06:00`);
        d.setFullYear(d.getFullYear() - 2);
        startDate = d.toISOString().slice(0, 10);
        console.log(`🆕 প্রথম রান: ${startDate} থেকে ${today}`);
    } else {
        startDate = nextDate(lastDate);

        if (startDate > today) {
            console.log(`✅ ইতিমধ্যে আপ-টু-ডেট: ${lastDate}`);
            return;
        }

        console.log(`🔄 Missing range: ${startDate} → ${today}`);
    }

    // The previous implementation made one external API request per ticker.
    // That API now returns HTTP 500. The reliable path is the DSE Day End
    // Archive: one request per trading day, then filter to our ticker list.
    const wanted = new Set(TICKERS.map(x => x.toUpperCase()));

    let cursor = startDate;
    let grandFetched = 0;
    let grandSaved = 0;
    let tradingDays = 0;

    while (cursor <= today) {
        if (!isTradingDayDate(cursor)) {
            cursor = nextDate(cursor);
            continue;
        }

        console.log(`\n📅 ===== DSE archive: ${cursor} =====`);
        tradingDays++;

        let allRows;
        try {
            allRows = await fetchDseArchiveForDay(cursor);
            console.log(`📥 DSE archive rows: ${allRows.length}`);
        } catch (err) {
            console.error(`❌ ${cursor}: DSE archive fetch failed: ${err.message}`);
            // Do not stop the whole workflow because of one unavailable day.
            // The next run will retry this date because history_dse has not
            // advanced past it.
            cursor = nextDate(cursor);
            await sleep(2500);
            continue;
        }

        const targetRows = allRows.filter(
            r => r.date === cursor && wanted.has(String(r.ticker).toUpperCase())
        );

        console.log(`🎯 Target rows for StockPulse: ${targetRows.length}`);

        // If DSE returned a page but no target rows, refuse to mark the day
        // complete. This protects against an HTML/layout change.
        if (!targetRows.length) {
            console.error(`⚠️ ${cursor}: 0 target rows — nothing will be saved.`);
            cursor = nextDate(cursor);
            await sleep(2500);
            continue;
        }

        grandFetched += targetRows.length;

        // Save in manageable batches. Supabase accepts array POSTs with the
        // same ticker/date conflict key.
        const batchSize = 200;
        for (let i = 0; i < targetRows.length; i += batchSize) {
            const batch = targetRows.slice(i, i + batchSize);
            const saved = await batchUpsert(`DSE-ARCHIVE-${cursor}`, batch);
            grandSaved += saved;
            console.log(`💾 ${cursor}: batch ${Math.floor(i / batchSize) + 1} saved ${saved}/${batch.length}`);
        }

        cursor = nextDate(cursor);

        // Be polite to the legacy DSE site.
        await sleep(2500);
    }

    console.log('\n======================================');
    console.log('✅ DSE HISTORY UPDATE COMPLETE');
    console.log(`📅 Trading days processed: ${tradingDays}`);
    console.log(`📊 Target records found: ${grandFetched}`);
    console.log(`💾 Target records saved/upserted: ${grandSaved}`);
    console.log('======================================');
}

if (require.main === module) {
    updateDSEHistory().catch(err => {
        console.error('❌ Fatal error:', err.response?.data || err.message || err);
        process.exit(1);
    });
}

module.exports = {
    updateDSEHistory,
    fetchTickerData,
    fetchTickerDataFromApi,
    fetchDseArchiveForDay,
    parseDseArchiveHtml,
    parseDseArchiveHtmlAll
};
