const test = require('node:test');
const assert = require('node:assert/strict');
const {
    to24,
    parseMultiSlots,
    parseSectionSlots,
    checkConflict,
    mergeDayIntervals,
    scoreSchedule,
    solveSchedules
} = require('../public/schedule-core');

function makeSection(courseName, secNo, times, status = 'متاحة', room = 'قاعة 1') {
    const sec = {
        'اسم المادة': courseName,
        'ش.': secNo,
        'رقم المادة': courseName,
        'س.': '3',
        'الاوقات': times,
        'القاعات': room,
        'الحالة': status,
        'ملاحظات': room === 'online' ? 'عن بعد' : '',
        _courseName: courseName
    };
    return parseSectionSlots(sec);
}

test('to24 converts onsite and online 12-hour times correctly', () => {
    assert.equal(to24(8, false), 8);
    assert.equal(to24(11, false), 11);
    assert.equal(to24(1, false), 13);
    assert.equal(to24(5, false), 17);
    assert.equal(to24(9, true), 21);
    assert.equal(to24(12, true), 12);
});

test('parseMultiSlots handles single, multi-slot ||, and empty strings', () => {
    assert.deepEqual(parseMultiSlots('ح ث 08:30 10:00'), [
        { days: ['ح', 'ث'], start: '08:30', end: '10:00' }
    ]);
    assert.deepEqual(parseMultiSlots('ن ر 08:30 09:30 || ث 02:30 05:30'), [
        { days: ['ن', 'ر'], start: '08:30', end: '09:30' },
        { days: ['ث'], start: '02:30', end: '05:30' }
    ]);
    assert.deepEqual(parseMultiSlots(''), []);
});

test('checkConflict detects overlaps and allows touching boundaries', () => {
    const s1 = makeSection('A', '1', 'ح ث 09:30 10:30');
    const s2 = makeSection('B', '1', 'ح ث 10:30 11:30');
    const s3 = makeSection('C', '1', 'ث 10:00 11:00');
    const s4 = makeSection('D', '1', 'ن ر 09:30 10:30');

    assert.equal(checkConflict(s1, s2), false);
    assert.equal(checkConflict(s1, s3), true);
    assert.equal(checkConflict(s1, s4), false);
});

test('scoreSchedule excludes online sections from days/breaks and supports sort modes', () => {
    const onsiteA = makeSection('A', '1', 'ح 08:00 09:00');
    const onsiteB = makeSection('B', '1', 'ح 11:00 12:00');
    const onlineC = makeSection('C', '1', 'ن ر 04:00 05:00', 'متاحة', 'online');

    const balanced = scoreSchedule([onsiteA, onsiteB, onlineC], 'balanced');
    assert.equal(balanced.days, 1);
    assert.equal(balanced.breaks, 120);

    const morning = scoreSchedule([onsiteA, onsiteB], 'morning');
    const afternoon = scoreSchedule([onsiteA, onsiteB], 'afternoon');
    assert.ok(morning.total > 0 && afternoon.total > 0);
});

test('mergeDayIntervals merges contiguous and overlapping slots while preserving disjoint ones', () => {
    const merged = mergeDayIntervals([
        { start: 9 * 60 + 30, end: 10 * 60 },
        { start: 8 * 60 + 30, end: 9 * 60 + 30 },
        { start: 11 * 60, end: 12 * 60 }
    ]);
    assert.deepEqual(merged, [
        { start: 8 * 60 + 30, end: 10 * 60 },
        { start: 11 * 60, end: 12 * 60 }
    ]);
});

test('scoreSchedule differentiates morning, afternoon, fewest_days, and least_breaks modes', () => {
    // Schedule A: 3 morning days, 0 breaks, 8:30-10:30
    const schedMorning = [
        makeSection('M1', '1', 'ح ن ث 08:30 09:30'),
        makeSection('M2', '1', 'ح ن ث 09:30 10:30')
    ];
    // Schedule B: 2 afternoon days, 60m break, 1:00-4:00 PM
    const schedAfternoon = [
        makeSection('M1', '2', 'ن ر 01:00 02:00'),
        makeSection('M2', '2', 'ن ر 03:00 04:00')
    ];

    assert.ok(scoreSchedule(schedMorning, 'morning').total < scoreSchedule(schedAfternoon, 'morning').total);
    assert.ok(scoreSchedule(schedAfternoon, 'afternoon').total < scoreSchedule(schedMorning, 'afternoon').total);
    assert.ok(scoreSchedule(schedAfternoon, 'fewest_days').total < scoreSchedule(schedMorning, 'fewest_days').total);
    assert.ok(scoreSchedule(schedMorning, 'least_breaks').total < scoreSchedule(schedAfternoon, 'least_breaks').total);
});

test('solveSchedules returns true Top-K, filters closed/excluded days, and reports pairwise & 3-way conflicts', () => {
    const c1 = [
        makeSection('C1', '1', 'ح 08:00 09:00', 'مغلقة'),
        makeSection('C1', '2', 'ح 09:00 10:00', 'متاحة'),
        makeSection('C1', '3', 'ن 09:00 10:00', 'متاحة')
    ];
    const c2 = [
        makeSection('C2', '1', 'ح 10:00 11:00', 'متاحة'),
        makeSection('C2', '2', 'ح 12:00 01:00', 'متاحة')
    ];

    // Open-only & Top-1 should pick the 0-break schedule (C1 sec 2 + C2 sec 1)
    const res = solveSchedules([c1, c2], { maxSchedules: 1, openOnly: true, sortMode: 'balanced' });
    assert.equal(res.scoredSchedules.length, 1);
    assert.equal(res.scoredSchedules[0].score.breaks, 0);
    assert.equal(res.wasCapped, true);

    // Excluded day 'ح' leaves C2 with 0 sections -> filtered_out
    const filteredRes = solveSchedules([c1, c2], { excludedDays: ['ح'] });
    assert.equal(filteredRes.conflictReason, 'filtered_out');
    assert.deepEqual(filteredRes.filteredOutCourses, ['C2']);

    // 3-way conflict: each pair can coexist, but all 3 cannot
    const x = [makeSection('X', '1', 'ح 08:00 09:00'), makeSection('X', '2', 'ن 08:00 09:00')];
    const y = [makeSection('Y', '1', 'ح 08:00 09:00'), makeSection('Y', '2', 'ن 08:00 09:00')];
    const z = [makeSection('Z', '1', 'ح 08:00 09:00'), makeSection('Z', '2', 'ن 08:00 09:00')];
    const threeWay = solveSchedules([x, y, z]);
    assert.equal(threeWay.totalFound, 0);
    assert.equal(threeWay.conflictReason, 'multi_way');
});
