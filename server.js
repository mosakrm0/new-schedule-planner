require('dotenv').config();

const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const {
    HEADERS,
    EXCLUDED_DEPTS,
    SKIP_COLLEGES,
    STATUS_DESC,
    toStr,
    safeParseArray,
    stripHtml,
    cleanRoomField,
    processScrapedRows,
    shouldAcceptScrape
} = require('./lib/scraper-utils');

const app = express();
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'public', 'data');
const META_PATH = path.join(DATA_DIR, 'metadata.json');

if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
}

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            fontSrc: ["'self'"],
            connectSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            workerSrc: ["'self'"],
            upgradeInsecureRequests: process.env.ENABLE_HSTS_UPGRADE === 'true' ? [] : null
        }
    }
}));

app.use(compression());

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false
});

if (process.env.DATA_DIR) {
    app.use('/data', express.static(DATA_DIR, {
        maxAge: '5m',
        etag: true,
        lastModified: true,
        setHeaders(res, filePath) {
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.csv' || ext === '.json') {
                res.setHeader('Cache-Control', 'public, max-age=300');
            }
        }
    }));
}

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

const STALE_DATA_MS = 7 * 24 * 60 * 60 * 1000;
const SCRAPE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SCRAPE_CHECK_MS = 5 * 60 * 1000;     // check every 5 minutes
const SCRAPE_RETRY_COOLDOWN_MS = 15 * 60 * 1000;
const SCRAPE_CONCURRENCY = 3;

let cachedMetadata = null;
let metadataWriteChain = Promise.resolve();
let scraperRunning = false;
let lastScrapeAttemptMs = 0;

function loadMetadataSync() {
    try {
        const raw = fs.readFileSync(META_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            if (!parsed.files || typeof parsed.files !== 'object') parsed.files = {};
            cachedMetadata = parsed;
            return parsed;
        }
    } catch { /* no metadata yet */ }
    return null;
}

loadMetadataSync();

function writeMetadataAtomic(snapshot) {
    metadataWriteChain = metadataWriteChain.then(async () => {
        const metaTmpPath = `${META_PATH}.tmp`;
        await fs.promises.writeFile(metaTmpPath, JSON.stringify(snapshot), 'utf8');
        await fs.promises.rename(metaTmpPath, META_PATH);
        cachedMetadata = snapshot;
    });
    return metadataWriteChain;
}

async function sendRMI(url, params, maxRetries = 2) {
    const body = params instanceof URLSearchParams
        ? params.toString()
        : (params && typeof params === 'object' ? new URLSearchParams(params).toString() : toStr(params));

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await new Promise(r => setTimeout(r, attempt === 0 ? 300 : 500 * attempt));
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
                signal: AbortSignal.timeout(10000)
            });
            if (!res.ok) {
                const err = new Error(`HTTP ${res.status}`);
                err.status = res.status;
                if (res.status >= 500 && attempt < maxRetries) continue;
                throw err;
            }
            return await res.text();
        } catch (err) {
            if (attempt >= maxRetries) throw err;
        }
    }
}

async function scrapeServer(server, metadata) {
    console.log(`\n[Scraper] Connecting to server: ${server.name}`);
    let collegesRaw;
    try {
        collegesRaw = await sendRMI(server.url, { method: 'getColleges', paramsCount: '0' });
    } catch (e) {
        console.error(`[Scraper] Failed to get colleges for ${server.name}:`, e.message);
        return false;
    }

    const colleges = safeParseArray(collegesRaw);
    const filteredColleges = colleges.filter(c => c.name && !SKIP_COLLEGES.includes(toStr(c.name).trim()));
    if (!filteredColleges.length) {
        console.warn(`[Scraper] No colleges found for ${server.name}. Skipping.`);
        return false;
    }

    let wroteAny = false;
    for (const degree of DEGREES) {
        try {
            const allRows = [];
            let hadFailures = false;

            for (let ci = 0; ci < filteredColleges.length; ci++) {
                const college = filteredColleges[ci];
                const collegeName = toStr(college.name).trim();
                let deptsRaw;
                try {
                    deptsRaw = await sendRMI(server.url, {
                        method: 'getDepartments',
                        paramsCount: '1',
                        param0: toStr(college.id)
                    });
                } catch (e) {
                    hadFailures = true;
                    console.warn(`[Scraper] Failed getDepartments for ${collegeName}: ${e.message}`);
                    continue;
                }

                const departments = safeParseArray(deptsRaw);
                const activeDepts = departments.filter(d => d.name && !EXCLUDED_DEPTS.includes(toStr(d.name).trim()));
                if (activeDepts.length === 0) continue;

                for (let di = 0; di < activeDepts.length; di++) {
                    const deptName = toStr(activeDepts[di].name).trim();
                    const deptId = toStr(activeDepts[di].id);

                    let countRaw;
                    try {
                        countRaw = await sendRMI(server.url, {
                            method: 'getCoursesPagesCount',
                            paramsCount: '3',
                            param0: degree.id,
                            param1: toStr(college.id),
                            param2: deptId
                        });
                    } catch {
                        hadFailures = true;
                        continue;
                    }

                    const pageCount = parseInt(countRaw, 10) || 0;
                    if (pageCount === 0) continue;

                    for (let page = 1; page <= pageCount; page++) {
                        let coursesRaw;
                        try {
                            coursesRaw = await sendRMI(server.url, {
                                method: 'getCourses',
                                paramsCount: '4',
                                param0: degree.id,
                                param1: toStr(college.id),
                                param2: deptId,
                                param3: String(page)
                            });
                        } catch {
                            hadFailures = true;
                            continue;
                        }

                        safeParseArray(coursesRaw).forEach(c => {
                            const row = [
                                toStr(c.no).trim(),
                                toStr(c.name).trim(),
                                toStr(c.hours).trim(),
                                toStr(c.sectionNo).trim(),
                                stripHtml(c.times),
                                stripHtml(c.lecturers),
                                cleanRoomField(c.rooms),
                                STATUS_DESC[c.status] || '',
                                stripHtml(c.remarks)
                            ];
                            if (row[0] !== 'رقم المادة' && row[0] !== '') {
                                allRows.push({ dept: deptName, college: collegeName, row });
                            }
                        });
                    }
                }
            }

            if (allRows.length === 0) {
                console.log(`[Scraper] No courses found for ${server.name} - ${degree.name}.`);
                continue;
            }

            const processed = processScrapedRows(allRows, {
                includeGraduationProjects: degree.id === '3'
            });
            const fileKey = `${server.key}_${degree.id}`;
            const finalPath = path.join(DATA_DIR, `${fileKey}.csv`);

            let prevCount = 0;
            try {
                const existing = await fs.promises.readFile(finalPath, 'utf8');
                const nonEmptyLines = existing.split(/\r?\n/).filter(l => l.trim().length > 0);
                prevCount = Math.max(0, nonEmptyLines.length - 1);
            } catch { /* no file yet */ }

            const lastFileIso = metadata.files[fileKey];
            const lastFileMs = lastFileIso ? new Date(lastFileIso).getTime() : NaN;
            const isFresh = Number.isFinite(lastFileMs) && (Date.now() - lastFileMs) <= STALE_DATA_MS;

            if (hadFailures && prevCount > 0 && isFresh) {
                console.warn(`[Scraper] Partial fetch failures for ${fileKey}; preserving existing intact dataset.`);
                continue;
            }

            if (!shouldAcceptScrape(processed.length, prevCount, lastFileIso)) {
                console.warn(`[Scraper] New data for ${fileKey} (${processed.length} vs ${prevCount}) is too low. Aborting write.`);
                continue;
            }

            const csvLines = [HEADERS.join(',')];
            processed.forEach(r => {
                csvLines.push(HEADERS.map(h => {
                    const cleanCell = toStr(r[h]).replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
                    return `"${cleanCell}"`;
                }).join(','));
            });
            const csvContent = '\uFEFF' + csvLines.join('\n');
            const tmpPath = path.join(DATA_DIR, `${fileKey}.csv.tmp`);
            await fs.promises.writeFile(tmpPath, csvContent, 'utf8');
            await fs.promises.rename(tmpPath, finalPath);

            const nowIso = new Date().toISOString();
            metadata.files[fileKey] = nowIso;
            metadata.lastUpdate = nowIso;
            await writeMetadataAtomic({ lastUpdate: metadata.lastUpdate, files: { ...metadata.files } });
            wroteAny = true;

            console.log(`[Scraper] Saved ${fileKey}.csv with ${processed.length} sections.`);
        } catch (err) {
            console.error(`[Scraper] Error processing ${server.key}_${degree.id}:`, err.message);
        }
    }
    return wroteAny;
}

async function runScraperJob() {
    if (scraperRunning) {
        console.log('[Scraper] Already running, skipping.');
        return;
    }
    scraperRunning = true;
    lastScrapeAttemptMs = Date.now();
    try {
        console.log('[Scraper] Starting comprehensive data pull for all servers...');
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        let metadata = { lastUpdate: null, files: {} };

        try {
            const rawMeta = await fs.promises.readFile(META_PATH, 'utf8');
            const parsed = JSON.parse(rawMeta);
            if (parsed && typeof parsed === 'object') {
                metadata = parsed;
                if (!metadata.files || typeof metadata.files !== 'object') metadata.files = {};
            }
        } catch { /* ignore if no metadata */ }

        const queue = [...SERVERS];
        const workers = Array.from({ length: Math.min(SCRAPE_CONCURRENCY, queue.length) }, async () => {
            while (queue.length > 0) {
                const srv = queue.shift();
                if (!srv) break;
                await scrapeServer(srv, metadata);
            }
        });
        await Promise.all(workers);

        console.log('[Scraper] Done with all servers.');
    } catch (err) {
        console.error('[Scraper] Error:', err);
    } finally {
        scraperRunning = false;
    }
}

async function maybeRunScraperJob() {
    if (lastScrapeAttemptMs && (Date.now() - lastScrapeAttemptMs) < SCRAPE_RETRY_COOLDOWN_MS) {
        return;
    }
    try {
        const raw = await fs.promises.readFile(META_PATH, 'utf8');
        const { lastUpdate } = JSON.parse(raw);
        if (lastUpdate) {
            const ageMs = Date.now() - new Date(lastUpdate).getTime();
            if (ageMs < SCRAPE_INTERVAL_MS) {
                console.log(`[Scraper] Data is fresh (${Math.round(ageMs / 60000)}m old), skipping.`);
                return;
            }
        }
    } catch { /* no file yet — proceed */ }
    return runScraperJob();
}

const startupTimer = setTimeout(maybeRunScraperJob, 1000);
const scrapeInterval = setInterval(maybeRunScraperJob, SCRAPE_CHECK_MS);

app.get('/last-update', apiLimiter, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (cachedMetadata) {
        return res.json(cachedMetadata);
    }
    try {
        const raw = await fs.promises.readFile(META_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        cachedMetadata = parsed;
        res.json(parsed);
    } catch {
        res.json({ lastUpdate: null, files: {} });
    }
});

app.get('/health', apiLimiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        scraperRunning,
        lastUpdate: cachedMetadata?.lastUpdate || null
    });
});

const PORT = process.env.PORT || 3000;
const httpServer = app.listen(PORT, () => console.log(`Server running -> 0.0.0.0:${PORT}`));

httpServer.on('error', err => {
    console.error('[Server] Listen error:', err);
    process.exit(1);
});

function shutdown(signal) {
    console.log(`[Server] Received ${signal}, shutting down gracefully...`);
    clearTimeout(startupTimer);
    clearInterval(scrapeInterval);
    httpServer.close(() => {
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
