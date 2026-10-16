// node scripts/test_dse_legacy.js
// Offline checks for scripts/lib/dse_legacy.js (no network, no Supabase).
const assert = require('assert');
const {
  htmlToLegacyText, parsePageDate, parseLegacyDsex, parseLegacySummary,
} = require('./lib/dse_legacy');

const summaryTables = `
<table><tr><th>Total Trade</th><th>Total Volume</th><th>Total Value in Taka (mn)</th></tr>
<tr><td>162437</td><td>162107049</td><td>4996.899</td></tr></table>
<table><tr><th>Issues Advanced</th><th>Issues declined</th><th>Issues Unchanged</th></tr>
<tr><td>240</td><td>90</td><td>55</td></tr></table>`;

const page = (indexRows, extra = '') => `
<html><body><div class="hdr">Last update on Oct 15, 2026 at 5:26 PM</div>
<table>${indexRows}</table>${summaryTables}${extra}</body></html>`;

const variants = {
  'label split by span':
    page(`<tr><td><a href="#">DSE<span style="font-size:24px">X</span> Index</a></td><td>5452.05858</td><td>22.68731</td><td>0.41786%</td><td><img src="images/up.png" alt="up"></td></tr>
          <tr><td>DSE<span>S</span> Index</td><td>1077.95857</td><td>5.51703</td><td>0.51444%</td><td><img src="images/up.png"></td></tr>`),
  'label with spaces and font tags':
    page(`<tr><td><font>DSE</font> <font size="5">X</font> <font>Index</font></td><td> 5452.05858 </td><td>22.68731</td><td>0.41786 %</td><td><i class="fa fa-angle-double-up"></i></td></tr>`),
  'nested table + extra empty cells':
    page(`<tr><td><table><tr><td>&nbsp;</td><td><b>DSE</b><big>X</big>&nbsp;Index</td><td>5452.05858</td><td></td><td>22.68731</td><td>0.41786%</td><td class="arrow-up"></td></tr></table></td></tr>`),
  'th label and nbsp separators':
    page(`<tr><th>DSEX&nbsp;Index</th><td>5,452.05858</td><td>22.68731</td><td>0.41786%</td><td></td></tr>`),
};

for (const [name, html] of Object.entries(variants)) {
  const r = parseLegacyDsex(html);
  assert.strictEqual(r.dsex, 5452.05858, `${name}: dsex`);
  assert.strictEqual(r.change, 22.68731, `${name}: change`);
  assert.strictEqual(r.change_percent, 0.41786, `${name}: percent`);
  const s = parseLegacySummary(html);
  assert.deepStrictEqual(s, {
    total_trades: 162437, total_volume: 162107049, total_value: 4996.899,
    advanced: 240, declined: 90, unchanged: 55,
  }, `${name}: summary`);
  assert.strictEqual(parsePageDate(htmlToLegacyText(html), { year: 2026, iso: '2026-10-16' }), '2026-10-15', `${name}: date`);
  console.log(`✅ ${name}`);
}

// Negative day: minus sign in text
{
  const r = parseLegacyDsex(page(`<tr><td>DSE<span>X</span> Index</td><td>5410.00</td><td>-19.37</td><td>-0.36%</td><td><img src="down.gif"></td></tr>`));
  assert.strictEqual(r.change, -19.37); assert.strictEqual(r.change_percent, -0.36);
  console.log('✅ negative with minus sign');
}
// Negative day: no minus sign, only a red down arrow
{
  const r = parseLegacyDsex(page(`<tr><td>DSE<span>X</span> Index</td><td>5410.00</td><td>19.37</td><td>0.36%</td><td><img src="images/arrow_down_red.gif"></td></tr>
                                  <tr><td>DSE<span>S</span> Index</td><td>1070</td><td>5.5</td><td>0.5%</td><td><img src="images/up.png"></td></tr>`));
  assert.strictEqual(r.change, -19.37); assert.strictEqual(r.change_percent, -0.36);
  console.log('✅ negative with down arrow only (DSES up arrow is ignored)');
}
// Unicode minus
{
  const r = parseLegacyDsex(page(`<tr><td>DSE<span>X</span> Index</td><td>5410.00</td><td>\u221219.37</td><td>\u22120.36%</td></tr>`));
  assert.strictEqual(r.change, -19.37);
  console.log('✅ unicode minus');
}
// DSES row must never be mistaken for DSEX
{
  assert.throws(() => parseLegacyDsex(page(`<tr><td>DSE<span>S</span> Index</td><td>1077.95</td><td>5.5</td><td>0.5%</td></tr>`)), /not found/);
  console.log('✅ DSES row is not read as DSEX');
}
// New-site text must NOT be hijacked by the legacy parser
{
  const newSite = '<div>Market closed 09:15 BST · DSEX 5,408.90 +0.00 (+0.00%)</div><div>DSEX · BROAD INDEX 5,408.90 ▬0.00 0.00%</div>';
  assert.throws(() => parseLegacyDsex(newSite), /not found/);
  console.log('✅ new-site text is left to the new-site parser');
}

// REAL-WORLD BUG: the label also appears in the navigation menu (with "dropdown" markup).
// The arrow must come from the table row, not from the first label in the HTML.
{
  const nav = `<ul class="nav"><li class="dropdown"><a class="dropdown-toggle" href="/indices">DSE<b>X</b> Index</a>
               <ul class="dropdown-menu"><li><a href="/dsex">DSEX Index</a></li></ul></li></ul>`;
  const row = arrow => `<tr><td>DSE<span>X</span> Index</td><td>5452.05858</td><td>22.68731</td><td>0.41786%</td><td>${arrow}</td></tr>
                        <tr><td>DSE<span>S</span> Index</td><td>1077.95857</td><td>5.51703</td><td>0.51444%</td><td><img src="down_red.png"></td></tr>`;
  let r = parseLegacyDsex(nav + page(row('<i class="fa fa-angle-double-up" style="color:green"></i>')));
  assert.strictEqual(r.change, 22.68731); assert.strictEqual(r.signSource, 'arrow');
  r = parseLegacyDsex(nav + page(row('<img src="images/up_green.gif">')));
  assert.strictEqual(r.change, 22.68731);
  r = parseLegacyDsex(nav + page(row('<img src="images/down_red.gif">')));
  assert.strictEqual(r.change, -22.68731);
  console.log('✅ nav-menu "dropdown" markup no longer turns an up day into a down day');
}
{
  const r = parseLegacyDsex(page(`<tr><td>DSE<span>X</span> Index</td><td>5452.05858</td><td>22.68731</td><td>0.41786%</td><td></td></tr>`));
  assert.strictEqual(r.signSource, 'none'); assert.strictEqual(r.direction, null);
  console.log('✅ missing arrow => sign reported as unproven (database decides)');
}

// Dates
{
  const now = { year: 2026, iso: '2026-10-16' };
  assert.strictEqual(parsePageDate('Last update on Oct 15, 2026 at 5:26 PM', now), '2026-10-15');
  assert.strictEqual(parsePageDate('last updated 15 Oct at 17:26 BST', now), '2026-10-15');
  assert.strictEqual(parsePageDate('Last update on Jan 3, 2021 at 5:26 PM', now), null);   // too old => ignored
  assert.strictEqual(parsePageDate('nothing here', now), null);
  console.log('✅ page date parsing');
}
console.log('\nAll legacy parser checks passed.');
