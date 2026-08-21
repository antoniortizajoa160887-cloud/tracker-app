/* Tracker app — part 1/8: 00-core.js
   Core & bootstrap — external-library guard, Supabase client + token-wrapped rpc, resilient retry, session token, version tracking, global search, the shared collapsible record-card list infrastructure, and the shared claims/charges deduction engine.
   Split out of the original single-file index.html for maintainability; classic
   script, loaded in order with its siblings and sharing one global scope. */
    // Detect whether the required external libraries actually loaded.
    // In some restricted preview/sandbox environments, external <script src>
    // tags from certain CDNs are blocked, which leaves window.XLSX / window.supabase
    // undefined. Rather than throwing a cryptic uncaught error, show a clear message.
    if (typeof window.supabase === 'undefined' || typeof window.XLSX === 'undefined') {
        document.getElementById('env-warning').style.display = 'block';
        var authBox = document.getElementById('auth-container');
        if (authBox) authBox.style.display = 'none';
        throw new Error('Required libraries (Supabase and/or XLSX) failed to load — this environment likely blocks the CDN they are hosted on. Open this file directly in a regular browser instead.');
    }

    const SUPABASE_URL = 'https://ofnveuguvwsvcxyidfdr.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9mbnZldWd1dndzdmN4eWlkZmRyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1MTM2MjMsImV4cCI6MjEwMTA4OTYyM30.-KAbO5eRUhYtcpX9_6vtgbt-onK5RPvmeQPSq6riI_E';
    const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // ===== Session token =====
    // The database no longer trusts the client-supplied p_actor string on its own:
    // every actor-scoped RPC now verifies an unforgeable session token issued by
    // verify_login (see _require_actor in Supabase). This wrapper attaches the current
    // token to every RPC that carries a p_actor, so individual call sites are unchanged.
    let authToken = null;
    const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // keep <= the server session lifetime
    (function wrapRpcWithToken() {
        const nativeRpc = supabaseClient.rpc.bind(supabaseClient);
        supabaseClient.rpc = function(fn, params, options) {
            if (params && typeof params === 'object' && 'p_actor' in params && authToken && !('p_token' in params)) {
                params = Object.assign({}, params, { p_token: authToken });
            }
            return nativeRpc(fn, params, options);
        };
    })();

    // Retry wrapper for calls where a dropped mobile connection must not fail the
    // whole flow (auth / 2FA). A *network* failure — the promise rejects, or the
    // returned error has no PostgREST code and reads like a fetch failure ("Load
    // failed" on iOS, "Failed to fetch" on Chrome) — is retried a few times with
    // backoff. Real application errors (they carry a PostgREST `.code`) are
    // returned immediately and never retried.
    function _isNetworkErr(err) {
        if (!err) return false;
        if (err.code) return false; // PostgREST/Postgres error -> not a network drop
        return /load failed|failed to fetch|networkerror|network request|timeout|fetch/i.test(err.message || String(err));
    }
    async function rpcResilient(name, params, opts) {
        const retries = (opts && opts.retries != null) ? opts.retries : 3;
        const delays = [400, 900, 1600, 2500];
        let last = { data: null, error: { message: 'Load failed' } };
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                const res = await supabaseClient.rpc(name, params);
                if (!res.error || !_isNetworkErr(res.error)) return res; // success or app-error
                last = res;
            } catch (e) {
                if (!_isNetworkErr(e)) return { data: null, error: e };
                last = { data: null, error: e };
            }
            if (attempt < retries) await new Promise(r => setTimeout(r, delays[Math.min(attempt, delays.length - 1)]));
        }
        return last;
    }

    let currentUser = null;
    let currentUserRole = 'User';
    let currentUsername = '';
    let routes = [], employees = [], claims = [], charges = [], damageTypes = ['Property Damage'], chargeTypes = ['Loan', 'Penalties', 'Bet'];
    let additionalIncome = [], incomeTypes = ['Bonus', 'Reimbursement', 'Per Diem'];
    // Daily-pay state
    let payTypes = {};          // employee_id -> 'Weekly' | 'Daily'
    let dailyGrid = {};         // employee_id -> { 0..6: { amount, is_off } } for the browsed week
    let currentWeekDaily = {};  // employee_id -> number (this week's daily total, for Payroll)
    let currentWeekDailyDetail = {}; // employee_id -> [{date, amount, is_off}] (this week, for Payroll expand)
    let currentWeekLabel = '';  // human label for the current pay week
    let recExpanded = { employees: new Set(), claims: new Set(), charges: new Set(), income: new Set(), companies: new Set(), payroll: new Set(), users: new Set(), approvals: new Set(), log: new Set(), changelog: new Set(), vehicles: new Set(), invoices: new Set(), bills: new Set(), releasehistory: new Set() };
    // Which status GROUPS are collapsed (not individual records — those use
    // recExpanded above). A status listed in a tab's set starts collapsed;
    // toggling removes/re-adds it and the choice persists for the session.
    // Claims & Charges, Income, Week in Deposit and Statement start with every
    // status group COLLAPSED by default (seeded below); the user expands what
    // they want. Invoices start expanded.
    const _COLLAPSE_DEFAULT_STATUSES = ['Queued', 'Deducting', 'Paying', 'Paid', 'Absorbed', 'Tk from check', 'Released', 'Stopped'];
    let collapsedStatusGroups = {
        claims: new Set(), charges: new Set(),
        cc: new Set(_COLLAPSE_DEFAULT_STATUSES),
        income: new Set(_COLLAPSE_DEFAULT_STATUSES),
        weekdeposit: new Set(_COLLAPSE_DEFAULT_STATUSES),
        statement: new Set(_COLLAPSE_DEFAULT_STATUSES),
        invoices: new Set(), bills: new Set()
    };
    function toggleStatusGroup(tab, status) {
        const set = collapsedStatusGroups[tab];
        if (!set) return;
        if (set.has(status)) set.delete(status); else set.add(status);
        if (tab === 'claims' || tab === 'cc' || tab === 'charges') renderClaimsCharges();
        else if (tab === 'income') renderIncome();
        else if (tab === 'weekdeposit') renderWeekDeposit();
        else if (tab === 'statement') renderStatement();
        else if (tab === 'invoices') renderInvoices();
        else if (tab === 'bills') renderBills();
    }
    // Employee grouping (Savings & Release Eligibility, Release History): which
    // employee groups are collapsed. All start expanded.
    let collapsedEmpGroups = { savingsreport: new Set(), releasehistory: new Set() };
    function toggleEmpGroup(tab, empId) {
        const set = collapsedEmpGroups[tab];
        if (!set) return;
        if (set.has(empId)) set.delete(empId); else set.add(empId);
        if (tab === 'savingsreport') renderSavingsReleaseReport();
        else if (tab === 'releasehistory') renderReleaseHistory();
    }
    let dailyExpanded = new Set();    // employee_ids whose Daily Pay card is expanded (mobile)

    // ===== Version tracking =====
    // This array is the source of truth for the app's version history — it
    // lives in the file itself so it's correct even across sessions/devices.
    // Newest entry first. Bump APP_VERSION and prepend an entry on every
    // delivered change.
    const APP_VERSION = 'v3.53';
    const CHANGELOG = [
        { version: 'v3.53', date: '2026-08-21', notes: 'Internal release — nothing about how the app looks or works has changed, and the only visible difference is the version number shown above. Until today, every new version had to be published to the server by hand. The automatic link between GitHub and the server had quietly stopped working about a day earlier: when the server moved onto its own web address, that link was still pointing at the old one, so the server simply never heard about new versions. That link has been repaired, and this release exists purely to confirm it works from end to end — if you are reading this version number, it arrived here on its own.' },
        { version: 'v3.52', date: '2026-08-21', notes: 'Internal maintenance release — no change to how the app looks or works. The app used to live in one very large file; it has been split into a small page plus a stylesheet and eight focused code files (core, auth, employees & claims, attachments/import/deposit, income & provider pay, messaging, language & sessions, and financial). This makes the code far easier to maintain and update going forward. The split was done so that it produces byte-for-byte the same result as before — verified by re-assembling the pieces into the exact original, by an automated snapshot test that confirmed every screen renders identically, and by load tests in the browser. If your screen looks momentarily stale right after this update, one refresh loads the new files.' },
        { version: 'v3.51', date: '2026-08-21', notes: 'The app is now bilingual — English and Español. A language switch appears on the login screen and in Settings (under “Language”). Pick English or Español and the whole interface changes at once: the side menu and tabs, every form, filter, button, table header and note box, the account and sign-out menus, the login and two-factor screens, and the record cards themselves — Employees, Claims & Charges, Income, Payroll, Statement, Week in Deposit, Savings & Release, Release History, Invoices, Bills, Companies, Users, Approvals, Log and the rest. Your choice is saved on this device only, so other people signed in elsewhere keep their own language. On a brand-new device where nothing has been chosen yet, the app follows the device’s own language (Spanish if the device is set to Spanish, otherwise English) until you pick one — picking a language from the switch is what locks it in. A small number of pop-up confirmation messages and a few status words still show in English for now and will be translated in a later update; nothing is ever left blank, since anything not yet translated simply falls back to English.' },
        { version: 'v3.50', date: '2026-08-21', notes: 'Two-factor setup reminders are now every 15 days instead of on every sign-in. If your role recommends 2FA and you tap “Skip for now”, you won’t be asked again for 15 days — then you’ll get one more reminder, and so on until you turn it on. It is never forced: you can always skip or sign out, the setup screen retries automatically if the connection drops, and once 2FA is on the reminders stop. If an Administrator resets your 2FA, the 15-day reminder cycle starts fresh.' },
        { version: 'v3.49', date: '2026-08-21', notes: 'The “Sign Out All Users” countdown now appears almost instantly for everyone instead of within about 20 seconds. When an Administrator starts — or cancels — a sign-out, every open screen is notified in real time and shows (or clears) the banner right away. If the real-time channel is ever unavailable, the app still falls back to its regular periodic check, so the countdown always appears; the shut-off time itself was already exact. No change to how it works otherwise.' },
        { version: 'v3.48', date: '2026-08-21', notes: 'Managers now see failed sign-ins only for their own company. The “Recent failed sign-ins” list and the unusual-activity pop-up previously showed failed attempts for accounts in every company to any Administrator or Medium manager; they now show only accounts in the manager’s own company, matching how the rest of the app is scoped. Super Admin still sees everything. Failed attempts from a network/address (which aren’t tied to any one account) stay visible to all managers so an attack in progress is still spotted.' },
        { version: 'v3.47', date: '2026-08-21', notes: 'New: “Sign Out All Users”, with a grace period and countdown. Administrators and Super Admins can now sign everyone out — an Administrator affects their own company, a Super Admin affects everyone. Find it on the Settings screen under the red Administrator zone. (1) You choose a grace period (default 5 minutes) and can add a reason. Everyone then sees a banner counting down (for example 04:59, 04:58…) that they cannot dismiss, telling them to save their work because unsaved changes will be lost, and showing your reason if you gave one. The banner turns red in the last minute and pulses in the last 30 seconds. People can keep working and saving during the countdown. (2) When the timer reaches zero, everyone is signed out of all their devices automatically — enforced on the server, so it applies even to someone who ignores the banner. (3) You can call it off before the deadline with the “Cancel (admin)” button on the banner. (4) Every Sign Out All Users is recorded under Users → Global sign-out history: who started it, when, the scope, the grace period, how many were signed out, the reason, and whether it completed or was cancelled. Signing out your own current session, and “Sign out my other devices”, are unchanged.' },
        { version: 'v3.46', date: '2026-08-21', notes: 'More reliable two-factor setup on phones — and you can never get locked out. (1) If your connection briefly drops while turning on 2FA or signing in, the app now retries automatically instead of failing with a “Load failed” error, and if it still can’t reach the server it shows a clear “Network problem — check your connection and try again” message. Your typed 6-digit code is kept, so you can just tap Verify again. (2) When 2FA setup is required for your role, the setup screen now always offers “Skip for now” (you’ll be asked again the next time you sign in) and “Sign out”, plus a “Try again” button if setup couldn’t even start. This means a bad connection during setup can no longer trap your account — a problem a Super Admin hit on a mobile connection.' },
        { version: 'v3.45', date: '2026-08-21', notes: 'The unusual-activity sign-in pop-up now names who is affected, and is shown to Medium level and above. Previously it only told you how many accounts or networks had many failed sign-ins; now it lists each one by username and employee ID (a network shows its address instead), so you can see exactly which account is being targeted and jump straight to it. The same username-and-ID detail now also shows in the Users → Recent failed sign-ins list. Managers at Medium level (not only Administrators) now receive this heads-up and can open the Recent failed sign-ins screen. The warning about your own account is unchanged.' },
        { version: 'v3.44', date: '2026-08-21', notes: 'Tidier Users screen, clearer tables, and a heads-up when sign-ins look suspicious. (1) On the Users screen the "System Users" list is now collapsible and starts collapsed — tap its heading to open it — so "Active sessions" and "Recent failed sign-ins" are easier to reach without scrolling past a long list. (2) Active sessions, Recent failed sign-ins, and System Users now all show as tidy tables on phone and desktop alike (on a narrow phone the table scrolls sideways inside its box), instead of switching to cards on mobile. Signing a session out works exactly as before — the Sign out button is in each session’s row. (3) New: right after you sign in, if there have been many failed sign-in attempts you get a short pop-up. You are warned about attempts on your own account (with a shortcut to change your password), and Administrators are additionally warned when any account or network has had many failures in the last 24 hours (with a shortcut to review them). "Many" means an account or network that got locked, or 10 or more failed tries. If nothing looks unusual, no pop-up appears.' },
        { version: 'v3.43', date: '2026-08-21', notes: 'Small consistency fix so account options match on phone and desktop. The “Sign out my other devices” option now also appears in the desktop side-menu account section (bottom-left), where previously it was only in the phone’s ⋮ menu. Everything else is unchanged: on a phone or installed app, the ⋮ button (top-right) still opens Change Password, Two-Factor Authentication, Sign out my other devices, and Sign Out; two-factor setup and the sign-in code prompt already work the same on phone, desktop and the installed app; and Administrators still find “Active sessions” and “Recent failed sign-ins” on the Users screen, which lays out as tap-friendly cards on a phone.' },
        { version: 'v3.42', date: '2026-08-21', notes: 'Two-factor authentication (2FA) for stronger sign-in security. You can now protect your account with a second step at sign-in: a 6-digit code from a free authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy, 1Password, and others). Once it is on, signing in asks for your password and then the current code, so a stolen password by itself is no longer enough to get in. (1) To turn it on yourself, open the account menu (the ⋮ button, or the bottom of the side menu) → Two-Factor Authentication → Set up now. Add the account to your authenticator app — tap “Open in authenticator app” on a phone, or type the shown key — then enter the 6-digit code once to confirm and save the eight one-time recovery codes it gives you. (2) Manager-level accounts (Medium and Administrator, plus Super Admin) are asked to set this up the next time they sign in and cannot skip it; View Only accounts may turn it on but are never required to. (3) Lost your phone? Enter one of your saved recovery codes in place of the app code (each works once), or ask an Administrator to reset your 2FA from the Users screen — after a reset you just set it up again. (4) Administrators can see who has 2FA on (a 🔐 marker on the Users list) and reset it for anyone who gets locked out. Everything is checked on the server; the secret and the recovery codes are stored hashed and are never shown again after setup.' },
        { version: 'v3.41', date: '2026-08-21', notes: 'Security improvements around signing in. (1) Sign-in attempts are now also limited per network, not just per account. Previously someone could try one password against many different usernames without ever tripping the 5-attempt account lock \u2014 that gap is closed. The network limit is deliberately generous (30 failed attempts in 15 minutes, then a 15-minute pause) so a normal office sharing one internet connection is never affected. (2) Administrators can now see every active sign-in under Users \u2192 Active sessions, and sign any of them out immediately \u2014 useful if a phone or laptop goes missing. Everyone can see their own sessions, and there is a new \u201cSign out my other devices\u201d option in the account menu. For safety the session itself is never exposed, so this screen can show and end sessions but can never be used to impersonate anyone. (3) Administrators can see recent failed sign-ins under Users \u2192 Recent failed sign-ins, so an attack in progress is visible rather than silently recorded. (4) Sessions now last 8 hours instead of 12; the 10-minute inactivity sign-out is unchanged.' },
        { version: 'v3.40', date: '2026-08-21', notes: 'Files shared in a conversation can now be renamed before they are sent, the same way they already could from a record\u2019s Files. Picking a file in a chat no longer sends it straight away: it is listed first with an editable name, pre-filled to match the rest of the app \u2014 for example \"3OFL00110D-20260821\" for a charge, with -2, -3 for more than one the same day \u2014 so a camera name like \"IMG_20260819_223344_1.jpg\" never ends up on the record. You can rename any of them, remove one you picked by mistake, then press Send. The extension is kept out of the editable box so it cannot be broken, names are cleaned up automatically, and anything staged but not sent is discarded if you switch to another conversation. Files still attach to the claim, charge or income the conversation is about, and the paperclip counts on those records update immediately.' },
        { version: 'v3.39', date: '2026-08-20', notes: 'Messaging now always talks about the right person\u2019s records, and View Only users can share files in a conversation. (1) When a conversation involves a View Only user, picking Claims, Charges or Income now always lists THAT person\u2019s records \u2014 whoever opened the conversation. Previously, if a View Only user started a chat with a manager, the list showed the manager\u2019s records instead of their own. So Sixto messaging Antonio about a claim now sees Sixto\u2019s claims, and Anahi messaging Sixto sees Sixto\u2019s claims too. Manager-to-manager conversations are unchanged. (2) View Only users can now attach photos, videos and documents inside a conversation about one of their own claims, charges or income, and the file is filed against that record automatically \u2014 so it also appears in that record\u2019s Files. They can open anything attached to their own records, including files a manager added, but still cannot delete or rename them. They cannot attach to anyone else\u2019s record, or to a truck, invoice or bill. (3) Who may start a conversation is unchanged: a View Only user can message managers, and managers can message anyone.' },
        { version: 'v3.38', date: '2026-08-20', notes: 'View Only accounts can now look after their own record, with managers kept in the loop. (1) A View Only user can open their own Status history — read only; they still cannot change their own status or edit any other field. (2) They can upload their own Driver License, Work Permit and Medical Card from their employee card. They can add and view those documents but cannot rename or delete them, so a document cannot be withdrawn once it has been submitted. They cannot upload to anyone else, to a truck, or to a claim, charge, invoice or bill. (3) As soon as a View Only user uploads one of their documents, everyone at Medium level and above gets a notification naming the person and the document, so it can be reviewed — tap the notification to jump straight to that employee. Managers uploading documents themselves create no notification, since they already know. Security note: the rule limiting a View Only user to their own record is now enforced on the server, not just hidden in the screen.' },
        { version: 'v3.37', date: '2026-08-20', notes: 'Shorter, consistent file names for uploaded documents. Names are now built as a short document code, the record ID and the date — for example "DL-3OFL0002S-20260820.jpg" for a Driver License, or "REG-3OFL0001V-20260820.jpg" for a truck registration (DL = Driver License, WP = Work Permit, MC = Medical Card, REG = Registration, INS = Insurance Card). A general file on a record is just the record ID and date. A second file the same day gets -2, -3 and so on. This replaces the previous long names like "Driver License — Antonio Ortiz Arevalo.jpg", which were unwieldy and turned into runs of underscores in storage. Names are still fully editable before you upload, and files already uploaded have been renamed to the new format — only the name shown changes, the files themselves are untouched. Also fixed earlier today: uploading to an employee or truck failed because the list of record types allowed to hold files was duplicated in three places and only some had been updated; all three now agree.' },
        { version: 'v3.36', date: '2026-08-20', notes: 'Employees and trucks can now hold their documents, and files can be named properly. (1) Each employee has upload slots for Driver License, Work Permit and Medical Card, and each truck has slots for Registration and Insurance Card — tap a slot to upload or view. Uploading is completely optional; nothing is required. (2) The Expiring Documents screen now shows the same slots, so when something is about to expire you can open the actual document right there instead of going to look for it. (3) A paperclip count appears on employee and truck rows that have files, the same way it already does on claims and charges. (4) When you upload, files are now listed first with an editable name — pre-filled with something tidy like "Medical Card — Luis Melara" — so a camera file name like "IMG_20260819_223344_1.jpg" does not end up in the record. You can also rename a file that is already uploaded with the ✎ button. Renaming only changes the name shown; the file itself is untouched.' },
        { version: 'v3.35', date: '2026-08-20', notes: 'Finished fixing the doubled window title bar of the installed app. The operating system builds that title bar as "{installed app name} + page title", and it remembers the app name from when the app was first installed — so the old, long name ("Tracker — Logistics · HR · Claims") kept showing before the page title, doubling the wording. Now, when the app is running as an installed window, the page title holds only the company name (nothing else), so the bar reads cleanly — e.g. "Tracker — Logistics · HR · Claims - 3 Of Life LLC" on an existing install, or "Tracker - 3 Of Life LLC" once reinstalled — with no repeated words either way. Opened in a normal browser tab it still shows the full "… · Unified Logistics · HR · Claims". You do NOT need to reinstall to clear the duplication — just reload; reinstalling only shortens the app-name prefix to "Tracker".' },
        { version: 'v3.34', date: '2026-08-20', notes: 'Fixed the doubled window title bar. When the app is installed and opened in its own window, the operating system builds the title bar as "{app name} + page title" — and because both already said "Tracker — … Logistics · HR · Claims", the whole thing showed twice. The installed app name is now simply "Tracker" and the page title no longer repeats it, so the window title bar reads cleanly as "Tracker · Unified Logistics · HR · Claims" (and "Tracker · {Company} · Unified Logistics · HR · Claims" once signed in). The in-app header is unchanged — it still shows "{Company} / Tracker — Unified Logistics · HR · Claims". Note: a window/tab that was already open may need a refresh, and an already-installed app may keep its old name until reinstalled.' },
        { version: 'v3.33', date: '2026-08-20', notes: 'Login and branding polish. (1) The app title/branding no longer appears twice — the sidebar corner simply reads "Tracker", while the main title bar carries the full "{Company} / Tracker — Unified Logistics · HR · Claims". (2) The login screen has a show/hide password eye — tap it to reveal what you typed and check it. (3) Pressing Enter now signs you in (Enter on the username field jumps to the password field; Enter on the password field submits) — no need to click Sign In. (4) The app icons (browser tab, taskbar, home screen) now use the rounded-corner logo instead of a hard square, matching the official logo everywhere.' },
        { version: 'v3.32', date: '2026-08-20', notes: 'Records with uploaded files now show a paperclip badge so you can tell at a glance which ones have documents, photos or videos — no more opening each one to check. Wherever files can be attached — Claims & Charges, Additional Income, Invoices and Bills — any record with one or more files shows a small 📎 chip with the count right on its collapsed row/card. Tap the chip to open that record\'s Files directly. The count updates as soon as you add or remove files.' },
        { version: 'v3.31', date: '2026-08-19', notes: 'A new title bar and two grouped report screens. The app title now reads "Tracker — Unified Logistics · HR · Claims", and once you are signed into a company it shows the company first — for example "3 Of Life LLC / Tracker — Unified Logistics · HR · Claims". This applies to every company (Super Admin sees it update as they switch companies, and it also updates the browser tab). Separately, the Savings & Release Eligibility and Release History screens now group their records by Employee — tap an employee heading to collapse or expand that person — and each gained filters: Savings & Release Eligibility has search plus a Type filter (Week in Deposit / Last Paycheck) and an Eligibility filter (Ready now / Not yet), and Release History has search plus a Type filter and an Early / On-time filter.' },
        { version: 'v3.30', date: '2026-08-19', notes: 'Messaging gets files, emoji, and a cleaner people list. (1) You can now attach photos, videos and documents inside a chat: from a Claim, Charge or Income conversation tap the 📎 button to send a file — it is automatically attached to that specific record (so it also appears in that record\'s Files) and shows in the chat with a tap-to-open button. Phone photos are shrunk automatically and single files can be up to 100 MB. (General and Missing Day chats have no record to attach to, so files are sent from the record conversations.) (2) An emoji picker (😊) is available in every conversation. (3) The "new conversation" people list is cleaner: role labels are hidden, and the Super Admin account and the automatic company login accounts (like "3ofl") no longer appear — you only see real people you are allowed to message.' },
        { version: 'v3.29', date: '2026-08-19', notes: 'Messages are now organized down to the specific item. When you start a conversation you pick a person, then a topic — and for Claims, Charges or Income you then pick the exact record it is about (only that person\'s records are listed), while Missing Day opens a calendar to pick the date. Each item becomes its own independent thread: your conversation about one claim stays completely separate from another claim, from a Missing Day, and from General chat — each with its own history and unread count. The conversation list shows the item next to each thread (for example the claim number and damage type, or the date), and the topic filter chips still narrow the list.' },
        { version: 'v3.28', date: '2026-08-19', notes: 'Provider Pay is now linked to Bills Payable. Under each provider on the Provider Pay screen, any unpaid bill whose vendor name matches that provider now appears with a checkbox and its amount. Tick one or more bills and press "Pay selected" to mark them Paid in a single step and add their combined total to that provider\'s pay for the week (the bill numbers are noted automatically). This lets you settle several of a provider\'s bills at once and keeps Bills Payable and Provider Pay in sync — a paid bill immediately drops off the provider\'s list.' },
        { version: 'v3.27', date: '2026-08-19', notes: 'Invoices and Bills can now be marked Void. A voided invoice or bill stays on record — it moves into a new Void group at the bottom of the list — but no longer counts toward any outstanding/unpaid total, and (for invoices) it drops out of the “Invoiced This Month” amount: a voided document is treated as zero value while the original record is preserved for history. Void is available in the Status dropdown on the New/Edit form, as a Status filter, and as its own collapsible group (shown after Unpaid and Paid).' },
        { version: 'v3.26', date: '2026-08-19', notes: 'Two fixes. The desktop side menu no longer shows a left-right scrollbar — long menu names like "Savings & Release Eligibility" now wrap onto a second line so everything fits the panel width, on any screen size. And Bills Payable now groups its bills into Unpaid and Paid sections (Unpaid first, each header showing its count and dollar total), matching the Invoices screen, and gained the same controls: search, a Status filter, a Vendor filter, a Clear-filters button, and a Sort-by menu (due date, bill date, vendor, bill #, amount, or status) with an ascending/descending toggle.' },
        { version: 'v3.25', date: '2026-08-19', notes: 'Two organizing changes. First, several list screens now open with their sections collapsed, so you see the headings first and expand only what you need: on Claims & Charges, Income, Week in Deposit and the Statement, every status group (Deducting, Queued, Paid, and so on) starts collapsed — tap a heading to open it — and the Settings screen\'s panels (ID Configuration, Type of Damage, Charge Type, Additional Income Type) start collapsed too. Nothing is hidden permanently; the sections are all one tap away. Second, the Invoices screen now groups every invoice into Unpaid and Paid sections (Unpaid first, each showing its count and dollar total), and gained the same full controls the other lists have: search, a Status filter, a Customer filter, a Clear-filters button, and a Sort-by menu (invoice date, invoice #, customer, due date, amount, or status) with an ascending/descending toggle.' },
        { version: 'v3.24', date: '2026-08-19', notes: 'Messaging now organizes each conversation by topic, and the menu icons are consistent. When you start a chat with someone you first pick a topic — General, Missing Day, Claims, Charges, or Income — and each topic becomes its own separate, independent thread with that person: your Claims conversation with Sixto stays completely separate from your Missing Day conversation with Sixto, each with its own unread count and history. The Messages list now shows one row per topic conversation, with topic filter chips (All / General / Missing Day / Claims / Charges / Income) across the top and a “+” button to start a new one (pick the person, pick the topic). Everything else about messaging is unchanged — same company scoping, same rule that a View Only user can message managers but not another View Only user, same read receipts and unread badge. Separately, the three menu icons added last time (Income, Savings & Release Eligibility, Release History) plus Home were switched from colored emoji to the same clean single-color line icons the rest of the menu already uses, so the whole sidebar now matches.' },
        { version: 'v3.23', date: '2026-08-19', notes: 'New built-from-scratch messaging system, plus a few tab icons. Messages is now a direct, person-to-person chat between the people who log in (user accounts), not the old per-employee note threads. Open Messages to see everyone you\'re allowed to talk to on the left, with unread counts and a badge on the Messages menu item; click a person to open the conversation and type at the bottom. Who can message whom is enforced on the server, not just hidden in the screen: everyone is limited to people in their own company (Super Admin can reach anyone, in any company, and anyone can reach a Super Admin), and — as requested — a View Only user can message managers and Super Admin but cannot message another View Only user. Read receipts (a “Read” tag once the other person opens it), unread badges, and delete-your-own-message are all included; it stays up to date every few seconds while the tab is open. Also added quick icons to three menu items so they\'re easier to spot: 💵 Income, 🏦 Savings & Release Eligibility, and 📜 Release History. The previous employee-note message threads are retired from the interface (their history is left untouched in the database).' },
        { version: 'v3.22', date: '2026-08-19', notes: 'Claims and Charges are now managed on one screen. The old separate \'Claims\' and \'Charges & Income\' tabs became a single \'Claims & Charges\' tab that lists both together — every row and card carries a CLAIM or CHARGE badge so they\'re never confused, and a Kind dropdown (Claims & Charges / Claims only / Charges only) plus one shared search, employee, type and status filter let you narrow to exactly what you want. Nothing about the records themselves changed: a claim is still a claim and a charge is still a charge, each keeps its own ID series, its own table, and its own statuses, and each is still created and edited on its own form (a New Claim / New Charge switch sits at the top of the tab). Additional Income moved out to its own dedicated \'Income\' tab (with its own employee selector), so it\'s no longer mixed in with charges. The tab\'s summary cards now cover both kinds at once — separate Claims and Charges counts, pooled total amount and outstanding balance, and combined Deducting / Queued / Resolved counts. Under the hood this rides on the shared engine from v3.21, so balances, schedules, rate changes and pauses are unchanged; only where things are displayed moved.' },
        { version: 'v3.21', date: '2026-08-18', notes: 'Internal engineering release: claims and charges now run on one shared deduction engine. They remain separate records with their own IDs, their own tables, and their own statuses — but how they work (base weekly rate, dated rate changes, pause windows, the weekly schedule walk, balances as of any date, and the rate/pause history panels in the edit form) is now a single implementation configured per kind, so any future fix or feature automatically applies to both. Every original function was kept with its exact name and behavior, verified by an automated equivalence test: 6,000 randomized scenarios (every status, past/future dates, rate changes to and from zero, overlapping pauses, inactive employees, missing data) produced identical balances before and after, plus 1,491 cross-checks proving a claim and a charge given identical data now behave identically. One deliberate improvement rode along: a schedule whose rate history dead-ends at $0 no longer projects decades of phantom empty weeks on the claims side — a fix charges already had; balances are unchanged, only the phantom tail disappears from schedule views.' },
        { version: 'v3.20', date: '2026-08-18', notes: 'Brand refresh, chosen from the design options board. New sharper logo (same shield-and-gauge identity, bolder gauge and crisper edges) across the login screen, sidebar, app icons and favicon. New shorter app title: \'Tracker — Logistics · HR · Claims\' (the header shows \'[Company] — Tracker\' when signed into a specific company). Two brand-new interface themes join the existing three: Indigo, a cool violet take on the light theme, and Carbon, a neutral graphite dark theme with amber accents — pick them from the same theme circles on the login screen, the header menu, or the sidebar. The login background hero stays as-is by choice. All existing themes, data, and workflows are untouched.' },
        { version: 'v3.19', date: '2026-08-18', notes: 'File attachments arrived, plus two fixes. You can now attach photos, videos and documents to any individual claim, charge, income record, invoice, or bill — open a record and tap the new 📎 Files button. Attachments are always optional, belong to that one specific record, and any file type is accepted; each upload is automatically classified as a photo, video, or document. Photos taken on a phone are automatically shrunk (down to about a tenth of their size) before uploading to save storage, with no visible quality loss; single files are capped at 100 MB. Everyone who can see a record can view its files; only editors can add or remove them; Super Admin can do this on any company\'s records, and files are stored privately — every view link is personal, expires after 10 minutes, and is only issued after the server re-checks who you are. The fixes: an update earlier today accidentally broke the Employees screen (SSN handling) and password resets for a few hours — both were repaired server-side, tested end to end (login, reset by admin and superadmin, employee list, and 15 other functions), and no data was affected. Also note: passwords now must be at least 8 characters when set or changed; existing passwords keep working.' },
        { version: 'v3.18', date: '2026-08-18', notes: 'Visual redesign plus a changelog change. The redesign gives the app two polished looks that ride on the theme switcher you already have: the Light theme is now a clean, airy “Clean SaaS” style (cooler background, softer lines, calmer table headers instead of the heavy blue bar, rounded cards), and the two dark themes (Ocean and Emerald) became a “Midnight Pro” style — a deep, easy-on-the-eyes canvas with gently glowing teal/green accents and elevated cards. It is the same app and the same layout; only the paint changed, and every screen shifted at once because it is driven by shared color tokens. The changelog (this popup) now reads its history from the database instead of a list baked into the page, so it stays complete and identical on every device and can grow without shipping a new file each time; if the connection is unavailable it still falls back to the copy stored in the page. Tap the version number in the bottom-right corner any time to see this history.' },
        { version: 'v3.17', date: '2026-08-18', notes: 'Security hardening pass — no visible change to how the app is used, but the data behind it is now properly locked down. Two real holes were found and closed. First: the login could be bypassed. The database used to trust whatever username the page claimed, with no proof — so anyone who knew an admin username could reach admin-only data and actions from outside the app entirely, without a password. Now every sign-in issues a private session token that the page must present on every request, and the database rejects anything that does not match, so a username alone is worthless to an outsider. Second: several tables (claims, charges, income, routes, employees, daily pay, and more) could be read around or written to directly, again bypassing the login screen. All create/edit/delete now flow through checked database functions that enforce your role and company, and the wide-open direct access was removed. Also: the encryption key that protects Social Security numbers was reachable from the public side and is now sealed off; a leftover create-any-user function that needed no permission was locked; and free-text fields (names, notes, claim numbers) are now escaped everywhere they are shown, so a value typed into a form can never run as code on someone else\'s screen. A visual refresh rode along too: rounder cards with softer shadows, buttons that respond to hover and keyboard focus, cleaner tables, and a fix that makes the dark (Ocean/Emerald) themes\' tables actually readable. Sign out and back in once after this update so a fresh secure session is issued.' },
        { version: 'v3.16', date: '2026-08-17', notes: 'Found and fixed a real money-tracking bug: any claim, charge, or income item with status \'Tk from check\' was being treated as fully resolved and forced to show a $0 balance \u2014 the same shortcut used for genuinely finished statuses like Absorbed and Paid. That\'s wrong: \'Tk from check\' only means the money is collected directly from a paycheck instead of through the normal weekly deduction schedule, not that it\'s been collected yet. Confirmed against real data \u2014 an employee with five Tk-from-check claims where four had never had a single dollar deducted, correctly showing $0.00 pending in the Release Eligibility report when the real number was $730. Fixed at the source, in the four shared functions everything else calls (claimBalance, chargeBalance, remainingBalance, remainingBalanceAsOf) rather than patching each screen separately, so every place this could show up \u2014 Release Eligibility, the Claims and Charges lists, dashboard totals, sort order \u2014 is now correct at once. A database check afterward found 25 claims across the account sitting in this exact state, so real numbers should visibly change in a few places after this update, not just Release Eligibility.' },
        { version: 'v3.15', date: '2026-08-17', notes: 'Fixed content getting silently cut off on smaller/non-maximized desktop windows and laptop screens \u2014 reported as fields (like Start Date on the New Contact form) and table columns disappearing off the right edge with no way to scroll to them. Root cause: the main content area had both width:100% and a fixed margin-left:240px (for the sidebar) applied at the same time. Those two together don\'t shrink to fit each other \u2014 the box became 100% width, then got pushed an additional 240px to the right on top of that, overflowing the page by exactly the sidebar\'s width. Combined with overflow-x:hidden on the page (needed for the mobile scroll fix), that overflow wasn\'t even a scrollbar \u2014 it was just silently clipped and gone, worse the narrower the window or the higher the browser zoom. Switched to width:calc(100% - 240px) so the content area actually shrinks to fit alongside the sidebar instead of overflowing past it, on any screen size or zoom level. While investigating, also found and fixed the actual cause of a duplicate-key error when adding an employee: the next-ID generator was counting currently-loaded employees instead of finding the highest ID number actually in use, so it silently broke the first time any employee record was ever deleted, generating an ID that already existed further up the sequence. Now scans for the real highest ID instead, which is immune to gaps left by deletions.' },
        { version: 'v3.14', date: '2026-08-17', notes: 'Closed out the Android scrolling investigation from the last several versions. After all the earlier fixes still didn\'t resolve it, removed the custom pull-to-refresh entirely as a decisive step \u2014 it was the only non-standard, global touch-handling code left on the page, and normal native scrolling should never need anything sitting on top of it. That fixed scrolling everywhere it was tested. Rebuilt the PWA install/offline layer from scratch afterward (manifest.json and sw.js), and added a proper cross-platform install experience: a real \'Install\' button and native prompt on Chrome/Edge (desktop and Android), clear manual \'Add to Home Screen\' instructions on iOS Safari (which has no install-prompt API for a site to hook into at all), and an automatic one-time reload when a future update\'s service worker takes over so an open tab never keeps running stale cached code. Pull-to-refresh was then re-added, but scoped so it only ever runs in standalone/installed mode \u2014 a normal browser tab already has its own native swipe-down-to-refresh built into the browser itself, and custom code layered on top of that native gesture is exactly what broke scrolling in the first place. In a regular browser tab (where all the reported scrolling problems happened), none of this custom touch code attaches at all anymore.' },
        { version: 'v3.13', date: '2026-08-15', notes: 'The \'even in desktop-site mode\' detail was the key piece \u2014 that mode uses a completely different layout path than the mobile menu, so if scrolling failed there too, the real cause couldn\'t be anything specific to the mobile drawer (already fixed last round, but clearly not the whole story). It had to be something applying everywhere, regardless of screen size. Found it: touch-action: manipulation was applied to literally every single element on the page, all the way down to scroll containers and tables, not just the buttons it was originally meant for. Desktop-site mode leans heavily on pinch-zoom-and-pan to navigate a page wider than the screen, and that\'s exactly the kind of gesture this setting can interfere with when it\'s spread that broadly. Scoped it down to only actual buttons and links, where it genuinely helps, and left every scrollable area alone. Also made the on-phone debug console easier to trigger \u2014 tapping the small version number bottom-right 5 times now turns it on too, no URL typing required, since that can be its own hassle on a phone. If this round doesn\'t fully fix it, that\'s the fastest way to get real error output next.' },
        { version: 'v3.12', date: '2026-08-15', notes: 'Found the real bug, and it explains everything reported: the pull-to-refresh feature listens for touch gestures across the whole page, but never learned that the sidebar (and a couple of other spots) scroll independently of the main page \u2014 so every scroll gesture inside the sidebar looked identical to \'at the top of the page, about to pull down and refresh\' from its point of view, since the page itself genuinely was at the very top the whole time. That\'s exactly the \'scrolling works but also tries to trigger refresh\' behavior described \u2014 and very likely the reason navigation stopped working too, since the refresh indicator (pinned across the top of the screen) could then end up sitting directly on top of whatever menu item was being tapped. Fixed properly: pull-to-refresh now checks whether a touch started inside its own independently-scrollable area (the sidebar, message threads, or anywhere else with its own scroll now or in the future) and steps aside entirely for those, letting them scroll normally on their own. Also made the refresh indicator itself unable to intercept taps no matter what, as a second layer of protection. No console errors ever should have shown up for this one \u2014 it was a gesture-handling gap, not a crash \u2014 which matches exactly what was reported back from the debug console.' },
        { version: 'v3.11', date: '2026-08-15', notes: 'Added a temporary on-phone debug console for tracking down the reported navigation/scrolling issue. Chrome on Android has no built-in way to see JavaScript errors directly on the phone itself \u2014 the normal method needs a computer connected by USB. Visiting the site with ?debug=1 added to the end of the URL (e.g. aortiza.netlify.app/?debug=1) now shows a small floating button that opens a full console right on the phone screen, with all errors and messages visible directly \u2014 no computer needed. Completely inert for everyone else; nothing changes without that exact URL parameter. This is meant to be temporary, just to see the real error text so the actual problem can be fixed precisely instead of guessed at.' },
        { version: 'v3.10', date: '2026-08-15', notes: 'Rebuilt the PWA (installable app) setup from scratch after reports it wasn\'t working at all on Android, browser or shortcut. Found the likely real cause: the install manifest was embedded directly in the page as a data URI instead of being served as an actual file \u2014 that\'s an unusual pattern Android\'s app-install process (WebAPK generation) doesn\'t reliably support, even though it looked fine everywhere else. Moved it to a real manifest.json file with real separate icon image files, both delivered alongside index.html and sw.js \u2014 the standard approach every PWA guide recommends, and the one actually built to be checked by Android\'s installer. Also rewrote sw.js in the same pass: the old version had accumulated three rounds of increasingly complex fixes trying to be clever about cache-busting, and each fix risked reintroducing the last bug \u2014 replaced all of that with the simplest version that still does the job (cache the app shell once at install, network-first with that as a fallback only if the network genuinely fails), since this app depends on a live connection either way and there was never much value in aggressive offline caching to begin with. Also stopped silently swallowing service worker registration errors, so if anything about this ever breaks again it\'ll actually show up somewhere instead of failing invisibly like before. Two new files this time \u2014 manifest.json and three icon PNGs \u2014 all need to go in the same folder as index.html and sw.js.' },
        { version: 'v3.09', date: '2026-08-15', notes: 'Three things. First, a proper thin dark scrollbar for the sidebar on desktop instead of the chunky default browser one (mobile already looked right and is untouched). Second, tightened sidebar spacing a bit more. Third, and the real work this time: fixed Daily Pay import against an actual real nomina file. Two genuine structural mismatches were found by examining the real file directly rather than guessing: the day columns were being read one column too early (missing a flat day-rate column real sheets carry before the seven actual weekdays), and a real week sheet isn\'t one flat list \u2014 it\'s several sections (hourly employees, then trucking companies/owner-operators) each starting with its own repeated mini header, which the importer used to treat as the end of all data. Fixed both, and added a week picker for files that bundle many weeks in one workbook (common for a running yearly file) rather than guessing which tab to use. A $0 week is now correctly treated as a normal entry, not a stop signal, since the same person can easily have hours in one week and none in another. Verified this thoroughly before writing any code: extracted and matched every single name against the real employee list across three different real weeks from the uploaded file (89, 98, and 99 entries) \u2014 100% matched cleanly in all three, confirming the matching logic itself was always fine and only the column/section reading was ever broken. The existing unmatched-name correction report (a downloadable spreadsheet to fix names or add missing employees) is untouched and still triggers exactly the same way for any future week that does have a genuine mismatch.' },
        { version: 'v3.08', date: '2026-08-14', notes: 'Two real pieces of work. First, sidebar cleanup: reduced spacing throughout for a more compact feel, and fixed how Notifications and Messages are positioned \u2014 they were only \'pinned\' via a CSS trick that still let them drift up and down as different menu groups expanded above them. Restructured into a genuinely separate scrollable area (the expandable groups) and a fixed area (Notifications, Messages, account actions) that never moves regardless of what\'s expanded above it. Second, and this was the bigger one: revised how a claim or charge moves through the release stages when a single check can\'t cover it. Last Paycheck is never the final chance \u2014 an Inactive employee\'s Week in Deposit release, if they have one, is always still coming \u2014 so it no longer declares anything a final loss; whatever it can\'t cover just stays exactly as it was, ready for that next stage. Only Week in Deposit (the genuinely last possible stage) finalizes anything now. Once something IS finalized (status Absorbed), that\'s permanent \u2014 it never gets reconsidered by a later release again. Found and fixed two real bugs while building this: a database sequencing issue that would have silently erased an earlier partial credit when a claim finally got finalized in a later stage (caught by hand-tracing the exact numbers before it ever touched the database), and a gap where only the specific credited item was being protected from finalizing during a Last Paycheck release \u2014 every OTHER uncovered item was still being wrongly finalized alongside it. Verified the complete two-stage flow end to end against disposable test data: a $750 check against a $2,769.78 claim correctly stays open and carries $2,019.78 forward, and a subsequent $500 Week in Deposit release correctly finalizes it at exactly the full original amount \u2014 not a cent more or less.' },
        { version: 'v3.07', date: '2026-08-14', notes: 'Found the real cause of Release Paycheck going unresponsive: Release Last Paycheck never got the same smart starting checklist that Week in Deposit release already has \u2014 every claim/charge always opened fully unchecked, leaving no sensible default and no obvious way to reach a valid combination by hand. That\'s almost certainly how Francis Fernandez\'s screen ended up with both claims checked at once (over $2,769 selected against a $750 paycheck) \u2014 the button wasn\'t broken, it was correctly disabled because that combination genuinely doesn\'t fit, it just never offered a starting point that did. Fixed by sharing the same starting-checklist logic Week in Deposit already uses: now Release Last Paycheck opens with a sensible default too (whatever fits within the paycheck gets pre-checked, smallest first), recalculated once more the moment the real paycheck amount finishes auto-filling. Verified the exact Francis Fernandez numbers in Node: both claims correctly start unchecked (neither fits alone), the button is enabled, and the statement is immediately ready to review and confirm without any manual checkbox fiddling.' },
        { version: 'v3.06', date: '2026-08-14', notes: 'Two things. First, verified Joel Acosta\'s \'Saved so far\' with the actual saved data and current code: it correctly computes to $100, not $1,020 \u2014 that specific bug was already fixed by an earlier update. Second, and this one was real: on the release screen, when the available money couldn\'t fully cover an outstanding claim or charge, the leftover amount wasn\'t clearly shown as being credited against it before the remainder got declared a loss \u2014 worked out to the same final numbers either way, but looked like the partial amount just vanished instead of being applied. Now it\'s explicit: for example, a $750 last check against a $2,769.78 claim clearly shows \'$750 applied first\' with \'$2,019.78 remaining will be declared a loss\' right on the statement before you confirm anything, exactly matching how the last-paycheck stage and the Week in Deposit stage are each supposed to work in sequence. Also removed the leftover \'(as of DATE)\' labels on a few Statement balance fields \u2014 the week you\'re viewing was already fully driven by the Prev/Next/This-week navigation (fixed properly back in v2.44), the label text just hadn\'t caught up. Verified the exact Francis Fernandez numbers in Node before shipping, confirmed the Active-employee early-release case (where a partial payment correctly stays open on its normal schedule) still works exactly as before.' },
        { version: 'v3.05', date: '2026-08-14', notes: 'Found the real reason Carlos Amador and Joel Acosta kept showing as needing a Last Paycheck release even after being released: a database function (get_employee_details) had a hardcoded list of fields that was never updated when Last Date Worked, Inactive Since, and the two Last Paycheck release fields were added over the last several versions \u2014 the data was always being saved correctly, the app just never actually received it back. This silently affected the whole eligibility system since it first shipped, not just this one report. Fixed. New Release History tab (HR & Payroll) \u2014 a permanent, searchable record of every release, Week in Deposit or Last Paycheck: original amount (broken out into base pay vs. additional income for Last Paycheck releases specifically), what got deducted toward other claims/charges, and the final amount that actually reached the employee, plus who released it and whether it was early. New \'\u23F0 Early Release\' button alongside the normal Release button, in both Week in Deposit and the Savings & Release Eligibility report \u2014 requires an explicit extra confirmation since it bypasses the normal 90/30-day wait on purpose. Medium accounts can now use both the normal and early Release actions, but neither executes immediately for them \u2014 both get sent to a new Pending Release Requests panel in Approvals, where an Administrator reviews the exact same settle/absorb/prepay plan the Medium user built and either approves it (which runs the real release immediately) or rejects it (nothing happens). An Administrator\'s own releases still execute directly as before, no approval needed. Every piece of this \u2014 the request/approve/reject flow, both release types, the income breakdown, direct-vs-approved tracking \u2014 was tested end-to-end against disposable test companies, including the specific numbers matching exactly, before any of it touched real data.' },
        { version: 'v3.04', date: '2026-08-14', notes: 'Fixed a real \'\$0 saved\' bug in the database (Joel Acosta and 5 others): each had genuine deposit history recorded week by week, but was stuck on a \'Queued\' status, which makes the app treat them as if nothing had started yet — corrected all 6 to \'Deducting\' to match their real history, logged in the audit trail. Second, bigger fix: an Inactive employee\'s claims and charges were still projecting deductions forever into the future, as if they were still earning a paycheck to deduct from \u2014 there isn\'t one. Every weekly schedule (Claims, Charges, Semana de Fondo, Statement, Payroll, everywhere) now stops projecting further deductions past an Inactive employee\'s actual last working day \u2014 real past history is completely untouched, this only stops inventing future weeks that were never going to happen. Verified directly against a real, currently-affected charge before shipping. Safe for the 46 already-Inactive employees predating this feature (no last-worked-date on file for most of them yet, so nothing changes for them until that gets filled in) and confirmed working correctly for the few that do have it.' },
        { version: 'v3.03', date: '2026-08-14', notes: 'Two fixes. The checkbox on the release screen was rendering as a huge, misaligned square instead of a normal small checkbox \u2014 root cause was the app\'s shared base styling for text fields (input/select/textarea) never excluded checkboxes, so it inherited full-width and a 44px minimum height meant for things like text and date fields. Added a proper override so any checkbox (this one, and any future ones) renders at a normal size and lines up with its label. Second: Release Last Paycheck now auto-fills the paycheck amount instead of starting blank \u2014 it adds up that employee\'s Daily Pay entries plus any Additional Income for the Sun\u2013Sat week containing their last worked day (not a full payroll recompute \u2014 claim/charge deductions are deliberately left out, since the release screen\'s own settle/prepay/absorb logic already handles those separately). The field stays fully editable so it can still be corrected against Statement/Payroll if something looks off, and if there\'s no Daily Pay history to derive a week from at all, it just asks for the amount by hand like before. Verified the week math and the income-eligibility filtering in Node before shipping.' },
        { version: 'v3.02', date: '2026-08-14', notes: 'Fixed a real gap in last update\'s prepayment logic, caught before it ever hit a real release: the \'leftover becomes a prepayment, the item stays open on its normal weekly schedule\' behavior only makes sense for an employee who\'s still actively earning a paycheck to deduct from \u2014 it was wrongly applying to Inactive (quit/fired) employees too, where there\'s no more weekly income to ever actually continue collecting from. Now: for an Inactive employee (or the Last Paycheck release, which by definition only ever applies to someone who\'s already gone), anything not fully covered goes straight to a declared loss instead \u2014 no dangling half-open balance waiting on a paycheck that will never come. The prepay-then-continue behavior still applies correctly when releasing Week in Deposit early for a still-Active employee, since there\'s a real next paycheck for that case. Also closed a second, related leak while fixing this: previously, whenever a release couldn\'t cover everything but the leftover fragment didn\'t qualify for a prepayment, that fragment was quietly still counted as \'net release to the employee\' \u2014 now nothing ever reaches the employee while any claim or charge remains outstanding, full stop, regardless of why. Verified all four cases in Node (Active gets a prepayment, Inactive goes straight to loss, Last Paycheck always goes straight to loss, and a genuine surplus with nothing outstanding still releases correctly) before re-confirming the database side against a throwaway company.' },
        { version: 'v3.01', date: '2026-08-14', notes: 'Two more pieces of the release rules. First: when the last-paycheck (30-day) check doesn\'t fully cover what an employee owes, whatever\'s left over after fully settling what it CAN cover no longer gets released to the employee \u2014 it\'s now held back and applied as a partial prepayment toward the next outstanding claim or charge instead. That item stays open (not Paid, not Absorbed) with a smaller balance, and its normal weekly deduction schedule just continues from there automatically \u2014 no new mechanism needed for that part, it\'s exactly how weekly deductions already work. The release statement shows this prepayment as its own line so it\'s visible before confirming, not something that just quietly happens. Money only ever reaches the employee once every single outstanding claim or charge is genuinely covered with nothing left pending. Same logic applies to a Week in Deposit release, not just the 30-day check. Second: a standing reminder now appears on Home starting Wednesday each week (through Saturday) whenever an Inactive employee\'s last paycheck is eligible for release but nobody\'s made a decision on it yet \u2014 deliberately has no dismiss button, since it\'s meant to keep showing until someone actually acts on it via the Savings & Release Eligibility report, not just gets clicked away. (The Release button in Week in Deposit was already correctly hidden from View Only accounts \u2014 checked and confirmed, no change needed there.) Tested the prepayment math end to end against a throwaway company: a $350 charge correctly dropped to $250 and stayed in its normal Deducting status with its weekly rate untouched, ready to keep collecting on its own.' },
        { version: 'v3.00', date: '2026-08-14', notes: 'New no-show flag on Employees: any Active Daily Pay employee whose most recent worked day falls before Thursday of the last fully-completed week (i.e. they had no work logged Thursday, Friday, or Saturday of that week \u2014 3 days in a row) now shows a warning banner at the top of Employees listing them by name, with a one-click \'Mark Inactive\' that ties straight into last week\'s release rules: it locks in today as their departure date and immediately starts the clock on holding their Week in Deposit savings (90 days) and last paycheck (30 days), exactly like manually flipping their status already did. A \'Dismiss\' option is also there for a quick false alarm, though it only lasts the session \u2014 the flag comes back next login if nothing\'s actually changed. Scoped to Daily Pay employees only (Weekly and Provider Pay don\'t log daily attendance the same way, so the check wouldn\'t mean anything for them), and never shown to View Only accounts. Verified the boundary case specifically in Node before shipping \u2014 someone who worked exactly on that cutoff Thursday correctly does NOT get flagged, only someone whose last day was before it.' },
        { version: 'v2.99', date: '2026-08-13', notes: 'Big one: release-eligibility rules and a new report to go with them. Employees now have a Last Date Worked field (pull it straight from Daily Pay with one click, or type it in) alongside the existing Start Date. Flipping an employee to Inactive for the first time locks in today as their departure date and auto-fills Last Date Worked from Daily Pay if it wasn\'t already set \u2014 flipping status back and forth later never resets that clock once it\'s started. Two release rules now run off that date: Week in Deposit savings can\'t be released earlier than 90 days after it, and an Inactive employee\'s held last paycheck can\'t be released earlier than 30 days after it \u2014 both enforced as a hard block on the release buttons themselves, not just a note in a report. New HR & Payroll \u2192 Savings & Release Eligibility report shows everyone with open savings or an unreleased last paycheck, what they still owe elsewhere, and the earliest date for each \u2014 including the actual Thursday it\'d be issued and Saturday it\'d be handed over. The release screen itself got real upgrades: every claim or charge listed is now clickable to go review it first; \'pending\' now means any claim or charge regardless of status with either a real balance or a leftover absorbed amount (broadened from just Tk-from-check); when there isn\'t enough to cover everything, checkboxes default to settling as many items as possible at 100% (smallest first) but you can freely change the selection; anything left uncovered gets marked Absorbed instead of just left dangling \u2014 and critically, that absorbed amount is now remembered accurately so a later release (say, Week in Deposit, after an earlier last-paycheck release couldn\'t cover everything) gets a real chance to collect it, exactly as asked. The last paycheck\'s dollar amount is entered by hand in the release screen rather than auto-calculated \u2014 reconstructing an accurate historical week\'s net pay safely wasn\'t something to guess at for a real money release, so it reads off whatever Statement/Payroll already shows for that week. Found and fixed a real piece of technical debt while extending this: an old, superseded version of the release function was still sitting live as a second overload of the same name \u2014 dropped it explicitly rather than just replacing the new one, since Postgres treats different-signature functions as entirely separate until told otherwise. Every new database function was tested end to end against a disposable company \u2014 settle/absorb combinations, double-release blocking, an already-absorbed item correctly getting picked back up by a later release, wrong-role rejection \u2014 before any of it touched real data.' },
        { version: 'v2.98', date: '2026-08-13', notes: 'New \'\U0001F513 Release\' button on each Semana de Fondo record in Week in Deposit, for when the savings are actually handed over as a check and the account needs to close. Clicking it opens a statement, not an immediate action: it checks whether that employee has any OTHER outstanding claim or charge (anything besides another Semana de Fondo record), and if so, shows exactly how much of the savings would go toward settling those first \u2014 oldest debt first \u2014 before showing the real net amount left to hand over. Only pressing \'Close Account\' on that statement actually does anything. Settling another claim/charge this way actually reduces what it shows as owed everywhere else in the app (Payroll included), not just a note saying it happened. A released account is fully excluded from every balance calculation in the app going forward (Payroll deductions, Home dashboard, Week in Deposit totals) while still correctly showing its real historical numbers if you look back at a past week from before it was released. Tested the whole flow \u2014 savings with two different outstanding debts, oldest-first settling, double-release blocked, wrong-role blocked \u2014 against a throwaway company before this ever touched real data.' },
        { version: 'v2.97', date: '2026-08-13', notes: 'Four fixes. Income and Route Tracker were the only two places still using the old popup-based edit flow (a sequence of \'leave unchanged / press Cancel to stop\' prompts) \u2014 both now repopulate the form at the top and switch to an Editing mode with Save/Cancel, exactly like Claims and Charges already work; checked and confirmed nothing else in the app still uses the old popup style. Claims, Charges, and Income were all silently dropping their Notes field from the expandable detail card \u2014 fixed on all three, and traced further into Payroll: its per-employee breakdown wasn\'t even fetching notes onto the claim/charge/income line items it builds, so there was nothing to show even before the display gap \u2014 fixed both the data and the display, notes now appear under the relevant line in a payslip breakdown too. Bills Payable\'s Vendor field now suggests names from the Provider Pay roster as you type (a normal autocomplete, not a hard requirement) \u2014 pick a provider already in the system, or type any external vendor name freely, same field either way.' },
        { version: 'v2.96', date: '2026-08-13', notes: 'Two things. First, a real bug: hovering felt like the cause but it wasn\'t \u2014 the whole sidebar area for an open group (Notifications, Messages, or whichever section was expanded) was rendering with a solid white background at rest, making pale sidebar text unreadable against it. Root cause was a shared CSS class carrying over a background meant for a completely different, light-background part of the app; fixed by resetting it back to transparent for the sidebar specifically. Second: a new Financial section \u2014 \'\U0001F4B0 Financial\' now sits in the sidebar with two tabs. Invoices lets you build a real itemized invoice (date, description, rate, qty, extra, amount per line, auto-totaling as you go) for a customer, matching how your actual invoice templates are laid out; Bills Payable is a lighter-weight running list of what you owe vendors (amount, due date, paid/unpaid). Both are hidden from View Only accounts, same reasoning as Fleet. Caught a real numbering bug before shipping this: the same ID-numbering approach from v2.91\'s Semana de Fondo fix (used again here for invoice/bill numbers) breaks specifically for an ID prefix that starts with a digit \u2014 which \'3OFL\' does \u2014 silently grabbing the wrong number and risking a duplicate ID. Found it by actually running the numbering logic in Node before shipping, not just reading the code; confirmed it hadn\'t caused real damage yet (the only place it was already live, the Week in Deposit import, hasn\'t been re-run since v2.91), and fixed the shared root cause everywhere it\'s used.' },
        { version: 'v2.95', date: '2026-08-13', notes: 'New Home dashboard. A \'\U0001F3E0 Home\' button now sits at the very top of the sidebar, above Logistics, and is where you land right after logging in (View Only still lands on their own Employees record as before \u2014 Home shows company-wide numbers that don\'t fit their \'your own records only\' access level, so it\'s hidden for them same as Fleet/Settings already are). The page itself shows 8 stat cards \u2014 Active Employees, Open Claims, Active Charges, Semana de Fondo progress, Income This Week, Fleet, Expiring Soon, and Unread Notifications \u2014 each tappable to jump straight to that section. Built entirely from data the app already has loaded for other tabs, so there\'s no extra loading time and the numbers are always in sync. Caught and fixed a real bug before shipping: Home isn\'t part of the existing Logistics/HR/Expiring/Administration group system, and an existing piece of sidebar logic didn\'t know that \u2014 it would\'ve stripped Home\'s highlight the instant you logged in and incorrectly lit up Logistics instead, even with Home\'s content the one actually on screen. Verified every number on the dashboard (open balances, this week\'s income window, savings-goal totals) by actually running the calculations with realistic fake data before shipping, not just checking the code reads correctly.' },
        { version: 'v2.94', date: '2026-08-13', notes: 'Three fixes/additions. (1) Deleting a charge, claim, or additional income record was leaving its \'New Charge/Claim/Income\' notification behind forever, pointing at a record that no longer existed \u2014 a real gap that\'s existed since Notifications shipped, not something new. Cleaned up 57 orphaned notifications left over from the Semana de Fondo import cleanup, and fixed delete_charge/delete_claim/delete_income to remove the matching notification going forward. (2) The Week in Deposit bulk import wrote straight to the charges/charge_rate_changes tables from the browser, which meant it left zero trace in the audit log \u2014 only a real server-side function logs to it in this app. Built a proper database function for this import (role-checked, same replace-on-rerun behavior as before, now with one real audit log entry per run) and switched the import to use it. (3) New Schedule Maintenance panel on the Fleet tab: pick a truck, a date, and a description to schedule upcoming maintenance, and an Upcoming Maintenance list right above the truck list shows everything scheduled across every truck, soonest first \u2014 tap one to jump straight to that truck\'s card. Reuses the Service Log\'s existing \'Scheduled\' vs \'Performed\' distinction that was already there per-truck, just no dedicated form or combined view existed for it before. To mark one done, delete the scheduled entry and log it as Performed on that truck\'s own Service Log once the work is actually finished.' },
        { version: 'v2.93', date: '2026-08-13', notes: 'Fixed the mobile/PWA navigation drawer closing itself the instant you tapped Logistics, HR & Payroll, Expiring Documents, or Administration, before you could pick a sub-option. Root cause: tapping a group header was designed to both reveal its sub-tab list AND immediately jump into that group\'s first tab as a sensible default \u2014 fine on desktop, where the sidebar is always open anyway, but that automatic jump is what closes the drawer (opening any tab always closes it), so on mobile it closed before you ever saw the other options. Now the drawer version of a group tap only expands the list; picking an actual sub-tab is what navigates and closes the drawer, same as it always was. Desktop is untouched \u2014 still jumps straight to a group\'s first tab when you click its header.' },
        { version: 'v2.92', date: '2026-08-13', notes: 'Fixed a bug I introduced in v2.90\'s sw.js fix: forcing a real network fetch by calling fetch(req, {cache:\'reload\'}) on the original navigation Request crashes outright on some Android WebView/Chrome builds (a spec restriction on re-fetching a \'navigate\'-mode request with overridden options), and that crash happened before the fallback code ever got a chance to run \u2014 so every page load through an already-installed app icon failed with a bare network error, and since nothing rendered there was nothing to scroll either (matches \'shows an error, can pull down to refresh but can\'t scroll\'). A brand-new browser tab was never affected, since a first-ever visit\'s first load doesn\'t go through the service worker at all. Switched to fetching a cache-busted plain URL instead of re-fetching the Request object, which achieves the same real-network guarantee without tripping that restriction. Bumped the internal cache name again so already-installed apps get a clean slate. Both index.html and sw.js need to be uploaded together again.' },
        { version: 'v2.91', date: '2026-08-13', notes: 'Made the Semana de Fondo import safe to re-run instead of a one-shot operation. Re-uploading the same or an updated file now deletes and rebuilds any charge it previously created (matched by its own \'Imported from Week in Deposit spreadsheet\' note) with fresh numbers, instead of silently skipping it forever \u2014 a hand-entered Semana de Fondo charge for someone is still always left alone. Also fixed how new charge numbers get assigned: it now always picks one past the highest charge number that currently exists anywhere in the table, instead of just counting how many charges are loaded \u2014 so deleting a charge from the middle of the sequence (for any charge type, not just this one) can never cause a future import to reuse a number that\'s already taken. Investigated the \'Saved so far\' totals looking wrong after yesterday\'s import: root cause wasn\'t the import or the balance math \u2014 9 of the newly-created charges had been manually switched from Deducting to Queued afterward, and Queued charges count as $0 saved by design everywhere else in the app (nothing was owed yet). Cleaned up yesterday\'s import in the database directly (56 charges and their 334 rate-change rows, restored to exactly the pre-import count) so it can be re-run cleanly with this fixed code.' },
        { version: 'v2.90', date: '2026-08-13', notes: 'Fixed the installed Android/iOS app icon serving a stale, out-of-date copy of the app (confirmed: worked fine in every regular browser tab, only the installed icon was affected). Root cause was in sw.js, the separate file that makes the installed icon work: it fetched the app shell with the browser\'s default HTTP caching still in play, so \'network-first\' wasn\'t actually a hard guarantee — the browser could quietly hand back an old cached copy of index.html before the service worker\'s own logic ever got a say. Fixed by forcing a true bypass of the browser\'s HTTP cache on every shell fetch, and bumped the internal cache name so this device\'s existing installed copy gets a clean slate rather than carrying old cached files forward. This requires uploading BOTH files — index.html and the updated sw.js — to the same GitHub folder; index.html itself didn\'t need any changes to fix this, only sw.js did. After uploading, fully close the installed app (swipe it away, not just background it) and reopen it once to pick up the fix.' },
        { version: 'v2.89', date: '2026-08-12', notes: 'Two fixes. The Messages typing box no longer gets squeezed when you pick "Claim", "Charge", or "Income" (which shows a second "Which one?" dropdown) — the category pickers now sit on their own row above the typing box, so the typing box always keeps its full width. Also added a new "⬆️ Import Semana de Fondo" button on Charges & Income: upload the weekly deposit tracking spreadsheet (employee names in column A, one dated column per week, goal amount in the "cantidad final" column) and it creates a real "Semana de Fondo" charge for every employee who doesn\'t already have one, reproducing their exact week-by-week saved amounts — once an employee\'s goal is reached, no further weeks are shown, matching the existing charge balance engine\'s own behavior rather than needing a separate rule for it. Employees who already have a Semana de Fondo charge, or who can\'t be matched to a name in the roster, are skipped and reported at the end. Caught and fixed a real bug while testing this against your actual file before shipping: charges whose goal wasn\'t fully reached in the data were computing an "Ends" date decades in the future (an existing bug in how the app decided whether a charge\'s deduction schedule was still "live" going forward) — fixed so it correctly stops projecting once it runs past what the file actually records. Also: a couple of employees had a one-week negative amount in the source file (a correction/withdrawal); since a weekly amount can\'t go negative anywhere else in this app, those are treated as $0 for that week and flagged by name in the import summary so you can double-check them.' },
        { version: 'v2.88', date: '2026-08-06', notes: 'Fixed both issues. Notifications and Messages were being closed automatically the instant any other section in the sidebar was opened, which is why they never actually stayed visible — now they\'re correctly excluded from that behavior and stay put. Also strengthened the sidebar\'s hover styling everywhere (including one spot — the section headers like Logistics/HR & Payroll — that had no hover styling defined at all, which could plausibly explain the white-on-white you saw) so text is guaranteed readable on hover no matter what.' },
        { version: 'v2.87', date: '2026-08-06', notes: 'Last piece from the big batch — Summary Reports. Payroll, Claims, Charges, Additional Income, and Week in Deposit each now have their own "📊 Summary Report" buttons, in Excel and PDF. These are real reports, not raw data — totals, breakdowns by status and type, generated fresh each time — not individualized by employee, exactly as asked. One note on the PDF side: it uses the same print system as everything else in the app (so the standalone-app printing limitation on iPhone/iPad applies here too, with the same clear heads-up if it comes up) — "download as PDF" happens by choosing Save as PDF from the print screen, same as printing a payslip.' },
        { version: 'v2.86', date: '2026-08-06', notes: 'Third batch. Fleet service records can now track mileage — how many miles were on it when the service was done, and the mileage the next one is due at. Shows right in the service log for each vehicle. Last piece left: summary reports for Payroll, Claims, Charges, Income, and Week in Deposit, downloadable in Excel and PDF.' },
        { version: 'v2.85', date: '2026-08-06', notes: 'Second batch. Claims\' table now shows the same columns as Charges — Employee ID, Weekly rate, Weeks, Start, and Ends alongside what was already there, so both read the same way. "Paid So Far" and "Balance" now line up on the left instead of the right in every detail view, matching their neighboring fields. Still ahead: summary reports for Payroll/Claims/Charges/Income/Week in Deposit, and new mileage fields for Fleet service records.' },
        { version: 'v2.84', date: '2026-08-06', notes: 'First batch from a large request — more coming right after this. Fixed a real bug: the "printing doesn\'t work" warning was showing up on desktop too, not just iPhone/iPad — turns out the check I used also matched Windows/Mac apps installed from the browser, which don\'t actually have that problem, only iOS Safari does. Narrowed it down so desktop prints normally again. Auto sign-out is now 10 minutes instead of 5. Notifications and Messages have moved out of HR & Payroll and now sit on their own, right above the theme circles at the bottom of the sidebar. Still ahead: summary reports for Payroll/Claims/Charges/Income/Week in Deposit, left-aligning "Paid So Far"/"Balance" everywhere, matching Claims\' table style to Charges, and new mileage fields for Fleet service records.' },
        { version: 'v2.83', date: '2026-08-06', notes: 'Charges and Additional Income are now expandable/collapsible on desktop too, same as Claims already was — click any row to see its full details, including the progress bar. And Statement now shows that same progress bar for every individual claim, charge, and income entry when you expand it, not just in their own tabs.' },
        { version: 'v2.82', date: '2026-08-06', notes: 'Claims, Charges, and Additional Income now show the same progress bar as Week in Deposit when you expand one — a quick visual for how much of the total has been paid off so far, right above the details.' },
        { version: 'v2.81', date: '2026-08-06', notes: 'Charges & Income now get the same status-by-status grouping as Claims, Statement, and Week in Deposit — organized by what\'s currently Deducting, Queued, Paid, and so on, each group foldable by tapping its header. This closes out the grouping work across every relevant tab.' },
        { version: 'v2.80', date: '2026-08-06', notes: 'Looked into the printing-from-the-installed-app issue directly — this turns out to be a genuine, long-standing Safari limitation on iPhone/iPad that goes back many years and has never been fixed by Apple, not something wrong in Tracker. Printing from an app added to the home screen just doesn\'t work reliably on iOS, full stop. Rather than leave the button silently doing nothing, every print button now checks for this and tells you plainly: open the same page in Safari instead of the home screen icon, and print from there — that always works, since your browser screenshot showed printing working perfectly (all 67 pages, one per person) from Safari itself.' },
        { version: 'v2.79', date: '2026-08-06', notes: 'Fixed why the mobile drawer wasn\'t showing up at all — the ☰ button that opens it had two style rules fighting each other, and the wrong one was winning every time regardless of screen size, so it never appeared no matter what device you were on. Should actually show up now.' },
        { version: 'v2.78', date: '2026-08-06', notes: 'Mobile navigation is now the drawer style from the samples — tap the ☰ icon top-left to slide in the same menu your desktop sidebar already has (same sections, same icons, same order), tap anywhere outside it or pick a destination to close it. Desktop is completely unchanged. Also: every place with grouped statuses (Claims, Statement, Week in Deposit) can now be collapsed and expanded per group, not just viewed — tap a status header to fold it away. One honest note on scope: this covers the navigation itself, not the denser card styling or new Home screen shown as illustration in the sample images — those are still ahead if you\'d like them built too. Charges and Additional Income are also still pending their status-grouping.' },
        { version: 'v2.77', date: '2026-08-06', notes: 'Payroll\'s "Print All" is simplified to just that name, and fixed to match what you asked: each person now prints on their own page, formatted exactly like printing that one person by hand — their own header, their own week line — instead of one combined summary page. Also added a small fix across every print button in the app for a phone-specific issue where the print preview could come up blank — should now consistently show the content every time. Claims is now grouped by status (Deducting together, Paid together, and so on), same treatment Statement and Week in Deposit already got. Charges and Additional Income are still ahead of us for that same grouping — continuing next.' },
        { version: 'v2.76', date: '2026-08-06', notes: 'Two pieces done, more coming. Week in Deposit now defaults to showing every status and groups results by status (Deducting together, Paid together, etc.) so it\'s easy to see what\'s actively being saved vs. already reached its goal. Expiring Documents is fully reworked — a truck or employee with more than one thing coming up (like registration AND insurance) now shows once, not twice, expanding to show everything for that truck/employee together, with the most urgent one setting the red/amber warning you see at a glance. Tap it to jump straight to editing that record. Still ahead: this same status-grouping treatment for Claims, Charges, and Additional Income.' },
        { version: 'v2.75', date: '2026-08-06', notes: 'Fixed the error that broke the whole app in the last update — a real mistake on my end while cleaning up Week in Deposit, a leftover reference to something I\'d removed. Confirmed this time by actually running the exact code with real data before shipping, not just checking it looks right. Also fixed the ⋮ menu on phones opening in the wrong spot and getting cut off along the edge — it now opens directly under the button itself and stays fully on screen, calculated from the button\'s real position instead of a fixed guess.' },
        { version: 'v2.74', date: '2026-08-06', notes: 'Fixed a real problem with Week in Deposit before it caused any confusion: it was built looking for a charge type that didn\'t match your real data, so it would have shown up completely empty despite your 9 existing "Semana de Fondo" entries being right there. Fixed to read the correct existing category, and it also no longer offers to create new ones — it\'s a dedicated savings-style view of what you already record on Charges & Income, not a separate place to add them. You can still edit or remove an existing entry directly from this tab; new ones get added the normal way, tagged "Semana de Fondo" like always.' },
        { version: 'v2.73', date: '2026-08-06', notes: 'Finished the sidebar/theme rework and shipped two new things. Change Password, Sign Out, and the theme picker are now three individual, always-visible items at the bottom of the sidebar on desktop — no menu to open first — while phone stays exactly as it was, up top. Statement now shows View Only accounts their own information immediately, no more picking themselves from a list with only one name in it. Fleet search now also matches by Vehicle ID, not just truck #/plate/VIN. And there\'s a brand new "Week in Deposit" tab for tracking savings-style deposits — set a goal and a weekly amount, and it shows exactly how much has been saved and how much is left, week by week, with its own icon in the sidebar.' },
        { version: 'v2.72', date: '2026-08-06', notes: 'Two small fixes. Expiring Documents now has its icon in the sidebar, matching every other section. And on desktop, Change Password / Sign Out now anchor to the bottom of the left sidebar instead of sitting up in the header — a cleaner, more standard spot for account actions. Phone and tablet are untouched — they stay right where they were, up top.' },
        { version: 'v2.71', date: '2026-08-06', notes: 'Expiring Documents is now its own section in the sidebar, no longer tucked under Administration — and View Only accounts can now see it too, with the same "your own information only" rule already used everywhere else in the app: they\'ll only ever see their own driver license, work permit, and medical card expirations, never anyone else\'s, and never fleet items, since a truck isn\'t personal to any one person the way those documents are.' },
        { version: 'v2.70', date: '2026-08-06', notes: 'Went back and fixed the messaging refresh properly this time. The last fix only softened what got rebuilt every few seconds — this one stops it from touching anything on screen at all unless a message actually came in. So now, if nothing new has happened, the background check runs quietly and nothing visibly moves, resets, or interrupts you — not the dropdowns, not your typing, nothing. Also made sending a message feel a bit smoother: the message box stays focused right after you hit send, so you can keep typing your next line without having to click back into it.' },
        { version: 'v2.69', date: '2026-08-06', notes: 'Three changes. Fixed the ⋮ menu text going unreadable on hover — Change Password and Sign Out now stay clearly visible the whole time your mouse is over them, in every theme. New "Expiring Documents" tab (under Administration) — one combined, soonest-first list of everything with an expiration date already on file: fleet registration and insurance, plus driver license, work permit, and medical card for every employee, instead of having to check each one individually. Search results now open as their own full page instead of a small popup, similar to a search engine\'s results page — the search bar itself works exactly the same as before, just Enter to search.' },
        { version: 'v2.68', date: '2026-08-06', notes: 'Fixed the Messages dropdowns closing on their own — the background check for new messages was quietly rebuilding those dropdowns every few seconds even when nothing in them had actually changed, and rebuilding a dropdown while it\'s open is exactly what makes it snap shut on you. It only touches those dropdowns now when something about them genuinely needs to change, so they\'ll stay open exactly as long as you\'re using them.' },
        { version: 'v2.67', date: '2026-08-06', notes: 'Finished the search bar — there\'s now a real search box at the top of the app (employees, claims, charges, income, fleet all included), and typing something and hitting Enter opens a results page you can click straight into. Messages now feels closer to a live chat — while that tab is open, it checks for new messages every few seconds automatically, no need to reload. While going through this, found and fixed a real gap: resizing the window while on the Fleet tab didn\'t switch between the phone-style and desktop-style layouts the way every other tab already does — it now does. Sidebar, Messages, and everything else built this session already auto-adjust correctly on resize since they\'re built with responsive CSS, which works the same whether you\'re in a browser tab, on a phone, or in the installed app — verified that holds true across all of them.' },
        { version: 'v2.66', date: '2026-08-06', notes: 'Two big changes. First, sidebar icons are now real line icons matching the new design, not emoji — cleaner and consistent across every device. Second, Messages is fully rebuilt to match the sample you shared: a real two-pane chat, contact list on the left with search and category filters, an open conversation on the right with message bubbles and a message box at the bottom, instead of the old flat list with a compose form up top. Everything you type just sends straight into the open conversation now — no more picking who or what you\'re replying to first. The privacy rules underneath are exactly the same as before: View Only sees their own conversation and any staff replies in it, never anyone else\'s, and still can\'t delete messages — this was purely a new coat of paint on the same secure foundation, verified against real accounts before shipping.' },
        { version: 'v2.65', date: '2026-08-06', notes: 'Theme switching is back in the app itself — no more signing out just to change it. Tap the ⋮ menu, top right, and the three theme circles are right there, no label text above them. Same colors as the login screen, and switching updates instantly without closing the menu, so you can click through and compare before deciding. Change Password and Sign Out are still in that same menu, just below the colors now.' },
        { version: 'v2.64', date: '2026-08-06', notes: 'Fixed sidebar text turning invisible on hover in Light theme — the sidebar itself always stays dark by design (a consistent look regardless of which theme you\'re using), but on hover the text was picking up a color meant for the light background elsewhere in the app, going dark-on-dark against the sidebar. Now it always turns white on hover in the sidebar, no matter which theme is active.' },
        { version: 'v2.63', date: '2026-08-06', notes: 'Several redesign refinements: the desktop sidebar now has icons next to every item. "Vehicles" is renamed to "Fleet" throughout (the tab and its summary count) — individual vehicle records still say "vehicle," since that reads naturally ("Add Vehicle" to your fleet). Model is now optional when adding a vehicle. Removed the duplicate theme picker from Settings — Appearance now lives in exactly one place, the login screen, instead of two. The Change Password / Sign Out buttons in the header are now tucked behind a single ⋮ menu instead of sitting out as two separate buttons, closer to how the new design keeps headers clean — that\'s my read of "add the 3 dot," happy to adjust if you pictured something different. Also caught and fixed a real bug while making Model optional: the vehicle-creation activity log was quietly concatenating year + make + model together, and in the database, joining anything with a missing piece like that wipes out the whole line — so vehicles saved without a model would\'ve shown up in the audit log as a blank entry instead of "2022 Ford." Fixed and verified before shipping.' },
        { version: 'v2.62', date: '2026-08-06', notes: 'Redesign, phase 2: navigation is now a fixed sidebar on desktop, matching the new design — logo at top, Logistics/HR & Payroll/Administration as sections you click through, docked to the left instead of a bar across the top. On phone and tablet, navigation looks exactly like it did before this update — nothing changed there, on purpose, since a sidebar doesn\'t make sense on a narrow screen. Built this carefully: it\'s the exact same navigation buttons and permissions logic as always (including what View Only accounts can and can\'t see), just repositioned by CSS depending on screen size — nothing about how tabs, groups, or role-based hiding actually work underneath was touched.' },
        { version: 'v2.61', date: '2026-08-06', notes: 'Redesigned the login screen to match the new look — a dark gradient backdrop with soft glow, a cleaner "Tracker Login" heading with subtitle, and the theme picker is now three small color circles instead of a row of text buttons, so you can see each theme\'s actual color at a glance. This backdrop stays a consistent dark look regardless of which of the 3 in-app themes is selected — it\'s a first-impression / branding moment, not something that needs to preview your chosen theme. Caught one real thing before shipping: the "Tracker" wordmark at the top would have gone nearly invisible for anyone on Light theme, since it was using a color that flips dark-on-light vs light-on-dark depending on theme, but the new card background is always dark. Fixed to a fixed light color so it\'s always readable.' },
        { version: 'v2.60', date: '2026-08-06', notes: 'Redesign, phase 1 of several: applied the new design system\'s typography and focus styling everywhere. Genuinely good news while doing this — the new look\'s colors, card shadows, rounded corners, and striped tables were already almost entirely matching what this app already had, so this phase was smaller and safer than expected. Two real additions: numbers, IDs, and currency values across the whole app now render in JetBrains Mono (the technical monospace font the new design specifically calls for), and every input field now shows a small emerald accent on its left edge when focused. Next up is the bigger piece — reworking navigation into a sidebar layout — which I\'m tackling as its own focused step since it touches how every single tab in the app is switched to.' },
        { version: 'v2.59', date: '2026-08-06', notes: 'Messages: added replies, so a conversation can now actually be followed as a thread instead of a flat list — each message has a "↩ Reply" option, and replies show grouped and indented right under what they\'re replying to, oldest first. Also corrected the delete permission to match what was actually intended: View Only accounts can send and reply, but can no longer delete any message — not even their own. Deleting stays a Medium-and-above action.' },
        { version: 'v2.58', date: '2026-08-06', notes: 'New: "Print All (net pay > 0)" button on Payroll — prints everyone with a real amount owed for the selected week in one combined document instead of opening each person one at a time. Respects whatever filters you already have set (Person type, Status, search), so it prints exactly who\'s on screen, minus anyone whose net pay is zero or less.' },
        { version: 'v2.57', date: '2026-08-06', notes: 'Logistics is now fully hidden for View Only accounts — found that Vehicles specifically had been left visible there since it was added, even though the rest of Logistics was already hidden; fixing that one thing let the whole Logistics group correctly disappear the way it was always meant to for that role. Statement: claims and charges are now grouped by status — Deducting together, Queued together, Paid together, and so on — with claims and charges mixed together within each group, but Additional Income stays in its own separate section as before, never mixed in with the other two.' },
        { version: 'v2.56', date: '2026-08-06', notes: 'New: full data export and import, both as one combined file and individually per section. "Export All Data" (Data Sync tab) downloads a single Excel file with a separate sheet for Employees, Claims, Charges, Additional Income, Vehicles, Routes, Daily Pay, and Provider Pay — everything in one download, SSN/ITIN never included. "Import All Data" reads that same file back in and restores everything except Employees (which keeps its own dedicated import, since employee records need more careful handling around sensitive fields). Claims, Charges, Additional Income, Vehicles, and Provider Pay also each got their own individual Export/Import buttons for when you only need one section. Every import matches existing records by their ID and updates them, or creates a new record if the ID isn\'t recognized — verified each of these paths directly against real data before shipping. One honest note: I tested every underlying save/update operation directly, but couldn\'t click through an actual export-then-reimport in a live browser from here — worth trying that full round trip once and letting me know how it goes.' },
        { version: 'v2.55', date: '2026-08-06', notes: 'Fixed being unable to switch anyone to Provider pay — last version added Provider as an option, but missed three real spots that were still hardcoded to only know about Weekly and Daily: the quick ↺ toggle button on the Employees list (was a strict Weekly/Daily flip-flop with no way to ever land on Provider), the employee form\'s own save handler (would have silently saved "Weekly" even if you picked Provider from the dropdown), and the bulk CSV import. All three now correctly handle all three pay types. The quick toggle now cycles Weekly → Daily → Provider → back to Weekly.' },
        { version: 'v2.54', date: '2026-08-06', notes: 'New: Provider Pay — a third pay category alongside Weekly and Daily, for providers whose pay isn\'t a flat rate. Set someone\'s Pay Type to "Provider" in the Employees tab, and they show up on the new Provider Pay tab (right next to Daily Pay), where you enter one amount for the week plus an optional note — no day-by-day breakdown, since that\'s not how these get paid. Entries save automatically and flow straight into Payroll the same way Daily Pay already does, with its own badge so it\'s easy to tell at a glance which pay category someone is on. Note: I built this as one amount per week rather than a 7-day grid — if you actually need day-by-day entry for providers too, let me know and I\'ll adjust it.' },
        { version: 'v2.53', date: '2026-08-06', notes: 'Fixed mouse scrolling. Traced it to a setting added a few versions back specifically to smooth out a small visual glitch on iPhone (where the phone\'s own natural bounce-scroll was fighting the pull-to-refresh indicator) — that setting was applied everywhere, including desktop, where it had no business being and could interfere with scrolling through the app\'s tables and lists with a mouse. It now only applies on touchscreens, where it was actually needed, and never touches mouse/trackpad scrolling at all.' },
        { version: 'v2.52', date: '2026-08-06', notes: 'Fixed the Messages text box — the app\'s dark themes style every input and dropdown to match, but textareas had been completely skipped from that styling since Messages introduced the first one, so it was showing up as a plain white browser box that clashed with everything around it. It now matches the rest of the app in all three themes, same border, background, and focus behavior as every other field.' },
        { version: 'v2.51', date: '2026-08-06', notes: 'Charges now has a "Paid" status option (it was missing — only Queued/Deducting/Absorbed/Tk from check existed before). And the automatic "mark as Paid once it\'s actually finished" behavior that claims already had now runs for charges and additional income too — a charge or income item that reaches $0 and stays there for a week gets automatically switched to Paid overnight, exactly the same rule claims have used all along. Verified this against real payoff data (a charge and an income item, each fully paid off) before turning it on.' },
        { version: 'v2.50', date: '2026-08-06', notes: 'Fixed claim and charge schedules disappearing once something is Paid or Absorbed — Statement and the print buttons were showing "No schedule to project" for anything already resolved, even though the real payment history obviously still happened and should still be viewable. Verified against a real resolved claim before shipping: it now correctly shows all 4 of its actual weekly payments again. Also simplified the wording on Messages — it now just says "Messages are kept private" instead of spelling out the exact role rule every time.' },
        { version: 'v2.49', date: '2026-08-06', notes: 'To answer directly: once the app is installed as a home screen shortcut, tapping it does NOT go through whatever browser the phone has set as default — it opens straight into its own standalone window, completely independent of that setting. That was already true, but added one missing piece (a "scope" setting) to make browsers honor this more consistently. The one real limit, worth being upfront about since it\'s an Apple restriction, not something any app can work around: on iPhone, the shortcut only opens standalone if it was installed through Safari specifically — installing via Chrome or another browser on iPhone doesn\'t get the same standalone treatment, because Apple only allows it through Safari\'s own install flow. On Android, this isn\'t a limitation — Chrome, Edge, and Samsung Internet all install and launch it standalone correctly.' },
        { version: 'v2.48', date: '2026-08-06', notes: 'Direct answer on the last update: yes, Android and iOS both work, but they behave a little differently, so here\'s the honest breakdown. Android (Chrome): full support out of the box — installs with a real icon, opens in its own window, works offline for the app shell, pull-to-refresh works. iOS (Safari): also fully supported, but Apple only lets you install by tapping Share → "Add to Home Screen" — there\'s no automatic "Install" prompt like Android has, that\'s an Apple platform limitation, not something any app can add. Found and fixed one real gap while double-checking this: without a couple of Apple-specific tags, iOS would have opened the installed app back inside Safari\'s browser bar instead of as its own clean app window, and would have shown the long full title under the icon instead of "Tracker" — both are fixed now. Also added a small screen-bounce fix so the pull-to-refresh gesture doesn\'t visually fight with iPhone\'s own natural scroll-bounce.' },
        { version: 'v2.47', date: '2026-08-06', notes: 'Added real PWA behavior and pull-to-refresh. Installed copies of the app now load instantly and stay usable if the connection briefly drops, though your actual data always requires a live connection — this app doesn\'t try to show you stale numbers when offline. Pull-to-refresh: pull down from the top of any screen to re-sync the current tab\'s data, the same gesture you\'d expect from any phone app — this matters especially once installed, since installed apps don\'t get the browser\'s built-in pull-to-refresh. One deployment note: this required a second file, sw.js, alongside index.html — upload both to the same folder in GitHub. If sw.js isn\'t there, the app still works completely normally, it just won\'t have the offline-shell behavior until it is.' },
        { version: 'v2.46', date: '2026-08-06', notes: 'New: Messages — a new tab under HR & Payroll for notes tied to an employee, and optionally to one specific claim, charge, or additional income item. Meant for things like flagging a missing day or leaving a note on why a claim amount changed. Visibility works exactly as designed: everyone can see their own messages, Medium-level staff and above see every message, and View Only accounts never see another View Only account\'s messages — only their own, plus anything staff wrote back on their thread. View Only accounts can only post about their own employee record. Every post and delete is recorded in the audit log like everything else in the app.' },
        { version: 'v2.45', date: '2026-08-06', notes: 'View Only accounts no longer see the Vehicles tab — fleet info is now Medium role and above only, matching how View Only\'s access already works everywhere else in the app.' },
        { version: 'v2.44', date: '2026-08-06', notes: 'A big Statement/Payroll/Daily Pay update. Printing: each claim and charge in Statement now has its own "Print schedule" button (full week-by-week payment history, one item at a time), and each employee\'s Payroll detail has a "Print payslip" button — each prints just that one thing, not everything at once. Statement: removed the separate "Statement as of" date field entirely — it now uses the same Prev/Next/This week navigation as Payroll and Daily Pay, and every number on the page is driven purely by whichever week is selected, with no hidden fallback to today\'s date anywhere. Statement also gained bubble indicators at the top — claims/charges/additional income counts and their dollar totals — matching the style already used on the Claims tab. Daily Pay, Payroll, and Statement now all open to last week by default instead of the current week (the "This week" button still correctly jumps to the real current week when tapped).' },
        { version: 'v2.43', date: '2026-08-06', notes: 'Fixes the "can\'t add or edit vehicles" error some of you may have hit right after the last database update — that was a real, temporary gap between the database and this file (the database side of a security fix landed slightly ahead of this file), not something wrong with your data. This version closes that gap: Vehicles now saves and edits correctly again. Two other things: every employee dropdown across the whole app now consistently shows Name then Employee ID, in that order, everywhere — a few had it backwards or missing the ID entirely. And the biggest one: found that the audit log (Administration → Log) was missing a real record of a lot of actions — not just Vehicles as reported, but deleting a claim, charge, or route entirely, resetting a company\'s data, changing someone\'s pay type, editing income, editing employee details, and more all left zero trace before this. All of it now writes a proper log entry, tested individually before shipping.' },
        { version: 'v2.42', date: '2026-08-06', notes: 'Claims on desktop now works the same way Employees and Payroll already do: instead of one very wide table showing every column at once (Claim ID, Employee, Emp ID, Claimant Acct, Company, Carrier #, Customer #, Damage Type, Amount, Weeks, Balance, Absorbed, Start, Ends, Status, Action — all 16 columns, needing horizontal scroll to see the rest), each row now shows a short summary and taps open to reveal everything else, matching exactly what the mobile card already showed. Built this so mobile and desktop share the exact same detail content from one place — they can\'t drift out of sync with each other going forward.' },
        { version: 'v2.41', date: '2026-08-06', notes: 'Added the actual logo, visible inside the app itself — last version only added it as the browser/install icon, which wasn\'t what was meant. The Shield + Dial + Pin mark now sits next to the title on the main dashboard, and a full logo (icon + "Tracker" wordmark) appears above the login form. Drawn as crisp vector graphics rather than a bitmap image, so it looks sharp at any size. Fixed one thing before shipping: the login screen\'s wordmark subtitle was using a fixed color that would have been hard to read in the two dark themes — switched it to the same theme-aware color already used for accents elsewhere, so it looks right in Light, Ocean, and Emerald alike.' },
        { version: 'v2.40', date: '2026-08-06', notes: 'Added a real app icon — the "Shield + Dial + Pin" mark you picked from the concepts (protection, tracking, and location in one badge). Recreated it precisely as actual icon files (not just a picture) at every size browsers and phones need, plus a proper install manifest, so the app can now be installed with a real icon on both Windows and Android — Chrome/Edge will offer "Install this app" on Windows, and on Android it installs as a genuine home-screen app (technically a real WebAPK, generated automatically by Chrome). A true standalone .apk file for direct distribution outside the browser would need separate packaging tools beyond what can be done from inside this file — this covers the "install it like an app" part.' },
        { version: 'v2.39', date: '2026-08-06', notes: 'Daily Pay import now automatically downloads a correction report whenever a name in the file can\'t be matched to an employee — no more digging through the original spreadsheet by hand to find who was skipped. The report lists each unmatched name, its row in your file, and that week\'s total dollar amount so you can tell at a glance which ones actually had real pay data at stake versus an empty row. Fix the names (or add the employee) and re-upload. The name-matching itself hasn\'t changed — it already used the same logic as the Claims importer.' },
        { version: 'v2.38', date: '2026-08-06', notes: 'Bilingual work continued: Charges & Income is now fully translatable — both forms, the rate-change/pause-resume panel on Charges, and both tables. Still hidden until every tab is done (per request).' },
        { version: 'v2.37', date: '2026-08-06', notes: 'Bilingual work continued: Claims tab is now fully translatable (the form, the rate-change/pause panel, and the table). Per request, the Language switcher itself is now hidden — on the login screen and in Settings — until every tab is done, so nobody sees a half-English, half-Spanish app in the meantime. Nothing was removed; it\'ll reappear once translation is complete.' },
        { version: 'v2.36', date: '2026-08-06', notes: 'Continued the bilingual work — the Employees tab (form and table) is now fully translatable, along with the "Clear filters" and "Sort by" controls used across every section in the app. Still English-only: every other tab\'s form fields and table headers, help text, and pop-up messages — same as before, this is ongoing.' },
        { version: 'v2.35', date: '2026-08-06', notes: 'Charges can now have their weekly rate changed mid-stream and be paused/resumed — the exact same tools Claims already had, now on the Charges tab too (tap Edit on a charge to see it). This wasn\'t just a UI addition: Charges\' whole balance calculation was rebuilt underneath to actually account for pauses and rate changes week by week, the same proven system Claims already used — previously charges only understood a flat weekly amount with no way to represent a pause or a rate change at all. Statement now also shows exactly how much of each claim, charge, and income item has actually been paid or collected so far, not just what\'s left — and Charges\' Statement view now shows the full week-by-week schedule the same way Claims already did. Verified the whole pipeline directly with a test charge — paused it for two weeks, changed its rate mid-stream, and confirmed the schedule correctly skipped the paused weeks and applied the new rate from the right date, landing on exactly $0 at the right week — before shipping.' },
        { version: 'v2.34', date: '2026-08-06', notes: 'Found the real, deeper cause of the income-showing-in-the-wrong-week issue — last version\'s fix was correct as far as it went, but there was a second, more fundamental bug underneath it that only this exact case (a 1-week item) exposed clearly. The week-counting math for every charge and additional income (not claims, which were already correct) was starting the count a full week late — treating the very week something starts as "zero weeks elapsed" instead of the first week. For a 1-week item like David Rodriguez\'s $50 income, that meant it looked unpaid during its actual start week and then looked like it was still being paid the week after, instead of being fully done in its own start week as it should be — exactly matching the rule you gave: weeks = 1 means the start week and end week are the same. Fixed the underlying week count so it now matches how claims already worked. Important to know: this also quietly corrects the running balance shown for every other active charge and additional income, not just this one — those had been under-counting by one week\'s payment this whole time, so a few balances (Charges & Income tab, and Payroll) will shift down by one week\'s worth of deduction the moment this goes live. That\'s the correction taking effect, not new data loss.' },
        { version: 'v2.33', date: '2026-08-06', notes: 'Two things. (1) Fixed a real, confirmed bug in Payroll: claims, charges, and additional income were showing in payroll weeks BEFORE their own start date, not just after they finished — David Rodriguez\'s income entry (start date 7/25) was incorrectly showing in the 7/12 week too, more than a week before it began. Root cause: the balance calculation correctly reports "full amount, nothing paid yet" for any week before something starts, which is true, but nothing was checking whether the week being viewed was even on-or-after the start date before treating that as an active deduction. Fixed with a direct date check. Verified against the exact reported case — the income entry now shows in exactly one week, its actual start week, and nowhere else. Applies to claims, charges, and additional income alike. (2) New: Import Registry button on Daily Pay — upload your weekly daily-pay spreadsheet directly instead of entering each day by hand. Matches employees by name the same way Claims import already does, skips anyone it can\'t confidently match rather than guessing, and tells you exactly who was skipped so you can fix and re-import.' },
        { version: 'v2.32', date: '2026-08-06', notes: 'Fixed Route Tracker not showing all your data after a large import. Checked your file directly and confirmed the import itself worked completely and correctly — all 1,063 routes were saved with nothing missing and nothing duplicated. The problem was on the way back out: Supabase caps how many rows come back in a single request, and with over 1,000 routes now on file, the tail end was silently getting cut off every time the dashboard loaded them, with no error shown. Route Tracker now automatically fetches everything in batches instead of trusting one request to return it all, so this won\'t happen again regardless of how large the dataset grows.' },
        { version: 'v2.31', date: '2026-08-06', notes: 'Fixed Truck # not saving — turned out to be much bigger than that one field: editing or deleting an existing vehicle was completely broken (adding a new one worked fine, editing or removing one silently did nothing). Root cause: those two actions were written to talk to the database directly instead of through this app\'s normal secure channel, and without that channel they couldn\'t actually find the vehicle to change. Fixed properly, and directly confirmed your real truck now has "1444" saved. While fixing this, checked the rest of the app for the exact same mistake and found it in three more places that were likely also silently failing: editing Additional Income, and removing a claim\'s rate-change or pause history entries. All four fixed and individually tested before shipping.' },
        { version: 'v2.30', date: '2026-08-06', notes: 'Found and fixed a real, separate bug behind "the claim isn\'t showing" — different from the one fixed a few versions ago. A claim/charge/income item that gets fully paid off in a single week (its balance reaching exactly $0 that same week) was being completely hidden from Payroll for that week, and showing $0 instead of the real amount if it did show — because the check for "is this still being deducted" was accidentally using the balance AFTER that week\'s payment (which is $0 once it\'s the very last payment) instead of the balance BEFORE it. Confirmed against the exact reported case — a $75 claim, paid off in one single deduction — before shipping: it now correctly shows the $75 deduction for the week it actually happened, and the balance afterward still correctly reads $0.' },
        { version: 'v2.29', date: '2026-08-06', notes: 'Vehicles: added Truck # (your company\'s own identification number, separate from license plate) and VIN — VIN had been missing entirely, it wasn\'t being saved anywhere. Truck # now shows first, before the year, in both the vehicle list and each vehicle\'s title, and both fields are searchable and Truck # is sortable.' },
        { version: 'v2.28', date: '2026-08-06', notes: 'New: Vehicles tab (Logistics) — track your fleet\'s year/make/model, license plate, registration expiry, and insurance (company, policy #, expiry), plus a per-vehicle service log (performed or scheduled work, with dates). Registration and insurance expiry get the same warning badges already used for driver license/work permit/medical card elsewhere in the app. Built this after reviewing a version you had a different AI build as a standalone tool — that version only saved data in one browser on one device with no backup and no way for your team to share it, so it was rebuilt properly against this app\'s real database instead: same login/role system, same security model, and it now shows up wherever else you access this app (desktop, phone, any of your three deployments) instead of being stuck on one device.' },
        { version: 'v2.27', date: '2026-08-06', notes: 'Added a "✕ Clear filters" button to every section that has search boxes or filter dropdowns — Employees, Claims, Charges, Additional Income, Statement, Daily Pay, Payroll, and Notifications. One tap resets that section back to its normal default view (search cleared, dropdowns back to Active/All as appropriate) instead of clearing each field by hand.' },
        { version: 'v2.26', date: '2026-08-06', notes: 'Two things. (1) Notifications redesigned per feedback: added a Date range filter (30/60/90 days, last year, or all time) and a newest/oldest sort toggle — available to every role, same as before. Each notification is now a plain flat row instead of the collapsible-card style used elsewhere, since there was never anything to expand into. (2) Fixed a real bug in Payroll: once a claim, charge, or income item resolved (Paid/Absorbed/Tk from check/Stopped — including the automatic one from v2.15), it stopped showing in Payroll for EVERY week, including past weeks from before it resolved, when it had genuinely still been deducting. Confirmed the exact case reported: a claim that reached $0 by 08/08 had correctly been deducting the week of 08/01, but browsing back to that week showed nothing. Root cause: the balance calculation was forcing $0 for any date once a status resolved, not just from the resolution point forward. Fixed so a past week now shows what was actually true at the time, while today and future weeks still correctly show $0 for anything resolved — verified against the exact numbers from the reported case before shipping.\\n\\nA note on how this was implemented: you shared instructions you\'d given Gemini, including its proposed fix (a new payroll_transactions ledger table). I did not build it as written — it used ID types that don\'t match this database (UUIDs where this app uses text IDs throughout), it would have reopened the exact open-to-anyone security hole closed a few versions back, and its 4th section proposed replacing this app\'s entire working login system with Supabase\'s unrelated built-in auth, which would have logged everyone out permanently since no accounts exist in that system. None of that was implemented. The actual bug didn\'t need a new table at all — the schedule math already stored everything needed (start date, rate changes, pauses); it just wasn\'t being asked the right question for a past date.' },
        { version: 'v2.25', date: '2026-08-05', notes: 'New: Notifications tab (HR & Payroll). Whenever a claim, charge, or additional income is created for an employee, they now get a notification showing what it is, the amount, and when it happened — tap it and it jumps straight to that record, already filtered into view. A red count badge on the tab shows how many are unread. This runs at the database level, so it fires no matter how the record was created (the form, a CSV import, anything in the future) — nothing can slip through. Same access rules as everywhere else: a View Only account only ever sees notifications about themselves, never a coworker\'s.' },
        { version: 'v2.24', date: '2026-08-05', notes: 'Fixed Daily Pay not saving — the exact same underlying issue as last version\'s Weekly/Daily pay-type bug, just on a different table: the security fix before that had removed direct read access to the daily pay table, which broke the kind of save this screen uses the same way. Moved it to the same kind of dedicated database function. Checked every other screen in the app for this same pattern and confirmed nothing else is affected. Also merged the Changelog tab\'s two lists (Version History and System Changelog) into one, since they were showing the same information twice — it now reads entirely from the database-backed list, including the full history back to v1.0, so this record survives independently of whatever app file is deployed. Still Super Admin only.' },
        { version: 'v2.23', date: '2026-08-05', notes: 'Full database reset and security hardening, at your request. Wiped every operational table clean (companies, employees, claims, charges, routes, income, daily pay, and everything tied to them) — reused the existing Damage Type / Charge Type / Income Type lists rather than losing them. Every table connected to a company, employee, or claim now has a real enforced connection at the database level, so deleting something always takes everything that belongs to it with it — verified directly, not just assumed. SSN/ITIN, driver license, and work permit numbers are now encrypted in storage — previously they were kept as plain readable text; confirmed the raw stored values are now unreadable without going through the app\'s own access controls. Created the Super Admin account. New: a database-backed System Changelog (Changelog tab, second panel) that survives independently of this app file — visible to Super Admin only, same as the regular Version History above it, which is no longer visible to Administrators. Also closed a smaller gap found while doing this: the Damage/Charge/Income Type lists in Settings could previously be edited by anyone logged in, including View Only accounts — now requires Medium role or above, same as everything else that changes shared data.' },
        { version: 'v2.22', date: '2026-08-05', notes: 'Fixed switching an employee between Weekly and Daily pay — it started failing right after last version\'s security fix. That fix (correctly) removed direct read access to the pay-type table, but Postgres needs that same read access internally to process the kind of save this screen uses, so every attempt started failing outright the moment the security fix went live. Moved the save itself to a dedicated database function that doesn\'t hit that limitation, and fixed a related issue: a failed save was still showing the attempted new value on screen instead of the real one, so it looked like it worked right up until the page was reloaded — a failed save now visibly reverts immediately instead of silently lying. Checked the underlying data directly: it\'s accurate — 118 of 127 people are correctly Daily and the other 9 are Staff roles that are genuinely Weekly-salary, not a mistake. If anyone still shows the wrong pay type after this update, it should now be safe to correct and have it actually stick.' },
        { version: 'v2.21', date: '2026-08-05', notes: '"Delete All Users" (Data Sync) is fixed — it was calling a database function that had never actually been created, so every click failed outright. Now works the same way deleting one user at a time already does (Administrators can only remove non-SuperAdmin accounts in their own company; Super Admin can remove anyone but themselves). Users can now have their linked Employee ID changed or cleared directly (🪪 Edit ID button, Users tab) instead of needing the account deleted and recreated — an employee can never be linked to more than one account at the same time, enforced at the database level, and the employee must belong to that user\'s own company. Also revised claim rate-change and pause/resume: a new weekly amount can no longer be negative or duplicate an existing effective date for the same claim, and a pause\'s expected resume date must actually be after its start date and can no longer overlap an existing pause window for that claim — all of these were previously accepted without any check.' },
        { version: 'v2.20', date: '2026-08-04', notes: 'Security fix — the "Unlinked" name on that income row turned out to be a symptom of something bigger: Additional Income, Employee Details (phone/email/driver\'s license/medical card), Daily Pay, employee pay-type, and claim rate-change/pause history were all readable directly by any logged-in account, with no scoping by company or role at all. In practice this meant a View Only account could see every coworker\'s bonus amounts, personal contact and license info, and daily earnings — not just their own — and it wasn\'t scoped to one company either. All six now go through the same properly-scoped access every other part of the app already uses (a View Only account sees only their own record; other roles see their own company). The reported symptom is also gone as a side effect: a View Only account now simply doesn\'t see other people\'s records at all, so there\'s nothing left to show as "Unlinked."' },
        { version: 'v2.19', date: '2026-08-04', notes: 'Fixed the Daily Report table (Route Tracker) header row running off the right edge of the screen with the last few columns cut off entirely and no obvious way to see them. Column headers now wrap onto 2-3 lines instead of forcing themselves onto one, so each column\'s width is driven by its (short) data instead of its (long) label like "COMPLETED STOPS**". Also added a permanent "scroll for more columns" hint under this specific table, since even with wrapped headers, 15 columns will usually still need a horizontal scroll on most screens — previously that hint only ever showed on narrow mobile widths.' },
        { version: 'v2.18', date: '2026-08-04', notes: 'Database-only fix, no app screens changed: deleting a company left a surprising amount behind. Audited every table for how it connects to a company and found only employees, routes, claims, and charges actually cleaned up automatically — usernames were never removed (just unlinked, so the login account kept working with no company attached), and additional income, claim rate-change/pause history, daily pay entries, employee details, pay-type settings, and pending approval requests were all left behind permanently with no cleanup at all. Deleting a company now removes all of it. Verified end-to-end with a fully isolated throwaway test company (one of every kind of record, 19 tables total, including a real login account) — deleted it and confirmed zero rows remained anywhere. A company\'s change history is also cleared as part of this (unlike deleting a single employee or claim, which still keep their history) — a full company deletion is a more total action, and there\'s no longer a company left for that history to be about.' },
        { version: 'v2.17', date: '2026-08-04', notes: 'Fixed the sort direction (▲/▼) button doing nothing on first tap, needing a dropdown change first to "wake up" — every "Sort by" list defaulted to no sort field selected internally even though its dropdown visually showed one, so flipping direction had nothing to apply itself to until the dropdown was touched. Every sortable list now starts properly sorted by its dropdown\'s default option, so the direction button works immediately. Audited every list in the app for sorting as asked: Payroll, Companies, Users, and the Approvals and Log tabs had no sorting controls at all before this — added the same "Sort by" dropdown + direction button to all five, matching the pattern already used by Employees/Claims/Charges/Income (Payroll: Employee/ID/Type/Base/Gross/Deductions/Net/Status; Companies: Name/Code/Owner/Manager/Created; Users: Username/Employee ID/Role/Created; Approvals: Requested/Requested by/Table/Field; Log: When/Who/Table/Field, defaulting newest-first same as before). Employees now defaults to showing Active only, matching Payroll/Daily Pay/Statement\'s existing default — switch to Inactive or All statuses anytime from the same dropdown.' },
        { version: 'v2.16', date: '2026-08-04', notes: 'Fixed Charges (and occasionally Claims) sometimes showing an employee as "Unlinked" even though the charge/claim is correctly linked in the database — confirmed on a real example (charge 3OFL00001D → employee 3OFL0031E, Jesus Gonzales Perez) that the data itself was byte-for-byte correct; the problem was purely a display timing issue. Employees, Claims, and Charges all load at the same time on refresh, and Employees now does more work per person (details + user-account links) — so if Employees happens to finish loading last, Charges/Claims can render one beat too early, before the employee list they need to look names up in is actually ready, and every row shows Unlinked. Claims already had a quiet fix for this (a second render once everything settles); Charges never got the same treatment. Added the same fix for Charges (and Additional Income, which has the identical issue), and also made opening the Claims or Charges & Income tab directly always re-render with current data, matching how every other tab already behaves. Nothing to fix in your data — once this update is live, any "Unlinked" row still showing was just stale on screen and will read correctly on the next load.' },
        { version: 'v2.15', date: '2026-08-04', notes: 'Database-only change, no visible app difference: the "auto-switch a claim to Paid a week after it hits $0" feature (added last version) now runs as a true server-side job on Supabase — a scheduled task that checks every "Deducting" claim once a day (06:00 UTC) and settles any that qualify, using the exact same schedule math the app itself displays (weekly deductions from the start date, honoring recorded rate changes and pauses). This means it now works even when nobody has the app open, instead of only checking whenever someone loads the Claims/Payroll data. Removed the version of this check that ran in the browser, since the server job replaces it. Verified live against real claims before turning it on for real: 2 already qualified (paid off with their last scheduled deduction more than a week ago) and were correctly flipped to Paid, with the usual audit trail entry. Worth flagging: one of those two (claim 3OFL00003) was originally imported with status "Paused" from the Excel tracker back in the Claims-import work, and its notes say it still needs a real pause entry added — since that was never added, this claim\'s schedule was calculated as if it deducted continuously with no pause, so it\'s worth double-checking that one specifically rather than just trusting the auto-resolved "Paid" status.' },
        { version: 'v2.14', date: '2026-08-04', notes: 'Carrier claim # and Customer claim # now show alongside Company and Claimant account in the same two spots added last version: Payroll\'s expanded deduction breakdown, and Statement\'s per-claim panel.' },
        { version: 'v2.13', date: '2026-08-04', notes: 'Three additions. (1) Employees without a login now show a "Generate User" button in their expanded detail — mainly for the 126 people brought in through CSV import, which never auto-creates accounts. Uses the same role mapping as adding a new employee (Owner/Manager → Administrator, Staff → Medium, everyone else → View Only) and shows the new username/password once, same as the existing flow. Found and fixed a real problem while building this: the username generator (shared with the existing new-employee flow) builds a username from "first initial + last name" — but most employees here have their whole name in one field with nothing in last name, so it was generating single-letter usernames like "a". Fixed specifically for this new button by splitting the full name on spaces instead when last name is empty, without touching the already-shipped new-employee flow. (2) Claim deductions in Payroll and Statement now also show Company and Claimant Account beneath the claim, when the claim has them set. (3) A claim still marked "Deducting" now automatically switches to "Paid" once its own payment schedule has shown a $0.00 balance for a full week — not the instant it hits zero, so it settles rather than flipping the moment the last dollar clears. This checks quietly on every data refresh; nothing to click.' },
        { version: 'v2.12', date: '2026-08-04', notes: 'Fixed Payroll sometimes showing every paid day doubled (e.g. "Wed 8/5" twice, base pay total exactly 2x what it should be) when expanding a person\'s row. Confirmed first that the underlying Daily Pay data itself was never actually duplicated — this was a pure display bug: the function that loads the week\'s daily totals reset a shared list and then filled it back in after a database round-trip, so if it got triggered twice in quick succession (switching a Payroll filter, for instance), both calls could end up dropping their rows into the same list together. Rebuilt it to assemble each call\'s results separately and swap them in only once, fully finished, so overlapping calls can no longer double up. Applied the same fix to claim rate-change/pause history for the same underlying reason. Also reworked how Weekly Deductions and Additional Income are displayed in Payroll\'s expanded view — they were rigid 3-column tables that clipped the Balance/Remaining figure off the right edge of the screen on mobile; each line now stacks the item on its own row with the two amounts below it, so nothing gets cut off at any screen width.' },
        { version: 'v2.11', date: '2026-08-04', notes: 'Fixed the Claims Excel/CSV importer from v2.10 immediately failing with "No claim rows found to import." on the exact file it was built for. Root cause: the header-row detector scanned rows with a SheetJS option that silently drops fully-blank rows before handing back row numbers — this file has a blank row right above its real header row, so the detector\'s row count came back one short of reality, and the actual data extraction (which does NOT drop blank rows) then grabbed the wrong row as the header. Rewrote the detector to read cells directly by their true row/column address instead, so the row number it finds always lines up with the row number the rest of the import uses. Also made the "found nothing importable" message name how many rows it did see, to make it faster to diagnose if this ever happens again for a different reason.' },
        { version: 'v2.10', date: '2026-08-04', notes: 'New: Import Excel/CSV button on the Claims tab. Built against a "Tracker" sheet like the one already used for Route imports — auto-finds the real header row (skips metadata rows above it), matches columns flexibly, and skips Weeks/Balance/Processing Fee (the app already computes those live). Employee names are matched against the roster automatically — verified against a real 187-row file, matching 183 correctly and safely leaving the 4 genuinely ambiguous ones (e.g. a bare "Jose Garcia" when two different Jose Garcias exist) blank for manual assignment in Claims → Edit, rather than guessing wrong. Source status text is mapped to this app\'s 5 statuses (Paused→Deducting, Pending→Queued, Absorved→Absorbed, Drop Claim→Absorbed, Tk FrLast Check→Tk from check); anything that doesn\'t map cleanly (Wrong, Team Notified, blank) defaults to Queued — the safest non-deducting state — with the original text preserved in Notes so it is easy to find and fix. New damage-type descriptions found in the file are added to the Damage Types list automatically. Claim IDs are always freshly generated by the app itself, never reused from the source file\'s own reference numbers, so re-importing or importing alongside existing claims can\'t collide with an ID already in use.' },
        { version: 'v2.9', date: '2026-08-04', notes: 'Database-only fix, no app screens changed: deleting a claim (single delete, bulk "delete all claims", or a full company reset) now also removes that claim\'s rate-change history, pause history, and any still-pending approval request tied to it — previously only the claim record itself was deleted, leaving those behind as orphaned rows invisible in the app but still sitting in the database. Verified directly against the database with a throwaway test claim (rate change + pause + pending approval attached) before and after deletion.' },
        { version: 'v2.8', date: '2026-08-04', notes: 'Fixed Payroll showing negative net pay: claim/charge deductions were being taken at their full scheduled weekly amount even in a week where someone had $0 gross pay (e.g. a Daily-rate person with no Daily Pay entered that week), pushing Net below zero. Deductions are now capped at that week\'s actual gross pay, so Net can never go negative — the expanded per-person breakdown shows a note (and the original scheduled amount) whenever a deduction was reduced this way. Worth knowing: the claim/charge balance itself still follows its own calendar schedule regardless of pay, so it won\'t automatically know a week wasn\'t actually collected — for a week you already know will have $0 pay, pausing that claim (Claims tab) keeps its running balance accurate too, the same way pausing already works today.' },
        { version: 'v2.7', date: '2026-08-04', notes: 'Daily Pay now shows as a real horizontal table on desktop browsers — ID, Name, all 7 days, and Week Total as columns — matching the pattern every other list in the app already uses (Employees, Claims, Charges, Income, Payroll, Companies, Users, Approvals, Log). Stays the collapsible card layout on mobile, and switches automatically based on screen width, including on rotation.' },
        { version: 'v2.6', date: '2026-08-04', notes: 'Daily Pay and Statement now have the same Person type / Status / Search filter row as Payroll. Daily Pay\'s Status filter (Active / Inactive / All statuses, defaulting to Active like Payroll) narrows down who shows up in the timesheet — previously everyone on Daily Rate showed regardless of status. Statement\'s filters narrow the Employee dropdown itself, so finding one person in a long roster no longer means scrolling a 126-name list. Hardened every place the app deletes a record directly (income entries, claim rate-change/pause history, and the Damage/Charge/Income Type lists in Settings) against ever sending a delete with no target — each now checks it has a real ID/name before touching the database and shows a clear message if not, instead of the confusing native "DELETE requires a WHERE clause" error. Also fixed a real related bug: Damage/Charge/Income Type names were being inserted unescaped into their delete buttons\' click handlers, so a name containing an apostrophe (e.g. "Driver\'s fault") could break the button entirely — now properly escaped.' },
        { version: 'v2.5', date: '2026-08-04', notes: 'Fixed a real bug behind "expand/collapse doesn\'t work on desktop until I switch screens": the detail row\'s hide/show relied on a style that was only ever set once, at render time, so tapping it on desktop silently did nothing until something else (like resizing past the mobile/desktop breakpoint) forced a full re-render — now fixed at the root so every expandable list responds immediately. Employees\' desktop view now also collapses down to a compact row (ID, Name, Type, Department, Start, Pay, Status) per person instead of one very wide table — collapsed by default, tap a row to see the rest (phone, email, SSN/ITIN, license, work permit, medical card, role, notes). Added a Status filter (Active / Inactive / All statuses) next to the Employees search box. Every Active↔Inactive change is now recorded with who changed it and when — visible via a "Status history" button inside each employee\'s expanded detail — laying the groundwork for prorating payroll around status changes later.' },
        { version: 'v2.4', date: '2026-08-04', notes: 'Fixed a real bug in the Employees CSV import: rows with Person Type "Contractor" were silently being saved as the invalid type "Company" instead, due to a typo in the import code — this broke both the record\'s Type and its ID suffix. Contractors now import correctly. Added a new Super Admin-only "Reset System" action (Data Sync tab): removes every user account except Super Admins and clears the audit Log and pending Approvals, while leaving companies and everything that belongs to them — employees, claims, charges, routes, income — completely untouched. Requires typing an exact confirmation phrase before running, since it can\'t be undone.' },
        { version: 'v2.3', date: '2026-08-04', notes: 'Every card-based list (Employees, Claims, Charges, Income, Payroll, Companies, Users, Approvals, Log) now shows as a real horizontal table on desktop browsers — same columns as before cards existed — while staying the collapsible card layout on mobile. The two switch automatically based on screen width, including if you rotate a tablet mid-session. Payroll\'s desktop table keeps the same expandable per-person breakdown as its card, just as a row you tap to expand instead. Also fixed a small pre-existing display bug in the Log tab\'s error state.' },
        { version: 'v2.2', date: '2026-08-03', notes: 'Adding an employee (one at a time, via the Employees tab form) now also auto-creates their login, shown once in the same on-screen panel companies use, with the same duplicate-proof username policy. Role follows Person Type: Owner or Manager → Administrator, Staff → Medium, Employee/Contractor/Provider → View Only. Bulk CSV import intentionally skips this — importing many rows at once can\'t sanely display many one-time passwords, so add logins individually afterward for anyone imported that way. Also fixed a real bug found while testing this: company creation (v2.0/v2.1) has been failing outright since it shipped due to a mismatched internal logging call — confirmed and corrected; creating a company should now work end-to-end rather than error out.' },
        { version: 'v2.1', date: '2026-08-03', notes: 'Creating a company now automatically sets it up end to end: if an Owner name is given, an Owner-type employee is created for that company (ID ending in "O"); same for Manager ("M"). An Administrator account is always auto-created for the new company too, with a generated username (based on the company code, guaranteed unique system-wide) and a random password — shown once in an on-screen panel right after creation, since it can\'t be retrieved again later (it can still be reset from the Users tab). "Owner" and "Manager" are now selectable Person Types on the Employees tab too, so if the info wasn\'t provided when the company was created, a Super Admin can add that employee afterward — doing so links their name back to the company\'s Owner/Manager field automatically, both when creating and when editing an employee.' },
        { version: 'v2.0', date: '2026-08-03', notes: 'Administrators can now see the Companies tab, scoped to only their own company — they never see or can switch to another company\'s data there. They can edit their company\'s contact info (Owner, Phone, Email, Manager, Manager Phone); the Company Name and Code stay Super Admin-only to change, and Administrators never see the "Add Company" form (creating and deleting companies remain Super Admin-only actions). Enforced on the database side too, not just hidden in the UI — tested directly that one Administrator cannot edit another company\'s record even by calling the save function directly.' },
        { version: 'v1.9', date: '2026-08-03', notes: 'Added a "Changelog" tab under Administration, showing this same version history (version, date, what changed) as collapsible cards instead of just the tap-to-open badge popup. Visible only to Super Admin and Administrator users — Medium and View-only accounts don\'t see it.' },
        { version: 'v1.8', date: '2026-08-03', notes: 'Fixed the "one pale row" bug in both dark themes: on a touchscreen, tapping a table row keeps its :hover style active until you tap elsewhere, and several :hover states (table rows, the Daily Report\'s slicer filters) were still hardcoded to a light color — so whatever you\'d just tapped showed as a stuck white patch, mismatched from the row before this fix confirmed it was the true cause. Also fixed: the Daily Report slicer panels, active input/select focus state, Daily Report\'s Expand/Collapse toggle buttons, Daily Pay\'s OFF-day styling, note boxes, and the CSV drop-zone — all were still hardcoded light and are now properly dark in both Ocean and Emerald.' },
        { version: 'v1.7', date: '2026-08-03', notes: 'Added a second Dark theme option — "Emerald" — inspired by a black dashboard mockup with a green-to-teal gradient accent, distinct from the first ("Ocean," the navy/wave theme). Appearance is now a 3-way choice: Light, Ocean, or Emerald, available from Settings and now also from the login screen itself, so you can preview or pick a look before signing in. The choice still lives only on this device (localStorage) — it\'s never tied to a user account or written to the shared database, so it never becomes a global default for anyone else.' },
        { version: 'v1.6', date: '2026-08-03', notes: 'Fixed a real readability bug in Dark theme: collapsed cards (Employees, Claims, Charges, Income, Payroll, Users, Companies, Approvals, Log), striped table rows (Route Tracker, Daily Report, Settings lists), and form inputs had stayed on their light-mode background color while the text color had already switched to the light shade meant for dark backgrounds — pale text on a near-white background, very hard to read. All of those now get proper dark backgrounds, so text is fully legible everywhere in Dark mode.' },
        { version: 'v1.5', date: '2026-08-03', notes: 'Added an optional Dark theme (Settings → Appearance), built from the blue wave/mesh reference image — deep navy background with teal-cyan accents, applied to every panel, card, table, and button. Light stays the default; switching is one tap and remembered per device (localStorage), so it doesn\'t affect other people signed in elsewhere. Nothing else changed — all data, calculations, and features work identically in either theme.' },
        { version: 'v1.4', date: '2026-08-03', notes: 'Payroll, Users, Approvals, and Log are now the same collapsible-card layout as Employees/Claims/Charges/Income/Companies — every table in the app now uses it except Route Tracker\'s log. Companies can now be edited after creation (SuperAdmin only), so the Owner/Phone/Email/Manager/Manager Phone fields can be filled in for companies created before those fields existed. Employees now show document numbers and their expiration dates as separate, always-visible fields instead of combined text. The header now reads "Welcome, [your name]" instead of "User: [username]", adds a "Company:" line showing your assigned company, and the page title becomes "[Company Name] / Logistics & HR Claims Dashboard" instead of "Unified..." for anyone tied to a specific company (Super Admins viewing all companies still see the original title).' },
        { version: 'v1.3', date: '2026-08-03', notes: 'Fixed a real bug where the Users list could render completely blank with no explanation — it now shows Loading/error/empty states and isolates failures so one bad row or a network hiccup can\'t blank the whole table. Cleaned up the Employees card layout: Edit/Delete and the Pay-type/Status quick controls are now in clearly separated, labeled rows instead of one cramped line. Added Phone and Email to Employees (shown in the card, included in CSV export/import and search). Document expiration dates (driver license, work permit, medical card) are now shown explicitly, not just as a countdown badge. Companies gained five new fields — Owner, Phone, Email, Manager, Manager Phone — and the Companies list now uses the same collapsible card layout as Employees/Claims/Charges/Income. Verified Payroll\'s calculation logic directly against the database: it is working correctly — a $0.00 base pay reflects an employee whose weekly pay rate has not been entered yet, not a bug.' },
        { version: 'v1.2', date: '2026-08-03', notes: 'Employees, Claims, Charges & Income now display as collapsible cards instead of wide tables — each record shows a compact summary (name, ID, balance/status) and expands on tap for full details. The card grid reflows automatically to fit the screen: one column on a phone, several side by side on a tablet or desktop, so nothing requires horizontal scrolling anymore. Column-header sorting was replaced with a "Sort by" dropdown + direction toggle above each list. Daily Pay\'s collapsible card view (previously mobile-only) now applies on desktop too, using the same responsive multi-column grid instead of reverting to the old spreadsheet table.' },
        { version: 'v1.1', date: '2026-08-03', notes: 'Grouped the tab bar into three sections to cut down on top-level clutter: Logistics (Route Tracker, Daily Report), HR & Payroll (Employees, Claims, Charges & Income, Daily Pay, Statement, Payroll), and Administration (Settings, Users, Companies, Approvals, Log, Data Sync). Tap a group to reveal its tabs below. Each role sees only the groups that contain at least one tab it has access to.' },
        { version: 'v1.0', date: '2026-08-03', notes: 'Version tracking introduced (this badge + changelog). Snapshot of the app at this point: multi-company payroll/HR dashboard — Route Tracker, Daily Report, Employees, Claims (rate-change & pause history), Charges & Income (merged tab, feeds Payroll), Statement (collapsible, historical week selector), Daily Pay (mobile card view, historical weeks), Payroll (historical week selector, expandable per-person breakdown), Settings, Users (role management, employee-link uniqueness), Companies, Approvals, role-scoped Log, Data Sync, and a 5-minute idle session timeout.' }
    ];
    function renderVersionBadge() {
        const b = document.getElementById('version-badge');
        if (b) b.textContent = APP_VERSION;
    }
    // ===== Global search =====================================================
    // Searches whatever's already loaded client-side for the current user
    // (employees/claims/charges/income/vehicles) — these arrays are already
    // scoped to what that user's role/company can see via their normal
    // fetch functions, so this needs no new permission logic of its own.
    function runGlobalSearch() {
        const raw = (document.getElementById('global-search-input')?.value || '').trim();
        const q = raw.toLowerCase();
        const results = document.getElementById('global-search-results');
        const title = document.getElementById('global-search-title');
        if (!results) return;
        if (!q) return;

        // Show the results page the same way openTab() shows any other tab —
        // this isn't in the sidebar nav, so no nav button gets marked active.
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        document.getElementById('tab-search-results').classList.add('active');
        stopMessagePolling();

        const empName = id => { const e = employees.find(x => x.id === id); return e ? `${e.first_name} ${e.last_name}` : id; };

        const empMatches = employees.filter(e => `${e.first_name} ${e.last_name} ${e.id} ${e.department || ''}`.toLowerCase().includes(q));
        const claimMatches = claims.filter(c => `${c.claim_id} ${c.damage_type || ''} ${c.carrier_claim_number || ''} ${c.customer_claim_number || ''} ${empName(c.employee_id)}`.toLowerCase().includes(q));
        const chargeMatches = charges.filter(c => `${c.charge_id} ${c.charge_type || ''} ${empName(c.employee_id)}`.toLowerCase().includes(q));
        const incomeMatches = additionalIncome.filter(i => `${i.income_id} ${i.income_type || ''} ${empName(i.employee_id)}`.toLowerCase().includes(q));
        const vehicleMatches = vehicles.filter(v => `${v.truck_number || ''} ${v.make || ''} ${v.model || ''} ${v.plate || ''} ${v.vin || ''}`.toLowerCase().includes(q));

        const totalCount = empMatches.length + claimMatches.length + chargeMatches.length + incomeMatches.length + vehicleMatches.length;
        title.textContent = `Search results for "${raw}" (${totalCount})`;

        if (!totalCount) {
            results.innerHTML = '<div class="panel" style="text-align:center; color:var(--text-muted); padding:30px 16px; font-size:0.85rem;">No matches. Try a different name, ID, or term.</div>';
            return;
        }

        const section = (label, items, renderRow) => !items.length ? '' : `
            <div class="panel" style="padding-bottom:6px;">
                <div style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); margin-bottom:6px;">${label} (${items.length})</div>
                ${items.map(renderRow).join('')}
            </div>`;

        results.innerHTML =
            section('Employees', empMatches, e => `
                <div class="global-search-result" onclick="goToSearchResult('employees','${e.id}')">
                    <span class="type-pill">${escHtml(e.first_name)} ${escHtml(e.last_name)}</span>
                    <span style="font-size:11px; color:var(--text-muted);">${e.id} · ${escHtml(e.person_type || '')}</span>
                </div>`) +
            section('Claims', claimMatches, c => `
                <div class="global-search-result" onclick="goToSearchResult('claims','${c.claim_id}')">
                    <span class="type-pill">${c.claim_id}</span>
                    <span style="font-size:11px; color:var(--text-muted);">${escHtml(empName(c.employee_id))} · ${escHtml(c.damage_type || '')} · ${formatMoney(c.claim_amount)}</span>
                </div>`) +
            section('Charges', chargeMatches, c => `
                <div class="global-search-result" onclick="goToSearchResult('charges','${c.charge_id}')">
                    <span class="type-pill">${c.charge_id}</span>
                    <span style="font-size:11px; color:var(--text-muted);">${escHtml(empName(c.employee_id))} · ${escHtml(c.charge_type || '')} · ${formatMoney(c.amount)}</span>
                </div>`) +
            section('Additional Income', incomeMatches, i => `
                <div class="global-search-result" onclick="goToSearchResult('income','${i.income_id}')">
                    <span class="type-pill">${i.income_id}</span>
                    <span style="font-size:11px; color:var(--text-muted);">${escHtml(empName(i.employee_id))} · ${escHtml(i.income_type || '')} · ${formatMoney(i.amount)}</span>
                </div>`) +
            section('Fleet', vehicleMatches, v => `
                <div class="global-search-result" onclick="goToSearchResult('vehicles','${v.id}')">
                    <span class="type-pill">${escHtml(v.truck_number || v.id)}</span>
                    <span style="font-size:11px; color:var(--text-muted);">${escHtml(v.year || '')} ${escHtml(v.make || '')} ${escHtml(v.model || '')} · ${escHtml(v.plate || '')}</span>
                </div>`);
    }

    // Jumps to the right tab and pre-fills that tab's own search box with
    // an identifying value, so the clicked record is right there instead
    // of just landing on a generic tab. openTab() itself already hides the
    // search-results page like any other tab, so no separate "close" step
    // is needed here anymore.
    function goToSearchResult(kind, id) {
        const map = {
            employees: { tab: 'tab-employees', input: 'employee-search', fn: 'renderEmployees' },
            claims: { tab: 'tab-claims', input: 'cc-search', fn: 'renderClaimsCharges' },
            charges: { tab: 'tab-claims', input: 'cc-search', fn: 'renderClaimsCharges' },
            income: { tab: 'tab-income', input: 'income-search', fn: 'renderIncome' },
            vehicles: { tab: 'tab-vehicles', input: 'vehicle-search', fn: 'renderVehicles' }
        };
        const cfg = map[kind];
        if (!cfg) return;
        openTab(null, cfg.tab);
        // Combined Claims & Charges tab: clear the kind filter so a jumped-to
        // record of either kind is visible regardless of the last filter set.
        if (cfg.tab === 'tab-claims') { const ks = document.getElementById('cc-kind'); if (ks) ks.value = ''; }
        const input = document.getElementById(cfg.input);
        if (input) { input.value = id; }
        if (typeof window[cfg.fn] === 'function') window[cfg.fn]();
        const gsi = document.getElementById('global-search-input');
        if (gsi) gsi.value = '';
    }

    // Version badge tap: open the changelog popup. The history is sourced
    // from the DB (system_changelog — the fuller, shared source of truth),
    // with the in-file CHANGELOG array as an offline / not-signed-in fallback.
    function handleVersionBadgeTap() { toggleVersionLog(); }

    let changelogCache = null;   // DB changelog rows, fetched once per session
    async function toggleVersionLog() {
        const ov = document.getElementById('version-log-overlay');
        if (!ov) return;
        if (ov.style.display === 'flex') { ov.style.display = 'none'; return; }
        const list = document.getElementById('version-log-list');
        if (list) list.innerHTML = '<div style="padding:16px 0; text-align:center; color:var(--text-muted); font-size:12px;">Loading…</div>';
        ov.style.display = 'flex';

        // Prefer the DB-backed history; fall back to the local array when the
        // request fails or nobody's signed in yet (login screen / offline).
        let entries = changelogCache;
        if (!entries) {
            try {
                if (currentUsername && authToken) {
                    const { data, error } = await supabaseClient.rpc('list_system_changelog', { p_actor: currentUsername });
                    if (!error && data && data.length) {
                        entries = data.map(c => ({ version: c.version, date: c.entry_date, notes: c.notes }));
                        changelogCache = entries;
                    }
                }
            } catch (e) { /* fall through to the local array */ }
        }
        if (!entries) entries = CHANGELOG;

        if (list) {
            list.innerHTML = entries.map(c => `
                <div style="padding:10px 0; border-bottom:1px solid var(--border);">
                    <div style="font-weight:700; font-size:13px; color:var(--secondary);">${escHtml(c.version)} <span style="font-weight:400; color:var(--text-muted); font-size:11px;">· ${escHtml(String(c.date || ''))}</span></div>
                    <div style="font-size:12px; color:var(--text); margin-top:3px; line-height:1.4;">${escHtml(c.notes)}</div>
                </div>`).join('');
        }
    }

    // Administration > Changelog tab — same data as the version-badge popup,
    // laid out as the same collapsible cards used everywhere else in the app.
    // Administration > Changelog tab — now sourced entirely from the
    // DB-backed system_changelog table (Super Admin only), so this history
    // persists independently of whatever app file happens to be deployed.
    // The version-badge popup (tap bottom-right) still uses the local
    // CHANGELOG array above — that's a quick glance for any user, unrelated
    // to this SuperAdmin-only tab.
    async function renderChangelogTab() {
        const container = document.getElementById('changelog-tbody');
        if (!container || currentUserRole !== 'SuperAdmin') return;
        container.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">Loading…</div>';
        const { data, error } = await supabaseClient.rpc('list_system_changelog', { p_actor: currentUsername });
        if (error) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">${escHtml(error.message)}</div>`; return; }
        if (!data || !data.length) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_versions')}</div>`; return; }
        container.innerHTML = '';
        data.forEach((c, i) => {
            const open = recExpanded.changelog.has(c.id);
            const isCurrent = i === 0;
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-changelog-${c.id}">
                    <div class="rec-card-head" onclick="toggleRecCard('changelog',${c.id})">
                        <span class="rec-caret" data-caret="changelog-${c.id}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${escHtml(c.version)}</span>
                        <span class="rec-sub">${c.entry_date}</span>
                        <span class="rec-right">${isCurrent ? `<span class="status-badge status-active">${t('d_current')}</span>` : ''}</span>
                    </div>
                    <div class="rec-card-body">
                        <div style="font-size:12px; line-height:1.5;">${escHtml(c.notes)}</div>
                    </div>
                </div>`);
        });
    }
    let dailyView = null;       // { sunday: Date(UTC), year, week }
    let payrollView = null;     // { sunday } — Payroll week selector
    let lastPayrollCalc = [];   // most recent renderPayroll() calc[] — for printAllPayroll
    let statementView = null;   // { sunday } — Statement week selector
    let dailyTableMissing = false;
    const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let settings = { prefix: '3OFL', empDigits: 4, claimDigits: 5, chargeDigits: 5, chargeSuffix: 'D' };
    let filters = { contractor: new Set(), year: new Set(), week: new Set(), date: new Set(), thirdMan: new Set() };
    let expandedState = {};
    let sortState = {
        employees: { key: 'name', dir: 1 }, claims: { key: 'employee', dir: 1 },
        cc: { key: 'employee', dir: 1 },
        charges: { key: 'employee', dir: 1 }, income: { key: 'employee', dir: 1 },
        payroll: { key: 'employee', dir: 1 }, companies: { key: 'name', dir: 1 },
        users: { key: 'username', dir: 1 }, approvals: { key: 'requested', dir: 1 },
        log: { key: 'changed', dir: -1 }, vehicles: { key: 'truck', dir: 1 },
        invoices: { key: 'date', dir: -1 }, bills: { key: 'due', dir: 1 }
    };

    function applySort(list, table, getters) {
        const s = sortState[table];
        if (!s.key || !getters[s.key]) return list;
        const get = getters[s.key];
        return [...list].sort((a, b) => {
            let va = get(a), vb = get(b);
            if (typeof va === 'string') va = va.toLowerCase();
            if (typeof vb === 'string') vb = vb.toLowerCase();
            if (va < vb) return -1 * s.dir;
            if (va > vb) return 1 * s.dir;
            return 0;
        });
    }

    // ===== Shared collapsible record-card list (Employees, Claims, Charges,
    // Income): expand state per table, and a Sort-by dropdown + direction
    // toggle that stands in for the old clickable column headers. =====

    // Cards on phones, a real table on wider screens — every list in the app
    // that uses this pattern checks this before rendering.
    function isDesktopView() { return window.matchMedia('(min-width: 600px)').matches; }

    // Re-render whichever of the 9 card/table tabs is currently open, used
    // when the viewport crosses the mobile/desktop breakpoint (e.g. rotating
    // a tablet) so the layout switches without needing a manual refresh.
    function reRenderActiveCardTable() {
        const active = document.querySelector('.tab-content.active');
        if (!active) return;
        if (active.id === 'tab-income') { renderIncome(); return; }
        const map = {
            'tab-employees': renderEmployees, 'tab-claims': renderClaimsCharges,
            'tab-payroll': renderPayroll, 'tab-users': fetchUsersList,
            'tab-companies': renderCompanies, 'tab-approvals': renderApprovals, 'tab-log': renderLog,
            'tab-vehicles': renderVehicles
            // tab-dailypay has its own dedicated matchMedia listener elsewhere (near renderDailyPay) — not duplicated here.
        };
        const fn = map[active.id];
        if (fn) fn();
    }
    try {
        window.matchMedia('(min-width: 600px)').addEventListener('change', reRenderActiveCardTable);
    } catch (e) { /* older browsers: ignore */ }

    // Shared status-grouping order across Claims/Charges/Income — any
    // status not listed here (e.g. Income's own "Paying"/"Stopped") still
    // groups correctly, just sorted after the known ones alphabetically.
    const REC_STATUS_ORDER = ['Deducting', 'Paying', 'Queued', 'Paid', 'Absorbed', 'Tk from check', 'Stopped'];
    function groupByStatus(list, statusField) {
        statusField = statusField || 'status';
        const groups = {};
        list.forEach(item => {
            const s = item[statusField] || '(no status)';
            if (!groups[s]) groups[s] = [];
            groups[s].push(item);
        });
        const statuses = Object.keys(groups).sort((a, b) => {
            const ia = REC_STATUS_ORDER.indexOf(a), ib = REC_STATUS_ORDER.indexOf(b);
            if (ia === -1 && ib === -1) return a.localeCompare(b);
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        return statuses.map(s => ({ status: s, items: groups[s] }));
    }

    function toggleRecCard(table, id) {
        const set = recExpanded[table];
        const nowOpen = !set.has(id);
        if (nowOpen) set.add(id); else set.delete(id);
        const el = document.getElementById(`rec-${table}-${id}`);
        if (el) {
            el.classList.toggle('open', nowOpen);
            // Desktop detail rows are real <tr> elements whose visibility is
            // driven by an inline display style set at render time (needed
            // so a hidden row doesn't still occupy space in the table) —
            // the 'open' class alone doesn't affect a <tr>, so flip it here too.
            if (el.tagName === 'TR') el.style.display = nowOpen ? 'table-row' : 'none';
        }
        // Caret glyph is plain text set at render time, not CSS-driven, so it
        // has to be updated by hand wherever it appears for this record (a
        // mobile card head and/or a desktop summary row both use the same id).
        document.querySelectorAll(`[data-caret="${table}-${id}"]`).forEach(c => { c.textContent = nowOpen ? '▾' : '▸'; });
    }

    function reRenderRecTable(table) {
        if (table === 'employees') renderEmployees();
        else if (table === 'claims' || table === 'cc' || table === 'charges') renderClaimsCharges();
        else if (table === 'income') renderIncome();
        else if (table === 'payroll') renderPayroll();
        else if (table === 'companies') renderCompanies();
        else if (table === 'users') fetchUsersList();
        else if (table === 'approvals') renderApprovals();
        else if (table === 'log') renderLog();
        else if (table === 'invoices') renderInvoices();
        else if (table === 'bills') renderBills();
    }
    function setSortField(table, key) {
        sortState[table].key = key; sortState[table].dir = 1;
        reRenderRecTable(table);
    }
    function flipSortDir(table) {
        sortState[table].dir *= -1;
        reRenderRecTable(table);
    }
    function updateRecSortUI(table) {
        const s = sortState[table];
        const sel = document.getElementById('sort-select-' + table);
        if (sel && s.key) sel.value = s.key;
        const dirBtn = document.getElementById('sort-dir-' + table);
        if (dirBtn) dirBtn.textContent = s.dir === 1 ? '▲' : '▼';
    }

    const formatMoney = (num) => '$ ' + parseFloat(num || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const numFmt = (num) => parseFloat(num || 0).toFixed(0);

    function getWeekNumber(dStr) {
        if (!dStr) return 1;
        const d = new Date(dStr);
        if (isNaN(d)) return 1;
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
        return Math.ceil(( ( (d - yearStart) / 86400000) + 1)/7);
    }
    function getYear(dStr) {
        if (!dStr) return new Date().getFullYear().toString();
        const d = new Date(dStr);
        return isNaN(d) ? new Date().getFullYear().toString() : d.getUTCFullYear().toString();
    }

    // --- SHARED CLAIM/CHARGE FINANCIALS ---------------------------------
    // A "deduction item" = a claim (amount = claim_amount) or a charge
    // (amount = amount). Both share: weekly_deduction, start_date,
    // status, and (claims only) absorbed_amount.

    // Full weeks elapsed from a start date up to today (never negative).
    function weeksElapsed(startStr) {
        if (!startStr) return 0;
        const start = new Date(startStr);
        if (isNaN(start)) return 0;
        const diffDays = (Date.now() - start.getTime()) / 86400000;
        // The first payment happens ON start_date itself — same convention
        // buildClaimSchedule already uses for claims (proven correct there).
        // This was previously missing the +1, so every charge/income was
        // under-counted by a full week versus how claims already behaved.
        return diffDays < 0 ? 0 : Math.floor(diffDays / 7) + 1;
    }

    // Total weeks needed to pay the item off at its weekly rate.
    function weeksNeeded(amount, weekly) {
        return weekly > 0 ? Math.ceil(amount / weekly) : 0;
    }

    // Auto-calculated end-of-deduction date = start + weeksNeeded*7 days.
    function projectedEndDate(startStr, amount, weekly) {
        if (!startStr || weekly <= 0) return null;
        const start = new Date(startStr);
        if (isNaN(start)) return null;
        const end = new Date(start.getTime());
        end.setDate(end.getDate() + weeksNeeded(amount, weekly) * 7);
        return end.toISOString().split('T')[0];
    }

    // Remaining balance:
    //  - Absorbed -> 0 (written off, genuinely settled)
    //  - otherwise: amount - absorbed - (weekly * weeks paid so far),
    //    where weeks paid is capped at weeksNeeded and at weeksElapsed.
    //    'Tk from check' used to be grouped in as if it meant "settled" —
    //    it doesn't, it just means a different collection method (direct
    //    from a paycheck instead of the weekly schedule). Confirmed against
    //    real data: Tk-from-check items sitting at $0 paid toward a real
    //    amount owed. See claimBalance()/chargeBalance() for the fuller
    //    version of this same fix.
    function remainingBalance(amount, absorbed, weekly, startStr, status) {
        amount = parseFloat(amount || 0);
        absorbed = parseFloat(absorbed || 0);
        weekly = parseFloat(weekly || 0);
        if (status === 'Absorbed') return 0;

        const owedAfterAbsorb = Math.max(0, amount - absorbed);
        const weeksPaid = Math.min(weeksElapsed(startStr), weeksNeeded(owedAfterAbsorb, weekly));
        const paid = weekly * weeksPaid;
        return Math.max(0, owedAfterAbsorb - paid);
    }

    // Same idea as remainingBalance/weeksElapsed but evaluated at a chosen date
    // instead of "now" — used for historical statements (charges + income).
    function weeksElapsedAsOf(startStr, asOfStr) {
        if (!startStr) return 0;
        const start = new Date(startStr);
        const asOf = asOfStr ? new Date(asOfStr) : new Date();
        if (isNaN(start) || isNaN(asOf)) return 0;
        const diffDays = (asOf.getTime() - start.getTime()) / 86400000;
        // Same +1 fix as weeksElapsed above — the week containing start_date
        // is already "week 1", not the week after it.
        return diffDays < 0 ? 0 : Math.floor(diffDays / 7) + 1;
    }
    function remainingBalanceAsOf(amount, weekly, startStr, status, asOfStr) {
        amount = parseFloat(amount || 0); weekly = parseFloat(weekly || 0);
        // A resolved status (written off, paid, or stopped) correctly means
        // $0 owed from today onward — but forcing that for every date,
        // including weeks BEFORE the item was resolved, erased the real
        // deduction history the moment something got resolved. Only apply
        // the shortcut when asOf isn't in the past. 'Tk from check' is
        // deliberately NOT in this list — see remainingBalance() above.
        const viewingPast = asOfStr && asOfStr < todayStr();
        if (!viewingPast && (status === 'Absorbed' || status === 'Paid' || status === 'Stopped')) return 0;
        const weeksPaid = Math.min(weeksElapsedAsOf(startStr, asOfStr), weeksNeeded(amount, weekly));
        return Math.max(0, +(amount - weekly * weeksPaid).toFixed(2));
    }
    // Same reasoning as claimBalanceBefore: the balance ENTERING a given
    // week, not after that week's own deduction — a charge/income item that
    // gets fully paid off in a single week would otherwise show $0 and
    // vanish for the very week it was actually taken.
    function remainingBalanceBefore(amount, weekly, startStr, status, asOfStr) {
        if (!asOfStr) return remainingBalanceAsOf(amount, weekly, startStr, status, asOfStr);
        const d = new Date(asOfStr + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 7);
        return remainingBalanceAsOf(amount, weekly, startStr, status, d.toISOString().split('T')[0]);
    }

    // ===== Claim rate-change / pause history + balance-from-history =====
    let claimRateChanges = {};   // claim_id -> [{id, effective_date, weekly_amount}]
    let claimPauses = {};        // claim_id -> [{id, paused_date, resume_date}]
    let editingClaimId = null;
    let claimHistMissing = false;
    let chargeRateChanges = {};  // charge_id -> [{id, effective_date, weekly_amount}]
    let chargePauses = {};       // charge_id -> [{id, paused_date, resume_date}]
    let editingChargeId = null;
    let chargeHistMissing = false;

    function todayStr() { return new Date().toISOString().split('T')[0]; }

    // ===== Shared deduction engine — claims & charges =====================
    // A claim and a charge are different records with their own IDs, their
    // own tables and their own statuses — but HOW they deduct (base weekly
    // rate, dated rate changes, pause windows, weekly schedule walk, balance
    // as of a date) is ONE shared system, written once below against a
    // per-kind config. Every original function name (claimBalance,
    // chargeRateOn, buildChargeSchedule, renderClaimHistoryPanels, …) still
    // exists as a thin wrapper with the exact same signature, so no call
    // site anywhere else in the file changed.
    const DED_KIND = {
        claim: {
            label: 'claim',
            keyField: 'claim_id',
            idOf: r => r.claim_id,
            owedOf: r => Math.max(0, (parseFloat(r.claim_amount) || 0) - (parseFloat(r.absorbed_amount) || 0)),
            terminal: ['Absorbed', 'Paid'],
            rc: () => claimRateChanges,
            ps: () => claimPauses,
            setHist: (rcm, psm) => { claimRateChanges = rcm; claimPauses = psm; },
            missing: () => claimHistMissing,
            setMissing: v => { claimHistMissing = v; },
            editingId: () => editingClaimId,
            find: id => claims.find(x => x.claim_id === id),
            rerender: () => renderClaims(),
            rpcGetRates: 'get_claim_rate_changes', rpcGetPauses: 'get_claim_pauses',
            rpcAddRate: 'add_claim_rate_change', rpcAddPause: 'add_claim_pause',
            rpcDelRate: 'delete_claim_rate_change_entry', rpcDelPause: 'delete_claim_pause_entry',
            rpcKey: 'p_claim_id',
            dom: { setup: 'claim-hist-setup', cur: 'claim-current-rate', pstat: 'claim-pause-status',
                   rhist: 'rate-history', phist: 'pause-history',
                   rcAmt: 'rc-amount', rcDate: 'rc-date', pDate: 'pause-date', pResume: 'pause-resume' },
            onDelRate: 'deleteRateChange', onDelPause: 'deletePause'
        },
        charge: {
            label: 'charge',
            keyField: 'charge_id',
            idOf: r => r.charge_id,
            owedOf: r => Math.max(0, parseFloat(r.amount) || 0),
            terminal: ['Absorbed', 'Paid', 'Released'],
            rc: () => chargeRateChanges,
            ps: () => chargePauses,
            setHist: (rcm, psm) => { chargeRateChanges = rcm; chargePauses = psm; },
            missing: () => chargeHistMissing,
            setMissing: v => { chargeHistMissing = v; },
            editingId: () => editingChargeId,
            find: id => charges.find(x => x.charge_id === id),
            rerender: () => renderCharges(),
            rpcGetRates: 'get_charge_rate_changes', rpcGetPauses: 'get_charge_pauses',
            rpcAddRate: 'add_charge_rate_change', rpcAddPause: 'add_charge_pause',
            rpcDelRate: 'delete_charge_rate_change_entry', rpcDelPause: 'delete_charge_pause_entry',
            rpcKey: 'p_charge_id',
            dom: { setup: 'charge-hist-setup', cur: 'charge-current-rate', pstat: 'charge-pause-status',
                   rhist: 'charge-rate-history', phist: 'charge-pause-history',
                   rcAmt: 'chrc-amount', rcDate: 'chrc-date', pDate: 'chpause-date', pResume: 'chpause-resume' },
            onDelRate: 'deleteChargeRateChange', onDelPause: 'deleteChargePause'
        }
    };

    async function _dedLoadHistory(cfg) {
        cfg.setMissing(false);
        try {
            const rq = supabaseClient.rpc(cfg.rpcGetRates, { p_actor: currentUsername, p_company: currentCompany });
            const pq = supabaseClient.rpc(cfg.rpcGetPauses, { p_actor: currentUsername, p_company: currentCompany });
            const [{ data: rc, error: re }, { data: pc, error: pe }] = await Promise.all([rq, pq]);
            if (re && isMissingTable(re)) { cfg.setMissing(true); return; }
            if (pe && isMissingTable(pe)) { cfg.setMissing(true); return; }
            // Build into local objects and swap the shared ones in at the end
            // (same reasoning as loadCurrentWeekDaily) so an overlapping call
            // can't interleave duplicate rows into these lists.
            const rateChanges = {}, pauses = {};
            (rc || []).forEach(r => { (rateChanges[r[cfg.keyField]] = rateChanges[r[cfg.keyField]] || []).push(r); });
            (pc || []).forEach(p => { (pauses[p[cfg.keyField]] = pauses[p[cfg.keyField]] || []).push(p); });
            cfg.setHist(rateChanges, pauses);
        } catch (e) { console.error('loadHistory(' + cfg.label + '):', e); }
    }
    async function loadClaimHistory() { return _dedLoadHistory(DED_KIND.claim); }
    async function loadChargeHistory() { return _dedLoadHistory(DED_KIND.charge); }

    // Applicable weekly rate on a given date: the record's base rate,
    // overridden by the most recent rate change on/before that date.
    function _dedRateOn(cfg, rec, dateStr) {
        let rate = parseFloat(rec.weekly_deduction) || 0;
        const changes = (cfg.rc()[cfg.idOf(rec)] || []).slice()
            .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));
        for (const ch of changes) {
            if (String(ch.effective_date) <= dateStr) rate = parseFloat(ch.weekly_amount) || 0;
            else break;
        }
        return rate;
    }
    // Only counts as "a future rate exists" when a rate change actually takes
    // effect AFTER this date with a positive amount. This branch is only
    // reached once the CURRENT rate has resolved to $0, which for a record
    // with any rate-change history means something already zeroed it out —
    // the untouched original base value must not keep the schedule walking
    // forward indefinitely (that could run to the 2000-week guard limit —
    // decades of empty $0 weeks — whenever a rate history ends at $0, e.g.
    // an in-progress savings goal whose deposit history stops before the
    // goal is reached). This was originally fixed on the charge side only;
    // the engine now applies the same rule to both kinds, which is the one
    // deliberate behavior alignment in this consolidation — balances are
    // unchanged either way (verified by golden tests), only the phantom
    // $0-week tail disappears from claim schedules too.
    function _dedFutureRateExists(cfg, rec, dateStr) {
        return (cfg.rc()[cfg.idOf(rec)] || []).some(ch => String(ch.effective_date) > dateStr && (parseFloat(ch.weekly_amount) || 0) > 0);
    }
    // Is a deduction date inside any recorded pause window [paused, resume)?
    function _dedPausedOn(cfg, rec, dateStr) {
        return (cfg.ps()[cfg.idOf(rec)] || []).some(p => {
            const start = String(p.paused_date || '');
            const end = p.resume_date ? String(p.resume_date) : null;
            return start && dateStr >= start && (!end || dateStr < end);
        });
    }

    // Build the full weekly deduction schedule from start_date until the
    // balance reaches $0, applying rate changes and skipping pause weeks.
    // No resolved-status shortcut here on purpose — _dedBalance() already
    // handles "resolved, so $0 as of today/future" on its own before ever
    // calling this. This function's job is to walk the REAL recorded
    // history (start_date, rate changes, pauses) and show it — that history
    // doesn't stop being real just because the record later got marked
    // Paid/Absorbed, and callers that want the full schedule table
    // (Statement, printing) need it regardless of current status.
    function _dedBuildSchedule(cfg, rec, asOf) {
        const owed = cfg.owedOf(rec);
        const rows = [];
        if (!rec.start_date || owed <= 0) {
            return { rows, owed, balanceAsOf: owed, endDate: null };
        }
        let bal = owed;
        let d = new Date(rec.start_date + 'T00:00:00Z');
        if (isNaN(d)) return { rows, owed, balanceAsOf: owed, endDate: null };
        // An Inactive employee has no more paycheck to ever deduct from, so
        // weeks past their last real one aren't just hidden for display —
        // they were never going to happen at all. Stopping the walk here
        // keeps Statement/printing from projecting phantom future
        // deductions too, not just the balance number.
        const incomeStopped = incomeStoppedDate(rec.employee_id);
        let guard = 0;
        while (bal > 0.004 && guard < 2000) {
            guard++;
            const ds = d.toISOString().split('T')[0];
            if (incomeStopped && ds > incomeStopped) break;
            if (_dedPausedOn(cfg, rec, ds)) {
                rows.push({ date: ds, deducted: 0, balance: +bal.toFixed(2), paused: true });
            } else {
                const rate = _dedRateOn(cfg, rec, ds);
                if (rate <= 0) { if (!_dedFutureRateExists(cfg, rec, ds)) break; }
                const ded = Math.min(rate, bal);
                bal = +(bal - ded).toFixed(2);
                rows.push({ date: ds, deducted: ded, balance: bal, paused: false });
            }
            d.setUTCDate(d.getUTCDate() + 7);
        }
        const endDate = rows.length ? rows[rows.length - 1].date : null;
        let balanceAsOf = owed;
        if (asOf) {
            let paid = 0;
            rows.forEach(r => { if (r.date <= asOf) paid += r.deducted; });
            balanceAsOf = Math.max(0, +(owed - paid).toFixed(2));
        } else {
            balanceAsOf = bal;
        }
        return { rows, owed, balanceAsOf, endDate };
    }

    // Current balance, honoring rate changes + pauses. 'Tk from check' is
    // NOT a resolved status — it only means the money comes straight from
    // the paycheck rather than the weekly schedule; such a record can still
    // have a real unpaid balance. Only genuinely-terminal statuses (per
    // kind: Absorbed/Paid, plus Released for charges) force $0 today.
    function _dedBalance(cfg, rec, asOf) {
        const owed = cfg.owedOf(rec);
        const viewingPast = asOf && asOf < todayStr();
        if (!viewingPast && cfg.terminal.includes(rec.status)) return 0;
        if (rec.status === 'Queued') return owed;
        return _dedBuildSchedule(cfg, rec, asOf || todayStr()).balanceAsOf;
    }
    // Balance ENTERING a given week (i.e. as of the end of the previous
    // week) — distinct from the balance AFTER that week's own deduction.
    // A record fully paid off in a single week has balance()==0 for that
    // very week, which would hide that a deduction happened at all; this
    // answers "was there money to deduct entering this week?" instead.
    function _dedBalanceBefore(cfg, rec, asOf) {
        if (!asOf) return _dedBalance(cfg, rec, asOf);
        const d = new Date(asOf + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() - 7);
        return _dedBalance(cfg, rec, d.toISOString().split('T')[0]);
    }

    // ---- claim-named wrappers (signatures unchanged) ----
    function rateOn(claim, dateStr) { return _dedRateOn(DED_KIND.claim, claim, dateStr); }
    function futureRateExists(claim, dateStr) { return _dedFutureRateExists(DED_KIND.claim, claim, dateStr); }
    function isPausedOn(claim, dateStr) { return _dedPausedOn(DED_KIND.claim, claim, dateStr); }
    function buildClaimSchedule(claim, asOf) { return _dedBuildSchedule(DED_KIND.claim, claim, asOf); }
    function claimBalance(claim, asOf) { return _dedBalance(DED_KIND.claim, claim, asOf); }
    function claimBalanceBefore(claim, asOf) { return _dedBalanceBefore(DED_KIND.claim, claim, asOf); }
    function claimCurrentRate(claim) { return _dedRateOn(DED_KIND.claim, claim, todayStr()); }
    // ---- charge-named wrappers (signatures unchanged) ----
    function chargeRateOn(charge, dateStr) { return _dedRateOn(DED_KIND.charge, charge, dateStr); }
    function chargeFutureRateExists(charge, dateStr) { return _dedFutureRateExists(DED_KIND.charge, charge, dateStr); }
    function isChargePausedOn(charge, dateStr) { return _dedPausedOn(DED_KIND.charge, charge, dateStr); }
    function buildChargeSchedule(charge, asOf) { return _dedBuildSchedule(DED_KIND.charge, charge, asOf); }
    function chargeBalance(charge, asOf) { return _dedBalance(DED_KIND.charge, charge, asOf); }
    function chargeBalanceBefore(charge, asOf) { return _dedBalanceBefore(DED_KIND.charge, charge, asOf); }
    function chargeCurrentRate(charge) { return _dedRateOn(DED_KIND.charge, charge, todayStr()); }

    // ---- shared rate-change / pause history panel + handlers ----
    function _dedRenderHistPanels(cfg) {
        const editing = cfg.editingId();
        if (!editing) return;
        const rec = cfg.find(editing);
        if (!rec) return;
        const setup = document.getElementById(cfg.dom.setup);
        if (setup) setup.style.display = cfg.missing() ? 'block' : 'none';
        document.getElementById(cfg.dom.cur).innerHTML = `${formatMoney(_dedRateOn(cfg, rec, todayStr()))} / wk <span style="opacity:.7;">(current)</span> · balance ${formatMoney(_dedBalance(cfg, rec))}`;
        const paused = _dedPausedOn(cfg, rec, todayStr());
        document.getElementById(cfg.dom.pstat).innerHTML = `Current: <span class="status-badge status-${paused ? 'Paused' : 'Deducting'}">${paused ? 'Paused' : 'Active'}</span>`;

        const rc = (cfg.rc()[cfg.idOf(rec)] || []).slice().sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)));
        document.getElementById(cfg.dom.rhist).innerHTML = rc.length
            ? `<table style="width:100%; font-size:12px;"><thead><tr><th style="text-align:left;">${t('d_th_effective')}</th><th style="text-align:left;">${t('d_th_weekly')}</th><th></th></tr></thead><tbody>${rc.map(r => `<tr><td>${r.effective_date}</td><td>${formatMoney(r.weekly_amount)}</td><td style="text-align:right;"><span class="del-btn" onclick="${cfg.onDelRate}(${r.id})">✕</span></td></tr>`).join('')}</tbody></table>`
            : `<div style="font-size:12px;color:var(--text-muted);">${t('d_no_rate_changes')}</div>`;

        const ph = (cfg.ps()[cfg.idOf(rec)] || []).slice().sort((a, b) => String(a.paused_date).localeCompare(String(b.paused_date)));
        document.getElementById(cfg.dom.phist).innerHTML = ph.length
            ? `<table style="width:100%; font-size:12px;"><thead><tr><th style="text-align:left;">${t('d_th_paused')}</th><th style="text-align:left;">${t('d_th_resume')}</th><th></th></tr></thead><tbody>${ph.map(p => `<tr><td>${p.paused_date}</td><td>${p.resume_date || '—'}</td><td style="text-align:right;"><span class="del-btn" onclick="${cfg.onDelPause}(${p.id})">✕</span></td></tr>`).join('')}</tbody></table>`
            : `<div style="font-size:12px;color:var(--text-muted);">${t('d_no_pauses')}</div>`;
    }
    function _dedHistCompany(cfg) {
        const rec = cfg.find(cfg.editingId());
        return (rec && rec.company_code) ? rec.company_code : writeCompany();
    }
    async function _dedAddRateChange(cfg) {
        const editing = cfg.editingId();
        if (!editing) return;
        const amt = parseFloat(document.getElementById(cfg.dom.rcAmt).value);
        const date = document.getElementById(cfg.dom.rcDate).value;
        if (!date || isNaN(amt)) { alert('Enter both a new weekly amount and an effective date.'); return; }
        if (amt < 0) { alert('Weekly amount cannot be negative.'); return; }
        const existing = cfg.rc()[editing] || [];
        if (existing.some(r => r.effective_date === date)) {
            alert(`There's already a rate change effective ${date} for this ${cfg.label}. Remove the existing one first if you want to replace it.`);
            return;
        }
        const params = { p_actor: currentUsername, p_company: _dedHistCompany(cfg), p_effective_date: date, p_weekly_amount: amt };
        params[cfg.rpcKey] = editing;
        const { error } = await supabaseClient.rpc(cfg.rpcAddRate, params);
        if (error) { if (isMissingTable(error)) { cfg.setMissing(true); _dedRenderHistPanels(cfg); } else alert('Error: ' + error.message); return; }
        document.getElementById(cfg.dom.rcAmt).value = ''; document.getElementById(cfg.dom.rcDate).value = '';
        await _dedLoadHistory(cfg); _dedRenderHistPanels(cfg); cfg.rerender();
    }
    async function _dedRecordPause(cfg) {
        const editing = cfg.editingId();
        if (!editing) return;
        const date = document.getElementById(cfg.dom.pDate).value;
        const resume = document.getElementById(cfg.dom.pResume).value || null;
        if (!date) { alert('Enter a paused date.'); return; }
        if (resume && resume <= date) { alert('Expected resume date must be after the paused date.'); return; }
        const existing = cfg.ps()[editing] || [];
        const overlaps = existing.some(p => {
            const pStart = p.paused_date, pEnd = p.resume_date;
            // Two [start, end) windows overlap unless one ends before the other starts
            // (an open-ended existing or new pause is treated as extending to infinity).
            const newEndsBeforeExisting = resume && resume <= pStart;
            const existingEndsBeforeNew = pEnd && pEnd <= date;
            return !(newEndsBeforeExisting || existingEndsBeforeNew);
        });
        if (overlaps) { alert(`This overlaps with an existing pause window for this ${cfg.label}. Remove or adjust the existing one first.`); return; }
        const params = { p_actor: currentUsername, p_company: _dedHistCompany(cfg), p_paused_date: date, p_resume_date: resume };
        params[cfg.rpcKey] = editing;
        const { error } = await supabaseClient.rpc(cfg.rpcAddPause, params);
        if (error) { if (isMissingTable(error)) { cfg.setMissing(true); _dedRenderHistPanels(cfg); } else alert('Error: ' + error.message); return; }
        document.getElementById(cfg.dom.pDate).value = ''; document.getElementById(cfg.dom.pResume).value = '';
        await _dedLoadHistory(cfg); _dedRenderHistPanels(cfg); cfg.rerender();
    }
    async function _dedDeleteRateChange(cfg, rid) {
        if (rid === undefined || rid === null) { alert('Error: could not identify which rate change to delete — try refreshing the page.'); return; }
        if (!confirm('Remove this rate change?')) return;
        const { error } = await supabaseClient.rpc(cfg.rpcDelRate, { p_actor: currentUsername, p_id: rid });
        if (error) { alert('Error: ' + error.message); return; }
        await _dedLoadHistory(cfg); _dedRenderHistPanels(cfg); cfg.rerender();
    }
    async function _dedDeletePause(cfg, pid) {
        if (pid === undefined || pid === null) { alert('Error: could not identify which pause to delete — try refreshing the page.'); return; }
        if (!confirm('Remove this pause record?')) return;
        const { error } = await supabaseClient.rpc(cfg.rpcDelPause, { p_actor: currentUsername, p_id: pid });
        if (error) { alert('Error: ' + error.message); return; }
        await _dedLoadHistory(cfg); _dedRenderHistPanels(cfg); cfg.rerender();
    }

    // Opens/closes the mobile off-canvas drawer. Desktop never calls this —
    // the hamburger button that triggers it is CSS-hidden there (the
    // sidebar is always open on desktop instead).
    function toggleMobileDrawer(forceClose) {
        const drawer = document.getElementById('app-sidebar');
        const scrim = document.getElementById('mobile-drawer-scrim');
        if (!drawer || !scrim) return;
        const shouldOpen = forceClose ? false : !drawer.classList.contains('drawer-open');
        drawer.classList.toggle('drawer-open', shouldOpen);
        scrim.classList.toggle('show', shouldOpen);
    }

    function openTab(evt, tabName) {
        toggleMobileDrawer(true); // picking a tab always closes the drawer, whether it was open or not — a no-op on desktop since drawer-open is never set there
        // View Only users may only open their 6 permitted tabs.
        if (currentUserRole === 'User') {
            const allowed = ['tab-notifications','tab-employees','tab-claims','tab-income','tab-weekdeposit','tab-statement','tab-payroll','tab-messages','tab-expiring'];
            if (!allowed.includes(tabName)) return;
        }
        document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
        if (tabName !== 'tab-messages') stopMessagePolling();
        document.getElementById(tabName).classList.add('active');
        if(evt && evt.currentTarget) evt.currentTarget.classList.add('active');
        if(tabName === 'tab-notifications') renderNotifications();
        if(tabName === 'tab-vehicles') renderVehicles();
        if(tabName === 'tab-messages') renderMessagesTab();
        if(tabName === 'tab-claims') renderClaimsCharges();
        if(tabName === 'tab-income') renderIncome();
        if(tabName === 'tab-weekdeposit') renderWeekDeposit();
        if(tabName === 'tab-report') renderDailyReport();
        if(tabName === 'tab-users') { fetchUsersList(); loadSessions(); loadLoginAttempts(); loadGlobalSignoutHistory(); }
        if(tabName === 'tab-statement') populateStatementDropdown();
        if(tabName === 'tab-dailypay') renderDailyPay();
        if(tabName === 'tab-providerpay') renderProviderPay();
        if(tabName === 'tab-employees' && typeof updateNextEmpId === 'function') updateNextEmpId();
        if(tabName === 'tab-payroll') renderPayroll();
        if(tabName === 'tab-companies') loadCompanies();
        if(tabName === 'tab-approvals') { renderApprovals(); renderReleaseRequests(); }
        if(tabName === 'tab-log') renderLog();
        if(tabName === 'tab-settings') renderSettingsLists();
        if(tabName === 'tab-expiring') renderExpiringDocuments();
        if(tabName === 'tab-invoices') renderInvoices();
        if(tabName === 'tab-savingsreport') renderSavingsReleaseReport();
        if(tabName === 'tab-releasehistory') fetchReleaseHistory();
        if(tabName === 'tab-bills') renderBills();
        if(tabName === 'tab-changelog') renderChangelogTab();
        if(tabName === 'tab-home') renderHomeDashboard();
    }

    // Home isn't part of the group system (TAB_GROUPS) — it's a standalone
    // top-level nav item styled like a group button but always leading
    // straight to its one tab, same as Notifications/Messages already do
    // with the .tab-btn styling further down the sidebar. openTab() only
    // ever manages .tab-btn's active highlight, not .group-btn's (that's
    // openGroup()'s job) — so a plain openTab(event,'tab-home') call would
    // highlight Home without ever clearing whichever real group was
    // previously active, leaving two nav items highlighted at once. This
    // wrapper clears that state first, and collapses whatever group's
    // sub-tab row was open, so Home always leaves the nav in a clean,
    // unambiguous state.
    function openHomeTab(evt) {
        document.querySelectorAll('.group-btn').forEach(b => b.classList.remove('active'));
        if (evt && evt.currentTarget) evt.currentTarget.classList.add('active');
        document.querySelectorAll('.tabs.sub-tabs:not(#grp-notifications):not(#grp-messages)').forEach(g => g.classList.remove('open'));
        openTab(evt, 'tab-home');
    }
