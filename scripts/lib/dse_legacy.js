// scripts/lib/dse_legacy.js
// Robust parser for the legacy DSE home page (https://old.dsebd.org/).
//
// Why this exists: on the legacy page the label "DSEX Index" is built from several
// inline tags (for example DSE<span>X</span> Index) and the values sit in sibling cells.
// Tag-by-tag cell matching is fragile, so this module converts the page to text in a way
// that keeps inline tags glued together (DSE + X = DSEX) and then reads the numbers that
// follow each label. It has no third-party dependencies so it can be unit-tested offline.

const INLINE_TAGS = 'a|b|i|u|em|strong|span|font|small|big|sup|sub|label|abbr|mark';
const INLINE_RE = new RegExp(`</?(?:${INLINE_TAGS})(?:\\s[^>]*)?>`, 'gi');

const NUM = '[\\d,]+(?:\\.\\d+)?';
const SGN = '[-+\\u2212\\u2013]?\\s*';

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function decodeEntities(value) {
  return String(value)
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

// Inline tags are removed WITHOUT adding a space; every other tag becomes a space.
function htmlToLegacyText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(INLINE_RE, '')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(value) {
  if (value == null) return null;
  const normalized = String(value).replace(/[\u2212\u2013]/g, '-').replace(/,/g, '').replace(/\s+/g, '');
  const m = normalized.match(/[-+]?\d+(?:\.\d+)?/);
  if (!m) return null;
  return Number(m[0]);
}

function dhakaToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { year: Number(p.year), iso: `${p.year}-${p.month}-${p.day}` };
}

function isoDate(year, month, day) {
  if (!year || !month || !day) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// "Last update on Oct 15, 2026 at 5:26 PM"  (legacy)
// "last updated 15 Oct at 17:26 BST"          (current site, year omitted)
// Returns YYYY-MM-DD, or null when nothing plausible is found. A date more than 6 days
// away from today in Dhaka is treated as a mis-parse and ignored.
function parsePageDate(text, now = dhakaToday()) {
  const source = String(text || '');
  let iso = null;

  let m = source.match(/Last\s+update(?:d)?\s+on\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i);
  if (m) iso = isoDate(Number(m[3]), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]));

  if (!iso) {
    m = source.match(/Last\s+update(?:d)?\s+(?:on\s+)?(\d{1,2})\s+([A-Za-z]{3,9}),?(?:\s+(\d{4}))?/i);
    if (m) iso = isoDate(m[3] ? Number(m[3]) : now.year, MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
  }

  if (!iso) return null;
  const diffDays = Math.abs((Date.parse(iso) - Date.parse(now.iso)) / 86400000);
  return diffDays <= 6 ? iso : null;
}

// Reads the up/down arrow that belongs to the DSEX row and returns 'up', 'down' or null.
//
// The label "DSEX Index" can appear several times in the raw HTML (for example in the site's
// navigation menu), so the occurrence is chosen by its content: it must be followed, in the
// page text, by the same index value that was parsed. Only the markup of that row (up to the
// next DSES label) is inspected, and keywords must be whole words (so "dropdown" is not "down").
const LABEL_TAGS = '(?:<[^>]*>|\\s|&nbsp;)*';
function arrowDirection(html, valueRaw) {
  const raw = String(html || '');
  const labelRe = new RegExp(`D${LABEL_TAGS}S${LABEL_TAGS}E${LABEL_TAGS}X${LABEL_TAGS}Index`, 'gi');
  const nextRe = new RegExp(`D${LABEL_TAGS}S${LABEL_TAGS}E${LABEL_TAGS}S${LABEL_TAGS}Index`, 'i');
  const valueDigits = String(valueRaw || '').replace(/,/g, '').trim();

  let chosen = null;
  let m;
  while ((m = labelRe.exec(raw)) !== null) {
    const ahead = htmlToLegacyText(raw.slice(m.index, m.index + 900)).replace(/,/g, '');
    if (!valueDigits || ahead.includes(valueDigits)) { chosen = m; break; }
  }
  if (!chosen) return null;

  let slice = raw.slice(chosen.index, chosen.index + 1800);
  const next = nextRe.exec(slice.slice(12));
  if (next) slice = slice.slice(0, next.index + 12);

  const attrs = [];
  slice.replace(/(?:src|alt|class|title|style|data-[\w-]+)\s*=\s*["']([^"']*)["']/gi, (whole, v) => { attrs.push(v); return whole; });
  const glyphs = (slice.match(/[\u25b2\u25bc\u2191\u2193]/g) || []).join(' ');
  const joined = `${attrs.join(' ')} ${glyphs}`;

  const word = w => new RegExp(`(?<![a-z])(?:${w})(?![a-z])`, 'i');
  const down = word('down|decline|declined|decrease|negative|loss|red').test(joined) || /[\u25bc\u2193]/.test(joined);
  const up = word('up|advance|advanced|increase|positive|gain|green').test(joined) || /[\u25b2\u2191]/.test(joined);
  if (down && !up) return 'down';
  if (up && !down) return 'up';
  return null;
}

function labelRegex(label) {
  // DSEX / DSES / DS30 followed by "Index"; tolerant to spaces between the letters.
  const letters = label.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
  return new RegExp(`${letters}\\s*Index`, 'i');
}

function readIndexRow(text, label) {
  const strict = new RegExp(
    `${labelRegex(label).source}\\s+(${NUM})\\s+(${SGN}${NUM})\\s+(${SGN}${NUM})\\s*%`, 'i'
  ).exec(text);
  if (strict) {
    return { value: toNumber(strict[1]), valueRaw: strict[1], changeRaw: strict[2], percentRaw: strict[3], mode: 'strict' };
  }

  // Loose: take the numbers that follow the label (extra cells / icons in between).
  const at = labelRegex(label).exec(text);
  if (!at) return null;
  const window = text.slice(at.index + at[0].length, at.index + at[0].length + 260);
  const tokens = window.match(new RegExp(`${SGN}${NUM}\\s*%?`, 'g')) || [];
  const plain = tokens.filter(t => !t.includes('%'));
  const percent = tokens.find(t => t.includes('%'));
  if (plain.length >= 2 && percent) {
    return { value: toNumber(plain[0]), valueRaw: plain[0], changeRaw: plain[1], percentRaw: percent.replace('%', ''), mode: 'loose' };
  }
  return null;
}

// Returns { dsex, change, change_percent, source } or throws with a helpful diagnostic.
function parseLegacyDsex(html) {
  const text = htmlToLegacyText(html);
  const row = readIndexRow(text, 'DSEX');

  if (!row) {
    const at = /DSE\s*X/i.exec(text);
    const context = at ? text.slice(at.index, at.index + 220) : '(label DSEX not present in page text)';
    throw new Error(`Legacy DSEX Index row not found. Page text near label: ${context}`);
  }

  const dsex = row.value;
  if (!(dsex >= 1000 && dsex <= 30000)) throw new Error(`Legacy DSEX value out of range: ${dsex}`);

  let change = toNumber(row.changeRaw);
  let percent = toNumber(row.percentRaw);
  if (change == null || percent == null) throw new Error('Legacy DSEX change values are not numeric');

  // signSource tells the caller how much to trust the sign:
  //   'text'  - the page itself printed a minus sign (trusted)
  //   'arrow' - taken from the up/down arrow markup of the DSEX row (cross-check with the database)
  //   'none'  - nothing proves the sign (must be resolved from the database)
  const hasMinus = /[-\u2212\u2013]/.test(row.changeRaw) || /[-\u2212\u2013]/.test(row.percentRaw);
  let direction = null;
  let signSource = 'none';
  if (hasMinus) { direction = 'down'; signSource = 'text'; }
  else {
    direction = arrowDirection(html, row.valueRaw);
    if (direction) signSource = 'arrow';
  }
  if (direction === 'down') { change = -Math.abs(change); percent = -Math.abs(percent); }
  else { change = Math.abs(change); percent = Math.abs(percent); }

  // Consistency: change / previous close should equal the reported percent.
  const prev = dsex - change;
  if (prev > 0 && Math.abs((change / prev) * 100 - percent) > 0.05) {
    console.warn(`⚠️ Legacy DSEX change (${change}) and percent (${percent}) are not consistent; check the page layout.`);
  }

  return {
    dsex,
    change: Number(change.toFixed(5)),
    change_percent: Number(percent.toFixed(5)),
    direction,          // null means the sign could not be proven from the page
    signSource,
    mode: row.mode,
  };
}

// Reads Total Trade / Total Volume / Total Value (mn) and Issues Advanced / declined / unchanged
// from the legacy page. Header cells and value cells are consecutive in the page text.
function parseLegacySummary(html) {
  const text = htmlToLegacyText(html);

  const activity = new RegExp(
    `Total\\s*Trade\\s+Total\\s*Volume\\s+Total\\s*Value\\s*in\\s*Taka\\s*\\(\\s*mn\\s*\\)\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})`, 'i'
  ).exec(text);
  const breadth = new RegExp(
    `Issues\\s*Advanced\\s+Issues\\s*declined\\s+Issues\\s*Unchanged\\s+(${NUM})\\s+(${NUM})\\s+(${NUM})`, 'i'
  ).exec(text);

  if (!activity) throw new Error('Legacy Total Trade / Volume / Value row not found');
  if (!breadth) throw new Error('Legacy Issues Advanced / declined / unchanged row not found');

  return {
    total_trades: toNumber(activity[1]),
    total_volume: toNumber(activity[2]),
    total_value: toNumber(activity[3]),
    advanced: toNumber(breadth[1]),
    declined: toNumber(breadth[2]),
    unchanged: toNumber(breadth[3]),
  };
}

module.exports = {
  htmlToLegacyText, parsePageDate, arrowDirection, parseLegacyDsex, parseLegacySummary, toNumber,
};
