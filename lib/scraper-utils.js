const JSON5 = require('json5');

const TABLE_COLS = ['رقم المادة', 'اسم المادة', 'س.', 'ش.', 'الاوقات', 'المحاضرين', 'القاعات', 'الحالة', 'ملاحظات'];
const HEADERS = ['الكلية', 'القسم', ...TABLE_COLS];
const EXCLUDED_DEPTS = ['القبول والتسجيل', 'العلوم الهندسية الاساسية'];
const SKIP_COLLEGES = ['كلية الدراسات العليا', 'كليات وجامعات اخرى'];
const STATUS_DESC = ['', 'متاحة', 'ملغاة', 'مغلقة'];
const PROJECT_NAMES = ['مشروع التخرج', 'مشروع 1', 'مشروع 2', 'مشروع التخرج 2', 'مشروع التخرج 1', 'مشروع التخرج1', 'مشروع التخرج2'];
const STALE_DATA_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Safely parse RMI API responses (which may be valid JSON or unquoted JS object-literal arrays).
 * Uses JSON.parse first, then falls back to JSON5.parse, and filters to plain objects only.
 */
function safeParseArray(text) {
    if (!text || typeof text !== 'string') return [];
    const trimmed = text.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];

    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed)
            ? parsed.filter(item => item !== null && typeof item === 'object' && !Array.isArray(item))
            : [];
    } catch { /* fall through to JSON5 */ }

    try {
        const result = JSON5.parse(trimmed);
        if (!Array.isArray(result)) return [];
        return result.filter(item =>
            item !== null &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            Object.getPrototypeOf(item) === Object.prototype
        );
    } catch {
        return [];
    }
}

function toStr(v) {
    return v == null ? '' : String(v);
}

/**
 * Normalize Arabic text for consistent comparisons (whitespace, tatweel, alef/ya variants).
 */
function normalizeAr(s) {
    return toStr(s)
        .replace(/\s+/g, ' ')
        .replace(/[ـ]/g, '')
        .replace(/[أإآ]/g, 'ا')
        .replace(/ى/g, 'ي')
        .trim();
}

function normProjectKey(s) {
    return normalizeAr(s).replace(/(\D)(\d+)$/, '$1 $2');
}

const PROJECT_KEYS = new Set(PROJECT_NAMES.map(n => normProjectKey(n)));

/**
 * Clean HTML fragments from RMI fields, collapsing repeated <br> or || separators.
 */
function stripHtml(s) {
    return toStr(s)
        .replace(/<br\s*\/?>/gi, ' || ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\r\n]+/g, ' ')
        .replace(/(?:\s*\|\|\s*)+/g, ' || ')
        .replace(/\s+/g, ' ')
        .replace(/^\s*\|\|\s*|\s*\|\|\s*$/g, '')
        .trim();
}

/**
 * Clean room field, stripping HTML, literal "null" placeholders, and normalizing separators.
 */
function cleanRoomField(s) {
    const cleaned = stripHtml(s);
    if (!cleaned) return '';
    const seen = new Set();
    const tokens = [];
    for (const part of cleaned.split(/\s*(?:\|\||\/)\s*/)) {
        const t = part.trim();
        if (!t || /^null$/i.test(t) || seen.has(t)) continue;
        seen.add(t);
        tokens.push(t);
    }
    return tokens.join(' / ');
}

const STATUS_PRIORITY = {
    'ملغاة': 3,
    'مغلقة': 2,
    'متاحة': 1,
    '': 0
};

/**
 * Transform raw scraped rows into normalized, deduplicated, and merged course section objects.
 */
function processScrapedRows(allRows, options = {}) {
    const { includeGraduationProjects = true } = options || {};

    let processed = (allRows || []).map(({ dept, college, row }) => {
        const obj = {
            'الكلية': toStr(college).replace(/[\r\n]+/g, ' ').trim(),
            'القسم': toStr(dept).replace(/[\r\n]+/g, ' ').trim()
        };
        TABLE_COLS.forEach((h, i) => {
            const val = toStr(row?.[i]).replace(/[\r\n]+/g, ' ').trim();
            obj[h] = h === 'القاعات' ? cleanRoomField(val) : val;
        });
        return obj;
    });

    processed = processed.map(r => {
        if (normalizeAr(r['اسم المادة']) === 'التدريب الميداني') {
            const hours = toStr(r['س.']).trim();
            r['اسم المادة'] = `التدريب الميداني${hours ? ` (${hours} ساعات)` : ''} — ${r['القسم']}`;
        }
        return r;
    });

    if (includeGraduationProjects) {
        processed = processed.filter(r => !PROJECT_KEYS.has(normProjectKey(r['اسم المادة'] || '')));

        ['مشروع التخرج', 'مشروع التخرج 1', 'مشروع التخرج 2'].forEach((projName, idx) => {
            const dummy = { 'الكلية': 'عام', 'القسم': 'مشاريع التخرج' };
            TABLE_COLS.forEach(h => { dummy[h] = ''; });
            Object.assign(dummy, {
                'رقم المادة': `GP${idx + 1}000`,
                'اسم المادة': projName,
                'س.': '3',
                'ش.': '1',
                'الحالة': 'متاحة'
            });
            processed.push(dummy);
        });
    }

    const mergeMap = new Map();
    const mergedProcessed = [];
    processed.forEach(r => {
        const key = [r['الكلية'], r['القسم'], r['رقم المادة'], r['ش.']].map(v => toStr(v).trim()).join('||');
        if (!r['رقم المادة'] || !r['ش.']) {
            mergedProcessed.push(r);
            return;
        }
        if (mergeMap.has(key)) {
            const existing = mergeMap.get(key);
            const appendUnique = (field, sep, splitPattern) => {
                const trimSep = sep.trim();
                const splitter = splitPattern || trimSep;
                const aTokens = toStr(existing[field]).split(splitter).map(t => t.trim()).filter(Boolean);
                const bTokens = toStr(r[field]).split(splitter).map(t => t.trim()).filter(Boolean);
                if (bTokens.length === 0) return;
                const seen = new Set(aTokens);
                const newTokens = bTokens.filter(t => !seen.has(t));
                const combined = [...aTokens, ...newTokens];
                existing[field] = combined.join(sep);
            };
            appendUnique('الاوقات', ' || ');
            appendUnique('المحاضرين', ' || ');
            appendUnique('القاعات', ' / ', /\s*(?:\|\||\/)\s*/);

            const curPrio = STATUS_PRIORITY[toStr(existing['الحالة']).trim()] || 0;
            const nextPrio = STATUS_PRIORITY[toStr(r['الحالة']).trim()] || 0;
            if (nextPrio > curPrio) {
                existing['الحالة'] = toStr(r['الحالة']).trim();
            }
        } else {
            const clone = { ...r };
            mergeMap.set(key, clone);
            mergedProcessed.push(clone);
        }
    });

    return mergedProcessed;
}

/**
 * Guard against writing truncated scrapes unless existing data is missing or >7 days stale.
 */
function shouldAcceptScrape(newCount, prevCount, lastFileUpdateIso, nowMs = Date.now()) {
    if (!Number.isFinite(newCount) || newCount <= 0) return false;
    if (!Number.isFinite(prevCount) || prevCount <= 0) return true;
    if (!lastFileUpdateIso) return true;
    const lastMs = new Date(lastFileUpdateIso).getTime();
    if (Number.isNaN(lastMs) || (nowMs - lastMs) > STALE_DATA_MS) return true;
    return newCount >= prevCount * 0.5;
}

module.exports = {
    TABLE_COLS,
    HEADERS,
    EXCLUDED_DEPTS,
    SKIP_COLLEGES,
    STATUS_DESC,
    toStr,
    safeParseArray,
    normalizeAr,
    normProjectKey,
    stripHtml,
    cleanRoomField,
    processScrapedRows,
    shouldAcceptScrape
};
