require('dotenv').config();

const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const {
    HEADERS,
    EXCLUDED_DEPTS,
    SKIP_COLLEGES,
    STATUS_DESC,
    safeParseArray,
    stripHtml,
    processScrapedRows,
    shouldAcceptScrape
} = require('./lib/scraper-utils');

const app = express();

if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://fonts.googleapis.com'],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'blob:']
        }
    }
}));

app.use(compression());

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1h',
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.html' || ext === '.js' || ext === '.css') {
            res.setHeader('Cache-Control', 'no-cache');
        } else if (ext === '.csv' || ext === '.json') {
            res.setHeader('Cache-Control', 'public, max-age=300');
        } else if (/\.(jpg|jpeg|png|gif|webp|woff2?)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
        }
    }
}));

const SERVERS = [
    { key: 'center', name: 'كليات مركز الجامعة وكلية الأميرة رحمة الجامعية', url: 'https://app2.bau.edu.jo:7799/courses/actions/rmiMethod' },
    { key: 'fet', name: 'كلية الهندسة التكنولوجية', url: 'http://appserver.fet.edu.jo:7778/courses/actions/rmiMethod' },
    { key: 'irbid', name: 'كلية اربد الجامعية', url: 'http://app.irbid.bau.edu.jo:8080/courses/actions/rmiMethod' },
    { key: 'huson', name: 'كلية الحصن الجامعية', url: 'http://app.huson.edu.jo/courses/actions/rmiMethod' },
    { key: 'ajloun', name: 'كلية عجلون الجامعية', url: 'http://appserver.ajloun.bau.edu.jo/courses/actions/rmiMethod' },
    { key: 'alia', name: 'كلية الاميرة عالية الجامعية', url: 'http://app.alia.bau.edu.jo/courses/actions/rmiMethod' },
    { key: 'amman', name: 'كلية عمان الجامعية', url: 'http://reg.amman.bau.edu.jo:7777/courses/actions/rmiMethod' },
    { key: 'karak', name: 'كلية الكرك الجامعية', url: 'http://kuc-onlinereg.karak.bau.edu.jo/courses/actions/rmiMethod' },
    { key: 'maan', name: 'كلية معان', url: 'http://app.maan.bau.edu.jo/courses/actions/rmiMethod' },
    { key: 'shoubak', name: 'كلية الشوبك الجامعية', url: 'http://app.shoubak.bau.edu.jo/courses/actions/rmiMethod' },
    { key: 'aqaba', name: 'كلية العقبة الجامعية', url: 'https://aqabaapp.bau.edu.jo/courses/actions/rmiMethod' },
    { key: 'zarqa', name: 'كلية الزرقاء الجامعية', url: 'http://app.zarqa.bau.edu.jo/courses/actions/rmiMethod' }
];

const DEGREES = [
    { id: '3', name: 'بكالوريوس' },
    { id: '2', name: 'دبلوم متوسط' }
];

async function sendRMI(url, params) {
    await new Promise(r => setTimeout(r, 300));
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: AbortSignal.timeout(10000)
    });
    return res.text();
}

let scraperRunning = false;

async function runScraperJob() {
    if (scraperRunning) {
        console.log('[Scraper] Already running, skipping.');
        return;
    }
    scraperRunning = true;
    try {
        console.log('[Scraper] Starting comprehensive data pull for all servers...');
        const dataDir = path.join(__dirname, 'public', 'data');
        await fs.promises.mkdir(dataDir, { recursive: true });
        let metadata = { lastUpdate: new Date().toISOString(), files: {} };
        const metaPath = path.join(dataDir, 'metadata.json');

        try {
            const rawMeta = await fs.promises.readFile(metaPath, 'utf8');
            metadata = JSON.parse(rawMeta);
            if (!metadata.files || typeof metadata.files !== 'object') metadata.files = {};
        } catch { /* ignore if no metadata */ }

        metadata.lastUpdate = new Date().toISOString();

        for (const server of SERVERS) {
            console.log(`\n[Scraper] Connecting to server: ${server.name}`);
            let collegesRaw;
            try {
                collegesRaw = await sendRMI(server.url, 'method=getColleges&paramsCount=0');
            } catch (e) {
                console.error(`[Scraper] Failed to get colleges for ${server.name}:`, e.message);
                continue;
            }
            const colleges = safeParseArray(collegesRaw);
            const filteredColleges = colleges.filter(c => c.name && !SKIP_COLLEGES.includes(c.name.trim()));
            if (!filteredColleges.length) {
                console.warn(`[Scraper] No colleges found for ${server.name}. Skipping.`);
                continue;
            }

            for (const degree of DEGREES) {
                const allRows = [];

                for (let ci = 0; ci < filteredColleges.length; ci++) {
                    const college = filteredColleges[ci];
                    let deptsRaw;
                    try {
                        deptsRaw = await sendRMI(server.url, `method=getDepartments&paramsCount=1&param0=${college.id}`);
                    } catch (e) {
                        console.warn(`[Scraper] Failed getDepartments for ${college.name}: ${e.message}`);
                        continue;
                    }
                    const departments = safeParseArray(deptsRaw);
                    const activeDepts = departments.filter(d => d.name && !EXCLUDED_DEPTS.includes(d.name.trim()));
                    if (activeDepts.length === 0) continue;

                    for (let di = 0; di < activeDepts.length; di++) {
                        const deptName = activeDepts[di].name.trim();
                        const deptId = activeDepts[di].id;

                        let countRaw;
                        try {
                            countRaw = await sendRMI(server.url, `method=getCoursesPagesCount&paramsCount=3&param0=${degree.id}&param1=${college.id}&param2=${deptId}`);
                        } catch { continue; }
                        const pageCount = parseInt(countRaw, 10) || 0;
                        if (pageCount === 0) continue;

                        for (let page = 1; page <= pageCount; page++) {
                            let coursesRaw;
                            try {
                                coursesRaw = await sendRMI(server.url, `method=getCourses&paramsCount=4&param0=${degree.id}&param1=${college.id}&param2=${deptId}&param3=${page}`);
                            } catch { continue; }
                            safeParseArray(coursesRaw).forEach(c => {
                                const row = [
                                    c.no || '', c.name || '', c.hours || '', c.sectionNo || '',
                                    stripHtml(c.times), stripHtml(c.lecturers), stripHtml(c.rooms),
                                    STATUS_DESC[c.status] || '', c.remarks || ''
                                ];
                                if (row[0] !== 'رقم المادة' && row[0] !== '') {
                                    allRows.push({ dept: deptName, college: college.name, row });
                                }
                            });
                        }
                    }
                }

                if (allRows.length === 0) {
                    console.log(`[Scraper] No courses found for ${server.name} - ${degree.name}.`);
                    continue;
                }

                const processed = processScrapedRows(allRows);
                const fileKey = `${server.key}_${degree.id}`;
                const finalPath = path.join(dataDir, `${fileKey}.csv`);

                let prevCount = 0;
                try {
                    const existing = await fs.promises.readFile(finalPath, 'utf8');
                    prevCount = existing.split('\n').length - 1;
                } catch { /* no file yet */ }

                if (!shouldAcceptScrape(processed.length, prevCount, metadata.files[fileKey])) {
                    console.warn(`[Scraper] New data for ${fileKey} (${processed.length} vs ${prevCount}) is too low. Aborting write.`);
                    continue;
                }

                const csvLines = [HEADERS.join(',')];
                processed.forEach(r => {
                    csvLines.push(HEADERS.map(h => `"${(r[h] || '').replace(/"/g, '""')}"`).join(','));
                });
                const csvContent = '\uFEFF' + csvLines.join('\n');
                const tmpPath = path.join(dataDir, `${fileKey}.csv.tmp`);
                await fs.promises.writeFile(tmpPath, csvContent, 'utf8');
                await fs.promises.rename(tmpPath, finalPath);

                metadata.files[fileKey] = new Date().toISOString();
                const metaTmpPath = `${metaPath}.tmp`;
                await fs.promises.writeFile(metaTmpPath, JSON.stringify(metadata), 'utf8');
                await fs.promises.rename(metaTmpPath, metaPath);

                console.log(`[Scraper] Saved ${fileKey}.csv with ${processed.length} sections.`);
            }
        }
        console.log('[Scraper] Done with all servers.');
    } catch (err) {
        console.error('[Scraper] Error:', err);
    } finally {
        scraperRunning = false;
    }
}

const SCRAPE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SCRAPE_CHECK_MS = 5 * 60 * 1000;     // check every 5 minutes

async function maybeRunScraperJob() {
    try {
        const filePath = path.join(__dirname, 'public', 'data', 'metadata.json');
        const raw = await fs.promises.readFile(filePath, 'utf8');
        const { lastUpdate } = JSON.parse(raw);
        const ageMs = Date.now() - new Date(lastUpdate).getTime();
        if (ageMs < SCRAPE_INTERVAL_MS) {
            console.log(`[Scraper] Data is fresh (${Math.round(ageMs / 60000)}m old), skipping.`);
            return;
        }
    } catch { /* no file yet — proceed */ }
    return runScraperJob();
}

setTimeout(runScraperJob, 1000);
setInterval(maybeRunScraperJob, SCRAPE_CHECK_MS);

app.get('/last-update', async (req, res) => {
    try {
        const filePath = path.join(__dirname, 'public', 'data', 'metadata.json');
        const raw = await fs.promises.readFile(filePath, 'utf8');
        res.json(JSON.parse(raw));
    } catch {
        res.json({ lastUpdate: null });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running -> 0.0.0.0:${PORT}`));
