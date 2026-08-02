// scripts/update_dse_history.js
const axios = require('axios');
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
// 🕐 বাংলাদেশ সময় (UTC+6)
// ==========================================
function getBangladeshTime() {
    const now = new Date();
    const bdTime = new Date(now.getTime() + 6 * 60 * 60 * 1000);
    return bdTime.toISOString();
}

// ==========================================
// 📋 আপনার নির্দিষ্ট টিকার তালিকা
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
// 📡 ব্যাচ আপসার্ট – এক টিকার সব রেকর্ড একসাথে
// ==========================================
async function batchUpsert(ticker, records) {
    if (records.length === 0) return 0;

    const table = 'history_dse';
    const url = `${SUPABASE_URL}/rest/v1/${table}?on_conflict=ticker,date`;
    const headers = {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
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
        return 0;
    } catch (err) {
        console.error(`❌ ব্যাচ আপসার্ট ব্যর্থ (${ticker}):`, err.message);
        if (err.response) console.error('📄 রেসপন্স:', err.response.data);
        return 0;
    }
}

// ==========================================
// 📡 API থেকে এক টিকার ডেটা আনা
// ==========================================
async function fetchTickerData(ticker, startDate, endDate) {
    const API_BASE_URL = 'https://bd-stock-api-an3n.vercel.app/v1/dse/historical';
    const url = `${API_BASE_URL}?start=${startDate}&end=${endDate}&code=${ticker}`;

    try {
        const response = await axios.get(url, { timeout: 30000 });
        if (!response.data?.success || !response.data?.data) {
            return [];
        }

        const historicalData = response.data.data;
        if (historicalData.length === 0) return [];

        return historicalData.map(item => ({
            ticker: item['TRADING CODE'] || ticker,
            date: item['DATE'],
            ltp: parseFloat(item['LTP*']) || 0,
            high: parseFloat(item['HIGH']) || 0,
            low: parseFloat(item['LOW']) || 0,
            open: parseFloat(item['OPENP*']) || 0,
            ycp: parseFloat(item['YCP']) || 0,
            volume: parseInt(item['VOLUME']) || 0,
            trade: parseInt(item['TRADE']) || 0,
            value_mn: parseFloat(item['VALUE (mn)']) || 0,
            updated_at: getBangladeshTime()
        }));

    } catch (err) {
        console.error(`❌ ${ticker} -> API কল ব্যর্থ:`, err.message);
        return [];
    }
}

// ==========================================
// 📅 সর্বশেষ তারিখ খুঁজে বের করা (history_dse থেকে)
// ==========================================
async function getLastDate() {
    try {
        const url = `${SUPABASE_URL}/rest/v1/history_dse?select=date&order=date.desc&limit=1`;
        const headers = {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        };
        const res = await axios.get(url, { headers, httpsAgent: agent, timeout: 10000 });
        if (res.data && res.data.length > 0) {
            const lastDate = res.data[0].date;
            console.log(`📅 সর্বশেষ রেকর্ডের তারিখ: ${lastDate}`);
            return lastDate;
        }
    } catch (e) {
        console.warn('⚠️ শেষ তারিখ পড়া যায়নি (সম্ভবত টেবিল খালি)');
    }
    return null;
}

// ==========================================
// 🚀 মেইন ফাংশন – ইনক্রিমেন্টাল আপডেট
// ==========================================
async function updateDSEHistory() {
    console.log(`🕐 ${getBangladeshTime()} - DSE হিস্টোরি আপডেট শুরু... (শুধু আপনার তালিকা)`);
    console.log(`📊 মোট ${TICKERS.length}টি টিকার ডেটা আনা হবে।`);

    const today = new Date().toISOString().split('T')[0];
    const lastDate = await getLastDate();

    let startDate;
    let isFullHistory = false;

    if (!lastDate) {
        // প্রথমবার: গত ২ বছর
        const twoYearsAgo = new Date();
        twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
        startDate = twoYearsAgo.toISOString().split('T')[0];
        isFullHistory = true;
        console.log(`🆕 টেবিল খালি। গত ২ বছরের ডেটা আনা হবে (${startDate} থেকে)`);
    } else {
        // পরবর্তী রান: শেষ তারিখের পরের দিন থেকে আজ
        const nextDay = new Date(lastDate);
        nextDay.setDate(nextDay.getDate() + 1);
        startDate = nextDay.toISOString().split('T')[0];

        if (startDate > today) {
            console.log(`✅ ইতিমধ্যে আপ-টু-ডেট। (সর্বশেষ: ${lastDate}, আজ: ${today})`);
            return;
        }
        console.log(`🔄 নতুন ডেটা আনা হবে (${startDate} থেকে ${today} পর্যন্ত)`);
    }

    // 🔥 কনকারেন্টি কন্ট্রোল – একসাথে ৫ টিকা
    const concurrency = 5;
    let totalRecords = 0;
    let successCount = 0;

    for (let i = 0; i < TICKERS.length; i += concurrency) {
        const chunk = TICKERS.slice(i, i + concurrency);
        console.log(`📡 প্রসেসিং ব্যাচ ${Math.floor(i/concurrency) + 1}/${Math.ceil(TICKERS.length/concurrency)} (${i+1}-${Math.min(i+concurrency, TICKERS.length)})`);

        // প্যারালালে সব টিকার ডেটা আনা
        const fetchPromises = chunk.map(ticker => fetchTickerData(ticker, startDate, today));
        const results = await Promise.all(fetchPromises);

        // প্রতিটি টিকার ডেটা ব্যাচ আপসার্ট
        const upsertPromises = chunk.map((ticker, index) => {
            const records = results[index];
            if (records.length === 0) return Promise.resolve(0);
            return batchUpsert(ticker, records);
        });

        const savedCounts = await Promise.all(upsertPromises);

        // সারাংশ
        for (let j = 0; j < chunk.length; j++) {
            const ticker = chunk[j];
            const records = results[j];
            const saved = savedCounts[j];
            totalRecords += records.length;
            successCount += saved;
            console.log(`${ticker}: ${saved}/${records.length} সেভ হয়েছে`);
        }

        // রেট-লিমিট এড়াতে বিরতি
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`✅ DSE হিস্টোরি আপডেট সম্পন্ন!`);
    console.log(`📊 মোট রেকর্ড: ${totalRecords}, সফল: ${successCount}`);
    if (isFullHistory) {
        console.log(`🎉 প্রথমবারের মতো সম্পূর্ণ ইতিহাস সেভ হয়েছে।`);
    } else {
        console.log(`📅 আজকের ডেটা আপডেট হয়েছে।`);
    }
}

// ==========================================
// 🔥 রান
// ==========================================
updateDSEHistory().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
