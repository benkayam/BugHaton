// --- CONFIGURATION ---
const CONFIG = {
    // Polling Interval in ms (e.g., 5 seconds)
    POLLING_INTERVAL: 5000,
    JQL_DATE_FILTER: '2025-01-01',
    DONE_STATUSES: ["Done", "Closed", "Verified", "Resolved"],
    POINTS_BY_SEVERITY: {
        'Critical': 25,
        'Very High': 20,
        'High': 15,
        'Medium': 10,
        'Low': 5
    },
    DEFAULT_POINTS: 10,
    STORAGE_KEY: 'bugathon_data_v1',
    TIMER_KEY: 'bugathon_timer_v1',
    CALCULATE_POINTS: true, // Activity mode
    LEADERBOARD_LIMIT: 5, // Max users to show in "Top X"
    TIMER_DURATION_MINUTES: 90, // 1.5 Hours Default
    DATA_SOURCE_URL: 'JiraProxy.ashx', // .NET Handler
    ICONS: {
        PLAY: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="transform: translateX(2px);"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`,
        PAUSE: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`
    }
};

// --- SERVICES ---

/**
 * Handles persistent storage of data.
 */
class StorageService {
    save(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));
        } catch (e) {
            console.error("Storage Save Error:", e);
        }
    }

    load(key) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : null;
        } catch (e) {
            console.error("Storage Load Error:", e);
            return null;
        }
    }

    clear(key) {
        localStorage.removeItem(key);
    }
}

/**
 * Handles Jira data parsing, analysis, and diffing.
 */
class JiraService {
    constructor() {
        this.rawData = null;
        this.stats = {
            total: 0,
            done: 0,
            statusBreakdown: {},
            developers: {},
            testers: {}
        };
    }

    processData(json) {
        this.rawData = json;
        const issues = json.issues || [];

        // Reset Stats
        // FIX: Use issues.length to reflect actual loaded data, ignoring metadata Total if it differs (e.g. pagination)
        this.stats.total = issues.length;
        this.stats.done = 0;
        this.stats.statusBreakdown = {};
        this.stats.developers = {};
        this.stats.testers = {};

        issues.forEach(issue => this._analyzeIssue(issue));

        return this.stats;
    }

    _analyzeIssue(issue) {
        const fields = issue.fields;
        const status = fields.status.name;
        const priority = fields.customfield_11506?.value || fields.priority?.name || 'Medium';

        // 1. Status Breakdown
        if (!this.stats.statusBreakdown[status]) {
            this.stats.statusBreakdown[status] = 0;
        }
        this.stats.statusBreakdown[status]++;

        // 2. Done Count
        if (CONFIG.DONE_STATUSES.includes(status)) {
            this.stats.done++;
        }

        // Check if issue is considered "Done" for points
        const isDone = CONFIG.DONE_STATUSES.includes(status);

        // 3. Testers (Reporter)
        const reporterName = fields.reporter?.displayName || "Unknown";
        const reporterAvatar = fields.reporter?.avatarUrls?.['48x48'];
        this._updatePerson(this.stats.testers, reporterName, reporterAvatar, priority, isDone);

        // 4. Developers (Assignee)
        const devName = fields.customfield_10919?.displayName
            || fields.assignee?.displayName
            || "Unassigned";

        if (devName !== "Unassigned") {
            const devAvatar = fields.customfield_10919?.avatarUrls?.['48x48']
                || fields.assignee?.avatarUrls?.['48x48'];
            this._updatePerson(this.stats.developers, devName, devAvatar, priority, isDone);
        }
    }

    _updatePerson(store, name, avatar, priority, isDone) {
        if (!store[name]) {
            store[name] = { name, avatar, bugs: 0, points: 0 };
        }
        // Count total bugs assigned/reported regardless of status?
        // User said "if bug is closed... also get points and be in list".
        // Leaderboard filters by points > 0.
        // We will increment total bugs count always (activity), but points only if done.
        store[name].bugs++;

        if (CONFIG.CALCULATE_POINTS && isDone) {
            store[name].points += (CONFIG.POINTS_BY_SEVERITY[priority] || CONFIG.DEFAULT_POINTS);
        }
    }
}

/**
 * Main Controller used to manage the UI and App Lifecycle.
 */
class DashboardApp {
    constructor() {
        this.storage = new StorageService();
        this.jira = new JiraService();

        this.state = {
            timer: { startTime: null, elapsed: 0, isRunning: false },
            lastUpdateConfig: null
        };

        this.knownIssues = new Map(); // Track issue states: Key -> Status

        // DOM Elements
        this.els = {
            jsonInput: document.getElementById('jsonInput'),
            heroTotal: document.getElementById('hero-total'),
            heroDone: document.getElementById('hero-done'),
            heroPct: document.getElementById('hero-pct'),
            statusGrid: document.getElementById('status-grid'),
            devList: document.getElementById('dev-list'),
            testList: document.getElementById('test-list'),
            timerDisplay: document.getElementById('timer'),
            progressBar: document.getElementById('progress-bar'),
            progressText: document.getElementById('progress-text'),
            avgTimeDisplay: document.getElementById('avg-time-display'),
            timerToggleBtn: document.getElementById('btn-timer-toggle')
        };

        this.init();
    }

    init() {
        console.log(`🚀 Dashboard App Initializing...`);

        // Load Timer & Data State
        this.loadState();

        // --- UNIVERSAL MODE ---
        // Always fetch data directly as requested
        this.fetchData();

        // Start Polling for updates
        this.schedulerId = setInterval(() => this.poll(), CONFIG.POLLING_INTERVAL);



        // Start Timer UI Loop (Runs on both, synced via localStorage)
        setInterval(() => this.updateTimerUI(), 1000);
    }

    /* --- DATA HANDLING --- */

    // Viewer: Sync data from LocalStorage
    syncFromStorage() {
        const stored = this.storage.load(CONFIG.STORAGE_KEY);
        if (stored && JSON.stringify(stored) !== JSON.stringify(this.jira.rawData)) {
            console.log("Viewer: New data found in storage, updating...");
            this.updateData(stored);
        }
    }

    poll() {
        this.fetchData();
    }

    renderZeroState() {
        // Renders all zeros
        const zeroStats = {
            total: 0,
            done: 0,
            statusBreakdown: {},
            developers: {},
            testers: {}
        };
        // Mock jira stats temporarily to render zero
        const oldStats = this.jira.stats;
        this.jira.stats = zeroStats;
        this.render();
        this.jira.stats = oldStats; // Restore? Or just keep zero.
    }

    async fetchData() {
        try {
            // Simulate API call to local file
            // Adding timestamp to prevent browser caching of the JSON file
            // Use Configurable URL
            const separator = CONFIG.DATA_SOURCE_URL.includes('?') ? '&' : '?';
            const url = `${CONFIG.DATA_SOURCE_URL}${separator}t=${Date.now()}`;
            console.log(`Fetching data from: ${url}`);

            const response = await fetch(url);
            if (!response.ok) throw new Error("Failed to fetch data");

            const json = await response.json();
            this.updateData(json);
        } catch (err) {
            console.error("API Fetch Error:", err);
        }
    }

    updateData(json) {
        // Optimization: Prevent re-rendering if data hasn't changed
        // We initialize lastRenderedJson in init/constructor in a separate step or lazily here if undefined
        const jsonString = JSON.stringify(json);
        if (this.state && this.state.lastRenderedJson === jsonString) {
            return;
        }
        if (this.state) this.state.lastRenderedJson = jsonString;

        const oldStats = this.jira.stats ? { ...this.jira.stats } : null;

        // Process
        const newStats = this.jira.processData(json);

        // Detect Changes (Victory Logic)
        if (json.issues) {
            this.detectAndNotify(json.issues);
        }



        // Render
        this.render();

        // Check for "Diffs" (Simple check: did Done count increase?)
        // if (oldStats && newStats.done > oldStats.done) {
        //    this.triggerCelebration(newStats.done);
        // }
    }

    loadState() {
        // Load Data
        const cachedData = this.storage.load(CONFIG.STORAGE_KEY);
        if (cachedData) {
            console.log("📦 Loaded cached data");
            this.jira.processData(cachedData);
            this.render();
        }

        // Load Timer
        const cachedTimer = this.storage.load(CONFIG.TIMER_KEY);
        if (cachedTimer) {
            this.state.timer = cachedTimer;
            // Resume if it was running? For simplicity, we might just restore the time.
            if (this.state.timer.isRunning) {
                this.state.timer.isRunning = false;
            }
        }
    }

    /* --- RENDERING --- */

    render() {
        const s = this.jira.stats;
        if (!s) return;

        // Hero Stats
        this.els.heroTotal.innerText = s.total;
        this.els.heroDone.innerText = s.done;

        const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
        this.els.heroPct.innerText = `${pct}%`;

        // Progress Bar (Top Header)
        if (this.els.progressBar) {
            this.els.progressBar.style.width = `${pct}%`;
            if (this.els.progressText) {
                this.els.progressText.innerText = `${s.done} / ${s.total} (${pct}%)`;
            }
        }

        // Status Breakdown Grid
        this.renderStatusGrid(s.statusBreakdown);

        // Leaderboards
        this.renderLeaderboard(this.els.devList, s.developers);
        this.renderLeaderboard(this.els.testList, s.testers);
    }

    // Updated renderStatusGrid to hide 'Done' cards
    renderStatusGrid(breakdown) {
        this.els.statusGrid.innerHTML = '';

        Object.entries(breakdown).forEach(([status, count]) => {
            // Hiding Done/Closed from the grid (redundant with Hero Stats)
            if (['done', 'closed', 'verified', 'resolved'].includes(status.toLowerCase())) return;

            const card = document.createElement('div');
            card.className = 'status-card';

            // Highlight "Reopen" Status only if count > 0
            if (status.toLowerCase().includes('reopen') && count > 0) {
                card.classList.add('status-reopen');
            }

            card.innerHTML = `
                <div class="status-count">${count}</div>
                <div class="status-name">${status}</div>
            `;
            this.els.statusGrid.appendChild(card);
        });
    }

    renderLeaderboard(container, dataMap) {
        container.innerHTML = '';
        const sorted = Object.values(dataMap)
            .filter(p => p.points > 0)
            .sort((a, b) => b.points - a.points)
            .slice(0, CONFIG.LEADERBOARD_LIMIT);

        if (sorted.length === 0) {
            container.innerHTML = `
                <div class="empty-state-container">
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="empty-state-icon">
                        <path d="M5 22h14"></path>
                        <path d="M5 2h14"></path>
                        <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"></path>
                        <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"></path>
                    </svg>
                </div>
            `;
            return;
        }

        sorted.forEach((p, idx) => {
            const rank = idx + 1;
            let medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;

            const div = document.createElement('div');
            div.className = 'rank-item';
            div.innerHTML = `
                <div class="medal">${rank <= 3 ? medal : `<span style="font-size:0.9rem; font-weight:700;">${medal}</span>`}</div>
                <div class="user-info">
                    <div class="user-name">${p.name}</div>
                </div>
                <div class="points">${p.points}</div>
            `;
            container.appendChild(div);
        });
    }

    /* --- TIMER & UTILS --- */

    // --- TIMER (COUNTDOWN) ---
    updateTimerUI() {
        let display = "00:00:00";
        let remaining = 0;

        if (this.state.timer.isRunning) {
            const now = Date.now();
            // Calculate remaining time
            remaining = Math.max(0, this.state.timer.targetTime - now);

            if (remaining === 0) {
                this.state.timer.isRunning = false;
                this.state.timer.isFinished = true;
                this.showVictoryToast('Timer', "Time's Up!", "System", "System");
                if (typeof playBeep === 'function') playBeep();
            }

            this.state.timer.remaining = remaining;
            this.storage.save(CONFIG.TIMER_KEY, this.state.timer);

        } else {
            // If not running, show stored remaining time or default
            remaining = this.state.timer.remaining;
            if (remaining === undefined || remaining === null) {
                remaining = CONFIG.TIMER_DURATION_MINUTES * 60 * 1000;
            }
        }

        display = this.formatTime(remaining);

        if (this.els.timerDisplay) this.els.timerDisplay.innerText = display;

        // Toggle Icon State
        if (this.els.timerToggleBtn) {
            this.els.timerToggleBtn.innerHTML = this.state.timer.isRunning
                ? CONFIG.ICONS.PAUSE
                : CONFIG.ICONS.PLAY;
        }
    }

    formatTime(ms) {
        const totalSeconds = Math.floor(ms / 1000);
        const h = Math.floor((totalSeconds / 3600)).toString().padStart(2, '0');
        const m = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
        const s = (totalSeconds % 60).toString().padStart(2, '0');
        return `${h}:${m}:${s}`;
    }

    // Exposed globally for buttons
    toggleTimer() {
        if (this.state.timer.isRunning) {
            // PAUSE
            this.state.timer.isRunning = false;
        } else {
            // START
            this.state.timer.isRunning = true;

            // Calculate Target Time based on CURRENT remaining time
            let currentRemaining = this.state.timer.remaining;
            if (!currentRemaining && currentRemaining !== 0) {
                currentRemaining = CONFIG.TIMER_DURATION_MINUTES * 60 * 1000;
            }

            this.state.timer.targetTime = Date.now() + currentRemaining;
        }
        this.storage.save(CONFIG.TIMER_KEY, this.state.timer);
        this.updateTimerUI(); // Immediate update
    }

    resetTimer() {
        this.state.timer.isRunning = false;
        this.state.timer.isFinished = false;
        this.state.timer.remaining = CONFIG.TIMER_DURATION_MINUTES * 60 * 1000;
        this.state.timer.targetTime = null;

        this.updateTimerUI();
        this.storage.save(CONFIG.TIMER_KEY, this.state.timer);
    }

    /* --- VICTORY LOGIC --- */

    detectAndNotify(currentIssues) {
        if (this.knownIssues.size === 0) {
            // First run: just populate the map, no notifications
            currentIssues.forEach(issue => {
                this.knownIssues.set(issue.key, issue.fields.status.name);
            });
            return;
        }

        currentIssues.forEach(issue => {
            const key = issue.key;
            const newStatus = issue.fields.status.name;
            const oldStatus = this.knownIssues.get(key);

            // Updates map
            this.knownIssues.set(key, newStatus);

            // Check for VICTORY: Was not done, now is done?
            const isDoneNow = CONFIG.DONE_STATUSES.includes(newStatus);
            const wasDoneBefore = CONFIG.DONE_STATUSES.includes(oldStatus);

            if (isDoneNow && !wasDoneBefore && oldStatus) {
                // VICTORY!
                const dev = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unknown';
                const qa = issue.fields.customfield_11024 ? issue.fields.customfield_11024.displayName : 'Unknown';

                this.showVictoryToast(key, issue.fields.summary, dev, qa);
                this.fireConfetti(); // User requested to re-enable animation
            }
        });
    }

    showVictoryToast(key, summary, dev, qa) {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `
                <div class="toast-header">
                    <span>🎉🎉</span> Bug Smashed!
                </div>
                <div class="toast-body">
                    <strong>${key}:</strong> ${summary}
                </div>
                <div class="toast-credits">
                    ${dev} ❤️ ${qa}
                </div>
            `;

        container.appendChild(toast);

        // Remove after 5 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(100%)';
            setTimeout(() => toast.remove(), 300);
        }, 10000);
    }

    fireConfetti() {
        // Robust, dependency-free confetti implementation
        const colors = ['#a864fd', '#29cdff', '#78ff44', '#ff718d', '#fdff6a'];

        for (let i = 0; i < 100; i++) {
            const confetti = document.createElement('div');
            confetti.style.width = '8px';
            confetti.style.height = '8px';
            confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            confetti.style.position = 'fixed';
            confetti.style.top = '0';
            confetti.style.left = Math.random() * 100 + 'vw';
            confetti.style.zIndex = '9999';
            confetti.style.pointerEvents = 'none';
            confetti.style.opacity = '1';
            confetti.style.transform = `rotate(${Math.random() * 360}deg)`;

            // Animation
            const duration = Math.random() * 3 + 2;
            confetti.style.transition = `top ${duration}s ease-in, opacity ${duration}s ease-out, transform ${duration}s linear`;

            document.body.appendChild(confetti);

            // Trigger animation
            setTimeout(() => {
                confetti.style.top = '110vh';
                confetti.style.opacity = '0';
                confetti.style.transform = `rotate(${Math.random() * 360 + 360}deg)`;
            }, 10);

            // Cleanup
            setTimeout(() => confetti.remove(), duration * 1000);
        }
    }
}

// Global functions for HTML buttons
let app;
window.startTimer = () => app.toggleTimer(); // Toggle covers start/pause
window.pauseTimer = () => app.toggleTimer();
window.resetTimer = () => app.resetTimer();

// --- SOUNDS ---
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function playBeep() {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(800, audioCtx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.2);

    gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.2);
}

// Init
window.addEventListener('DOMContentLoaded', () => {
    app = new DashboardApp();
});
