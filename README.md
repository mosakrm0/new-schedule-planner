# University Schedule Planner (BAU)

A web application for **Balqa Applied University (BAU)** students to build conflict-free course schedules across all university colleges and campuses, featuring a vintage Windows 95 interface, Web Worker constraint solving, weekly calendar visualization, and PNG schedule export.

**Author:** Mosa Akram ([LinkedIn](https://www.linkedin.com/in/mosakrm/))

---

## Technology Stack
- **Backend:** Node.js + Express 5 (`helmet`, `compression`, `dotenv`, `json5`)
- **Frontend:** Vanilla HTML/CSS/JS + Web Workers + `PapaParse` + `html2canvas`
- **Data Source:** Balqa Applied University RMI endpoints (12 campuses/colleges × 2 degree levels)
- **Storage:** CSV datasets in `public/data/*.csv` + `public/data/metadata.json`
- **Deployment:** Multi-stage `node:20-alpine` Docker image

---

## Project Structure
```text
├── server.js                 # Express static server, CSP/security headers, & RMI scraper
├── lib/
│   └── scraper-utils.js      # Safe JSON/JSON5 parsing, HTML cleanup, row merging, & scrape guards
├── public/
│   ├── index.html            # RTL Arabic UI with vintage Windows 95 chrome
│   ├── styles.css            # Windows 95 beveled theme preserving BAU green & cream palette
│   ├── schedule-core.js      # Shared slot parser, conflict detector, scorer, & Top-K solver
│   ├── worker.js             # Web Worker entrypoint delegating to schedule-core.js
│   ├── app.js                # UI state, CSV loading, preferences, calendar view, & PNG export
│   ├── data/                 # Scraped <server>_<degree>.csv files & metadata.json
│   └── images/               # University logo and background texture
├── tests/
│   ├── scraper-utils.test.js # Unit tests for scraper utilities
│   └── schedule-core.test.js # Unit tests for schedule solver & conflict detection
├── Dockerfile                # Multi-stage Alpine production image
└── package.json
```

---

## Key Features
1. **Multi-Campus & Degree Support:** Covers 12 BAU servers (`center`, `fet`, `irbid`, `huson`, `ajloun`, `alia`, `amman`, `karak`, `maan`, `shoubak`, `aqaba`, `zarqa`) across Bachelor's (`3`) and Intermediate Diploma (`2`), with dynamic sub-college filtering for `center` and automatic disabling of unavailable degree files.
2. **True Top-100 Backtracking Solver:** Runs off the main thread in `worker.js` using `ScheduleCore.solveSchedules()`, retaining the best 100 schedules by the selected scoring strategy instead of stopping at the first 100 DFS hits.
3. **Smart Preferences & Filtering:**
   - Sort modes: Balanced, Fewest Days, Least Breaks, Morning, Afternoon
   - **Open Sections Only** toggle (excludes `مغلقة` sections while still allowing inspection when disabled)
   - **Day Exclusion** toggles (`الأحد`–`السبت`)
4. **Conflict Diagnostics:** Reports filter-excluded courses, direct pairwise conflicts, and 3-way multi-course conflicts.
5. **Calendar & Export:** Toggleable 8:00 AM–8:00 PM weekly calendar grid and clean `html2canvas` PNG export.

---

## Running Locally & Testing

### Environment Variables (`.env`)
```env
PORT=3000
TRUST_PROXY=false
```

### Commands
```bash
npm install
npm test     # Runs node --test tests/*.test.js
npm start    # Starts Express server on PORT (default 3000)
```

### Docker
```bash
docker build -t bau-schedule-planner .
docker run -p 3000:3000 bau-schedule-planner
```
