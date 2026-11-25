const {
    DAY_FULL,
    DAY_ORDER,
    CALENDAR_DAY_ORDER,
    normalizeAr,
    to24,
    isOnlineSection,
    isClosedSection,
    parseMultiSlots,
    parseSectionSlots,
    mergeDayIntervals,
    scoreSchedule
} = window.ScheduleCore;

// =================== Utility: XSS-safe HTML escaping ===================
function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// =================== Toast ===================
function showToast(msg, duration = 3000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    void t.offsetWidth;
    t.classList.add('show');
    setTimeout(() => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 300);
    }, duration);
}

// =================== Global State ===================
let allSections = [];
let coursesByName = {};
let coursesByDept = {};
let selectedCourses = new Set();
let currentPage = 1;
let currentSchedules = [];
let lastSortedSchedules = [];
let lastTotalFound = 0;
let lastWasCapped = false;
let lastConflicts = [];
let lastConflictReason = '';
let lastFilteredOutCourses = [];
let scheduleWorker = null;
const ITEMS_PER_PAGE = 10;

let currentServer = '';
let currentDegree = '';
let currentSubCollege = '';
let availableFiles = new Set();

let userPrefs = {
    sortMode: 'balanced',
    openOnly: true,
    excludedDays: []
};

// =================== Persistence ===================
const STORAGE_KEY = 'bau_selected_courses';
const SERVER_KEY = 'bau_selected_server';
const DEGREE_KEY = 'bau_selected_degree';
const SUBCOLLEGE_KEY = 'bau_selected_subcollege';
const PREFS_KEY = 'bau_prefs';

const LEGACY_KEYS = {
    [STORAGE_KEY]: 'fet_selected_courses',
    [SERVER_KEY]: 'fet_selected_server',
    [DEGREE_KEY]: 'fet_selected_degree',
    [SUBCOLLEGE_KEY]: 'fet_selected_subcollege'
};

function readWithMigration(newKey) {
    const val = localStorage.getItem(newKey);
    if (val !== null) return val;
    const legacyKey = LEGACY_KEYS[newKey];
    if (!legacyKey) return null;
    const legacyVal = localStorage.getItem(legacyKey);
    if (legacyVal !== null) {
        try {
            localStorage.setItem(newKey, legacyVal);
            localStorage.removeItem(legacyKey);
        } catch (_) { }
    }
    return legacyVal;
}

function saveSelectionsToStorage() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...selectedCourses]));
        localStorage.setItem(SERVER_KEY, currentServer);
        localStorage.setItem(DEGREE_KEY, currentDegree);
        localStorage.setItem(SUBCOLLEGE_KEY, currentSubCollege);
        localStorage.setItem(PREFS_KEY, JSON.stringify(userPrefs));
    } catch (_) { }
}

function restoreSelectionsFromStorage() {
    try {
        currentServer = readWithMigration(SERVER_KEY) || '';
        currentDegree = readWithMigration(DEGREE_KEY) || '';
        currentSubCollege = readWithMigration(SUBCOLLEGE_KEY) || '';

        const saved = readWithMigration(STORAGE_KEY);
        if (saved) {
            const arr = JSON.parse(saved);
            if (Array.isArray(arr)) arr.forEach(name => selectedCourses.add(name));
        }

        const savedPrefs = localStorage.getItem(PREFS_KEY);
        if (savedPrefs) {
            const parsed = JSON.parse(savedPrefs);
            if (parsed && typeof parsed === 'object') {
                if (typeof parsed.sortMode === 'string') userPrefs.sortMode = parsed.sortMode;
                if (typeof parsed.openOnly === 'boolean') userPrefs.openOnly = parsed.openOnly;
                if (Array.isArray(parsed.excludedDays)) userPrefs.excludedDays = parsed.excludedDays;
            }
        }
    } catch (_) {
        try { localStorage.removeItem(STORAGE_KEY); } catch (_) { }
    }
}

// =================== CSV Loading & Parsing ===================
function normalizeCSVRow(row) {
    if (!row || typeof row !== 'object') return row;
    const out = {};
    for (const key of Object.keys(row)) {
        const k = (typeof key === 'string' && key.charCodeAt(0) === 0xFEFF) ? key.slice(1) : key;
        out[k] = row[key];
    }
    return out;
}

function getCourseName(section) {
    const name = (section['اسم المادة'] || '').trim();
    if (name && !/^\d+$/.test(name)) return name;
    const keys = Object.keys(section).filter(k => !k.startsWith('_'));
    if (keys.length >= 3) {
        const third = (section[keys[2]] || '').trim();
        if (third && !/^\d+$/.test(third)) return third;
    }
    return '';
}

function getDept(section) {
    return (section['القسم'] || section[Object.keys(section).find(k => !k.startsWith('_'))] || 'أخرى').trim();
}

function getCourseCredits(courseName) {
    const secs = coursesByName[courseName];
    if (!secs || secs.length === 0) return 0;
    const hrs = parseFloat(String(secs[0]['س.'] || '').trim());
    return Number.isFinite(hrs) ? hrs : 0;
}

function getTotalSelectedCredits() {
    let total = 0;
    selectedCourses.forEach(name => {
        total += getCourseCredits(name);
    });
    return total;
}

const subCollegeCache = {};

function populateSubCollegeOptions(sortedColleges) {
    const subCollegeSelect = document.getElementById('subCollegeSelect');
    if (!subCollegeSelect) return;

    const preferred = subCollegeSelect.value || currentSubCollege;
    subCollegeSelect.innerHTML = '<option value="">الكلية (الجميع)</option>';
    sortedColleges.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        subCollegeSelect.appendChild(opt);
    });

    const optExists = [...subCollegeSelect.options].some(o => o.value === preferred);
    if (optExists) {
        subCollegeSelect.value = preferred;
        currentSubCollege = preferred;
    } else {
        subCollegeSelect.value = '';
        currentSubCollege = '';
    }
}

function populateSubColleges(rawSections) {
    const colleges = new Set();
    rawSections.forEach(s => {
        const c = (s['الكلية'] || '').trim();
        if (c && c !== 'عام') colleges.add(c);
    });
    const sorted = [...colleges].sort((a, b) => a.localeCompare(b, 'ar'));
    populateSubCollegeOptions(sorted);
}

async function preloadSubColleges(degree) {
    if (typeof Papa === 'undefined') return;
    const targetDeg = (degree === '2' || degree === '3') ? degree : '3';
    if (subCollegeCache[targetDeg]) {
        populateSubCollegeOptions(subCollegeCache[targetDeg]);
        return;
    }

    const candidates = (degree === '2' || degree === '3') ? [degree] : ['3', '2'];
    for (const deg of candidates) {
        try {
            const res = await fetch(`data/center_${deg}.csv`);
            if (!res.ok) continue;
            let text = await res.text();
            text = text.replace(/^\uFEFF/, '');
            const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
            const colleges = new Set();
            (parsed.data || []).forEach(raw => {
                const row = normalizeCSVRow(raw);
                const c = (row['الكلية'] || '').trim();
                if (c && c !== 'عام') colleges.add(c);
            });
            const sorted = [...colleges].sort((a, b) => a.localeCompare(b, 'ar'));
            subCollegeCache[deg] = sorted;
            const serverSelect = document.getElementById('serverSelect');
            if (serverSelect && serverSelect.value === 'center') {
                populateSubCollegeOptions(sorted);
            }
            return;
        } catch (_) { /* ignore and try next candidate */ }
    }
}

async function loadCSV(forceRevalidate) {
    if (!currentServer || !currentDegree) {
        document.getElementById('courseList').innerHTML = `
            <div class="course-list-placeholder">
                يرجى تحديد الكلية والدرجة العلمية أولاً من الأعلى للبدء.
            </div>`;
        return;
    }
    const courseList = document.getElementById('courseList');
    courseList.innerHTML = '<div class="sidebar-skeleton"><div class="skeleton-bar"></div><div class="skeleton-bar short"></div><div class="skeleton-bar"></div><div class="skeleton-bar short"></div><div class="skeleton-bar"></div></div>';
    try {
        const fileKey = `${currentServer}_${currentDegree}`;
        const fetchOpts = forceRevalidate ? { cache: 'no-cache' } : {};
        const response = await fetch(`data/${fileKey}.csv`, fetchOpts);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        let text = await response.text();
        text = text.replace(/^\uFEFF/, '');
        const result = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
        const rows = (result.data || []).map(normalizeCSVRow);
        const rawSections = rows.filter(row => row['الحالة'] && row['الحالة'].trim() !== 'ملغاة');

        if (currentServer === 'center') {
            populateSubColleges(rawSections);
        }

        if (currentServer === 'center' && currentSubCollege) {
            const normSub = normalizeAr(currentSubCollege);
            allSections = rawSections.filter(s => normalizeAr(s['الكلية']) === normSub || (s['الكلية'] || '').trim() === 'عام');
        } else {
            allSections = rawSections;
        }

        allSections.forEach(section => parseSectionSlots(section));

        coursesByName = {};
        allSections.forEach(section => {
            const name = getCourseName(section);
            if (!name) return;
            if (!coursesByName[name]) coursesByName[name] = [];
            coursesByName[name].push(section);
        });

        coursesByDept = {};
        Object.keys(coursesByName).forEach(name => {
            const deptsForCourse = new Set(coursesByName[name].map(s => getDept(s)));
            deptsForCourse.forEach(dept => {
                if (!coursesByDept[dept]) coursesByDept[dept] = [];
                if (!coursesByDept[dept].includes(name)) coursesByDept[dept].push(name);
            });
        });
        Object.keys(coursesByDept).forEach(dept => { coursesByDept[dept].sort(); });

        [...selectedCourses].forEach(name => {
            if (!coursesByName[name]) selectedCourses.delete(name);
        });

        updateStats();
        renderCourseList(document.getElementById('searchInput').value.trim());
        updateSelectedCountUI();
        renderSelectedPanel();
    } catch (err) {
        console.error('Error loading CSV:', err);
        courseList.innerHTML = `
            <div class="course-list-error">
                تعذّر تحميل بيانات المواد.<br>
                <span>الرجاء التحقق من توفر الدرجة العلمية لهذه الكلية والمحاولة لاحقاً.</span>
            </div>`;
    }
}

// =================== Time Formatter ===================
function format12(t, isOnline = false) {
    if (!t) return t;
    const [h, m] = t.split(':').map(Number);
    const h24 = to24(h, isOnline);
    const period = h24 >= 12 ? 'م' : 'ص';
    const display = h24 > 12 ? h24 - 12 : (h24 === 0 ? 12 : h24);
    return `${display}:${String(m).padStart(2, '0')} ${period}`;
}

function formatTimeSlotsHTML(section, isOnline = false) {
    const slots = section._rawSlots || parseMultiSlots(typeof section === 'string' ? section : section['الاوقات']);
    if (slots.length === 0) return '<span class="time-empty">—</span>';
    return slots.map(slot => {
        if (slot.raw) return `<span class="time-slot"><span class="time-range">${esc(slot.raw)}</span></span>`;
        const sortedDays = [...slot.days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
        const dayLabels = sortedDays.map(d => `<span class="time-day">${esc(DAY_FULL[d] || d)}</span>`).join('');
        return `<span class="time-slot">${dayLabels}<span class="time-range">${esc(format12(slot.start, isOnline))}–${esc(format12(slot.end, isOnline))}</span></span>`;
    }).join('');
}

// =================== Stats & Metadata ===================
function updateStats() {
    document.getElementById('totalCoursesCount').textContent = Object.keys(coursesByName).length;
    document.getElementById('totalSectionsCount').textContent = allSections.length;
    const depts = new Set(allSections.map(s => s['القسم']).filter(Boolean));
    document.getElementById('totalDeptsCount').textContent = depts.size;
}

function showLastUpdate(dateOrStr) {
    const el = document.getElementById('lastUpdateText');
    if (!el) return;
    if (!dateOrStr) { el.textContent = '--'; return; }
    const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
    if (isNaN(d.getTime())) { el.textContent = '--'; return; }
    const dateStr = d.toLocaleDateString('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    el.textContent = `${timeStr} — ${dateStr}`;
}

function updateDegreeAvailability() {
    const serverSelect = document.getElementById('serverSelect');
    const degreeSelect = document.getElementById('degreeSelect');
    const btnLoadData = document.getElementById('btnLoadData');
    if (!serverSelect || !degreeSelect) return;

    const srv = serverSelect.value;
    const baseLabels = { '3': 'بكالوريوس', '2': 'دبلوم متوسط' };

    [...degreeSelect.options].forEach(opt => {
        if (!opt.value) return;
        const base = baseLabels[opt.value] || opt.textContent;
        if (srv && availableFiles.size > 0 && !availableFiles.has(`${srv}_${opt.value}`)) {
            opt.disabled = true;
            opt.textContent = `${base} (غير متوفر)`;
        } else {
            opt.disabled = false;
            opt.textContent = base;
        }
    });

    const selectedOpt = degreeSelect.options[degreeSelect.selectedIndex];
    if (selectedOpt && selectedOpt.disabled) {
        degreeSelect.value = '';
    }

    if (btnLoadData) {
        btnLoadData.disabled = !serverSelect.value || !degreeSelect.value;
    }
}

let currentLastUpdate = null;

async function fetchLastUpdate() {
    try {
        const res = await fetch('/last-update');
        const data = await res.json();
        if (data?.files && typeof data.files === 'object') {
            availableFiles = new Set(Object.keys(data.files));
            updateDegreeAvailability();
        }
        if (!currentServer || !currentDegree) {
            showLastUpdate(data?.lastUpdate || null);
            return;
        }
        const fileKey = `${currentServer}_${currentDegree}`;
        const fileTime = data?.files?.[fileKey] || data?.lastUpdate;

        if (fileTime) {
            if (currentLastUpdate && currentLastUpdate !== fileTime) {
                loadCSV(true);
            }
            currentLastUpdate = fileTime;
            showLastUpdate(fileTime);
        } else {
            showLastUpdate(null);
        }
    } catch (_) { showLastUpdate(null); }
}

// =================== Course List ===================
function renderCourseList(filter = '') {
    const container = document.getElementById('courseList');
    if (!currentServer || !currentDegree) return;

    const normFilter = normalizeAr(filter);

    const depts = Object.keys(coursesByDept).sort((a, b) => {
        const target = 'مشاريع التخرج';
        if (a === target && b !== target) return 1;
        if (b === target && a !== target) return -1;
        return a.localeCompare(b, 'ar');
    });

    const fragment = document.createDocumentFragment();

    depts.forEach((dept, dIdx) => {
        let courses = coursesByDept[dept] || [];
        if (normFilter) courses = courses.filter(c => normalizeAr(c).includes(normFilter));
        if (courses.length === 0) return;

        const group = document.createElement('div');
        group.className = 'level-group' + (dIdx === 0 || normFilter ? ' open' : '');

        const header = document.createElement('div');
        header.className = 'level-header';
        header.innerHTML = `
            <span class="level-badge"></span>
            <span class="level-title">${esc(dept)}</span>
            <span class="level-count">${courses.length}</span>
            <span class="level-chevron">◀</span>`;
        header.setAttribute('tabindex', '0');
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', group.classList.contains('open') ? 'true' : 'false');
        header.addEventListener('click', () => {
            group.classList.toggle('open');
            header.setAttribute('aria-expanded', group.classList.contains('open') ? 'true' : 'false');
        });
        header.addEventListener('keydown', e => {
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); header.click(); }
        });
        group.appendChild(header);

        const levelCourses = document.createElement('div');
        levelCourses.className = 'level-courses';

        courses.forEach(name => {
            const sectionsInDept = coursesByName[name].filter(s => getDept(s) === dept);
            const openCount = sectionsInDept.filter(s => !isClosedSection(s)).length;
            const isSelected = selectedCourses.has(name);
            const noOpen = userPrefs.openOnly && openCount === 0;

            const item = document.createElement('div');
            item.className = 'course-item' + (isSelected ? ' selected' : '') + (noOpen ? ' all-closed' : '');
            item.dataset.courseName = name;
            item.setAttribute('tabindex', '0');
            item.setAttribute('role', 'checkbox');
            item.setAttribute('aria-checked', isSelected ? 'true' : 'false');

            const countText = userPrefs.openOnly
                ? `${openCount}/${sectionsInDept.length} متاحة`
                : `${sectionsInDept.length} شعب`;

            item.innerHTML = `
                <span class="custom-checkbox" aria-hidden="true"></span>
                <span class="course-name">${esc(name)}</span>
                <span class="course-sections-count">${esc(countText)}</span>`;
            item.addEventListener('click', () => toggleCourse(item, name));
            item.addEventListener('keydown', e => {
                if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggleCourse(item, name); }
            });
            levelCourses.appendChild(item);
        });

        group.appendChild(levelCourses);
        fragment.appendChild(group);
    });

    container.innerHTML = '';
    if (fragment.childElementCount === 0) {
        container.innerHTML = '<div class="course-list-placeholder">لا توجد مواد مطابقة للبحث.</div>';
        return;
    }
    container.appendChild(fragment);
}

function updateSelectedCountUI() {
    const count = selectedCourses.size;
    const credits = getTotalSelectedCredits();
    document.getElementById('selectedCountNum').textContent = count;
    const creditsNumEl = document.getElementById('selectedCreditsNum');
    if (creditsNumEl) creditsNumEl.textContent = credits;
    const creditsBadgeEl = document.getElementById('selectedCreditsBadge');
    if (creditsBadgeEl) creditsBadgeEl.textContent = `${credits} ساعة معتمدة`;
    document.getElementById('btnGenerate').disabled = count === 0;
}

function toggleCourse(el, courseName) {
    if (selectedCourses.has(courseName)) {
        selectedCourses.delete(courseName);
        el.classList.remove('selected');
        el.setAttribute('aria-checked', 'false');
    } else {
        selectedCourses.add(courseName);
        el.classList.add('selected');
        el.setAttribute('aria-checked', 'true');
    }
    updateSelectedCountUI();
    renderSelectedPanel();
    saveSelectionsToStorage();
}

function resetResultsToEmpty() {
    document.getElementById('resultsArea').innerHTML = `
        <div class="empty-state" id="emptyState">
            <div class="empty-icon">
                <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
                    <path d="M6 12v5c6 3 10 0 12-2v-3" />
                </svg>
            </div>
            <h3>ابدأ بتنظيم جدولك</h3>
            <p>اختر المواد من القائمة الجانبية ثم اضغط على زر التوليد لعرض جميع الجداول الممكنة بدون تعارض.</p>
        </div>`;
}

function clearSelections() {
    selectedCourses.clear();
    currentSchedules = [];
    lastSortedSchedules = [];
    lastTotalFound = 0;
    lastWasCapped = false;
    lastConflicts = [];
    lastConflictReason = '';
    lastFilteredOutCourses = [];
    updateSelectedCountUI();
    renderCourseList(document.getElementById('searchInput').value.trim());
    renderSelectedPanel();
    saveSelectionsToStorage();
    resetResultsToEmpty();
}

// =================== Selected Courses Panel ===================
function renderSelectedPanel() {
    const container = document.getElementById('selectedTags');
    if (!container) return;
    if (selectedCourses.size === 0) {
        container.innerHTML = '<span class="selected-panel-empty">لم يتم اختيار مواد بعد</span>';
        return;
    }
    container.innerHTML = '';
    [...selectedCourses].forEach(name => {
        const span = document.createElement('span');
        span.className = 'selected-tag';
        span.appendChild(document.createTextNode(name));
        const removeBtn = document.createElement('span');
        removeBtn.className = 'selected-tag-remove';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('role', 'button');
        removeBtn.setAttribute('aria-label', `إزالة ${name}`);
        removeBtn.addEventListener('click', () => removeCourse(name));
        span.appendChild(removeBtn);
        container.appendChild(span);
    });
}

function removeCourse(name) {
    selectedCourses.delete(name);
    updateSelectedCountUI();
    renderCourseList(document.getElementById('searchInput').value.trim());
    renderSelectedPanel();
    saveSelectionsToStorage();
}

// =================== Schedule Generation (Web Worker) ===================
function generateSchedules() {
    if (selectedCourses.size === 0) return;

    if (scheduleWorker) scheduleWorker.terminate();

    const resultsArea = document.getElementById('resultsArea');
    resultsArea.innerHTML = `
        <div class="loading-state">
            <div class="skeleton-container">
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
            </div>
            <div class="loading-text">جاري تحليل الجداول الممكنة...</div>
            <div class="loading-ai-text">محرك الجدولة يبحث عن أفضل التوافيق بدون تعارض</div>
        </div>`;

    function norm(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }
    function getSectionKey(s) {
        return [norm(s['اسم المادة']), norm(s['ش.']), norm(s['رقم المادة']), norm(s['الاوقات'])].join('|');
    }

    const coursesSections = [];
    const seenCourseKey = new Set();
    let errorCourseName = '';

    for (const courseName of selectedCourses) {
        const allSecs = coursesByName[courseName];
        if (!allSecs || allSecs.length === 0) {
            errorCourseName = courseName;
            break;
        }
        const sections = [];
        const seenSec = new Set();
        allSecs.forEach(s => {
            const k = getSectionKey(s);
            if (!seenSec.has(k)) {
                seenSec.add(k);
                s._courseName = courseName;
                sections.push(s);
            }
        });
        const courseKey = sections.map(getSectionKey).sort().join('<>');
        if (seenCourseKey.has(courseKey)) continue;
        seenCourseKey.add(courseKey);
        coursesSections.push(sections);
    }

    if (errorCourseName) {
        resultsArea.innerHTML = `
            <div class="no-results">
                <div class="icon"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
                <h3>خطأ في المادة</h3>
                <p>المادة "${esc(errorCourseName)}" ليس لها شعب مسجلة.</p>
            </div>`;
        return;
    }

    const btnGenerate = document.getElementById('btnGenerate');
    btnGenerate.disabled = true;

    scheduleWorker = new Worker('./worker.js?v=3');
    scheduleWorker.postMessage({
        coursesSections,
        options: {
            maxSchedules: 100,
            sortMode: userPrefs.sortMode,
            openOnly: userPrefs.openOnly,
            excludedDays: userPrefs.excludedDays
        }
    });

    scheduleWorker.onmessage = function (e) {
        const {
            scoredSchedules,
            validSchedules,
            totalFound,
            wasCapped,
            incompatiblePairs,
            conflictReason,
            filteredOutCourses
        } = e.data;

        lastSortedSchedules = scoredSchedules || (validSchedules || []).map(s => ({
            schedule: s,
            score: scoreSchedule(s, userPrefs.sortMode)
        }));
        currentSchedules = lastSortedSchedules.map(item => item.schedule);
        lastTotalFound = totalFound || currentSchedules.length;
        lastWasCapped = Boolean(wasCapped);
        lastConflicts = incompatiblePairs || [];
        lastConflictReason = conflictReason || '';
        lastFilteredOutCourses = filteredOutCourses || [];
        currentPage = 1;
        renderResults();
        scheduleWorker.terminate();
        scheduleWorker = null;
        btnGenerate.disabled = selectedCourses.size === 0;
    };

    scheduleWorker.onerror = function (err) {
        console.error('Worker error:', err);
        resultsArea.innerHTML = `
            <div class="no-results">
                <div class="icon"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#b91c1c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>
                <h3>حدث خطأ أثناء المعالجة</h3>
                <p>يرجى المحاولة مجدداً.</p>
            </div>`;
        scheduleWorker.terminate();
        scheduleWorker = null;
        btnGenerate.disabled = selectedCourses.size === 0;
    };
}

// =================== Formatters ===================
function formatLecturers(raw) {
    if (!raw) return '—';
    const s = raw
        .replace(/<br\s*\/?>/gi, ' || ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!s) return '—';

    if (s.includes('||')) {
        return s.split('||').map(n => n.trim()).filter(Boolean).join(' || ');
    }

    const parts = s.split(/\s+(?=(?:أ\.د\.|د\.|أ\.|م\.)\s)/u).map(p => p.trim()).filter(Boolean);
    if (parts.length > 1) return parts.join(' || ');
    return s;
}

function formatRooms(raw) {
    if (!raw) return '—';
    const s = String(raw).replace(/\s+/g, ' ').trim();
    if (!s) return '—';
    return s;
}

function getScheduleCredits(schedule) {
    return schedule.reduce((sum, s) => {
        const hrs = parseFloat(String(s['س.'] || '').trim());
        return sum + (Number.isFinite(hrs) ? hrs : 0);
    }, 0);
}

// =================== Render Results ===================
function renderResults() {
    const resultsArea = document.getElementById('resultsArea');
    if (currentSchedules.length === 0) {
        let conflictHtml = '';
        let headline = 'يوجد تعارض إجباري في الأوقات بين المواد المختارة.';

        if (lastConflictReason === 'filtered_out' && lastFilteredOutCourses.length > 0) {
            headline = 'بعض المواد المختارة لا تحتوي على شعب مطابقة للفلاتر الحالية.';
            conflictHtml = `
                <div class="conflict-details">
                    <h4>مواد استُبعدت بسبب الفلاتر (الشعب المتاحة فقط / استثناء الأيام):</h4>
                    <ul>
                        ${lastFilteredOutCourses.map(name => `<li>• <strong>${esc(name)}</strong></li>`).join('')}
                    </ul>
                    <p class="conflict-hint">* جرّب إلغاء تفعيل "الشعب المتاحة فقط" أو تقليل الأيام المستثناة.</p>
                </div>`;
        } else if (lastConflicts && lastConflicts.length > 0) {
            conflictHtml = `
                <div class="conflict-details">
                    <h4>التعارضات التي منعت توليد الجداول:</h4>
                    <ul>
                        ${lastConflicts.map(pair => `
                            <li>* تعارض بين <strong>${esc(pair.split(' | ')[0])}</strong> و <strong>${esc(pair.split(' | ')[1])}</strong></li>
                        `).join('')}
                    </ul>
                    <p class="conflict-hint">* يرجى إزالة أو تغيير إحدى هذه المواد والمحاولة مرة أخرى.</p>
                </div>`;
        } else if (lastConflictReason === 'multi_way') {
            headline = 'لا يوجد تعارض ثنائي مباشر، لكن 3 مواد أو أكثر تتقاطع معاً في جميع التوليفات الممكنة.';
            conflictHtml = `
                <div class="conflict-details">
                    <h4>تعارض مركّب بين عدة مواد:</h4>
                    <p class="conflict-hint">* كل مادتين يمكن أخذهما معاً بشكل منفرد، ولكن عند جمع كل المواد المختارة لا تتوفر أوقات خالية من التعارض. جرّب إزالة إحدى المواد أو تغيير الفلاتر.</p>
                </div>`;
        }

        resultsArea.innerHTML = `
            <div class="no-results">
                <div class="icon"><svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#9a6700" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>
                <h3>لا يوجد جداول متاحة</h3>
                <p>${esc(headline)}</p>
                ${conflictHtml}
            </div>`;
        return;
    }

    const scored = lastSortedSchedules;
    const totalPages = Math.ceil(scored.length / ITEMS_PER_PAGE);
    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, scored.length);
    const pageSchedules = scored.slice(start, end);

    const wrapper = document.createElement('div');

    const header = document.createElement('div');
    header.className = 'results-header';
    const countText = lastWasCapped
        ? `عرض أفضل <strong>${scored.length}</strong> من أصل <strong>${lastTotalFound}</strong>+ جدول`
        : `تم العثور على <strong>${scored.length}</strong> جدول`;
    header.innerHTML = `
        <h2 class="results-title">الجداول المقترحة</h2>
        <div class="results-count">${countText}</div>`;
    wrapper.appendChild(header);

    if (lastWasCapped) {
        const capWarn = document.createElement('div');
        capWarn.className = 'cap-warning';
        capWarn.textContent = `عدد التوليفات الممكنة كبير (${lastTotalFound}+) — يتم عرض أفضل ${scored.length} جدول حسب معيار الترتيب المختار.`;
        wrapper.appendChild(capWarn);
    }

    pageSchedules.forEach(({ schedule, score }, idx) => {
        const globalRank = start + idx + 1;
        const breakHours = Math.floor(score.breaks / 60);
        const breakMins = score.breaks % 60;
        const breakLabel = score.breaks === 0 ? 'بدون بريكات'
            : breakHours > 0 ? `${breakHours}س ${breakMins}د` : `${breakMins}د`;
        const totalCredits = getScheduleCredits(schedule);
        const isTop = globalRank <= 3;

        const card = document.createElement('div');
        card.className = 'schedule-card' + (idx === 0 ? ' open' : '');
        if (isTop && globalRank === 1) card.classList.add('rank-one-card');

        const cardHeader = document.createElement('div');
        cardHeader.className = 'card-header';
        cardHeader.innerHTML = `
            <div class="card-header-meta">
                <div class="card-header-right">
                    <span class="card-num-badge">${globalRank}</span>
                    <span class="card-num-text">الجدول رقم ${globalRank}</span>
                </div>
                <div class="card-header-left">
                    <div class="score-badges">
                        <span class="score-badge days">${score.days} ${score.days === 1 ? 'يوم' : 'أيام'}</span>
                        <span class="score-badge breaks">${esc(breakLabel)}</span>
                        ${score.earliest > 0 && score.latest > 0 ? `<span class="score-badge time-window">${esc(formatMinutes12(score.earliest))} – ${esc(formatMinutes12(score.latest))}</span>` : ''}
                        <span class="score-badge credits">${totalCredits} ساعة</span>
                        ${isTop ? `<span class="score-badge rank-best">${globalRank === 1 ? 'الأفضل' : globalRank === 2 ? 'ممتاز' : 'جيد جداً'}</span>` : ''}
                    </div>
                    <div class="card-actions" data-html2canvas-ignore="true">
                        <button class="btn-calendar" data-rank="${globalRank}">تقويم</button>
                        <button class="btn-export" data-rank="${globalRank}">تصدير</button>
                    </div>
                    <span class="card-expand-icon" data-html2canvas-ignore="true">▼</span>
                </div>
            </div>`;

        cardHeader.addEventListener('click', e => {
            if (e.target.closest('button')) return;
            card.classList.toggle('open');
        });

        const cardBody = document.createElement('div');
        cardBody.className = 'card-body';

        const tableHeader = document.createElement('div');
        tableHeader.className = 'table-header';
        tableHeader.innerHTML = '<span>المادة</span><span>الشعبة</span><span>س.</span><span>الوقت</span><span>القاعة</span><span>المحاضر</span><span>النمط</span>';
        cardBody.appendChild(tableHeader);

        schedule.forEach(section => {
            const row = document.createElement('div');
            row.className = 'section-row';
            const online = isOnlineSection(section);
            const closed = isClosedSection(section);
            const modeBadgeClass = online ? 'mode-badge online' : 'mode-badge onsite';
            const modeLabel = online ? 'أونلاين' : 'وجاهي';
            const closedBadge = closed ? '<span class="mode-badge closed">مغلقة</span>' : '';
            row.innerHTML = `
                <span class="section-course-name">${esc(section['اسم المادة'])}</span>
                <span class="section-num" data-label="الشعبة">${esc(section['ش.'])}</span>
                <span class="section-hours" data-label="الساعات">${esc(section['س.'] || '—')}</span>
                <span class="section-time" data-label="الوقت">${formatTimeSlotsHTML(section, online)}</span>
                <span class="section-room" data-label="القاعة">${esc(formatRooms(section['القاعات']))}</span>
                <span class="section-instructor" data-label="المحاضر">${esc(formatLecturers(section['المحاضرين']))}</span>
                <span class="section-mode" data-label="النمط"><span class="${modeBadgeClass}">${modeLabel}</span>${closedBadge}</span>`;
            cardBody.appendChild(row);
        });

        const calPanel = document.createElement('div');
        calPanel.className = 'calendar-panel';
        calPanel.id = `calendar-${globalRank}`;
        calPanel.style.display = 'none';
        cardBody.appendChild(calPanel);

        card.appendChild(cardHeader);
        card.appendChild(cardBody);

        cardHeader.querySelector('.btn-export').addEventListener('click', e => {
            e.stopPropagation();
            exportSchedule(card, globalRank, e.currentTarget);
        });
        cardHeader.querySelector('.btn-calendar').addEventListener('click', e => {
            e.stopPropagation();
            toggleCalendar(e.currentTarget, schedule, globalRank);
        });

        wrapper.appendChild(card);
    });

    if (totalPages > 1) {
        const pagination = document.createElement('div');
        pagination.className = 'pagination';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'page-btn';
        prevBtn.textContent = '◀ السابق';
        prevBtn.disabled = currentPage === 1;
        prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
        pagination.appendChild(prevBtn);

        let lastWasDots = false;
        for (let p = 1; p <= totalPages; p++) {
            if (totalPages <= 7 || p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1) {
                lastWasDots = false;
                const btn = document.createElement('button');
                btn.className = 'page-btn' + (p === currentPage ? ' active' : '');
                btn.textContent = p;
                btn.addEventListener('click', () => goToPage(p));
                pagination.appendChild(btn);
            } else if (!lastWasDots) {
                lastWasDots = true;
                const dots = document.createElement('button');
                dots.className = 'page-btn';
                dots.textContent = '...';
                dots.disabled = true;
                pagination.appendChild(dots);
            }
        }

        const nextBtn = document.createElement('button');
        nextBtn.className = 'page-btn';
        nextBtn.textContent = 'التالي ▶';
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.addEventListener('click', () => goToPage(currentPage + 1));
        pagination.appendChild(nextBtn);
        wrapper.appendChild(pagination);
    }

    resultsArea.innerHTML = '';
    resultsArea.appendChild(wrapper);
}

function goToPage(page) {
    const totalPages = Math.ceil(lastSortedSchedules.length / ITEMS_PER_PAGE);
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    renderResults();
    document.getElementById('resultsArea').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// =================== Calendar View ===================
const SLOT_START = 8 * 60;
const SLOT_END = 20 * 60;
const SLOT_SIZE = 30;
const COLORS = ['#0f8f4d', '#2563eb', '#9333ea', '#ea580c', '#0891b2', '#65a30d', '#be185d', '#ca8a04'];

function formatMinutes12(mins) {
    const h24 = Math.floor(mins / 60);
    const mm = String(mins % 60).padStart(2, '0');
    const period = h24 >= 12 ? 'م' : 'ص';
    const h12 = h24 > 12 ? h24 - 12 : (h24 === 0 ? 12 : h24);
    return `${h12}:${mm} ${period}`;
}

function toggleCalendar(btn, schedule, rank) {
    const panel = document.getElementById(`calendar-${rank}`);
    const card = btn.closest('.schedule-card');
    if (!card.classList.contains('open')) card.classList.add('open');
    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        btn.textContent = 'تقويم';
        return;
    }
    panel.style.display = 'block';
    renderCalendar(panel, schedule);
    btn.textContent = 'إخفاء التقويم';
}

function renderCalendar(panel, schedule) {
    const slots = Math.ceil((SLOT_END - SLOT_START) / SLOT_SIZE);
    const grid = document.createElement('div');
    grid.className = 'calendar-grid';

    const emptyHeader = document.createElement('div');
    emptyHeader.className = 'cal-header';
    emptyHeader.style.gridRow = '1';
    emptyHeader.style.gridColumn = '1';
    grid.appendChild(emptyHeader);
    CALENDAR_DAY_ORDER.forEach((d, dIdx) => {
        const h = document.createElement('div');
        h.className = 'cal-header';
        h.textContent = DAY_FULL[d] || d;
        h.style.gridRow = '1';
        h.style.gridColumn = String(dIdx + 2);
        grid.appendChild(h);
    });

    for (let i = 0; i < slots; i++) {
        const rowNum = String(i + 2);
        const mins = SLOT_START + i * SLOT_SIZE;
        const h24 = Math.floor(mins / 60);
        const mm = String(mins % 60).padStart(2, '0');
        const period = h24 >= 12 ? 'م' : 'ص';
        const h12 = h24 > 12 ? h24 - 12 : (h24 === 0 ? 12 : h24);
        const timeCell = document.createElement('div');
        timeCell.className = 'cal-time';
        timeCell.textContent = `${h12}:${mm} ${period}`;
        timeCell.style.gridRow = rowNum;
        timeCell.style.gridColumn = '1';
        grid.appendChild(timeCell);
        CALENDAR_DAY_ORDER.forEach((_, dIdx) => {
            const cell = document.createElement('div');
            cell.className = 'cal-cell';
            cell.style.gridRow = rowNum;
            cell.style.gridColumn = String(dIdx + 2);
            grid.appendChild(cell);
        });
    }

    schedule.forEach((section, sIdx) => {
        const parsedSlots = section._parsedSlots;
        if (!parsedSlots || parsedSlots.length === 0) return;
        const color = COLORS[sIdx % COLORS.length];

        const byDay = {};
        parsedSlots.forEach(t => {
            (t.days || []).forEach(day => {
                if (!byDay[day]) byDay[day] = [];
                byDay[day].push({ start: t.start, end: t.end });
            });
        });

        Object.entries(byDay).forEach(([day, intervals]) => {
            const dayIdx = CALENDAR_DAY_ORDER.indexOf(day);
            if (dayIdx === -1) return;

            mergeDayIntervals(intervals).forEach(interval => {
                const exactStart = Math.max(0, (interval.start - SLOT_START) / SLOT_SIZE);
                const exactEnd = Math.min(slots, (interval.end - SLOT_START) / SLOT_SIZE);
                if (exactStart >= slots || exactEnd <= 0 || exactEnd <= exactStart) return;

                const firstSlot = Math.floor(exactStart);
                const lastSlotExcl = Math.max(firstSlot + 1, Math.ceil(exactEnd));
                const startRow = firstSlot + 2;
                const endRow = lastSlotExcl + 2;
                const topFrac = exactStart - firstSlot;
                const bottomFrac = lastSlotExcl - exactEnd;

                const event = document.createElement('div');
                event.className = 'cal-event';
                const timeRangeText = `${formatMinutes12(interval.start)} – ${formatMinutes12(interval.end)}`;
                event.title = `${section['اسم المادة']} (${timeRangeText})`;

                const titleEl = document.createElement('span');
                titleEl.className = 'cal-event-title';
                titleEl.textContent = section['اسم المادة'] || '';

                const timeEl = document.createElement('span');
                timeEl.className = 'cal-event-time';
                timeEl.textContent = timeRangeText;

                event.appendChild(titleEl);
                event.appendChild(timeEl);
                event.style.background = color;
                event.style.gridColumn = String(dayIdx + 2);
                event.style.gridRow = `${startRow} / ${endRow}`;
                event.style.marginTop = `${Math.round(topFrac * 30) + 2}px`;
                event.style.marginBottom = `${Math.round(bottomFrac * 30) + 2}px`;
                grid.appendChild(event);
            });
        });
    });

    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'calendar-scroll-wrap';
    scrollWrap.appendChild(grid);

    panel.innerHTML = '';
    panel.appendChild(scrollWrap);
}

// =================== Export Schedule ===================
async function exportSchedule(cardElement, rank, btnElement) {
    if (typeof html2canvas === 'undefined') {
        showToast('جاري تحميل مكتبة التصدير، يرجى المحاولة بعد قليل...');
        return;
    }

    try {
        btnElement.textContent = 'جاري التصدير...';
        btnElement.disabled = true;

        const wasOpen = cardElement.classList.contains('open');
        if (!wasOpen) cardElement.classList.add('open');

        const scrollWrap = cardElement.querySelector('.calendar-scroll-wrap');
        let oldOverflow = '';
        if (scrollWrap) {
            oldOverflow = scrollWrap.style.overflowX;
            scrollWrap.style.overflowX = 'visible';
        }

        const isMobile = window.innerWidth <= 768;
        const oldWidth = cardElement.style.width;
        const oldMaxWidth = cardElement.style.maxWidth;
        if (isMobile) {
            cardElement.style.width = '1024px';
            cardElement.style.maxWidth = '1024px';
        }

        await new Promise(resolve => setTimeout(resolve, 50));

        const canvas = await html2canvas(cardElement, {
            scale: window.devicePixelRatio > 1 ? 2 : 1.5,
            useCORS: true,
            backgroundColor: '#fffcec',
            windowWidth: isMobile ? 1024 : document.documentElement.offsetWidth,
            width: isMobile ? 1024 : undefined
        });

        if (isMobile) {
            cardElement.style.width = oldWidth;
            cardElement.style.maxWidth = oldMaxWidth;
        }
        if (scrollWrap) {
            scrollWrap.style.overflowX = oldOverflow;
        }
        if (!wasOpen) cardElement.classList.remove('open');

        const imgData = canvas.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = imgData;
        a.download = `schedule_${rank}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        showToast(`تم تصدير الجدول رقم ${rank} كصورة بنجاح`);
    } catch (err) {
        console.error('Error exporting image:', err);
        showToast('حدث خطأ أثناء تصدير الصورة');
    } finally {
        btnElement.textContent = 'تصدير';
        btnElement.disabled = false;
    }
}

// =================== Event Listeners ===================
document.addEventListener('DOMContentLoaded', () => {
    restoreSelectionsFromStorage();

    const serverSelect = document.getElementById('serverSelect');
    const degreeSelect = document.getElementById('degreeSelect');
    const subCollegeContainer = document.getElementById('subCollegeContainer');
    const subCollegeSelect = document.getElementById('subCollegeSelect');
    const btnLoadData = document.getElementById('btnLoadData');
    const sortModeSelect = document.getElementById('sortModeSelect');
    const openOnlyToggle = document.getElementById('openOnlyToggle');
    const excludedDaysGroup = document.getElementById('excludedDaysGroup');

    if (currentServer) serverSelect.value = currentServer;
    if (currentDegree) degreeSelect.value = currentDegree;
    if (sortModeSelect) sortModeSelect.value = userPrefs.sortMode;
    if (openOnlyToggle) openOnlyToggle.checked = userPrefs.openOnly;

    const excludedSet = new Set(userPrefs.excludedDays);
    if (excludedDaysGroup) {
        excludedDaysGroup.querySelectorAll('.day-toggle-btn').forEach(btn => {
            const day = btn.dataset.day;
            const active = excludedSet.has(day);
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
    }

    function checkDropdowns() {
        if (serverSelect.value === 'center') {
            subCollegeContainer.classList.add('visible');
            preloadSubColleges(degreeSelect.value);
        } else {
            subCollegeContainer.classList.remove('visible');
            subCollegeSelect.value = '';
            currentSubCollege = '';
        }
        updateDegreeAvailability();
    }

    serverSelect.addEventListener('change', checkDropdowns);
    degreeSelect.addEventListener('change', () => {
        btnLoadData.disabled = !serverSelect.value || !degreeSelect.value;
        if (serverSelect.value === 'center') {
            preloadSubColleges(degreeSelect.value);
        }
    });
    checkDropdowns();

    subCollegeSelect.addEventListener('change', () => {
        currentSubCollege = subCollegeSelect.value;
        saveSelectionsToStorage();
        if (currentServer === 'center' && currentDegree &&
            serverSelect.value === 'center' && degreeSelect.value === currentDegree) {
            loadCSV(false);
        }
    });

    btnLoadData.addEventListener('click', () => {
        if (currentServer !== serverSelect.value || currentDegree !== degreeSelect.value) {
            currentServer = serverSelect.value;
            currentDegree = degreeSelect.value;
            if (currentServer === 'center') {
                currentSubCollege = subCollegeSelect.value;
            } else {
                currentSubCollege = '';
                subCollegeSelect.value = '';
            }
            selectedCourses.clear();
            currentSchedules = [];
            lastSortedSchedules = [];
            lastTotalFound = 0;
            lastWasCapped = false;
            lastConflicts = [];
            lastConflictReason = '';
            lastFilteredOutCourses = [];
            saveSelectionsToStorage();
            updateSelectedCountUI();
            renderSelectedPanel();
            resetResultsToEmpty();
        }
        loadCSV(true);
        fetchLastUpdate();
    });

    function handlePrefsChange(sortOnly) {
        saveSelectionsToStorage();
        renderCourseList(document.getElementById('searchInput').value.trim());
        if (selectedCourses.size > 0 && (currentSchedules.length > 0 || lastConflictReason)) {
            if (sortOnly && !lastWasCapped && lastSortedSchedules.length > 0) {
                lastSortedSchedules = lastSortedSchedules.map(item => ({
                    schedule: item.schedule,
                    score: scoreSchedule(item.schedule, userPrefs.sortMode)
                }));
                lastSortedSchedules.sort((a, b) => a.score.total - b.score.total);
                currentSchedules = lastSortedSchedules.map(item => item.schedule);
                currentPage = 1;
                renderResults();
            } else {
                generateSchedules();
            }
        }
    }

    if (sortModeSelect) {
        sortModeSelect.addEventListener('change', () => {
            userPrefs.sortMode = sortModeSelect.value;
            handlePrefsChange(true);
        });
    }

    if (openOnlyToggle) {
        openOnlyToggle.addEventListener('change', () => {
            userPrefs.openOnly = openOnlyToggle.checked;
            handlePrefsChange(false);
        });
    }

    if (excludedDaysGroup) {
        excludedDaysGroup.addEventListener('click', e => {
            const btn = e.target.closest('.day-toggle-btn');
            if (!btn) return;
            const day = btn.dataset.day;
            const idx = userPrefs.excludedDays.indexOf(day);
            if (idx === -1) {
                userPrefs.excludedDays.push(day);
                btn.classList.add('active');
                btn.setAttribute('aria-pressed', 'true');
            } else {
                userPrefs.excludedDays.splice(idx, 1);
                btn.classList.remove('active');
                btn.setAttribute('aria-pressed', 'false');
            }
            handlePrefsChange(false);
        });
    }

    let searchDebounce;
    document.getElementById('searchInput').addEventListener('input', e => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => renderCourseList(e.target.value.trim()), 150);
    });

    document.getElementById('btnGenerate').addEventListener('click', generateSchedules);
    document.getElementById('btnClear').addEventListener('click', clearSelections);

    fetchLastUpdate();
    loadCSV(true);

    setInterval(fetchLastUpdate, 10 * 60 * 1000);
});
