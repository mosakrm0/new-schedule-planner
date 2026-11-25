(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ScheduleCore = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DAY_CHARS = new Set(['ح', 'ن', 'ث', 'ر', 'خ', 'س', 'ج']);
    const DAY_FULL = {
        'س': 'السبت',
        'ح': 'الأحد',
        'ن': 'الإثنين',
        'ث': 'الثلاثاء',
        'ر': 'الأربعاء',
        'خ': 'الخميس',
        'ج': 'الجمعة'
    };
    const DAY_ORDER = ['س', 'ح', 'ن', 'ث', 'ر', 'خ', 'ج'];
    const CALENDAR_DAY_ORDER = ['ح', 'ن', 'ث', 'ر', 'خ', 'س'];

    function normalizeAr(s) {
        return (s || '')
            .replace(/\s+/g, ' ')
            .replace(/[ـ]/g, '')
            .replace(/[أإآ]/g, 'ا')
            .replace(/ى/g, 'ي')
            .trim();
    }

    // University times are 12-hour format without AM/PM.
    // Online sections  : noon -> midnight (hours 1-11 -> PM)
    // In-person sections: 8 AM -> 5 PM   (hours 1-7  -> PM, 8-12 -> AM)
    function to24(h, isOnline) {
        if (isOnline) return (h >= 1 && h <= 11) ? h + 12 : h;
        return (h >= 1 && h <= 7) ? h + 12 : h;
    }

    function isOnlineSection(section) {
        if (!section) return false;
        const fields = [section['القاعات'], section['الاوقات'], section['ملاحظات']];
        return fields.some(f => f && (String(f).toLowerCase().includes('online') || String(f).includes('عن بعد')));
    }

    function isClosedSection(section) {
        return String(section?.['الحالة'] || '').trim() === 'مغلقة';
    }

    function parseMultiSlots(timeStr) {
        if (!timeStr || String(timeStr).trim() === '') return [];
        const cleaned = String(timeStr)
            .replace(/<br\s*\/?>/gi, ' ')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\|\|/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const parts = cleaned.split(/\s+/);
        const slots = [];
        let days = [];
        let times = [];

        const flush = () => {
            if (days.length > 0 && times.length === 2) {
                slots.push({ days: [...days], start: times[0], end: times[1] });
            }
            days = [];
            times = [];
        };

        for (const p of parts) {
            if (DAY_CHARS.has(p)) {
                if (times.length === 2) flush();
                days.push(p);
            } else if (/^\d{1,2}:\d{2}$/.test(p)) {
                times.push(p);
            }
        }
        flush();

        if (slots.length === 0 && cleaned !== '') return [{ raw: cleaned }];
        return slots;
    }

    function slotTimeToMinutes(t, isOnline) {
        if (!t) return 0;
        const parts = String(t).split(':').map(Number);
        if (parts.length !== 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return 0;
        return to24(parts[0], isOnline) * 60 + parts[1];
    }

    function parseSectionSlots(section) {
        const online = isOnlineSection(section);
        const rawSlots = parseMultiSlots(section['الاوقات']);
        section._rawSlots = rawSlots;
        section._parsedSlots = rawSlots
            .filter(slot => slot.days && slot.start && slot.end)
            .map(slot => ({
                days: slot.days,
                start: slotTimeToMinutes(slot.start, online),
                end: slotTimeToMinutes(slot.end, online)
            }));
        return section;
    }

    function checkConflict(s1, s2) {
        const slots1 = s1._parsedSlots;
        const slots2 = s2._parsedSlots;
        if (!slots1 || !slots2 || slots1.length === 0 || slots2.length === 0) return false;
        for (const t1 of slots1) {
            for (const t2 of slots2) {
                const commonDays = t1.days.filter(d => t2.days.includes(d));
                if (commonDays.length === 0) continue;
                if (t1.start < t2.end && t2.start < t1.end) return true;
            }
        }
        return false;
    }

    function countDays(schedule) {
        const days = new Set();
        schedule.forEach(s => {
            if (isOnlineSection(s)) return;
            (s._parsedSlots || []).forEach(slot => {
                slot.days.forEach(d => days.add(d));
            });
        });
        return days.size;
    }

    function countBreakMinutes(schedule) {
        const dayMap = {};
        schedule.forEach(s => {
            if (isOnlineSection(s)) return;
            (s._parsedSlots || []).forEach(slot => {
                slot.days.forEach(d => {
                    if (!dayMap[d]) dayMap[d] = [];
                    dayMap[d].push(slot);
                });
            });
        });

        let totalBreaks = 0;
        Object.values(dayMap).forEach(slots => {
            slots.sort((a, b) => a.start - b.start);
            for (let i = 0; i < slots.length - 1; i++) {
                const gap = slots[i + 1].start - slots[i].end;
                if (gap > 0) totalBreaks += gap;
            }
        });
        return totalBreaks;
    }

    function mergeDayIntervals(intervals) {
        if (!Array.isArray(intervals) || intervals.length === 0) return [];
        const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
        const merged = [{ start: sorted[0].start, end: sorted[0].end }];
        for (let i = 1; i < sorted.length; i++) {
            const cur = merged[merged.length - 1];
            const next = sorted[i];
            if (next.start <= cur.end) {
                cur.end = Math.max(cur.end, next.end);
            } else {
                merged.push({ start: next.start, end: next.end });
            }
        }
        return merged;
    }

    function getTimeBounds(schedule) {
        let earliest = Infinity;
        let latest = -Infinity;
        let startSum = 0;
        let slotCount = 0;
        let hasOnsite = false;

        schedule.forEach(s => {
            if (isOnlineSection(s)) return;
            (s._parsedSlots || []).forEach(slot => {
                hasOnsite = true;
                if (slot.start < earliest) earliest = slot.start;
                if (slot.end > latest) latest = slot.end;
                startSum += slot.start;
                slotCount++;
            });
        });

        if (!hasOnsite) {
            schedule.forEach(s => {
                (s._parsedSlots || []).forEach(slot => {
                    if (slot.start < earliest) earliest = slot.start;
                    if (slot.end > latest) latest = slot.end;
                    startSum += slot.start;
                    slotCount++;
                });
            });
        }

        return {
            earliest: earliest === Infinity ? 0 : earliest,
            latest: latest === -Infinity ? 0 : latest,
            avgStart: slotCount > 0 ? Math.round(startSum / slotCount) : 0
        };
    }

    function scoreSchedule(schedule, sortMode) {
        const mode = sortMode || 'balanced';
        const days = countDays(schedule);
        const breaks = countBreakMinutes(schedule);
        const { earliest, latest, avgStart } = getTimeBounds(schedule);

        let total;
        switch (mode) {
            case 'fewest_days':
                total = days * 100000 + breaks * 10 + latest;
                break;
            case 'least_breaks':
                total = breaks * 10000 + days * 100 + latest;
                break;
            case 'morning':
                total = latest * 1000 + avgStart * 100 + days * 50 + breaks;
                break;
            case 'afternoon':
                total = (24 * 60 - earliest) * 1000 + (24 * 60 - avgStart) * 100 + days * 50 + breaks;
                break;
            case 'balanced':
            default:
                total = days * 1200 + breaks * 10 + Math.round(avgStart / 10);
                break;
        }

        return { days, breaks, earliest, latest, avgStart, total };
    }

    function filterCourseSections(sections, options) {
        const openOnly = Boolean(options.openOnly);
        const excludedSet = new Set(Array.isArray(options.excludedDays) ? options.excludedDays : []);

        return sections.filter(sec => {
            if (openOnly && isClosedSection(sec)) return false;
            if (excludedSet.size > 0 && !isOnlineSection(sec)) {
                const slots = sec._parsedSlots || [];
                for (const slot of slots) {
                    if ((slot.days || []).some(d => excludedSet.has(d))) return false;
                }
            }
            return true;
        });
    }

    function solveSchedules(coursesSections, options) {
        const opts = options || {};
        const maxSchedules = opts.maxSchedules || 100;
        const maxEvaluations = opts.maxEvaluations || 100000;
        const timeLimitMs = opts.timeLimitMs || 1500;
        const sortMode = opts.sortMode || 'balanced';

        if (!Array.isArray(coursesSections) || coursesSections.length === 0) {
            return {
                scoredSchedules: [],
                validSchedules: [],
                totalFound: 0,
                wasCapped: false,
                incompatiblePairs: [],
                conflictReason: '',
                filteredOutCourses: []
            };
        }

        const filteredCourses = [];
        const filteredOutCourses = [];

        for (const secs of coursesSections) {
            const kept = filterCourseSections(secs, opts);
            if (kept.length === 0) {
                filteredOutCourses.push(secs[0]?._courseName || secs[0]?.['اسم المادة'] || 'مادة');
            }
            filteredCourses.push(kept);
        }

        if (filteredOutCourses.length > 0) {
            return {
                scoredSchedules: [],
                validSchedules: [],
                totalFound: 0,
                wasCapped: false,
                incompatiblePairs: [],
                conflictReason: 'filtered_out',
                filteredOutCourses
            };
        }

        // Fail-first: process courses with fewest sections first
        const ordered = [...filteredCourses].sort((a, b) => a.length - b.length);
        const topK = [];
        let totalFound = 0;
        let stoppedEarly = false;
        const startTime = Date.now();

        function insertTopK(entry) {
            // Binary insertion keeping topK sorted ascending by score.total
            let lo = 0;
            let hi = topK.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (topK[mid].score.total <= entry.score.total) lo = mid + 1;
                else hi = mid;
            }
            topK.splice(lo, 0, entry);
            if (topK.length > maxSchedules) topK.pop();
        }

        function backtrack(idx, current) {
            if (stoppedEarly) return;
            if (totalFound >= maxEvaluations || (totalFound > 0 && totalFound % 256 === 0 && (Date.now() - startTime) >= timeLimitMs)) {
                stoppedEarly = true;
                return;
            }
            if (idx === ordered.length) {
                totalFound++;
                const sched = [...current];
                const score = scoreSchedule(sched, sortMode);
                if (topK.length < maxSchedules || score.total < topK[topK.length - 1].score.total) {
                    insertTopK({ schedule: sched, score });
                }
                return;
            }
            for (const section of ordered[idx]) {
                let conflict = false;
                for (const chosen of current) {
                    if (checkConflict(section, chosen)) {
                        conflict = true;
                        break;
                    }
                }
                if (!conflict) {
                    current.push(section);
                    backtrack(idx + 1, current);
                    current.pop();
                    if (stoppedEarly) return;
                }
            }
        }

        backtrack(0, []);

        const incompatiblePairs = [];
        let conflictReason = '';
        if (totalFound === 0) {
            for (let i = 0; i < ordered.length; i++) {
                for (let j = i + 1; j < ordered.length; j++) {
                    const courseA = ordered[i];
                    const courseB = ordered[j];
                    let canCoexist = false;
                    for (const secA of courseA) {
                        for (const secB of courseB) {
                            if (!checkConflict(secA, secB)) {
                                canCoexist = true;
                                break;
                            }
                        }
                        if (canCoexist) break;
                    }
                    if (!canCoexist) {
                        const n1 = courseA[0]._courseName || courseA[0]['اسم المادة'];
                        const n2 = courseB[0]._courseName || courseB[0]['اسم المادة'];
                        incompatiblePairs.push(`${n1} | ${n2}`);
                    }
                }
            }
            conflictReason = incompatiblePairs.length > 0 ? 'pairwise' : 'multi_way';
        }

        return {
            scoredSchedules: topK,
            validSchedules: topK.map(item => item.schedule),
            totalFound,
            wasCapped: totalFound > maxSchedules || stoppedEarly,
            incompatiblePairs,
            conflictReason,
            filteredOutCourses: []
        };
    }

    return {
        DAY_CHARS,
        DAY_FULL,
        DAY_ORDER,
        CALENDAR_DAY_ORDER,
        normalizeAr,
        to24,
        isOnlineSection,
        isClosedSection,
        parseMultiSlots,
        slotTimeToMinutes,
        parseSectionSlots,
        checkConflict,
        countDays,
        countBreakMinutes,
        mergeDayIntervals,
        getTimeBounds,
        scoreSchedule,
        filterCourseSections,
        solveSchedules
    };
});
