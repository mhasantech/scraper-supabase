// scripts/update_dse_history.js
// StockPulse - DSE history updater
//
// Purpose:
//   Keep history_dse complete from 2026-08-02 through the current Bangladesh date.
//   Every run re-checks the full requested window and UPSERTs ticker+date, so
//   missing days are repaired automatically instead of depending on one
//   possibly-incomplete "last date" value.
//
// Data source strategy (same approach used by current bdshare 1.2.7):
//   1) New DSE JSON API: dsebd.org/api/live/data-archive/day-end
//   2) New DSE alternate host: dse.com.bd/api/live/data-archive/day-end
//   3) Legacy DSE archive: old.dsebd.org/day_end_archive.php
//   4) Legacy alternate host: old.dse.com.bd/day_end_archive.php
//
// IMPORTANT: The new DSE endpoint returns at most 500 rows. We request one
// ticker at a time, so the response for a ticker stays below that limit and
// the whole 2026-08-02 -> today window can be fetched safely.

const axios = require('axios');
const https = require('https');

// ==========================================
// Supabase configuration
// ==========================================
const SUPABASE_URL = 'https://dpdicusxlrdydajkcgev.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
    console.error('❌ SUPABASE_SERVICE_KEY পাওয়া যায়নি।');
    process.exit(1);
}

// DSE currently has an incomplete certificate chain in some environments.
// Keep the existing project's behavior so GitHub Actions does not fail on TLS.
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ==========================================
// Fixed backfill start date requested for StockPulse
// ==========================================
const HISTORY_START_DATE = '2026-08-02';

// ==========================================
// DSE sources
// ==========================================
const DSE_JSON_URLS = [
    'https://dsebd.org/api/live/data-archive/day-end',
    'https://dse.com.bd/api/live/data-archive/day-end'
];

const DSE_LEGACY_URLS = [
    'https://old.dsebd.org/day_end_archive.php',
    'https://old.dse.com.bd/day_end_archive.php'
];

// ==========================================
// Bangladesh time helpers
// ==========================================
function getBangladeshNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka' }));
}

function getBangladeshDate() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());

    const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${map.year}-${map.month}-${map.day}`;
}

function getBangladeshTimestamp() {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Dhaka',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(new Date()).replace(' ', 'T') + '+06:00';
}

// ==========================================
// Target ticker list
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

// Remove accidental duplicates while preserving order.
const UNIQUE_TICKERS = [...new Set(TICKERS.map(t => String(t).trim()).filter(Boolean))];

// ==========================================
// Numeric/date normalization
// ==========================================
function toNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const cleaned = String(value).replace(/,/g, '').trim();
    if (!cleaned || cleaned === '-' || cleaned === '--' || /^n\/a$/i.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

function toInteger(value) {
    const n = toNumber(value);
    return n === null ? null : Math.trunc(n);
}

function normalizeDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    const m = s.match(/^(\d{4})[-\/]?(\d{2})[-\/]?(\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function normalizeTicker(value, fallback) {
    const s = String(value || fallback || '').trim();
    return s || fallback;
}

// ==========================================
// Generic retry helper
// ==========================================
async function requestWithRetry(label, requestFn, attempts = 4) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await requestFn();
        } catch (err) {
            lastError = err;
            const status = err?.response?.status;
            const detail = status ? `HTTP ${status}` : err.message;
            console.warn(`⚠️ ${label} ব্যর্থ (${attempt}/${attempts}): ${detail}`);
            if (attempt < attempts) {
                await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
    }

    throw lastError;
}

// ==========================================
// New DSE JSON API
// ==========================================
async function fetchNewDseHistory(ticker, startDate, endDate) {
    let lastError = null;

    for (const baseUrl of DSE_JSON_URLS) {
        try {
            const response = await requestWithRetry(
                `${ticker} -> ${baseUrl}`,
                () => axios.get(baseUrl, {
                    params: {
                        from: startDate,
                        to: endDate,
                        inst: ticker
                    },
                    httpsAgent,
                    timeout: 20000,
                    headers: {
                        'User-Agent': 'StockPulse-DSE-History/1.0',
                        'Accept': 'application/json,text/plain,*/*',
                        'Referer': 'https://dsebd.org/'
                    },
                    validateStatus: status => status >= 200 && status < 300
                })
            );

            const body = response.data;
            if (!body || !Array.isArray(body.rows)) {
                throw new Error('DSE JSON response-এ rows পাওয়া যায়নি');
            }

            const rows = body.rows;
            if (body.truncated || (Number(body.total) > rows.length)) {
                throw new Error(`DSE API response truncated (${rows.length}/${body.total || '?'})`);
            }

            return rows.map(row => ({
                date: normalizeDate(row.date),
                ticker: normalizeTicker(row.tradingCode, ticker),
                ltp: toNumber(row.ltp),
                high: toNumber(row.high),
                low: toNumber(row.low),
                open: toNumber(row.openp),
                ycp: toNumber(row.ycp),
                volume: toInteger(row.volume),
                trade: toInteger(row.trade),
                value_mn: toNumber(row.value)
            })).filter(r => r.date && r.ticker);
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ ${ticker}: ${baseUrl} ব্যবহার করা যায়নি।`);
        }
    }

    throw lastError || new Error('DSE new API ব্যর্থ');
}

// ==========================================
// Legacy DSE archive fallback
// ==========================================
function findLegacyTableRows(html) {
    // The legacy archive is an HTML table. We deliberately parse the first
    // table containing the expected column names rather than relying on one
    // fragile CSS class.
    const tableMatches = html.match(/<table\b[\s\S]*?<\/table>/gi) || [];
    for (const table of tableMatches) {
        const plain = table.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toUpperCase();
        if (plain.includes('TRADING CODE') && plain.includes('LTP') && plain.includes('VOLUME')) {
            return table;
        }
    }
    return null;
}

function parseLegacyTable(html, requestedTicker) {
    const table = findLegacyTableRows(html);
    if (!table) throw new Error('Legacy DSE archive table পাওয়া যায়নি');

    const rows = [];
    const trMatches = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];

    for (const tr of trMatches.slice(1)) {
        const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
            m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').trim()
        );

        if (cells.length < 12) continue;

        // Legacy column layout used by bdshare 1.2.7:
        // 0 serial, 1 date, 2 trading code, 3 ltp, 4 high, 5 low,
        // 6 open, 7 close, 8 ycp, 9 trade, 10 value, 11 volume.
        const ticker = normalizeTicker(cells[2], requestedTicker);
        if (requestedTicker && ticker.toUpperCase() !== requestedTicker.toUpperCase()) continue;

        const date = normalizeDate(cells[1]);
        if (!date) continue;

        rows.push({
            date,
            ticker,
            ltp: toNumber(cells[3]),
            high: toNumber(cells[4]),
            low: toNumber(cells[5]),
            open: toNumber(cells[6]),
            ycp: toNumber(cells[8]),
            volume: toInteger(cells[11]),
            trade: toInteger(cells[9]),
            value_mn: toNumber(cells[10])
        });
    }

    return rows;
}

async function fetchLegacyDseHistory(ticker, startDate, endDate) {
    let lastError = null;

    for (const baseUrl of DSE_LEGACY_URLS) {
        try {
            const response = await requestWithRetry(
                `${ticker} -> legacy ${baseUrl}`,
                () => axios.get(baseUrl, {
                    params: {
                        startDate,
                        endDate,
                        inst: ticker,
                        archive: 'data'
                    },
                    httpsAgent,
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'StockPulse-DSE-History/1.0',
                        'Accept': 'text/html,application/xhtml+xml,*/*'
                    },
                    validateStatus: status => status >= 200 && status < 300
                })
            );

            const rows = parseLegacyTable(String(response.data || ''), ticker);
            return rows;
        } catch (err) {
            lastError = err;
            console.warn(`⚠️ ${ticker}: ${baseUrl} fallback ব্যর্থ।`);
        }
    }

    throw lastError || new Error('Legacy DSE archive ব্যর্থ');
}

// ==========================================
// Fetch one ticker: new API -> legacy fallback
// ==========================================
async function fetchTickerData(ticker, startDate, endDate) {
    let newError = null;

    // New DSE JSON is the primary source.
    try {
        const result = await fetchNewDseHistory(ticker, startDate, endDate);
        if (result.length > 0) {
            return { source: 'DSE JSON', rows: result };
        }
        console.warn(`ℹ️ ${ticker}: DSE JSON returned 0 rows; checking legacy archive...`);
    } catch (error) {
        newError = error;
        console.warn(`↩️ ${ticker}: New DSE API ব্যর্থ, legacy archive fallback শুরু...`);
    }

    // Legacy archive is the fallback for API outages / symbols not present in
    // the new endpoint.
    try {
        const legacyRows = await fetchLegacyDseHistory(ticker, startDate, endDate);
        if (legacyRows.length > 0) {
            return { source: 'DSE legacy', rows: legacyRows };
        }
        // Both sources answered successfully but had no rows. This is a
        // legitimate no-data symbol, not a workflow failure.
        return { source: 'NO DATA', rows: [] };
    } catch (legacyError) {
        // If the primary source returned a clean empty dataset, prefer the
        // no-data classification. Otherwise both sources actually failed.
        if (!newError) {
            return { source: 'NO DATA', rows: [] };
        }
        throw new Error(
            `${ticker}: new API + legacy দুটোই ব্যর্থ | ` +
            `new=${newError.message} | legacy=${legacyError.message}`
        );
    }
}

// ==========================================
// Supabase UPSERT
// ==========================================
async function batchUpsert(ticker, records) {
    if (!records.length) return 0;

    const url = `${SUPABASE_URL}/rest/v1/history_dse?on_conflict=ticker,date`;
    const headers = {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
    };

    // Keep requests comfortably sized even if the DSE returns more rows than usual.
    const CHUNK_SIZE = 250;
    let saved = 0;

    for (let i = 0; i < records.length; i += CHUNK_SIZE) {
        const chunk = records.slice(i, i + CHUNK_SIZE);
        const response = await requestWithRetry(
            `${ticker} -> Supabase UPSERT ${i + 1}-${i + chunk.length}`,
            () => axios.post(url, chunk, {
                headers,
                httpsAgent,
                timeout: 30000,
                validateStatus: status => status >= 200 && status < 300
            })
        );

        if (![200, 201, 202, 204].includes(response.status)) {
            throw new Error(`Supabase unexpected HTTP ${response.status}`);
        }
        saved += chunk.length;
    }

    return saved;
}

// ==========================================
// Main update
// ==========================================
async function updateDSEHistory() {
    const today = getBangladeshDate();

    if (today < HISTORY_START_DATE) {
        throw new Error(`আজকের তারিখ ${today}; configured start ${HISTORY_START_DATE}-এর আগে।`);
    }

    console.log('==================================================');
    console.log(`🕐 ${getBangladeshTimestamp()} - DSE history update শুরু`);
    console.log(`📅 Fixed backfill range: ${HISTORY_START_DATE} → ${today}`);
    console.log(`📊 Target tickers: ${UNIQUE_TICKERS.length}`);
    console.log('==================================================');

    let totalFetched = 0;
    let totalSaved = 0;
    let successfulTickers = 0;
    const failedTickers = [];
    const skippedTickers = [];
    const noDataTickers = [];

    // Conservative concurrency protects DSE from bursts and keeps the workflow stable.
    const concurrency = 4;

    for (let i = 0; i < UNIQUE_TICKERS.length; i += concurrency) {
        const chunk = UNIQUE_TICKERS.slice(i, i + concurrency);
        const batchNo = Math.floor(i / concurrency) + 1;
        const batchTotal = Math.ceil(UNIQUE_TICKERS.length / concurrency);

        console.log(`\n📦 Batch ${batchNo}/${batchTotal}: ${chunk.join(', ')}`);

        const results = await Promise.all(chunk.map(async ticker => {
            try {
                const result = await fetchTickerData(ticker, HISTORY_START_DATE, today);
                return { ticker, ...result };
            } catch (error) {
                return { ticker, error };
            }
        }));

        for (const result of results) {
            if (result.error) {
                // DSE data না পাওয়া/temporary source failure হলে শুধু এই ticker বাদ থাকবে।
                // অন্য ticker-এর পাওয়া data অবশ্যই Supabase-এ save হবে।
                skippedTickers.push(result.ticker);
                console.warn(`⚠️ ${result.ticker}: historical data পাওয়া যায়নি; skipped. ${result.error.message}`);
                continue;
            }

            // Only save rows inside the exact requested range and for the requested ticker.
            const records = result.rows
                .filter(r => r.date >= HISTORY_START_DATE && r.date <= today)
                .filter(r => r.ticker.toUpperCase() === result.ticker.toUpperCase())
                .map(r => ({
                    ticker: result.ticker,
                    date: r.date,
                    ltp: r.ltp,
                    high: r.high,
                    low: r.low,
                    open: r.open,
                    ycp: r.ycp,
                    volume: r.volume,
                    trade: r.trade,
                    value_mn: r.value_mn,
                    updated_at: getBangladeshTimestamp()
                }));

            // Deduplicate by ticker/date before sending to Supabase.
            const unique = new Map(records.map(r => [`${r.ticker}|${r.date}`, r]));
            const cleanRecords = [...unique.values()];

            if (!cleanRecords.length) {
                // A symbol can legitimately have no rows in the requested window
                // (new/delisted/suspended instrument or code changed at DSE).
                // This is not a database/API crash, so do not abort the whole
                // 347/401-symbol backfill. Keep it visible in the summary.
                noDataTickers.push(result.ticker);
                console.warn(`⚠️ ${result.ticker}: requested range-এ কোনো historical row নেই; skipped.`);
                continue;
            }

            try {
                const saved = await batchUpsert(result.ticker, cleanRecords);
                totalFetched += cleanRecords.length;
                totalSaved += saved;
                successfulTickers++;
                console.log(`✅ ${result.ticker}: ${saved}/${cleanRecords.length} saved | source=${result.source}`);
            } catch (error) {
                failedTickers.push(result.ticker);
                console.error(`❌ ${result.ticker}: Supabase save ব্যর্থ: ${error.message}`);
            }
        }

        // Small pause between batches.
        if (i + concurrency < UNIQUE_TICKERS.length) {
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console.log('\n==================================================');
    console.log('📊 DSE HISTORY UPDATE SUMMARY');
    console.log(`📅 Range: ${HISTORY_START_DATE} → ${today}`);
    console.log(`🎯 Tickers: ${UNIQUE_TICKERS.length}`);
    console.log(`✅ Successful tickers: ${successfulTickers}`);
    console.log(`🧾 Records fetched: ${totalFetched}`);
    console.log(`💾 Records upserted: ${totalSaved}`);
    const allSkipped = [...new Set([...noDataTickers, ...skippedTickers])];
    console.log(`⚠️ Skipped tickers (no data/source response): ${allSkipped.length}`);
    if (allSkipped.length) console.log(`ℹ️ Skipped list: ${allSkipped.join(', ')}`);
    console.log(`❌ Actual database/save failures: ${failedTickers.length}`);
    if (failedTickers.length) console.log(`⚠️ Failed list: ${failedTickers.join(', ')}`);
    console.log('==================================================');

    // Missing/unavailable ticker data is intentionally skipped.
    // Only a real Supabase/database save failure makes the workflow fail.
    if (failedTickers.length > 0) {
        throw new Error(`${failedTickers.length} ticker(s) could not be saved to history_dse.`);
    }

    if (totalSaved === 0) {
        throw new Error('কোনো record Supabase-এ save হয়নি।');
    }

    console.log('🎉 history_dse backfill/update সম্পূর্ণ সফল।');
}

updateDSEHistory().catch(error => {
    console.error('\n❌ FATAL:', error.message);
    process.exit(1);
});
