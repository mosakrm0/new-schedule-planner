const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSectionSlots } = require('../public/schedule-core');

function parseCSVLine(line) {
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            cells.push(cur);
            cur = '';
        } else {
            cur += ch;
        }
    }
    cells.push(cur);
    return cells;
}

test('all bundled CSV datasets parse with zero inverted or >12h slots', () => {
    const dataDir = path.join(__dirname, '..', 'public', 'data');
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));
    assert.ok(files.length > 0, 'Expected CSV files in public/data');

    for (const file of files) {
        const raw = fs.readFileSync(path.join(dataDir, file), 'utf8').replace(/^\uFEFF/, '');
        const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
        const headers = parseCSVLine(lines[0]);

        for (let i = 1; i < lines.length; i++) {
            const values = parseCSVLine(lines[i]);
            const row = {};
            headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
            if (String(row['الحالة']).trim() === 'ملغاة') continue;

            parseSectionSlots(row);
            for (const slot of row._parsedSlots) {
                assert.ok(
                    slot.start < slot.end,
                    `${file} line ${i + 1} (${row['اسم المادة']}): inverted slot ${slot.start} >= ${slot.end} from "${row['الاوقات']}"`
                );
                assert.ok(
                    (slot.end - slot.start) <= 12 * 60,
                    `${file} line ${i + 1} (${row['اسم المادة']}): >12h slot ${slot.start}..${slot.end}`
                );
            }
        }
    }
});
