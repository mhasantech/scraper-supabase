// node scripts/test_dsex_recent.js
// Offline checks for scripts/dsex_scraper.js (no network, no Supabase).
const assert = require('assert');
const { parseRecentMarketRows, makeIndexRows, parseDate, parseNumber } = require('./dsex_scraper');

// --- helpers --------------------------------------------------------------
assert.strictEqual(parseDate('15-10-2026'), '2026-10-15');
assert.strictEqual(parseDate('2026-10-15'), '2026-10-15');
assert.strictEqual(parseDate('15 Oct 2026'), '2026-10-15');
assert.strictEqual(parseDate('31-02-2026'), null);
assert.strictEqual(parseNumber('5,452.05858'), 5452.05858);
assert.strictEqual(parseNumber('-'), null);

const day = (d, trade, vol, val, eq, tot, dsex, dses, ds30) =>
  `<tr><td>${d}</td><td>${trade}</td><td>${vol}</td><td>${val}</td><td>${eq}</td><td>${tot}</td><td>${dsex}</td><td>${dses}</td><td>${ds30}</td></tr>`;

const dataRows =
  day('15-10-2026', 162437, 162107049, '4996.899', '3388147.972', '6841000.1', '5452.05858', '1077.95857', '2096.50979') +
  day('14-10-2026', 148617, 153950630, '4161.523', '3376644.318', '6846300.2', '5429.37127', '1072.44154', '2092.63213') +
  day('13-10-2026', 148495, 156567761, '4161.054', '3369028.16', '6835900.7', '5410.00000', '1068.00000', '2085.00000');

// Variant A: two-row header with colspan/rowspan, a group header "Index" over DSEX/DSES/DS30
const variantA = `
<html><body>
<table><tr><td>Total Trade Volume</td><td>171412005</td><td>10-03-2021</td></tr>
<tr><td>DSEX Index</td><td>7367.99947</td><td>10-10-2021</td></tr></table>
<table>
<tr><th colspan="9">Recent Market Information</th></tr>
<tr><th rowspan="2">Date</th><th rowspan="2">Total Trade</th><th rowspan="2">Total Volume</th>
    <th rowspan="2">Total Value in Taka (mn)</th><th colspan="2">Market Capitalization in (mn)</th>
    <th colspan="3">Index</th></tr>
<tr><th>Equity Securities</th><th>Total Market</th><th>DSEX</th><th>DSES</th><th>DS30</th></tr>
${dataRows}</table></body></html>`;

// Variant B: single header row, "DSEX Index" style names, ISO dates, extra empty cells
const variantB = `
<table><tr><th>Date</th><th>Total Trade</th><th>DSEX Index</th><th>DS30 Index</th><th>DSES Index</th></tr>
<tr><td>2026-10-15</td><td>162437</td><td>5,452.05858</td><td>2,096.50979</td><td>1,077.95857</td></tr>
<tr><td>2026-10-14</td><td>148617</td><td>5,429.37127</td><td>2,092.63213</td><td>1,072.44154</td></tr></table>`;

// Variant C: rows come newest-first, one row has a dash instead of a number
const variantC = variantB.replace('1,072.44154', '-');

function check(name, html, expectDses = true) {
  const rows = parseRecentMarketRows(html);
  assert.ok(rows.length >= 2, `${name}: rows`);
  assert.deepStrictEqual(rows.map(r => r.date).slice(-2), ['2026-10-14', '2026-10-15'], `${name}: sorted ascending`);
  const last = rows[rows.length - 1];
  assert.strictEqual(last.DSEX, 5452.05858, `${name}: DSEX`);
  assert.strictEqual(last.DS30, 2096.50979, `${name}: DS30`);
  if (expectDses) assert.strictEqual(last.DSES, 1077.95857, `${name}: DSES`);

  const out = makeIndexRows(rows);
  const dsex = out.filter(r => r.index_name === 'DSEX' && r.date === '2026-10-15')[0];
  assert.strictEqual(dsex.change, 22.68731, `${name}: DSEX change`);
  assert.strictEqual(dsex.change_percent, 0.41786, `${name}: DSEX %`);
  const ds30 = out.filter(r => r.index_name === 'DS30' && r.date === '2026-10-15')[0];
  assert.strictEqual(ds30.change, 3.87766, `${name}: DS30 change`);
  // the oldest row of the window must NOT carry null change fields
  const oldest = out.filter(r => r.index_name === 'DSEX')[0];
  assert.ok(!('change' in oldest), `${name}: oldest row has no change key`);
  return out;
}

check('variant A (two-row header)', variantA);
const outA = parseRecentMarketRows(variantA);
assert.strictEqual(outA.length, 3, 'record table at the top is ignored');
check('variant B (single header, comma numbers)', variantB);
const c = check('variant C (dash instead of number)', variantC, false);
assert.ok(!c.some(r => r.index_name === 'DSES' && r.date === '2026-10-14'), 'dash is skipped, not stored as 0');


// Variant D: messy real-world markup — upper-case tags, unclosed <tr>/<td>, thead/tbody,
// inline tags splitting the label (DSE<b>X</b>), entities and padded dates.
const variantD = `
<TABLE class="table"><THEAD>
<TR><TH ROWSPAN=2>Date<TH>Total Trade<TH>Total Volume<TH>Total Value in Taka (mn)<TH COLSPAN=2>Market Capitalization in (mn)<TH COLSPAN=3>Index
<TR><TH>&nbsp;<TH>&nbsp;<TH>&nbsp;<TH>Equity Securities<TH>Total Market<TH>DSE<b>X</b><TH>DSE<b>S</b><TH>DS30
</THEAD><TBODY>
<TR><TD> 15-10-2026 <TD>162437<TD>162107049<TD>4996.899<TD>3388147.972<TD>6841000.1<TD>5,452.05858<TD>1,077.95857<TD>2,096.50979
<TR><TD> 14-10-2026 <TD>148617<TD>153950630<TD>4161.523<TD>3376644.318<TD>6846300.2<TD>5,429.37127<TD>1,072.44154<TD>2,092.63213
</TBODY></TABLE>`;
check('variant D (messy markup)', variantD);

// Page without the table gives a helpful error
assert.throws(() => parseRecentMarketRows('<html><body><table><tr><td>x</td></tr></table></body></html>'),
  /table not found/i);

console.log('✅ test_dsex_recent: all checks passed');
