const test = require('node:test');
const assert = require('node:assert/strict');
const {
    safeParseArray,
    stripHtml,
    processScrapedRows,
    shouldAcceptScrape
} = require('../lib/scraper-utils');

test('safeParseArray parses valid JSON and JSON5 object literals while filtering non-objects', () => {
    assert.deepEqual(safeParseArray('[{"id":1,"name":"CS"}]'), [{ id: 1, name: 'CS' }]);
    assert.deepEqual(safeParseArray("[{id: 2, name: 'EE'}]"), [{ id: 2, name: 'EE' }]);
    assert.deepEqual(safeParseArray('not-an-array'), []);
    assert.deepEqual(safeParseArray('[1, "x", null, {id: 3}]'), [{ id: 3 }]);
});

test('stripHtml collapses repeated <br> and || || artifacts', () => {
    assert.equal(stripHtml('ح ث 08:30 09:30<br><br>ن ر 10:00 11:00'), 'ح ث 08:30 09:30 || ن ر 10:00 11:00');
    assert.equal(stripHtml('هـ.ت || || هـ.ت'), 'هـ.ت || هـ.ت');
    assert.equal(stripHtml('<br>  <span>قاعة 1</span> <br/> '), 'قاعة 1');
});

test('processScrapedRows disambiguates internship, adds عام GP rows, and merges split sections cleanly', () => {
    const rows = [
        {
            dept: 'هندسة الحاسوب',
            college: 'كلية الهندسة',
            row: ['101', 'التدريب الميداني', '3', '1', 'ح 08:00 09:00', 'د. علي', 'قاعة 1', 'متاحة', '']
        },
        {
            dept: 'هندسة الحاسوب',
            college: 'كلية الهندسة',
            row: ['202', 'برمجة', '3', '1', 'ح 09:00 10:00', 'د. سارة', 'مختبر 1', 'متاحة', '']
        },
        {
            dept: 'هندسة الحاسوب',
            college: 'كلية الهندسة',
            row: ['202', 'برمجة', '3', '1', 'ن 10:00 11:00 || || ', 'د. سارة', 'مختبر 2', 'متاحة', '']
        },
        {
            dept: 'هندسة الحاسوب',
            college: 'كلية الهندسة',
            row: ['999', 'مشروع التخرج 1', '3', '1', '', '', '', 'متاحة', '']
        }
    ];

    const out = processScrapedRows(rows);
    const internship = out.find(r => r['رقم المادة'] === '101');
    assert.equal(internship['اسم المادة'], 'التدريب الميداني (3 ساعات) — هندسة الحاسوب');

    const merged = out.find(r => r['رقم المادة'] === '202');
    assert.equal(merged['الاوقات'], 'ح 09:00 10:00 || ن 10:00 11:00');
    assert.equal(merged['المحاضرين'], 'د. سارة');
    assert.equal(merged['القاعات'], 'مختبر 1 / مختبر 2');

    const gpRows = out.filter(r => r['رقم المادة'].startsWith('GP'));
    assert.equal(gpRows.length, 3);
    assert.ok(gpRows.every(r => r['الكلية'] === 'عام' && r['القسم'] === 'مشاريع التخرج'));
});

test('shouldAcceptScrape rejects empty scrapes, enforces 50% guard when fresh, and bypasses when >7 days stale', () => {
    const now = Date.parse('2026-06-10T00:00:00Z');
    const freshIso = '2026-06-09T00:00:00Z';
    const staleIso = '2026-06-01T00:00:00Z';

    assert.equal(shouldAcceptScrape(0, 100, freshIso, now), false);
    assert.equal(shouldAcceptScrape(60, 100, freshIso, now), true);
    assert.equal(shouldAcceptScrape(40, 100, freshIso, now), false);
    assert.equal(shouldAcceptScrape(40, 100, staleIso, now), true);
    assert.equal(shouldAcceptScrape(10, 0, freshIso, now), true);
});

test('stripHtml and processScrapedRows handle numeric fields, literal null rooms, and status precedence', () => {
    assert.equal(stripHtml(203), '203');
    const out = processScrapedRows([
        {
            dept: 'هندسة الحاسوب',
            college: 'كلية الهندسة',
            row: [30801101, 'برمجة', 3, 1, 'ح 08:00 09:00', 'د. علي', 'null || 203', 'متاحة', '']
        },
        {
            dept: 'هندسة الحاسوب',
            college: 'كلية الهندسة',
            row: [30801101, 'برمجة', 3, 1, 'ن 09:00 10:00', 'د. علي', 'null', 'مغلقة', '']
        }
    ], { includeGraduationProjects: false });

    assert.equal(out.length, 1);
    assert.equal(out[0]['رقم المادة'], '30801101');
    assert.equal(out[0]['القاعات'], '203');
    assert.equal(out[0]['الحالة'], 'مغلقة');
});
