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
    const APP_VERSION = 'v3.51';
    const CHANGELOG = [
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

    // ===== Two-level nav: which tabs live under which group =====
    const TAB_GROUPS = {
        'grp-logistics': ['tab-tracker', 'tab-report', 'tab-vehicles'],
        'grp-hr': ['tab-employees', 'tab-claims', 'tab-income', 'tab-weekdeposit', 'tab-dailypay', 'tab-providerpay', 'tab-statement', 'tab-payroll', 'tab-savingsreport', 'tab-releasehistory'],
        'grp-expiring': ['tab-expiring'],
        'grp-financial': ['tab-invoices', 'tab-bills'],
        'grp-admin': ['tab-settings', 'tab-users', 'tab-companies', 'tab-approvals', 'tab-log', 'tab-data', 'tab-changelog']
    };

    // Open a group: show its sub-tab row, hide the others, and switch to its
    // first tab that's actually visible for this role.
    function openGroup(groupId) {
        // #grp-notifications/#grp-messages share the .tabs.sub-tabs class
        // for visual styling but are NOT part of the toggle system — they're
        // permanently-open standalone sections above the account bar, so
        // they're excluded here to avoid getting closed by this sweep.
        document.querySelectorAll('.tabs.sub-tabs:not(#grp-notifications):not(#grp-messages)').forEach(g => g.classList.remove('open'));
        document.querySelectorAll('.group-btn').forEach(b => b.classList.remove('active'));
        const g = document.getElementById(groupId);
        if (g) g.classList.add('open');
        const gbtn = document.getElementById('btn-' + groupId);
        if (gbtn) gbtn.classList.add('active');

        // On the mobile drawer (<900px — the same breakpoint the sidebar's
        // own CSS switches on), tapping a group header should only reveal
        // its sub-tab list so the person can then pick one. Auto-navigating
        // into the first sub-tab here was closing the whole drawer before
        // they ever got a chance to see or tap any of the other options,
        // since openTab() always closes the drawer as its very first step.
        // Desktop keeps the auto-select-first-tab behavior below — there's
        // no drawer to lose there, and it gives a sensible default view.
        if (!window.matchMedia('(min-width: 900px)').matches) return;

        const tabs = TAB_GROUPS[groupId] || [];
        const firstVisible = tabs.find(t => {
            const b = document.getElementById('btn-' + t);
            return b && b.style.display !== 'none';
        });
        if (firstVisible) {
            const btnEl = document.getElementById('btn-' + firstVisible);
            openTab({ currentTarget: btnEl }, firstVisible);
        }
    }

    // Run after role-based tab visibility is decided: hide any group with no
    // visible tabs, and expand whichever group holds the currently active tab
    // (so a role-driven landing tab, like View Only's Employees, opens under
    // the right group automatically).
    function refreshGroupVisibility() {
        // If Home is the tab actually showing, leave it alone entirely —
        // it isn't part of TAB_GROUPS, so without this check the fallback
        // below (which always picks SOME group to highlight when it can't
        // find the active tab in any group's list) would strip Home's own
        // active highlight and incorrectly light up Logistics instead,
        // even though Logistics' content isn't what's on screen. Same
        // bug shape as #13 in memory — a new element not accounted for by
        // an existing sweep/fallback written before it existed.
        const homeContent = document.getElementById('tab-home');
        if (homeContent && homeContent.classList.contains('active')) return;

        let activeGroup = null;
        Object.keys(TAB_GROUPS).forEach(groupId => {
            const tabs = TAB_GROUPS[groupId];
            const anyVisible = tabs.some(t => {
                const b = document.getElementById('btn-' + t);
                return b && b.style.display !== 'none';
            });
            const gbtn = document.getElementById('btn-' + groupId);
            if (gbtn) gbtn.style.display = anyVisible ? 'inline-block' : 'none';
            tabs.forEach(t => {
                const content = document.getElementById(t);
                if (content && content.classList.contains('active')) activeGroup = groupId;
            });
        });
        if (!activeGroup) {
            activeGroup = Object.keys(TAB_GROUPS).find(gid => {
                const b = document.getElementById('btn-' + gid);
                return b && b.style.display !== 'none';
            });
        }
        if (activeGroup) {
            document.querySelectorAll('.tabs.sub-tabs:not(#grp-notifications):not(#grp-messages)').forEach(g => g.classList.remove('open'));
            document.querySelectorAll('.group-btn').forEach(b => b.classList.remove('active'));
            const g = document.getElementById(activeGroup);
            if (g) g.classList.add('open');
            const gbtn = document.getElementById('btn-' + activeGroup);
            if (gbtn) gbtn.classList.add('active');
        }
    }

    // Show/hide the login password. Swaps the input type and the eye icon
    // (open eye = currently hidden/click to show, slashed eye = currently shown).
    function toggleLoginPassword() {
        const input = document.getElementById('login-password');
        const btn = document.getElementById('login-password-toggle');
        const icon = document.getElementById('login-eye-icon');
        if (!input || !icon) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        icon.innerHTML = show
            ? '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/><line x1="3" y1="3" x2="21" y2="21"/>'
            : '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>';
        if (btn) { btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); btn.setAttribute('title', show ? 'Hide password' : 'Show password'); }
        input.focus();
    }

    async function handleLoginClick() {
        const usernameInput = document.getElementById('login-username').value.trim().toLowerCase();
        const passwordInput = document.getElementById('login-password').value;
        const errEl = document.getElementById('login-error');
        
        errEl.textContent = '';
        try {
            const { data, error } = await rpcResilient('verify_login', { p_username: usernameInput, p_password: passwordInput });

            if (error) {
                // verify_login only raises for the lockout case -- a wrong
                // password just returns zero rows, handled below -- so any
                // error here is safe to show verbatim (e.g. "Too many failed
                // attempts. Try again in a few minutes.").
                errEl.textContent = _isNetworkErr(error)
                    ? 'Network problem — check your connection and try again.'
                    : (error.message || 'Invalid username or password.');
            } else if (!data || data.length === 0) {
                errEl.textContent = 'Invalid username or password.';
            } else if (data[0].requires_2fa) {
                // Password OK but the account has 2FA — ask for the code before
                // any session is issued (the server returned only a pending token).
                pendingLogin = { pending_token: data[0].pending_token, username: data[0].username };
                showLogin2faStep();
            } else {
                finalizeLogin(data[0]);
            }
        } catch (err) {
            console.error('Login request failed:', err);
            errEl.textContent = 'Could not reach the login server: ' + (err && err.message ? err.message : err);
        }
    }

    // ===== Two-factor authentication (TOTP) =====
    // The server split login into two steps for enrolled accounts: verify_login
    // returns a pending token instead of a session, and verify_login_2fa exchanges
    // a valid 6-digit (or recovery) code for the real session. Non-enrolled
    // accounts are unaffected. Medium+ roles are asked to enroll on sign-in.
    let pendingLogin = null;         // { pending_token, username } between the two login steps
    let enroll2faState = null;       // { otpauth_uri, mandatory } during enrollment

    function showLogin2faStep() {
        document.getElementById('login-error').textContent = '';
        document.getElementById('login-credentials-step').style.display = 'none';
        document.getElementById('login-2fa-step').style.display = 'block';
        const c = document.getElementById('login-2fa-code');
        c.value = '';
        setTimeout(() => c.focus(), 30);
    }

    function cancelLogin2fa() {
        pendingLogin = null;
        document.getElementById('login-2fa-step').style.display = 'none';
        document.getElementById('login-credentials-step').style.display = 'block';
        document.getElementById('login-error').textContent = '';
        document.getElementById('login-password').value = '';
    }

    async function submitLoginCode() {
        if (!pendingLogin) { cancelLogin2fa(); return; }
        const errEl = document.getElementById('login-error');
        const btn = document.getElementById('login-2fa-btn');
        const code = document.getElementById('login-2fa-code').value.trim();
        errEl.textContent = '';
        if (!code) { errEl.textContent = 'Enter the 6-digit code.'; return; }
        btn.disabled = true;
        try {
            const { data, error } = await rpcResilient('verify_login_2fa', {
                p_pending_token: pendingLogin.pending_token, p_code: code
            });
            if (error) {
                // Only the per-account lockout raises here.
                errEl.textContent = _isNetworkErr(error)
                    ? 'Network problem — check your connection and tap Verify again.'
                    : (error.message || 'Could not verify the code.');
            } else if (!data || data.length === 0) {
                errEl.textContent = 'Incorrect or expired code. Try again, or go back and sign in again.';
                const c = document.getElementById('login-2fa-code'); c.value = ''; c.focus();
            } else {
                pendingLogin = null;
                document.getElementById('login-2fa-step').style.display = 'none';
                document.getElementById('login-credentials-step').style.display = 'block';
                finalizeLogin(data[0]);
            }
        } catch (err) {
            console.error('2FA verify failed:', err);
            errEl.textContent = 'Could not reach the server: ' + (err && err.message ? err.message : err);
        } finally {
            btn.disabled = false;
        }
    }

    // Shared tail for both login paths: adopt the session row and start the app.
    function finalizeLogin(row) {
        currentUser = row;
        currentUsername = row.username;
        currentUserRole = row.role;
        authToken = row.session_token;
        currentUser.token_expires_at = Date.now() + TOKEN_TTL_MS;
        localStorage.setItem('unified_user', JSON.stringify(currentUser));
        initAppSession();
        // Medium+ accounts without 2FA are reminded to set it up — but only when
        // their 15-day snooze isn't active (each "Skip for now" snoozes it), so we
        // nudge every 15 days rather than every sign-in, and never force it.
        // Otherwise surface any unusual sign-in activity.
        if (row.must_enroll_2fa && !twofaSnoozeActive(row.twofa_snooze_until)) startTwofaEnroll(true);
        else maybeShowSecurityAlert(row.recent_fail_count);
    }

    // Is the 2FA-reminder snooze still in the future?
    function twofaSnoozeActive(ts) {
        if (!ts) return false;
        const t = new Date(ts).getTime();
        return !isNaN(t) && Date.now() < t;
    }

    // ===== Unusual-activity heads-up (shown once after sign-in) =====
    function showSecurityAlert(bodyHtml, actions) {
        document.getElementById('security-alert-body').innerHTML = bodyHtml;
        const actEl = document.getElementById('security-alert-actions');
        actEl.innerHTML = '';
        (actions || []).forEach(a => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = a.primary ? 'btn' : 'btn-small';
            b.textContent = a.label;
            b.onclick = () => { closeSecurityAlert(); if (a.fn) a.fn(); };
            actEl.appendChild(b);
        });
        document.getElementById('security-alert-overlay').style.display = 'flex';
    }
    function closeSecurityAlert() { document.getElementById('security-alert-overlay').style.display = 'none'; }

    // Warn about (a) your own account's recent failed sign-ins, and (b) for
    // admins, any account/network with many recent failures. "Many" = hit
    // lockout (5/account, 30/network -> locked_until set) or 10+ failures, in
    // the last 24h. Shows one combined pop-up only when something qualifies.
    async function maybeShowSecurityAlert(recentFailCount) {
        const parts = [];
        const actions = [];
        const mine = parseInt(recentFailCount, 10) || 0;
        if (mine >= 5) {
            parts.push(`<p style="margin:0 0 10px;">There ${mine === 1 ? 'was' : 'were'} <strong>${mine}</strong> failed sign-in attempt${mine === 1 ? '' : 's'} on <strong>your account</strong> recently. If that wasn't you, change your password now.</p>`);
            actions.push({ label: '🔑 Change my password', primary: true, fn: () => toggleChangePasswordCard() });
        }
        // Medium and above are shown which accounts/networks look suspicious,
        // named (username + employee ID), not just a count.
        if (currentUserRole === 'Medium' || currentUserRole === 'Administrator' || currentUserRole === 'SuperAdmin') {
            let flagged = [];
            try {
                const { data } = await supabaseClient.rpc('list_login_attempts', { p_actor: currentUsername });
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                flagged = (data || []).filter(r => {
                    const recent = r.last_fail_at && new Date(r.last_fail_at).getTime() >= cutoff;
                    const heavy = !!r.locked_until || (r.fail_count || 0) >= 10;
                    return recent && heavy;
                });
            } catch (e) { console.error('security scan failed:', e); }
            if (flagged.length) {
                const MAX = 8;
                const items = flagged.slice(0, MAX).map(r => {
                    if (r.kind === 'network') {
                        return `<li>Network <strong>${escHtml(r.subject)}</strong> — ${r.fail_count} failed</li>`;
                    }
                    const id = r.emp_id ? ` <span style="color:var(--text-muted);">(${escHtml(r.emp_id)})</span>` : '';
                    return `<li><strong>${escHtml(r.subject)}</strong>${id} — ${r.fail_count} failed</li>`;
                }).join('');
                const more = flagged.length > MAX ? `<li>…and ${flagged.length - MAX} more</li>` : '';
                parts.push(`<p style="margin:0 0 6px;">These accounts or networks had many failed sign-ins in the last 24 hours:</p>
                    <ul style="margin:0 0 10px; padding-left:18px;">${items}${more}</ul>`);
                actions.push({ label: '🔎 Review sign-ins', primary: mine < 5, fn: () => openFailedSignins() });
            }
        }
        if (!parts.length) return;
        actions.push({ label: 'Dismiss', primary: false, fn: null });
        showSecurityAlert(parts.join(''), actions);
    }

    // Jump to Administration -> Users and open the failed sign-ins panel.
    function openFailedSignins() {
        try {
            openGroup('grp-admin');
            openTab({ currentTarget: document.getElementById('btn-tab-users') }, 'tab-users');
        } catch (e) { console.error(e); }
        setTimeout(() => {
            const bodyEl = document.getElementById('login-attempts-body');
            const panel = bodyEl && bodyEl.closest('.panel');
            if (panel) panel.classList.remove('collapsed');
        }, 80);
    }

    // ===== Sign Out All Users (global sign-out with grace period) =====
    let gsoPollTimer = null, gsoTickTimer = null, activeGlobalSignout = null, gsoChannel = null;

    // Best-effort Realtime "poke": when an admin starts/cancels a global sign-out,
    // a broadcast tells every open client to re-check immediately (~1s) instead of
    // waiting for the next 20s poll. The poll remains the guaranteed fallback, and
    // every Realtime call is wrapped so a Realtime hiccup never affects the app.
    function pokeGlobalSignout() {
        try { if (gsoChannel) gsoChannel.send({ type: 'broadcast', event: 'poke', payload: {} }); } catch (e) {}
    }

    function openGlobalSignoutModal() {
        document.getElementById('gso-scope-label').textContent =
            (currentUserRole === 'SuperAdmin') ? t('gso_scope_all') : t('gso_scope_company');
        document.getElementById('gso-reason').value = '';
        document.getElementById('gso-confirm').value = '';
        document.getElementById('gso-modal-error').textContent = '';
        document.getElementById('gso-grace').value = '300';
        document.getElementById('global-signout-modal').style.display = 'flex';
    }
    function closeGlobalSignoutModal() { document.getElementById('global-signout-modal').style.display = 'none'; }

    async function submitGlobalSignout() {
        const errEl = document.getElementById('gso-modal-error');
        errEl.textContent = '';
        if ((document.getElementById('gso-confirm').value || '').trim().toUpperCase() !== 'SIGN OUT ALL') {
            errEl.textContent = 'Type SIGN OUT ALL to confirm.'; return;
        }
        const grace = parseInt(document.getElementById('gso-grace').value, 10) || 300;
        const reason = (document.getElementById('gso-reason').value || '').trim();
        const btn = document.getElementById('gso-submit-btn'); btn.disabled = true;
        try {
            const { data, error } = await rpcResilient('initiate_global_signout', {
                p_actor: currentUsername, p_reason: reason || null, p_grace_seconds: grace
            });
            if (error) {
                errEl.textContent = _isNetworkErr(error) ? 'Network problem — try again.' : error.message;
                return;
            }
            closeGlobalSignoutModal();
            checkGlobalSignout(); // show the banner immediately for the initiator
            pokeGlobalSignout();  // and tell everyone else to re-check now
        } catch (e) {
            errEl.textContent = 'Could not reach the server: ' + (e && e.message ? e.message : e);
        } finally { btn.disabled = false; }
    }

    async function adminCancelGlobalSignout() {
        if (!activeGlobalSignout) return;
        if (!confirm('Cancel the scheduled sign-out for everyone?')) return;
        try {
            await rpcResilient('cancel_global_signout', { p_actor: currentUsername, p_id: activeGlobalSignout.id });
        } catch (e) { /* poll will reconcile */ }
        checkGlobalSignout();
        pokeGlobalSignout();  // clear everyone else's banner promptly
    }

    function startGlobalSignoutPoll() {
        stopGlobalSignoutPoll();
        checkGlobalSignout();
        gsoPollTimer = setInterval(checkGlobalSignout, 20000);
        // Realtime fast path (best-effort; poll above is the safety net).
        try {
            gsoChannel = supabaseClient.channel('global-signout', { config: { broadcast: { self: true } } })
                .on('broadcast', { event: 'poke' }, () => checkGlobalSignout())
                .subscribe();
        } catch (e) { gsoChannel = null; }
    }
    function stopGlobalSignoutPoll() {
        if (gsoPollTimer) { clearInterval(gsoPollTimer); gsoPollTimer = null; }
        if (gsoTickTimer) { clearInterval(gsoTickTimer); gsoTickTimer = null; }
        try { if (gsoChannel) supabaseClient.removeChannel(gsoChannel); } catch (e) {}
        gsoChannel = null;
    }

    // Poll for a pending global sign-out affecting me.
    async function checkGlobalSignout() {
        if (!authToken) return;
        let data, error;
        try { ({ data, error } = await supabaseClient.rpc('get_active_global_signout', { p_actor: currentUsername })); }
        catch (e) { return; } // transient network — try next tick
        if (error) {
            // The deadline passed and the server invalidated this session.
            if (/signed out by an administrator/i.test(error.message || '')) logout('global');
            return;
        }
        const ev = data && data[0];
        if (ev) {
            activeGlobalSignout = { id: ev.id, effective_at: new Date(ev.effective_at).getTime(), reason: ev.reason, initiated_by: ev.initiated_by };
            if (!gsoTickTimer) { tickGlobalSignout(); gsoTickTimer = setInterval(tickGlobalSignout, 1000); }
        } else {
            hideGlobalSignoutBanner(); // none pending (or cancelled)
        }
    }

    function hideGlobalSignoutBanner() {
        activeGlobalSignout = null;
        if (gsoTickTimer) { clearInterval(gsoTickTimer); gsoTickTimer = null; }
        document.getElementById('global-signout-banner').style.display = 'none';
    }

    function tickGlobalSignout() {
        if (!activeGlobalSignout) return;
        const banner = document.getElementById('global-signout-banner');
        const remaining = Math.ceil((activeGlobalSignout.effective_at - Date.now()) / 1000);
        if (remaining <= 0) {
            document.getElementById('gso-banner-text').textContent = 'Signing you out…';
            if (gsoTickTimer) { clearInterval(gsoTickTimer); gsoTickTimer = null; }
            logout('global');
            return;
        }
        const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
        const ss = String(remaining % 60).padStart(2, '0');
        // Warning states: amber >60s, red ≤60s, critical (pulse) ≤30s.
        let bg = '#b45309';
        if (remaining <= 30) bg = '#7f1d1d';
        else if (remaining <= 60) bg = '#b91c1c';
        banner.style.background = bg;
        banner.style.animation = remaining <= 30 ? 'gsoPulse 1s ease-in-out infinite' : 'none';
        const reason = activeGlobalSignout.reason ? ` Reason: ${escHtml(activeGlobalSignout.reason)}.` : '';
        document.getElementById('gso-banner-text').innerHTML =
            `⚠️ You will be signed out in <span style="font-variant-numeric:tabular-nums;">${mm}:${ss}</span>.${reason} Save your work now — unsaved changes will be lost.`;
        // Admins can call it off.
        const canCancel = (currentUserRole === 'Administrator' || currentUserRole === 'SuperAdmin');
        document.getElementById('gso-banner-cancel').style.display = canCancel ? 'inline-block' : 'none';
        banner.style.display = 'block';
    }

    async function loadGlobalSignoutHistory() {
        const body = document.getElementById('gso-history-body');
        const count = document.getElementById('gso-history-count');
        if (!body) return;
        body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_loading')}</div>`;
        const { data, error } = await supabaseClient.rpc('list_global_signouts', { p_actor: currentUsername });
        if (error) { body.innerHTML = `<div style="grid-column:1/-1; color:#ef4444; padding:10px;">${escHtml(error.message)}</div>`; return; }
        const rows = data || [];
        if (count) count.textContent = `(${rows.length})`;
        if (!rows.length) { body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_no_gso')}</div>`; return; }
        const trs = rows.map(r => {
            const st = r.status === 'scheduled' ? '<span class="status-badge status-active">scheduled</span>'
                     : r.status === 'cancelled' ? '<span class="exp-pill">cancelled</span>'
                     : '<span class="exp-pill exp-over">completed</span>';
            return `<tr>
                <td>${escHtml(r.initiated_by)}</td>
                <td style="white-space:nowrap;">${new Date(r.initiated_at).toLocaleString()}</td>
                <td>${escHtml(r.scope_company || t('d_all_companies'))}</td>
                <td style="text-align:center;">${Math.round((r.grace_seconds||0)/60)}m</td>
                <td style="text-align:center;">${r.affected_count == null ? '-' : r.affected_count}</td>
                <td>${st}</td>
                <td>${escHtml(r.reason || '')}</td>
            </tr>`;
        }).join('');
        body.className = '';
        body.innerHTML = `<div class="table-wrapper"><table><thead><tr>
            <th>${t('d_th_initiator')}</th><th>${t('sort_when')}</th><th>${t('d_th_scope')}</th><th>${t('d_th_grace')}</th><th>${t('d_th_affected')}</th><th>${t('status_field')}</th><th>${t('d_th_reason')}</th>
        </tr></thead><tbody>${trs}</tbody></table></div>`;
    }

    // Begin enrollment: fetch a fresh secret + otpauth URI and show the overlay.
    // mandatory=true hides Cancel (a required setup can't be dismissed).
    // Set to true when a Medium+ user chooses "Skip for now" — lasts only for
    // this page-load, so they're prompted again on their next sign-in.
    let twofaEnrollSkipped = false;

    async function startTwofaEnroll(mandatory) {
        if (mandatory && twofaEnrollSkipped) return;   // don't re-open after a same-session skip
        enroll2faState = { mandatory: !!mandatory };
        document.getElementById('twofa-enroll-step1').style.display = 'block';
        document.getElementById('twofa-enroll-step2').style.display = 'none';
        document.getElementById('twofa-enroll-error').textContent = '';
        document.getElementById('twofa-confirm-code').value = '';
        document.getElementById('twofa-recovery-ack').checked = false;
        document.getElementById('twofa-done-btn').disabled = true;
        document.getElementById('twofa-secret-key').textContent = '…';
        document.getElementById('twofa-enroll-intro').textContent = mandatory
            ? t('twofa_intro_mandatory')
            : t('twofa_intro_optional');
        // Mandatory: always offer a way out (Skip / Sign out) so a network glitch
        // can never trap the account. Optional: a plain Cancel.
        document.getElementById('twofa-enroll-cancel-btn').style.display = mandatory ? 'none' : 'inline-block';
        document.getElementById('twofa-enroll-skip-btn').style.display = mandatory ? 'inline-block' : 'none';
        document.getElementById('twofa-enroll-signout-btn').style.display = mandatory ? 'inline-block' : 'none';
        document.getElementById('twofa-enroll-retry-btn').style.display = 'none';
        document.getElementById('twofa-enroll-overlay').style.display = 'flex';
        const verifyBtn = document.getElementById('twofa-enroll-verify-btn');
        verifyBtn.disabled = true;
        const { data, error } = await rpcResilient('begin_2fa_enrollment', { p_actor: currentUsername });
        if (error) {
            document.getElementById('twofa-enroll-error').textContent = _isNetworkErr(error)
                ? 'Network problem — couldn’t start setup. Check your connection and tap Try again.'
                : error.message;
            document.getElementById('twofa-enroll-retry-btn').style.display = 'inline-block';
            return;
        }
        const row = data && data[0];
        if (!row) {
            document.getElementById('twofa-enroll-error').textContent = 'Could not start enrollment.';
            document.getElementById('twofa-enroll-retry-btn').style.display = 'inline-block';
            return;
        }
        enroll2faState.otpauth_uri = row.otpauth_uri;
        document.getElementById('twofa-secret-key').textContent = row.secret_base32;
        document.getElementById('twofa-otpauth-link').href = row.otpauth_uri;
        verifyBtn.disabled = false;
        setTimeout(() => document.getElementById('twofa-confirm-code').focus(), 40);
    }

    // "Skip for now": let them into the app, and snooze the reminder 15 days so
    // they're nudged again next time rather than on every sign-in.
    async function skipTwofaEnroll() {
        twofaEnrollSkipped = true;
        enroll2faState = null;
        window._twofaRecovery = null;
        document.getElementById('twofa-enroll-overlay').style.display = 'none';
        try {
            const { data } = await rpcResilient('skip_2fa_enrollment', { p_actor: currentUsername });
            if (currentUser && typeof data === 'string' && data) {
                currentUser.twofa_snooze_until = data;   // scalar timestamptz from the RPC
                try { localStorage.setItem('unified_user', JSON.stringify(currentUser)); } catch (e) {}
            }
        } catch (e) { /* best-effort; the gate re-checks next login */ }
    }

    function copy2faKey() {
        const k = document.getElementById('twofa-secret-key').textContent;
        try { navigator.clipboard.writeText(k); } catch (e) {}
    }

    async function confirm2faEnrollment() {
        const errEl = document.getElementById('twofa-enroll-error');
        const code = document.getElementById('twofa-confirm-code').value.trim();
        errEl.textContent = '';
        if (!/^[0-9]{6}$/.test(code)) { errEl.textContent = 'Enter the 6-digit code from your app.'; return; }
        const btn = document.getElementById('twofa-enroll-verify-btn'); btn.disabled = true;
        try {
            const { data, error } = await rpcResilient('confirm_2fa', { p_actor: currentUsername, p_code: code });
            if (error) {
                // Keep the typed code so the user can just tap Verify again.
                errEl.textContent = _isNetworkErr(error)
                    ? 'Network problem — check your connection and tap Verify again.'
                    : error.message;
                return;
            }
            const codes = (data || []).map(r => r.recovery_code);
            window._twofaRecovery = codes;
            document.getElementById('twofa-recovery-codes').innerHTML = codes.map(c => `<div>${escHtml(c)}</div>`).join('');
            document.getElementById('twofa-enroll-step1').style.display = 'none';
            document.getElementById('twofa-enroll-step2').style.display = 'block';
        } finally { btn.disabled = false; }
    }

    function copyRecoveryCodes() {
        try { navigator.clipboard.writeText((window._twofaRecovery || []).join('\n')); } catch (e) {}
    }

    function finishTwofaEnroll() {
        if (!document.getElementById('twofa-recovery-ack').checked) return;
        window._twofaRecovery = null;
        // Reflect enrolled state so the mandatory gate won't reappear on restore.
        if (currentUser) {
            currentUser.must_enroll_2fa = false;
            currentUser.twofa_snooze_until = null;
            try { localStorage.setItem('unified_user', JSON.stringify(currentUser)); } catch (e) {}
        }
        enroll2faState = null;
        document.getElementById('twofa-enroll-overlay').style.display = 'none';
    }

    function closeTwofaEnroll() {
        if (enroll2faState && enroll2faState.mandatory) return;  // required setup can't be cancelled
        enroll2faState = null;
        window._twofaRecovery = null;
        document.getElementById('twofa-enroll-overlay').style.display = 'none';
    }

    // ===== 2FA management (account menu) =====
    async function openTwofaManage() {
        const card = document.getElementById('twofa-manage-card');
        const body = document.getElementById('twofa-manage-body');
        body.innerHTML = 'Checking…';
        card.style.display = 'block';
        try {
            const { data, error } = await supabaseClient.rpc('my_2fa_status', { p_actor: currentUsername });
            if (error) { body.textContent = error.message; return; }
            if (data === true) {
                body.innerHTML = `
                    <div style="color:var(--secondary); font-weight:700; margin-bottom:8px;">🔐 Two-factor authentication is ON for your account.</div>
                    <div style="font-size:0.83rem; margin-bottom:8px;">To turn it off, enter a current 6-digit code or one of your recovery codes:</div>
                    <input type="text" id="twofa-disable-code" inputmode="numeric" autocomplete="one-time-code" placeholder="Code" maxlength="20" style="letter-spacing:0.12em;">
                    <p id="twofa-disable-error" style="color:#ef4444; font-size:0.83rem; margin:0.4rem 0 0;"></p>
                    <button class="btn-small" style="background:#b91c1c; color:#fff; margin-top:6px;" onclick="submitDisable2fa()">Turn off 2FA</button>`;
            } else {
                body.innerHTML = `
                    <div style="margin-bottom:10px; color:var(--text);">Two-factor authentication adds a second step at sign-in — a 6-digit code from your phone — so a stolen password alone isn't enough.</div>
                    <button class="btn-small" style="background:var(--navy);" onclick="closeTwofaManage(); startTwofaEnroll(false);">Set up now</button>`;
            }
        } catch (err) {
            body.textContent = 'Could not reach the server: ' + (err && err.message ? err.message : err);
        }
    }

    function closeTwofaManage() { document.getElementById('twofa-manage-card').style.display = 'none'; }

    async function submitDisable2fa() {
        const errEl = document.getElementById('twofa-disable-error');
        const code = (document.getElementById('twofa-disable-code').value || '').trim();
        errEl.textContent = '';
        if (!code) { errEl.textContent = 'Enter a current or recovery code.'; return; }
        try {
            const { error } = await rpcResilient('disable_2fa', { p_actor: currentUsername, p_target: null, p_code: code });
            if (error) {
                errEl.textContent = _isNetworkErr(error)
                    ? 'Network problem — check your connection and try again.'
                    : error.message;
                return;
            }
            alert('Two-factor authentication has been turned off.');
            closeTwofaManage();
        } catch (err) {
            errEl.textContent = 'Could not reach the server: ' + (err && err.message ? err.message : err);
        }
    }

    // Admin reset: turn off another user's 2FA (device-lost recovery). Server
    // restricts this to Administrator/SuperAdmin.
    async function resetUser2FA(usernameToReset) {
        if (!confirm(`Turn off two-factor authentication for "${usernameToReset}"?\n\nUse this only if they lost their device. They'll be asked to set it up again next time they sign in (if their role requires it).`)) return;
        try {
            const { error } = await supabaseClient.rpc('disable_2fa', { p_actor: currentUsername, p_target: usernameToReset });
            if (error) { alert(error.message); return; }
            alert(`Two-factor authentication was reset for "${usernameToReset}".`);
            fetchUsersList();
        } catch (err) {
            alert('Could not reach the server: ' + (err && err.message ? err.message : err));
        }
    }

    // Title bar: "{Company} / Tracker — Unified Logistics · HR · Claims" when a
    // company is in context, else the base title. Works for every company: a
    // regular user shows their own; SuperAdmin shows whichever they've switched
    // to (and the base title on "All companies").
    function updateAppTitle() {
        const base = 'Tracker — Unified Logistics · HR · Claims';
        let coName = '';
        if (currentUser && currentUser.company_name) {
            coName = currentUser.company_name;
        } else if (currentCompany) {
            const c = (typeof companies !== 'undefined' ? companies : []).find(x => x.code === currentCompany);
            coName = c ? c.name : currentCompany;
        }
        const full = coName ? `${coName} / ${base}` : base;
        const titleEl = document.getElementById('app-title');
        if (titleEl) titleEl.textContent = full;   // in-app header — unchanged
        // Window / tab title. An installed PWA's OS title bar is composed as
        // "{manifest app name} + {document.title}", and the app name (a
        // "Tracker …" brand) is cached by the OS at install time — so to avoid
        // ANY doubling we keep only the company name in the installed-window
        // title (never "Tracker" or the tagline, which the app name already
        // carries). A normal browser tab has no prepend, so show the full brand.
        const tagline = base.replace(/^Tracker\s*[—-]\s*/, ''); // "Unified Logistics · HR · Claims"
        let standalone = false;
        try {
            const mm = window.matchMedia;
            standalone = !!(mm && (mm('(display-mode: standalone)').matches
                || mm('(display-mode: window-controls-overlay)').matches
                || mm('(display-mode: minimal-ui)').matches))
                || window.navigator.standalone === true;
        } catch (e) {}
        document.title = standalone
            ? (coName || '')                                  // OS supplies the app name
            : (coName ? `${coName} · ${tagline}` : `Tracker — ${tagline}`);
    }

    function initAppSession() {
        document.getElementById('auth-container').style.display = 'none';
        const authBg = document.getElementById('auth-bg'); if (authBg) authBg.style.display = 'none';
        document.getElementById('app-container').style.display = 'block';
        document.body.classList.add('logged-in'); // drives the desktop sidebar CSS (see #app-sidebar rules)
        const welcomeName = (currentUser && currentUser.first_name)
            ? `${currentUser.first_name} ${currentUser.last_name || ''}`.trim()
            : currentUsername;
        document.getElementById('user-name-display').textContent = welcomeName;
        document.getElementById('user-role-display').textContent = currentUserRole;
        const companyLabel = (currentUser && currentUser.company_name) ? currentUser.company_name : (currentUserRole === 'SuperAdmin' ? 'All companies' : (currentUser && currentUser.company_code) || '—');
        document.getElementById('user-company-display').textContent = companyLabel;
        updateAppTitle();

        // Company scope: non-super users are locked to their own company.
        // SuperAdmin starts on "All" (null) and can switch via the dropdown.
        if (currentUserRole === 'SuperAdmin') {
            currentCompany = null;
            document.getElementById('company-switcher-wrap').style.display = 'flex';
            document.getElementById('btn-tab-companies').style.display = 'inline-block';
            document.getElementById('btn-tab-users').style.display = 'inline-block';
            document.getElementById('btn-tab-log').style.display = 'inline-block';
            document.getElementById('btn-tab-approvals').style.display = 'inline-block';
            document.getElementById('btn-tab-changelog').style.display = 'inline-block';
            document.getElementById('admin-danger-zone').style.display = 'block';
            document.getElementById('superadmin-danger-zone').style.display = 'block';
            loadCompanies();
        } else {
            currentCompany = currentUser ? currentUser.company_code : null;
            loadCompanies();   // so Company dropdowns can show the name, not just the code
        }

        if (currentUserRole === 'Administrator' || currentUserRole === 'Medium') {
            document.getElementById('btn-tab-users').style.display = 'inline-block';
            document.getElementById('btn-tab-log').style.display = 'inline-block';
        }
        if (currentUserRole === 'Administrator') {
            document.getElementById('admin-danger-zone').style.display = 'block';
            document.getElementById('btn-tab-approvals').style.display = 'inline-block';
            document.getElementById('btn-tab-companies').style.display = 'inline-block';
        }
        populateUserRoleOptions();

        // View Only (User): restrict to 5 tabs of their own data; no editing.
        if (currentUserRole === 'User') {
            ['btn-tab-home','btn-tab-tracker','btn-tab-report','btn-tab-vehicles','btn-tab-settings','btn-tab-data','btn-tab-dailypay','btn-tab-providerpay','btn-tab-invoices','btn-tab-bills','btn-tab-savingsreport','btn-tab-releasehistory'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.display = 'none';
            });
            // Land on Employees (their own record) instead of the hidden tracker.
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            const empTab = document.getElementById('tab-employees');
            const empBtn = document.getElementById('btn-tab-employees');
            if (empTab) empTab.classList.add('active');
            if (empBtn) empBtn.classList.add('active');
            // Hide create-record forms (View Only can't add anything).
            ['employee-form','claim-form','charge-form','income-form'].forEach(id => {
                const f = document.getElementById(id);
                if (f) {
                    f.style.display = 'none';
                    // also hide the form's section heading panel wrapper if present
                }
            });
        }

        refreshGroupVisibility();

        fetchAllDataFromCloud().catch(function(err) {
            console.error('Data sync failed:', err);
            showDiagBanner('could not sync data (' + (err && err.message ? err.message : err) + ')');
        });

        startIdleWatch();
        startGlobalSignoutPoll();
    }

    function checkExistingSession() {
        const saved = localStorage.getItem('unified_user');
        if (saved) {
            try {
                currentUser = JSON.parse(saved);
                // A restored session needs a live token; if it's missing or past its
                // estimated expiry, drop it and fall back to the login screen rather
                // than running with a dead token that every RPC would reject.
                if (!currentUser.session_token ||
                    (currentUser.token_expires_at && Date.now() > currentUser.token_expires_at)) {
                    localStorage.removeItem('unified_user');
                    currentUser = null;
                    return;
                }
                currentUsername = currentUser.username;
                currentUserRole = currentUser.role;
                authToken = currentUser.session_token;
                initAppSession();
                // Same 15-day reminder gate on a restored session.
                if (currentUser.must_enroll_2fa && !twofaSnoozeActive(currentUser.twofa_snooze_until)) startTwofaEnroll(true);
            } catch(e) {
                console.error('Session restore failed:', e);
                localStorage.removeItem('unified_user');
            }
        }
    }

    function logout(reason) {
        stopIdleWatch();
        stopGlobalSignoutPoll();
        // Best-effort: invalidate the server-side session so the token can't be reused.
        try { if (authToken) supabaseClient.rpc('end_session', { p_token: authToken }); } catch (e) {}
        authToken = null;
        localStorage.removeItem('unified_user');
        if (reason === 'idle') sessionStorage.setItem('logout_reason', 'idle');
        if (reason === 'global') sessionStorage.setItem('logout_reason', 'global');
        location.reload();
    }

    // ===== Idle session timeout: 10 minutes of no activity signs the user out,
    // with a 30s warning first so in-progress form entries aren't lost silently. =====
    const IDLE_LIMIT_MS = 10 * 60 * 1000;
    const IDLE_WARNING_MS = 30 * 1000;
    let idleTimer = null, idleWarnTimer = null, idleCountdownInt = null;

    function resetIdleTimer() {
        if (!currentUsername) return; // only runs while signed in
        clearTimeout(idleTimer); clearTimeout(idleWarnTimer); clearInterval(idleCountdownInt);
        const overlay = document.getElementById('idle-warning-overlay');
        if (overlay) overlay.style.display = 'none';
        idleWarnTimer = setTimeout(showIdleWarning, IDLE_LIMIT_MS - IDLE_WARNING_MS);
        idleTimer = setTimeout(() => logout('idle'), IDLE_LIMIT_MS);
    }

    function showIdleWarning() {
        const overlay = document.getElementById('idle-warning-overlay');
        const cd = document.getElementById('idle-countdown');
        if (!overlay || !cd) return;
        let secsLeft = Math.round(IDLE_WARNING_MS / 1000);
        cd.textContent = secsLeft;
        overlay.style.display = 'flex';
        idleCountdownInt = setInterval(() => {
            secsLeft -= 1;
            if (cd) cd.textContent = Math.max(secsLeft, 0);
            if (secsLeft <= 0) clearInterval(idleCountdownInt);
        }, 1000);
    }

    function staySignedIn() { resetIdleTimer(); }

    function startIdleWatch() {
        ['click', 'keydown', 'touchstart', 'scroll', 'input'].forEach(evt =>
            document.addEventListener(evt, resetIdleTimer, { passive: true })
        );
        resetIdleTimer();
    }
    function stopIdleWatch() {
        clearTimeout(idleTimer); clearTimeout(idleWarnTimer); clearInterval(idleCountdownInt);
    }

    function toggleUserMenu(evt) {
        if (evt) evt.stopPropagation();
        const dd = document.getElementById('user-menu-dropdown');
        const btn = document.getElementById('user-menu-btn');
        if (!dd || !btn) return;
        const opening = dd.style.display === 'none' || !dd.style.display;
        if (opening) {
            // Position from the button's real on-screen location instead of
            // relying on CSS right:0 relative to its wrapper — on mobile
            // the wrapper doesn't always sit at the header's right edge,
            // which was pushing the dropdown partly off-screen.
            const r = btn.getBoundingClientRect();
            const ddWidth = 190;
            let left = r.right - ddWidth;
            left = Math.max(10, Math.min(left, window.innerWidth - ddWidth - 10));
            dd.style.position = 'fixed';
            dd.style.top = (r.bottom + 6) + 'px';
            dd.style.left = left + 'px';
            dd.style.right = 'auto';
            dd.style.bottom = 'auto';
            dd.style.width = ddWidth + 'px';
            dd.style.minWidth = '0';
        }
        dd.style.display = opening ? 'block' : 'none';
    }
    // Close the menu on any click elsewhere, and on Escape.
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('user-menu-dropdown');
        const btn = document.getElementById('user-menu-btn');
        if (dd && dd.style.display === 'block' && !dd.contains(e.target) && e.target !== btn) {
            dd.style.display = 'none';
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const dd = document.getElementById('user-menu-dropdown');
            if (dd) dd.style.display = 'none';
        }
    });

    function toggleChangePasswordCard() {
        const card = document.getElementById('change-password-card');
        const isHidden = card.style.display === 'none';
        card.style.display = isHidden ? 'block' : 'none';
        document.getElementById('cp-current-pass').value = '';
        document.getElementById('cp-new-pass').value = '';
        document.getElementById('cp-confirm-pass').value = '';
        document.getElementById('cp-error').textContent = '';
    }

    async function submitChangePassword() {
        const currentPass = document.getElementById('cp-current-pass').value;
        const newPass = document.getElementById('cp-new-pass').value;
        const confirmPass = document.getElementById('cp-confirm-pass').value;
        const errEl = document.getElementById('cp-error');
        errEl.textContent = '';

        if (!currentPass) {
            errEl.textContent = 'Enter your current password.';
            return;
        }
        if (!newPass || newPass.length < 8) {
            errEl.textContent = 'New password must be at least 8 characters.';
            return;
        }
        if (newPass !== confirmPass) {
            errEl.textContent = 'Passwords do not match.';
            return;
        }

        try {
            const { error } = await supabaseClient.rpc('change_own_password', {
                p_username: currentUsername, p_current_password: currentPass, p_new_password: newPass
            });
            if (error) {
                errEl.textContent = error.message;
            } else {
                alert('Password updated successfully.');
                toggleChangePasswordCard();
            }
        } catch (err) {
            errEl.textContent = 'Could not reach the server: ' + (err && err.message ? err.message : err);
        }
    }

    let currentCompany = null;   // SuperAdmin's selected filter; null = all
    let companies = [];

    // Which company_code should a newly created record use?
    function writeCompany() {
        if (currentUserRole === 'SuperAdmin') return currentCompany;
        return currentUser ? currentUser.company_code : null;
    }
    function requireWriteCompany() {
        const c = writeCompany();
        if (!c) { alert('Select a specific company first (top-right dropdown) before adding records.'); return null; }
        return c;
    }

    async function loadCompanies() {
        const { data, error } = await supabaseClient.rpc('list_companies', { p_actor: currentUsername });
        if (error) { console.error('list_companies:', error); companies = []; }
        else companies = data || [];
        // Non-super users are locked to their own company — never surface others'.
        if (currentUserRole !== 'SuperAdmin' && currentUser && currentUser.company_code) {
            companies = companies.filter(c => c.code === currentUser.company_code);
        }
        const sw = document.getElementById('company-switcher');
        if (sw) {
            sw.innerHTML = '<option value="">All companies</option>';
            companies.forEach(c => sw.insertAdjacentHTML('beforeend', `<option value="${c.code}">${c.name} (${c.code})</option>`));
            sortSelectAZ(sw);
            sw.value = currentCompany || '';
        }
        populateCompanySelects();
        renderCompanies();
        updateAppTitle();  // company names are now loaded — refresh the SuperAdmin title
    }

    function onCompanySwitch() {
        const v = document.getElementById('company-switcher').value;
        currentCompany = v || null;
        updateAppTitle();
        populateCompanySelects();
        updateNextEmpId();
        refreshIdPreviews();
        fetchAllDataFromCloud();
    }

    function refreshIdPreviews() {
        const cd = document.getElementById('next-claim-id-display');
        if (cd) cd.textContent = idPrefix() ? `${idPrefix()}${String(claims.length + 1).padStart(settings.claimDigits, '0')}` : '— select company —';
        const gd = document.getElementById('next-charge-id-display');
        if (gd) gd.textContent = idPrefix() ? `${idPrefix()}${String(charges.length + 1).padStart(settings.chargeDigits, '0')}${settings.chargeSuffix}` : '— select company —';
        const idisp = document.getElementById('next-income-id-display');
        if (idisp) idisp.textContent = idPrefix() ? `${idPrefix()}${String(additionalIncome.length + 1).padStart(settings.chargeDigits, '0')}I` : '— select company —';
    }

    let editingCompanyCode = null;

    function renderCompanies() {
        const container = document.getElementById('companies-tbody');
        if (!container) return;
        // Administrators only ever see their own company here (loadCompanies
        // already scopes the list), and never get the create-new-company form.
        const formPanel = document.getElementById('company-form-panel');
        if (formPanel) formPanel.style.display = (currentUserRole === 'SuperAdmin' || editingCompanyCode) ? 'block' : 'none';

        const list = applySort(companies, 'companies', {
            name: c => c.name || '', code: c => c.code || '',
            owner: c => c.owner || '', manager: c => c.manager || '',
            created: c => c.created_at || ''
        });

        if (isDesktopView()) {
            container.className = '';
            if (!list.length) { container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_companies')}</div>`; return; }
            let rows = '';
            list.forEach(c => {
                const canEditThis = currentUserRole === 'SuperAdmin' || (currentUserRole === 'Administrator' && currentUser && currentUser.company_code === c.code);
                let actions = '';
                if (canEditThis) actions += `<button class="btn-small" style="background:var(--navy);margin:0 3px 0 0;" onclick="editCompany('${c.code}')">${t('d_edit')}</button>`;
                if (currentUserRole === 'SuperAdmin') actions += `<button class="del-btn" onclick="deleteCompany('${c.code}')">✕</button>`;
                rows += `<tr>
                    <td class="id-cell">${c.code}</td>
                    <td>${c.name}</td>
                    <td>${c.owner || '-'}</td>
                    <td>${escHtml(c.phone || '-')}</td>
                    <td>${escHtml(c.email || '-')}</td>
                    <td>${c.manager || '-'}</td>
                    <td>${c.manager_phone || '-'}</td>
                    <td>${new Date(c.created_at).toLocaleDateString()}</td>
                    <td style="text-align:center; white-space:nowrap;">${actions}</td>
                </tr>`;
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th>${t('sort_code')}</th><th>${t('d_th_name')}</th><th>${t('owner_label')}</th><th>${t('d_phone')}</th><th>${t('d_email')}</th><th>${t('manager_label')}</th><th>${t('d_manager_phone')}</th><th>${t('d_created')}</th><th>${t('th_action')}</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`;
            updateRecSortUI('companies');
            return;
        }

        container.className = 'record-grid';
        container.innerHTML = list.length ? '' : `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_companies')}</div>`;
        list.forEach(c => {
            const open = recExpanded.companies ? recExpanded.companies.has(c.code) : false;
            const canEditThis = currentUserRole === 'SuperAdmin' || (currentUserRole === 'Administrator' && currentUser && currentUser.company_code === c.code);
            let actions = '';
            if (canEditThis) actions += `<button class="btn-small" style="background:var(--navy);margin:0;" onclick="editCompany('${c.code}')">${t('d_edit')}</button>`;
            if (currentUserRole === 'SuperAdmin') actions += `<button class="del-btn" onclick="deleteCompany('${c.code}')">${t('d_delete')}</button>`;
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-companies-${c.code}">
                    <div class="rec-card-head" onclick="toggleRecCard('companies','${c.code}')">
                        <span class="rec-caret" data-caret="companies-${c.code}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${c.name}</span>
                        <span class="rec-sub">${c.code}</span>
                    </div>
                    <div class="rec-card-body">
                        <div class="rec-detail-grid">
                            <div><div class="k">${t('owner_label')}</div><div class="v">${c.owner || '-'}</div></div>
                            <div><div class="k">${t('d_phone')}</div><div class="v">${escHtml(c.phone || '-')}</div></div>
                            <div><div class="k">${t('d_email')}</div><div class="v">${escHtml(c.email || '-')}</div></div>
                            <div><div class="k">${t('manager_label')}</div><div class="v">${c.manager || '-'}</div></div>
                            <div><div class="k">${t('d_manager_phone')}</div><div class="v">${c.manager_phone || '-'}</div></div>
                            <div><div class="k">${t('d_created')}</div><div class="v">${new Date(c.created_at).toLocaleDateString()}</div></div>
                        </div>
                        ${actions ? `<div class="rec-actions">${actions}</div>` : ''}
                    </div>
                </div>`);
        });
        updateRecSortUI('companies');
    }

    function editCompany(code) {
        const canEditThis = currentUserRole === 'SuperAdmin' || (currentUserRole === 'Administrator' && currentUser && currentUser.company_code === code);
        if (!canEditThis) return;
        const c = companies.find(x => x.code === code);
        if (!c) return;
        editingCompanyCode = code;
        document.getElementById('company-form-panel').style.display = 'block';
        document.getElementById('new-company-code').value = c.code;
        document.getElementById('new-company-code').disabled = true; // code can't change once created
        document.getElementById('new-company-name').value = c.name || '';
        document.getElementById('new-company-name').disabled = (currentUserRole !== 'SuperAdmin'); // name changes are Super Admin-only
        document.getElementById('new-company-owner').value = c.owner || '';
        document.getElementById('new-company-phone').value = c.phone || '';
        document.getElementById('new-company-email').value = c.email || '';
        document.getElementById('new-company-manager').value = c.manager || '';
        document.getElementById('new-company-manager-phone').value = c.manager_phone || '';
        document.getElementById('company-form-titletext').textContent = `${t('editing_prefix')} ${c.name} — ${c.code}`;
        document.getElementById('company-save-btn').textContent = t('save_changes_plain');
        document.getElementById('company-cancel-btn').style.display = 'inline-block';
        document.getElementById('tab-companies').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function cancelCompanyEdit() {
        editingCompanyCode = null;
        ['new-company-code','new-company-name','new-company-owner','new-company-phone','new-company-email','new-company-manager','new-company-manager-phone'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        document.getElementById('new-company-code').disabled = false;
        document.getElementById('new-company-name').disabled = false;
        document.getElementById('company-form-titletext').textContent = t('add_company_title');
        document.getElementById('company-save-btn').textContent = t('add_company_btn');
        document.getElementById('company-cancel-btn').style.display = 'none';
        if (currentUserRole !== 'SuperAdmin') document.getElementById('company-form-panel').style.display = 'none';
    }

    async function createCompany() {
        const code = document.getElementById('new-company-code').value.trim().toUpperCase();
        const name = document.getElementById('new-company-name').value.trim();
        const owner = document.getElementById('new-company-owner').value.trim();
        const phone = document.getElementById('new-company-phone').value.trim();
        const email = document.getElementById('new-company-email').value.trim();
        const manager = document.getElementById('new-company-manager').value.trim();
        const managerPhone = document.getElementById('new-company-manager-phone').value.trim();
        if (code.length < 3 || code.length > 4) { alert('Company code must be 3 or 4 characters.'); return; }
        if (!name) { alert('Enter a company name.'); return; }

        if (editingCompanyCode) {
            const { error } = await supabaseClient.rpc('edit_company', {
                p_actor: currentUsername, p_code: editingCompanyCode, p_name: name,
                p_owner: owner || null, p_phone: phone || null, p_email: email || null,
                p_manager: manager || null, p_manager_phone: managerPhone || null
            });
            if (error) { alert('Error: ' + error.message); return; }
            cancelCompanyEdit();
            loadCompanies();
            return;
        }

        const { data, error } = await supabaseClient.rpc('create_company', {
            p_actor: currentUsername, p_code: code, p_name: name,
            p_owner: owner || null, p_phone: phone || null, p_email: email || null,
            p_manager: manager || null, p_manager_phone: managerPhone || null
        });
        if (error) { alert('Error: ' + error.message); return; }
        ['new-company-code','new-company-name','new-company-owner','new-company-phone','new-company-email','new-company-manager','new-company-manager-phone'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        loadCompanies();
        // create_company always provisions an Administrator account for the
        // new company (and an Owner/Manager employee record if those names
        // were given) — show the generated login once, right now.
        const result = (data && data[0]) ? data[0] : null;
        if (result && result.admin_username) showNewAdminCredentials(name, code, result);
    }

    function showNewAdminCredentials(companyName, companyCode, result) {
        document.getElementById('new-admin-title').textContent = '✅ Company created';
        document.getElementById('new-admin-company-line').textContent = `${companyName} (${companyCode})`;
        document.getElementById('new-admin-username').textContent = result.admin_username;
        document.getElementById('new-admin-password').textContent = result.admin_password;
        const linkParts = [];
        if (result.owner_employee_id) linkParts.push(`Linked to the new Owner employee (${result.owner_employee_id})`);
        else if (result.manager_employee_id) linkParts.push(`Linked to the new Manager employee (${result.manager_employee_id})`);
        else linkParts.push('Not linked to an employee yet — link one later from the Users tab if needed.');
        document.getElementById('new-admin-links').textContent = linkParts.join(' ');
        document.getElementById('new-admin-credentials-overlay').style.display = 'flex';
    }
    // Same overlay, reused for the login auto-created alongside a new employee.
    function showNewEmployeeCredentials(empName, empId, role, username, password) {
        document.getElementById('new-admin-title').textContent = '✅ Employee added';
        document.getElementById('new-admin-company-line').textContent = `${empName} (${empId})`;
        document.getElementById('new-admin-username').textContent = username;
        document.getElementById('new-admin-password').textContent = password;
        document.getElementById('new-admin-links').textContent = `Role: ${role}`;
        document.getElementById('new-admin-credentials-overlay').style.display = 'flex';
    }
    function closeNewAdminCredentials() {
        document.getElementById('new-admin-credentials-overlay').style.display = 'none';
    }
    async function copyNewAdminCredentials() {
        const u = document.getElementById('new-admin-username').textContent;
        const p = document.getElementById('new-admin-password').textContent;
        const text = `Username: ${u}\nPassword: ${p}`;
        try {
            await navigator.clipboard.writeText(text);
            alert('Copied to clipboard.');
        } catch (e) {
            alert(text); // clipboard unavailable — show it plainly so it can be copied by hand
        }
    }

    async function deleteCompany(code) {
        if (!confirm(`Delete company ${code} and ALL its data (employees, routes, claims, charges, users)? This cannot be undone.`)) return;
        const { error } = await supabaseClient.rpc('delete_company', { p_actor: currentUsername, p_code: code });
        if (error) alert('Error: ' + error.message);
        else { if (currentCompany === code) currentCompany = null; loadCompanies(); fetchAllDataFromCloud(); }
    }

    async function fetchAllDataFromCloud() {
        await loadPayTypes();            // needed before employees render (Pay column)
        await Promise.all([
            fetchRoutesFromCloud(),
            fetchEmployeesFromCloud(),
            fetchClaimsFromCloud(),
            fetchChargesFromCloud(),
            fetchSettingsFromCloud(),
            loadAttachmentCounts()       // "has files" indicators across every list
        ]);
        await loadCurrentWeekDaily();    // for Payroll base pay of Daily people
        await loadCurrentWeekProvider(); // for Payroll base pay of Provider people
        await loadClaimHistory();        // rate changes + pauses for balances
        await loadChargeHistory();       // same, for charges
        await fetchIncomeFromCloud();    // additional income for Payroll
        // Claims/Charges/Income are fetched concurrently with Employees just
        // above — if Employees happens to finish loading last (it does more
        // work per employee now: details + user-account links), Claims/
        // Charges/Income can render against a still-empty/stale employees
        // array and every row shows as "Unlinked" until something else
        // happens to re-render them. Re-render all three now that every
        // fetch above is guaranteed complete, so nothing is ever left
        // showing a stale Unlinked.
        if (typeof renderClaims === 'function') renderClaims();
        if (typeof renderCharges === 'function') renderCharges();
        if (typeof renderIncome === 'function') renderIncome();
        await loadNotifications();
        if (typeof fetchDmThreads === 'function') await fetchDmThreads(); // seeds the Messages unread badge
        await fetchVehiclesFromCloud();
        await fetchInvoicesFromCloud();
        await fetchBillsFromCloud();
        await fetchLastDailyPayWorked();
        if (typeof renderInactivityFlagsBanner === 'function') renderInactivityFlagsBanner();
        if (typeof renderHomeDashboard === 'function') renderHomeDashboard();
    }

    // Supabase's API caps a single request's returned rows (commonly 1000,
    // configurable per-project) — silently, no error, just a truncated
    // result. Any RPC that could plausibly return more rows than that over
    // time (routes especially, after a bulk import) needs to page through
    // in batches instead of trusting one call to return everything.
    async function fetchAllRpcRows(rpcName, params, pageSize = 1000) {
        let all = [];
        let from = 0;
        while (true) {
            const { data, error } = await supabaseClient.rpc(rpcName, params).range(from, from + pageSize - 1);
            if (error) return { data: null, error };
            all = all.concat(data || []);
            if (!data || data.length < pageSize) break;
            from += pageSize;
        }
        return { data: all, error: null };
    }

    async function fetchRoutesFromCloud() {
        const { data, error } = await fetchAllRpcRows('get_routes', { p_actor: currentUsername, p_company: currentCompany });
        if (error) console.error('get_routes:', error);
        routes = data || [];
        updateUI();
    }

    // Which employees already have a linked login (app_users.employee_id) —
    // drives whether the "Generate User" button shows on their card. Kept
    // separate from the full Users list (which is lazy-loaded only when that
    // tab opens) since Employees needs this much earlier/more often.
    let employeeUserIds = new Set();
    async function loadEmployeeUserLinks() {
        try {
            const { data, error } = await supabaseClient.rpc('list_users', { p_actor: currentUsername, p_company: currentCompany });
            if (error) { employeeUserIds = new Set(); return; }
            employeeUserIds = new Set((data || []).filter(u => u.employee_id).map(u => u.employee_id));
        } catch (e) { employeeUserIds = new Set(); }
    }

    async function fetchEmployeesFromCloud() {
        const { data, error } = await supabaseClient.rpc('get_employees', { p_actor: currentUsername, p_company: currentCompany });
        if (error) { console.error('get_employees failed:', error); showDiagBanner('Employees: ' + error.message); employees = []; }
        else { employees = data || []; }
        await loadEmployeeDetails();
        if (canEdit()) await loadEmployeeUserLinks();
        renderEmployees();
        populateEmployeeDropdowns();
        if (typeof updateNextEmpId === 'function') updateNextEmpId();
    }

    async function fetchClaimsFromCloud() {
        const { data, error } = await supabaseClient.rpc('get_claims', { p_actor: currentUsername, p_company: currentCompany });
        if (error) { console.error('get_claims:', error); showDiagBanner('Claims: ' + error.message); }
        claims = data || [];
        renderClaims();
        updateClaimStats();
        populateClaimFilters();
    }

    async function fetchChargesFromCloud() {
        const { data, error } = await supabaseClient.rpc('get_charges', { p_actor: currentUsername, p_company: currentCompany });
        if (error) { console.error('get_charges:', error); showDiagBanner('Charges: ' + error.message); }
        charges = data || [];
        renderClaimsCharges();
        populateClaimFilters();
    }

    async function fetchSettingsFromCloud() {
        const { data: dTypes } = await supabaseClient.from('damage_types').select('name');
        if (dTypes && dTypes.length) damageTypes = dTypes.map(d => d.name);

        const { data: cTypes } = await supabaseClient.from('charge_types').select('name');
        if (cTypes && cTypes.length) chargeTypes = cTypes.map(c => c.name);

        try {
            const { data: iTypes, error: iErr } = await supabaseClient.from('income_types').select('name');
            if (!iErr && iTypes && iTypes.length) incomeTypes = iTypes.map(i => i.name);
        } catch (e) { /* income_types table not created yet — defaults stay */ }

        renderSettingsLists();
        populateDropdowns();
    }

    function toggleCollapse(el) {
        const panel = el.closest('.panel, .card');
        if (panel) panel.classList.toggle('collapsed');
    }

    // Reorder a <select>'s options alphabetically, keeping the first
    // (placeholder) option pinned and preserving the current value.
    function sortSelectAZ(sel, pinFirst = true) {
        if (!sel) return;
        const val = sel.value;
        const opts = Array.from(sel.options);
        const head = (pinFirst && opts.length) ? [opts.shift()] : [];
        opts.sort((a, b) => a.textContent.trim().localeCompare(b.textContent.trim(), undefined, { numeric: true, sensitivity: 'base' }));
        sel.innerHTML = '';
        [...head, ...opts].forEach(o => sel.appendChild(o));
        sel.value = val;
    }

    function populateDropdowns() {
        const damageSel = document.getElementById('cDamageType');
        if (damageSel) {
            damageSel.innerHTML = '<option value="">— Select —</option>';
            damageTypes.forEach(d => damageSel.insertAdjacentHTML('beforeend', `<option value="${d}">${d}</option>`));
            sortSelectAZ(damageSel);
        }
        const chargeSel = document.getElementById('gChargeType');
        if (chargeSel) {
            chargeSel.innerHTML = '<option value="">— Select —</option>';
            chargeTypes.forEach(ct => chargeSel.insertAdjacentHTML('beforeend', `<option value="${ct}">${ct}</option>`));
            sortSelectAZ(chargeSel);
        }
        const incomeSel = document.getElementById('iType');
        if (incomeSel) {
            incomeSel.innerHTML = '<option value="">— Select —</option>';
            incomeTypes.forEach(it => incomeSel.insertAdjacentHTML('beforeend', `<option value="${it}">${it}</option>`));
            sortSelectAZ(incomeSel);
        }
        populateCompanySelects();
    }

    // Filters for the combined Claims & Charges tab: employees, the union of
    // damage-types + charge-types, and the union of both kinds' statuses.
    // (Kept the old name so existing call sites need no change.)
    function populateClaimFilters() {
        const empSel = document.getElementById('cc-emp');
        const typeSel = document.getElementById('cc-type');
        const statSel = document.getElementById('cc-status');
        if (empSel) {
            const prev = empSel.value;
            empSel.innerHTML = '<option value="">All employees</option>' +
                employees.map(e => `<option value="${e.id}">${employeeOptionLabel(e)}</option>`).join('');
            sortSelectAZ(empSel);
            empSel.value = prev || '';
        }
        if (typeSel) {
            const prev = typeSel.value;
            const types = Array.from(new Set([].concat(damageTypes || [], chargeTypes || []))).filter(Boolean);
            typeSel.innerHTML = '<option value="">All types</option>' +
                types.map(t => `<option value="${t}">${t}</option>`).join('');
            sortSelectAZ(typeSel);
            typeSel.value = prev || '';
        }
        if (statSel) {
            const prev = statSel.value;
            statSel.innerHTML = '<option value="">All statuses</option>' +
                ['Queued', 'Deducting', 'Paid', 'Absorbed', 'Tk from check', 'Released']
                    .map(s => `<option value="${s}">${s}</option>`).join('');
            statSel.value = prev || '';
        }
    }

    // --- EMPLOYEES ---
    let editingEmpId = null;         // null = creating, else editing this id
    let employeeDetails = {};        // employee_id -> { id_type, driver_license, dl_expiration, work_permit, work_permit_exp, medical_card, medical_card_exp, notes }
    let empDetailsMissing = false;

    // iOS Safari has never reliably supported window.print() when a site is
    // running standalone (added to the home screen) — the print dialog
    // either never appears or appears and silently fails. This is a
    // long-standing WebKit limitation with no fix available from page
    // JavaScript, so rather than call window.print() and let it do nothing,
    // detect the situation and tell the person plainly what to do instead.
    function attemptPrint() {
        // window.navigator.standalone is a Safari-only proprietary flag —
        // true only for an iOS/iPadOS home-screen-installed app. Deliberately
        // NOT using the generic matchMedia('(display-mode: standalone)')
        // check here: that also matches desktop Chrome/Edge PWA installs
        // (confirmed via research — Windows/Chrome and Windows/Edge both
        // report "standalone" for an installed app window), which don't
        // have this printing limitation, so using it here was incorrectly
        // blocking normal desktop printing too.
        const isIOSStandalone = window.navigator.standalone === true;
        if (isIOSStandalone) {
            alert('Printing doesn\'t work reliably from the installed app icon — this is a long-standing Safari limitation on iPhone/iPad, not something in Tracker itself.\n\nTo print: open this same page in Safari (not the home screen icon) and print from there.');
            return;
        }
        setTimeout(() => window.print(), 60); // let the browser paint the new content first — calling print() immediately after an innerHTML swap can show a blank preview on some mobile browsers
    }

    function escHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    // For free-text values interpolated into an inline onclick="...('${x}')"
    // attribute: escapes the JS string-literal delimiter (') AND the
    // surrounding HTML double-quoted attribute delimiter, so a name like
    // "Driver's fault" can't break the inline handler and (depending on
    // browser) send a malformed/undefined argument through to a delete call.
    function escJsAttr(s) {
        s = String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function getEmpDetail(id) { return employeeDetails[id] || {}; }

    // Companion table for the non-secret ID fields. Was direct-access with
    // no scoping at all (a real PII exposure — driver's license, phone,
    // email, medical card readable by anyone) — now goes through
    // get_employee_details, same scoping as employees/claims/charges.
    // Still degrades quietly if the table isn't created yet.
    async function loadEmployeeDetails() {
        empDetailsMissing = false;
        employeeDetails = {};
        try {
            const { data, error } = await supabaseClient.rpc('get_employee_details', { p_actor: currentUsername, p_company: currentCompany });
            if (error) { if (isMissingTable(error)) empDetailsMissing = true; return; }
            (data || []).forEach(r => { employeeDetails[r.employee_id] = r; });
        } catch (e) { console.error('loadEmployeeDetails:', e); }
    }

    async function saveEmployeeDetails(empId, co) {
        const payload = {
            employee_id: empId,
            company_code: co || writeCompany() || null,
            id_type: document.getElementById('emp-idtype').value || 'SSN',
            phone: document.getElementById('emp-phone').value.trim(),
            email: document.getElementById('emp-email').value.trim(),
            driver_license: document.getElementById('emp-dl').value.trim(),
            dl_expiration: document.getElementById('emp-dlexp').value || null,
            work_permit: document.getElementById('emp-wp').value.trim(),
            work_permit_exp: document.getElementById('emp-wpexp').value || null,
            medical_card: document.getElementById('emp-medcard').value || 'No',
            medical_card_exp: document.getElementById('emp-medexp').value || null,
            notes: document.getElementById('emp-notes').value.trim(),
            last_date_worked: document.getElementById('emp-lastworked').value || null
        };
        employeeDetails[empId] = payload; // optimistic
        try {
            const { error } = await supabaseClient.rpc('save_employee_details', {
                p_actor: currentUsername, p_employee_id: empId, p_company: payload.company_code,
                p_id_type: payload.id_type, p_driver_license: payload.driver_license, p_dl_expiration: payload.dl_expiration,
                p_work_permit: payload.work_permit, p_work_permit_exp: payload.work_permit_exp,
                p_medical_card: payload.medical_card, p_medical_card_exp: payload.medical_card_exp,
                p_notes: payload.notes, p_phone: payload.phone, p_email: payload.email,
                p_last_date_worked: payload.last_date_worked
            });
            if (error && isMissingTable(error)) {
                empDetailsMissing = true;
                alert('The employee_details table is not set up yet — the extra ID fields (license, permit, medical card, notes) were not saved. Run the provided SQL setup once, then re-save.');
            } else if (error) { console.error('saveEmployeeDetails:', error); alert('Could not save: ' + error.message); }
        } catch (e) { console.error('saveEmployeeDetails:', e); }
    }

    // ID prefix now comes from the active company's 3-4 char code, not a
    // manual setting. Falls back to any legacy settings.prefix, else ''.
    function idPrefix() {
        return String(writeCompany() || settings.prefix || '').toUpperCase();
    }

    // Fill the route-form Company dropdown (and any others) from the
    // registered companies, sorted A-Z. Value = company code, label = name.
    function populateCompanySelects() {
        const fallbackName = (currentUser && (currentUser.company_name || currentUser.companyName)) || writeCompany();
        const list = (companies && companies.length)
            ? companies.map(c => ({ code: c.code, name: c.name || c.code }))
            : (writeCompany() ? [{ code: writeCompany(), name: fallbackName }] : []);
        const sel = document.getElementById('f-contractor');
        if (sel) {
            const prev = sel.value;
            sel.innerHTML = '<option value="">— Select company —</option>' +
                list.map(c => `<option value="${escHtml(c.code)}">${escHtml(c.name)}</option>`).join('');
            sortSelectAZ(sel);
            // default to the active company when one is selected up top
            sel.value = prev || writeCompany() || '';
        }
    }

    function computeNextEmpId(type) {
        const letter = type === 'Staff' ? 'S' : type === 'Contractor' ? 'C' : type === 'Provider' ? 'P' : type === 'Owner' ? 'O' : type === 'Manager' ? 'M' : 'E';
        const prefix = idPrefix();
        // Based on the HIGHEST existing numeric ID for this type, not a
        // count of currently-loaded employees. Counting breaks permanently
        // the moment any employee of this type is ever deleted: the count
        // drops by one, but the highest ID number already used doesn't —
        // so count+1 then collides with a record that still exists further
        // up the sequence. Scanning for the actual max is immune to gaps
        // left by deletions.
        const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const idPattern = new RegExp('^' + escaped + '(\\d+)' + letter + '$');
        let max = 0;
        employees.forEach(emp => {
            const m = String(emp.id || '').match(idPattern);
            if (m) max = Math.max(max, parseInt(m[1], 10));
        });
        return `${prefix}${String(max + 1).padStart(settings.empDigits, '0')}${letter}`;
    }
    function updateNextEmpId() {
        const el = document.getElementById('next-emp-id-display');
        if (!el) return;
        if (editingEmpId) { el.textContent = editingEmpId; return; }
        el.textContent = idPrefix() ? computeNextEmpId(document.getElementById('emp-type').value) : '— select company —';
    }

    function readEmployeeForm() {
        return {
            first: document.getElementById('emp-first').value.trim(),
            last: document.getElementById('emp-last').value.trim(),
            type: document.getElementById('emp-type').value,
            dept: document.getElementById('emp-dept').value.trim(),
            role: document.getElementById('emp-role').value.trim(),
            start: document.getElementById('emp-start').value || null,
            pay: parseFloat(document.getElementById('emp-payrate').value) || 0,
            ssn: document.getElementById('emp-idnum').value.trim(),
            payType: ['Daily', 'Provider'].includes(document.getElementById('emp-paytype').value) ? document.getElementById('emp-paytype').value : 'Weekly'
        };
    }

    document.getElementById('employee-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!canEdit()) return;
        const co = requireWriteCompany();
        if (!co) return;
        const f = readEmployeeForm();

        if (editingEmpId) {
            // ----- EDIT -----
            const id = editingEmpId;
            const { data, error } = await supabaseClient.rpc('edit_employee', {
                p_actor: currentUsername, p_id: id,
                p_first: f.first, p_last: f.last, p_type: f.type,
                p_dept: f.dept, p_role_title: f.role, p_start: f.start,
                p_pay: f.pay,
                p_ssn: f.ssn === '' ? null : f.ssn,   // blank = keep existing
                p_status: null                          // status changed via the row dropdown
            });
            if (error) { alert('Error: ' + error.message); return; }
            await saveEmployeeDetails(id, co);
            await setPayType(id, f.payType, co);
            if (data && String(data).indexOf('approval') !== -1) alert(data);
            cancelEmployeeEdit();
            fetchEmployeesFromCloud();
        } else {
            // ----- CREATE -----
            const id = computeNextEmpId(f.type);
            const { data, error } = await supabaseClient.rpc('create_employee', {
                p_actor: currentUsername, p_company: co, p_id: id,
                p_first: f.first, p_last: f.last, p_type: f.type,
                p_dept: f.dept, p_role_title: f.role, p_start: f.start,
                p_pay: f.pay, p_ssn: f.ssn
            });
            if (error) { alert('Error: ' + error.message); return; }
            await saveEmployeeDetails(id, co);
            await setPayType(id, f.payType, co);
            document.getElementById('employee-form').reset();
            updateNextEmpId();
            fetchEmployeesFromCloud();
            // create_employee also auto-provisions a login for this employee
            // (Owner/Manager -> Administrator, Staff -> Medium, else View Only).
            const result = (data && data[0]) ? data[0] : null;
            if (result && result.new_username) {
                const autoRole = (f.type === 'Owner' || f.type === 'Manager') ? 'Administrator' : (f.type === 'Staff' ? 'Medium' : 'User');
                showNewEmployeeCredentials(`${f.first} ${f.last}`.trim(), id, ROLE_LABELS[autoRole] || autoRole, result.new_username, result.new_password);
            }
        }
    });

    function editEmployee(id) {
        if (!canEdit()) return;
        const emp = employees.find(e => e.id === id);
        if (!emp) return;
        const d = getEmpDetail(id);
        editingEmpId = id;
        document.getElementById('emp-first').value = emp.first_name || '';
        document.getElementById('emp-last').value = emp.last_name || '';
        document.getElementById('emp-type').value = emp.person_type || 'Employee';
        document.getElementById('emp-dept').value = emp.department || '';
        document.getElementById('emp-role').value = emp.role_title || '';
        document.getElementById('emp-start').value = emp.start_date || '';
        document.getElementById('emp-idnum').value = '';   // never prefill the hidden SSN
        document.getElementById('emp-idnum').placeholder = 'leave blank to keep current';
        document.getElementById('emp-idtype').value = d.id_type || 'SSN';
        document.getElementById('emp-phone').value = d.phone || '';
        document.getElementById('emp-email').value = d.email || '';
        document.getElementById('emp-lastworked').value = d.last_date_worked || '';
        document.getElementById('emp-dl').value = d.driver_license || '';
        document.getElementById('emp-dlexp').value = d.dl_expiration || '';
        document.getElementById('emp-wp').value = d.work_permit || '';
        document.getElementById('emp-wpexp').value = d.work_permit_exp || '';
        document.getElementById('emp-medcard').value = d.medical_card || 'No';
        document.getElementById('emp-medexp').value = d.medical_card_exp || '';
        document.getElementById('emp-notes').value = d.notes || '';
        document.getElementById('emp-paytype').value = getPayType(id);
        document.getElementById('emp-payrate').value = emp.pay_rate || '';

        document.getElementById('employee-form-titletext').textContent = `Editing ${emp.first_name} ${emp.last_name} — ${id}`;
        document.getElementById('emp-save-btn').textContent = 'Save changes';
        document.getElementById('emp-cancel-btn').style.display = 'inline-block';
        document.getElementById('employee-form').classList.add('editing');
        updateNextEmpId();
        document.getElementById('tab-employees').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function cancelEmployeeEdit() {
        editingEmpId = null;
        document.getElementById('employee-form').reset();
        document.getElementById('emp-idnum').placeholder = 'XXX-XX-XXXX';
        document.getElementById('employee-form-titletext').textContent = 'New Contact';
        document.getElementById('emp-save-btn').textContent = '+ Add Employee';
        document.getElementById('emp-cancel-btn').style.display = 'none';
        document.getElementById('employee-form').classList.remove('editing');
        updateNextEmpId();
    }

    // Expiration badge: within `days` -> amber, past -> red.
    function expBadge(dateStr, days) {
        if (!dateStr) return '';
        const d = new Date(dateStr); if (isNaN(d)) return '';
        const diff = Math.floor((d - new Date()) / 86400000);
        if (diff < 0) return ` <span class="exp-pill exp-over">expired</span>`;
        if (diff <= days) return ` <span class="exp-pill exp-soon">${diff}d</span>`;
        return '';
    }

    // Consolidated view of every expiry date already tracked across the
    // app (Fleet reg/insurance, employee DL/work permit/medical card) —
    // no new data, just one combined list instead of hunting per-tab.
    function buildExpiringDocumentsList() {
        const items = [];
        const daysUntil = dateStr => {
            const d = new Date(dateStr);
            return isNaN(d) ? null : Math.floor((d - new Date()) / 86400000);
        };
        const isViewOnly = currentUserRole === 'User';
        const myEmpId = currentUser && currentUser.employee_id;
        // View Only sees only their own document expirations, matching the
        // same "own information only" policy applied everywhere else in
        // the app — and Fleet is excluded entirely for them, since a
        // vehicle isn't personal to any one employee the way DL/work
        // permit/medical card are.
        if (!isViewOnly) {
            vehicles.forEach(v => {
                const label = v.truck_number || v.id;
                if (v.reg_expiry) items.push({ category: 'Fleet', who: label, doc: 'Registration', date: v.reg_expiry, days: daysUntil(v.reg_expiry), kind: 'vehicles', id: v.id });
                if (v.insurance_expiry) items.push({ category: 'Fleet', who: label, doc: 'Insurance', date: v.insurance_expiry, days: daysUntil(v.insurance_expiry), kind: 'vehicles', id: v.id });
            });
        }
        const employeeScope = isViewOnly ? employees.filter(e => e.id === myEmpId) : employees;
        employeeScope.forEach(e => {
            const d = getEmpDetail(e.id);
            const name = `${e.first_name} ${e.last_name}`;
            if (d.dl_expiration) items.push({ category: 'Employee', who: name, doc: 'Driver License', date: d.dl_expiration, days: daysUntil(d.dl_expiration), kind: 'employees', id: e.id });
            if (d.work_permit_exp) items.push({ category: 'Employee', who: name, doc: 'Work Permit', date: d.work_permit_exp, days: daysUntil(d.work_permit_exp), kind: 'employees', id: e.id });
            if (d.medical_card_exp) items.push({ category: 'Employee', who: name, doc: 'Medical Card', date: d.medical_card_exp, days: daysUntil(d.medical_card_exp), kind: 'employees', id: e.id });
        });
        return items.filter(i => i.days !== null).sort((a, b) => a.days - b.days);
    }

    function renderExpiringDocuments() {
        const grid = document.getElementById('expiring-stats-grid');
        const body = document.getElementById('expiring-tbody');
        if (!body) return;
        const isViewOnly = currentUserRole === 'User';
        const categoryField = document.getElementById('expiring-category')?.closest('.field');
        if (categoryField) categoryField.style.display = isViewOnly ? 'none' : ''; // Fleet's excluded for them anyway — nothing to filter by category
        const windowDays = parseInt(document.getElementById('expiring-window').value, 10) || 60;
        const category = isViewOnly ? '' : document.getElementById('expiring-category').value;
        const query = (document.getElementById('expiring-search').value || '').toLowerCase();

        // Group every tracked document by whoever it belongs to (one truck
        // or employee = one group), not one row per document — a truck
        // with both registration AND insurance coming up shows once, with
        // both listed inside, instead of twice.
        const all = buildExpiringDocumentsList();
        const groupMap = {};
        all.forEach(i => {
            const key = i.kind + ':' + i.id;
            if (!groupMap[key]) groupMap[key] = { kind: i.kind, id: i.id, who: i.who, category: i.category, docs: [] };
            groupMap[key].docs.push(i);
        });
        let groups = Object.values(groupMap).map(g => {
            g.docs.sort((a, b) => a.days - b.days); // most urgent doc first within the group
            g.minDays = g.docs[0].days; // drives the group's own badge + sort order
            return g;
        });
        // A group shows if ANY of its documents falls inside the selected
        // window — once it qualifies, every document for that truck/
        // employee displays, even ones further out, so the full picture
        // is visible in one place rather than needing to piece it together.
        groups = groups.filter(g => g.docs.some(d => d.days <= windowDays));
        if (category) groups = groups.filter(g => g.category === category);
        if (query) groups = groups.filter(g => `${g.who} ${g.docs.map(d => d.doc).join(' ')}`.toLowerCase().includes(query));
        groups.sort((a, b) => a.minDays - b.minDays);

        const expiredCount = groups.filter(g => g.minDays < 0).length;
        const soonCount = groups.filter(g => g.minDays >= 0 && g.minDays <= 14).length;
        if (grid) grid.innerHTML = `
            <div class="stat-card"><div class="stat-label" data-i18n="d_already_expired">Already expired</div><div class="stat-value" style="color:#dc2626;">${expiredCount}</div></div>
            <div class="stat-card"><div class="stat-label" data-i18n="d_within_14">Within 14 days</div><div class="stat-value" style="color:#d97706;">${soonCount}</div></div>
            <div class="stat-card"><div class="stat-label" data-i18n="d_total_shown">Total shown</div><div class="stat-value">${groups.length}</div></div>`;

        if (!groups.length) { body.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:20px;">${t('d_nothing_expiring')}</div>`; applyTranslations(); return; }

        const pillFor = days => days < 0
            ? `<span class="exp-pill exp-over">expired ${Math.abs(days)}d ago</span>`
            : days <= 14 ? `<span class="exp-pill exp-soon">${days}d left</span>` : `<span class="type-pill">${days}d left</span>`;

        // buildExpiringDocumentsList() labels each document in plain English;
        // these are the matching attachment slots, so an about-to-expire
        // document can be opened right here instead of hunting for the record.
        const EXP_DOC_SLOT = {
            'Driver License': 'driver_license', 'Work Permit': 'work_permit',
            'Medical Card': 'medical_card', 'Registration': 'registration', 'Insurance': 'insurance'
        };

        const rows = groups.map(g => `
            <div class="panel collapsed" style="margin-bottom:8px;">
                <div class="panel-head" onclick="toggleCollapse(this)">
                    <span style="font-size:13px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                        <span class="type-pill">${g.category}</span>
                        <b>${escHtml(g.who)}</b>
                        ${pillFor(g.minDays)}
                        <span style="color:var(--text-muted); font-size:0.75rem;">${g.docs.length} document${g.docs.length > 1 ? 's' : ''}</span>
                    </span>
                    <span class="caret">&#9662;</span>
                </div>
                <div>
                    <div class="rec-detail-grid" style="margin:8px 0;">
                        ${g.docs.map(d => {
                            const slot = EXP_DOC_SLOT[d.doc];
                            const et = g.kind === 'vehicles' ? 'vehicle' : 'employee';
                            return `<div><div class="k">${escHtml(d.doc)}</div><div class="v">${d.date} ${pillFor(d.days)}</div>${slot ? `<div style="margin-top:4px;">${attachSlotHtml(et, g.id, slot)}</div>` : ''}</div>`;
                        }).join('')}
                    </div>
                    <button type="button" class="btn-small" style="margin:0;background:var(--navy);" onclick="event.stopPropagation(); goToSearchResult('${g.kind}','${g.id}')">${g.kind === 'vehicles' ? t('d_edit_vehicle_record') : t('d_edit_employee_record')}</button>
                </div>
            </div>`).join('');
        body.innerHTML = rows;
        applyTranslations();
    }

    // Shared block of extra fields shown once an employee is expanded —
    // used by BOTH the desktop detail <tr> and the mobile card body so the
    // two views never drift apart.
    function employeeDetailHtml(emp, d, ssn) {
        const dl = d.driver_license ? escHtml(d.driver_license) : '—';
        const dlExp = d.dl_expiration ? d.dl_expiration + expBadge(d.dl_expiration, 30) : '—';
        const wp = d.work_permit ? escHtml(d.work_permit) : '—';
        const wpExp = d.work_permit_exp ? d.work_permit_exp + expBadge(d.work_permit_exp, 90) : '—';
        const med = (d.medical_card === 'Yes') ? 'Yes' : '<span style="color:var(--text-muted);">No</span>';
        const medExp = d.medical_card_exp ? d.medical_card_exp + expBadge(d.medical_card_exp, 60) : '—';
        return `<div class="rec-detail-grid">
                <div><div class="k" data-i18n="d_phone">Phone</div><div class="v">${d.phone ? escHtml(d.phone) : '-'}</div></div>
                <div><div class="k" data-i18n="d_email">Email</div><div class="v">${d.email ? escHtml(d.email) : '-'}</div></div>
                <div><div class="k"><span data-i18n="d_ssn_itin">SSN / ITIN</span> (${escHtml(d.id_type || 'SSN')})</div><div class="v id-cell">${ssn}</div></div>
                <div><div class="k" data-i18n="d_dl_stateid">Driver License / State ID</div><div class="v">${dl}</div></div>
                <div><div class="k" data-i18n="d_dl_exp">DL Expiration</div><div class="v">${dlExp}</div></div>
                <div><div class="k" data-i18n="d_wp_num">Work Permit #</div><div class="v">${wp}</div></div>
                <div><div class="k" data-i18n="d_wp_exp">Work Permit Expiration</div><div class="v">${wpExp}</div></div>
                <div><div class="k" data-i18n="d_medcard">Medical Card</div><div class="v">${med}</div></div>
                <div><div class="k" data-i18n="d_medcard_exp">Medical Card Expiration</div><div class="v">${medExp}</div></div>
                ${emp.role_title ? `<div><div class="k" data-i18n="d_role_title">Role / Title</div><div class="v">${escHtml(emp.role_title)}</div></div>` : ''}
                ${d.notes ? `<div><div class="k" data-i18n="d_notes">Notes</div><div class="v">${escHtml(d.notes)}</div></div>` : ''}
            </div>
            ${docSlotsHtml('employee', emp.id, ['driver_license', 'work_permit', 'medical_card'])}
            <div class="rec-actions" style="margin-top:10px;">
                ${attachBtnHtml('employee', emp.id)}
                <button class="btn-small" style="background:var(--navy);margin:0;" onclick="event.stopPropagation(); loadEmployeeStatusHistory('${emp.id}')" data-i18n="d_status_history">Status history</button>
                ${(canEdit() && !employeeUserIds.has(emp.id)) ? `<button class="btn-small" style="background:var(--navy);margin:0;" onclick="event.stopPropagation(); generateEmployeeUser('${emp.id}')" data-i18n="d_generate_user">Generate User</button>` : ''}
            </div>
            <div id="stathist-${emp.id}" style="margin-top:6px;font-size:12px;"></div>`;
    }

    async function loadEmployeeStatusHistory(empId) {
        const box = document.getElementById(`stathist-${empId}`);
        if (!box) return;
        box.innerHTML = `<span style="color:var(--text-muted);">${t('d_loading')}</span>`;
        const { data, error } = await supabaseClient.rpc('list_employee_status_history', {
            p_actor: currentUsername, p_company: currentCompany, p_employee_id: empId, p_limit: 50
        });
        if (error) { box.innerHTML = `<span style="color:#dc2626;">Error: ${error.message}</span>`; return; }
        if (!data || !data.length) { box.innerHTML = `<span style="color:var(--text-muted);">${t('d_no_status_changes')}</span>`; return; }
        box.innerHTML = `<table style="width:100%;font-size:12px;"><thead><tr><th style="text-align:left;">${t('d_th_date')}</th><th style="text-align:left;">${t('d_th_change')}</th><th style="text-align:left;">${t('d_th_by')}</th></tr></thead><tbody>${
            data.map(h => `<tr><td>${new Date(h.changed_at).toLocaleString()}</td><td>${h.old_status || '—'} → ${h.new_status}</td><td>${escHtml(h.changed_by || '—')}</td></tr>`).join('')
        }</tbody></table>`;
    }

    // Resets a section's filter controls back to their defaults (matching
    // each dropdown's own default-selected option) and re-renders — one
    // function so every "Clear filters" button behaves consistently.
    function clearFilters(tab) {
        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        switch (tab) {
            case 'employees':
                setVal('employee-search', ''); setVal('employee-status-filter', 'Active');
                renderEmployees();
                break;
            case 'cc':
            case 'claims':
            case 'charges':
                setVal('cc-search', ''); setVal('cc-kind', ''); setVal('cc-emp', ''); setVal('cc-type', ''); setVal('cc-status', '');
                renderClaimsCharges();
                break;
            case 'weekdeposit':
                setVal('weekdeposit-status-filter', '');
                setVal('weekdeposit-search', '');
                renderWeekDeposit();
                break;
            case 'income':
                setVal('income-search', '');
                renderIncome();
                break;
            case 'dailypay':
                setVal('dailypay-type-filter', ''); setVal('dailypay-status-filter', 'Active'); setVal('dailypay-search', '');
                renderDailyPay();
                break;
            case 'providerpay':
                setVal('providerpay-status-filter', 'Active'); setVal('providerpay-search', '');
                renderProviderPay();
                break;
            case 'statement':
                setVal('statement-type-filter', ''); setVal('statement-status-filter', 'Active'); setVal('statement-search', '');
                populateStatementEmployeeDropdown();
                break;
            case 'payroll':
                setVal('payroll-type-filter', ''); setVal('payroll-status-filter', 'Active'); setVal('payroll-search', '');
                renderPayroll();
                break;
            case 'notifications':
                setVal('notif-range', '');
                renderNotifications();
                break;
            case 'vehicles':
                setVal('vehicle-search', '');
                renderVehicles();
                break;
            case 'messages':
                setVal('dm-search', '');
                renderDmContacts();
                break;
            case 'invoices':
                setVal('invoice-search', ''); setVal('invoice-status-filter', ''); setVal('invoice-customer-filter', '');
                renderInvoices();
                break;
            case 'bills':
                setVal('bill-search', ''); setVal('bill-status-filter', ''); setVal('bill-vendor-filter', '');
                renderBills();
                break;
            case 'savingsreport':
                setVal('savingsreport-search', ''); setVal('savingsreport-kind-filter', ''); setVal('savingsreport-ready-filter', '');
                renderSavingsReleaseReport();
                break;
            case 'releasehistory':
                setVal('releasehistory-search', ''); setVal('releasehistory-type-filter', ''); setVal('releasehistory-early-filter', '');
                renderReleaseHistory();
                break;
        }
    }

    function renderEmployees() {
        renderInactivityFlagsBanner();
        const query = (document.getElementById('employee-search')?.value || '').toLowerCase();
        const statusFilter = document.getElementById('employee-status-filter')?.value || '';
        let list = employees.filter(emp => {
            if (statusFilter && emp.status !== statusFilter) return false;
            if (!query) return true;
            const name = `${emp.first_name} ${emp.last_name}`.toLowerCase();
            const d = getEmpDetail(emp.id);
            return name.includes(query) || String(emp.id || '').toLowerCase().includes(query) ||
                (emp.department || '').toLowerCase().includes(query) || (emp.person_type || '').toLowerCase().includes(query) ||
                (d.driver_license || '').toLowerCase().includes(query) || (d.work_permit || '').toLowerCase().includes(query) ||
                (d.phone || '').toLowerCase().includes(query) || (d.email || '').toLowerCase().includes(query);
        });
        list = applySort(list, 'employees', {
            id: e => e.id,
            name: e => `${e.first_name} ${e.last_name}`,
            type: e => e.person_type || '',
            department: e => e.department || '',
            start: e => e.start_date || '',
            status: e => e.status || ''
        });
        const container = document.getElementById('employees-tbody');
        const editable = canEdit();

        if (isDesktopView()) {
            container.className = '';
            if (!list.length) { container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_employees')}</div>`; return; }
            let rows = '';
            list.forEach(emp => {
                const ssn = emp.ssn_display ? emp.ssn_display : '<span style="color:#cbd5e1;">— hidden —</span>';
                const d = getEmpDetail(emp.id);
                const pt = getPayType(emp.id);
                const payToggle = editable ? ` <button class="btn-small" style="padding:0.15rem 0.4rem;font-size:0.65rem;margin:0;" onclick="event.stopPropagation(); togglePayType('${emp.id}')" title="Cycle Weekly / Daily / Provider pay">↺</button>` : '';
                const statusCell = editable
                    ? `<select onclick="event.stopPropagation();" onchange="event.stopPropagation(); setEmployeeStatus('${emp.id}', this.value)" style="padding:3px 4px;font-size:11px;border-radius:5px;">
                           <option value="Active" ${emp.status === 'Active' ? 'selected' : ''}>Active</option>
                           <option value="Inactive" ${emp.status !== 'Active' ? 'selected' : ''}>Inactive</option>
                       </select>`
                    : `<span class="status-badge ${emp.status === 'Active' ? 'status-active' : 'status-quit'}">${emp.status}</span>`;
                const open = recExpanded.employees.has(emp.id);
                rows += `<tr style="cursor:pointer;" onclick="toggleRecCard('employees','${emp.id}')">
                    <td class="id-cell"><span class="rec-caret" data-caret="employees-${emp.id}">${open ? '▾' : '▸'}</span> ${emp.id} ${attachInd('employee', emp.id)}</td>
                    <td>${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</td>
                    <td>${emp.person_type}</td>
                    <td>${escHtml(emp.department) || '-'}</td>
                    <td>${emp.start_date || '-'}</td>
                    <td>${pt}${payToggle}</td>
                    <td>${statusCell}</td>
                    <td style="text-align:center; white-space:nowrap;" onclick="event.stopPropagation();">${editable ? `<button class="btn-small" style="padding:0.3rem 0.6rem;font-size:0.75rem;margin:0 3px 0 0;background:var(--navy);" onclick="editEmployee('${emp.id}')" data-i18n="d_edit">Edit</button><button class="del-btn" onclick="deleteEmployee('${emp.id}')">✕</button>` : ''}</td>
                </tr>
                <tr class="rec-card${open ? ' open' : ''}" id="rec-employees-${emp.id}" style="display:${open ? 'table-row' : 'none'};">
                    <td colspan="8" style="padding:12px; background:var(--surface-2);">${employeeDetailHtml(emp, d, ssn)}</td>
                </tr>`;
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th data-i18n="th_id">ID</th><th data-i18n="th_name">Name</th><th data-i18n="th_type">Type</th><th data-i18n="th_department">Department</th><th data-i18n="th_start">Start</th><th data-i18n="th_pay">Pay</th><th data-i18n="th_status">Status</th><th data-i18n="th_action">Action</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`;
            applyTranslations();
            return;
        }

        container.className = 'record-grid';
        container.innerHTML = list.length ? '' : `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_employees')}</div>`;
        list.forEach(emp => {
            const ssn = emp.ssn_display ? emp.ssn_display : '<span style="color:#cbd5e1;">— hidden —</span>';
            const d = getEmpDetail(emp.id);
            const pt = getPayType(emp.id);
            const payToggle = editable ? ` <button class="btn-small" style="padding:0.15rem 0.4rem;font-size:0.65rem;margin:0;" onclick="togglePayType('${emp.id}')" title="Cycle Weekly / Daily / Provider pay">↺</button>` : '';
            const statusCell = editable
                ? `<select onchange="setEmployeeStatus('${emp.id}', this.value)" style="padding:3px 4px;font-size:11px;border-radius:5px;">
                       <option value="Active" ${emp.status === 'Active' ? 'selected' : ''}>Active</option>
                       <option value="Inactive" ${emp.status !== 'Active' ? 'selected' : ''}>Inactive</option>
                   </select>`
                : `<span class="status-badge ${emp.status === 'Active' ? 'status-active' : 'status-quit'}">${emp.status}</span>`;
            const open = recExpanded.employees.has(emp.id);
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-employees-${emp.id}">
                    <div class="rec-card-head" onclick="toggleRecCard('employees','${emp.id}')">
                        <span class="rec-caret" data-caret="employees-${emp.id}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</span>
                        <span class="rec-sub">${emp.id}</span>
                        ${attachInd('employee', emp.id)}
                        <span class="rec-right"><span class="pay-pill ${pt === 'Daily' ? 'pay-daily' : pt === 'Provider' ? 'pay-provider' : 'pay-weekly'}">${pt}</span> <span class="status-badge ${emp.status === 'Active' ? 'status-active' : 'status-quit'}">${emp.status}</span></span>
                    </div>
                    <div class="rec-card-body">
                        <div class="rec-detail-grid">
                            <div><div class="k" data-i18n="d_type">Type</div><div class="v">${emp.person_type}</div></div>
                            <div><div class="k" data-i18n="d_department">Department</div><div class="v">${escHtml(emp.department) || '-'}</div></div>
                            <div><div class="k" data-i18n="d_start_date">Start date</div><div class="v">${emp.start_date || '-'}</div></div>
                        </div>
                        ${employeeDetailHtml(emp, d, ssn)}
                        ${editable ? `
                        <div class="rec-actions">
                            <button class="btn-small" style="background:var(--navy);margin:0;" onclick="editEmployee('${emp.id}')" data-i18n="d_edit">Edit</button>
                            <button class="del-btn" onclick="deleteEmployee('${emp.id}')" data-i18n="d_delete">✕ Delete</button>
                        </div>
                        <div class="rec-quick-settings">
                            <span class="rec-qs-item"><span class="rec-qs-label" data-i18n="d_pay">Pay</span> ${pt}${payToggle}</span>
                            <span class="rec-qs-item"><span class="rec-qs-label" data-i18n="d_status">Status</span> ${statusCell}</span>
                        </div>` : ''}
                    </div>
                </div>`);
        });
        updateRecSortUI('employees');
        applyTranslations();
    }

    async function setEmployeeStatus(id, newStatus) {
        if (!canEdit()) return;
        const emp = employees.find(e => e.id === id);
        if (!emp || emp.status === newStatus) return;
        const wasActive = emp.status !== 'Inactive';
        const { error } = await supabaseClient.rpc('edit_employee', {
            p_actor: currentUsername, p_id: id,
            p_first: emp.first_name, p_last: emp.last_name, p_type: emp.person_type,
            p_dept: emp.department, p_role_title: emp.role_title,
            p_start: emp.start_date || null, p_pay: parseFloat(emp.pay_rate) || 0,
            p_ssn: null, p_status: newStatus
        });
        if (error) { alert('Error: ' + error.message); fetchEmployeesFromCloud(); return; }
        // First time going Inactive starts the 90/30-day release clocks —
        // locks in today as inactive_since and, if nothing's set by hand
        // already, locks in the Daily Pay-derived last-worked date too.
        // Flipping status back and forth again later doesn't reset this
        // (mark_employee_inactive_since only ever fills in a blank).
        if (wasActive && newStatus === 'Inactive') {
            await supabaseClient.rpc('mark_employee_inactive_since', {
                p_actor: currentUsername, p_employee_id: id,
                p_inactive_since: todayStr(), p_derived_last_worked: lastDailyPayWorked[id] || null
            });
            await loadEmployeeDetails();
        }
        fetchEmployeesFromCloud();
    }

    // ---- Employee CSV export / import ----------------------------------
    function csvCell(s) {
        s = (s == null) ? '' : String(s);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    const EMP_CSV_HEADERS = ['ID','First Name','Last Name','Person Type','Department','Role/Title','Start Date','Status','Base Weekly Pay','Pay Type','Phone','Email','ID Type','Driver License','DL Expiration','Work Permit','Work Permit Expiration','Medical Card','Medical Card Expiration','Notes'];

    function exportEmployeesCsv() {
        const rows = [EMP_CSV_HEADERS.map(csvCell).join(',')];
        employees.forEach(emp => {
            const d = getEmpDetail(emp.id);
            rows.push([
                emp.id, emp.first_name, emp.last_name, emp.person_type, emp.department, emp.role_title,
                emp.start_date, emp.status, emp.pay_rate, getPayType(emp.id), d.phone, d.email,
                d.id_type || 'SSN', d.driver_license, d.dl_expiration, d.work_permit, d.work_permit_exp,
                d.medical_card || 'No', d.medical_card_exp, d.notes
            ].map(csvCell).join(','));
        });
        const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'employees.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // Minimal RFC-4180-ish CSV parser (handles quotes, commas, newlines).
    function parseCsvText(text) {
        const rows = []; let row = []; let field = ''; let i = 0; let inQ = false;
        text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        while (i < text.length) {
            const ch = text[i];
            if (inQ) {
                if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
                else field += ch;
            } else {
                if (ch === '"') inQ = true;
                else if (ch === ',') { row.push(field); field = ''; }
                else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
                else field += ch;
            }
            i++;
        }
        if (field !== '' || row.length) { row.push(field); rows.push(row); }
        return rows.filter(r => r.length && r.some(c => c.trim() !== ''));
    }

    async function importEmployeesCsv(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = ''; // allow re-importing the same file
        if (!file) return;
        if (!canEdit()) { alert('You do not have permission to import.'); return; }
        const co = requireWriteCompany();
        if (!co) return;

        const text = await file.text();
        const rows = parseCsvText(text);
        if (rows.length < 2) { alert('CSV appears to be empty.'); return; }

        const header = rows[0].map(h => h.trim().toLowerCase());
        const col = (names) => { for (const n of names) { const i = header.indexOf(n); if (i > -1) return i; } return -1; };
        const idx = {
            first: col(['first name','first','firstname']),
            last:  col(['last name','last','lastname']),
            type:  col(['person type','type']),
            dept:  col(['department','dept']),
            role:  col(['role/title','role','role title','title']),
            start: col(['start date','start']),
            pay:   col(['base weekly pay','pay','weekly pay','pay rate']),
            payType: col(['pay type']),
            phone: col(['phone','phone #','phone number']),
            email: col(['email']),
            ssn:   col(['ssn','ssn/itin','ssn / itin','ssn or itin']),
            idType: col(['id type','type of id']),
            dl:    col(['driver license','driver license or state id #','dl']),
            dlExp: col(['dl expiration','driver license expiration','dl / state id expiration']),
            wp:    col(['work permit','work permit #']),
            wpExp: col(['work permit expiration','work permit exp']),
            med:   col(['medical card']),
            medExp:col(['medical card expiration','medical card exp']),
            notes: col(['notes'])
        };
        if (idx.first < 0 || idx.last < 0) { alert('CSV must include at least "First Name" and "Last Name" columns.'); return; }

        const get = (r, i) => (i > -1 && r[i] != null) ? String(r[i]).trim() : '';
        const normType = t => {
            t = (t || '').toLowerCase();
            if (t.startsWith('staff')) return 'Staff';
            if (t.startsWith('contract')) return 'Contractor';
            if (t.startsWith('provid')) return 'Provider';
            return 'Employee';
        };

        let ok = 0, fail = 0;
        const dataRows = rows.slice(1);
        for (const r of dataRows) {
            const first = get(r, idx.first), last = get(r, idx.last);
            if (!first && !last) continue;
            const type = normType(get(r, idx.type));
            // Compute a fresh ID from the in-memory list, then push a stub so
            // the next row's count increments correctly within this batch.
            const id = computeNextEmpId(type);
            const { error } = await supabaseClient.rpc('create_employee', {
                p_actor: currentUsername, p_company: co, p_id: id,
                p_first: first, p_last: last, p_type: type,
                p_dept: get(r, idx.dept), p_role_title: get(r, idx.role),
                p_start: get(r, idx.start) || null,
                p_pay: parseFloat(get(r, idx.pay)) || 0,
                p_ssn: get(r, idx.ssn),
                p_auto_account: false // bulk import: N one-time passwords can't be shown sanely — add logins individually afterward if needed
            });
            if (error) { fail++; console.error('import row failed:', error.message); continue; }
            employees.push({ id, person_type: type, first_name: first, last_name: last, status: 'Active', pay_rate: parseFloat(get(r, idx.pay)) || 0 });
            const details = {
                employee_id: id, company_code: co,
                id_type: (get(r, idx.idType) || 'SSN').toUpperCase() === 'ITIN' ? 'ITIN' : 'SSN',
                phone: get(r, idx.phone), email: get(r, idx.email),
                driver_license: get(r, idx.dl), dl_expiration: get(r, idx.dlExp) || null,
                work_permit: get(r, idx.wp), work_permit_exp: get(r, idx.wpExp) || null,
                medical_card: (get(r, idx.med).toLowerCase() === 'yes') ? 'Yes' : 'No',
                medical_card_exp: get(r, idx.medExp) || null, notes: get(r, idx.notes)
            };
            try {
                await supabaseClient.rpc('save_employee_details', {
                    p_actor: currentUsername, p_employee_id: id, p_company: co,
                    p_id_type: details.id_type, p_driver_license: details.driver_license, p_dl_expiration: details.dl_expiration,
                    p_work_permit: details.work_permit, p_work_permit_exp: details.work_permit_exp,
                    p_medical_card: details.medical_card, p_medical_card_exp: details.medical_card_exp,
                    p_notes: details.notes, p_phone: details.phone, p_email: details.email
                });
            } catch (e) {}
            const rawPayType = get(r, idx.payType).toLowerCase();
            const ptv = rawPayType === 'daily' ? 'Daily' : rawPayType === 'provider' ? 'Provider' : 'Weekly';
            await setPayType(id, ptv, co);
            ok++;
        }
        alert(`Import finished: ${ok} added${fail ? ', ' + fail + ' failed (see console)' : ''}.`);
        fetchEmployeesFromCloud();
    }

    async function deleteEmployee(id) {
        if(confirm("Delete employee " + id + "?")) {
            const { error } = await supabaseClient.rpc('delete_employee', { p_actor: currentUsername, p_id: id });
            if (error) alert('Error: ' + error.message);
            else fetchEmployeesFromCloud();
        }
    }

    async function generateEmployeeUser(empId) {
        if (!canEdit()) return;
        const emp = employees.find(e => e.id === empId);
        if (!emp) return;
        const name = `${emp.first_name} ${emp.last_name || ''}`.trim();
        if (!confirm(`Generate a login for ${name}?`)) return;
        const { data, error } = await supabaseClient.rpc('provision_employee_account', { p_actor: currentUsername, p_employee_id: empId });
        if (error) { alert('Error: ' + error.message); return; }
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || !row.new_username) { alert('No account was returned — check the Users tab.'); return; }
        const role = (emp.person_type === 'Owner' || emp.person_type === 'Manager') ? 'Administrator' : (emp.person_type === 'Staff' ? 'Medium' : 'User');
        employeeUserIds.add(empId);
        showNewEmployeeCredentials(name, empId, role, row.new_username, row.new_password);
        renderEmployees();
    }

    function employeeOptionLabel(emp) {
        return `${emp.first_name} ${emp.last_name} — ${emp.id}`;
    }

    function populateEmployeeDropdowns() {
        const sorted = [...employees].sort((a, b) =>
            `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, undefined, { sensitivity: 'base' })
        );
        const opts = '<option value="">— Select employee —</option>' +
            sorted.map(emp => `<option value="${emp.id}">${employeeOptionLabel(emp)}</option>`).join('');
        ['cEmployee', 'ci-employee', 'i-employee'].forEach(id => {
            const sel = document.getElementById(id);
            if (!sel) return;
            const prev = sel.value;
            sel.innerHTML = opts;
            sel.value = prev || '';
        });
        populateStatementEmployeeDropdown();
    }

    // --- CLAIMS ---
    document.getElementById('claim-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!canEdit()) return;
        const amount = parseFloat(document.getElementById('cAmount').value) || 0;
        const weekly = parseFloat(document.getElementById('cWeekly').value) || 0;
        const claimEmpId = document.getElementById('cEmployee').value;
        if (!claimEmpId) { alert('Please select a valid employee from the list.'); return; }

        const fields = {
            employee_id: claimEmpId,
            claimant_account: document.getElementById('cClaimant').value.trim(),
            company_name: document.getElementById('cCompany').value.trim(),
            carrier_claim_number: document.getElementById('cCarrier').value.trim(),
            customer_claim_number: document.getElementById('cCustomer').value.trim(),
            damage_type: document.getElementById('cDamageType').value,
            claim_amount: amount,
            weekly_deduction: weekly,
            start_date: document.getElementById('cStartDate').value || null,
            end_date: document.getElementById('cEndDate').value || null,
            status: document.getElementById('cStatus').value,
            absorbed_amount: parseFloat(document.getElementById('cAbsorbed').value) || 0,
            notes: document.getElementById('cNotes').value.trim()
        };

        if (editingClaimId) {
            // ----- EDIT (through the type-safe edit_claim RPC; Medium locked-field changes route to approval) -----
            const { data, error } = await supabaseClient.rpc('edit_claim', { p_actor: currentUsername, p_id: editingClaimId, p_fields: fields });
            if (error) { alert('Error: ' + error.message); return; }
            if (data && String(data).indexOf('approval') !== -1) alert(data);
            cancelClaimEdit();
            fetchClaimsFromCloud();
        } else {
            // ----- CREATE -----
            const claimCo = requireWriteCompany();
            if (!claimCo) return;
            const claimId = `${idPrefix()}${String(claims.length + 1).padStart(settings.claimDigits, '0')}`;
            const payload = Object.assign({ claim_id: claimId, company_code: claimCo }, fields);
            const { error } = await supabaseClient.rpc('create_claim', { p_actor: currentUsername, p_fields: payload });
            if (error) { alert('Error saving claim: ' + error.message); return; }
            document.getElementById('claim-form').reset();
            document.getElementById('cEmployee').value = '';
            fetchClaimsFromCloud();
            refreshIdPreviews();
        }
    });

    // Combined stats for the Claims & Charges tab — claims and charges are
    // separate record types, so counts are shown per kind while money totals
    // (amount, outstanding) and lifecycle counts are pooled across both.
    function updateClaimStats() {
        const grid = document.getElementById('claim-stats-grid');
        if (!grid) return;
        const claimAmt = claims.reduce((a, c) => a + (parseFloat(c.claim_amount) || 0), 0);
        const chargeAmt = charges.reduce((a, c) => a + (parseFloat(c.amount) || 0), 0);
        const claimBal = claims.reduce((a, c) => a + claimBalance(c), 0);
        const chargeBal = charges.reduce((a, c) => a + chargeBalance(c), 0);
        const both = claims.concat(charges);
        const deducting = both.filter(x => x.status === 'Deducting').length;
        const queued = both.filter(x => x.status === 'Queued').length;
        const resolved = both.filter(x => ['Absorbed', 'Tk from check', 'Paid', 'Released'].includes(x.status)).length;
        grid.innerHTML = `
            <div class="stat-card"><div class="stat-label">Claims</div><div class="stat-value">${claims.length}</div></div>
            <div class="stat-card"><div class="stat-label">Charges</div><div class="stat-value">${charges.length}</div></div>
            <div class="stat-card"><div class="stat-label">Total Amount</div><div class="stat-value">${formatMoney(claimAmt + chargeAmt)}</div></div>
            <div class="stat-card"><div class="stat-label">Outstanding</div><div class="stat-value">${formatMoney(claimBal + chargeBal)}</div></div>
            <div class="stat-card"><div class="stat-label">Deducting</div><div class="stat-value">${deducting}</div></div>
            <div class="stat-card"><div class="stat-label">Queued</div><div class="stat-value">${queued}</div></div>
            <div class="stat-card"><div class="stat-label">Resolved</div><div class="stat-value">${resolved}</div></div>
        `;
    }

    // --- NOTIFICATIONS ----------------------------------------------------
    let notifications = [];
    let notifDir = -1; // -1 = newest first (default), 1 = oldest first

    async function loadNotifications() {
        const { data, error } = await supabaseClient.rpc('get_notifications', { p_actor: currentUsername, p_company: currentCompany });
        if (error) { console.error('get_notifications:', error); notifications = []; return; }
        notifications = data || [];
        updateNotifBadge();
    }

    function updateNotifBadge() {
        const badge = document.getElementById('notif-badge');
        if (!badge) return;
        const unread = notifications.filter(n => !n.read_at).length;
        if (unread > 0) { badge.textContent = unread > 99 ? '99+' : String(unread); badge.style.display = 'inline-block'; }
        else { badge.style.display = 'none'; }
    }

    function flipNotifDir() {
        notifDir *= -1;
        const btn = document.getElementById('notif-dir-btn');
        if (btn) btn.textContent = notifDir === 1 ? '▲' : '▼';
        renderNotifications();
    }

    const NOTIF_KIND_LABEL = { claim: 'Claim', charge: 'Charge', income: 'Additional Income', document: 'Document' };
    const NOTIF_KIND_ICON = { claim: '📋', charge: '➖', income: '➕', document: '📎' };

    function renderNotifications() {
        const container = document.getElementById('notifications-tbody');
        if (!container) return;
        container.className = 'record-grid';

        const rangeDays = parseInt(document.getElementById('notif-range')?.value || '', 10);
        let list = notifications;
        if (rangeDays) {
            const cutoff = Date.now() - rangeDays * 86400000;
            list = list.filter(n => new Date(n.created_at).getTime() >= cutoff);
        }
        list = [...list].sort((a, b) => (new Date(a.created_at) - new Date(b.created_at)) * notifDir);

        if (!list.length) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_notifs')}</div>`;
            return;
        }
        container.innerHTML = '';
        list.forEach(n => {
            const unread = !n.read_at;
            const emp = employees.find(e => e.id === n.employee_id);
            const empName = emp ? `${emp.first_name} ${emp.last_name}`.trim() : n.employee_id;
            // Plain, flat notification row — deliberately not the collapsible
            // .rec-card style used elsewhere, since there's nothing to expand
            // into (everything relevant is already shown); the whole row is
            // just a single click-to-jump target.
            container.insertAdjacentHTML('beforeend', `
                <div id="rec-notif-${n.id}" style="cursor:pointer; display:flex; align-items:center; gap:10px; padding:10px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface); ${unread ? 'border-left:3px solid var(--secondary);' : 'opacity:0.7;'}" onclick="goToNotification(${n.id}, '${n.kind}', '${escJsAttr(n.record_id)}', '${escJsAttr(n.employee_id)}')">
                    <span style="font-size:18px; flex-shrink:0;">${NOTIF_KIND_ICON[n.kind] || '🔔'}</span>
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:700; font-size:13px;">New ${NOTIF_KIND_LABEL[n.kind] || n.kind}${unread ? ' <span class="status-badge status-active" style="margin-left:4px;">New</span>' : ''}</div>
                        <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">${escHtml(n.label)}${n.amount ? ' · ' + formatMoney(n.amount) : ''} · ${escHtml(empName)}</div>
                    </div>
                    <div style="text-align:right; font-family:var(--mono); font-size:11px; color:var(--text-muted); flex-shrink:0;">${n.record_id}<br>${new Date(n.created_at).toLocaleDateString()}</div>
                </div>`);
        });
    }

    async function goToNotification(notifId, kind, recordId, empId) {
        try { await supabaseClient.rpc('mark_notification_read', { p_actor: currentUsername, p_id: notifId }); } catch (e) {}
        const n = notifications.find(x => x.id === notifId);
        if (n) n.read_at = n.read_at || new Date().toISOString();
        updateNotifBadge();

        if (kind === 'document') {
            // record_id is the employee the document belongs to — open their
            // record so the reviewer lands on the Documents slots directly.
            openTab(null, 'tab-employees');
            document.getElementById('btn-tab-employees')?.classList.add('active');
            const es = document.getElementById('employee-search'); if (es) es.value = recordId;
            recExpanded.employees.add(recordId);
            renderEmployees();
        } else if (kind === 'claim' || kind === 'charge') {
            openTab(null, 'tab-claims');
            document.getElementById('btn-tab-claims')?.classList.add('active');
            const ks = document.getElementById('cc-kind'); if (ks) ks.value = kind;
            const search = document.getElementById('cc-search'); if (search) search.value = recordId;
            recExpanded[kind === 'claim' ? 'claims' : 'charges'].add(recordId);
            renderClaimsCharges();
        } else {
            openTab(null, 'tab-income');
            document.getElementById('btn-tab-income')?.classList.add('active');
            const search = document.getElementById('income-search'); if (search) search.value = recordId;
            recExpanded.income.add(recordId);
            renderIncome();
        }
        renderNotifications();
    }

    async function markAllNotificationsRead() {
        try {
            await supabaseClient.rpc('mark_all_notifications_read', { p_actor: currentUsername, p_company: currentCompany });
            notifications.forEach(n => { n.read_at = n.read_at || new Date().toISOString(); });
            updateNotifBadge();
            renderNotifications();
        } catch (e) { console.error('markAllNotificationsRead:', e); }
    }

    // ===== Combined Claims & Charges list ================================
    // Claims and charges are separate record types (own IDs, own tables, own
    // statuses) but are shown together in ONE badged, filterable list. Each
    // row/card carries a CLAIM/CHARGE badge and delegates to that kind's own
    // schedule/balance/detail/edit/delete code — nothing about either record
    // type changed; only where they're displayed did.
    function ccKindOf(r) { return Object.prototype.hasOwnProperty.call(r, 'claim_id') ? 'claim' : 'charge'; }
    function ccRecId(r)  { return ccKindOf(r) === 'claim' ? r.claim_id : r.charge_id; }
    function ccType(r)   { return ccKindOf(r) === 'claim' ? (r.damage_type || '') : (r.charge_type || ''); }
    function ccAmount(r) { return parseFloat(ccKindOf(r) === 'claim' ? r.claim_amount : r.amount) || 0; }
    function ccWeekly(r) { return ccKindOf(r) === 'claim' ? rateOn(r, todayStr()) : chargeRateOn(r, todayStr()); }
    function ccBalance(r){ return ccKindOf(r) === 'claim' ? claimBalance(r) : chargeBalance(r); }
    function ccSchedule(r){ return ccKindOf(r) === 'claim' ? buildClaimSchedule(r, null) : buildChargeSchedule(r, null); }
    function ccDetailHtml(r, empName, weeks, bal, endDate, editable) {
        return ccKindOf(r) === 'claim'
            ? claimDetailHtml(r, empName, weeks, bal, endDate, editable)
            : chargeDetailHtml(r, empName, weeks, bal, endDate, editable);
    }
    const CC_KIND_BADGE = {
        claim:  '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800;letter-spacing:.04em;background:rgba(37,99,235,.16);color:#2563eb;">CLAIM</span>',
        charge: '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:800;letter-spacing:.04em;background:rgba(220,38,38,.16);color:#dc2626;">CHARGE</span>'
    };

    // Show the New Claim form or the New Charge form (they add separate records).
    function showCCForm(kind) {
        const on = kind === 'charge' ? 'charge' : 'claim';
        const cw = document.getElementById('cc-claim-form-wrap');
        const gw = document.getElementById('cc-charge-form-wrap');
        const cb = document.getElementById('cc-seg-claim');
        const gb = document.getElementById('cc-seg-charge');
        if (cw) cw.style.display = on === 'claim' ? '' : 'none';
        if (gw) gw.style.display = on === 'charge' ? '' : 'none';
        if (cb) cb.style.background = on === 'claim' ? '' : '#64748b';
        if (gb) gb.style.background = on === 'charge' ? '' : '#64748b';
    }

    function renderClaimsCharges() {
        const container = document.getElementById('cc-tbody');
        if (!container) return;
        const q = (document.getElementById('cc-search')?.value || '').toLowerCase();
        const kindF = document.getElementById('cc-kind')?.value || '';
        const empF = document.getElementById('cc-emp')?.value || '';
        const typeF = document.getElementById('cc-type')?.value || '';
        const statF = document.getElementById('cc-status')?.value || '';
        const editable = canEdit();

        let list = [];
        if (kindF !== 'charge') list = list.concat(claims);
        if (kindF !== 'claim')  list = list.concat(charges);

        list = list.filter(r => {
            const k = ccKindOf(r);
            const emp = employees.find(e => e.id === r.employee_id);
            const empName = emp ? `${emp.first_name} ${emp.last_name}`.toLowerCase() : '';
            const matchQ = !q
                || ccRecId(r).toLowerCase().includes(q)
                || empName.includes(q)
                || (r.employee_id || '').toLowerCase().includes(q)
                || ccType(r).toLowerCase().includes(q)
                || (r.status || '').toLowerCase().includes(q)
                || (k === 'claim' && ((r.company_name || '').toLowerCase().includes(q) || (r.claimant_account || '').toLowerCase().includes(q)));
            const matchEmp = !empF || r.employee_id === empF;
            const matchType = !typeF || ccType(r) === typeF;
            const matchStat = !statF || r.status === statF;
            return matchQ && matchEmp && matchType && matchStat;
        });

        list = applySort(list, 'cc', {
            employee: r => { const e = employees.find(x => x.id === r.employee_id); return e ? `${e.first_name} ${e.last_name}` : ''; },
            kind: r => ccKindOf(r),
            id: r => ccRecId(r),
            type: r => ccType(r),
            amount: r => ccAmount(r),
            balance: r => ccBalance(r),
            status: r => r.status || '',
            start: r => r.start_date || ''
        });

        updateRecSortUI('cc');
        updateClaimStats();

        if (isDesktopView()) {
            container.className = '';
            if (!list.length) { container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_cc')}</div>`; return; }
            let rows = '';
            groupByStatus(list).forEach(({ status, items }) => {
                const collapsed = collapsedStatusGroups.cc.has(status);
                rows += `<tr class="rec-group-row" style="cursor:pointer;" onclick="toggleStatusGroup('cc','${status}')"><td colspan="13"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400;">(${items.length})</span></td></tr>`;
                if (collapsed) return;
                items.forEach(r => {
                    const k = ccKindOf(r);
                    const tbl = k === 'claim' ? 'claims' : 'charges';
                    const id = ccRecId(r);
                    const emp = employees.find(e => e.id === r.employee_id);
                    const empName = emp ? `${emp.first_name} ${emp.last_name}` : 'Unlinked';
                    const sched = ccSchedule(r);
                    const weeks = sched.rows.filter(x => !x.paused).length;
                    const bal = ccBalance(r);
                    const endDate = sched.endDate || (r.end_date || '—');
                    const open = recExpanded[tbl].has(id);
                    const editFn = k === 'claim' ? 'editClaim' : 'editCharge';
                    const delFn = k === 'claim' ? 'deleteClaim' : 'deleteCharge';
                    rows += `<tr style="cursor:pointer;" onclick="toggleRecCard('${tbl}','${id}')">
                        <td class="id-cell"><span class="rec-caret" data-caret="${tbl}-${id}">${open ? '▾' : '▸'}</span> ${id} ${attachInd(k, id)}</td>
                        <td>${CC_KIND_BADGE[k]}</td>
                        <td>${escHtml(empName)}</td>
                        <td class="id-cell">${r.employee_id}</td>
                        <td>${escHtml(ccType(r))}</td>
                        <td>${formatMoney(ccAmount(r))}</td>
                        <td>${formatMoney(ccWeekly(r))}</td>
                        <td>${weeks}</td>
                        <td>${formatMoney(bal)}</td>
                        <td>${r.start_date || '-'}</td>
                        <td>${endDate}</td>
                        <td><span class="status-badge status-${r.status}">${r.status}</span></td>
                        <td style="text-align:center; white-space:nowrap;" onclick="event.stopPropagation();">${editable ? `<button class="btn-small" style="padding:0.3rem 0.6rem;font-size:0.75rem;margin:0 3px 0 0;" onclick="${editFn}('${id}')">✎</button><button class="del-btn" onclick="${delFn}('${id}')">✕</button>` : ''}</td>
                    </tr>
                    <tr class="rec-card${open ? ' open' : ''}" id="rec-${tbl}-${id}" style="display:${open ? 'table-row' : 'none'};">
                        <td colspan="13" style="padding:12px; background:var(--surface-2);">${ccDetailHtml(r, empName, weeks, bal, endDate, editable)}</td>
                    </tr>`;
                });
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th data-i18n="d_th_id">ID</th><th data-i18n="d_th_kind">Kind</th><th data-i18n="th_employee">Employee</th><th data-i18n="th_emp_id">Emp. ID</th><th data-i18n="th_type">Type</th><th data-i18n="th_amount">Amount</th><th data-i18n="th_weekly">Weekly</th><th data-i18n="th_weeks">Weeks</th><th data-i18n="th_balance">Balance</th><th data-i18n="th_start">Start</th><th data-i18n="th_ends">Ends</th><th data-i18n="th_status">Status</th><th data-i18n="th_action">Action</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`;
            applyTranslations();
            return;
        }

        container.className = 'record-grid';
        container.innerHTML = list.length ? '' : `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_cc')}</div>`;
        groupByStatus(list).forEach(({ status, items }) => {
            const collapsed = collapsedStatusGroups.cc.has(status);
            container.insertAdjacentHTML('beforeend', `<div class="rec-group-header" style="grid-column:1/-1; cursor:pointer;" onclick="toggleStatusGroup('cc','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem;">(${items.length})</span></div>`);
            if (collapsed) return;
            items.forEach(r => {
                const k = ccKindOf(r);
                const tbl = k === 'claim' ? 'claims' : 'charges';
                const id = ccRecId(r);
                const emp = employees.find(e => e.id === r.employee_id);
                const empName = emp ? `${emp.first_name} ${emp.last_name}` : 'Unlinked';
                const sched = ccSchedule(r);
                const weeks = sched.rows.filter(x => !x.paused).length;
                const bal = ccBalance(r);
                const endDate = sched.endDate || (r.end_date || '—');
                const open = recExpanded[tbl].has(id);
                const balColor = k === 'charge' ? ' style="color:#dc2626;"' : '';
                container.insertAdjacentHTML('beforeend', `
                    <div class="rec-card${open ? ' open' : ''}" id="rec-${tbl}-${id}">
                        <div class="rec-card-head" onclick="toggleRecCard('${tbl}','${id}')">
                            <span class="rec-caret" data-caret="${tbl}-${id}">${open ? '▾' : '▸'}</span>
                            <span class="rec-title">${escHtml(empName)}</span>
                            <span class="rec-sub">${CC_KIND_BADGE[k]} ${id}</span>
                            ${attachInd(k, id)}
                            <span class="rec-right"${balColor}>${formatMoney(bal)} <span class="status-badge status-${r.status}">${r.status}</span></span>
                        </div>
                        <div class="rec-card-body">${ccDetailHtml(r, empName, weeks, bal, endDate, editable)}</div>
                    </div>`);
            });
        });
        applyTranslations();
    }

    // Back-compat aliases: every existing call site (openTab, fetch handlers,
    // notifications, global search, DED_KIND rerender, etc.) still works and
    // now drives the one combined list.
    function filterClaims() { renderClaimsCharges(); }
    function renderClaims() { renderClaimsCharges(); }

    // Shared detail content for one claim — used by BOTH the desktop
    // collapsible row and the mobile card body, so they can never drift
    // apart (same pattern as employeeDetailHtml).
    // ---- Print: claim payment schedule ----------------------------------
    function printClaimSchedule(claimId) {
        const c = claims.find(x => x.claim_id === claimId);
        if (!c) return;
        const emp = employees.find(e => e.id === c.employee_id);
        const empName = emp ? `${emp.first_name} ${emp.last_name}` : 'Unlinked';
        const sched = buildClaimSchedule(c, null);
        const bal = claimBalance(c);
        const owed = Math.max(0, (parseFloat(c.claim_amount) || 0) - (parseFloat(c.absorbed_amount) || 0));
        const paidSoFar = Math.max(0, +(owed - bal).toFixed(2));
        const rows = sched.rows.map(r => `<tr><td>${r.date}</td><td>${r.paused ? 'Paused' : formatMoney(r.deducted)}</td><td>${formatMoney(r.balance)}</td></tr>`).join('');
        document.getElementById('print-area').innerHTML = `
            <h1>Claim Payment Schedule</h1>
            <div class="print-meta">${escHtml(empName)} (${c.employee_id}) · Claim ${c.claim_id} · ${escHtml(c.damage_type || '')} · Printed ${new Date().toLocaleDateString()}</div>
            <table><tbody>
                <tr><td>Claim amount</td><td>${formatMoney(c.claim_amount)}</td></tr>
                <tr><td>Weekly rate</td><td>${formatMoney(rateOn(c, todayStr()))}</td></tr>
                <tr><td>Start date</td><td>${c.start_date || '-'}</td></tr>
                <tr><td>Status</td><td>${c.status}</td></tr>
                <tr><td>Paid so far</td><td>${formatMoney(paidSoFar)}</td></tr>
                <tr class="print-totals"><td>Current balance</td><td>${formatMoney(bal)}</td></tr>
            </tbody></table>
            <h2>Weekly Schedule</h2>
            ${rows ? `<table><thead><tr><th>Date</th><th>Deducted</th><th>Running Balance</th></tr></thead><tbody>${rows}</tbody></table>` : '<div>No schedule to print — this claim is resolved or missing a start date/weekly amount.</div>'}
        `;
        attemptPrint();
    }

    // ---- Print: charge payment schedule ----------------------------------
    function printChargeSchedule(chargeId) {
        const ch = charges.find(x => x.charge_id === chargeId);
        if (!ch) return;
        const emp = employees.find(e => e.id === ch.employee_id);
        const empName = emp ? `${emp.first_name} ${emp.last_name}` : 'Unlinked';
        const sched = buildChargeSchedule(ch, null);
        const bal = chargeBalance(ch);
        const owed = Math.max(0, parseFloat(ch.amount) || 0);
        const paidSoFar = Math.max(0, +(owed - bal).toFixed(2));
        const rows = sched.rows.map(r => `<tr><td>${r.date}</td><td>${r.paused ? 'Paused' : formatMoney(r.deducted)}</td><td>${formatMoney(r.balance)}</td></tr>`).join('');
        document.getElementById('print-area').innerHTML = `
            <h1>Charge Payment Schedule</h1>
            <div class="print-meta">${escHtml(empName)} (${ch.employee_id}) · Charge ${ch.charge_id} · ${escHtml(ch.charge_type || '')} · Printed ${new Date().toLocaleDateString()}</div>
            <table><tbody>
                <tr><td>Charge amount</td><td>${formatMoney(ch.amount)}</td></tr>
                <tr><td>Weekly rate</td><td>${formatMoney(chargeRateOn(ch, todayStr()))}</td></tr>
                <tr><td>Start date</td><td>${ch.start_date || '-'}</td></tr>
                <tr><td>Status</td><td>${ch.status}</td></tr>
                <tr><td>Paid so far</td><td>${formatMoney(paidSoFar)}</td></tr>
                <tr class="print-totals"><td>Current balance</td><td>${formatMoney(bal)}</td></tr>
            </tbody></table>
            <h2>Weekly Schedule</h2>
            ${rows ? `<table><thead><tr><th>Date</th><th>Deducted</th><th>Running Balance</th></tr></thead><tbody>${rows}</tbody></table>` : '<div>No schedule to print — this charge is resolved or missing a start date/weekly amount.</div>'}
        `;
        attemptPrint();
    }

    // ---- Print: whole statement for the selected employee ---------------
    function printStatement() {
        const empId = document.getElementById('statement-emp-select').value;
        if (!empId) { alert('Select an employee first.'); return; }
        const content = document.getElementById('statement-content');
        const statsGrid = document.getElementById('statement-stats-grid');
        const emp = employees.find(e => e.id === empId);
        const empName = emp ? `${emp.first_name} ${emp.last_name}` : empId;
        document.getElementById('print-area').innerHTML = `
            <h1>Statement — ${escHtml(empName)} (${empId})</h1>
            <div class="print-meta">Week ending ${statementAsOf()} · Printed ${new Date().toLocaleDateString()}</div>
            ${statsGrid ? statsGrid.outerHTML : ''}
            ${content.innerHTML}
        `;
        attemptPrint();
    }

    // Shared progress-bar visual (same style already used in Week in
    // Deposit) — reused wherever a total gets fulfilled incrementally over
    // weeks: claims/charges being paid down, income being paid out.
    function progressBarHtml(pct) {
        pct = Math.max(0, Math.min(100, pct || 0));
        return `<div style="background:var(--surface-2); border-radius:6px; height:8px; margin:8px 0 4px; overflow:hidden;"><div style="background:var(--primary); height:100%; width:${pct}%;"></div></div>
            <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">${pct}% paid</div>`;
    }

    // ===== Attachments =====================================================
    // One shared system for files/photos/videos on claims, charges, income,
    // invoices, bills, employees and vehicles. Metadata lives in the
    // attachments table (reached only through token-guarded RPCs); the bytes
    // live in a private Supabase Storage bucket reached only through the
    // 'attachments' Edge Function, which re-checks the session token and
    // company scope server-side and hands out short-lived signed URLs.
    // SuperAdmin is unrestricted across companies; everyone else is limited to
    // records in their own company.
    //
    // Employees and vehicles additionally use *labeled document slots*: a file
    // can be tagged as the Driver License / Work Permit / Medical Card /
    // Registration / Insurance for that record, so the Expiring Documents
    // screen can jump straight to the document that's about to expire. The
    // label is optional — an untagged file is just a general attachment.
    let attachCtx = null; // { type, id, docLabel } for the record the modal is on

    // Server-side, record_attachment only accepts these labels; anything else
    // is stored untagged. Keep the two lists in step.
    const DOC_LABELS = {
        driver_license: 'Driver License',
        work_permit: 'Work Permit',
        medical_card: 'Medical Card',
        registration: 'Registration',
        insurance: 'Insurance Card'
    };

    // Short codes for file names. Full labels are for reading on screen; these
    // keep the stored name compact — "DL-3OFL0002S-20260820.jpg" rather than
    // "Driver License — Antonio Ortiz Arevalo.jpg". Hyphens and digits only, so
    // the name also survives the storage layer's character filter untouched
    // (spaces and dashes would otherwise become runs of underscores).
    const DOC_CODES = {
        driver_license: 'DL',
        work_permit: 'WP',
        medical_card: 'MC',
        registration: 'REG',
        insurance: 'INS'
    };

    function attachBtnHtml(type, id) {
        return `<button type="button" class="btn-small" style="background:var(--excel-blue); margin:0;" onclick="event.stopPropagation(); openAttachments('${type}','${escJsAttr(String(id))}')">📎 Files</button>`;
    }

    // One labeled document slot. Solid+blue once something is uploaded,
    // dashed "+ Upload" while empty, and inert for a View Only user with
    // nothing on file (nothing to open, nothing they may add).
    function attachSlotHtml(type, id, docLabel) {
        const label = DOC_LABELS[docLabel] || 'Document';
        const n = attachmentLabelCounts[`${type}:${id}:${docLabel}`] || 0;
        if (!n && !canUploadTo(type, id)) {
            return `<span class="doc-slot muted" title="No ${escHtml(label)} on file">${escHtml(label)} <span class="doc-slot-val">—</span></span>`;
        }
        const title = n ? `${n} file${n === 1 ? '' : 's'} for ${label} — click to view` : `Upload ${label}`;
        return `<span class="doc-slot${n ? ' has-file' : ''}" title="${escHtml(title)}" onclick="event.stopPropagation(); openAttachments('${type}','${escJsAttr(String(id))}','${docLabel}')">${escHtml(label)} <span class="doc-slot-val">${n ? '📎 ' + n : '+ Upload'}</span></span>`;
    }

    // The "Documents" block shown inside an expanded employee/vehicle.
    function docSlotsHtml(type, id, labels) {
        return `<div class="detail-subhead" style="margin-top:10px;">Documents</div>
            <div class="doc-slot-row">${labels.map(l => attachSlotHtml(type, id, l)).join('')}</div>`;
    }

    // Per-record attachment counts, keyed "type:id" → number of files. Loaded
    // once per data refresh via a single scope-checked RPC so every list can
    // show a "has files" indicator without opening each record. Any change is
    // set true so the indicators can be refreshed when the Files modal closes.
    let attachmentCounts = {};        // "type:id"        -> total files
    let attachmentLabelCounts = {};   // "type:id:label"  -> files in that slot
    let attachDirty = false;

    async function loadAttachmentCounts() {
        if (!currentUsername) { attachmentCounts = {}; attachmentLabelCounts = {}; return; }
        try {
            const { data, error } = await supabaseClient.rpc('attachment_counts', { p_actor: currentUsername });
            if (error) { console.warn('attachment_counts:', error.message); return; }
            // The RPC returns one row per (entity, doc_label); the per-record
            // total is the sum across its labels (including the untagged null).
            const totals = {}, byLabel = {};
            (data || []).forEach(r => {
                const n = parseInt(r.cnt, 10) || 0;
                const key = `${r.entity_type}:${r.entity_id}`;
                totals[key] = (totals[key] || 0) + n;
                if (r.doc_label) byLabel[`${key}:${r.doc_label}`] = n;
            });
            attachmentCounts = totals;
            attachmentLabelCounts = byLabel;
        } catch (e) { console.warn('attachment_counts:', e); }
    }

    // Small paperclip+count chip for a collapsed record row/card. Renders only
    // when the record has ≥1 attached file; clicking it opens the Files modal
    // without toggling the row.
    function attachInd(type, id) {
        const n = attachmentCounts[`${type}:${id}`] || 0;
        if (!n) return '';
        return `<span class="attach-ind" title="${n} file${n === 1 ? '' : 's'} attached — click to view" onclick="event.stopPropagation(); openAttachments('${type}','${escJsAttr(String(id))}')">📎${n}</span>`;
    }

    // Re-render every list that carries attachment indicators (open cards keep
    // their state — expansion is tracked separately in recExpanded).
    function rerenderAttachmentLists() {
        ['renderClaimsCharges', 'renderIncome', 'renderInvoices', 'renderBills',
         'renderEmployees', 'renderVehicles', 'renderExpiringDocuments'].forEach(fn => {
            if (typeof window[fn] === 'function') { try { window[fn](); } catch (e) { /* tab not built yet */ } }
        });
    }

    async function efAttach(payload) {
        const res = await fetch(SUPABASE_URL + '/functions/v1/attachments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'apikey': SUPABASE_ANON_KEY },
            body: JSON.stringify(Object.assign({ token: authToken }, payload))
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
        return j;
    }

    function formatBytes(n) {
        n = parseInt(n, 10) || 0;
        if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
        if (n >= 1024) return Math.round(n / 1024) + ' KB';
        return n + ' B';
    }

    // A human label for whatever record the modal is open on — used both in
    // the modal title and to pre-fill a tidy suggested file name.
    function attachCtxName() {
        if (!attachCtx) return '';
        const { type, id } = attachCtx;
        try {
            if (type === 'employee') {
                const e = employees.find(x => x.id === id);
                return e ? `${e.first_name} ${e.last_name}`.trim() : id;
            }
            if (type === 'vehicle') {
                const v = vehicles.find(x => x.id === id);
                if (!v) return id;
                return v.truck_number ? `Truck ${v.truck_number}` : `${v.year} ${v.make} ${v.model}`.trim();
            }
        } catch (e) { /* array not loaded yet */ }
        return id;
    }

    // docLabel is optional: with it the modal shows only that document and
    // tags anything uploaded, without it it's the record's general file list.
    function openAttachments(type, id, docLabel) {
        attachCtx = { type, id, docLabel: docLabel || null };
        attachStage = [];
        attachListCache = [];
        renderAttachStage();
        const ov = document.getElementById('attachments-overlay');
        const who = attachCtxName();
        document.getElementById('attachments-title').textContent = docLabel
            ? `${DOC_LABELS[docLabel] || 'Document'} — ${who}`
            : `Files — ${id}`;
        const sub = document.getElementById('attachments-subtitle');
        if (sub) sub.textContent = docLabel
            ? `${DOC_LABELS[docLabel] || 'Document'} on file for ${who}. Optional — nothing requires an upload.`
            : 'Photos, videos and documents for this record. Optional — nothing requires an upload.';
        document.getElementById('attachments-add-btn').style.display = canUploadTo(type, id) ? 'inline-block' : 'none';
        document.getElementById('attachments-progress').textContent = '';
        ov.style.display = 'flex';
        loadAttachmentsList();
    }
    async function closeAttachments() {
        document.getElementById('attachments-overlay').style.display = 'none';
        document.getElementById('attachments-file-input').value = '';
        attachCtx = null;
        attachStage = [];
        attachListCache = [];
        renderAttachStage();
        // If files were added/removed while open, refresh the counts (and the
        // row/card indicators) from the authoritative server side.
        if (attachDirty) { attachDirty = false; await loadAttachmentCounts(); rerenderAttachmentLists(); }
    }

    let attachListCache = [];   // what's currently listed, for name suggestions

    async function loadAttachmentsList() {
        if (!attachCtx) return;
        const listEl = document.getElementById('attachments-list');
        listEl.innerHTML = '<div style="color:var(--text-muted); font-size:12px; padding:8px 0;">Loading…</div>';
        const { data, error } = await supabaseClient.rpc('list_attachments', {
            p_actor: currentUsername, p_entity_type: attachCtx.type, p_entity_id: attachCtx.id
        });
        if (error) { listEl.innerHTML = `<div style="color:#ef4444; font-size:12px;">${escHtml(error.message)}</div>`; return; }
        // Opened on a document slot: show only that document.
        let rows = data || [];
        if (attachCtx.docLabel) rows = rows.filter(a => a.doc_label === attachCtx.docLabel);
        attachListCache = rows;
        if (!rows.length) {
            listEl.innerHTML = `<div style="color:var(--text-muted); font-size:12px; padding:8px 0;">${attachCtx.docLabel ? 'Nothing uploaded for this document yet.' : 'No files attached yet.'}</div>`;
            return;
        }
        const icon = { photo: '📷', video: '🎬', document: '📄' };
        listEl.innerHTML = rows.map(a => `
            <div style="display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); font-size:12.5px;">
                <span style="font-size:16px;">${icon[a.kind] || '📄'}</span>
                <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escHtml(a.file_name)}">${escHtml(a.file_name)}${(!attachCtx.docLabel && a.doc_label) ? ` <span class="type-pill" style="font-size:9px; padding:1px 6px;">${escHtml(DOC_LABELS[a.doc_label] || a.doc_label)}</span>` : ''}</span>
                <span style="color:var(--text-muted); white-space:nowrap;">${formatBytes(a.size_bytes)}</span>
                <button type="button" class="btn-small" style="margin:0; padding:3px 9px;" onclick="viewAttachment('${escJsAttr(a.storage_path)}')">View</button>
                ${canEdit() ? `<button type="button" class="btn-small" style="margin:0; padding:3px 8px; background:var(--navy);" title="Rename this file" onclick="renameAttachmentUi(${a.id}, '${escJsAttr(a.file_name)}')">✎</button>` : ''}
                ${canEdit() ? `<span class="del-btn" style="cursor:pointer;" onclick="deleteAttachmentUi(${a.id}, '${escJsAttr(a.storage_path)}')">✕</span>` : ''}
            </div>`).join('');
    }

    // Photos are downscaled/re-encoded in the browser before upload (max
    // 1920px, JPEG q0.82) — typically shrinks a phone photo 5-10x with no
    // visible loss, saving storage. Falls back to the original file if the
    // browser can't decode it (e.g. HEIC on some platforms). Videos and
    // documents upload as-is.
    async function compressImageFile(file) {
        if (!file.type.startsWith('image/') || file.type === 'image/gif' || file.type === 'image/svg+xml') return file;
        try {
            const img = await createImageBitmap(file);
            const maxDim = 1920;
            let w = img.width, h = img.height;
            if (Math.max(w, h) > maxDim) { const s = maxDim / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.82));
            img.close && img.close();
            if (blob && blob.size < file.size) {
                return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
            }
            return file;
        } catch (e) { return file; }
    }

    // Picking files no longer uploads straight away: the files are staged with
    // an editable, pre-filled name so a camera's "IMG_20260819_223344_1.jpg"
    // can become something readable before it lands. Nothing is sent until
    // "Upload" is pressed.
    let attachStage = [];   // [{ file, name (no extension), ext }]

    function splitExt(name) {
        const m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
        return m ? { base: String(name).slice(0, -(m[1].length + 1)), ext: m[1].toLowerCase() } : { base: String(name || ''), ext: '' };
    }

    // Keep a file name to something a file system and the storage layer are
    // both happy with: no path separators or control characters, single
    // spaces, no trailing dots, bounded length. Mirrors rename_attachment's
    // server-side cleaning so the two can't disagree.
    function sanitizeAttachName(s) {
        let out = String(s == null ? '' : s)
            .replace(/[\\/\r\n\t\u0000-\u001f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\.+$/, '')
            .trim();
        return out ? out.slice(0, 120) : 'File';
    }

    // Suggested name: "{CODE}-{record id}-{YYYYMMDD}" in a document slot
    // (DL-3OFL0002S-20260820), or "{record id}-{YYYYMMDD}" for a general file,
    // with -2, -3… when that's already taken. Short, sorts by date, and stays
    // correct if the person or truck is later renamed.
    // Shared by the Files modal and the chat composer so both produce the same
    // "{CODE}-{record id}-{YYYYMMDD}" convention and can never drift apart.
    function buildAttachName(id, docLabel, taken) {
        const code = docLabel ? (DOC_CODES[docLabel] || '') : '';
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
        const base = `${code ? code + '-' : ''}${id}-${stamp}`;
        if (!taken.has(base.toLowerCase())) return base;
        let n = 2;
        while (taken.has(`${base}-${n}`.toLowerCase())) n++;
        return `${base}-${n}`;
    }

    function suggestAttachName() {
        if (!attachCtx) return 'File';
        const taken = new Set();
        (attachListCache || []).forEach(a => taken.add(splitExt(a.file_name).base.toLowerCase()));
        attachStage.forEach(st => taken.add(String(st.name).toLowerCase()));
        return buildAttachName(attachCtx.id, attachCtx.docLabel, taken);
    }

    function stageSelectedAttachments(fileList) {
        if (!attachCtx || !canUploadTo(attachCtx.type, attachCtx.id)) return;
        Array.from(fileList || []).forEach(f => {
            const { ext } = splitExt(f.name);
            attachStage.push({ file: f, name: suggestAttachName(), ext });
        });
        document.getElementById('attachments-file-input').value = '';
        renderAttachStage();
    }

    function setStagedName(i, val) { if (attachStage[i]) attachStage[i].name = val; }
    function removeStagedAttachment(i) { attachStage.splice(i, 1); renderAttachStage(); }
    function clearAttachStage() { attachStage = []; renderAttachStage(); }

    function renderAttachStage() {
        const el = document.getElementById('attachments-stage');
        if (!el) return;
        if (!attachStage.length) { el.innerHTML = ''; return; }
        el.innerHTML = `
            <div style="margin-top:10px; padding-top:10px; border-top:1px dashed var(--border);">
                <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); font-weight:700; margin-bottom:4px;">Ready to upload — rename if you like</div>
                ${attachStage.map((st, i) => `
                    <div class="stage-row">
                        <input type="text" value="${escHtml(st.name)}" oninput="setStagedName(${i}, this.value)" placeholder="File name">
                        <span class="stage-meta">${st.ext ? '.' + escHtml(st.ext) : ''} · ${formatBytes(st.file.size)}</span>
                        <span class="del-btn" style="cursor:pointer;" title="Remove" onclick="removeStagedAttachment(${i})">✕</span>
                    </div>`).join('')}
                <div style="margin-top:8px;">
                    <button type="button" class="btn-small" id="attach-upload-btn" style="margin:0;" onclick="uploadStagedAttachments()">Upload ${attachStage.length} file${attachStage.length === 1 ? '' : 's'}</button>
                    <button type="button" class="btn-small" style="margin:0 0 0 6px; background:#64748b;" onclick="clearAttachStage()">Cancel</button>
                </div>
            </div>`;
    }

    async function uploadStagedAttachments() {
        if (!attachCtx || !attachStage.length || !canUploadTo(attachCtx.type, attachCtx.id)) return;
        const prog = document.getElementById('attachments-progress');
        const btn = document.getElementById('attach-upload-btn');
        if (btn) btn.disabled = true;
        const items = attachStage.slice();
        let done = 0, failed = 0;
        for (let i = 0; i < items.length; i++) {
            const st = items[i];
            prog.textContent = `Uploading ${i + 1} of ${items.length}…`;
            try {
                if (st.file.size > 104857600) throw new Error(`${st.file.name}: over the 100 MB limit`);
                const file = await compressImageFile(st.file);
                // compressImageFile may re-encode to JPEG, so take the
                // extension from what's actually being uploaded.
                const ext = splitExt(file.name).ext || st.ext;
                const finalName = sanitizeAttachName(st.name) + (ext ? '.' + ext : '');
                const signed = await efAttach({ action: 'sign-upload', entity_type: attachCtx.type, entity_id: attachCtx.id, file_name: finalName });
                const up = await fetch(signed.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
                if (!up.ok) throw new Error('Upload failed (HTTP ' + up.status + ')');
                const { error } = await supabaseClient.rpc('record_attachment', {
                    p_actor: currentUsername, p_entity_type: attachCtx.type, p_entity_id: attachCtx.id,
                    p_storage_path: signed.path, p_file_name: finalName,
                    p_mime_type: file.type || null, p_size_bytes: file.size, p_kind: null,
                    p_doc_label: attachCtx.docLabel || null
                });
                if (error) throw new Error(error.message);
                done++;
            } catch (e) {
                failed++;
                console.error('attachment upload:', e);
                alert('Could not upload: ' + (e && e.message ? e.message : e));
            }
        }
        prog.textContent = failed ? `${done} uploaded, ${failed} failed.` : `${done} file${done === 1 ? '' : 's'} uploaded.`;
        attachStage = [];
        renderAttachStage();
        document.getElementById('attachments-file-input').value = '';
        if (done) attachDirty = true;
        loadAttachmentsList();
    }

    // Rename a file that's already uploaded — display name only, the stored
    // object is never moved. The extension is held back from the prompt so it
    // can't be lost or mangled.
    async function renameAttachmentUi(id, current) {
        if (!canEdit()) return;
        const { base, ext } = splitExt(current);
        const next = prompt('Rename file', base);
        if (next === null) return;
        const finalName = sanitizeAttachName(next) + (ext ? '.' + ext : '');
        if (finalName === current) return;
        const { error } = await supabaseClient.rpc('rename_attachment', {
            p_actor: currentUsername, p_id: id, p_file_name: finalName
        });
        if (error) { alert('Error: ' + error.message); return; }
        loadAttachmentsList();
    }

    async function viewAttachment(path) {
        try {
            const r = await efAttach({ action: 'sign-download', path });
            window.open(r.signedUrl, '_blank');
        } catch (e) { alert('Could not open file: ' + (e && e.message ? e.message : e)); }
    }

    async function deleteAttachmentUi(id, path) {
        if (!canEdit()) return;
        if (!confirm('Delete this file? This cannot be undone.')) return;
        const { data, error } = await supabaseClient.rpc('delete_attachment', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        try { await efAttach({ action: 'delete-object', path: data || path }); } catch (e) { console.warn('storage object cleanup:', e); }
        attachDirty = true;
        loadAttachmentsList();
    }

    function claimDetailHtml(c, empName, weeks, bal, endDate, editable) {
        const owed = Math.max(0, (parseFloat(c.claim_amount) || 0) - (parseFloat(c.absorbed_amount) || 0));
        const pct = owed > 0 ? Math.round(((owed - bal) / owed) * 100) : 0;
        return `
            ${progressBarHtml(pct)}
            <div class="rec-detail-grid">
                <div><div class="k" data-i18n="d_employee">Employee</div><div class="v">${escHtml(empName)}</div></div>
                <div><div class="k" data-i18n="d_employee_id">Employee ID</div><div class="v id-cell">${c.employee_id}</div></div>
                <div><div class="k" data-i18n="d_claimant_acct">Claimant acct</div><div class="v">${escHtml(c.claimant_account || '-')}</div></div>
                <div><div class="k" data-i18n="d_company">Company</div><div class="v">${escHtml(c.company_name || '-')}</div></div>
                <div><div class="k" data-i18n="d_carrier_claim">Carrier claim #</div><div class="v">${escHtml(c.carrier_claim_number || '-')}</div></div>
                <div><div class="k" data-i18n="d_customer_claim">Customer claim #</div><div class="v">${escHtml(c.customer_claim_number || '-')}</div></div>
                <div><div class="k" data-i18n="d_type_damage">Type of damage</div><div class="v">${escHtml(c.damage_type)}</div></div>
                <div><div class="k" data-i18n="d_claim_amount">Claim amount</div><div class="v">${formatMoney(c.claim_amount)}</div></div>
                <div><div class="k" data-i18n="d_weeks">Weeks</div><div class="v">${weeks}</div></div>
                <div><div class="k" data-i18n="d_balance">Balance</div><div class="v">${formatMoney(bal)}</div></div>
                <div><div class="k" data-i18n="d_absorbed">Absorbed</div><div class="v">${formatMoney(c.absorbed_amount)}</div></div>
                <div><div class="k" data-i18n="d_start_ded">Start ded.</div><div class="v">${c.start_date || '-'}</div></div>
                <div><div class="k" data-i18n="d_end_ded">End ded.</div><div class="v">${endDate}</div></div>
            </div>
            ${c.notes ? `<div class="detail-subhead" style="margin-top:8px;" data-i18n="d_notes">Notes</div><div class="note-box" style="margin:0;">${escHtml(c.notes)}</div>` : ''}
            <div class="rec-actions">
                ${attachBtnHtml('claim', c.claim_id)}
                ${editable ? `<button class="btn-small" style="margin:0;" onclick="editClaim('${c.claim_id}')" data-i18n="d_edit_full">✎ Edit</button>
                <button class="del-btn" onclick="deleteClaim('${c.claim_id}')" data-i18n="d_delete">✕ Delete</button>` : ''}
            </div>`;
    }

    function renderClaimsTable(list) {
        // Legacy shim: the standalone claims table was merged into the combined
        // Claims & Charges list (renderClaimsCharges). Kept as a delegating
        // no-op so any stray caller still renders the right thing.
        return renderClaimsCharges();
    }

    async function deleteClaim(id) {
        if (!canEdit()) return;
        if(confirm("Delete claim " + id + "?")) {
            const { error } = await supabaseClient.rpc('delete_claim', { p_actor: currentUsername, p_id: id });
            if (error) alert('Error: ' + error.message);
            fetchClaimsFromCloud();
        }
    }

    // --- Claims Excel/CSV import -----------------------------------------
    // Built against a "Tracker" tab shaped like: Company Name, Internal
    // RefClaim, Employee ID, Employee, RXO Claim #, Costco/Lowe's Claim #,
    // Claim Description, Claim amount, Processing Fee Included, Weeks,
    // Weekly amount, Balance, Deduction Start Date, Deduction End Date,
    // Status, Absorved amount, Comments. "Employee ID" is intentionally
    // ignored for matching (it's a legacy scheme, not this app's IDs) —
    // matching is done by the Employee name column instead. "Weeks",
    // "Balance", and "Processing Fee Included" are intentionally skipped —
    // the app computes weeks/balance itself from claim_amount, absorbed
    // amount, weekly rate, and status, so importing stale numbers for those
    // would just be overwritten by the live calculation anyway.

    // Strip separators/punctuation so e.g. "Hans / Hamsa Express Llc" and
    // "Hans - Hamsa Express Llc" compare equal, and so a name with a middle
    // name in one source but not the other can still be compared token-wise.
    function normalizeNameForMatch(s) {
        return String(s || '')
            .replace(/[()\/,\-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    // Returns a matched employee id, or null if nothing safe to assign.
    // Most employee records in this app keep the full name in first_name
    // with last_name blank, so an exact match against first_name alone
    // covers the large majority of cases.
    function matchEmployeeByName(rawName) {
        const target = normalizeNameForMatch(rawName);
        if (!target) return null;
        let hit = employees.find(e => normalizeNameForMatch(e.first_name) === target);
        if (hit) return hit.id;
        hit = employees.find(e => normalizeNameForMatch(`${e.first_name} ${e.last_name}`) === target);
        if (hit) return hit.id;
        // Unambiguous prefix match either direction (e.g. source has "Raul"
        // and the roster has "Raul Monroy") — only when exactly one
        // employee qualifies, since guessing wrong is worse than leaving
        // the field blank for manual review.
        const candidates = employees.filter(e => {
            const full = normalizeNameForMatch(e.first_name);
            if (!full) return false;
            return full.startsWith(target + ' ') || target.startsWith(full + ' ') ||
                   full.endsWith(' ' + target) || target.endsWith(' ' + full);
        });
        return candidates.length === 1 ? candidates[0].id : null;
    }

    // Source files use their own status vocabulary; this app's Claims form
    // only offers 5 (Queued/Deducting/Paid/Absorbed/Tk from check). Anything
    // that doesn't map cleanly falls back to Queued (the safest default —
    // it won't actively deduct anything) with the original text preserved
    // in Notes so it's easy to find and fix.
    const CLAIM_STATUS_MAP = {
        'paused':         { status: 'Deducting', note: 'Originally "Paused" in import — needs a manual pause entry (Claims tab)' },
        'paid':           { status: 'Paid', note: null },
        'deducting':      { status: 'Deducting', note: null },
        'tk frlast check':{ status: 'Tk from check', note: null },
        'tk from check':  { status: 'Tk from check', note: null },
        'pending':        { status: 'Queued', note: 'Originally "Pending" in import' },
        'absorved':       { status: 'Absorbed', note: null },
        'absorbed':       { status: 'Absorbed', note: null },
        'queued':         { status: 'Queued', note: null },
        'wrong':          { status: 'Queued', note: 'Originally "Wrong" in import — flagged for manual review' },
        'team notified':  { status: 'Queued', note: 'Originally "Team Notified" in import — flagged for manual review' },
        'drop claim':     { status: 'Absorbed', note: 'Originally "Drop Claim" in import — treated as written off, please verify' }
    };
    function mapClaimStatus(raw) {
        const key = String(raw || '').trim().toLowerCase();
        if (!key) return { status: 'Queued', note: 'No status in source file' };
        return CLAIM_STATUS_MAP[key] || { status: 'Queued', note: `Originally "${raw}" in import — unrecognized status, flagged for manual review` };
    }

    function excelSerialToDateStr(v) {
        if (v === null || v === undefined || v === '') return null;
        if (v instanceof Date) return v.toISOString().split('T')[0];
        if (typeof v === 'number') {
            const excelEpoch = new Date(Date.UTC(1899, 11, 30));
            return new Date(excelEpoch.getTime() + v * 86400000).toISOString().split('T')[0];
        }
        const d = new Date(String(v).trim());
        return isNaN(d) ? null : d.toISOString().split('T')[0];
    }

    // Scans the first few rows for one that looks like the real header (has
    // both an "Employee" and a "Claim amount" column) instead of assuming a
    // fixed row number, since this file's real header sits on row 7 under
    // several metadata rows.
    function findClaimsHeaderRow(sheet) {
        const ref = sheet['!ref'];
        if (!ref) return 0;
        const range = XLSX.utils.decode_range(ref);
        const maxR = Math.min(range.e.r, range.s.r + 14);
        for (let r = range.s.r; r <= maxR; r++) {
            let hasEmployee = false, hasAmount = false;
            for (let c = range.s.c; c <= range.e.c; c++) {
                const cell = sheet[XLSX.utils.encode_cell({ r, c })];
                const v = cell ? String(cell.v || '').toLowerCase() : '';
                if (v.includes('employee')) hasEmployee = true;
                if (v.includes('claim amount')) hasAmount = true;
            }
            if (hasEmployee && hasAmount) return r;
        }
        return 0;
    }

    // Daily Pay registry import — expects the same layout as the exported
    // weekly registry: row 1 = column labels, row 2 = the actual date for
    // each of the 7 day columns (Sun..Sat, columns C..I), row 3+ = one
    // employee per row with that week's daily amounts (or "OFF").
    // ===== IMPORT (individual + combined) =================================
    // Each processX(rows) takes already-parsed row objects (works whether
    // they came from that section's own single-sheet file or one sheet
    // pulled out of a combined multi-sheet "Import All" file) and returns
    // {imported, skipped, errors}. Resolves an employee either by an exact
    // "Employee ID" match (what our own export always produces) or, failing
    // that, by name — so a hand-edited file still has a fighting chance.
    function resolveRowEmployeeId(row) {
        const rawId = String(row['Employee ID'] || '').trim();
        if (rawId && employees.some(e => e.id === rawId)) return rawId;
        const rawName = String(row['Employee'] || row['Employee Name'] || '').trim();
        if (rawName) return matchEmployeeByName(rawName);
        return null;
    }

    async function processClaimRows(rows) {
        let imported = 0, skipped = 0; const errors = [];
        for (const row of rows) {
            const empId = resolveRowEmployeeId(row);
            if (!empId) { skipped++; errors.push(`Row skipped — no matching employee (Claim ID ${row['Claim ID'] || '?'})`); continue; }
            const fields = {
                employee_id: empId, claimant_account: row['Claimant Account'] || null, company_name: row['Company'] || null,
                carrier_claim_number: row['Carrier Claim #'] || null, customer_claim_number: row['Customer Claim #'] || null,
                damage_type: row['Damage Type'] || '', claim_amount: parseFloat(row['Claim Amount']) || 0,
                weekly_deduction: parseFloat(row['Weekly Deduction']) || 0, start_date: row['Start Date'] || null,
                end_date: row['End Date'] || null, status: row['Status'] || 'Queued',
                absorbed_amount: parseFloat(row['Absorbed Amount']) || 0, notes: row['Notes'] || null
            };
            const existingId = String(row['Claim ID'] || '').trim();
            const exists = existingId && claims.some(c => c.claim_id === existingId);
            if (exists) {
                const { error } = await supabaseClient.rpc('edit_claim', { p_actor: currentUsername, p_id: existingId, p_fields: fields });
                if (error) { skipped++; errors.push(`${existingId}: ${error.message}`); continue; }
            } else {
                const co = requireWriteCompany(); if (!co) { skipped++; continue; }
                const newId = `${idPrefix()}${String(claims.length + imported + 1).padStart(settings.claimDigits, '0')}`;
                const { error } = await supabaseClient.rpc('create_claim', { p_actor: currentUsername, p_fields: { claim_id: newId, company_code: co, ...fields } });
                if (error) { skipped++; errors.push(`New claim: ${error.message}`); continue; }
            }
            imported++;
        }
        return { imported, skipped, errors };
    }

    async function processChargeRows(rows) {
        let imported = 0, skipped = 0; const errors = [];
        for (const row of rows) {
            const empId = resolveRowEmployeeId(row);
            if (!empId) { skipped++; errors.push(`Row skipped — no matching employee (Charge ID ${row['Charge ID'] || '?'})`); continue; }
            const fields = {
                employee_id: empId, charge_type: row['Charge Type'] || '', amount: parseFloat(row['Amount']) || 0,
                weekly_deduction: parseFloat(row['Weekly Deduction']) || 0, start_date: row['Start Date'] || null,
                end_date: row['End Date'] || null, status: row['Status'] || 'Queued', notes: row['Notes'] || null
            };
            const existingId = String(row['Charge ID'] || '').trim();
            const exists = existingId && charges.some(c => c.charge_id === existingId);
            if (exists) {
                const { error } = await supabaseClient.rpc('edit_charge', { p_actor: currentUsername, p_id: existingId, p_fields: fields });
                if (error) { skipped++; errors.push(`${existingId}: ${error.message}`); continue; }
            } else {
                const co = requireWriteCompany(); if (!co) { skipped++; continue; }
                const newId = `${idPrefix()}${String(charges.length + imported + 1).padStart(settings.chargeDigits, '0')}${settings.chargeSuffix}`;
                const { error } = await supabaseClient.rpc('create_charge', { p_actor: currentUsername, p_fields: { charge_id: newId, company_code: co, ...fields } });
                if (error) { skipped++; errors.push(`New charge: ${error.message}`); continue; }
            }
            imported++;
        }
        return { imported, skipped, errors };
    }

    async function processIncomeRows(rows) {
        let imported = 0, skipped = 0; const errors = [];
        for (const row of rows) {
            const empId = resolveRowEmployeeId(row);
            if (!empId) { skipped++; errors.push(`Row skipped — no matching employee (Income ID ${row['Income ID'] || '?'})`); continue; }
            const income_type = row['Income Type'] || '', amount = parseFloat(row['Amount']) || 0,
                  weekly_amount = parseFloat(row['Weekly Amount']) || 0, start_date = row['Start Date'] || null,
                  status = row['Status'] || 'Queued', notes = row['Notes'] || null;
            const existingId = String(row['Income ID'] || '').trim();
            const exists = existingId && additionalIncome.some(i => i.income_id === existingId);
            if (exists) {
                const { error } = await supabaseClient.rpc('edit_income', { p_actor: currentUsername, p_id: existingId, p_income_type: income_type, p_amount: amount, p_weekly_amount: weekly_amount, p_start_date: start_date, p_status: status, p_notes: notes });
                if (error) { skipped++; errors.push(`${existingId}: ${error.message}`); continue; }
            } else {
                const co = requireWriteCompany(); if (!co) { skipped++; continue; }
                const newId = `${idPrefix()}${String(additionalIncome.length + imported + 1).padStart(5, '0')}I`;
                const { error } = await supabaseClient.rpc('create_income', { p_actor: currentUsername, p_fields: { income_id: newId, company_code: co, employee_id: empId, income_type, amount, weekly_amount, start_date, status, notes } });
                if (error) { skipped++; errors.push(`New income: ${error.message}`); continue; }
            }
            imported++;
        }
        return { imported, skipped, errors };
    }

    async function processVehicleRows(rows) {
        let imported = 0, skipped = 0; const errors = [];
        for (const row of rows) {
            const co = requireWriteCompany(); if (!co) { skipped++; continue; }
            const fields = {
                p_truck_number: row['Truck #'] || null, p_year: row['Year'] || null, p_make: row['Make'] || '',
                p_model: row['Model'] || '', p_plate: row['Plate'] || null, p_vin: row['VIN'] || null,
                p_reg_expiry: row['Reg Expiry'] || null, p_insurance_company: row['Insurance Company'] || null,
                p_insurance_policy: row['Insurance Policy'] || null, p_insurance_expiry: row['Insurance Expiry'] || null,
                p_notes: row['Notes'] || null
            };
            const existingId = String(row['Vehicle ID'] || '').trim();
            const exists = existingId && vehicles.some(v => v.id === existingId);
            if (exists) {
                const { error } = await supabaseClient.rpc('update_vehicle', { p_actor: currentUsername, p_id: existingId, ...fields });
                if (error) { skipped++; errors.push(`${existingId}: ${error.message}`); continue; }
            } else {
                const newId = `${idPrefix()}${String(vehicles.length + imported + 1).padStart(4, '0')}V`;
                const { error } = await supabaseClient.rpc('create_vehicle', { p_actor: currentUsername, p_id: newId, p_company: co, ...fields });
                if (error) { skipped++; errors.push(`New vehicle: ${error.message}`); continue; }
            }
            imported++;
        }
        return { imported, skipped, errors };
    }

    async function processProviderPayRows(rows) {
        let imported = 0, skipped = 0; const errors = [];
        for (const row of rows) {
            const empId = resolveRowEmployeeId(row);
            if (!empId) { skipped++; errors.push(`Row skipped — no matching employee (${row['Year'] || '?'}/${row['Week'] || '?'})`); continue; }
            const { error } = await supabaseClient.rpc('save_provider_pay', {
                p_actor: currentUsername, p_employee_id: empId, p_year: String(row['Year'] || ''), p_week: String(row['Week'] || ''),
                p_amount: parseFloat(row['Amount']) || 0, p_notes: row['Notes'] || null
            });
            if (error) { skipped++; errors.push(`${empId} ${row['Year']}/${row['Week']}: ${error.message}`); continue; }
            imported++;
        }
        return { imported, skipped, errors };
    }

    function readWorkbookFromEvent(event) {
        return new Promise((resolve, reject) => {
            const file = event.target.files[0];
            if (!file) { resolve(null); return; }
            const reader = new FileReader();
            reader.onload = (evt) => {
                try { resolve(XLSX.read(new Uint8Array(evt.target.result), { type: 'array' })); }
                catch (e) { reject(e); }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }
    function sheetRows(workbook, name) {
        const sheet = workbook.Sheets[name];
        return sheet ? XLSX.utils.sheet_to_json(sheet) : null;
    }

    async function importChargesExcel(event) {
        if (!canEdit()) { alert('You do not have permission to import.'); event.target.value = ''; return; }
        const wb = await readWorkbookFromEvent(event); if (!wb) return;
        const rows = sheetRows(wb, wb.SheetNames.find(n => n.toLowerCase().includes('charge')) || wb.SheetNames[0]) || [];
        const res = await processChargeRows(rows);
        alert(`Imported ${res.imported} charge(s).${res.skipped ? ` ${res.skipped} skipped:\n` + res.errors.slice(0, 10).join('\n') : ''}`);
        event.target.value = '';
        fetchChargesFromCloud();
    }
    // "Week in Deposit" import — creates/refreshes "Semana de Fondo" savings-
    // goal charges straight from the weekly deposit tracking spreadsheet:
    // column A = employee name, columns B onward = one date per week with
    // that week's deducted/saved amount, then summary columns further right
    // for "already paid" / the goal amount / what's still owed. Builds each
    // employee's week-by-week history as a charge_rate_changes step
    // function (one entry per week the amount actually changes) so the
    // existing chargeBalance()/buildChargeSchedule() engine reproduces the
    // exact same numbers — that engine already caps a week's deduction to
    // whatever balance remains and stops walking forward once it hits zero,
    // which is exactly "no dates shown after the goal is reached", with no
    // special-casing needed here.
    //
    // Safe to re-run: an employee who already has a Semana de Fondo charge
    // FROM A PRIOR RUN OF THIS SAME IMPORT (identified by its notes) gets
    // that old charge and its rate changes deleted and replaced with fresh
    // ones from the new file — so re-uploading an updated spreadsheet
    // rewrites the numbers instead of silently skipping everyone. An
    // employee whose existing Semana de Fondo charge was entered manually
    // (no such note) is left alone and skipped, to protect hand-entered
    // data this import didn't create.
    //
    // New charge_id numbers are always one past the highest existing charge
    // number across ALL charges (any type, not just this one) — never
    // charges.length — so a manually deleted charge anywhere in the middle
    // of the sequence can never cause two charges to collide on the same
    // ID, and numbers only ever move forward, never get reused.
    // Extracts the padded sequence number from an app-generated ID like
    // "3OFL00042D" — strips the current company prefix first, THEN
    // matches digits in what's left, rather than matching the first digit
    // run in the whole string. That distinction matters here specifically
    // because this app's real prefix ("3OFL") itself starts with a digit:
    // a naive /(\d+)/ match against "3OFL00042D" grabs just the leading
    // "3" (from "3OFL"), not "00042" — silently returning 3 instead of 42.
    // Found via Node-testing this exact function against a realistic ID
    // before shipping the new invoice/bill numbering below, which reuses
    // it — and which is also what nextChargeNumber() (already live since
    // v2.91) had been doing wrong the whole time. No real damage happened
    // yet: the only caller (Week in Deposit import) hasn't been re-run
    // since v2.91, confirmed via the still-unchanged 42-row charges count.
    function extractIdNumber(id) {
        const s = String(id || '');
        const p = idPrefix();
        const rest = (p && s.startsWith(p)) ? s.slice(p.length) : s;
        const m = rest.match(/\d+/);
        return m ? parseInt(m[0], 10) : 0;
    }

    function nextChargeNumber() {
        let max = 0;
        charges.forEach(c => { max = Math.max(max, extractIdNumber(c.charge_id)); });
        return max;
    }

    async function importWeekInDepositExcel(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (!canEdit()) { alert('You do not have permission to import.'); event.target.value = ''; return; }
        const co = requireWriteCompany();
        if (!co) { event.target.value = ''; return; }
        const reader = new FileReader();
        reader.onload = async function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const ws = workbook.Sheets[sheetName];
                if (!ws['!ref']) { alert('The file appears to be empty.'); return; }
                const range = XLSX.utils.decode_range(ws['!ref']);

                // Date columns: column B (index 1) onward, for as long as the
                // header row holds a real Excel date (numeric cell type).
                let dateColCount = 0;
                while (true) {
                    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: 1 + dateColCount })];
                    if (!cell || cell.t !== 'n') break;
                    dateColCount++;
                }
                if (dateColCount < 1) { alert('Could not find any week/date columns starting at column B — check the file format.'); return; }

                // Locate the goal ("cantidad final") column among the summary
                // headers after the date block by text match, not a fixed
                // column letter, so a re-export with a shifted column still
                // reads the right one.
                let goalCol = -1;
                for (let c = 1 + dateColCount; c <= range.e.c; c++) {
                    const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
                    const h = cell ? String(cell.v || '').toLowerCase() : '';
                    if (h.includes('final') || h.includes('goal') || h.includes('meta')) { goalCol = c; break; }
                }
                if (goalCol < 0) { alert('Could not find the goal amount column (expected a header containing "final" or "goal") after the date columns.'); return; }

                // Rebuild the week dates from column B's date, stepping +7
                // days per column, rather than trusting every stored date —
                // this file's later columns can roll into the next year but
                // keep the same year number as the first pass through the
                // calendar, which would otherwise place those weeks before
                // the ones they actually follow.
                const baseCell = ws[XLSX.utils.encode_cell({ r: 0, c: 1 })];
                const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                const baseDate = new Date(excelEpoch.getTime() + baseCell.v * 86400000);
                if (isNaN(baseDate)) { alert("Could not read the first week's date in column B."); return; }
                const dateStrs = [];
                for (let i = 0; i < dateColCount; i++) {
                    const d = new Date(baseDate);
                    d.setUTCDate(d.getUTCDate() + 7 * i);
                    dateStrs.push(d.toISOString().split('T')[0]);
                }
                const stopperDate = new Date(baseDate);
                stopperDate.setUTCDate(stopperDate.getUTCDate() + 7 * dateColCount);
                const stopperDateStr = stopperDate.toISOString().split('T')[0];

                const newCharges = [];
                const newRateChanges = [];
                const unmatched = []; // {row, name}
                const negativeFlags = []; // employee names with a negative (correction/withdrawal) week, treated as $0
                const oldChargeIdsToReplace = []; // prior-import charges being rewritten
                let protectedSkip = 0, noGoal = 0;
                let nextNum = nextChargeNumber();

                for (let r = 1; r <= range.e.r; r++) {
                    const nameCell = ws[XLSX.utils.encode_cell({ r, c: 0 })];
                    const name = nameCell ? String(nameCell.v || '').trim() : '';
                    if (!name) continue;
                    const empId = matchEmployeeByName(name);
                    if (!empId) { unmatched.push({ row: r + 1, name }); continue; }

                    const existing = charges.find(c => c.employee_id === empId && c.charge_type === WEEK_DEPOSIT_TYPE);
                    if (existing) {
                        if (existing.notes === 'Imported from Week in Deposit spreadsheet') {
                            oldChargeIdsToReplace.push(existing.charge_id);
                        } else {
                            protectedSkip++; continue; // manually entered — never touched by this import
                        }
                    }

                    const goalCell = ws[XLSX.utils.encode_cell({ r, c: goalCol })];
                    const goal = parseFloat(goalCell ? goalCell.v : 0) || 0;
                    if (goal <= 0) { noGoal++; continue; }

                    const weekly = [];
                    let hadNegative = false;
                    for (let i = 0; i < dateColCount; i++) {
                        const cell = ws[XLSX.utils.encode_cell({ r, c: 1 + i })];
                        const v = cell ? parseFloat(cell.v) : NaN;
                        const clean = isNaN(v) ? 0 : v;
                        if (clean < 0) hadNegative = true;
                        weekly.push(Math.max(0, clean)); // charge_rate_changes can't hold a negative weekly amount (the manual entry form rejects it too), so a correction/withdrawal week is treated as $0 rather than dropped or misapplied
                    }
                    if (hadNegative) negativeFlags.push(name);
                    const totalSaved = weekly.reduce((a, b) => a + b, 0);
                    const reached = totalSaved >= goal - 0.004;

                    const rcRows = [];
                    let prevRate = weekly[0];
                    for (let i = 1; i < dateColCount; i++) {
                        if (Math.abs(weekly[i] - prevRate) > 0.004) {
                            rcRows.push({ effective_date: dateStrs[i], weekly_amount: weekly[i] });
                            prevRate = weekly[i];
                        }
                    }
                    // Caps the schedule from projecting forever at the last
                    // known rate past the edge of what this file actually
                    // records — a no-op once the goal is already reached by
                    // then, since the balance hits zero first either way.
                    rcRows.push({ effective_date: stopperDateStr, weekly_amount: 0 });

                    nextNum++;
                    const chargeId = `${idPrefix()}${String(nextNum).padStart(settings.chargeDigits, '0')}${settings.chargeSuffix}`;
                    newCharges.push({
                        charge_id: chargeId, company_code: co, employee_id: empId, charge_type: WEEK_DEPOSIT_TYPE,
                        amount: goal, weekly_deduction: weekly[0], start_date: dateStrs[0], end_date: null,
                        status: reached ? 'Paid' : 'Deducting', notes: 'Imported from Week in Deposit spreadsheet'
                    });
                    rcRows.forEach(rc => newRateChanges.push({ company_code: co, charge_id: chargeId, effective_date: rc.effective_date, weekly_amount: rc.weekly_amount }));
                }

                if (!newCharges.length) {
                    let msg = 'Nothing to import.';
                    if (protectedSkip) msg += ` ${protectedSkip} employee(s) have a manually-entered "Semana de Fondo" charge and were left alone.`;
                    if (noGoal) msg += ` ${noGoal} employee(s) had no goal amount.`;
                    if (unmatched.length) msg += ` ${unmatched.length} name(s) couldn't be matched to an employee.`;
                    alert(msg);
                    event.target.value = '';
                    return;
                }

                // Replacing a prior import run, plus the fresh insert, plus
                // an audit_log entry for the whole operation, all happen
                // server-side in one RPC now — this used to be raw
                // client-side .insert()/.delete() calls straight against
                // the tables, which worked but left the whole import
                // completely invisible in the audit log (only a proper
                // SECURITY DEFINER RPC calls _audit() in this app; nothing
                // does that automatically just because a row got written).
                const { error: importError } = await supabaseClient.rpc('import_week_deposit_charges', {
                    p_actor: currentUsername, p_company: co,
                    p_replace_ids: oldChargeIdsToReplace.length ? oldChargeIdsToReplace : null,
                    p_charges: newCharges, p_rate_changes: newRateChanges
                });
                const insertFailed = importError ? newCharges.length : 0;
                if (importError) console.error('week-in-deposit import failed:', importError.message);

                await fetchChargesFromCloud();
                await loadChargeHistory();
                renderCharges();

                const replacedCount = oldChargeIdsToReplace.length;
                const createdCount = newCharges.length - replacedCount;
                let msg = '';
                if (createdCount > 0) msg += `Created ${createdCount} new "Semana de Fondo" charge(s). `;
                if (replacedCount > 0) msg += `Refreshed ${replacedCount} existing one(s) from this file with updated numbers. `;
                if (insertFailed) msg += `${insertFailed} failed to save (see browser console). `;
                if (protectedSkip) msg += `\n${protectedSkip} employee(s) already have a manually-entered charge and were left alone.`;
                if (noGoal) msg += `\n${noGoal} employee(s) had no goal amount and were skipped.`;
                if (unmatched.length) {
                    msg += `\n${unmatched.length} name(s) couldn't be matched to an employee — a correction file was downloaded.`;
                    downloadWeekDepositCorrectionReport(unmatched, sheetName);
                }
                if (negativeFlags.length) {
                    msg += `\n${negativeFlags.length} employee(s) had a negative amount in one week (a correction/withdrawal) that was treated as $0, since a rate can't go negative in this app: ${negativeFlags.join(', ')}. Double-check those against the source file.`;
                }
                alert(msg);
                event.target.value = '';
            } catch (err) {
                alert('Error importing file: ' + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function downloadWeekDepositCorrectionReport(unmatched, sourceSheetName) {
        const rows = unmatched.map(u => ({
            'Row in source file': u.row,
            'Name as entered': u.name,
            'Correct Employee ID or Name': '',
            'Notes': ''
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 28 }, { wch: 30 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Corrections needed');
        XLSX.writeFile(wb, `Week_in_Deposit_Corrections_${sourceSheetName}.xlsx`);
    }

    async function importIncomeExcel(event) {
        if (!canEdit()) { alert('You do not have permission to import.'); event.target.value = ''; return; }
        const wb = await readWorkbookFromEvent(event); if (!wb) return;
        const rows = sheetRows(wb, wb.SheetNames.find(n => n.toLowerCase().includes('income')) || wb.SheetNames[0]) || [];
        const res = await processIncomeRows(rows);
        alert(`Imported ${res.imported} income record(s).${res.skipped ? ` ${res.skipped} skipped:\n` + res.errors.slice(0, 10).join('\n') : ''}`);
        event.target.value = '';
        fetchIncomeFromCloud();
    }
    async function importVehiclesExcel(event) {
        if (!canEdit()) { alert('You do not have permission to import.'); event.target.value = ''; return; }
        const wb = await readWorkbookFromEvent(event); if (!wb) return;
        const rows = sheetRows(wb, wb.SheetNames.find(n => n.toLowerCase().includes('vehicle')) || wb.SheetNames[0]) || [];
        const res = await processVehicleRows(rows);
        alert(`Imported ${res.imported} vehicle(s).${res.skipped ? ` ${res.skipped} skipped:\n` + res.errors.slice(0, 10).join('\n') : ''}`);
        event.target.value = '';
        fetchVehiclesFromCloud();
    }
    async function importProviderPayExcel(event) {
        if (!canEdit()) { alert('You do not have permission to import.'); event.target.value = ''; return; }
        const wb = await readWorkbookFromEvent(event); if (!wb) return;
        const rows = sheetRows(wb, wb.SheetNames.find(n => n.toLowerCase().includes('provider')) || wb.SheetNames[0]) || [];
        const res = await processProviderPayRows(rows);
        alert(`Imported ${res.imported} provider pay entr${res.imported === 1 ? 'y' : 'ies'}.${res.skipped ? ` ${res.skipped} skipped:\n` + res.errors.slice(0, 10).join('\n') : ''}`);
        event.target.value = '';
        renderProviderPay();
    }

    // Reads a combined "Export All Data" file and routes each recognized
    // sheet through its own processor. Deliberately does NOT touch
    // Employees — that has its own dedicated CSV import with PII-aware
    // handling (SSN/ITIN blank-means-unchanged) that a generic combined
    // pass shouldn't risk overwriting carelessly.
    async function importAllData(event) {
        if (!canEdit()) { alert('You do not have permission to import.'); event.target.value = ''; return; }
        const statusEl = document.getElementById('import-all-status');
        statusEl.textContent = 'Reading file…';
        let wb;
        try { wb = await readWorkbookFromEvent(event); } catch (e) { statusEl.textContent = 'Error reading file: ' + e.message; return; }
        if (!wb) { statusEl.textContent = ''; return; }

        const plan = [
            { label: 'Claims', match: 'claim', proc: processClaimRows },
            { label: 'Charges', match: 'charge', proc: processChargeRows },
            { label: 'Additional Income', match: 'income', proc: processIncomeRows },
            { label: 'Vehicles', match: 'vehicle', proc: processVehicleRows },
            { label: 'Provider Pay', match: 'provider', proc: processProviderPayRows }
        ];
        const summary = [];
        for (const step of plan) {
            const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes(step.match));
            if (!sheetName) continue;
            statusEl.textContent = `Importing ${step.label}…`;
            const rows = sheetRows(wb, sheetName) || [];
            const res = await step.proc(rows);
            summary.push(`${step.label}: ${res.imported} imported${res.skipped ? `, ${res.skipped} skipped` : ''}`);
        }
        statusEl.innerHTML = summary.length
            ? '<strong>Done.</strong><br>' + summary.join('<br>')
            : 'No recognizable sheets found (expected names like Claims, Charges, Additional Income, Vehicles, Provider Pay).';
        event.target.value = '';
        await fetchAllDataFromCloud();
    }

    let dailyPayImportWorkbook = null; // holds the parsed workbook while the sheet-picker overlay is open, for a multi-week file with no sheet literally named "Daily Pay"

    async function importDailyPayExcel(event) {
        const file = event.target.files[0];
        if (!file) return;
        if (!canEdit()) { alert('You do not have permission to import.'); event.target.value = ''; return; }
        const co = requireWriteCompany();
        if (!co) { event.target.value = ''; return; }
        const reader = new FileReader();
        reader.onload = function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const exactMatch = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'daily pay');
                if (exactMatch) { runDailyPayImportForSheet(workbook, exactMatch); event.target.value = ''; return; }
                // A running workbook with one tab per week (like a full
                // year of nomina history) has no sheet literally named
                // "Daily Pay" — ask which week instead of guessing, since
                // silently picking the wrong one out of 50+ tabs would be
                // a real mess to untangle after the fact. Defaults to the
                // last tab, which is normally the most recently added week.
                dailyPayImportWorkbook = workbook;
                const sel = document.getElementById('dailypay-sheet-select');
                sel.innerHTML = workbook.SheetNames.map(n => `<option value="${escHtml(n)}">${escHtml(n)}</option>`).join('');
                sel.value = workbook.SheetNames[workbook.SheetNames.length - 1];
                document.getElementById('dailypay-sheet-picker-overlay').style.display = 'flex';
            } catch (err) {
                alert('Error parsing file: ' + err.message);
            } finally {
                event.target.value = '';
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function closeDailyPaySheetPicker() {
        dailyPayImportWorkbook = null;
        document.getElementById('dailypay-sheet-picker-overlay').style.display = 'none';
    }

    function proceedDailyPayImport() {
        const sheetName = document.getElementById('dailypay-sheet-select').value;
        const workbook = dailyPayImportWorkbook;
        document.getElementById('dailypay-sheet-picker-overlay').style.display = 'none';
        dailyPayImportWorkbook = null;
        if (workbook && sheetName) runDailyPayImportForSheet(workbook, sheetName);
    }

    // A real weekly nomina sheet isn't one flat block — it's several
    // stacked sections (regular hourly employees, then owner-operators/
    // trucking companies, etc.), each starting with its own repeated
    // mini-header (a "sun/MON/.../SAT" row plus the actual date row)
    // rather than one continuous table. There's also a target column
    // shift from what this importer originally assumed: real sheets carry
    // a flat "DIA" day-rate column at C before the seven actual weekday
    // columns, which run D through J (not C through I) — Total sits at K.
    // The loop below skips each repeated mini-header instead of treating
    // it as the end of data, and only actually stops at a truly blank
    // stretch (or a disconnected footer/reconciliation table below the
    // real data, which never has anything resembling a name in column B).
    // A $0 week total is a normal, valid entry (someone just didn't work
    // that particular week) and must never be treated as a stop signal —
    // only a genuinely missing name means "nothing else here."
    async function runDailyPayImportForSheet(workbook, sheetName) {
        try {
            const ws = workbook.Sheets[sheetName];
            if (!ws['!ref']) { alert('That sheet appears to be empty.'); return; }

            const dayCols = [3, 4, 5, 6, 7, 8, 9]; // D..J = Sun..Sat (C is the flat "DIA" day-rate column, not a weekday)
            const readDate = (r, c) => {
                const cell = ws[XLSX.utils.encode_cell({ r, c })];
                if (!cell) return null;
                if (cell.t === 'n') { const epoch = new Date(Date.UTC(1899, 11, 30)); return new Date(epoch.getTime() + cell.v * 86400000); }
                const d = new Date(cell.v);
                return isNaN(d) ? null : d;
            };
            const dates = dayCols.map(c => readDate(1, c)); // row 2
            if (dates.some(d => !d)) {
                alert(`Could not find 7 day dates in row 2 (columns D–J) of "${sheetName}". Make sure this matches the Daily Pay registry format.`);
                return;
            }

            const sunday = weekStartSunday(dates[0]);
            const wk = weekKeyFromSunday(sunday);

            const entries = [];
            const unmatched = []; // {row, name, weekTotal} — same name-matching as the Claims importer (matchEmployeeByName)
            let r = 2; // row 3 = first data row
            const maxRow = (XLSX.utils.decode_range(ws['!ref']).e.r) + 1;
            while (r < maxRow) {
                const nameCell = ws[XLSX.utils.encode_cell({ r, c: 1 })]; // column B
                const name = nameCell ? String(nameCell.v || '').trim() : '';
                const dayOneCell = ws[XLSX.utils.encode_cell({ r, c: 3 })]; // column D, where a repeated mini-header says "sun"
                const dayOneStr = dayOneCell ? String(dayOneCell.v || '').trim().toLowerCase() : '';

                if (dayOneStr === 'sun') { r += 2; continue; } // a new section's repeated header (label row + date row) — not data, skip both

                if (!name) {
                    // Could be a genuinely blank spacer row inside real
                    // data, or the true end of it (followed by an
                    // unrelated footer/reconciliation table, or nothing).
                    // Peek a few rows ahead before deciding which.
                    let realDataAhead = false;
                    for (let i = 1; i <= 3 && r + i < maxRow; i++) {
                        const peekCell = ws[XLSX.utils.encode_cell({ r: r + i, c: 1 })];
                        if (peekCell && String(peekCell.v || '').trim()) { realDataAhead = true; break; }
                    }
                    if (!realDataAhead) break;
                    r++; continue;
                }

                const empId = matchEmployeeByName(name);
                if (!empId) {
                    let weekTotal = 0;
                    dayCols.forEach(c => {
                        const cell = ws[XLSX.utils.encode_cell({ r, c })];
                        const v = cell ? parseFloat(cell.v) : NaN;
                        if (!isNaN(v)) weekTotal += v;
                    });
                    unmatched.push({ row: r + 1, name, weekTotal });
                    r++; continue;
                }
                dayCols.forEach((c, i) => {
                    const cell = ws[XLSX.utils.encode_cell({ r, c })];
                    if (!cell || cell.v === undefined || cell.v === null || String(cell.v).trim() === '') return; // blank = no entry, skip
                    const raw = String(cell.v).trim();
                    if (raw.toUpperCase() === 'OFF') entries.push({ employee_id: empId, year: wk.year, week: wk.week, day_index: i, amount: 0, is_off: true });
                    else { const num = parseFloat(raw); if (!isNaN(num)) entries.push({ employee_id: empId, year: wk.year, week: wk.week, day_index: i, amount: num, is_off: false }); }
                });
                r++;
            }

            if (!entries.length && !unmatched.length) { alert('No importable daily pay rows found in this sheet.'); return; }

            let msg = '';
            if (entries.length) {
                const { data: result, error } = await supabaseClient.rpc('import_daily_pay_batch', { p_actor: currentUsername, p_entries: entries });
                if (error) { alert('Error importing: ' + error.message); return; }
                const res = (result && result[0]) || { imported: 0, skipped: 0 };
                msg = `Imported ${res.imported} daily pay entries for Week ${wk.week}, ${wk.year} (from "${sheetName}").`;
            } else {
                msg = `No rows could be matched to an employee for Week ${wk.week}, ${wk.year} — nothing was imported.`;
            }

            if (unmatched.length) {
                msg += `\n\n${unmatched.length} name(s) could not be matched to an employee and were skipped. A correction report has been downloaded — fix the names in that file (or add the employee), then re-upload.`;
                downloadDailyPayCorrectionReport(unmatched, wk, sheetName);
            }
            alert(msg);
            dailyView = { sunday };
            await fetchAllDataFromCloud();
        } catch (err) {
            alert('Error parsing sheet: ' + err.message);
        }
    }

    // Downloadable .xlsx listing every Daily Pay row that couldn't be
    // matched to an employee — row number and week total from the source
    // file for context, plus a blank column to note the fix, so the whole
    // thing can be corrected and re-uploaded in one pass instead of hunting
    // through the original file by hand.
    function downloadDailyPayCorrectionReport(unmatched, wk, sourceSheetName) {
        const rows = unmatched.map(u => ({
            'Row in source file': u.row,
            'Name as entered': u.name,
            'Week total ($)': +u.weekTotal.toFixed(2),
            'Correct Employee ID or Name': '',
            'Notes': ''
        }));
        const ws = XLSX.utils.json_to_sheet(rows);
        ws['!cols'] = [{ wch: 16 }, { wch: 34 }, { wch: 14 }, { wch: 28 }, { wch: 30 }];
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Corrections needed');
        XLSX.writeFile(wb, `Daily_Pay_Corrections_Week${wk.week}_${wk.year}.xlsx`);
    }

    async function importClaimsExcel(event) {
        const file = event.target.files && event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (!canEdit()) { alert('You do not have permission to import.'); return; }
        const co = requireWriteCompany();
        if (!co) return;

        try {
            const isCsv = /\.csv$/i.test(file.name);
            const workbook = isCsv
                ? XLSX.read(await file.text(), { type: 'string' })
                : XLSX.read(await file.arrayBuffer(), { type: 'array' });

            let sheetName = workbook.SheetNames.find(n => n.trim().toLowerCase() === 'tracker');
            if (!sheetName) sheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[sheetName];

            const headerRow = findClaimsHeaderRow(sheet);
            const rows = XLSX.utils.sheet_to_json(sheet, { range: headerRow, defval: '' });
            if (!rows.length) { alert(`No data rows found in the "${sheetName}" tab.`); return; }

            const col = (row, names) => {
                const keys = Object.keys(row);
                for (const n of names) {
                    const nl = n.toLowerCase();
                    let k = keys.find(k => k.trim().toLowerCase() === nl);
                    if (!k) k = keys.find(k => k.trim().toLowerCase().startsWith(nl));
                    if (k && row[k] !== '') return row[k];
                }
                return '';
            };

            let nextNum = claims.length + 1;
            const newClaims = [];
            const newDamageTypes = [];
            let matched = 0, unmatched = 0;
            const statusNotes = {};

            rows.forEach(row => {
                const internalRef = String(col(row, ['Internal RefClaim', 'Internal Ref']) || '').trim();
                const employeeName = String(col(row, ['Employee', 'Employee Name']) || '').trim();
                if (!employeeName && !internalRef) return; // skip fully blank rows

                const empId = matchEmployeeByName(employeeName);
                if (empId) matched++; else unmatched++;

                const statusInfo = mapClaimStatus(col(row, ['Status']));
                if (statusInfo.note) statusNotes[statusInfo.note] = (statusNotes[statusInfo.note] || 0) + 1;

                const damageType = String(col(row, ['Claim Description', 'Damage Type', 'Description']) || '').trim();
                if (damageType && !damageTypes.includes(damageType) && !newDamageTypes.includes(damageType)) {
                    newDamageTypes.push(damageType);
                }

                const comments = String(col(row, ['Comments', 'Notes']) || '').trim();
                const noteParts = [];
                if (comments) noteParts.push(comments);
                if (statusInfo.note) noteParts.push(statusInfo.note);
                if (internalRef) noteParts.push(`Ref: ${internalRef}`);

                const claimId = `${idPrefix()}${String(nextNum).padStart(settings.claimDigits, '0')}`;
                nextNum++;

                newClaims.push({
                    claim_id: claimId,
                    company_code: co,
                    employee_id: empId || null,
                    company_name: String(col(row, ['Company Name', 'Company']) || '').trim() || null,
                    carrier_claim_number: String(col(row, ['RXO Claim #', 'Carrier Claim #']) || '').trim() || null,
                    customer_claim_number: String(col(row, ["Costco/Lowe's Claim #", 'Customer Claim #']) || '').trim() || null,
                    damage_type: damageType || null,
                    claim_amount: parseFloat(col(row, ['Claim amount'])) || 0,
                    weekly_deduction: parseFloat(col(row, ['Weekly amount', 'Weekly Deduction'])) || 0,
                    start_date: excelSerialToDateStr(col(row, ['Deduction Start Date', 'Start Date'])),
                    end_date: excelSerialToDateStr(col(row, ['Deduction End Date', 'End Date'])),
                    status: statusInfo.status,
                    absorbed_amount: parseFloat(col(row, ['Absorved amount', 'Absorbed amount'])) || 0,
                    notes: noteParts.join(' | ') || null
                });
            });

            if (!newClaims.length) { alert(`Found ${rows.length} row(s) in "${sheetName}" but none had data in the Employee or Internal RefClaim columns — double-check the sheet has those column headers.`); return; }

            if (newDamageTypes.length) {
                await Promise.all(newDamageTypes.map(name => supabaseClient.rpc('add_type_value', { p_actor: currentUsername, p_kind: 'damage', p_value: name })));
                damageTypes.push(...newDamageTypes);
            }

            // Batch inserts to stay well under any single-request size limit.
            let inserted = 0, failed = 0;
            for (let i = 0; i < newClaims.length; i += 50) {
                const batch = newClaims.slice(i, i + 50);
                const { error } = await supabaseClient.rpc('create_claims_batch', { p_actor: currentUsername, p_rows: batch });
                if (error) { failed += batch.length; console.error('claims import batch failed:', error.message); }
                else inserted += batch.length;
            }

            populateDropdowns();
            populateClaimFilters();
            refreshIdPreviews();
            fetchClaimsFromCloud();

            const notesSummary = Object.entries(statusNotes).map(([n, c]) => `  • ${n}: ${c}`).join('\n');
            alert(
                `Import finished from the "${sheetName}" tab.\n\n` +
                `${inserted} claim(s) imported${failed ? `, ${failed} failed (see browser console)` : ''}.\n` +
                `${matched} matched to an employee automatically; ${unmatched} left blank — open those in Claims → Edit to assign the right person.\n` +
                (newDamageTypes.length ? `${newDamageTypes.length} new damage type(s) added to the list.\n` : '') +
                (notesSummary ? `\nRows flagged for review:\n${notesSummary}` : '')
            );
        } catch (err) {
            alert('Error importing file: ' + err.message);
        }
    }

    // --- CHARGES ---
    document.getElementById('charge-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!canEdit()) return;
        const chargeEmpId = document.getElementById('ci-employee').value;
        if (!chargeEmpId) { alert('Select an employee at the top of the tab first.'); return; }
        const fields = {
            employee_id: chargeEmpId,
            charge_type: document.getElementById('gChargeType').value,
            amount: parseFloat(document.getElementById('gAmount').value) || 0,
            weekly_deduction: parseFloat(document.getElementById('gWeekly').value) || 0,
            start_date: document.getElementById('gStartDate').value || null,
            end_date: document.getElementById('gEndDate').value || null,
            status: document.getElementById('gStatus').value,
            notes: document.getElementById('gNotes').value.trim()
        };

        if (editingChargeId) {
            const { data, error } = await supabaseClient.rpc('edit_charge', { p_actor: currentUsername, p_id: editingChargeId, p_fields: fields });
            if (error) { alert('Error: ' + error.message); return; }
            if (data) alert(data);
            cancelChargeEdit();
            fetchChargesFromCloud();
        } else {
            const chargeCo = requireWriteCompany();
            if (!chargeCo) return;
            const chargeId = `${idPrefix()}${String(charges.length + 1).padStart(settings.chargeDigits, '0')}${settings.chargeSuffix}`;
            const payload = Object.assign({ charge_id: chargeId, company_code: chargeCo }, fields);
            const { error } = await supabaseClient.rpc('create_charge', { p_actor: currentUsername, p_fields: payload });
            if (error) { alert('Error saving charge: ' + error.message); return; }
            document.getElementById('charge-form').reset();
            fetchChargesFromCloud();
            document.getElementById('next-charge-id-display').textContent = `${idPrefix()}${String(charges.length + 1).padStart(settings.chargeDigits, '0')}${settings.chargeSuffix}`;
        }
    });

    function chargeDetailHtml(ch, empName, weeks, bal, endDate, editable) {
        const owed = Math.max(0, parseFloat(ch.amount) || 0);
        const pct = owed > 0 ? Math.round(((owed - bal) / owed) * 100) : 0;
        return `
            ${progressBarHtml(pct)}
            <div class="rec-detail-grid">
                <div><div class="k" data-i18n="d_employee">Employee</div><div class="v">${escHtml(empName)}</div></div>
                <div><div class="k" data-i18n="d_employee_id">Employee ID</div><div class="v id-cell">${ch.employee_id}</div></div>
                <div><div class="k" data-i18n="d_charge_type">Charge type</div><div class="v">${escHtml(ch.charge_type)}</div></div>
                <div><div class="k" data-i18n="d_amount">Amount</div><div class="v">${formatMoney(ch.amount)}</div></div>
                <div><div class="k" data-i18n="d_weekly_deduction">Weekly deduction</div><div class="v">${formatMoney(ch.weekly_deduction)}</div></div>
                <div><div class="k" data-i18n="d_weeks">Weeks</div><div class="v">${weeks}</div></div>
                <div><div class="k" data-i18n="d_start_ded">Start ded.</div><div class="v">${ch.start_date || '-'}</div></div>
                <div><div class="k" data-i18n="d_end_ded">End ded.</div><div class="v">${endDate}</div></div>
            </div>
            ${ch.notes ? `<div class="detail-subhead" style="margin-top:8px;" data-i18n="d_notes">Notes</div><div class="note-box" style="margin:0;">${escHtml(ch.notes)}</div>` : ''}
            <div class="rec-actions">
                ${attachBtnHtml('charge', ch.charge_id)}
                ${editable ? `<button class="btn-small" style="margin:0;" onclick="editCharge('${ch.charge_id}')" data-i18n="d_edit_full">✎ Edit</button>
                <button class="del-btn" onclick="deleteCharge('${ch.charge_id}')" data-i18n="d_delete">✕ Delete</button>` : ''}
            </div>`;
    }

    // Back-compat alias — charges are now shown in the combined Claims &
    // Charges list. Every existing renderCharges() caller drives it.
    function renderCharges() { return renderClaimsCharges(); }

    async function deleteCharge(id) {
        if (!canEdit()) return;
        if(confirm("Delete charge " + id + "?")) {
            const { error } = await supabaseClient.rpc('delete_charge', { p_actor: currentUsername, p_id: id });
            if (error) alert('Error: ' + error.message);
            fetchChargesFromCloud();
        }
    }

    // ===== WEEK IN DEPOSIT ("semana de fondo") ============================
    // Not a new data type — this is a dedicated, savings-goal-framed view
    // over the same charges table, filtered to charge_type "Week in
    // Deposit". Reuses chargeBalance()/buildChargeSchedule() untouched, so
    // it inherits the same already-tested calculation logic and the same
    // server-side role scoping the rest of Charges already has.
    const WEEK_DEPOSIT_TYPE = 'Semana de Fondo';
    let editingWeekDepositId = null;

    function populateWeekDepositEmployeeDropdown() {
        const sel = document.getElementById('wd-employee');
        if (!sel) return;
        const isViewOnly = currentUserRole === 'User';
        const myEmpId = currentUser && currentUser.employee_id;
        const scoped = isViewOnly ? employees.filter(e => e.id === myEmpId) : employees;
        const sorted = scoped.slice().sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, undefined, { sensitivity: 'base' }));
        sel.innerHTML = '<option value="">— Select employee —</option>' + sorted.map(e => `<option value="${e.id}">${employeeOptionLabel(e)}</option>`).join('');
    }

    document.getElementById('weekdeposit-form').addEventListener('submit', async function (e) {
        e.preventDefault();
        if (!canEdit() || !editingWeekDepositId) return; // this form is edit-only — new deposits are created via the normal Charges tab, using the existing "Semana de Fondo" charge type
        const fields = {
            employee_id: document.getElementById('wd-employee').value,
            charge_type: WEEK_DEPOSIT_TYPE,
            amount: parseFloat(document.getElementById('wd-goal').value) || 0,
            weekly_deduction: parseFloat(document.getElementById('wd-weekly').value) || 0,
            start_date: document.getElementById('wd-start').value || null,
            end_date: null, status: 'Deducting',
            notes: document.getElementById('wd-notes').value.trim()
        };
        const { data, error } = await supabaseClient.rpc('edit_charge', { p_actor: currentUsername, p_id: editingWeekDepositId, p_fields: fields });
        if (error) { alert('Error: ' + error.message); return; }
        if (data) alert(data);
        cancelWeekDepositEdit();
        await fetchChargesFromCloud();
        renderWeekDeposit();
    });

    function editWeekDeposit(id) {
        if (!canEdit()) return;
        const ch = charges.find(c => c.charge_id === id);
        if (!ch) return;
        editingWeekDepositId = id;
        document.getElementById('wd-employee').value = ch.employee_id;
        document.getElementById('wd-goal').value = ch.amount;
        document.getElementById('wd-weekly').value = ch.weekly_deduction;
        document.getElementById('wd-start').value = ch.start_date || '';
        document.getElementById('wd-notes').value = ch.notes || '';
        document.getElementById('weekdeposit-form-panel').style.display = '';
        document.getElementById('weekdeposit-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function cancelWeekDepositEdit() {
        editingWeekDepositId = null;
        document.getElementById('weekdeposit-form').reset();
        document.getElementById('weekdeposit-form-panel').style.display = 'none';
    }
    async function deleteWeekDeposit(id) {
        await deleteCharge(id); // handles its own confirm + canEdit() check + re-fetch
        renderWeekDeposit();
    }

    function renderWeekDeposit() {
        populateWeekDepositEmployeeDropdown();
        // The edit panel only ever shows via editWeekDeposit() — no default-open create form anymore, since new "Semana de Fondo" deposits are created through the normal Charges tab, not duplicated here.

        const statusFilter = document.getElementById('weekdeposit-status-filter')?.value || '';
        const query = (document.getElementById('weekdeposit-search')?.value || '').toLowerCase();
        const empName = id => { const e = employees.find(x => x.id === id); return e ? `${e.first_name} ${e.last_name}` : id; };

        let list = charges.filter(c => c.charge_type === WEEK_DEPOSIT_TYPE);
        if (statusFilter) list = list.filter(c => c.status === statusFilter);
        if (query) list = list.filter(c => `${c.charge_id} ${empName(c.employee_id)}`.toLowerCase().includes(query));
        const editable = canEdit(); // still needed below for each row's Edit/Delete buttons, even though it's no longer used for the create-panel (that's edit-only now, shown via editWeekDeposit())

        const grid = document.getElementById('weekdeposit-stats-grid');
        // Computed independently of collapse state below — a collapsed
        // group must never silently disappear from these totals just
        // because its cards aren't currently being drawn.
        let totalSaved = 0, totalRemaining = 0;
        list.forEach(c => {
            const goal = Math.max(0, parseFloat(c.amount) || 0);
            const remaining = chargeBalance(c);
            totalSaved += Math.max(0, +(goal - remaining).toFixed(2));
            totalRemaining += remaining;
        });
        const cardHtml = c => {
            const goal = Math.max(0, parseFloat(c.amount) || 0);
            const remaining = chargeBalance(c);
            const saved = Math.max(0, +(goal - remaining).toFixed(2));
            const pct = goal > 0 ? Math.min(100, Math.round((saved / goal) * 100)) : 0;
            const sched = buildChargeSchedule(c, null);
            const scheduleRows = sched.rows.map(r => `<tr><td>${r.date}</td><td>${r.paused ? '<em style="color:var(--text-muted);">paused</em>' : formatMoney(r.deducted)}</td><td>${formatMoney(goal - r.balance)}</td><td>${formatMoney(r.balance)}</td></tr>`).join('');
            return `
                <div class="panel collapsed" style="margin-bottom:8px;">
                    <div class="panel-head" onclick="toggleCollapse(this)">
                        <span style="font-size:13px;"><span class="type-pill">${c.charge_id}</span> <b>${escHtml(empName(c.employee_id))}</b> · <span class="status-badge status-${c.status}">${c.status}</span></span>
                        <span class="caret">&#9662;</span>
                    </div>
                    <div>
                        <div style="background:var(--surface-2); border-radius:6px; height:8px; margin:8px 0 4px; overflow:hidden;"><div style="background:var(--primary); height:100%; width:${pct}%;"></div></div>
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">${pct}% ${t('d_of_goal')}</div>
                        <div class="form-row" style="margin:0 0 8px;align-items:center;">
                            <div class="field"><label>${t('d_goal')}</label><div class="money">${formatMoney(goal)}</div></div>
                            <div class="field"><label>${t('d_weekly_saving')}</label><div>${formatMoney(c.weekly_deduction)}</div></div>
                            <div class="field"><label>${t('d_saved_so_far')}</label><div class="money" style="color:#059669;">${formatMoney(saved)}</div></div>
                            <div class="field"><label>${t('d_remaining_to_goal')}</label><div class="money">${formatMoney(remaining)}</div></div>
                            <div class="field"><label>${t('d_start')}</label><div>${c.start_date || '-'}</div></div>
                        </div>
                        ${editable ? `<div class="rec-actions" style="margin-bottom:8px;">
                            <button class="btn-small" style="margin:0;" onclick="event.stopPropagation(); editWeekDeposit('${c.charge_id}')">${t('d_edit_full')}</button>
                            <button class="del-btn" onclick="event.stopPropagation(); deleteWeekDeposit('${c.charge_id}')">${t('d_delete')}</button>
                            ${c.status !== 'Released' ? `<button class="btn-small" style="margin:0;background:#7c3aed;" onclick="event.stopPropagation(); openReleaseStatement('${c.charge_id}')">${t('d_release')}</button>
                            <button class="btn-small" style="margin:0;background:#b45309;" onclick="event.stopPropagation(); openReleaseStatement('${c.charge_id}', true)">${t('d_early_release')}</button>` : ''}
                        </div>` : ''}
                        ${sched.rows.length ? `<div class="table-wrapper" style="max-height:260px;"><table style="font-size:12px;"><thead><tr><th style="text-align:left;">${t('d_th_date')}</th><th style="text-align:left;">${t('d_th_saved_week')}</th><th style="text-align:left;">${t('d_total_saved')}</th><th style="text-align:left;">${t('d_remaining')}</th></tr></thead><tbody>${scheduleRows}</tbody></table></div>` : ''}
                    </div>
                </div>`;
        };
        // Grouped by status (Deducting/Queued/Paid/Absorbed/Tk from check
        // order, matching Statement's own grouping) so it's easy to see
        // what's actively being deducted vs. already paid off at a glance.
        const STATUS_ORDER = ['Deducting', 'Queued', 'Paid', 'Released', 'Absorbed', 'Tk from check'];
        const statusesPresent = [...new Set(list.map(c => c.status))].sort((a, b) => {
            const ia = STATUS_ORDER.indexOf(a), ib = STATUS_ORDER.indexOf(b);
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
        });
        let rows = '';
        statusesPresent.forEach(status => {
            const group = list.filter(c => c.status === status);
            const collapsed = collapsedStatusGroups.weekdeposit.has(status);
            rows += `<div class="detail-subhead" style="margin:12px 0 6px; cursor:pointer;" onclick="toggleStatusGroup('weekdeposit','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400; text-transform:none; letter-spacing:normal;">(${group.length})</span></div>`;
            if (collapsed) return;
            group.forEach(c => { rows += cardHtml(c); });
        });

        if (grid) grid.innerHTML = `
            <div class="stat-card"><div class="stat-label">${t('d_active_deposits')}</div><div class="stat-value">${list.length}</div></div>
            <div class="stat-card"><div class="stat-label">${t('d_total_saved')}</div><div class="stat-value" style="color:#059669;">${formatMoney(totalSaved)}</div></div>
            <div class="stat-card"><div class="stat-label">${t('d_total_remaining')}</div><div class="stat-value">${formatMoney(totalRemaining)}</div></div>`;

        const body = document.getElementById('weekdeposit-tbody');
        if (body) body.innerHTML = rows || `<div style="text-align:center; color:var(--text-muted); padding:20px;">${t('d_no_deposits')}</div>`;
    }

    // ===== Release eligibility (90-day Week in Deposit / 30-day last week worked) =====
    let lastDailyPayWorked = {}; // employee_id -> 'YYYY-MM-DD', derived from Daily Pay's most recent non-OFF entry

    async function fetchLastDailyPayWorked() {
        try {
            const { data, error } = await supabaseClient.rpc('get_last_daily_pay_worked', { p_actor: currentUsername, p_company: currentCompany });
            if (error) { console.error('get_last_daily_pay_worked:', error); return; }
            const map = {};
            (data || []).forEach(r => {
                const sun = sundayFromWeekKey(r.year, r.week);
                const d = new Date(sun); d.setUTCDate(d.getUTCDate() + (parseInt(r.day_index, 10) || 0));
                map[r.employee_id] = d.toISOString().split('T')[0];
            });
            lastDailyPayWorked = map;
        } catch (e) { console.error('fetchLastDailyPayWorked:', e); }
    }

    function pullLastDateWorkedFromDailyPay() {
        if (!editingEmpId) { alert('Save this employee first, then edit them to pull from Daily Pay.'); return; }
        const found = lastDailyPayWorked[editingEmpId];
        if (!found) { alert('No Daily Pay entries found for this employee.'); return; }
        document.getElementById('emp-lastworked').value = found;
    }

    function addDaysStr(dateStr, days) {
        const d = new Date(dateStr + 'T00:00:00Z');
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().split('T')[0];
    }
    // Checks are issued Thursdays and handed over Saturdays — given an
    // earliest-ELIGIBLE date (the 90/30-day rule's result), the earliest a
    // check can actually be ISSUED is the next Thursday on or after that
    // date, and HANDED OVER is the Saturday right after (2 days later,
    // same week's check run).
    function nextThursdayOnOrAfter(dateStr) {
        const d = new Date(dateStr + 'T00:00:00Z');
        const THU = 4; // Sun=0..Sat=6
        const add = (THU - d.getUTCDay() + 7) % 7;
        d.setUTCDate(d.getUTCDate() + add);
        return d.toISOString().split('T')[0];
    }

    // The employee's own "Last Date Worked" field (manually set or pulled
    // from Daily Pay) drives both rules — Week in Deposit needs 90 days
    // from it, the last week worked's pay needs 30. Falls back to the
    // live Daily Pay-derived date if the employee field itself was never
    // filled in, so the report still shows something useful for anyone
    // Daily Pay already has history for.
    function effectiveLastDateWorked(empId) {
        const d = getEmpDetail(empId);
        return (d && d.last_date_worked) || lastDailyPayWorked[empId] || null;
    }
    // Once an employee is Inactive, there's no more paycheck to ever
    // deduct from — so any claim/charge schedule for them shouldn't keep
    // projecting further weekly deductions past their last real paycheck,
    // even though the schedule math itself would happily keep going
    // forever otherwise. Returns the date after which a schedule should
    // stop walking forward for this employee, or null if they're Active
    // (no cutoff — deductions proceed normally) or if there's genuinely
    // no data to determine one from (safe no-op, doesn't restrict
    // anything rather than guessing wrong). Falls back through
    // last_date_worked → Daily Pay-derived date → inactive_since, in that
    // order, matching the same chain weekDepositEligibleDate/
    // lastWeekPayEligibleDate already use, so "when did income stop" is
    // answered consistently everywhere in the app rather than by three
    // slightly different definitions.
    function incomeStoppedDate(empId) {
        const emp = employees.find(e => e.id === empId);
        if (!emp || emp.status !== 'Inactive') return null;
        return effectiveLastDateWorked(empId) || getEmpDetail(empId).inactive_since || null;
    }
    function weekDepositEligibleDate(empId) {
        const lw = effectiveLastDateWorked(empId);
        return lw ? addDaysStr(lw, 90) : null;
    }
    function lastWeekPayEligibleDate(empId) {
        const lw = effectiveLastDateWorked(empId);
        return lw ? addDaysStr(lw, 30) : null;
    }

    // No-show detection: flags a Daily Pay employee whose most recent
    // actual worked day falls before Thursday of the last FULLY completed
    // week — i.e. Thu/Fri/Sat of that week all show no work, which is the
    // "3 days in a row" the flag is watching for. Anchored to a completed
    // week (not just "3 calendar days ago") so someone doesn't get
    // flagged mid-week before Thursday/Friday/Saturday even happen yet —
    // only scoped to Daily Pay employees, since Weekly/Provider pay types
    // don't log daily attendance the same way and this check wouldn't
    // mean anything for them. A flag clears itself the moment the
    // employee is no longer Active (already Inactive, or shows up in
    // Daily Pay again and their last-worked date moves forward).
    function priorWeekThursdayStr() {
        const currentWeekSunday = weekStartSunday(new Date());
        const priorSat = new Date(currentWeekSunday); priorSat.setUTCDate(priorSat.getUTCDate() - 1);
        const priorThu = new Date(priorSat); priorThu.setUTCDate(priorThu.getUTCDate() - 2);
        return priorThu.toISOString().split('T')[0];
    }
    function flaggedForInactivityReview(empId) {
        const emp = employees.find(e => e.id === empId);
        if (!emp || emp.status !== 'Active') return false;
        if (getPayType(empId) !== 'Daily') return false;
        const lastWorked = lastDailyPayWorked[empId];
        if (!lastWorked) return false; // no Daily Pay history at all yet — nothing to compare, don't flag a brand-new hire
        return lastWorked < priorWeekThursdayStr();
    }
    function getInactivityFlaggedEmployees() {
        return employees.filter(e => flaggedForInactivityReview(e.id));
    }
    let dismissedInactivityFlags = new Set(); // session-only — reappears next login, doesn't require a DB write to "snooze"
    function dismissInactivityFlag(empId) {
        dismissedInactivityFlags.add(empId);
        renderInactivityFlagsBanner();
    }
    async function confirmMarkInactiveFromFlag(empId) {
        const emp = employees.find(e => e.id === empId);
        if (!emp) return;
        const name = `${emp.first_name} ${emp.last_name}`;
        if (!confirm(`Mark ${name} as Inactive? This locks in today as their departure date (if not already set) and holds their Week in Deposit savings (90 days) and last paycheck (30 days) per the release rules.`)) return;
        await setEmployeeStatus(empId, 'Inactive');
        dismissedInactivityFlags.delete(empId);
        renderInactivityFlagsBanner();
    }
    function renderInactivityFlagsBanner() {
        const el = document.getElementById('inactivity-flags-banner');
        if (!el) return;
        if (!canEdit()) { el.innerHTML = ''; el.style.display = 'none'; return; } // View Only never sees this — it's an admin action prompt, and their own employees list is scoped to just themselves anyway
        const flagged = getInactivityFlaggedEmployees().filter(e => !dismissedInactivityFlags.has(e.id));
        if (!flagged.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
        el.style.display = 'block';
        el.innerHTML = `
            <div class="note-box" style="border-left:3px solid #dc2626;">
                <strong>⚠ ${flagged.length} employee(s) haven't shown up in Daily Pay for 3+ days in a row (through last week)</strong>
                <div style="margin-top:8px;">
                    ${flagged.map(e => `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 0; border-bottom:1px solid var(--border); font-size:12px;">
                        <span>${escHtml(e.first_name + ' ' + e.last_name)} — last worked ${lastDailyPayWorked[e.id] || 'unknown'}</span>
                        <span style="display:flex; gap:6px;">
                            <button type="button" class="btn-small" style="margin:0; background:#dc2626;" onclick="confirmMarkInactiveFromFlag('${escJsAttr(e.id)}')">Mark Inactive</button>
                            <button type="button" class="btn-small" style="margin:0; background:#64748b;" onclick="dismissInactivityFlag('${escJsAttr(e.id)}')">Dismiss</button>
                        </span>
                    </div>`).join('')}
                </div>
            </div>`;
    }

    // Releasing a Semana de Fondo account hands the employee a check for
    // what they've saved — but if they still owe on any OTHER open claim
    // or charge (a damage claim, a loan, anything except another Semana de
    // Fondo record), that gets settled out of the savings first, same as
    // it would be if the company were writing the check by hand. Computed
    // entirely from balances the app already trusts (claimBalance/
    // chargeBalance), oldest debt first, until either the debts or the
    // savings run out — whichever comes first decides what's left to
    // actually hand over.
    let releaseStatementChargeId = null;

    // Shared by the release statement AND the Savings & Release
    // Eligibility report — one place computing "what does this employee
    // still owe" so the two views can never quietly disagree with each
    // other.
    function pendingItemsForEmployee(empId) {
        const items = [];
        // Exception rule: once a claim or charge is actually AT status
        // 'Absorbed', that's final — a declared loss, not something a
        // later release stage ever gets another chance at. That's a
        // deliberate change from this app's earlier behavior (which used
        // to let an Absorbed item resurface here using its leftover
        // absorbed_amount, specifically so a later release COULD still
        // collect it) — now, an item that can't be fully covered stays in
        // its normal ongoing status (still counts as pending via its real
        // balance below) right up until the truly last possible release
        // stage finalizes it to Absorbed; after that point it's excluded
        // here, permanently. Tk-from-check is a different status and
        // keeps working the same as before — this exception is specific
        // to the literal 'Absorbed' status only.
        claims.filter(c => c.employee_id === empId).forEach(c => {
            if (c.status === 'Absorbed') return;
            const bal = claimBalance(c);
            const absorbedAmt = parseFloat(c.absorbed_amount) || 0;
            const pending = bal > 0.004 ? bal : (absorbedAmt > 0.004 ? absorbedAmt : 0);
            if (pending > 0.004) items.push({ type: 'claim', id: c.claim_id, label: c.damage_type || 'Claim', amount: +pending.toFixed(2), start_date: c.start_date });
        });
        charges.filter(c => c.employee_id === empId && c.charge_type !== WEEK_DEPOSIT_TYPE).forEach(c => {
            if (c.status === 'Absorbed') return;
            const bal = chargeBalance(c);
            if (bal > 0.004) items.push({ type: 'charge', id: c.charge_id, label: c.charge_type || 'Charge', amount: +bal.toFixed(2), start_date: c.start_date });
        });
        return items;
    }

    function computeReleaseStatement(chargeId) {
        const wd = charges.find(c => c.charge_id === chargeId && c.charge_type === WEEK_DEPOSIT_TYPE);
        if (!wd) return null;
        const goal = Math.max(0, parseFloat(wd.amount) || 0);
        const remaining = chargeBalance(wd);
        const saved = Math.max(0, +(goal - remaining).toFixed(2));

        // A claim or charge counts as pending here regardless of its
        // current status — a real open balance, OR (claims only) a
        // leftover absorbed_amount even on an already-Absorbed or
        // Tk-from-check record, since that field is how this business
        // flags "still owed, just not through normal weekly payroll".
        // Charges have no such field, so they only ever qualify through
        // an actual open balance.
        const items = pendingItemsForEmployee(wd.employee_id);
        const stmt = { charge: wd, employeeId: wd.employee_id, goal, saved, items };
        applyGreedyDefaultSelection(stmt);
        items.sort((a, b) => String(a.start_date || '').localeCompare(String(b.start_date || '')));
        return stmt;
    }

    // Shared by both release flows (Week in Deposit and Last Paycheck) so
    // neither ever starts the checklist blank with the person left to
    // work out by hand which combination fits — greedy smallest-amount-
    // first, maximizing how many items land fully closed within what's
    // available. Only a starting point: the person can freely check/
    // uncheck anything afterward. Mutates stmt.items in place, so it's
    // safe to call again later once stmt.saved changes (Last Paycheck's
    // amount is only known after an async Daily Pay/Income lookup
    // finishes, well after the overlay first opens with saved still 0).
    function applyGreedyDefaultSelection(stmt) {
        const bySize = stmt.items.slice().sort((a, b) => (a.amount - b.amount) || String(a.start_date || '').localeCompare(String(b.start_date || '')));
        let pool = stmt.saved;
        const selectedKeys = new Set();
        bySize.forEach(it => {
            if (it.amount <= pool + 0.004) { selectedKeys.add(it.type + ':' + it.id); pool = +(pool - it.amount).toFixed(2); }
        });
        stmt.items.forEach(it => { it.selected = selectedKeys.has(it.type + ':' + it.id); });
    }

    // Recomputed on load and after every checkbox toggle — never touches
    // the DB, purely local math for the live totals shown in the overlay.
    function releaseTotals(stmt) {
        const totalPending = stmt.items.reduce((a, i) => a + i.amount, 0);
        const selectedTotal = stmt.items.filter(i => i.selected).reduce((a, i) => a + i.amount, 0);
        const insufficient = totalPending > stmt.saved + 0.004;
        const overCommitted = selectedTotal > stmt.saved + 0.004;

        // Nothing ever reaches the employee while anything remains
        // pending, full stop — whether the leftover ends up as a
        // prepayment toward one item (see below) or just stays absorbed
        // into the overall shortfall makes no difference to this: net
        // release is only ever the genuine surplus once EVERY pending
        // item is accounted for. Previously this only subtracted the
        // specific prepay amount, which correctly zeroed it out when a
        // prepayment applied but silently let the same leftover leak
        // through as "net release" whenever prepay didn't apply (an
        // Inactive employee's release, or Last Paycheck, which never
        // allows prepay) — money must never reach a departed employee
        // while they still owe on an open claim or charge.
        let netRelease = insufficient ? 0 : +Math.max(0, stmt.saved - selectedTotal).toFixed(2);

        // Whatever's left over after fully settling the checked items is
        // always credited against the smallest still-uncovered item —
        // even a partial amount reduces what's owed, it's never just
        // discarded because it can't cover the whole thing (Francis
        // Fernandez's case: a $750 last check against a $2,769.78 claim
        // still credits that $750 before the remaining $2,019.78 gets
        // either carried forward or declared a loss — it doesn't just
        // write off the full amount and leave the $750 unaccounted for).
        //
        // What differs is whether that remainder becomes a FINAL loss
        // right now, or stays open for the NEXT release stage to try:
        // Last Paycheck is never the last possible chance — an Inactive
        // employee's Week in Deposit release, if they have one, is still
        // coming — so anything Last Paycheck can't cover simply stays in
        // its current status (still counted as pending, ready for that
        // next stage) rather than being finalized. Week in Deposit IS the
        // genuinely last stage for an Inactive employee (nothing comes
        // after it) or, for a still-Active employee, isn't a "stage" in
        // a cascade at all — normal payroll just continues regardless —
        // so those are the only two cases where an uncovered remainder
        // finalizes into a declared loss (status → Absorbed) right away.
        const emp = employees.find(e => e.id === stmt.employeeId);
        const prepayStaysOpenIfInsufficient = currentReleaseMode === 'paycheck' || (emp && emp.status === 'Active');

        let prepayTarget = null, prepayAmount = 0, prepayStaysOpen = false;
        if (insufficient && !overCommitted) {
            const pool = +(stmt.saved - selectedTotal).toFixed(2);
            const unselected = stmt.items.filter(i => !i.selected).sort((a, b) => (a.amount - b.amount) || String(a.start_date || '').localeCompare(String(b.start_date || '')));
            if (pool > 0.004 && unselected.length) {
                prepayTarget = unselected[0];
                prepayAmount = +Math.min(pool, prepayTarget.amount).toFixed(2);
                prepayStaysOpen = prepayStaysOpenIfInsufficient;
            }
        }
        return { totalPending: +totalPending.toFixed(2), selectedTotal: +selectedTotal.toFixed(2), insufficient, overCommitted, netRelease, prepayTarget, prepayAmount, prepayStaysOpen };
    }

    let currentReleaseStatement = null; // the live, mutable statement object backing the open overlay
    let currentReleaseMode = 'wd'; // 'wd' = Week in Deposit, 'paycheck' = last paycheck
    let currentReleaseEmployeeId = null; // used by paycheck mode (no charge_id to key off)
    let currentReleaseIsEarly = false; // true when opened via the Early Release button, bypassing the normal 90/30-day gate

    function openReleaseStatement(chargeId, isEarly) {
        if (!canEdit()) return;
        const stmt = computeReleaseStatement(chargeId);
        if (!stmt) return;

        // Gate on eligibility BEFORE showing the statement at all — Week
        // in Deposit specifically needs the 90-day rule off the
        // employee's Last Date Worked, not the 30-day one (that one's for
        // the last week's pay itself, tracked separately in the HR &
        // Payroll report, not enforced here). The Early Release button
        // deliberately bypasses this gate — that's the whole point of it
        // — but still requires an explicit extra confirmation, and a
        // Medium user's early (or normal) release always goes to an
        // Administrator for approval rather than executing directly.
        const eligibleDate = weekDepositEligibleDate(stmt.charge.employee_id);
        if (!isEarly) {
            if (eligibleDate && todayStr() < eligibleDate) {
                alert(`This account can't be released yet. Based on this employee's Last Date Worked, the earliest eligible date is ${eligibleDate}. Use "Early Release" instead if this needs to happen sooner.`);
                return;
            }
            if (!eligibleDate) {
                if (!confirm('This employee has no Last Date Worked on file, so the 90-day eligibility rule can\'t be checked. Continue anyway?')) return;
            }
        } else {
            if (!confirm(`This is an EARLY release — the normal eligible date is ${eligibleDate || 'unknown (no Last Date Worked on file)'}. ${currentUserRole === 'Medium' ? 'This will be sent to an Administrator for approval.' : 'Continue?'}`)) return;
        }

        currentReleaseMode = 'wd';
        currentReleaseIsEarly = !!isEarly;
        releaseStatementChargeId = chargeId;
        currentReleaseStatement = stmt;
        document.getElementById('release-statement-title').textContent = (isEarly ? '⏰ Early Release — ' : '') + 'Release Semana de Fondo';
        document.getElementById('release-statement-subtitle').textContent = "Review before closing this account — this can't be undone from here.";
        document.getElementById('release-confirm-btn').textContent = currentUserRole === 'Medium' ? 'Send for Approval' : 'Close Account';
        document.getElementById('release-statement-overlay').style.display = 'flex';
        renderReleaseStatementBody();
    }

    // Second entry point into the same overlay — for an Inactive
    // Sums an employee's Daily Pay entries plus any Additional Income
    // active for the Sun-Sat week containing their last worked day —
    // deliberately NOT a full payroll recompute (no claim/charge
    // deductions folded in here), since the release flow's own
    // settle/prepay/absorb logic already handles those separately; this
    // is just "what would have shown up on the paycheck before
    // deductions". Returns null if there's no Daily Pay history to derive
    // a week from at all, so the caller can fall back to asking for the
    // amount by hand.
    async function computeLastPaycheckAmount(empId) {
        const lastWorked = lastDailyPayWorked[empId];
        if (!lastWorked) return null;
        const sunday = weekStartSunday(new Date(lastWorked + 'T00:00:00Z'));
        const key = weekKeyFromSunday(sunday);
        const saturday = new Date(sunday); saturday.setUTCDate(saturday.getUTCDate() + 6);
        const saturdayStr = saturday.toISOString().split('T')[0];

        let dailyTotal = 0;
        try {
            const { data, error } = await supabaseClient.rpc('get_daily_pay', { p_actor: currentUsername, p_company: currentCompany, p_year: key.year, p_week: key.week });
            if (error) { console.error('computeLastPaycheckAmount get_daily_pay:', error); }
            else (data || []).filter(r => r.employee_id === empId && !r.is_off).forEach(r => { dailyTotal += parseFloat(r.amount) || 0; });
        } catch (e) { console.error('computeLastPaycheckAmount:', e); }

        const incomeTotal = additionalIncome
            .filter(i => i.employee_id === empId && i.status !== 'Queued' && i.start_date && i.start_date <= saturdayStr && remainingBalanceBefore(i.amount, i.weekly_amount, i.start_date, i.status, saturdayStr) > 0)
            .reduce((a, i) => a + Math.min(parseFloat(i.weekly_amount) || 0, remainingBalanceBefore(i.amount, i.weekly_amount, i.start_date, i.status, saturdayStr)), 0);

        return { basePay: +dailyTotal.toFixed(2), additionalIncome: +incomeTotal.toFixed(2), total: +(dailyTotal + incomeTotal).toFixed(2) };
    }

    // Second entry point into the same overlay — for an Inactive
    // employee's held final paycheck instead of their Week in Deposit
    // savings. Same 100%-settle-then-absorb rules, same shared pending-
    // items list, just a different pool of money and its own 30-day gate.
    // The paycheck amount auto-fills from that employee's Daily Pay +
    // Additional Income for the week containing their last worked day —
    // still shown as a normal editable field so it can be corrected by
    // hand if Statement/Payroll shows something different for that week.
    async function openLastPaycheckRelease(empId, isEarly) {
        if (!canEdit()) return;
        const emp = employees.find(e => e.id === empId);
        if (!emp) return;
        const d = getEmpDetail(empId);
        if (d.last_paycheck_released_at) { alert('This employee\'s last paycheck has already been released.'); return; }
        const eligibleDate = lastWeekPayEligibleDate(empId);
        if (!isEarly) {
            if (eligibleDate && todayStr() < eligibleDate) {
                alert(`This can't be released yet. Based on this employee's Last Date Worked, the earliest eligible date is ${eligibleDate}. Use "Early Release" instead if this needs to happen sooner.`);
                return;
            }
            if (!eligibleDate) {
                if (!confirm('This employee has no Last Date Worked on file, so the 30-day eligibility rule can\'t be checked. Continue anyway?')) return;
            }
        } else {
            if (!confirm(`This is an EARLY release — the normal eligible date is ${eligibleDate || 'unknown (no Last Date Worked on file)'}. ${currentUserRole === 'Medium' ? 'This will be sent to an Administrator for approval.' : 'Continue?'}`)) return;
        }

        currentReleaseMode = 'paycheck';
        currentReleaseIsEarly = !!isEarly;
        currentReleaseEmployeeId = empId;
        currentReleaseStatement = { saved: 0, employeeId: empId, items: pendingItemsForEmployee(empId) };
        applyGreedyDefaultSelection(currentReleaseStatement); // pool is $0 at this point, so nothing selects yet — re-run below once the real amount is known
        document.getElementById('release-statement-title').textContent = (isEarly ? '⏰ Early Release — ' : '') + 'Release Last Paycheck';
        document.getElementById('release-statement-subtitle').textContent = "Calculating this employee's final paycheck from Daily Pay and Additional Income…";
        document.getElementById('release-confirm-btn').textContent = currentUserRole === 'Medium' ? 'Send for Approval' : 'Release Paycheck';
        document.getElementById('release-statement-overlay').style.display = 'flex';
        renderReleaseStatementBody();

        const auto = await computeLastPaycheckAmount(empId);
        if (currentReleaseMode !== 'paycheck' || currentReleaseEmployeeId !== empId) return; // overlay was closed/changed while this was loading
        if (auto !== null) {
            currentReleaseStatement.saved = auto.total;
            currentReleaseStatement.basePay = auto.basePay;
            currentReleaseStatement.additionalIncome = auto.additionalIncome;
            applyGreedyDefaultSelection(currentReleaseStatement); // now that the real amount is known, pick a sensible starting checklist instead of leaving everything unchecked
        }
        document.getElementById('release-statement-subtitle').textContent = auto !== null
            ? "Auto-filled from this employee's Daily Pay + Additional Income for their last worked week — double-check against Statement/Payroll, then review before releasing. This can't be undone from here."
            : "No Daily Pay history found to auto-fill from — enter the amount from this employee's final paycheck (check Statement/Payroll for that week), then review before releasing. This can't be undone from here.";
        renderReleaseStatementBody();
    }

    function setPaycheckAmount(val) {
        if (!currentReleaseStatement) return;
        currentReleaseStatement.saved = Math.max(0, parseFloat(val) || 0);
        // A manual edit means the amount no longer matches what was
        // auto-computed, so the base-pay/income split can't be trusted
        // anymore either — cleared rather than left showing a stale
        // breakdown that no longer adds up to the new total.
        currentReleaseStatement.basePay = undefined;
        currentReleaseStatement.additionalIncome = undefined;
        renderReleaseStatementBody();
    }

    function toggleReleaseItem(key) {
        if (!currentReleaseStatement) return;
        const [type, id] = key.split(':');
        const item = currentReleaseStatement.items.find(i => i.type === type && i.id === id);
        if (item) item.selected = !item.selected;
        renderReleaseStatementBody();
    }

    function renderReleaseStatementBody() {
        const stmt = currentReleaseStatement;
        if (!stmt) return;
        const totals = releaseTotals(stmt);
        const empId = currentReleaseMode === 'wd' ? stmt.charge.employee_id : currentReleaseEmployeeId;
        const emp = employees.find(e => e.id === empId);
        const empName = emp ? `${emp.first_name} ${emp.last_name}` : empId;
        const body = document.getElementById('release-statement-body');
        body.innerHTML = `
            <div class="rec-detail-grid" style="margin-bottom:10px;">
                <div><div class="k">Employee</div><div class="v">${escHtml(empName)}</div></div>
                ${currentReleaseMode === 'wd'
                    ? `<div><div class="k">Saved amount</div><div class="v" style="color:#059669;font-weight:700;">${formatMoney(stmt.saved)}</div></div>`
                    : `<div><div class="k">Paycheck amount</div><input type="number" step="0.01" min="0" value="${stmt.saved || ''}" placeholder="0.00" style="font-weight:700;" oninput="setPaycheckAmount(this.value)"></div>`}
            </div>
            ${stmt.items.length ? `
                <div class="detail-subhead">Outstanding / pending — tap a name to review, check to settle in full</div>
                <div style="font-size:12px; margin-bottom:8px;">
                    ${stmt.items.map(it => {
                        const isPrepayTarget = totals.prepayTarget && totals.prepayTarget.type === it.type && totals.prepayTarget.id === it.id;
                        const remainder = isPrepayTarget ? +(it.amount - totals.prepayAmount).toFixed(2) : 0;
                        return `<div style="display:flex; align-items:center; gap:8px; padding:5px 0; border-bottom:1px solid var(--border);">
                        <input type="checkbox" ${it.selected ? 'checked' : ''} onchange="toggleReleaseItem('${it.type}:${escJsAttr(it.id)}')">
                        <span style="flex:1; cursor:pointer; color:var(--secondary); text-decoration:underline;" onclick="jumpToReleaseItem('${it.type}','${escJsAttr(it.id)}')">
                            <span class="type-pill">${it.type === 'claim' ? 'Claim' : 'Charge'}</span> ${it.id} · ${escHtml(it.label)}
                            ${isPrepayTarget ? (totals.prepayStaysOpen
                                ? (currentReleaseMode === 'paycheck'
                                    ? `<br><span style="color:#7c3aed; font-weight:700;">+ ${formatMoney(totals.prepayAmount)} applied — ${formatMoney(remainder)} carries forward, still collectible from a future Week in Deposit release</span>`
                                    : `<br><span style="color:#7c3aed; font-weight:700;">+ ${formatMoney(totals.prepayAmount)} applied — ${formatMoney(remainder)} remains, continues on its normal weekly schedule</span>`)
                                : `<br><span style="color:#7c3aed; font-weight:700;">+ ${formatMoney(totals.prepayAmount)} applied first</span> — <span style="color:#dc2626; font-weight:700;">${formatMoney(remainder)} remaining will be declared a loss (Absorbed)</span>`) : ''}
                        </span>
                        <span style="font-weight:700; ${it.selected ? 'color:#dc2626;' : (isPrepayTarget ? 'color:#7c3aed;' : 'color:var(--text-muted);')}">${it.selected ? '−' : (isPrepayTarget ? '−' : '')}${formatMoney(it.selected ? it.amount : (isPrepayTarget ? totals.prepayAmount : it.amount))}</span>
                    </div>`;
                    }).join('')}
                </div>
                ${totals.insufficient ? `<div style="font-size:11px; color:#dc2626; margin-bottom:8px;">Outstanding total (${formatMoney(totals.totalPending)}) is more than what's available.${totals.prepayTarget ? ` Whatever's left after settling checked items is credited against the next item first${totals.prepayStaysOpen ? '' : ', then the remainder is declared a loss'} — none of it is released while debt remains.` : ''} ${currentReleaseMode === 'paycheck'
                    ? 'Everything else left unchecked simply stays pending exactly as it is — Last Paycheck is never the final chance, so nothing here gets declared a loss; a later Week in Deposit release can still cover it.'
                    : `Anything else left unchecked when you release will be marked <strong>Absorbed</strong> (a loss) — it can't stay open once this account closes.`}</div>` : ''}
                ${totals.overCommitted ? `<div style="font-size:11px; color:#dc2626; margin-bottom:8px;">Selected total (${formatMoney(totals.selectedTotal)}) is more than what's available — uncheck something first.</div>` : ''}
            ` : `<div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">No other outstanding or pending claims/charges for this employee.</div>`}
            <div style="display:flex; justify-content:space-between; font-weight:700; font-size:14px; padding-top:8px; border-top:1px solid var(--border);">
                <span>Net release to employee</span>
                <span style="color:#059669;">${formatMoney(totals.netRelease)}</span>
            </div>`;
        const confirmBtn = document.getElementById('release-confirm-btn');
        if (confirmBtn) confirmBtn.disabled = totals.overCommitted;
    }

    // Lets someone tap a listed claim/charge straight from the release
    // statement to go look at it before deciding whether to check it —
    // closes the overlay first since the record it jumps to lives on a
    // different tab entirely.
    function jumpToReleaseItem(type, id) {
        closeReleaseStatement();
        openHomeShortcut('tab-claims');
        recExpanded[type === 'claim' ? 'claims' : 'charges'].add(id);
        renderClaimsCharges();
        setTimeout(() => document.getElementById(`rec-${type === 'claim' ? 'claims' : 'charges'}-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 150);
    }

    function closeReleaseStatement() {
        releaseStatementChargeId = null;
        currentReleaseEmployeeId = null;
        currentReleaseStatement = null;
        currentReleaseIsEarly = false;
        document.getElementById('release-statement-overlay').style.display = 'none';
    }

    async function confirmRelease() {
        if (!currentReleaseStatement || !canEdit()) return;
        if (currentReleaseMode === 'wd' && !releaseStatementChargeId) return;
        if (currentReleaseMode === 'paycheck' && !currentReleaseEmployeeId) return;
        const stmt = currentReleaseStatement;
        const totals = releaseTotals(stmt);
        if (totals.overCommitted) { alert('Uncheck something first — the selected total is more than what\'s available.'); return; }
        if (currentReleaseMode === 'paycheck' && stmt.saved <= 0) { alert('Enter the paycheck amount first.'); return; }
        const settle = stmt.items.filter(i => i.selected).map(i => ({ type: i.type, id: i.id, amount: i.amount }));
        // Last Paycheck is never the final stage — an Inactive employee's
        // Week in Deposit release, if they have one, is still coming —
        // so NOTHING finalizes into a declared loss during a Last
        // Paycheck release, not just the specific item that got a
        // partial credit. Every other unselected item is simply left
        // untouched (not settled, not absorbed, not credited) and stays
        // exactly as pending as it already was for that next release to
        // try. Only a Week in Deposit release for an Inactive employee
        // (the genuinely last possible stage) ever finalizes anything.
        const neverFinalizesThisRelease = currentReleaseMode === 'paycheck';
        const prepayStaysOpen = totals.prepayTarget && totals.prepayStaysOpen;
        // When the prepay target stays open (a real ongoing paycheck to
        // fall back on, or Last Paycheck with a future stage still
        // coming), it's excluded from absorb — it isn't a loss, it
        // either continues on its normal weekly schedule from the
        // reduced balance (Active/Week in Deposit) or simply carries the
        // credit forward untouched otherwise (Last Paycheck). When it
        // doesn't stay open (the genuinely final stage), the credit and
        // the loss happen in the same instant — so instead of a separate
        // partial-prepay call, it goes through absorb with its FULL
        // pending amount, which lands on the identical final balance as
        // "credit the partial amount, then absorb the remainder" would
        // (750 credited + 2,019.78 absorbed = the same 2,769.78 total
        // either way) without needing two RPC calls to land on one number.
        const absorb = (totals.insufficient && !neverFinalizesThisRelease)
            ? stmt.items.filter(i => !i.selected && !(prepayStaysOpen && totals.prepayTarget.type === i.type && totals.prepayTarget.id === i.id)).map(i => ({ type: i.type, id: i.id, amount: i.amount }))
            : [];
        const prepay = prepayStaysOpen ? { type: totals.prepayTarget.type, id: totals.prepayTarget.id, amount: totals.prepayAmount } : null;
        const empId = currentReleaseMode === 'wd' ? stmt.employeeId : currentReleaseEmployeeId;

        const btn = document.getElementById('release-confirm-btn');
        const originalLabel = btn.textContent;
        btn.disabled = true; btn.textContent = currentUserRole === 'Medium' ? 'Sending...' : 'Releasing...';

        // A Medium user never executes a release directly — both the
        // normal and Early Release paths always go to an Administrator
        // for approval first. An Administrator (or SuperAdmin) executes
        // immediately, same as before, now also recording whether this
        // particular release was early.
        if (currentUserRole === 'Medium') {
            const { error } = await supabaseClient.rpc('request_release', {
                p_actor: currentUsername, p_release_type: currentReleaseMode,
                p_charge_id: currentReleaseMode === 'wd' ? releaseStatementChargeId : null,
                p_employee_id: empId, p_saved_amount: stmt.saved, p_settle: settle, p_absorb: absorb,
                p_prepay: prepay, p_net_release: totals.netRelease, p_is_early: currentReleaseIsEarly
            });
            btn.disabled = false; btn.textContent = originalLabel;
            if (error) { alert('Error: ' + error.message); return; }
            closeReleaseStatement();
            alert('Sent for Administrator approval — nothing has been released yet. You\'ll see it move once it\'s been acted on.');
            return;
        }

        const { error } = currentReleaseMode === 'wd'
            ? await supabaseClient.rpc('release_week_deposit', {
                p_actor: currentUsername, p_charge_id: releaseStatementChargeId,
                p_saved_amount: stmt.saved, p_settle: settle, p_absorb: absorb, p_prepay: prepay, p_net_release: totals.netRelease,
                p_is_early: currentReleaseIsEarly, p_via_request: false
            })
            : await supabaseClient.rpc('release_last_paycheck', {
                p_actor: currentUsername, p_employee_id: currentReleaseEmployeeId,
                p_paycheck_amount: stmt.saved, p_settle: settle, p_absorb: absorb, p_prepay: prepay, p_net_release: totals.netRelease,
                p_is_early: currentReleaseIsEarly, p_via_request: false,
                p_base_pay_amount: stmt.basePay ?? null, p_additional_income_amount: stmt.additionalIncome ?? null
            });
        btn.disabled = false; btn.textContent = originalLabel;
        if (error) { alert('Error: ' + error.message); return; }
        const mode = currentReleaseMode;
        closeReleaseStatement();
        await fetchChargesFromCloud();
        await fetchClaimsFromCloud();
        await loadChargeHistory();
        if (mode === 'wd') renderWeekDeposit();
        else { await loadEmployeeDetails(); renderSavingsReleaseReport(); }
        let msg = `Released. ${formatMoney(totals.netRelease)} net to hand over.`;
        if (prepay) msg += `\n${formatMoney(prepay.amount)} applied as a prepayment toward ${prepay.type} ${prepay.id}.`;
        if (settle.length) msg += `\n${settle.length} item(s) settled in full (${formatMoney(totals.selectedTotal)}).`;
        if (absorb.length) msg += `\n${absorb.length} item(s) couldn't be covered and were marked Absorbed.`;
        alert(msg);
    }

    // Cross-employee view of everything the two release flows need: who
    // has Semana de Fondo savings still open, who's an Inactive employee
    // with an unreleased final paycheck, what each owes elsewhere, and
    // the earliest date each becomes eligible — all built from data
    // that's already loaded, same as Home's dashboard.
    function renderSavingsReleaseReport() {
        const rows = [];
        charges.filter(c => c.charge_type === WEEK_DEPOSIT_TYPE && c.status !== 'Released').forEach(c => {
            const emp = employees.find(e => e.id === c.employee_id);
            const goal = Math.max(0, parseFloat(c.amount) || 0);
            const saved = Math.max(0, +(goal - chargeBalance(c)).toFixed(2));
            const pending = pendingItemsForEmployee(c.employee_id).reduce((a, i) => a + i.amount, 0);
            const eligible = weekDepositEligibleDate(c.employee_id);
            rows.push({
                empId: c.employee_id, empName: emp ? `${emp.first_name} ${emp.last_name}` : c.employee_id,
                kind: 'Week in Deposit', amount: saved, pending: +pending.toFixed(2),
                eligible, issue: eligible ? nextThursdayOnOrAfter(eligible) : null,
                handover: eligible ? addDaysStr(nextThursdayOnOrAfter(eligible), 2) : null,
                action: eligible && todayStr() >= eligible
                    ? `<button class="btn-small" style="margin:0;background:#7c3aed;" onclick="openReleaseStatement('${escJsAttr(c.charge_id)}')">${t('d_release')}</button>`
                    : `<button class="btn-small" style="margin:0;background:#b45309;" onclick="openReleaseStatement('${escJsAttr(c.charge_id)}', true)">${t('d_early_release')}</button>`
            });
        });
        employees.filter(e => e.status === 'Inactive').forEach(e => {
            const d = getEmpDetail(e.id);
            if (d.last_paycheck_released_at) return; // already handled
            const pending = pendingItemsForEmployee(e.id).reduce((a, i) => a + i.amount, 0);
            const eligible = lastWeekPayEligibleDate(e.id);
            rows.push({
                empId: e.id, empName: `${e.first_name} ${e.last_name}`,
                kind: 'Last Paycheck', amount: null, pending: +pending.toFixed(2),
                eligible, issue: eligible ? nextThursdayOnOrAfter(eligible) : null,
                handover: eligible ? addDaysStr(nextThursdayOnOrAfter(eligible), 2) : null,
                action: eligible && todayStr() >= eligible
                    ? `<button class="btn-small" style="margin:0;background:#7c3aed;" onclick="openLastPaycheckRelease('${escJsAttr(e.id)}')">${t('d_release')}</button>`
                    : `<button class="btn-small" style="margin:0;background:#b45309;" onclick="openLastPaycheckRelease('${escJsAttr(e.id)}', true)">${t('d_early_release')}</button>`
            });
        });
        rows.sort((a, b) => String(a.eligible || '9999').localeCompare(String(b.eligible || '9999')));

        const grid = document.getElementById('savingsreport-stats-grid');
        if (grid) {
            const readyNow = rows.filter(r => r.eligible && todayStr() >= r.eligible).length;
            const totalSavings = rows.filter(r => r.kind === 'Week in Deposit').reduce((a, r) => a + r.amount, 0);
            grid.innerHTML = `
                <div class="stat-card"><div class="stat-label">${t('d_ready_now')}</div><div class="stat-value">${readyNow}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_total_tracked')}</div><div class="stat-value">${rows.length}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_wid_savings')}</div><div class="stat-value">${formatMoney(totalSavings)}</div></div>`;
        }

        const q = (document.getElementById('savingsreport-search')?.value || '').toLowerCase();
        const kindF = document.getElementById('savingsreport-kind-filter')?.value || '';
        const readyF = document.getElementById('savingsreport-ready-filter')?.value || '';
        const filtered = rows.filter(r => {
            if (q && !r.empName.toLowerCase().includes(q)) return false;
            if (kindF && r.kind !== kindF) return false;
            const isReady = !!(r.eligible && todayStr() >= r.eligible);
            if (readyF === 'ready' && !isReady) return false;
            if (readyF === 'notyet' && isReady) return false;
            return true;
        });

        const body = document.getElementById('savingsreport-tbody');
        if (!body) return;
        if (!filtered.length) { body.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:20px;">${t('d_nothing_savings')}</div>`; return; }

        // Group by employee, employee groups sorted by name.
        const groups = {};
        filtered.forEach(r => { (groups[r.empId] = groups[r.empId] || []).push(r); });
        const empIds = Object.keys(groups).sort((a, b) => groups[a][0].empName.localeCompare(groups[b][0].empName, undefined, { sensitivity: 'base' }));
        const cardHtml = (r) => `
            <div class="rec-card" style="cursor:default;">
                <div class="rec-card-head" style="cursor:default;">
                    <span class="rec-title"><span class="type-pill">${r.kind}</span></span>
                    <span class="rec-right">${r.amount !== null ? formatMoney(r.amount) : ''}</span>
                </div>
                <div class="rec-card-body" style="display:block;">
                    <div class="rec-detail-grid">
                        <div><div class="k">${t('d_pending_elsewhere')}</div><div class="v" style="${r.pending > 0.004 ? 'color:#dc2626;font-weight:700;' : ''}">${formatMoney(r.pending)}</div></div>
                        <div><div class="k">${t('d_eligible_date')}</div><div class="v">${r.eligible || 'Unknown — no Last Date Worked on file'}</div></div>
                        <div><div class="k">${t('d_check_issued')}</div><div class="v">${r.issue || '-'}</div></div>
                        <div><div class="k">${t('d_handed_over')}</div><div class="v">${r.handover || '-'}</div></div>
                    </div>
                    ${r.action ? `<div class="rec-actions" style="margin-top:10px;">${r.action}</div>` : (r.eligible ? `<div style="font-size:11px; color:var(--text-muted); margin-top:8px;">${t('d_not_eligible_until')} ${r.eligible}.</div>` : '')}
                </div>
            </div>`;
        body.innerHTML = empIds.map(empId => {
            const items = groups[empId];
            const collapsed = collapsedEmpGroups.savingsreport.has(empId);
            const header = `<div class="rec-group-header" style="cursor:pointer;" onclick="toggleEmpGroup('savingsreport','${escJsAttr(empId)}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> ${escHtml(items[0].empName)} <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem;">(${items.length})</span></div>`;
            return collapsed ? header : header + items.map(cardHtml).join('');
        }).join('');
    }

    // Permanent, auditable log of every completed release — populated
    // automatically as the last step inside release_week_deposit and
    // release_last_paycheck, so it's complete regardless of whether a
    // release happened directly (Administrator) or through the approval
    // queue (Medium's request, once approved). Fetched fresh every time
    // the tab opens rather than cached, since it's a historical record
    // that should always reflect the true database state.
    let releaseHistoryCache = [];
    async function fetchReleaseHistory() {
        const body = document.getElementById('releasehistory-tbody');
        if (body) body.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding:20px;">Loading…</div>';
        try {
            const { data, error } = await supabaseClient.rpc('get_release_history', { p_actor: currentUsername, p_company: currentCompany });
            if (error) { console.error('get_release_history:', error); releaseHistoryCache = []; }
            else releaseHistoryCache = data || [];
        } catch (e) { console.error('fetchReleaseHistory:', e); releaseHistoryCache = []; }
        renderReleaseHistory();
    }

    function renderReleaseHistory() {
        const query = (document.getElementById('releasehistory-search')?.value || '').toLowerCase();
        const typeF = document.getElementById('releasehistory-type-filter')?.value || '';
        const earlyF = document.getElementById('releasehistory-early-filter')?.value || '';
        const rows = releaseHistoryCache.filter(r => {
            if (typeF && r.release_type !== typeF) return false;
            if (earlyF === 'early' && !r.was_early) return false;
            if (earlyF === 'ontime' && r.was_early) return false;
            if (query) {
                const emp = employees.find(e => e.id === r.employee_id);
                const empName = emp ? `${emp.first_name} ${emp.last_name}` : r.employee_id;
                if (!`${empName} ${r.released_by}`.toLowerCase().includes(query)) return false;
            }
            return true;
        });

        const grid = document.getElementById('releasehistory-stats-grid');
        if (grid) {
            const totalReleased = releaseHistoryCache.reduce((a, r) => a + (parseFloat(r.net_release) || 0), 0);
            const totalDeducted = releaseHistoryCache.reduce((a, r) => a + (parseFloat(r.total_deducted) || 0), 0);
            const earlyCount = releaseHistoryCache.filter(r => r.was_early).length;
            grid.innerHTML = `
                <div class="stat-card"><div class="stat-label">${t('d_total_releases')}</div><div class="stat-value">${releaseHistoryCache.length}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_net_released_emp')}</div><div class="stat-value" style="color:#059669;">${formatMoney(totalReleased)}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_total_applied_ded')}</div><div class="stat-value">${formatMoney(totalDeducted)}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_early_releases')}</div><div class="stat-value">${earlyCount}</div></div>`;
        }

        const body = document.getElementById('releasehistory-tbody');
        if (!body) return;
        if (!rows.length) { body.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_releases')}</div>`; return; }
        const nameOf = (empId) => { const emp = employees.find(e => e.id === empId); return emp ? `${emp.first_name} ${emp.last_name}` : empId; };
        const groups = {};
        rows.forEach(r => { (groups[r.employee_id] = groups[r.employee_id] || []).push(r); });
        const empIds = Object.keys(groups).sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }));
        const cardHtml = (r) => {
            const items = [...(r.settle || []), ...(r.absorb || [])];
            const hasBreakdown = r.base_pay_amount != null || r.additional_income_amount != null;
            const open = recExpanded.releasehistory.has(String(r.id));
            return `
            <div class="rec-card${open ? ' open' : ''}" id="rec-releasehistory-${r.id}">
                <div class="rec-card-head" onclick="toggleRecCard('releasehistory','${r.id}')">
                    <span class="rec-caret" data-caret="releasehistory-${r.id}">${open ? '▾' : '▸'}</span>
                    <span class="rec-title"><span class="type-pill">${r.release_type === 'wd' ? t('week_in_deposit_opt') : t('last_paycheck_opt')}</span>${r.was_early ? ' <span class="type-pill" style="background:#b45309;color:#fff;">Early</span>' : ''}</span>
                    <span class="rec-sub">${new Date(r.released_at).toISOString().split('T')[0]} · ${t('d_by')} ${escHtml(r.released_by)}</span>
                    <span class="rec-right" style="color:#059669;">${formatMoney(r.net_release)}</span>
                </div>
                <div class="rec-card-body">
                    <div class="rec-detail-grid">
                        ${hasBreakdown ? `
                        <div><div class="k">${t('d_base_pay')}</div><div class="v">${formatMoney(r.base_pay_amount || 0)}</div></div>
                        <div><div class="k">${t('d_additional_income_c')}</div><div class="v">${formatMoney(r.additional_income_amount || 0)}</div></div>` : ''}
                        <div><div class="k">${t('d_original_amount')}</div><div class="v">${formatMoney(r.gross_amount)}</div></div>
                        <div><div class="k">${t('d_total_deductions_c')}</div><div class="v" style="${r.total_deducted > 0.004 ? 'color:#dc2626;' : ''}">${formatMoney(r.total_deducted)}</div></div>
                        <div><div class="k">${t('d_final_released')}</div><div class="v" style="color:#059669;font-weight:700;">${formatMoney(r.net_release)}</div></div>
                        <div><div class="k">${t('d_requested_via')}</div><div class="v">${r.was_via_request ? 'Yes' : 'No — direct release'}</div></div>
                    </div>
                    ${items.length ? `
                    <div class="detail-subhead" style="margin-top:8px;">${t('d_applied_to')}</div>
                    <div style="font-size:12px;">
                        ${(r.settle || []).map(i => `<div style="padding:3px 0;"><span class="type-pill">${i.type === 'claim' ? 'Claim' : 'Charge'}</span> ${i.id} — settled in full <span style="color:#dc2626;">−${formatMoney(i.amount)}</span></div>`).join('')}
                        ${(r.absorb || []).map(i => `<div style="padding:3px 0;"><span class="type-pill">${i.type === 'claim' ? 'Claim' : 'Charge'}</span> ${i.id} — declared a loss (Absorbed) <span style="color:#dc2626;">−${formatMoney(i.amount)}</span></div>`).join('')}
                        ${r.prepay ? `<div style="padding:3px 0;"><span class="type-pill">${r.prepay.type === 'claim' ? 'Claim' : 'Charge'}</span> ${r.prepay.id} — partial prepayment <span style="color:#7c3aed;">−${formatMoney(r.prepay.amount)}</span></div>` : ''}
                    </div>` : `<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">${t('d_no_other_outstanding')}</div>`}
                </div>
            </div>`;
        };
        body.innerHTML = empIds.map(empId => {
            const its = groups[empId];
            const collapsed = collapsedEmpGroups.releasehistory.has(empId);
            const header = `<div class="rec-group-header" style="grid-column:1/-1; cursor:pointer;" onclick="toggleEmpGroup('releasehistory','${escJsAttr(empId)}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> ${escHtml(nameOf(empId))} <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem;">(${its.length})</span></div>`;
            return collapsed ? header : header + its.map(cardHtml).join('');
        }).join('');
    }

    // ===== ADDITIONAL INCOME (mirror of charges, but ADDS to pay) =====
    let incomeTableMissing = false;

    async function fetchIncomeFromCloud() {
        incomeTableMissing = false;
        try {
            const { data, error } = await supabaseClient.rpc('get_additional_income', { p_actor: currentUsername, p_company: currentCompany });
            if (error) { if (isMissingTable(error)) { incomeTableMissing = true; additionalIncome = []; } else console.error('additional_income:', error); }
            else additionalIncome = data || [];
        } catch (e) { console.error('fetchIncomeFromCloud:', e); }
        renderIncome();
        refreshIdPreviews();
    }

    // Remaining amount still to be paid out. Paid/Stopped -> 0.
    function incomeRemaining(inc) {
        if (inc.status === 'Paid' || inc.status === 'Stopped') return 0;
        return remainingBalance(inc.amount, 0, inc.weekly_amount, inc.start_date, inc.status);
    }
    // Sum of weekly additional income for one employee (only 'Paying', still owed).
    function activeWeeklyIncome(empId) {
        const asOf = payrollAsOf();
        let total = 0;
        additionalIncome.filter(i => i.employee_id === empId && i.status !== 'Queued' && i.start_date && i.start_date <= asOf).forEach(i => {
            const remBefore = remainingBalanceBefore(i.amount, i.weekly_amount, i.start_date, i.status, asOf);
            if (remBefore > 0) total += Math.min(parseFloat(i.weekly_amount) || 0, remBefore);
        });
        return total;
    }
    // Itemized version for the payroll expand row.
    function incomeBreakdown(empId) {
        const asOf = payrollAsOf();
        return additionalIncome
            .filter(i => i.employee_id === empId && i.status !== 'Queued' && i.start_date && i.start_date <= asOf && remainingBalanceBefore(i.amount, i.weekly_amount, i.start_date, i.status, asOf) > 0)
            .map(i => {
                const remBefore = remainingBalanceBefore(i.amount, i.weekly_amount, i.start_date, i.status, asOf);
                return { id: i.income_id, label: i.income_type || 'Income', weekly: Math.min(parseFloat(i.weekly_amount) || 0, remBefore), remaining: remainingBalanceAsOf(i.amount, i.weekly_amount, i.start_date, i.status, asOf), notes: i.notes || '' };
            });
    }

    document.getElementById('income-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!canEdit()) return;
        if (incomeTableMissing) { alert('The additional_income table is not set up yet. Run the income setup SQL first.'); return; }
        const incomeCo = requireWriteCompany();
        if (!incomeCo) return;
        const empId = document.getElementById('i-employee').value;
        if (!empId) { alert('Select an employee at the top of the tab first.'); return; }

        if (editingIncomeId) {
            const { error } = await supabaseClient.rpc('edit_income', {
                p_actor: currentUsername, p_id: editingIncomeId, p_income_type: document.getElementById('iType').value,
                p_amount: parseFloat(document.getElementById('iAmount').value) || 0,
                p_weekly_amount: parseFloat(document.getElementById('iWeekly').value) || 0,
                p_start_date: document.getElementById('iStartDate').value || null,
                p_status: document.getElementById('iStatus').value, p_notes: document.getElementById('iNotes').value.trim()
            });
            if (error) { alert('Error: ' + error.message); return; }
            cancelIncomeEdit();
            fetchIncomeFromCloud();
            return;
        }

        const incomeId = `${idPrefix()}${String(additionalIncome.length + 1).padStart(settings.chargeDigits, '0')}I`;
        const payload = {
            income_id: incomeId,
            company_code: incomeCo,
            employee_id: empId,
            income_type: document.getElementById('iType').value,
            amount: parseFloat(document.getElementById('iAmount').value) || 0,
            weekly_amount: parseFloat(document.getElementById('iWeekly').value) || 0,
            start_date: document.getElementById('iStartDate').value || null,
            end_date: document.getElementById('iEndDate').value || null,
            status: document.getElementById('iStatus').value,
            notes: document.getElementById('iNotes').value.trim()
        };
        const { error } = await supabaseClient.rpc('create_income', { p_actor: currentUsername, p_fields: payload });
        if (error) { alert('Error saving income: ' + error.message); return; }
        document.getElementById('income-form').reset();
        fetchIncomeFromCloud();
    });

    function incomeDetailHtml(i, empName, weeks, rem, endDate, editable) {
        const owed = Math.max(0, parseFloat(i.amount) || 0);
        const pct = owed > 0 ? Math.round(((owed - rem) / owed) * 100) : 0;
        return `
            ${progressBarHtml(pct)}
            <div class="rec-detail-grid">
                <div><div class="k" data-i18n="d_employee">Employee</div><div class="v">${escHtml(empName)}</div></div>
                <div><div class="k" data-i18n="d_employee_id">Employee ID</div><div class="v id-cell">${i.employee_id}</div></div>
                <div><div class="k" data-i18n="d_income_type">Income type</div><div class="v">${escHtml(i.income_type)}</div></div>
                <div><div class="k" data-i18n="d_amount">Amount</div><div class="v">${formatMoney(i.amount)}</div></div>
                <div><div class="k" data-i18n="d_weekly_amount">Weekly amount</div><div class="v">${formatMoney(i.weekly_amount)}</div></div>
                <div><div class="k" data-i18n="d_weeks">Weeks</div><div class="v">${weeks}</div></div>
                <div><div class="k" data-i18n="d_start">Start</div><div class="v">${i.start_date || '-'}</div></div>
                <div><div class="k" data-i18n="d_ends">Ends</div><div class="v">${endDate}</div></div>
            </div>
            ${i.notes ? `<div class="detail-subhead" style="margin-top:8px;" data-i18n="d_notes">Notes</div><div class="note-box" style="margin:0;">${escHtml(i.notes)}</div>` : ''}
            <div class="rec-actions">
                ${attachBtnHtml('income', i.income_id)}
                ${editable ? `<button class="btn-small" style="margin:0;" onclick="editIncome('${i.income_id}')" data-i18n="d_edit_full">✎ Edit</button>
                <button class="del-btn" onclick="deleteIncome('${i.income_id}')" data-i18n="d_delete">✕ Delete</button>` : ''}
            </div>`;
    }

    function renderIncome() {
        const query = (document.getElementById('income-search')?.value || '').toLowerCase();
        let list = additionalIncome.filter(i => {
            if (!query) return true;
            const emp = employees.find(e => e.id === i.employee_id);
            const empName = emp ? `${emp.first_name} ${emp.last_name}`.toLowerCase() : '';
            return (i.income_id || '').toLowerCase().includes(query) || (i.employee_id || '').toLowerCase().includes(query) ||
                empName.includes(query) || (i.income_type || '').toLowerCase().includes(query) || (i.status || '').toLowerCase().includes(query);
        });
        list = applySort(list, 'income', {
            income_id: i => i.income_id,
            employee_id: i => i.employee_id,
            employee: i => { const e = employees.find(x => x.id === i.employee_id); return e ? `${e.first_name} ${e.last_name}` : ''; },
            type: i => i.income_type || '',
            amount: i => i.amount || 0,
            remaining: i => incomeRemaining(i),
            status: i => i.status || '',
            start: i => i.start_date || ''
        });
        const container = document.getElementById('income-tbody');
        if (!container) return;
        if (incomeTableMissing) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#b45309; padding:1rem;">${t('d_income_setup_note')}</div>`; return; }
        const editable = canEdit();

        if (isDesktopView()) {
            container.className = '';
            if (!list.length) { container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_income')}</div>`; return; }
            let rows = '';
            groupByStatus(list).forEach(({ status, items }) => {
                const collapsed = collapsedStatusGroups.income.has(status);
                rows += `<tr class="rec-group-row" style="cursor:pointer;" onclick="toggleStatusGroup('income','${status}')"><td colspan="12"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400;">(${items.length})</span></td></tr>`;
                if (collapsed) return;
                items.forEach(i => {
                const emp = employees.find(e => e.id === i.employee_id);
                const empName = emp ? `${emp.first_name} ${emp.last_name}` : 'Unlinked';
                const weeks = weeksNeeded(i.amount, i.weekly_amount);
                const rem = incomeRemaining(i);
                const endDate = projectedEndDate(i.start_date, i.amount, i.weekly_amount) || (i.end_date || '-');
                const open = recExpanded.income.has(i.income_id);
                rows += `<tr style="cursor:pointer;" onclick="toggleRecCard('income','${i.income_id}')">
                    <td class="id-cell"><span class="rec-caret" data-caret="income-${i.income_id}">${open ? '▾' : '▸'}</span> ${i.income_id} ${attachInd('income', i.income_id)}</td>
                    <td>${escHtml(empName)}</td>
                    <td class="id-cell">${i.employee_id}</td>
                    <td>${escHtml(i.income_type)}</td>
                    <td>${formatMoney(i.amount)}</td>
                    <td>${formatMoney(i.weekly_amount)}</td>
                    <td>${weeks}</td>
                    <td>${formatMoney(rem)}</td>
                    <td>${i.start_date || '-'}</td>
                    <td>${endDate}</td>
                    <td><span class="status-badge status-${i.status}">${i.status}</span></td>
                    <td style="text-align:center; white-space:nowrap;" onclick="event.stopPropagation();">${editable ? `<button class="btn-small" style="padding:0.3rem 0.6rem;font-size:0.75rem;margin:0 3px 0 0;" onclick="editIncome('${i.income_id}')">✎</button><button class="del-btn" onclick="deleteIncome('${i.income_id}')">✕</button>` : ''}</td>
                </tr>
                <tr class="rec-card${open ? ' open' : ''}" id="rec-income-${i.income_id}" style="display:${open ? 'table-row' : 'none'};">
                    <td colspan="12" style="padding:12px; background:var(--surface-2);">${incomeDetailHtml(i, empName, weeks, rem, endDate, editable)}</td>
                </tr>`;
                });
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th data-i18n="th_income_id">Income ID</th><th data-i18n="th_employee">Employee</th><th data-i18n="th_emp_id">Emp. ID</th><th data-i18n="th_type">Type</th><th data-i18n="th_amount">Amount</th><th data-i18n="th_weekly">Weekly</th><th data-i18n="th_weeks">Weeks</th><th data-i18n="th_remaining">Remaining</th><th data-i18n="th_start">Start</th><th data-i18n="th_ends">Ends</th><th data-i18n="th_status">Status</th><th data-i18n="th_action">Action</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`;
            updateRecSortUI('income');
            applyTranslations();
            return;
        }

        container.className = 'record-grid';
        container.innerHTML = list.length ? '' : `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_income')}</div>`;
        groupByStatus(list).forEach(({ status, items }) => {
            const collapsed = collapsedStatusGroups.income.has(status);
            container.insertAdjacentHTML('beforeend', `<div class="rec-group-header" style="grid-column:1/-1; cursor:pointer;" onclick="toggleStatusGroup('income','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem;">(${items.length})</span></div>`);
            if (collapsed) return;
            items.forEach(i => {
            const emp = employees.find(e => e.id === i.employee_id);
            const empName = emp ? `${emp.first_name} ${emp.last_name}` : 'Unlinked';
            const weeks = weeksNeeded(i.amount, i.weekly_amount);
            const rem = incomeRemaining(i);
            const endDate = projectedEndDate(i.start_date, i.amount, i.weekly_amount) || (i.end_date || '-');
            const open = recExpanded.income.has(i.income_id);
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-income-${i.income_id}">
                    <div class="rec-card-head" onclick="toggleRecCard('income','${i.income_id}')">
                        <span class="rec-caret" data-caret="income-${i.income_id}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${escHtml(empName)}</span>
                        <span class="rec-sub">${i.income_id}</span>
                        ${attachInd('income', i.income_id)}
                        <span class="rec-right" style="color:#059669;">${formatMoney(rem)} <span class="status-badge status-${i.status}">${i.status}</span></span>
                    </div>
                    <div class="rec-card-body">${incomeDetailHtml(i, empName, weeks, rem, endDate, editable)}</div>
                </div>`);
            });
        });
        updateRecSortUI('income');
        applyTranslations();
    }

    let editingIncomeId = null;

    function editIncome(id) {
        if (!canEdit()) return;
        const inc = additionalIncome.find(x => x.income_id === id);
        if (!inc) return;
        editingIncomeId = id;
        const empSel = document.getElementById('i-employee');
        if (empSel) empSel.value = inc.employee_id || '';
        document.getElementById('iType').value = inc.income_type || '';
        document.getElementById('iAmount').value = (inc.amount ?? '');
        document.getElementById('iWeekly').value = (inc.weekly_amount ?? '');
        document.getElementById('iStartDate').value = inc.start_date || '';
        document.getElementById('iEndDate').value = inc.end_date || '';
        document.getElementById('iStatus').value = inc.status || 'Queued';
        document.getElementById('iNotes').value = inc.notes || '';
        document.getElementById('income-form-titletext').textContent = `${t('editing_prefix')} ${id}`;
        document.getElementById('income-save-btn').textContent = t('save_changes_plain');
        document.getElementById('income-cancel-btn').style.display = '';
        const panel = document.getElementById('income-form').closest('.panel');
        if (panel) panel.classList.remove('collapsed');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function cancelIncomeEdit() {
        editingIncomeId = null;
        document.getElementById('income-form').reset();
        document.getElementById('income-form-titletext').textContent = t('new_additional_income');
        document.getElementById('income-save-btn').textContent = t('save_income');
        document.getElementById('income-cancel-btn').style.display = 'none';
    }

    async function deleteIncome(id) {
        if (!canEdit()) return;
        if (!id) { alert('Error: could not identify which income entry to delete — try refreshing the page.'); return; }
        if (confirm('Delete income ' + id + '?')) {
            const { error } = await supabaseClient.rpc('delete_income', { p_actor: currentUsername, p_id: id });
            if (error) alert('Error: ' + error.message);
            fetchIncomeFromCloud();
        }
    }

    // --- STATEMENT LOGIC ---
    function populateStatementDropdown() {
        // Kept for the existing tab-open call site; the real work (and the
        // Person type / Status / Search filtering) lives below.
        populateStatementEmployeeDropdown();
    }

    function populateStatementEmployeeDropdown() {
        const sel = document.getElementById('statement-emp-select');
        if (!sel) return;
        const typeFilter = document.getElementById('statement-type-filter')?.value || '';
        const statusFilter = document.getElementById('statement-status-filter')?.value || '';
        const query = (document.getElementById('statement-search')?.value || '').toLowerCase();
        const filtered = employees.filter(emp => {
            if (typeFilter && emp.person_type !== typeFilter) return false;
            if (statusFilter && emp.status !== statusFilter) return false;
            if (query) {
                const hay = `${emp.id} ${emp.first_name} ${emp.last_name}`.toLowerCase();
                if (!hay.includes(query)) return false;
            }
            return true;
        }).sort((a, b) =>
            `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, undefined, { sensitivity: 'base' })
        );
        const prev = sel.value;
        sel.innerHTML = `<option value="">${t('select_employee_opt')}</option>` +
            filtered.map(emp => `<option value="${emp.id}">${employeeOptionLabel(emp)}</option>`).join('');
        // Keep the current selection if it still matches the filters; otherwise
        // clear it rather than silently keep showing a now-filtered-out person's statement.
        if (prev && filtered.some(e => e.id === prev)) { sel.value = prev; }
        else if (prev) { sel.value = ''; }
        // View Only only ever has their own single record to pick from (the
        // employees array is already server-side scoped to just them) — show
        // it directly instead of making them click a dropdown with one option.
        if (!sel.value && currentUserRole === 'User' && filtered.length === 1) sel.value = filtered[0].id;
        renderStatement(); // always, so the week label + stat bubbles are correct even before any employee is picked
    }

    // Bubble indicators above the statement — claims/charges/income counts
    // and totals for the selected employee, matching the stat-card style
    // already used on Claims/Charges/Payroll.
    function renderStatementStats(empId, asOf) {
        const grid = document.getElementById('statement-stats-grid');
        if (!grid) return;
        const empClaims = empId ? claims.filter(c => c.employee_id === empId) : [];
        const empCharges = empId ? charges.filter(ch => ch.employee_id === empId) : [];
        const empIncome = empId ? additionalIncome.filter(i => i.employee_id === empId) : [];
        const claimsTotal = empClaims.reduce((a, c) => a + (parseFloat(c.claim_amount) || 0), 0);
        const chargesTotal = empCharges.reduce((a, ch) => a + (parseFloat(ch.amount) || 0), 0);
        const incomeTotal = empIncome.reduce((a, i) => a + (parseFloat(i.amount) || 0), 0);
        grid.innerHTML = `
            <div class="stat-card"><div class="stat-label">${t('d_stat_claims')}</div><div class="stat-value">${empClaims.length}</div></div>
            <div class="stat-card"><div class="stat-label">${t('d_stat_charges')}</div><div class="stat-value">${empCharges.length}</div></div>
            <div class="stat-card"><div class="stat-label">${t('d_stat_add_income')}</div><div class="stat-value">${empIncome.length}</div></div>
            <div class="stat-card"><div class="stat-label">${t('d_total_claims')}</div><div class="stat-value">${formatMoney(claimsTotal)}</div></div>
            <div class="stat-card"><div class="stat-label">${t('d_total_charges')}</div><div class="stat-value">${formatMoney(chargesTotal)}</div></div>
            <div class="stat-card"><div class="stat-label">${t('d_total_income')}</div><div class="stat-value" style="color:#059669;">${formatMoney(incomeTotal)}</div></div>`;
    }

    // Extracted so both renderStatement's status-grouping loop and any
    // future caller can build one item's panel without duplicating markup.
    function statementClaimPanelHtml(c, asOf) {
        const sched = buildClaimSchedule(c, null); // full projection to $0.00
        const bal = claimBalance(c, asOf);
        const owed = Math.max(0, (parseFloat(c.claim_amount) || 0) - (parseFloat(c.absorbed_amount) || 0));
        const paidSoFar = Math.max(0, +(owed - bal).toFixed(2));
        const weeks = sched.rows.filter(r => !r.paused).length;
        const endDate = sched.endDate || '—';
        const scheduleRows = sched.rows.map(r => `<tr><td>${r.date}</td><td>${r.paused ? '<em style="color:var(--text-muted);">paused</em>' : formatMoney(r.deducted)}</td><td>${formatMoney(r.balance)}</td></tr>`).join('');
        return `
            <div class="panel collapsed" style="background:var(--surface-2); margin-bottom:8px;">
                <div class="panel-head" onclick="toggleCollapse(this)">
                    <span style="font-size:13px;"><span class="type-pill">Claim</span> <b>${c.claim_id}</b> · ${escHtml(c.damage_type)} · <span class="money">${formatMoney(bal)}</span> · <span class="status-badge status-${c.status}">${c.status}</span></span>
                    <span class="caret">&#9662;</span>
                </div>
                <div>
                    ${progressBarHtml(owed > 0 ? Math.round((paidSoFar / owed) * 100) : 0)}
                    <div class="form-row" style="margin:6px 0 4px;align-items:center;">
                        <div class="field"><label>${t('d_company')}</label><div>${c.company_name ? escHtml(c.company_name) : '—'}</div></div>
                        <div class="field"><label>${t('d_claimant_account')}</label><div>${c.claimant_account ? escHtml(c.claimant_account) : '—'}</div></div>
                        <div class="field"><label>${t('d_carrier_claim')}</label><div>${c.carrier_claim_number ? escHtml(c.carrier_claim_number) : '—'}</div></div>
                        <div class="field"><label>${t('d_customer_claim')}</label><div>${c.customer_claim_number ? escHtml(c.customer_claim_number) : '—'}</div></div>
                        <div class="field"><label>${t('d_weekly_rate')}</label><div>${formatMoney(rateOn(c, asOf))}</div></div>
                        <div class="field"><label>${t('d_weeks_to_zero')}</label><div>${weeks}</div></div>
                        <div class="field"><label>${t('d_ends')}</label><div>${endDate}</div></div>
                        <div class="field"><label>${t('d_paid_so_far')}</label><div class="money" style="color:#059669;">${formatMoney(paidSoFar)}</div></div>
                        <div class="field"><label>${t('d_balance')}</label><div class="money">${formatMoney(bal)}</div></div>
                    </div>
                    <button type="button" class="btn-small" style="background:var(--navy);margin:4px 0 0;" onclick="event.stopPropagation(); printClaimSchedule('${c.claim_id}')">${t('d_print_schedule')}</button>
                    ${sched.rows.length
                        ? `<div class="table-wrapper" style="max-height:340px;"><table style="font-size:12px;"><thead><tr><th style="text-align:left;">${t('d_th_date')}</th><th style="text-align:left;">${t('d_th_deducted')}</th><th style="text-align:left;">${t('d_th_running_balance')}</th></tr></thead><tbody>${scheduleRows}</tbody></table></div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Projected weekly from ${c.start_date || '—'} at the recorded rate(s), skipping recorded pauses, until $0.00.</div>`
                        : `<div style="font-size:12px;color:var(--text-muted);">${t('d_no_schedule_claim')}</div>`}
                </div>
            </div>`;
    }

    function statementChargePanelHtml(ch, asOf) {
        const sched = buildChargeSchedule(ch, null);
        const bal = chargeBalance(ch, asOf);
        const owed = Math.max(0, parseFloat(ch.amount) || 0);
        const paidSoFar = Math.max(0, +(owed - bal).toFixed(2));
        const weeks = sched.rows.filter(r => !r.paused).length;
        const endDate = sched.endDate || (ch.end_date || '-');
        const scheduleRows = sched.rows.map(r => `<tr><td>${r.date}</td><td>${r.paused ? '<em style="color:var(--text-muted);">paused</em>' : formatMoney(r.deducted)}</td><td>${formatMoney(r.balance)}</td></tr>`).join('');
        return `
            <div class="panel collapsed" style="background:var(--surface-2); margin-bottom:8px;">
                <div class="panel-head" onclick="toggleCollapse(this)">
                    <span style="font-size:13px;"><span class="type-pill">Charge</span> <b>${ch.charge_id}</b> · ${escHtml(ch.charge_type)} · <span class="money">${formatMoney(bal)}</span> · <span class="status-badge status-${ch.status}">${ch.status}</span></span>
                    <span class="caret">&#9662;</span>
                </div>
                <div>
                    ${progressBarHtml(owed > 0 ? Math.round((paidSoFar / owed) * 100) : 0)}
                    <div class="form-row" style="margin:6px 0 0;align-items:center;">
                        <div class="field"><label>${t('d_weekly_rate')}</label><div>${formatMoney(chargeRateOn(ch, asOf))}</div></div>
                        <div class="field"><label>${t('d_weeks')}</label><div>${weeks}</div></div>
                        <div class="field"><label>${t('d_ends')}</label><div>${endDate}</div></div>
                        <div class="field"><label>${t('d_paid_so_far')}</label><div class="money" style="color:#059669;">${formatMoney(paidSoFar)}</div></div>
                        <div class="field"><label>${t('d_balance')}</label><div class="money">${formatMoney(bal)}</div></div>
                        <div class="field"><label>${t('d_start')}</label><div>${ch.start_date || '-'}</div></div>
                    </div>
                    <button type="button" class="btn-small" style="background:var(--navy);margin:4px 0 0;" onclick="event.stopPropagation(); printChargeSchedule('${ch.charge_id}')">${t('d_print_schedule')}</button>
                    ${sched.rows.length
                        ? `<div class="table-wrapper" style="max-height:340px;"><table style="font-size:12px;"><thead><tr><th style="text-align:left;">${t('d_th_date')}</th><th style="text-align:left;">${t('d_th_deducted')}</th><th style="text-align:left;">${t('d_th_running_balance')}</th></tr></thead><tbody>${scheduleRows}</tbody></table></div><div style="font-size:11px;color:var(--text-muted);margin-top:4px;">Projected weekly from ${ch.start_date || '—'} at the recorded rate(s), skipping recorded pauses, until $0.00.</div>`
                        : `<div style="font-size:12px;color:var(--text-muted);">${t('d_no_schedule_charge')}</div>`}
                </div>
            </div>`;
    }

    function renderStatement() {
        const empId = document.getElementById('statement-emp-select').value;
        const container = document.getElementById('statement-content');
        const asOf = statementAsOf();
        updateStatementWeekLabel();
        renderStatementStats(empId, asOf);
        if (!empId) { container.innerHTML = `<div class="panel" style="text-align:center;color:var(--text-muted);">${t('d_select_emp_stmt')}</div>`; return; }

        const emp = employees.find(e => e.id === empId);
        const empClaims = claims.filter(c => c.employee_id === empId);
        const empCharges = charges.filter(ch => ch.employee_id === empId);
        const empIncome = additionalIncome.filter(i => i.employee_id === empId);

        let html = `
            <div class="panel">
                <h2>${escHtml(emp.first_name)} ${escHtml(emp.last_name)} — ${escHtml(emp.id)}</h2>
                <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${emp.person_type} · <span class="status-badge ${emp.status==='Active'?'status-active':'status-quit'}">${emp.status}</span>${emp.department ? ' · ' + escHtml(emp.department) : ''}</div>
            </div>
            <div class="panel">
                <h2>${t('d_current_deductions')}</h2>`;

        if(!empClaims.length && !empCharges.length) html += `<div style="text-align:center;color:var(--text-muted);padding:15px;">${t('d_no_current_cc')}</div>`;

        // Claims and charges share a status vocabulary and get grouped
        // together by status (Deducting people together, Queued together,
        // etc.) — income has its own separate vocabulary and section below,
        // deliberately never merged in with these two.
        const combined = [
            ...empClaims.map(c => ({ status: c.status, render: () => statementClaimPanelHtml(c, asOf) })),
            ...empCharges.map(ch => ({ status: ch.status, render: () => statementChargePanelHtml(ch, asOf) }))
        ];
        const STATUS_ORDER = ['Deducting', 'Queued', 'Paid', 'Absorbed', 'Tk from check'];
        const statusesPresent = [...new Set(combined.map(x => x.status))]
            .sort((a, b) => {
                const ia = STATUS_ORDER.indexOf(a), ib = STATUS_ORDER.indexOf(b);
                return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
            });
        statusesPresent.forEach(status => {
            const group = combined.filter(x => x.status === status);
            const collapsed = collapsedStatusGroups.statement.has(status);
            html += `<div class="detail-subhead" style="margin:12px 0 6px; cursor:pointer;" onclick="toggleStatusGroup('statement','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400; text-transform:none; letter-spacing:normal;">(${group.length})</span></div>`;
            if (collapsed) return;
            group.forEach(x => { html += x.render(); });
        });

        html += `</div>`;

        if (empIncome.length) {
            html += `<div class="panel"><h2>${t('d_add_income_breakdown')}</h2>`;
            empIncome.forEach(i => {
                const weeks = weeksNeeded(i.amount, i.weekly_amount);
                const rem = remainingBalanceAsOf(i.amount, i.weekly_amount, i.start_date, i.status, asOf);
                const paidSoFar = Math.max(0, +((parseFloat(i.amount) || 0) - rem).toFixed(2));
                const endDate = projectedEndDate(i.start_date, i.amount, i.weekly_amount) || '-';
                html += `
                    <div class="panel collapsed" style="background:var(--surface-2); margin-bottom:8px;">
                        <div class="panel-head" onclick="toggleCollapse(this)">
                            <span style="font-size:13px;"><span class="type-pill">Income</span> <b>${i.income_id}</b> · ${escHtml(i.income_type)} · <span class="money" style="color:#059669;">${formatMoney(rem)}</span> · <span class="status-badge status-${i.status}">${i.status}</span></span>
                            <span class="caret">&#9662;</span>
                        </div>
                        <div>
                            ${progressBarHtml((parseFloat(i.amount) || 0) > 0 ? Math.round((paidSoFar / parseFloat(i.amount)) * 100) : 0)}
                            <div class="form-row" style="margin:6px 0 0;align-items:center;">
                                <div class="field"><label>${t('d_weekly')}</label><div style="color:#059669;">+${formatMoney(i.weekly_amount)}</div></div>
                                <div class="field"><label>${t('d_weeks')}</label><div>${weeks}</div></div>
                                <div class="field"><label>${t('d_ends')}</label><div>${endDate}</div></div>
                                <div class="field"><label>${t('d_paid_so_far')}</label><div class="money" style="color:#059669;">${formatMoney(paidSoFar)}</div></div>
                                <div class="field"><label>${t('d_remaining')}</label><div class="money" style="color:#059669;">${formatMoney(rem)}</div></div>
                                <div class="field"><label>${t('d_start')}</label><div>${i.start_date || '-'}</div></div>
                            </div>
                        </div>
                    </div>`;
            });
            html += `</div>`;
        }

        container.innerHTML = html;
    }

    // --- PAYROLL ---------------------------------------------------------
    // Itemized weekly deductions for one employee — the individual claims and
    // charges (with this week's scheduled amount + remaining balance).
    // capAmount (optional) caps the TOTAL taken this week at that amount —
    // used to make sure a week's deductions can never exceed that week's
    // gross pay (so net pay can't go negative). Items are capped in order,
    // each item's `.weekly` becomes what's actually taken; `.scheduled` keeps
    // the original uncapped amount so the UI can show what was skipped and why.
    // NOTE: capping here only affects what's shown/paid THIS payroll week —
    // it does not rewrite the claim/charge's balance schedule (still a
    // calendar-based projection, unaware of actual weekly gross pay). If a
    // week is expected to have $0 gross pay in advance, pausing the claim
    // (Claims tab) for that week — same as already done here for 8/8–8/22 —
    // is the way to keep the balance schedule accurate too.
    function deductionBreakdown(empId, capAmount) {
        const asOf = payrollAsOf();
        const items = [];
        // Only Queued (never authorized to start) is excluded outright — a
        // claim/charge now Paid/Absorbed/Tk from check can still correctly
        // show a deduction for a past week before it was resolved, since
        // claimBalance/remainingBalanceAsOf above are now week-aware.
        // Inclusion + the actual weekly amount use the balance ENTERING the
        // week (claimBalanceBefore), not the balance after — otherwise a
        // claim/charge that gets fully paid off in one week shows $0 and
        // silently disappears for the very week its final payment happened.
        // A start_date guard is also required: before the item starts, its
        // balance function correctly reports "full amount, nothing paid
        // yet" — which is true, but was being misread as an active
        // deduction for every week before it even began.
        claims.filter(c => c.employee_id === empId && c.status !== 'Queued' && c.start_date && c.start_date <= asOf).forEach(c => {
            const balBefore = claimBalanceBefore(c, asOf);
            if (balBefore > 0 && !isPausedOn(c, asOf)) {
                const bal = claimBalance(c, asOf);
                const weekly = Math.min(rateOn(c, asOf), balBefore);
                items.push({ kind: 'Claim', id: c.claim_id, label: c.damage_type || 'Claim', company: c.company_name || '', claimant: c.claimant_account || '', carrier: c.carrier_claim_number || '', customer: c.customer_claim_number || '', weekly, scheduled: weekly, balance: bal, notes: c.notes || '' });
            }
        });
        charges.filter(ch => ch.employee_id === empId && ch.status !== 'Queued' && ch.start_date && ch.start_date <= asOf).forEach(ch => {
            const balBefore = chargeBalanceBefore(ch, asOf);
            if (balBefore > 0 && !isChargePausedOn(ch, asOf)) {
                const bal = chargeBalance(ch, asOf);
                const weekly = Math.min(chargeRateOn(ch, asOf), balBefore);
                items.push({ kind: 'Charge', id: ch.charge_id, label: ch.charge_type || 'Charge', weekly, scheduled: weekly, balance: bal, notes: ch.notes || '' });
            }
        });
        if (capAmount !== undefined && capAmount !== null) {
            let remaining = Math.max(0, capAmount);
            items.forEach(it => {
                const take = Math.min(it.weekly, remaining);
                it.weekly = +take.toFixed(2);
                remaining = +(remaining - take).toFixed(2);
            });
        }
        return items;
    }

    // Sum of weekly deductions for one employee from claims + charges that
    // are actively being deducted (status 'Deducting') and still have a
    // remaining balance. Pass capAmount (that week's gross pay) to make sure
    // deductions can never exceed what's actually being paid out.
    function activeWeeklyDeductions(empId, capAmount) {
        return deductionBreakdown(empId, capAmount).reduce((sum, it) => sum + it.weekly, 0);
    }

    // Individual routes that make up this week's route pay for a driver.
    function routeBreakdown(emp) {
        const wed = new Date(payrollSunday()); wed.setUTCDate(wed.getUTCDate() + 3);
        const repStr = ymd(wed);
        const thisWeek = getWeekNumber(repStr).toString();
        const thisYear = new Date(repStr + 'T00:00:00Z').getFullYear().toString();
        const fullName = `${emp.first_name} ${emp.last_name}`.trim().toLowerCase();
        return routes
            .filter(r => (r.driver || '').trim().toLowerCase() === fullName && r.week === thisWeek && r.year === thisYear)
            .map(r => ({ id: r.route_id || '', date: r.date || '', pay: parseFloat(r.final_pay) || 0 }))
            .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    }

    // Route pay for an employee in the current ISO week, matched by driver
    // name (routes store driver as free text, so we match on full name).
    function currentWeekRoutePay(emp) {
        // Representative date = Wednesday of the selected Payroll week, so the
        // lookup matches how routes store week/year (getWeekNumber of the date).
        const wed = new Date(payrollSunday()); wed.setUTCDate(wed.getUTCDate() + 3);
        const repStr = ymd(wed);
        const thisWeek = getWeekNumber(repStr).toString();
        const thisYear = new Date(repStr + 'T00:00:00Z').getFullYear().toString();
        const fullName = `${emp.first_name} ${emp.last_name}`.trim().toLowerCase();
        return routes
            .filter(r => (r.driver || '').trim().toLowerCase() === fullName && r.week === thisWeek && r.year === thisYear)
            .reduce((acc, r) => acc + (parseFloat(r.final_pay) || 0), 0);
    }

    // ====================================================================
    //  PAY TYPE (Weekly Salary vs Daily Rate)  +  DAILY PAY TIMESHEET
    // ====================================================================

    function getPayType(empId) {
        if (payTypes[empId] === 'Daily') return 'Daily';
        if (payTypes[empId] === 'Provider') return 'Provider';
        return 'Weekly';
    }

    // Load per-employee pay types from the cloud. Degrades gracefully if the
    // table hasn't been created yet (everyone defaults to Weekly).
    async function loadPayTypes() {
        dailyTableMissing = false; // re-check each full sync
        try {
            const { data, error } = await supabaseClient.rpc('get_employee_pay_type', { p_actor: currentUsername, p_company: currentCompany });
            if (error) { if (isMissingTable(error)) dailyTableMissing = true; return; }
            payTypes = {};
            (data || []).forEach(r => { payTypes[r.employee_id] = (r.pay_type === 'Daily' || r.pay_type === 'Provider') ? r.pay_type : 'Weekly'; });
        } catch (e) { console.error('loadPayTypes:', e); }
    }

    async function setPayType(empId, type, companyCode) {
        const previous = payTypes[empId];
        payTypes[empId] = type;               // optimistic local update
        try {
            const { error } = await supabaseClient.rpc('set_employee_pay_type', {
                p_actor: currentUsername, p_employee_id: empId, p_pay_type: type
            });
            if (error) {
                payTypes[empId] = previous;    // roll back — the save didn't actually happen
                if (isMissingTable(error)) { dailyTableMissing = true; alert('Daily-pay tables are not set up yet. See the yellow note in the Daily Pay tab.'); }
                else alert('Could not save pay type: ' + error.message);
                renderEmployees();
            }
        } catch (e) {
            payTypes[empId] = previous;
            console.error('setPayType:', e);
            renderEmployees();
        }
    }

    async function togglePayType(empId) {
        if (!canEdit()) return;
        const emp = employees.find(e => e.id === empId);
        if (!emp) return;
        const cur = getPayType(empId);
        const next = cur === 'Weekly' ? 'Daily' : cur === 'Daily' ? 'Provider' : 'Weekly';
        const nextLabel = next === 'Daily' ? 'Daily Rate' : next === 'Provider' ? 'Provider (variable)' : 'Weekly Salary';
        const co = requireWriteCompany();
        if (!co) return;
        if (!confirm(`Set ${emp.first_name} ${emp.last_name} to ${nextLabel}?`)) return;
        await setPayType(empId, next, co);
        renderEmployees();
        if (document.getElementById('tab-dailypay').classList.contains('active')) renderDailyPay();
        if (document.getElementById('tab-providerpay').classList.contains('active')) renderProviderPay();
    }

    function isMissingTable(error) {
        const m = ((error && (error.message || error.details || error.hint)) || '').toLowerCase();
        return m.includes('does not exist') || m.includes('could not find the table') || error.code === '42P01' || error.code === 'PGRST205';
    }

    // ---- Week math (Sun–Sat blocks) ------------------------------------
    function weekStartSunday(d) {
        const x = new Date(d);
        x.setUTCHours(0, 0, 0, 0);
        x.setUTCDate(x.getUTCDate() - x.getUTCDay()); // back up to Sunday
        return x;
    }
    function ymd(dt) { return dt.toISOString().split('T')[0]; }
    function weekKeyFromSunday(sun) {
        // Key the Sun–Sat block by the ISO week of its Wednesday (mid-week),
        // so a block always maps to one stable {year, week}.
        const wed = new Date(sun); wed.setUTCDate(wed.getUTCDate() + 3);
        return { year: getYear(ymd(wed)), week: getWeekNumber(ymd(wed)).toString() };
    }
    function weekDatesFromSunday(sun) {
        return Array.from({ length: 7 }, (_, i) => {
            const d = new Date(sun); d.setUTCDate(d.getUTCDate() + i); return d;
        });
    }
    // Reverse of weekKeyFromSunday — given {year, week} finds the Sunday
    // of that Sun-Sat block. Mirrors the exact same convention Daily Pay
    // already uses (a block's ISO week is read off its Wednesday), rather
    // than a generic ISO week formula, so results agree with the rest of
    // the app for the same (year, week) input. Verified by round-tripping
    // 160 consecutive real Sundays through weekKeyFromSunday and back
    // before shipping — matches for all of them except the very last ISO
    // week of December in some years, where getYear()'s use of the plain
    // calendar year (not the ISO week-year) already disagrees with
    // getWeekNumber() elsewhere in the app; not introduced here, and low-
    // impact for a 90/30-day eligibility gate.
    function sundayFromWeekKey(year, week) {
        const y = parseInt(year, 10), w = parseInt(week, 10);
        const jan4 = new Date(Date.UTC(y, 0, 4));
        const jan4Day = jan4.getUTCDay() || 7;
        const week1Monday = new Date(jan4);
        week1Monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1));
        const targetMonday = new Date(week1Monday);
        targetMonday.setUTCDate(week1Monday.getUTCDate() + (w - 1) * 7);
        const blockSunday = new Date(targetMonday);
        blockSunday.setUTCDate(targetMonday.getUTCDate() - 1);
        return blockSunday;
    }
    function fmtMD(dt) { return (dt.getUTCMonth() + 1) + '/' + dt.getUTCDate(); }
    function fmtWeekLabel(sun) {
        const dates = weekDatesFromSunday(sun);
        const k = weekKeyFromSunday(sun);
        return `Week ${k.week}, ${k.year} · ${fmtMD(dates[0])} – ${fmtMD(dates[6])}`;
    }

    // ===== PROVIDER PAY =====================================================
    // Same idea as Daily Pay, but for people whose pay isn't a flat rate and
    // doesn't break down by day either — one manually-entered amount per
    // week per provider. Feeds Payroll's base pay the same way Daily Pay does.
    let providerView = null;   // { sunday, year, week }
    let providerGrid = {};     // employee_id -> { amount, notes }

    function providerSunday() {
        if (!providerView) { const s = weekStartSunday(new Date()); s.setUTCDate(s.getUTCDate() - 7); providerView = { sunday: s }; } // defaults to LAST week, not this week
        return providerView.sunday;
    }
    function shiftProviderWeek(delta) {
        const s = new Date(providerSunday()); s.setUTCDate(s.getUTCDate() + delta * 7);
        providerView = { sunday: s };
        renderProviderPay();
    }
    function goToThisProviderWeek() {
        providerView = { sunday: weekStartSunday(new Date()) }; // explicit current week
        renderProviderPay();
    }

    async function loadProviderPayForWeek(year, week) {
        providerGrid = {};
        try {
            const { data, error } = await supabaseClient.rpc('get_provider_pay', { p_actor: currentUsername, p_company: currentCompany, p_year: year, p_week: week });
            if (error) { console.error('get_provider_pay:', error); return; }
            (data || []).forEach(r => { providerGrid[r.employee_id] = { amount: parseFloat(r.amount) || 0, notes: r.notes || '' }; });
        } catch (e) { console.error('loadProviderPayForWeek:', e); }
    }

    async function saveProviderCell(empId, amount, notes) {
        const sun = providerSunday();
        const k = weekKeyFromSunday(sun);
        try {
            const { error } = await supabaseClient.rpc('save_provider_pay', {
                p_actor: currentUsername, p_employee_id: empId, p_year: k.year, p_week: k.week,
                p_amount: amount, p_notes: notes
            });
            if (error) { alert('Error saving: ' + error.message); return; }
            flashSaved('providerpay-saveflash');
            // Keep Payroll's current-week cache in sync when editing this week
            const thisWeek = weekKeyFromSunday(weekStartSunday(new Date()));
            if (providerView.year === thisWeek.year && providerView.week === thisWeek.week) {
                await loadCurrentWeekProvider();
            }
        } catch (e) { console.error('saveProviderCell:', e); }
    }

    function onProviderAmountChange(empId, rawValue) {
        const amount = parseFloat(rawValue) || 0;
        const existing = providerGrid[empId] || { notes: '' };
        providerGrid[empId] = { amount, notes: existing.notes };
        saveProviderCell(empId, amount, existing.notes);
    }
    function onProviderNotesChange(empId, rawValue) {
        const existing = providerGrid[empId] || { amount: 0 };
        providerGrid[empId] = { amount: existing.amount, notes: rawValue };
        saveProviderCell(empId, existing.amount, rawValue);
    }

    // ===== Provider Pay <-> Bills Payable linkage =========================
    // A provider is an employee (pay type "Provider"); their bills are the
    // Bills Payable whose vendor name matches that provider's name. From a
    // provider's card you can tick several of their unpaid bills and pay them
    // in one action: each selected bill is marked Paid and its total is added
    // into this week's provider pay amount.
    function providerBillsForEmployee(emp) {
        const full = normalizeNameForMatch(`${emp.first_name || ''} ${emp.last_name || ''}`);
        const first = normalizeNameForMatch(emp.first_name || '');
        return (bills || []).filter(b => {
            if (b.status !== 'Unpaid') return false;
            const v = normalizeNameForMatch(b.vendor_name || '');
            return v && (v === full || (first && v === first));
        });
    }

    function providerBillsSectionHtml(emp, editable) {
        const list = providerBillsForEmployee(emp);
        if (!list.length) return '';
        const total = list.reduce((a, b) => a + (parseFloat(b.amount) || 0), 0);
        const rows = list.map(b => `
            <label style="display:flex; align-items:center; gap:8px; font-size:12px; padding:3px 0;">
                <input type="checkbox" class="prov-bill-cb" data-emp="${escHtml(emp.id)}" data-bill="${escHtml(b.bill_id)}" ${editable ? '' : 'disabled'} style="width:auto; min-height:0; margin:0;">
                <span style="flex:1; min-width:0;">${b.bill_number ? '#' + escHtml(b.bill_number) : escHtml(b.bill_id)}${b.due_date ? ' · due ' + b.due_date : ''}</span>
                <span style="font-family:var(--mono); white-space:nowrap;">${formatMoney(b.amount)}</span>
            </label>`).join('');
        return `
            <div style="flex:1 1 100%; border-top:1px solid var(--border); margin-top:6px; padding-top:8px;">
                <div style="font-size:11px; font-weight:700; color:var(--text-muted); margin-bottom:4px;">Unpaid bills for this provider (${list.length}) · ${formatMoney(total)}</div>
                ${rows}
                ${editable ? `<button type="button" class="btn-small" style="margin-top:8px; background:var(--primary);" onclick="payProviderSelectedBills('${escJsAttr(emp.id)}')">✓ Pay selected — mark Paid &amp; add to this week</button>` : ''}
            </div>`;
    }

    async function payProviderSelectedBills(empId) {
        if (!canEdit()) return;
        const checked = [...document.querySelectorAll(`.prov-bill-cb[data-emp="${CSS.escape(empId)}"]:checked`)];
        if (!checked.length) { alert('Tick at least one bill to pay.'); return; }
        const ids = checked.map(cb => cb.getAttribute('data-bill'));
        const selected = (bills || []).filter(b => ids.includes(b.bill_id));
        const sum = selected.reduce((a, b) => a + (parseFloat(b.amount) || 0), 0);
        if (!confirm(`Mark ${selected.length} bill(s) as Paid (${formatMoney(sum)}) and add that to this week's provider pay?`)) return;
        for (const b of selected) {
            const { error } = await supabaseClient.rpc('update_bill', {
                p_actor: currentUsername, p_id: b.bill_id, p_vendor_name: b.vendor_name,
                p_bill_number: b.bill_number, p_bill_date: b.bill_date, p_due_date: b.due_date,
                p_amount: b.amount, p_status: 'Paid', p_notes: b.notes
            });
            if (error) { alert('Error paying bill ' + (b.bill_number || b.bill_id) + ': ' + error.message); return; }
        }
        const existing = providerGrid[empId] || { amount: 0, notes: '' };
        const newAmount = (parseFloat(existing.amount) || 0) + sum;
        const refs = selected.map(b => b.bill_number || b.bill_id).join(', ');
        const newNotes = existing.notes ? `${existing.notes}; bills ${refs}` : `Bills: ${refs}`;
        providerGrid[empId] = { amount: newAmount, notes: newNotes };
        await saveProviderCell(empId, newAmount, newNotes);
        await fetchBillsFromCloud();   // paid bills drop out of the provider's list
        renderProviderPay();
    }

    async function renderProviderPay() {
        if (!providerView) { const s0 = weekStartSunday(new Date()); s0.setUTCDate(s0.getUTCDate() - 7); providerView = { sunday: s0 }; }
        const sun = providerView.sunday;
        const k = weekKeyFromSunday(sun);
        providerView.year = k.year; providerView.week = k.week;
        document.getElementById('providerpay-week-label').textContent = fmtWeekLabel(sun);

        const statusFilter = document.getElementById('providerpay-status-filter') ? document.getElementById('providerpay-status-filter').value : 'Active';
        const query = (document.getElementById('providerpay-search')?.value || '').toLowerCase();
        const providerEmps = employees
            .filter(e => getPayType(e.id) === 'Provider')
            .filter(e => {
                if (statusFilter && e.status !== statusFilter) return false;
                if (query) {
                    const hay = `${e.id} ${e.first_name} ${e.last_name}`.toLowerCase();
                    if (!hay.includes(query)) return false;
                }
                return true;
            })
            .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, undefined, { sensitivity: 'base' }));

        await loadProviderPayForWeek(k.year, k.week);

        const cardsWrap = document.getElementById('providerpay-cards');
        if (!providerEmps.length) {
            cardsWrap.innerHTML = `<div style="text-align:center; padding:1.5rem; color:var(--text-muted);">${t('d_no_provider_set')}</div>`;
            return;
        }

        const editable = canEdit();
        let grand = 0;
        const rows = providerEmps.map(emp => {
            const cell = providerGrid[emp.id] || { amount: 0, notes: '' };
            grand += cell.amount;
            const provBillsHtml = providerBillsSectionHtml(emp, editable);
            return `
                <div class="rec-card" style="margin-bottom:8px;">
                    <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:flex-end; padding:12px 14px;">
                        <div style="flex:1 1 220px;">
                            <div style="font-weight:700;">${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</div>
                            <div class="id-cell" style="font-size:11px; color:var(--text-muted);">${emp.id}</div>
                        </div>
                        <div style="flex:0 0 140px;">
                            <label style="font-size:10px;">${t('d_amount_this_week')}</label>
                            <input type="number" min="0" step="0.01" inputmode="decimal" value="${cell.amount || ''}" placeholder="0.00"
                                ${editable ? '' : 'disabled'} onchange="onProviderAmountChange('${emp.id}', this.value)">
                        </div>
                        <div style="flex:1 1 220px;">
                            <label style="font-size:10px;">${t('d_notes_optional')}</label>
                            <input type="text" value="${escHtml(cell.notes || '')}" placeholder="${t('d_provider_notes_ph')}"
                                ${editable ? '' : 'disabled'} onchange="onProviderNotesChange('${emp.id}', this.value)">
                        </div>
                        ${provBillsHtml}
                    </div>
                </div>`;
        }).join('');
        cardsWrap.innerHTML = rows + `<div style="text-align:right; font-weight:700; padding:10px 4px 0;">${t('d_total_this_week')}: ${formatMoney(grand)}</div>`;
    }

    // Loaded alongside Daily Pay's own current-week cache, same reasoning
    // (Payroll's base pay for Provider people reads from here). Kept
    // separate from providerGrid on purpose — providerGrid reflects
    // whichever week the Provider Pay TAB itself is currently viewing,
    // which is a totally different week selector than Payroll's own.
    let currentWeekProvider = {};       // employee_id -> number
    let currentWeekProviderNotes = {};  // employee_id -> string
    async function loadCurrentWeekProvider() {
        const sun = payrollSunday();
        const k = weekKeyFromSunday(sun);
        try {
            const { data, error } = await supabaseClient.rpc('get_provider_pay', { p_actor: currentUsername, p_company: currentCompany, p_year: k.year, p_week: k.week });
            if (error) { console.error('get_provider_pay (payroll):', error); currentWeekProvider = {}; currentWeekProviderNotes = {}; return; }
            const totals = {}, notes = {};
            (data || []).forEach(r => { totals[r.employee_id] = parseFloat(r.amount) || 0; notes[r.employee_id] = r.notes || ''; });
            currentWeekProvider = totals;
            currentWeekProviderNotes = notes;
        } catch (e) { console.error('loadCurrentWeekProvider:', e); currentWeekProvider = {}; currentWeekProviderNotes = {}; }
    }

    // ---- Payroll week selector (drives historical payroll) --------------
    function payrollSunday() {
        if (!payrollView) { const s = weekStartSunday(new Date()); s.setUTCDate(s.getUTCDate() - 7); payrollView = { sunday: s }; } // defaults to LAST week, not this week
        return payrollView.sunday;
    }
    function payrollWeekKey() { return weekKeyFromSunday(payrollSunday()); }
    function payrollAsOf() { // Saturday of the selected week — the point balances are evaluated at
        const sat = new Date(payrollSunday()); sat.setUTCDate(sat.getUTCDate() + 6); return ymd(sat);
    }
    function shiftPayrollWeek(delta) {
        const s = new Date(payrollSunday()); s.setUTCDate(s.getUTCDate() + delta * 7);
        payrollView = { sunday: s };
        renderPayroll();
    }
    function goToThisPayrollWeek() { payrollView = { sunday: weekStartSunday(new Date()) }; renderPayroll(); }

    // ---- Statement week selector (drives the "as of" date) --------------
    function statementSunday() {
        if (!statementView) { const s = weekStartSunday(new Date()); s.setUTCDate(s.getUTCDate() - 7); statementView = { sunday: s }; } // defaults to LAST week, not this week
        return statementView.sunday;
    }
    function statementAsOf() { // Saturday of the selected week — the only point balances are ever evaluated at, no other date logic
        const sat = new Date(statementSunday()); sat.setUTCDate(sat.getUTCDate() + 6); return ymd(sat);
    }
    function updateStatementWeekLabel(asOf) {
        const lbl = document.getElementById('statement-week-label');
        if (!lbl) return;
        lbl.textContent = fmtWeekLabel(statementSunday());
    }
    function shiftStatementWeek(delta) {
        const s = new Date(statementSunday()); s.setUTCDate(s.getUTCDate() + delta * 7);
        statementView = { sunday: s };
        renderStatement();
    }
    function goToThisStatementWeek() {
        statementView = { sunday: weekStartSunday(new Date()) };
        renderStatement();
    }

    // ---- Current-week daily totals (for Payroll) -----------------------
    async function loadCurrentWeekDaily() {
        const sun = payrollSunday();   // selected Payroll week (defaults to current week)
        const weekDates = weekDatesFromSunday(sun);
        currentWeekLabel = fmtWeekLabel(sun);
        if (dailyTableMissing) { currentWeekDaily = {}; currentWeekDailyDetail = {}; return; }
        const k = weekKeyFromSunday(sun);
        const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        try {
            const { data, error } = await supabaseClient.rpc('get_daily_pay', {
                p_actor: currentUsername, p_company: currentCompany, p_year: k.year, p_week: k.week
            });
            if (error) { if (isMissingTable(error)) dailyTableMissing = true; return; }
            // Build into fresh local objects rather than mutating the shared
            // module-level ones directly. If this function gets called again
            // (e.g. renderPayroll() re-firing on a filter change) before this
            // call's query resolves, each call resetting-then-awaiting the
            // *same* shared object let both calls' rows land in it together,
            // silently doubling every day's entry. Swapping the shared
            // variables in only once, atomically, after this call's own data
            // is fully processed makes that interleaving impossible — the
            // call that finishes last simply wins with a clean result.
            const totals = {};
            const detail = {};
            (data || []).forEach(r => {
                const di = parseInt(r.day_index, 10) || 0;
                (detail[r.employee_id] = detail[r.employee_id] || []).push({
                    day_index: di,
                    label: `${dayName[di]} ${weekDates[di] ? fmtMD(weekDates[di]) : ''}`.trim(),
                    amount: parseFloat(r.amount) || 0,
                    is_off: !!r.is_off
                });
                if (r.is_off) return;
                totals[r.employee_id] = (totals[r.employee_id] || 0) + (parseFloat(r.amount) || 0);
            });
            // keep each employee's days in Sun→Sat order
            Object.values(detail).forEach(arr => arr.sort((a, b) => a.day_index - b.day_index));
            currentWeekDaily = totals;
            currentWeekDailyDetail = detail;
        } catch (e) { console.error('loadCurrentWeekDaily:', e); }
    }

    // ---- Daily Pay tab -------------------------------------------------
    function goToThisPayWeek() {
        dailyView = { sunday: weekStartSunday(new Date()) }; // explicit current week — distinct from the initial-load default below
        renderDailyPay();
    }
    function shiftPayWeek(deltaWeeks) {
        if (!dailyView) { const s0 = weekStartSunday(new Date()); s0.setUTCDate(s0.getUTCDate() - 7); dailyView = { sunday: s0 }; } // defaults to LAST week, not this week
        const s = new Date(dailyView.sunday);
        s.setUTCDate(s.getUTCDate() + deltaWeeks * 7);
        dailyView = { sunday: s };
        renderDailyPay();
    }
    function toggleDailyCard(empId) {
        const card = document.getElementById('dpcard-' + empId);
        if (!card) return;
        card.classList.toggle('collapsed');
        const nowOpen = !card.classList.contains('collapsed');
        if (nowOpen) dailyExpanded.add(empId); else dailyExpanded.delete(empId);
        const caret = card.querySelector('.dp-caret');
        if (caret) caret.textContent = nowOpen ? '▾' : '▸';
    }

    async function renderDailyPay() {
        if (!dailyView) { const s0 = weekStartSunday(new Date()); s0.setUTCDate(s0.getUTCDate() - 7); dailyView = { sunday: s0 }; } // defaults to LAST week, not this week
        const sun = dailyView.sunday;
        const k = weekKeyFromSunday(sun);
        dailyView.year = k.year; dailyView.week = k.week;

        // Header dates + week label
        document.getElementById('dailypay-week-label').textContent = fmtWeekLabel(sun);
        const dates = weekDatesFromSunday(sun);

        const setup = document.getElementById('dailypay-setup');
        const cardsWrap = document.getElementById('dailypay-cards');

        // Which employees use Daily Rate? (further narrowed by the Person
        // type / Status / Search filters above, same pattern as Payroll)
        const typeFilter = document.getElementById('dailypay-type-filter')?.value || '';
        const statusFilter = document.getElementById('dailypay-status-filter') ? document.getElementById('dailypay-status-filter').value : 'Active';
        const query = (document.getElementById('dailypay-search')?.value || '').toLowerCase();
        const dailyEmps = employees
            .filter(e => getPayType(e.id) === 'Daily')
            .filter(e => {
                if (typeFilter && e.person_type !== typeFilter) return false;
                if (statusFilter && e.status !== statusFilter) return false;
                if (query) {
                    const hay = `${e.id} ${e.first_name} ${e.last_name}`.toLowerCase();
                    if (!hay.includes(query)) return false;
                }
                return true;
            })
            .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, undefined, { sensitivity: 'base' }));

        // Load this week's saved entries
        await loadDailyPayForWeek(k.year, k.week);

        if (dailyTableMissing) {
            setup.style.display = 'block';
            setup.className = 'setup-banner';
            setup.innerHTML = t('d_dp_setup');
        } else {
            setup.style.display = 'none';
        }

        if (!dailyEmps.length) {
            cardsWrap.innerHTML = `<div style="grid-column:1/-1; text-align:center; padding:1.5rem; color:var(--text-muted);">${t('d_no_daily_set')}</div>`;
            return;
        }

        const editable = canEdit();

        // One day's amount input + OFF toggle.
        const cellInner = (emp, i, cell) => {
            const off = !!cell.is_off;
            const val = (cell.amount === 0 || cell.amount === null || cell.amount === undefined) ? '' : cell.amount;
            return `<input class="day-input" type="number" min="0" step="0.01" inputmode="decimal"
                        id="dp-${emp.id}-${i}" value="${off ? '' : val}" placeholder="0"
                        ${off || !editable ? 'disabled' : ''}
                        onchange="onDailyInput('${emp.id}', ${i}, this.value)">
                    ${editable ? `<button class="off-btn ${off ? 'is-off' : ''}" id="dpoff-${emp.id}-${i}" onclick="toggleDailyOff('${emp.id}', ${i})">${off ? 'OFF' : 'off'}</button>` : (off ? '<div class="off-btn is-off">OFF</div>' : '')}`;
        };

        // Pre-compute each row's total once, shared by both the desktop
        // table and the mobile card layout below.
        let grand = 0;
        const rowTotals = {};
        dailyEmps.forEach(emp => {
            const row = dailyGrid[emp.id] || {};
            let rowTotal = 0;
            for (let i = 0; i < 7; i++) { const c = row[i]; if (c && !c.is_off) rowTotal += parseFloat(c.amount) || 0; }
            rowTotals[emp.id] = rowTotal;
            grand += rowTotal;
        });

        if (isDesktopView()) {
            cardsWrap.className = '';
            let rows = '';
            dailyEmps.forEach(emp => {
                const row = dailyGrid[emp.id] || {};
                let dayCells = '';
                for (let i = 0; i < 7; i++) {
                    const cell = row[i] || { amount: 0, is_off: false };
                    dayCells += `<td><div class="dp-day-label">${DAY_LABELS[i]} ${fmtMD(dates[i])}</div>${cellInner(emp, i, cell)}</td>`;
                }
                rows += `<tr>
                    <td class="id-cell">${emp.id}</td>
                    <td>${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</td>
                    ${dayCells}
                    <td style="font-weight:700;">Week: <span id="dp-total-${emp.id}">${formatMoney(rowTotals[emp.id])}</span></td>
                </tr>`;
            });
            cardsWrap.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th>${t('d_th_id')}</th><th>${t('d_th_name')}</th>${DAY_LABELS.map((d, i) => `<th>${d} ${fmtMD(dates[i])}</th>`).join('')}<th>${t('d_week_total')}</th>
            </tr></thead><tbody>${rows}</tbody></table></div>
            <div class="dp-grand">Total (${dailyEmps.length}): <span id="dailypay-grand">${formatMoney(grand)}</span></div>`;
            return;
        }

        cardsWrap.className = 'dp-grid';
        cardsWrap.innerHTML = '';
        dailyEmps.forEach(emp => {
            const row = dailyGrid[emp.id] || {};
            let days = '';
            for (let i = 0; i < 7; i++) {
                const cell = row[i] || { amount: 0, is_off: false };
                days += `<div class="dp-day"><div class="dp-day-label">${DAY_LABELS[i]} ${fmtMD(dates[i])}</div>${cellInner(emp, i, cell)}</div>`;
            }
            const dOpen = dailyExpanded.has(emp.id);
            cardsWrap.insertAdjacentHTML('beforeend', `
                <div class="dp-card${dOpen ? '' : ' collapsed'}" id="dpcard-${emp.id}">
                    <div class="dp-card-head" onclick="toggleDailyCard('${emp.id}')">
                        <span class="dp-caret">${dOpen ? '▾' : '▸'}</span>
                        <span class="dp-name">${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</span>
                        <span class="dp-id">${emp.id}</span>
                        <span class="dp-total">Week: <span id="dp-total-${emp.id}">${formatMoney(rowTotals[emp.id])}</span></span>
                    </div>
                    <div class="dp-days">${days}</div>
                </div>`);
        });

        cardsWrap.insertAdjacentHTML('beforeend', `<div class="dp-grand">Total (${dailyEmps.length}): <span id="dailypay-grand">${formatMoney(grand)}</span></div>`);
    }

    async function loadDailyPayForWeek(year, week) {
        dailyGrid = {};
        if (dailyTableMissing) return;
        try {
            const { data, error } = await supabaseClient.rpc('get_daily_pay', {
                p_actor: currentUsername, p_company: currentCompany, p_year: year, p_week: week
            });
            if (error) { if (isMissingTable(error)) dailyTableMissing = true; return; }
            (data || []).forEach(r => {
                if (!dailyGrid[r.employee_id]) dailyGrid[r.employee_id] = {};
                dailyGrid[r.employee_id][r.day_index] = { amount: parseFloat(r.amount) || 0, is_off: !!r.is_off };
            });
        } catch (e) { console.error('loadDailyPayForWeek:', e); }
    }

    function onDailyInput(empId, dayIndex, rawValue) {
        const amount = parseFloat(rawValue) || 0;
        if (!dailyGrid[empId]) dailyGrid[empId] = {};
        const existing = dailyGrid[empId][dayIndex] || { is_off: false };
        dailyGrid[empId][dayIndex] = { amount, is_off: existing.is_off };
        recomputeDailyTotals();
        saveDailyCell(empId, dayIndex, amount, dailyGrid[empId][dayIndex].is_off);
    }

    function toggleDailyOff(empId, dayIndex) {
        if (!canEdit()) return;
        if (!dailyGrid[empId]) dailyGrid[empId] = {};
        const existing = dailyGrid[empId][dayIndex] || { amount: 0, is_off: false };
        const nowOff = !existing.is_off;
        const amount = nowOff ? 0 : (parseFloat(existing.amount) || 0);
        dailyGrid[empId][dayIndex] = { amount, is_off: nowOff };
        // Update the input + button in place (no full re-render, to avoid a
        // cloud reload overwriting this change before the debounced save lands)
        const input = document.getElementById(`dp-${empId}-${dayIndex}`);
        if (input) { input.disabled = nowOff; input.value = nowOff ? '' : (amount || ''); }
        const btn = document.getElementById(`dpoff-${empId}-${dayIndex}`);
        if (btn) { btn.classList.toggle('is-off', nowOff); btn.textContent = nowOff ? 'OFF' : 'off'; }
        recomputeDailyTotals();
        saveDailyCell(empId, dayIndex, amount, nowOff);
    }

    function recomputeDailyTotals() {
        Object.keys(dailyGrid).forEach(empId => {
            const el = document.getElementById(`dp-total-${empId}`);
            if (!el) return;
            let t = 0;
            const row = dailyGrid[empId];
            for (let i = 0; i < 7; i++) { const c = row[i]; if (c && !c.is_off) t += parseFloat(c.amount) || 0; }
            el.textContent = formatMoney(t);
        });
        // Grand total footer (sum only Daily-type employees shown)
        const gEl = document.getElementById('dailypay-grand');
        if (gEl) {
            let g = 0;
            employees.filter(e => getPayType(e.id) === 'Daily').forEach(emp => {
                const row = dailyGrid[emp.id]; if (!row) return;
                for (let i = 0; i < 7; i++) { const c = row[i]; if (c && !c.is_off) g += parseFloat(c.amount) || 0; }
            });
            gEl.textContent = formatMoney(g);
        }
    }

    let _dailySaveTimers = {};
    // Swap between the mobile card layout and the desktop grid if the viewport
    // crosses the phone breakpoint (e.g. rotating the device).
    try {
        window.matchMedia('(max-width: 599px)').addEventListener('change', () => {
            const t = document.getElementById('tab-dailypay');
            if (t && t.classList.contains('active')) renderDailyPay();
        });
    } catch (e) { /* older browsers: ignore */ }
    function saveDailyCell(empId, dayIndex, amount, isOff) {
        if (dailyTableMissing) return;
        const key = `${empId}-${dayIndex}`;
        clearTimeout(_dailySaveTimers[key]);
        _dailySaveTimers[key] = setTimeout(async () => {
            try {
                const { error } = await supabaseClient.rpc('save_daily_pay', {
                    p_actor: currentUsername, p_employee_id: empId,
                    p_year: dailyView.year, p_week: dailyView.week, p_day_index: dayIndex,
                    p_amount: amount, p_is_off: isOff
                });
                if (error) {
                    if (isMissingTable(error)) { dailyTableMissing = true; renderDailyPay(); }
                    else { console.error('saveDailyCell:', error); alert('Could not save: ' + error.message); }
                    return;
                }
                flashSaved();
                // Keep Payroll's current-week cache in sync when editing this week
                const thisWeek = weekKeyFromSunday(weekStartSunday(new Date()));
                if (dailyView.year === thisWeek.year && dailyView.week === thisWeek.week) {
                    await loadCurrentWeekDaily();
                }
            } catch (e) { console.error('saveDailyCell:', e); }
        }, 500);
    }

    function flashSaved(elId) {
        const el = document.getElementById(elId || 'dailypay-saveflash');
        if (!el) return;
        el.classList.add('show');
        clearTimeout(el._t);
        el._t = setTimeout(() => el.classList.remove('show'), 1200);
    }

    // ---- Print: one employee's payroll for the selected week ------------
    function printPayrollForEmployee(empId) {
        const emp = employees.find(e => e.id === empId);
        if (!emp) return;
        const payType = getPayType(emp.id);
        const base = payType === 'Daily' ? (currentWeekDaily[emp.id] || 0) : payType === 'Provider' ? (currentWeekProvider[emp.id] || 0) : (parseFloat(emp.pay_rate) || 0);
        const routePay = currentWeekRoutePay(emp);
        const income = activeWeeklyIncome(emp.id);
        const gross = base + routePay + income;
        const ded = activeWeeklyDeductions(emp.id, gross);
        const net = gross - ded;
        const detail = payrollDetailHtml(emp, payType, base, routePay, ded, income);
        document.getElementById('print-area').innerHTML = `
            <h1>Payroll — ${escHtml(emp.first_name)} ${escHtml(emp.last_name)} (${emp.id})</h1>
            <div class="print-meta">Week of ${fmtWeekLabel(payrollSunday())} · Printed ${new Date().toLocaleDateString()}</div>
            <table><tbody>
                <tr><td>Base pay</td><td>${formatMoney(base)}</td></tr>
                <tr><td>Route pay</td><td>${formatMoney(routePay)}</td></tr>
                <tr><td>Additional income</td><td>${formatMoney(income)}</td></tr>
                <tr class="print-totals"><td>Gross pay</td><td>${formatMoney(gross)}</td></tr>
                <tr><td>Deductions</td><td>−${formatMoney(ded)}</td></tr>
                <tr class="print-totals"><td>Net pay</td><td>${formatMoney(net)}</td></tr>
            </tbody></table>
            ${detail}
        `;
        attemptPrint();
    }

    // Prints everyone currently shown in Payroll (same filters/sort already
    // on screen) whose net pay for the selected week is above zero — each
    // person gets their own page, formatted exactly like printing that one
    // person individually (same header style, own page break), rather than
    // one combined document with a single summary header up top.
    function printAllPayroll() {
        const qualifying = lastPayrollCalc.filter(c => c.net > 0);
        if (!qualifying.length) { alert('No one in the current view has a net amount to pay for this week.'); return; }
        const weekLabel = fmtWeekLabel(payrollSunday());
        const printedDate = new Date().toLocaleDateString();
        const sections = qualifying.map((c, idx) => {
            const detail = payrollDetailHtml(c.emp, c.payType, c.base, c.routePay, c.ded, c.income);
            return `
                <div style="${idx > 0 ? 'page-break-before:always;' : ''}">
                    <h1>Payroll — ${escHtml(c.emp.first_name)} ${escHtml(c.emp.last_name)} (${c.emp.id})</h1>
                    <div class="print-meta">Week of ${weekLabel} · Printed ${printedDate}</div>
                    <table><tbody>
                        <tr><td>Base pay</td><td>${formatMoney(c.base)}</td></tr>
                        <tr><td>Route pay</td><td>${formatMoney(c.routePay)}</td></tr>
                        <tr><td>Additional income</td><td>${formatMoney(c.income)}</td></tr>
                        <tr class="print-totals"><td>Gross pay</td><td>${formatMoney(c.gross)}</td></tr>
                        <tr><td>Deductions</td><td>−${formatMoney(c.ded)}</td></tr>
                        <tr class="print-totals"><td>Net pay</td><td>${formatMoney(c.net)}</td></tr>
                    </tbody></table>
                    ${detail}
                </div>`;
        }).join('');
        document.getElementById('print-area').innerHTML = sections;
        attemptPrint();
    }

    // ===== MESSAGES — direct messaging, per-item threads ==================
    // A 1:1 chat between app_user accounts. Conversations are split by topic
    // AND by the specific item they're about: General (no item), a specific
    // Claim / Charge / Income record, or a Missing-Day date. Each (person +
    // topic + item) is its own independent thread. Server enforces who may
    // message whom (dm_* RPCs): company-scoped, Super Admin spans all, and a
    // View Only user can message managers/Super Admin but not another View
    // Only user. "Live" via polling.
    const DM_TOPICS = ['General', 'Missing Day', 'Claims', 'Charges', 'Income'];
    const DM_TOPIC_PILL = {
        'General': 'background:#eef2f1;color:#0b1f1c;',
        'Missing Day': 'background:#fef3c7;color:#92400e;',
        'Claims': 'background:#e0f2fe;color:#075985;',
        'Charges': 'background:#fee2e2;color:#991b1b;',
        'Income': 'background:#dcfce7;color:#166534;'
    };
    let dmThreads = [];           // existing (person, topic, ref) threads
    let dmContacts = [];          // people the user may message (for the "+ New" picker)
    let dmActiveUser = null, dmActiveTopic = null, dmActiveRef = null;  // open thread
    let dmThreadMsgs = [];
    let dmTopicFilter = '';
    let dmThreadsSnap = '';
    let dmMsgsSnap = '';
    let dmRenderedKey = null;
    let dmPollTimer = null;

    function dmThreadLabel(t) { return (t.other_employee_name && t.other_employee_name.trim()) ? t.other_employee_name : t.other_username; }
    function dmContactLabel(c) { return (c.employee_name && c.employee_name.trim()) ? c.employee_name : c.username; }
    function dmRoleLabel(role) { return role === 'User' ? 'View Only' : role; }
    function dmTopicBadge(topic) { return `<span class="type-pill" style="${DM_TOPIC_PILL[topic] || ''} font-size:9px; padding:1px 6px;">${escHtml(topic)}</span>`; }
    function dmThreadKey(user, topic, ref) { return `${user}|${topic}|${ref || ''}`; }

    // The employee whose records a conversation is about. A conversation that
    // involves a View Only user is ALWAYS about that person's records, whoever
    // opened it: a View Only user only ever discusses their own, and a manager
    // messaging them is discussing that person's records, not their own.
    // Manager-to-manager keeps the older behaviour (the other party's records
    // if they are an employee, otherwise mine).
    function dmConversationEmpId(otherUsername) {
        if (isViewOnly()) return myEmployeeId();
        const c = dmContacts.find(x => x.username === otherUsername);
        if (c && c.role === 'User' && c.employee_id) return c.employee_id;
        if (c && c.employee_id) return c.employee_id;
        return (currentUser && currentUser.employee_id) || null;
    }
    // Records of a given topic for one employee, as {id, label}.
    function dmRecordsFor(topic, empId) {
        if (!empId) return [];
        if (topic === 'Claims') return (claims || []).filter(c => c.employee_id === empId).map(c => ({ id: c.claim_id, label: `${c.claim_id}${c.damage_type ? ' · ' + c.damage_type : ''}` }));
        if (topic === 'Charges') return (charges || []).filter(c => c.employee_id === empId).map(c => ({ id: c.charge_id, label: `${c.charge_id}${c.charge_type ? ' · ' + c.charge_type : ''}` }));
        if (topic === 'Income') return (additionalIncome || []).filter(i => i.employee_id === empId).map(i => ({ id: i.income_id, label: `${i.income_id}${i.income_type ? ' · ' + i.income_type : ''}` }));
        return [];
    }
    // Short label for the item a thread is about (topic badge shows the topic).
    function dmRefLabel(topic, ref) {
        if (!ref) return '';
        if (topic === 'Missing Day') return ref;
        if (topic === 'Claims') { const c = (claims || []).find(x => x.claim_id === ref); return c && c.damage_type ? `${ref} · ${c.damage_type}` : ref; }
        if (topic === 'Charges') { const c = (charges || []).find(x => x.charge_id === ref); return c && c.charge_type ? `${ref} · ${c.charge_type}` : ref; }
        if (topic === 'Income') { const i = (additionalIncome || []).find(x => x.income_id === ref); return i && i.income_type ? `${ref} · ${i.income_type}` : ref; }
        return ref;
    }

    function fmtMsgTime(iso) {
        const d = new Date(iso), now = new Date();
        return d.toDateString() === now.toDateString()
            ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    function refreshDmBadge() {
        const badge = document.getElementById('msg-badge');
        if (!badge) return;
        const total = dmThreads.reduce((n, t) => n + (parseInt(t.unread, 10) || 0), 0);
        if (total > 0) { badge.textContent = total > 99 ? '99+' : String(total); badge.style.display = 'inline-block'; }
        else { badge.style.display = 'none'; }
    }

    async function fetchDmThreads() {
        if (!currentUsername) { dmThreads = []; return false; }
        const { data, error } = await supabaseClient.rpc('dm_threads', { p_actor: currentUsername });
        if (error) { console.error('dm_threads:', error); return false; }
        dmThreads = data || [];
        refreshDmBadge();
        const snap = dmThreads.map(t => `${t.other_username}|${t.topic}|${t.ref_id || ''}:${t.unread}:${t.last_at || ''}`).join('~');
        const changed = snap !== dmThreadsSnap;
        dmThreadsSnap = snap;
        return changed;
    }

    async function fetchDmContacts() {
        if (!currentUsername) { dmContacts = []; return; }
        const { data, error } = await supabaseClient.rpc('dm_contacts', { p_actor: currentUsername });
        if (error) { console.error('dm_contacts:', error); return; }
        dmContacts = data || [];
    }

    function setDmTopicFilter(topic) {
        dmTopicFilter = topic;
        document.querySelectorAll('#dm-topic-pills .msg-pill').forEach(p => p.classList.toggle('active', p.getAttribute('data-topic') === topic));
        renderDmThreads();
    }

    function renderDmThreads() {
        const container = document.getElementById('dm-thread-list');
        if (!container) return;
        if (document.getElementById('dm-new-picker')) return; // don't wipe the picker mid-use
        const q = (document.getElementById('dm-search')?.value || '').toLowerCase();
        let list = dmThreads.slice();
        if (dmTopicFilter) list = list.filter(t => t.topic === dmTopicFilter);
        if (q) list = list.filter(t => `${dmThreadLabel(t)} ${t.other_username} ${t.topic} ${dmRefLabel(t.topic, t.ref_id)}`.toLowerCase().includes(q));
        if (!list.length) {
            container.innerHTML = `<div style="padding:20px 14px; text-align:center; color:var(--text-muted); font-size:0.8rem;">${t('d_no_convos')}</div>`;
            return;
        }
        container.innerHTML = list.map(t => {
            const active = t.other_username === dmActiveUser && t.topic === dmActiveTopic && (t.ref_id || null) === (dmActiveRef || null);
            const unread = parseInt(t.unread, 10) || 0;
            const refLabel = dmRefLabel(t.topic, t.ref_id);
            const snippet = t.last_body ? escHtml(t.last_body.length > 38 ? t.last_body.slice(0, 38) + '…' : t.last_body) : '';
            const pre = (t.last_from && t.last_from === currentUsername) ? (window.t('d_you_prefix') + ' ') : '';
            const refArg = t.ref_id ? `'${escJsAttr(t.ref_id)}'` : 'null';
            return `
                <div class="msg-convo-item${active ? ' active' : ''}" onclick="selectDmThread('${escJsAttr(t.other_username)}','${escJsAttr(t.topic)}',${refArg})">
                    <div class="msg-convo-meta">
                        <span class="msg-convo-name">${escHtml(dmThreadLabel(t))}${unread ? ` <span style="background:#dc2626;color:#fff;border-radius:10px;font-size:10px;padding:0 6px;font-weight:700;">${unread}</span>` : ''}</span>
                        <span class="msg-convo-time">${t.last_at ? fmtMsgTime(t.last_at) : ''}</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:6px; margin:2px 0;">${dmTopicBadge(t.topic)}${refLabel ? `<span style="font-size:11px; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escHtml(refLabel)}</span>` : ''}</div>
                    <div class="msg-convo-snippet">${pre}${snippet}</div>
                </div>`;
        }).join('');
    }

    // "+ New" — pick a person, a topic, and (for record topics) the specific
    // record, or (for Missing Day) a date. Each opens its own thread.
    async function startNewDmConversation() {
        if (!dmContacts.length) await fetchDmContacts();
        const people = dmContacts.slice().sort((a, b) => dmContactLabel(a).localeCompare(dmContactLabel(b), undefined, { sensitivity: 'base' }));
        const peopleOpts = people.map(c => `<option value="${escHtml(c.username)}">${escHtml(dmContactLabel(c))}</option>`).join('');
        const topicOpts = DM_TOPICS.map(t => `<option value="${t}">${t}</option>`).join('');
        const list = document.getElementById('dm-thread-list');
        if (!list) return;
        list.insertAdjacentHTML('afterbegin', `
            <div id="dm-new-picker" style="padding:10px 12px; border-bottom:1px solid var(--border); background:var(--surface-2); display:flex; flex-direction:column; gap:6px;">
                <div style="font-size:11px; font-weight:700; color:var(--text-muted);">${t('d_new_conversation')}</div>
                <select id="dm-new-person" onchange="dmNewPickerUpdate()"><option value="">${t('d_pick_person')}</option>${peopleOpts}</select>
                <select id="dm-new-topic" onchange="dmNewPickerUpdate()">${topicOpts}</select>
                <div id="dm-new-ref-wrap"></div>
                <div style="display:flex; gap:6px;">
                    <button type="button" class="btn-small" style="margin:0; background:var(--primary);" onclick="openNewDmConversation()">${t('d_open_chat')}</button>
                    <button type="button" class="btn-small" style="margin:0; background:#64748b;" onclick="(function(){var e=document.getElementById('dm-new-picker'); if(e) e.remove(); renderDmThreads();})()">${t('cancel')}</button>
                </div>
            </div>`);
        dmNewPickerUpdate();
    }

    // Rebuild the third control based on the chosen topic: a record dropdown
    // for Claims/Charges/Income, a date for Missing Day, nothing for General.
    function dmNewPickerUpdate() {
        const person = document.getElementById('dm-new-person')?.value || '';
        const topic = document.getElementById('dm-new-topic')?.value || 'General';
        const wrap = document.getElementById('dm-new-ref-wrap');
        if (!wrap) return;
        if (topic === 'Missing Day') {
            wrap.innerHTML = `<label style="font-size:11px; color:var(--text-muted);">Pick a date</label><input type="date" id="dm-new-ref" value="${todayStr()}">`;
        } else if (topic === 'Claims' || topic === 'Charges' || topic === 'Income') {
            if (!person) { wrap.innerHTML = `<div style="font-size:11px; color:var(--text-muted);">Pick a person to list their ${topic.toLowerCase()}.</div>`; return; }
            const recs = dmRecordsFor(topic, dmConversationEmpId(person));
            if (!recs.length) { wrap.innerHTML = `<div style="font-size:11px; color:var(--text-muted);">No ${topic.toLowerCase()} on file for this person.</div>`; return; }
            const noun = topic === 'Income' ? 'record' : topic.slice(0, -1).toLowerCase();
            wrap.innerHTML = `<select id="dm-new-ref"><option value="">— Pick a ${noun} —</option>${recs.map(r => `<option value="${escHtml(r.id)}">${escHtml(r.label)}</option>`).join('')}</select>`;
        } else {
            wrap.innerHTML = ''; // General
        }
    }

    function openNewDmConversation() {
        const person = document.getElementById('dm-new-person')?.value;
        const topic = document.getElementById('dm-new-topic')?.value;
        if (!person) { alert('Pick a person first.'); return; }
        if (!topic) { alert('Pick a topic first.'); return; }
        let ref = null;
        if (topic === 'Missing Day') {
            ref = document.getElementById('dm-new-ref')?.value || '';
            if (!ref) { alert('Pick a date for the Missing Day thread.'); return; }
        } else if (topic === 'Claims' || topic === 'Charges' || topic === 'Income') {
            ref = document.getElementById('dm-new-ref')?.value || '';
            if (!ref) { alert(`Pick which ${topic.toLowerCase().replace(/s$/, '')} this conversation is about.`); return; }
        }
        const picker = document.getElementById('dm-new-picker'); if (picker) picker.remove();
        selectDmThread(person, topic, ref || null);
    }

    async function selectDmThread(username, topic, ref) {
        dmActiveUser = username; dmActiveTopic = topic; dmActiveRef = ref || null;
        // Anything staged but not sent belongs to the previous conversation.
        chatStage = [];
        renderChatStage();
        await fetchDmThread();
        renderDmThread(true);
        await fetchDmThreads();
        renderDmThreads();
    }

    async function fetchDmThread() {
        if (!dmActiveUser || !dmActiveTopic) { dmThreadMsgs = []; return false; }
        const { data, error } = await supabaseClient.rpc('dm_thread', { p_actor: currentUsername, p_other: dmActiveUser, p_topic: dmActiveTopic, p_ref_id: dmActiveRef });
        if (error) { console.error('dm_thread:', error); dmThreadMsgs = []; return false; }
        dmThreadMsgs = data || [];
        const snap = dmThreadMsgs.map(m => m.id + ':' + (m.read_at || '')).join('|');
        const changed = snap !== dmMsgsSnap;
        dmMsgsSnap = snap;
        return changed;
    }

    function dmActivePersonLabel() {
        const t = dmThreads.find(x => x.other_username === dmActiveUser);
        if (t) return dmThreadLabel(t);
        const c = dmContacts.find(x => x.username === dmActiveUser);
        return c ? dmContactLabel(c) : dmActiveUser;
    }

    function renderDmThread(force) {
        const header = document.getElementById('dm-thread-header');
        const body = document.getElementById('dm-thread-body');
        const composer = document.getElementById('dm-composer');
        const empty = document.getElementById('dm-empty-state');
        if (!dmActiveUser || !dmActiveTopic) {
            if (header) header.style.display = 'none';
            if (composer) composer.style.display = 'none';
            if (empty) empty.style.display = 'flex';
            if (body) body.innerHTML = '';
            dmRenderedKey = null;
            return;
        }
        const label = dmActivePersonLabel();
        const refLabel = dmRefLabel(dmActiveTopic, dmActiveRef);
        if (empty) empty.style.display = 'none';
        if (header) { header.style.display = 'flex'; header.style.flexWrap = 'wrap'; header.innerHTML = `<span class="type-pill">${escHtml(label)}</span> ${dmTopicBadge(dmActiveTopic)}${refLabel ? ` <span style="font-size:11px; color:var(--text-muted);">${escHtml(refLabel)}</span>` : ''}`; }
        if (composer) composer.style.display = 'flex';

        const key = dmThreadKey(dmActiveUser, dmActiveTopic, dmActiveRef);
        const isSame = dmRenderedKey === key;
        const nearBottom = isSame && body && (body.scrollTop + body.clientHeight) >= (body.scrollHeight - 60);
        dmRenderedKey = key;

        if (!dmThreadMsgs.length) {
            if (body) body.innerHTML = '<div style="text-align:center;color:var(--text-muted);font-size:0.8rem;padding:20px;">No messages yet — say hello below.</div>';
            return;
        }
        let html = '', lastDay = null;
        dmThreadMsgs.forEach(m => {
            const day = new Date(m.created_at).toDateString();
            if (day !== lastDay) {
                const isToday = day === new Date().toDateString();
                const isYest = day === new Date(Date.now() - 86400000).toDateString();
                html += `<div class="msg-day-sep">${isToday ? 'Today' : isYest ? 'Yesterday' : new Date(m.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</div>`;
                lastDay = day;
            }
            const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
            const readTag = (m.mine && m.read_at) ? ' · Read' : '';
            html += `
                <div class="msg-bubble-row ${m.mine ? 'mine' : 'theirs'}">
                    <div class="msg-bubble-meta">${m.mine ? 'You' : escHtml(label)} · ${time}${readTag}</div>
                    <div class="msg-bubble">${m.body ? escHtml(m.body) : ''}${m.attach_path ? `${m.body ? '<br>' : ''}${dmFileChip(m)}` : ''}</div>
                    ${m.mine ? `<span class="msg-bubble-del" onclick="deleteDirectMessage(${m.id})">✕ Delete</span>` : ''}
                </div>`;
        });
        if (body) { body.innerHTML = html; if (force || !isSame || nearBottom) body.scrollTop = body.scrollHeight; }
    }

    async function sendDirectMessage() {
        if (!dmActiveUser || !dmActiveTopic) { alert('Pick a conversation first (tap +).'); return; }
        const el = document.getElementById('dm-compose-text');
        const text = (el.value || '').trim();
        if (!text) return;
        el.disabled = true;
        const { error } = await supabaseClient.rpc('dm_send', { p_actor: currentUsername, p_recipient: dmActiveUser, p_body: text, p_topic: dmActiveTopic, p_ref_id: dmActiveRef });
        el.disabled = false;
        if (error) { alert('Error: ' + error.message); el.focus(); return; }
        el.value = '';
        await fetchDmThread();
        renderDmThread(true);
        await fetchDmThreads();
        renderDmThreads();
        el.focus();
    }

    async function deleteDirectMessage(id) {
        if (!confirm('Delete this message?')) return;
        const { error } = await supabaseClient.rpc('dm_delete_message', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        await fetchDmThread();
        renderDmThread(true);
        await fetchDmThreads();
        renderDmThreads();
    }

    // ---- Emoji picker (works in every chat) ------------------------------
    const DM_EMOJIS = ['😀','😁','😂','🤣','😊','😍','😉','😎','🙂','😐','😕','😢','😭','😡','🤔','😅','👍','👎','👌','🙏','👏','💪','🔥','✅','❌','⚠️','❓','❗','💯','🎉','📌','📎','📷','🎬','📄','💰','💵','🧾','📅','⏰','🚚','🛠️','❤️','🚨'];
    function renderDmEmojiPanel() {
        const p = document.getElementById('dm-emoji-panel');
        if (!p) return;
        p.innerHTML = DM_EMOJIS.map(e => `<button type="button" onclick="insertDmEmoji('${e}')" style="background:none;border:none;font-size:20px;cursor:pointer;padding:2px 4px;line-height:1;">${e}</button>`).join('');
    }
    function toggleDmEmojiPanel() {
        const p = document.getElementById('dm-emoji-panel');
        if (!p) return;
        if (p.style.display === 'none' || !p.style.display) { renderDmEmojiPanel(); p.style.display = 'flex'; }
        else { p.style.display = 'none'; }
    }
    function insertDmEmoji(e) {
        const el = document.getElementById('dm-compose-text');
        if (!el) return;
        el.value = (el.value || '') + e;
        el.focus();
    }

    // ---- Attaching a file to a chat --------------------------------------
    // Files live on the record the thread is about, so they can only be sent
    // from a Claim / Charge / Income conversation — the file is attached to
    // that record (visible in its Files) AND shown here in the thread.
    function dmTopicEntityType(topic) {
        return topic === 'Claims' ? 'claim' : topic === 'Charges' ? 'charge' : topic === 'Income' ? 'income' : null;
    }
    function dmFileChip(m) {
        const icon = m.attach_kind === 'photo' ? '📷' : m.attach_kind === 'video' ? '🎬' : '📄';
        const size = m.attach_size ? ' · ' + formatBytes(m.attach_size) : '';
        return `<button type="button" class="btn-small" style="margin:2px 0 0; background:var(--excel-blue);" onclick="viewAttachment('${escJsAttr(m.attach_path)}')">${icon} ${escHtml(m.attach_name || 'file')}${size}</button>`;
    }
    // Chat uploads are staged with an editable, pre-filled name first — the same
    // two-step flow and naming convention as the Files modal — so a camera name
    // like "IMG_20260819_223344_1.jpg" never lands on the record. The file is
    // filed against the conversation's claim/charge/income either way.
    let chatStage = [];   // [{ file, name (no extension), ext }]

    async function stageChatFiles(fileList) {
        const arr = Array.from(fileList || []);
        const input = document.getElementById('dm-file-input');
        if (input) input.value = '';
        if (!arr.length) return;
        if (!dmActiveUser || !dmActiveTopic) { alert('Pick a conversation first (tap +).'); return; }
        const entityType = dmTopicEntityType(dmActiveTopic);
        if (!entityType || !dmActiveRef) {
            alert('To share a file, open a Claim, Charge, or Income conversation — the file attaches to that record. (General and Missing Day chats have no record to attach to.)');
            return;
        }
        if (!canUploadTo(entityType, dmActiveRef)) {
            alert('You can only share files on your own claims, charges and income.');
            return;
        }
        // Names already on this record, so the numeric suffix continues correctly
        // rather than restarting at (2) for every chat upload.
        const taken = new Set();
        try {
            const { data } = await supabaseClient.rpc('list_attachments', {
                p_actor: currentUsername, p_entity_type: entityType, p_entity_id: dmActiveRef
            });
            (data || []).forEach(a => taken.add(splitExt(a.file_name).base.toLowerCase()));
        } catch (e) { /* suggestion only — a collision is cosmetic, not fatal */ }

        arr.forEach(f => {
            const { ext } = splitExt(f.name);
            chatStage.forEach(st => taken.add(String(st.name).toLowerCase()));
            chatStage.push({ file: f, name: buildAttachName(dmActiveRef, null, taken), ext });
        });
        renderChatStage();
    }

    function setChatStagedName(i, val) { if (chatStage[i]) chatStage[i].name = val; }
    function removeChatStaged(i) { chatStage.splice(i, 1); renderChatStage(); }
    function clearChatStage() { chatStage = []; renderChatStage(); }

    function renderChatStage() {
        const el = document.getElementById('dm-stage-panel');
        if (!el) return;
        if (!chatStage.length) { el.innerHTML = ''; return; }
        el.innerHTML = `
            <div style="padding:6px; border:1px solid var(--border); border-radius:8px; background:var(--surface-2); margin-bottom:6px;">
                <div style="font-size:10px; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); font-weight:700; margin-bottom:4px;">Ready to send — rename if you like</div>
                ${chatStage.map((st, i) => `
                    <div class="stage-row">
                        <input type="text" value="${escHtml(st.name)}" oninput="setChatStagedName(${i}, this.value)" placeholder="File name">
                        <span class="stage-meta">${st.ext ? '.' + escHtml(st.ext) : ''} · ${formatBytes(st.file.size)}</span>
                        <span class="del-btn" style="cursor:pointer;" title="Remove" onclick="removeChatStaged(${i})">✕</span>
                    </div>`).join('')}
                <div style="margin-top:6px;">
                    <button type="button" class="btn-small" id="dm-send-files-btn" style="margin:0;" onclick="sendStagedChatFiles()">Send ${chatStage.length} file${chatStage.length === 1 ? '' : 's'}</button>
                    <button type="button" class="btn-small" style="margin:0 0 0 6px; background:#64748b;" onclick="clearChatStage()">Cancel</button>
                </div>
            </div>`;
    }

    async function sendStagedChatFiles() {
        if (!chatStage.length) return;
        if (!dmActiveUser || !dmActiveTopic) { alert('Pick a conversation first (tap +).'); return; }
        const entityType = dmTopicEntityType(dmActiveTopic);
        if (!entityType || !dmActiveRef) return;
        if (!canUploadTo(entityType, dmActiveRef)) {
            alert('You can only share files on your own claims, charges and income.');
            return;
        }
        const btn = document.getElementById('dm-send-files-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        const items = chatStage.slice();
        let ok = 0, failed = 0;
        for (const st of items) {
            try {
                if (st.file.size > 104857600) throw new Error(`${st.file.name}: over the 100 MB limit`);
                const file = await compressImageFile(st.file);
                // compressImageFile may re-encode to JPEG, so take the extension
                // from what is actually being uploaded.
                const ext = splitExt(file.name).ext || st.ext;
                const finalName = sanitizeAttachName(st.name) + (ext ? '.' + ext : '');
                const signed = await efAttach({ action: 'sign-upload', entity_type: entityType, entity_id: dmActiveRef, file_name: finalName });
                const up = await fetch(signed.signedUrl, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
                if (!up.ok) throw new Error('Upload failed (HTTP ' + up.status + ')');
                const { error: recErr } = await supabaseClient.rpc('record_attachment', {
                    p_actor: currentUsername, p_entity_type: entityType, p_entity_id: dmActiveRef,
                    p_storage_path: signed.path, p_file_name: finalName, p_mime_type: file.type || null, p_size_bytes: file.size, p_kind: null
                });
                if (recErr) throw new Error(recErr.message);
                const kind = (file.type || '').startsWith('image/') ? 'photo' : (file.type || '').startsWith('video/') ? 'video' : 'document';
                const { error: sendErr } = await supabaseClient.rpc('dm_send', {
                    p_actor: currentUsername, p_recipient: dmActiveUser, p_body: '', p_topic: dmActiveTopic, p_ref_id: dmActiveRef,
                    p_attach_path: signed.path, p_attach_name: finalName, p_attach_kind: kind, p_attach_size: file.size
                });
                if (sendErr) throw new Error(sendErr.message);
                ok++;
            } catch (e) {
                failed++;
                console.error('sendStagedChatFiles:', e);
                alert('Could not send file: ' + (e && e.message ? e.message : e));
            }
        }
        chatStage = [];
        renderChatStage();
        if (ok) { attachDirty = true; await loadAttachmentCounts(); rerenderAttachmentLists(); }
        await fetchDmThread();
        renderDmThread(true);
        await fetchDmThreads();
        renderDmThreads();
    }


    function startMessagePolling() {
        stopMessagePolling();
        dmPollTimer = setInterval(async () => {
            const threadsChanged = await fetchDmThreads();
            if (threadsChanged) renderDmThreads();
            if (dmActiveUser && dmActiveTopic) {
                const msgsChanged = await fetchDmThread();
                if (msgsChanged) renderDmThread(false);
            }
        }, 5000);
    }
    function stopMessagePolling() {
        if (dmPollTimer) { clearInterval(dmPollTimer); dmPollTimer = null; }
    }

    async function renderMessagesTab() {
        dmActiveUser = null; dmActiveTopic = null; dmActiveRef = null; dmRenderedKey = null;
        const search = document.getElementById('dm-search');
        if (search) search.value = '';
        await fetchDmThreads();
        await fetchDmContacts();
        renderDmThreads();
        renderDmThread();
        startMessagePolling();
    }

    async function renderPayroll() {
        const typeFilter = document.getElementById('payroll-type-filter').value;
        const statusFilter = document.getElementById('payroll-status-filter').value;
        const query = (document.getElementById('payroll-search').value || '').toLowerCase();

        // Load the selected week's daily and provider totals (historical), then label the week.
        await loadCurrentWeekDaily();
        await loadCurrentWeekProvider();
        const plabel = document.getElementById('payroll-week-label');
        if (plabel) plabel.textContent = fmtWeekLabel(payrollSunday());

        const list = employees.filter(emp => {
            if (typeFilter && emp.person_type !== typeFilter) return false;
            if (statusFilter && emp.status !== statusFilter) return false;
            if (query) {
                const hay = `${emp.id} ${emp.first_name} ${emp.last_name}`.toLowerCase();
                if (!hay.includes(query)) return false;
            }
            return true;
        });

        // Compute each person's numbers once so both the sort and the two
        // render branches below can reuse them instead of recalculating.
        let calc = list.map(emp => {
            const payType = getPayType(emp.id);
            const base = payType === 'Daily' ? (currentWeekDaily[emp.id] || 0) : payType === 'Provider' ? (currentWeekProvider[emp.id] || 0) : (parseFloat(emp.pay_rate) || 0);
            const routePay = currentWeekRoutePay(emp);
            const income = activeWeeklyIncome(emp.id);
            const gross = base + routePay + income;
            const ded = activeWeeklyDeductions(emp.id, gross);
            const net = gross - ded;
            return { emp, payType, base, routePay, income, gross, ded, net };
        });
        calc = applySort(calc, 'payroll', {
            employee: c => `${c.emp.first_name} ${c.emp.last_name}`,
            id: c => c.emp.id,
            type: c => c.emp.person_type || '',
            base: c => c.base,
            gross: c => c.gross,
            deductions: c => c.ded,
            net: c => c.net,
            status: c => c.emp.status || ''
        });
        lastPayrollCalc = calc; // for printAllPayroll — same rows, same filters/sort, currently on screen

        let totBase = 0, totRoute = 0, totIncome = 0, totGross = 0, totDed = 0, totNet = 0;
        const container = document.getElementById('payroll-tbody');

        if (isDesktopView()) {
            container.className = '';
            if (!calc.length) { container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_people_match')}</div>`; renderPayrollFoot(0, 0, 0, 0, 0, 0); return; }
            let rows = '';
            calc.forEach(({ emp, payType, base, routePay, income, gross, ded, net }) => {
                totBase += base; totRoute += routePay; totIncome += income; totGross += gross; totDed += ded; totNet += net;
                const open = recExpanded.payroll.has(emp.id);
                const payPill = payType === 'Daily' ? ' <span class="pay-pill pay-daily" style="font-size:9px;">daily</span>' : payType === 'Provider' ? ' <span class="pay-pill pay-provider" style="font-size:9px;">provider</span>' : '';
                rows += `<tr style="cursor:pointer;" onclick="toggleRecCard('payroll','${emp.id}')">
                    <td class="id-cell"><span class="rec-caret" data-caret="payroll-${emp.id}">${open ? '▾' : '▸'}</span> ${emp.id}</td>
                    <td>${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</td>
                    <td>${emp.person_type}</td>
                    <td>${formatMoney(base)}${payPill}</td>
                    <td>${formatMoney(routePay)}</td>
                    <td>${formatMoney(income)}</td>
                    <td>${formatMoney(gross)}</td>
                    <td style="color:#dc2626;">${ded > 0 ? '−' + formatMoney(ded) : formatMoney(0)}</td>
                    <td style="font-weight:700;">${formatMoney(net)}</td>
                </tr>
                <tr class="rec-card${open ? ' open' : ''}" id="rec-payroll-${emp.id}" style="display:${open ? 'table-row' : 'none'};">
                    <td colspan="9" style="padding:0; background:var(--surface-2);">${payrollDetailHtml(emp, payType, base, routePay, ded, income)}</td>
                </tr>`;
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th data-i18n="d_th_id">ID</th><th data-i18n="d_th_name">Name</th><th data-i18n="d_type">Type</th><th data-i18n="d_base_wk">Base (wk)</th><th data-i18n="d_route_wk">Route (wk)</th><th data-i18n="d_income_wk">Income (wk)</th><th data-i18n="d_gross">Gross</th><th data-i18n="d_deductions_h">Deductions</th><th data-i18n="d_net">Net</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`;
            renderPayrollFoot(calc.length, totBase, totRoute, totGross, totDed, totNet);
            updateRecSortUI('payroll');
            applyTranslations();
            return;
        }

        container.className = 'record-grid';
        container.innerHTML = calc.length ? '' : `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_people_match')}</div>`;

        calc.forEach(({ emp, payType, base, routePay, income, gross, ded, net }) => {
            totBase += base; totRoute += routePay; totIncome += income; totGross += gross; totDed += ded; totNet += net;

            const open = recExpanded.payroll.has(emp.id);
            const payPill = payType === 'Daily' ? ' <span class="pay-pill pay-daily" style="font-size:9px;">daily</span>' : payType === 'Provider' ? ' <span class="pay-pill pay-provider" style="font-size:9px;">provider</span>' : '';
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-payroll-${emp.id}">
                    <div class="rec-card-head" onclick="toggleRecCard('payroll','${emp.id}')">
                        <span class="rec-caret" data-caret="payroll-${emp.id}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</span>
                        <span class="rec-sub">${emp.id}</span>
                        <span class="rec-right" style="font-weight:700;">${formatMoney(net)}</span>
                    </div>
                    <div class="rec-card-body">
                        <div class="rec-detail-grid">
                            <div><div class="k" data-i18n="d_type">Type</div><div class="v">${emp.person_type}</div></div>
                            <div><div class="k" data-i18n="d_base_pay_wk">Base pay (wk)</div><div class="v">${formatMoney(base)}${payPill}</div></div>
                            <div><div class="k" data-i18n="d_route_pay_wk">Route pay (wk)</div><div class="v">${formatMoney(routePay)}</div></div>
                            <div><div class="k" data-i18n="d_gross">Gross</div><div class="v">${formatMoney(gross)}</div></div>
                            <div><div class="k" data-i18n="d_weekly_deductions">Weekly deductions</div><div class="v" style="color:#dc2626;">${ded > 0 ? '−' + formatMoney(ded) : formatMoney(0)}</div></div>
                            <div><div class="k" data-i18n="d_net_pay">Net pay</div><div class="v" style="font-weight:700;">${formatMoney(net)}</div></div>
                        </div>
                        ${payrollDetailHtml(emp, payType, base, routePay, ded, income)}
                    </div>
                </div>`);
        });

        renderPayrollFoot(calc.length, totBase, totRoute, totGross, totDed, totNet);
        updateRecSortUI('payroll');
        applyTranslations();
    }

    function renderPayrollFoot(count, totBase, totRoute, totGross, totDed, totNet) {
        const foot = document.getElementById('payroll-foot');
        if (foot) {
            foot.innerHTML = count ? `
                <div style="text-align:right; font-weight:700; padding:8px 4px; border-top:1px solid var(--border); margin-top:6px; font-size:13px;">
                    Totals (${count}) · Base ${formatMoney(totBase)} · Route ${formatMoney(totRoute)} · Gross ${formatMoney(totGross)} ·
                    Deductions ${totDed > 0 ? '−' + formatMoney(totDed) : formatMoney(0)} · Net ${formatMoney(totNet)}
                </div>` : '';
        }

        const grid = document.getElementById('payroll-stats-grid');
        if (grid) {
            grid.innerHTML = `
                <div class="stat-card"><div class="stat-label" data-i18n="d_people">People</div><div class="stat-value">${count}</div></div>
                <div class="stat-card"><div class="stat-label" data-i18n="d_gross_wk">Gross (wk)</div><div class="stat-value">${formatMoney(totGross)}</div></div>
                <div class="stat-card"><div class="stat-label" data-i18n="d_deductions_wk">Deductions (wk)</div><div class="stat-value">${formatMoney(totDed)}</div></div>
                <div class="stat-card"><div class="stat-label" data-i18n="d_net_pay_wk">Net Pay (wk)</div><div class="stat-value">${formatMoney(totNet)}</div></div>
            `;
        }
    }

    // Expanded breakdown for one payroll row: paid days / base pay (+ route
    // pay for drivers) on the left, itemized weekly deductions on the right.
    function payrollDetailHtml(emp, payType, base, routePay, ded, income) {
        let baseHtml;
        if (payType === 'Daily') {
            const days = currentWeekDailyDetail[emp.id] || [];
            baseHtml = days.length
                ? `<table style="width:100%;font-size:12px;"><thead><tr><th style="text-align:left;" data-i18n="d_th_day">Day</th><th style="text-align:right;" data-i18n="d_th_pay">Pay</th></tr></thead><tbody>${days.map(d => `<tr><td>${d.label}</td><td style="text-align:right;">${d.is_off ? '<em style="color:var(--text-muted);">OFF</em>' : formatMoney(d.amount)}</td></tr>`).join('')}<tr style="font-weight:700;border-top:1px solid var(--border);"><td data-i18n="d_base_daily_total">Base (daily total)</td><td style="text-align:right;">${formatMoney(base)}</td></tr></tbody></table>`
                : `<div style="color:var(--text-muted);font-size:12px;"><span data-i18n="d_no_daily_pay">No daily pay entered for</span> ${currentWeekLabel}.</div>`;
        } else if (payType === 'Provider') {
            const notes = currentWeekProviderNotes[emp.id] || '';
            baseHtml = base > 0 || notes
                ? `<table style="width:100%;font-size:12px;"><tbody><tr><td><span data-i18n="d_provider_pay">Provider pay</span>${notes ? ' · ' + escHtml(notes) : ''}</td><td style="text-align:right;font-weight:700;">${formatMoney(base)}</td></tr></tbody></table>`
                : `<div style="color:var(--text-muted);font-size:12px;"><span data-i18n="d_no_provider_pay">No provider pay entered for</span> ${currentWeekLabel}.</div>`;
        } else {
            baseHtml = `<table style="width:100%;font-size:12px;"><tbody><tr><td data-i18n="d_weekly_salary">Weekly salary</td><td style="text-align:right;font-weight:700;">${formatMoney(base)}</td></tr></tbody></table>`;
        }

        const rb = routeBreakdown(emp);
        const routeHtml = rb.length
            ? `<div style="margin-top:12px;"><div class="detail-subhead"><span data-i18n="d_route_pay_dot">Route pay</span> · ${currentWeekLabel}</div><table style="width:100%;font-size:12px;"><thead><tr><th style="text-align:left;" data-i18n="d_th_date">Date</th><th style="text-align:left;" data-i18n="d_th_route">Route</th><th style="text-align:right;" data-i18n="d_th_pay">Pay</th></tr></thead><tbody>${rb.map(r => `<tr><td>${r.date || '—'}</td><td>${r.id || '—'}</td><td style="text-align:right;">${formatMoney(r.pay)}</td></tr>`).join('')}<tr style="font-weight:700;border-top:1px solid var(--border);"><td colspan="2" data-i18n="d_route_total">Route total</td><td style="text-align:right;">${formatMoney(routePay)}</td></tr></tbody></table></div>`
            : '';

        const ib = incomeBreakdown(emp.id);
        const incomeHtml = ib.length
            ? `<div style="margin-top:12px;">
                    <div class="detail-subhead" data-i18n="d_additional_income">Additional income</div>
                    <div style="font-size:12px;">
                        ${ib.map(it => `
                            <div style="padding:6px 0;border-bottom:1px solid var(--border);">
                                <div>${it.id} · ${it.label}</div>
                                ${it.notes ? `<div style="color:var(--text-muted); font-style:italic; margin-top:1px;">${escHtml(it.notes)}</div>` : ''}
                                <div style="display:flex;justify-content:space-between;gap:8px;margin-top:2px;">
                                    <span style="color:#059669;font-weight:700;">+${formatMoney(it.weekly)}</span>
                                    <span style="color:var(--text-muted);">Remaining: ${formatMoney(it.remaining)}</span>
                                </div>
                            </div>`).join('')}
                        <div style="display:flex;justify-content:space-between;font-weight:700;padding-top:6px;">
                            <span data-i18n="d_income_total">Income total</span>
                            <span style="color:#059669;">+${formatMoney(income || 0)}</span>
                        </div>
                    </div>
                </div>`
            : '';

        const gross = base + routePay + income;
        const items = deductionBreakdown(emp.id, gross);
        const scheduledTotal = items.reduce((s, it) => s + it.scheduled, 0);
        const wasCapped = scheduledTotal - ded > 0.004;
        const dedHtml = items.length
            ? `<div style="font-size:12px;">
                    ${items.map(it => `
                        <div style="padding:6px 0;border-bottom:1px solid var(--border);">
                            <div><span class="type-pill">${it.kind}</span> ${it.id} · ${it.label}${(() => {
                                const parts = [];
                                if (it.company) parts.push(escHtml(it.company));
                                if (it.claimant) parts.push('Acct ' + escHtml(it.claimant));
                                if (it.carrier) parts.push('Carrier # ' + escHtml(it.carrier));
                                if (it.customer) parts.push('Customer # ' + escHtml(it.customer));
                                return parts.length ? `<br><span style="color:var(--text-muted);">${parts.join(' · ')}</span>` : '';
                            })()}${it.notes ? `<br><span style="color:var(--text-muted); font-style:italic;">${escHtml(it.notes)}</span>` : ''}${it.weekly < it.scheduled ? `<br><span style="color:var(--text-muted);">(scheduled ${formatMoney(it.scheduled)})</span>` : ''}</div>
                            <div style="display:flex;justify-content:space-between;gap:8px;margin-top:2px;">
                                <span style="color:#dc2626;font-weight:700;">−${formatMoney(it.weekly)}</span>
                                <span style="color:var(--text-muted);">Balance: ${formatMoney(it.balance)}</span>
                            </div>
                        </div>`).join('')}
                    <div style="display:flex;justify-content:space-between;font-weight:700;padding-top:6px;">
                        <span data-i18n="d_total_deductions">Total deductions</span>
                        <span style="color:#dc2626;">−${formatMoney(ded)}</span>
                    </div>
                </div>${wasCapped ? `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">Capped at this week's gross pay (${formatMoney(gross)}) — the full scheduled amount is ${formatMoney(scheduledTotal)}. Net pay can't go below $0.00. The claim/charge balance still follows its own calendar schedule regardless of pay, so if a week is known in advance to have no pay, pausing it (Claims tab) keeps the balance accurate too.</div>` : ''}`
            : `<div style="color:var(--text-muted);font-size:12px;" data-i18n="d_no_active_ded">No active weekly deductions.</div>`;

        return `<div style="padding:8px 12px 0;"><button type="button" class="btn-small" style="background:var(--navy);margin:0;" onclick="event.stopPropagation(); printPayrollForEmployee('${emp.id}')" data-i18n="d_print_payslip">🖨 Print payslip</button></div>
                <div style="display:flex;flex-wrap:wrap;gap:16px;padding:12px 12px;">
                    <div style="flex:1;min-width:240px;">
                        <div class="detail-subhead"><span data-i18n="d_paid_days_base">Paid days / base pay</span>${payType !== 'Weekly' ? ' · ' + currentWeekLabel : ''}</div>
                        ${baseHtml}${routeHtml}${incomeHtml}
                    </div>
                    <div style="flex:1;min-width:240px;">
                        <div class="detail-subhead" data-i18n="d_weekly_deductions">Weekly deductions</div>
                        ${dedHtml}
                    </div>
                </div>`;
    }

    // --- INLINE EDITING (Admin + Medium) --------------------------------
    function canEdit() {
        return currentUserRole === 'SuperAdmin' || currentUserRole === 'Administrator' || currentUserRole === 'Medium';
    }

    // A View Only account belongs to one employee and may maintain that one
    // record only. The server enforces this too (_attach_scope_ok confines role
    // 'User' to their own employee row) — these helpers just keep the UI honest
    // so a button is never offered that the server would refuse.
    function isViewOnly() { return currentUserRole === 'User'; }
    function myEmployeeId() { return (currentUser && currentUser.employee_id) || null; }

    // Who may ADD a file to a given record. Deliberately narrower than canEdit:
    // a View Only user can upload their own documents but cannot rename or
    // delete them, so a submitted document can't be withdrawn after a manager
    // has been notified to review it.
    function canUploadTo(type, id) {
        if (canEdit()) return true;
        if (!isViewOnly() || !id) return false;
        const me = myEmployeeId();
        if (!me) return false;
        // Mirrors _attach_scope_ok on the server: a View Only user owns their
        // employee row plus any claim, charge or income raised against them.
        // Ownership is checked explicitly rather than trusting that the loaded
        // arrays are already scoped.
        if (type === 'employee') return id === me;
        if (type === 'claim')  return (claims || []).some(c => c.claim_id === id && c.employee_id === me);
        if (type === 'charge') return (charges || []).some(c => c.charge_id === id && c.employee_id === me);
        if (type === 'income') return (additionalIncome || []).some(i => i.income_id === id && i.employee_id === me);
        return false;
    }

    // Prompt through a list of [label, key, currentValue] and collect only
    // the fields the user actually changed. Returns {} if nothing changed.
    function promptFields(title, fields) {
        alert(title + '\nLeave a value unchanged to keep it. Press Cancel on any field to stop.');
        const changed = {};
        for (const f of fields) {
            const cur = f.value === null || f.value === undefined ? '' : String(f.value);
            const input = prompt(f.label + ':', cur);
            if (input === null) break; // cancelled — stop, keep what we have
            if (input !== cur) changed[f.key] = input;
        }
        return changed;
    }

    // The edit prompts collect every value as text (prompt() always returns a
    // string). Numeric DB columns reject text ("type numeric but expression is
    // of type text"), and date columns reject "". Convert the known-typed keys
    // to real numbers / nulls before sending. Returns false if a number is
    // invalid so the caller can abort cleanly.
    function coerceEditFields(changed, numericKeys, dateKeys) {
        for (const k of (numericKeys || [])) {
            if (changed[k] === undefined) continue;
            const raw = String(changed[k]).trim();
            if (raw === '') { changed[k] = 0; continue; }
            const n = Number(raw.replace(/[$,\s]/g, ''));
            if (!isFinite(n)) { alert(`"${k.replace(/_/g, ' ')}" must be a number. Nothing was saved.`); return false; }
            changed[k] = n;
        }
        for (const k of (dateKeys || [])) {
            if (changed[k] === undefined) continue;
            const raw = String(changed[k]).trim();
            changed[k] = raw === '' ? null : raw;
        }
        return true;
    }

    // (Employee status is now changed via the inline dropdown -> setEmployeeStatus,
    //  and editing is inline via editEmployee/cancelEmployeeEdit defined above.)

    function editClaim(id) {
        if (!canEdit()) return;
        const c = claims.find(x => x.claim_id === id);
        if (!c) return;
        editingClaimId = id;
        document.getElementById('cClaimant').value = c.claimant_account || '';
        document.getElementById('cCompany').value = c.company_name || '';
        const emp = employees.find(e => e.id === c.employee_id);
        document.getElementById('cEmployee').value = c.employee_id || '';
        document.getElementById('cCarrier').value = c.carrier_claim_number || '';
        document.getElementById('cCustomer').value = c.customer_claim_number || '';
        document.getElementById('cDamageType').value = c.damage_type || '';
        document.getElementById('cAmount').value = (c.claim_amount ?? '');
        document.getElementById('cWeekly').value = (c.weekly_deduction ?? '');
        document.getElementById('cStartDate').value = c.start_date || '';
        document.getElementById('cEndDate').value = c.end_date || '';
        document.getElementById('cStatus').value = c.status || 'Queued';
        document.getElementById('cAbsorbed').value = (c.absorbed_amount ?? '');
        document.getElementById('cNotes').value = c.notes || '';
        document.getElementById('claim-form-titletext').textContent = `${t('editing_prefix')} ${id}`;
        document.getElementById('claim-save-btn').textContent = t('save_changes_plain');
        document.getElementById('claim-cancel-btn').style.display = '';
        document.getElementById('claim-edit-extra').style.display = '';
        showCCForm('claim');
        const panel = document.getElementById('claim-form').closest('.panel');
        if (panel) panel.classList.remove('collapsed');
        renderClaimHistoryPanels();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function cancelClaimEdit() {
        editingClaimId = null;
        document.getElementById('claim-form').reset();
        document.getElementById('cEmployee').value = '';
        document.getElementById('claim-form-titletext').textContent = t('new_claim');
        document.getElementById('claim-save-btn').textContent = t('save_claim');
        document.getElementById('claim-cancel-btn').style.display = 'none';
        document.getElementById('claim-edit-extra').style.display = 'none';
        refreshIdPreviews();
    }

    function renderClaimHistoryPanels() { return _dedRenderHistPanels(DED_KIND.claim); }
    function claimHistCompany() { return _dedHistCompany(DED_KIND.claim); }
    async function addRateChange() { return _dedAddRateChange(DED_KIND.claim); }
    async function recordPause() { return _dedRecordPause(DED_KIND.claim); }
    async function deleteRateChange(rid) { return _dedDeleteRateChange(DED_KIND.claim, rid); }
    async function deletePause(pid) { return _dedDeletePause(DED_KIND.claim, pid); }

    function editCharge(id) {
        if (!canEdit()) return;
        const ch = charges.find(x => x.charge_id === id);
        if (!ch) return;
        editingChargeId = id;
        document.getElementById('gChargeType').value = ch.charge_type || '';
        document.getElementById('gAmount').value = (ch.amount ?? '');
        document.getElementById('gWeekly').value = (ch.weekly_deduction ?? '');
        document.getElementById('gStartDate').value = ch.start_date || '';
        document.getElementById('gEndDate').value = ch.end_date || '';
        document.getElementById('gStatus').value = ch.status || 'Queued';
        document.getElementById('gNotes').value = ch.notes || '';
        const emp = employees.find(e => e.id === ch.employee_id);
        const empSel = document.getElementById('ci-employee');
        if (empSel) empSel.value = ch.employee_id || '';
        document.getElementById('charge-form-titletext').textContent = `${t('editing_prefix')} ${id}`;
        document.getElementById('charge-save-btn').textContent = t('save_changes_plain');
        document.getElementById('charge-cancel-btn').style.display = '';
        document.getElementById('charge-edit-extra').style.display = '';
        showCCForm('charge');
        const panel = document.getElementById('charge-form').closest('.panel');
        if (panel) panel.classList.remove('collapsed');
        renderChargeHistoryPanels();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function cancelChargeEdit() {
        editingChargeId = null;
        document.getElementById('charge-form').reset();
        document.getElementById('charge-form-titletext').textContent = t('new_charge');
        document.getElementById('charge-save-btn').textContent = t('save_charge');
        document.getElementById('charge-cancel-btn').style.display = 'none';
        document.getElementById('charge-edit-extra').style.display = 'none';
        refreshIdPreviews();
    }

    function renderChargeHistoryPanels() { return _dedRenderHistPanels(DED_KIND.charge); }
    function chargeHistCompany() { return _dedHistCompany(DED_KIND.charge); }
    async function addChargeRateChange() { return _dedAddRateChange(DED_KIND.charge); }
    async function recordChargePause() { return _dedRecordPause(DED_KIND.charge); }
    async function deleteChargeRateChange(rid) { return _dedDeleteRateChange(DED_KIND.charge, rid); }
    async function deleteChargePause(pid) { return _dedDeletePause(DED_KIND.charge, pid); }

    let editingRouteId = null;

    function editRoute(id) {
        if (!canEdit()) return;
        const r = routes.find(x => String(x.id) === String(id));
        if (!r) return;
        editingRouteId = id;
        document.getElementById('f-date').value = r.date || '';
        // r.contractor stores the company NAME (resolved at save time), but
        // the dropdown's option values are company CODEs — look up the
        // matching company to restore the right selection, not just stuff
        // the name into a code field.
        const matchedCo = (companies || []).find(c => (c.name || c.code) === r.contractor);
        document.getElementById('f-contractor').value = matchedCo ? matchedCo.code : (r.contractor || '');
        document.getElementById('f-type').value = r.type || 'Regular';
        document.getElementById('f-3rdman').value = r.third_man_status || 'None';
        document.getElementById('f-driver').value = r.driver || '';
        document.getElementById('f-routeNum').value = r.route_num || '';
        document.getElementById('f-routeId').value = r.route_id || '';
        document.getElementById('f-miles').value = (r.miles ?? 0);
        document.getElementById('f-manifest').value = (r.manifest ?? 0);
        document.getElementById('f-pullbacks').value = (r.pullbacks ?? 0);
        document.getElementById('f-incompletes').value = (r.incompletes ?? 0);
        document.getElementById('f-dedicated').value = (r.dedicated_flat ?? 0);
        document.getElementById('f-deductions').value = (r.deductions ?? 0);
        document.getElementById('f-extra').value = (r.extra_pay ?? 0);
        document.getElementById('route-form-titletext').textContent = `Editing ${r.route_id || id}`;
        document.getElementById('route-save-btn').textContent = 'Save changes';
        document.getElementById('route-cancel-btn').style.display = '';
        const panel = document.getElementById('tracker-form-card');
        if (panel) panel.classList.remove('collapsed');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function cancelRouteEdit() {
        editingRouteId = null;
        document.getElementById('route-form').reset();
        document.getElementById('route-form-titletext').textContent = 'Log New Route';
        document.getElementById('route-save-btn').textContent = '+ Add Route';
        document.getElementById('route-cancel-btn').style.display = 'none';
    }

    // --- APPROVALS & AUDIT LOG ------------------------------------------
    async function renderApprovals() {
        const container = document.getElementById('approvals-tbody');
        if (!container) return;
        const { data, error } = await supabaseClient.rpc('list_pending_changes', { p_actor: currentUsername, p_company: currentCompany });
        container.innerHTML = '';
        if (error) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">${error.message}</div>`; return; }
        if (!data || !data.length) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_pending')}</div>`; return; }

        const list = applySort(data, 'approvals', {
            requested: p => p.requested_at || '', requestedby: p => p.requested_by || '',
            table: p => p.table_name || '', field: p => p.field_name || ''
        });

        if (isDesktopView()) {
            container.className = '';
            let rows = '';
            list.forEach(p => {
                rows += `<tr>
                    <td>${p.requested_by}</td>
                    <td>${p.table_name}</td>
                    <td class="id-cell">${p.record_id}</td>
                    <td>${p.field_name}</td>
                    <td>${p.old_value ?? '-'}</td>
                    <td>${p.new_value ?? '-'}</td>
                    <td>${new Date(p.requested_at).toLocaleString()}</td>
                    <td style="text-align:center; white-space:nowrap;">
                        <button class="btn-small" style="background:var(--primary); margin:0 3px 0 0;" onclick="approveChange(${p.id})">${t('d_approve')}</button>
                        <button class="del-btn" onclick="rejectChange(${p.id})">✕</button>
                    </td>
                </tr>`;
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th>${t('d_th_requested_by')}</th><th>${t('sort_table')}</th><th>${t('d_th_record')}</th><th>${t('sort_field')}</th><th>${t('d_th_old')}</th><th>${t('d_th_new')}</th><th>${t('d_th_requested')}</th><th>${t('th_action')}</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`;
            updateRecSortUI('approvals');
            return;
        }

        container.className = 'record-grid';
        list.forEach(p => {
            const open = recExpanded.approvals ? recExpanded.approvals.has(p.id) : false;
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-approvals-${p.id}">
                    <div class="rec-card-head" onclick="toggleRecCard('approvals','${p.id}')">
                        <span class="rec-caret" data-caret="approvals-${p.id}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${p.requested_by}</span>
                        <span class="rec-sub">${p.record_id}</span>
                        <span class="rec-right">${p.field_name}</span>
                    </div>
                    <div class="rec-card-body">
                        <div class="rec-detail-grid">
                            <div><div class="k">${t('sort_table')}</div><div class="v">${p.table_name}</div></div>
                            <div><div class="k">${t('d_record')}</div><div class="v id-cell">${p.record_id}</div></div>
                            <div><div class="k">${t('sort_field')}</div><div class="v">${p.field_name}</div></div>
                            <div><div class="k">${t('d_old_value')}</div><div class="v">${p.old_value ?? '-'}</div></div>
                            <div><div class="k">${t('d_new_value')}</div><div class="v">${p.new_value ?? '-'}</div></div>
                            <div><div class="k">${t('d_requested')}</div><div class="v">${new Date(p.requested_at).toLocaleString()}</div></div>
                        </div>
                        <div class="rec-actions">
                            <button class="btn-small" style="background:var(--primary);margin:0;" onclick="approveChange(${p.id})">${t('d_approve')}</button>
                            <button class="del-btn" onclick="rejectChange(${p.id})">${t('d_reject')}</button>
                        </div>
                    </div>
                </div>`);
        });
        updateRecSortUI('approvals');
    }

    async function approveChange(id) {
        const { error } = await supabaseClient.rpc('approve_change', { p_actor: currentUsername, p_id: id });
        if (error) alert('Error: ' + error.message);
        else { renderApprovals(); fetchAllDataFromCloud(); }
    }

    async function rejectChange(id) {
        if (!confirm('Reject this change request?')) return;
        const { error } = await supabaseClient.rpc('reject_change', { p_actor: currentUsername, p_id: id });
        if (error) alert('Error: ' + error.message);
        else renderApprovals();
    }

    // A Medium user's release (normal or early) always lands here first —
    // the settle/absorb/prepay plan they already reviewed and built is
    // shown exactly as they built it; an Administrator isn't re-deciding
    // it, just approving or rejecting the same plan. Approving calls
    // straight into approve_release_request, which runs the real
    // release_week_deposit/release_last_paycheck RPC — everything from
    // there on (audit log, release_history, notifications) works exactly
    // like a direct Administrator release.
    async function renderReleaseRequests() {
        const container = document.getElementById('release-requests-tbody');
        if (!container) return;
        container.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">Loading…</div>';
        const { data, error } = await supabaseClient.rpc('get_pending_release_requests', { p_actor: currentUsername, p_company: currentCompany });
        if (error) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">${error.message}</div>`; return; }
        if (!data || !data.length) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_pending_release')}</div>`; return; }

        container.className = 'record-grid';
        container.innerHTML = data.map(r => {
            const emp = employees.find(e => e.id === r.employee_id);
            const empName = emp ? `${emp.first_name} ${emp.last_name}` : r.employee_id;
            const items = [...(r.settle || []), ...(r.absorb || [])];
            const open = recExpanded.approvals && recExpanded.approvals.has('rel' + r.id);
            return `
            <div class="rec-card${open ? ' open' : ''}" id="rec-approvals-rel${r.id}">
                <div class="rec-card-head" onclick="toggleRecCard('approvals','rel${r.id}')">
                    <span class="rec-caret" data-caret="approvals-rel${r.id}">${open ? '▾' : '▸'}</span>
                    <span class="rec-title">${escHtml(empName)} <span class="type-pill">${r.release_type === 'wd' ? t('week_in_deposit_opt') : t('last_paycheck_opt')}</span>${r.is_early ? ' <span class="type-pill" style="background:#b45309;color:#fff;">Early</span>' : ''}</span>
                    <span class="rec-sub">${t('d_requested_by')} ${escHtml(r.requested_by)}</span>
                    <span class="rec-right">${formatMoney(r.net_release)}</span>
                </div>
                <div class="rec-card-body">
                    <div class="rec-detail-grid">
                        <div><div class="k">${t('d_original_amount')}</div><div class="v">${formatMoney(r.saved_amount)}</div></div>
                        <div><div class="k">${t('d_net_to_release')}</div><div class="v" style="color:#059669;font-weight:700;">${formatMoney(r.net_release)}</div></div>
                        <div><div class="k">${t('d_requested')}</div><div class="v">${new Date(r.requested_at).toLocaleString()}</div></div>
                    </div>
                    ${items.length ? `<div class="detail-subhead" style="margin-top:8px;">${t('d_plan')}</div>
                    <div style="font-size:12px;">
                        ${(r.settle || []).map(i => `<div style="padding:3px 0;"><span class="type-pill">${i.type === 'claim' ? 'Claim' : 'Charge'}</span> ${i.id} — settle in full <span style="color:#dc2626;">−${formatMoney(i.amount)}</span></div>`).join('')}
                        ${(r.absorb || []).map(i => `<div style="padding:3px 0;"><span class="type-pill">${i.type === 'claim' ? 'Claim' : 'Charge'}</span> ${i.id} — declare a loss (Absorbed) <span style="color:#dc2626;">−${formatMoney(i.amount)}</span></div>`).join('')}
                        ${r.prepay ? `<div style="padding:3px 0;"><span class="type-pill">${r.prepay.type === 'claim' ? 'Claim' : 'Charge'}</span> ${r.prepay.id} — partial prepayment <span style="color:#7c3aed;">−${formatMoney(r.prepay.amount)}</span></div>` : ''}
                    </div>` : `<div style="font-size:12px; color:var(--text-muted); margin-top:6px;">${t('d_no_other_cc')}</div>`}
                    <div class="rec-actions">
                        <button class="btn-small" style="background:var(--primary);margin:0;" onclick="approveReleaseRequest(${r.id})">${t('d_approve')}</button>
                        <button class="del-btn" onclick="rejectReleaseRequest(${r.id})">${t('d_reject')}</button>
                    </div>
                </div>
            </div>`;
        }).join('');
    }

    async function approveReleaseRequest(id) {
        if (!confirm('Approve and execute this release now?')) return;
        const { error } = await supabaseClient.rpc('approve_release_request', { p_actor: currentUsername, p_request_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        renderReleaseRequests();
        await fetchChargesFromCloud();
        await fetchClaimsFromCloud();
        await loadChargeHistory();
        await loadEmployeeDetails();
        alert('Release approved and completed.');
    }

    async function rejectReleaseRequest(id) {
        if (!confirm('Reject this release request?')) return;
        const { error } = await supabaseClient.rpc('reject_release_request', { p_actor: currentUsername, p_request_id: id, p_reason: null });
        if (error) { alert('Error: ' + error.message); return; }
        renderReleaseRequests();
    }

    async function renderLog() {
        const tbody = document.getElementById('log-tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        // Map username -> role so we can filter the log by who made each change.
        const roleRank = { 'User': 1, 'Medium': 2, 'Administrator': 3, 'SuperAdmin': 4 };
        const roleMap = {};
        if (currentUsername) roleMap[currentUsername] = currentUserRole;
        if (currentUserRole !== 'SuperAdmin') {
            try {
                const { data: us } = await supabaseClient.rpc('list_users', { p_actor: currentUsername, p_company: currentCompany });
                (us || []).forEach(u => { roleMap[u.username] = u.role; });
            } catch (e) { /* if this fails, unknown actors are hidden below */ }
        }

        const { data, error } = await supabaseClient.rpc('list_audit_log', { p_actor: currentUsername, p_company: currentCompany, p_limit: 300 });
        if (error) { tbody.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">${error.message}</div>`; return; }

        let rows = data || [];
        if (currentUserRole !== 'SuperAdmin') {
            // Administrators see Administrator-and-below; Medium see Medium-and-below;
            // both only within their own company. (View-only never opens this tab.)
            const myRank = roleRank[currentUserRole] || 0;
            const myCompany = currentUser ? currentUser.company_code : null;
            rows = rows.filter(a => {
                if (myCompany && a.company_code && a.company_code !== myCompany) return false;
                const r = roleMap[a.actor];
                if (!r) return false;                      // higher-tier or other-company actor -> hidden
                return (roleRank[r] || 99) <= myRank;
            });
        }

        const container = document.getElementById('log-tbody');
        if (!rows.length) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_changes_logged')}</div>`; return; }

        rows = applySort(rows, 'log', {
            changed: a => a.changed_at || '', who: a => a.actor || '',
            table: a => a.table_name || '', field: a => a.field_name || ''
        });

        if (isDesktopView()) {
            container.className = '';
            let trs = '';
            rows.forEach(a => {
                trs += `<tr>
                    <td>${new Date(a.changed_at).toLocaleString()}</td>
                    <td>${a.actor}</td>
                    <td>${a.table_name}</td>
                    <td class="id-cell">${a.record_id}</td>
                    <td>${a.field_name}</td>
                    <td>${a.old_value ?? '-'}</td>
                    <td>${a.new_value ?? '-'}</td>
                </tr>`;
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th>${t('sort_when')}</th><th>${t('sort_who')}</th><th>${t('sort_table')}</th><th>${t('d_th_record')}</th><th>${t('sort_field')}</th><th>${t('d_th_old')}</th><th>${t('d_th_new')}</th>
            </tr></thead><tbody>${trs}</tbody></table></div>`;
            updateRecSortUI('log');
            return;
        }

        container.className = 'record-grid';
        container.innerHTML = '';
        rows.forEach((a, i) => {
            const open = recExpanded.log ? recExpanded.log.has(i) : false;
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-log-${i}">
                    <div class="rec-card-head" onclick="toggleRecCard('log',${i})">
                        <span class="rec-caret" data-caret="log-${i}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${a.actor}</span>
                        <span class="rec-sub">${new Date(a.changed_at).toLocaleString()}</span>
                        <span class="rec-right">${a.field_name}</span>
                    </div>
                    <div class="rec-card-body">
                        <div class="rec-detail-grid">
                            <div><div class="k">${t('sort_table')}</div><div class="v">${a.table_name}</div></div>
                            <div><div class="k">${t('d_record')}</div><div class="v id-cell">${a.record_id}</div></div>
                            <div><div class="k">${t('sort_field')}</div><div class="v">${a.field_name}</div></div>
                            <div><div class="k">${t('d_old_value')}</div><div class="v">${a.old_value ?? '-'}</div></div>
                            <div><div class="k">${t('d_new_value')}</div><div class="v">${a.new_value ?? '-'}</div></div>
                        </div>
                    </div>
                </div>`);
        });
        updateRecSortUI('log');
    }

    // ===== Appearance (Light / Dark theme) =====
    // ===== Language (English / Español) =====
    // First pass: navigation, login screen, and common header controls.
    // Not yet covered: form field labels within individual tabs, table
    // column headers, alert/confirm messages, and note-box help text — all
    // still English-only. Add more entries to TRANSLATIONS + tag more
    // elements with data-i18n to extend coverage over time.
    const TRANSLATIONS = {
        en: {
            welcome_prefix: 'Welcome,', role_label: 'Role:', company_label: 'Company:',
            synchronized: 'Synchronized', change_password_btn: 'Change Password', sign_out_btn: 'Sign Out',
            change_password_title: 'Change My Password', current_password: 'Current Password',
            new_password: 'New Password', confirm_new_password: 'Confirm New Password',
            save_password: 'Save Password', cancel: 'Cancel',
            group_logistics: 'Logistics', group_hr: 'HR & Payroll', group_admin: 'Administration',
            tab_tracker: 'Route Tracker', tab_report: 'Daily Report', tab_vehicles: 'Fleet',
            tab_notifications: 'Notifications', tab_employees: 'Employees', tab_claims: 'Claims & Charges',
            tab_charges: 'Charges & Income', tab_income: 'Income', tab_dailypay: 'Daily Pay', tab_statement: 'Statement',
            tab_payroll: 'Payroll', tab_settings: 'Settings', tab_users: 'Users', tab_companies: 'Companies',
            tab_approvals: 'Approvals', tab_log: 'Log', tab_data: 'Data Sync', tab_changelog: 'Changelog',
            login_title: 'Secure Login', username_label: 'Username', username_ph: 'Enter username',
            password_label: 'Password', sign_in_btn: 'Sign In',
            timeout_notice: 'You were signed out after 10 minutes of inactivity.',
            language_label: 'Language',
            language_note: 'Choose your language. This is saved on this device only, so other people signed in elsewhere keep their own preference. (Also available on the login screen.)',
            appearance_label: 'Appearance',
            clear_filters: '✕ Clear filters', sort_by: 'Sort by',
            new_contact: 'New Contact', next_id: 'Next ID', basic_info: 'Basic info',
            first_name: 'First Name', last_name: 'Last Name', person_type: 'Person Type',
            department: 'Department', role_title: 'Role / Title', start_date: 'Start Date',
            contact_info: 'Contact info', phone: 'Phone #', email: 'Email',
            identification: 'Identification', ssn_itin: 'SSN or ITIN #', type_label: 'Type',
            dl_or_state_id: 'Driver License or State ID #', dl_expiration: 'DL / State ID expiration',
            work_permit: 'Work Permit #', work_permit_exp: 'Work Permit expiration',
            medical_card: 'Medical Card', medical_card_exp: 'Medical Card expiration', notes: 'Notes',
            pay: 'Pay', pay_type: 'Pay Type', base_weekly_pay: 'Base Weekly Pay ($)',
            employee_note: 'Set <strong>Daily Rate</strong> for anyone whose pay changes week to week — enter their day-by-day amounts in the <strong>Daily Pay</strong> tab. On edit, leave <strong>SSN/ITIN</strong> blank to keep the stored number unchanged. Driver license, work permit, medical card and notes are shown openly in the directory; the SSN/ITIN stays hidden.',
            add_employee: '+ Add Employee', cancel_edit: 'Cancel edit',
            search_employees_ph: 'Search name, ID, department, type...',
            export_csv: 'Export CSV', import_csv: 'Import CSV',
            th_id: 'ID', th_name: 'Name', th_type: 'Type', th_department: 'Department',
            th_start: 'Start', th_pay: 'Pay', th_status: 'Status', th_action: 'Action',
            new_claim: 'New Claim', next_claim_id: 'Next Claim ID', claimant_account: 'Claimant account',
            company_field: 'Company', employee_field: 'Employee', carrier_claim_num: 'Carrier claim #',
            customer_claim_num: 'Customer claim #', type_of_damage: 'Type of damage', claim_amount: 'Claim amount',
            weekly_deduction: 'Weekly deduction', start_deduction_date: 'Start deduction date',
            end_deduction_date: 'End deduction date', status_field: 'Status', absorbed_amount: 'Absorbed amount',
            weeks_needed_note: 'Weeks needed = claim amount ÷ weekly deduction (rounded up), calculated automatically.',
            save_claim: '+ Save Claim', weekly_deduction_rate: 'Weekly deduction rate',
            new_weekly_amount: 'New weekly amount', effective_date: 'Effective date', add_rate_change: 'Add rate change',
            pause_resume: 'Pause / Resume', paused_date: 'Paused date', expected_resume: 'Expected resume (optional)',
            record_pause: 'Record pause', search_claims_ph: 'Search Claim ID, Employee, account, company...',
            import_excel_csv: 'Import Excel/CSV',
            th_claim_id: 'Claim ID', th_employee: 'Employee', th_emp_id: 'Emp. ID', th_claimant_acct: 'Claimant Acct',
            th_company: 'Company', th_carrier: 'Carrier #', th_customer: 'Customer #', th_damage_type: 'Damage Type',
            th_amount: 'Amount', th_weeks: 'Weeks', th_balance: 'Balance', th_absorbed: 'Absorbed', th_ends: 'Ends',
            employee_applies_both: 'Employee <span style="color:var(--text-muted); font-weight:400;">— for the new charge below</span>',
            new_charge: 'New Charge', next_charge_id: 'Next Charge ID', charge_type: 'Charge type', charge_amount: 'Charge amount',
            save_charge: '+ Save Charge', search_charges_ph: 'Search charge ID, employee, type, status...',
            new_additional_income: 'New Additional Income', next_income_id: 'Next Income ID', income_type: 'Income type',
            total_amount: 'Total amount', weekly_amount: 'Weekly amount', end_date: 'End date',
            income_note: 'Additional income is <strong>added</strong> to the employee\'s pay each week (the opposite of a charge) — the weekly amount is paid out until the total is reached, then it stops automatically.',
            save_income: '+ Save Income', search_income_ph: 'Search income ID, employee, type, status...',
            th_charge_id: 'Charge ID', th_income_id: 'Income ID', th_type: 'Type', th_weekly: 'Weekly', th_remaining: 'Remaining',
            // --- R1: shell, login 2FA step, overlays ---
            twofa_menu: 'Two-Factor Authentication', signout_other_devices: 'Sign out my other devices',
            two_step_title: 'Two-step verification',
            two_step_help: 'Enter the 6-digit code from your authenticator app. You can also use one of your recovery codes.',
            verify_btn: 'Verify', back_to_signin: '← Back to sign in',
            twofa_setup_title: 'Set up two-factor authentication',
            twofa_step1: '1. Add this account to an authenticator app',
            twofa_apps_note: 'Use Google Authenticator, Microsoft Authenticator, Authy, 1Password, or any TOTP app.',
            twofa_open_app: '📲 Open in authenticator app', twofa_manual_key: 'Or enter this key manually:',
            copy_btn: 'Copy', twofa_step2_label: '2. Enter the 6-digit code it shows',
            twofa_verify_on: 'Verify & turn on', try_again_btn: 'Try again', skip_for_now: 'Skip for now',
            twofa_is_on: '✅ Two-factor authentication is on', twofa_save_recovery: 'Save your recovery codes',
            twofa_recovery_help: 'Each code works once. If you ever lose your phone, a recovery code lets you sign in. Keep them somewhere safe — they are shown only now.',
            twofa_copy_codes: 'Copy codes', twofa_saved_ack: 'I have saved these recovery codes', done_btn: 'Done',
            twofa_intro_mandatory: 'Your role recommends two-factor authentication. Set it up now, or skip — we’ll remind you again in 15 days.',
            twofa_intro_optional: 'Add a second step at sign-in for extra security.',
            unusual_activity_title: 'Unusual sign-in activity', gso_cancel_admin: 'Cancel (admin)',
            gso_title: '🚪 Sign Out All Users', gso_everyone_pre: 'Everyone',
            gso_everyone_post: 'will get a countdown warning and then be signed out of all devices. Their unsaved work will be lost.',
            gso_grace_period: 'Grace period', mins_5: '5 minutes', mins_10: '10 minutes', mins_15: '15 minutes',
            mins_2: '2 minutes', mins_1: '1 minute', gso_reason_label: 'Reason (optional — shown to everyone)',
            gso_reason_ph: 'e.g. system maintenance', gso_type_pre: 'Type', gso_type_post: 'to confirm',
            gso_start: 'Start sign-out', gso_scope_all: 'in every company', gso_scope_company: 'in your company',
            idle_title: 'Still there?', idle_pre: 'You’ll be signed out in',
            idle_post: 's due to inactivity. Any unsaved changes could be lost.', idle_stay: 'Stay signed in',
            // --- R2: Settings, Home, Notifications ---
            id_config: 'ID Configuration',
            id_config_note: 'Changes here only affect <strong>new</strong> IDs going forward — Employee, Claim, and Charge IDs already assigned won\'t change. The ID <strong>prefix is the company code</strong> (set when a company is added), so switch companies up top to control it.',
            emp_id_digits: 'Employee ID digits', claim_id_digits: 'Claim ID digits', charge_id_digits: 'Charge ID digits',
            charge_id_suffix: 'Charge ID suffix', save_id_format: 'Save ID format',
            damage_type_panel: 'Type of Damage (Claims)', add_damage_type: 'Add a new damage type', damage_type_ph: 'e.g. Water damage',
            add_btn: 'Add', charge_type_panel: 'Charge Type (Charges)', add_charge_type: 'Add a new charge type', charge_type_ph: 'e.g. Advance',
            th_charge_type: 'Charge Type', income_type_panel: 'Additional Income Type', add_income_type: 'Add a new income type',
            income_type_ph: 'e.g. Bonus', th_income_type: 'Income Type',
            home_subtitle: 'Here\'s where things stand right now.',
            notif_note: 'New claims, charges, and additional income you\'ve been assigned show up here. Tap one to jump straight to it. View Only accounts only ever see their own — everyone else sees their whole company\'s, same as the rest of the app.',
            date_range: 'Date range', range_all: 'All time', range_30: 'Last 30 days', range_60: 'Last 60 days',
            range_90: 'Last 90 days', range_365: 'Last year', sort_short: 'Sort', opt_date: 'Date', mark_all_read: 'Mark all as read',
            // --- R3: Logistics (Tracker, Report, Fleet, Expiring) ---
            log_new_route: 'Log New Route', delivery_date: 'Delivery Date', route_type: 'Route Type', third_man: '3rd Man',
            driver: 'Driver', route_num: 'Route #', route_id: 'Route ID', miles: 'Miles', manifest_stops: 'Manifest Stops',
            pullbacks: 'Pullbacks', incompletes: 'Incompletes', dedicated_flat_pay: 'Dedicated Flat Pay', deductions: 'Deductions',
            extra_pay: 'Extra Pay', add_route: '+ Add Route', th_regded: 'Reg/Ded', th_loaded: 'Loaded Stops',
            th_completed: 'Completed Stops', th_mileage_pay: 'Mileage pay', th_fuel_pay: 'Fuel pay', th_total_daily: 'Total Daily Pay',
            th_total_route: 'Total Pay per Route',
            year_label: 'Year', week_label: 'Week', expand_all: '➕ Expand All', collapse_all: '➖ Collapse All', row_labels: 'Row Labels',
            th_delivery_area: 'Delivery Area*', th_miles2: 'Miles**', th_manifest2: 'Manifest Stops**', th_pullbacks2: 'Pullbacks**',
            th_loaded2: 'Loaded Stops*', th_incompletes2: 'Incompletes*', th_completed2: 'Completed Stops*', th_mileage2: 'Mileage pay*',
            th_fuel2: 'Fuel pay**', th_thirdman2: '3rd. Man.**', th_dedicated_flat: 'Dedicated Flat*', th_deductions2: 'Deductions*',
            th_extra2: 'Extra Pay*', th_total_route2: 'Total Pay per Route*',
            add_vehicle_title: 'Add Vehicle', truck_num: 'Truck #', truck_num_ph: 'Company ID #', make: 'Make', make_ph: 'e.g. Freightliner',
            model: 'Model', model_ph: 'e.g. Cascadia', license_plate: 'License Plate', reg_expiry: 'Registration Expiry',
            ins_company: 'Insurance Company', policy_number: 'Policy Number', ins_expiry: 'Insurance Expiry', add_vehicle_btn: '+ Add Vehicle',
            sched_maint: '📅 Schedule Maintenance', truck: 'Truck', date_label: 'Date', description: 'Description',
            sched_desc_ph: 'e.g. Oil Change, DOT Inspection', schedule_btn: '+ Schedule',
            vehicle_search_ph: 'Search truck #, year, make, model, plate, VIN...', export_btn: '⬇️ Export', import_btn: '⬆️ Import',
            opt_vehicle: 'Vehicle', opt_plate: 'Plate', opt_reg_exp: 'Reg. Expiry',
            expiring_title: 'Expiring Documents',
            expiring_note: 'Registration and insurance from Fleet, plus driver license, work permit, and medical card from Employees — all in one place, soonest first. Already-expired items show at the top.',
            show_within: 'Show within', days_30: '30 days', days_60: '60 days', days_90: '90 days', year_1: '1 year',
            everything_on_file: 'Everything on file', category: 'Category', all_categories: 'All categories', fleet_only: 'Fleet only',
            emp_docs_only: 'Employee documents only', expiring_search_ph: 'Search name, truck #...',
            // --- R3b: HR/Payroll (Statement, Daily Pay, Week Deposit, Provider Pay, Payroll, Savings & Release, Release History) ---
            all_types: 'All types', contractor: 'Contractor', opt_employee: 'Employee', opt_provider: 'Provider', opt_staff: 'Staff',
            active_opt: 'Active', inactive_opt: 'Inactive', all_statuses: 'All statuses', active_only: 'Active only',
            search_name_id_ph: 'Search name or ID...', prev_btn: '◀ Prev', next_btn: 'Next ▶', this_week: 'This week',
            print_btn: '🖨 Print', saved_flash: 'Saved ✓', select_employee_opt: '— Select employee —',
            optional_ph: 'optional', save_changes: '💾 Save changes',
            dailypay_title: 'Daily Pay Timesheet', import_registry: 'Import Registry',
            dailypay_note: 'Enter each person\'s pay for the days they worked (Sun–Sat). Tap <strong>OFF</strong> for days off — those are skipped in the week total. Entries save automatically and are kept per week, so you can browse any past week with the arrows. Only people set to <strong>Daily Rate</strong> appear here (change a person\'s pay type in the Employees tab).',
            weekdeposit_note: 'These are read from the existing <strong>Semana de Fondo</strong> charges already recorded on the Charges &amp; Income tab — a savings goal, built up week by week. This view doesn\'t create new ones; add a new deposit the same way as any other charge, using "Semana de Fondo" as the charge type.',
            edit_deposit: 'Edit Deposit', savings_goal: 'Savings Goal ($)', weekly_saving: 'Weekly Saving ($)',
            deducting_opt: 'Deducting', paid_opt: 'Paid', absorbed_opt: 'Absorbed',
            summary_report_excel: '📊 Summary Report (Excel)', summary_report_pdf: '📊 Summary Report (PDF)',
            providerpay_title: 'Provider Pay',
            providerpay_note: 'Enter each provider\'s pay for the week — a single amount, since providers aren\'t on a flat rate. Saves automatically and is kept per week, so you can browse any past week with the arrows. Only people set to <strong>Provider</strong> pay type appear here (change a person\'s pay type in the Employees tab). Feeds into Payroll the same way Daily Pay does. <strong>Linked to Bills Payable:</strong> any unpaid bill whose vendor matches a provider\'s name shows under that provider — tick one or more and tap “Pay selected” to mark those bills Paid and add their total to this week\'s amount.',
            payroll_title: 'Payroll Summary', print_all: '🖨 Print All',
            payroll_note: 'Net pay = base pay + route pay (drivers) + additional income − active weekly deductions (claims + charges currently being deducted). Base pay is the flat <strong>weekly salary</strong> for Weekly people, or this week\'s <strong>Daily Pay</strong> total for Daily-rate people. Route pay, additional income, and daily pay all use the current week.',
            savings_release_title: 'Savings & Release Eligibility',
            savingsrelease_note: 'Checks are issued Thursdays and handed over Saturdays. Week in Deposit can\'t be released earlier than <strong>90 days</strong> after an employee\'s Last Date Worked; that same employee\'s last week worked pay can\'t be released earlier than <strong>30 days</strong> after it. "Pending/outstanding" includes any claim or charge — any status — with a real balance, or (claims only) a leftover absorbed amount.',
            search_employee_ph: 'Search employee...', week_in_deposit_opt: 'Week in Deposit', last_paycheck_opt: 'Last Paycheck',
            all_eligibility: 'All eligibility', ready_release_now: 'Ready to release now', not_yet_eligible: 'Not yet eligible',
            release_history_title: 'Release History',
            releasehistory_note: 'Permanent record of every Week in Deposit and Last Paycheck release — original amount, what was deducted toward other claims/charges, and what actually reached the employee.',
            search_emp_releasedby_ph: 'Search employee, released by...',
            early_ontime: 'Early & on-time', early_only: 'Early only', ontime_only: 'On-time only',
            // --- R4: Messages, Invoices, Bills, Users, Companies, Approvals, Log, Data Sync, Changelog ---
            dm_search_ph: 'Search conversations...', pill_all: 'All', pill_general: 'General', pill_missing_day: 'Missing Day',
            pill_claims: 'Claims', pill_charges: 'Charges', pill_income: 'Income', dm_compose_ph: 'Type a message...',
            dm_empty_state: 'Select a person on the left to start a conversation.',
            new_invoice_title: 'New Invoice', edit_invoice_title: 'Edit Invoice', save_invoice_btn: '+ Save Invoice', update_invoice_btn: '✎ Update Invoice',
            inv_number: 'Invoice #', inv_customer: 'Customer', inv_date: 'Invoice Date', due_date: 'Due Date', bill_to: 'Bill To',
            unpaid_opt: 'Unpaid', void_opt: 'Void',
            inv_number_ph: 'e.g. 0169', inv_customer_ph: 'e.g. Tramo', inv_billto_ph: 'Company, address, contact — as it appears on the invoice',
            line_items: 'Line Items', add_line: '+ Add Line',
            invoice_search_ph: 'Search invoice #, customer, notes...', all_customers: 'All customers',
            new_bill_title: 'New Bill', edit_bill_title: 'Edit Bill', save_bill_btn: '+ Save Bill', update_bill_btn: '✎ Update Bill',
            vendor: 'Vendor', vendor_bill_num: 'Vendor\'s Bill #', bill_date: 'Bill Date', amount_label: 'Amount',
            bill_vendor_ph: 'e.g. ABC Fuel Co, or pick a provider', bill_number_ph: 'e.g. INV-9001',
            bill_search_ph: 'Search vendor, bill #, notes...', all_vendors: 'All vendors',
            create_user_title: 'Create New User Profile', role_field: 'Role', assign_employee: 'Assign to Employee',
            create_user_btn: '+ Create User', system_users: 'System Users', refresh_btn: '↻ Refresh',
            active_sessions: 'Active sessions', session_signout_note: 'Signing a session out takes effect immediately.',
            failed_signins: 'Recent failed sign-ins',
            failed_signins_note: 'Last 7 days. An account locks for 5 minutes after 5 failures; a network locks for 15 minutes after 30.',
            gso_history: 'Global sign-out history',
            gso_history_note: 'Every \'Sign Out All Users\' action: who started it, when, why, and how many were affected.',
            add_company_title: 'Add Company', add_company_btn: '+ Add Company', save_changes_plain: 'Save changes', editing_prefix: 'Editing',
            company_section: 'Company', company_code: 'Company Code (3–4 chars)', company_name: 'Company Name',
            ownership_contact: 'Ownership & contact', owner_label: 'Owner', manager_label: 'Manager', manager_phone: 'Manager Phone #',
            company_code_ph: 'e.g. 3FL', company_name_ph: 'e.g. 3 Of Life LLC', owner_ph: 'Owner name', phone_ph: '(555) 555-5555',
            email_ph: 'name@example.com', manager_ph: 'Manager name', companies_title: 'Companies',
            pending_approvals: 'Pending Approvals',
            approvals_note: 'Locked financial changes (base pay rate, claim amount, weekly deduction) requested by Medium users appear here for Administrator approval.',
            pending_release_requests: 'Pending Release Requests',
            release_requests_note: 'A Medium user\'s Week in Deposit or Last Paycheck release — normal or early — always lands here first. Nothing is released until an Administrator approves it.',
            change_log_title: 'Change Log',
            log_note: 'Every applied change to employees, claims, charges, and routes is recorded here.',
            export_data_title: 'Export Data', download_excel_backup: '⬇️ Download Excel Backup (Route Tracker only)',
            export_all_data: '⬇️ Export All Data (single file)',
            export_all_note: 'One .xlsx file with a separate sheet for Employees, Claims, Charges, Additional Income, Vehicles, Routes, Daily Pay, and Provider Pay — everything you have access to, in one download. Employee SSN/ITIN is never included in any export.',
            import_all_title: 'Import All Data (single file)',
            import_all_note: 'Upload a file exported from <strong>Export All Data</strong> above (or hand-edited to match its column layout) to restore Claims, Charges, Additional Income, Vehicles, Routes, Daily Pay, and Provider Pay in one pass — matched to existing employees by Employee ID. Doesn\'t touch Employees themselves; use Import CSV on the Employees tab for that.',
            import_sync_routes_title: 'Import & Sync Routes from Excel (Tab: Tracker)',
            admin_danger_title: 'Administrator Management & Reset Zone',
            admin_danger_note: 'These actions are restricted to <strong>Administrator</strong> users only.',
            del_all_routes: '🗑️ Delete All Routes', del_all_claims: '🗑️ Delete All Claims', del_all_charges: '🗑️ Delete All Charges',
            del_all_users: '🗑️ Delete All Users', reset_all_except_users: '⚠️ Reset All Data (Except Users)',
            gso_signout_note: 'Gives everyone a countdown warning, then signs them out of all devices. Administrators affect their own company; Super Admin affects everyone.',
            sysreset_title: 'System Reset — Super Admin Only',
            sysreset_note: 'Removes every user account except Super Admins, and clears the audit Log and pending Approvals. Companies and everything that belongs to them — employees, claims, charges, routes, income — are <strong>not</strong> touched. Cannot be undone.',
            reset_system_btn: '☢️ Reset System (Keep Companies & Super Admin)',
            changelog_title: 'Changelog',
            changelog_note: 'Every change delivered to this app, newest first — stored server-side so this history survives even across app file changes. Only visible to Super Admin.',
            search_results_title: 'Search results',
            // --- R4b: record-grid sort-dropdown options ---
            sort_kind: 'Kind', sort_start_ded: 'Start ded.', sort_start: 'Start', sort_base: 'Base (wk)',
            sort_gross: 'Gross', sort_net: 'Net', sort_bill_num: 'Bill #', sort_employee_id: 'Employee ID',
            sort_created: 'Created', sort_code: 'Code', sort_requested: 'Requested', sort_requested_by: 'Requested by',
            sort_table: 'Table', sort_field: 'Field', sort_when: 'When', sort_who: 'Who',
            // --- R5a: dynamic card chrome — Employees & Fleet ---
            d_type: 'Type', d_department: 'Department', d_start_date: 'Start date', d_pay: 'Pay', d_status: 'Status',
            d_edit: 'Edit', d_delete: '✕ Delete', d_phone: 'Phone', d_email: 'Email', d_ssn_itin: 'SSN / ITIN',
            d_dl_stateid: 'Driver License / State ID', d_dl_exp: 'DL Expiration', d_wp_num: 'Work Permit #', d_wp_exp: 'Work Permit Expiration',
            d_medcard: 'Medical Card', d_medcard_exp: 'Medical Card Expiration', d_role_title: 'Role / Title', d_notes: 'Notes',
            d_status_history: 'Status history', d_generate_user: 'Generate User', d_loading: 'Loading…',
            d_no_status_changes: 'No status changes recorded yet.', d_th_date: 'Date', d_th_change: 'Change', d_th_by: 'By',
            d_no_employees: 'No employees found.', d_no_vehicles: 'No vehicles yet.', d_nothing_expiring: 'Nothing expiring in this window.',
            d_no_upcoming_maint: 'No upcoming maintenance scheduled.', d_no_service_records: 'No service records yet.',
            d_already_expired: 'Already expired', d_within_14: 'Within 14 days', d_total_shown: 'Total shown',
            d_edit_vehicle_record: '✎ Edit vehicle record', d_edit_employee_record: '✎ Edit employee record',
            d_stat_fleet: 'Fleet', d_stat_reg_exp: 'Reg. expiring/expired', d_stat_ins_exp: 'Insurance expiring/expired',
            d_th_id: 'ID', d_th_truck: 'Truck #', d_th_vehicle: 'Vehicle', d_th_plate: 'Plate', d_th_reg_exp: 'Reg. Expiry',
            d_th_ins_co: 'Insurance Co.', d_th_ins_exp: 'Insurance Expiry',
            d_reg_expiry: 'Registration expiry', d_insurance_company: 'Insurance company', d_policy_num: 'Policy #', d_insurance_expiry: 'Insurance expiry',
            d_license_plate: 'License plate', d_vin: 'VIN', d_service_log: 'Service Log', d_mileage_at_service: 'Mileage at service',
            d_next_service_due: 'Next service due at', d_add: '+ Add', d_service_desc_ph: 'e.g. Oil Change, Tire Rotation',
            // --- R5a: dynamic card chrome — Claims, Charges, Income ---
            d_no_cc: 'No claims or charges found.', d_th_kind: 'Kind', d_employee: 'Employee', d_employee_id: 'Employee ID',
            d_claimant_acct: 'Claimant acct', d_company: 'Company', d_carrier_claim: 'Carrier claim #', d_customer_claim: 'Customer claim #',
            d_type_damage: 'Type of damage', d_claim_amount: 'Claim amount', d_weeks: 'Weeks', d_balance: 'Balance', d_absorbed: 'Absorbed',
            d_start_ded: 'Start ded.', d_end_ded: 'End ded.', d_edit_full: '✎ Edit',
            d_charge_type: 'Charge type', d_amount: 'Amount', d_weekly_deduction: 'Weekly deduction',
            d_income_type: 'Income type', d_weekly_amount: 'Weekly amount', d_start: 'Start', d_ends: 'Ends',
            d_no_income: 'No additional income found.',
            d_income_setup_note: 'Run the income setup SQL (the <strong>additional_income</strong> table) to start logging additional income.',
            d_th_effective: 'Effective', d_th_weekly: 'Weekly', d_no_rate_changes: 'No rate changes — using the base weekly amount.',
            d_th_paused: 'Paused', d_th_resume: 'Resume', d_no_pauses: 'No pauses recorded yet.',
            // --- R5a: dynamic card chrome — Payroll ---
            d_no_people_match: 'No people match these filters.', d_th_name: 'Name',
            d_base_wk: 'Base (wk)', d_route_wk: 'Route (wk)', d_income_wk: 'Income (wk)', d_gross: 'Gross', d_deductions_h: 'Deductions', d_net: 'Net',
            d_base_pay_wk: 'Base pay (wk)', d_route_pay_wk: 'Route pay (wk)', d_weekly_deductions: 'Weekly deductions', d_net_pay: 'Net pay',
            d_people: 'People', d_gross_wk: 'Gross (wk)', d_deductions_wk: 'Deductions (wk)', d_net_pay_wk: 'Net Pay (wk)',
            d_th_day: 'Day', d_th_pay: 'Pay', d_base_daily_total: 'Base (daily total)', d_provider_pay: 'Provider pay', d_weekly_salary: 'Weekly salary',
            d_route_pay_dot: 'Route pay', d_th_route: 'Route', d_route_total: 'Route total',
            d_no_daily_pay: 'No daily pay entered for', d_no_provider_pay: 'No provider pay entered for',
            d_additional_income: 'Additional income', d_income_total: 'Income total', d_total_deductions: 'Total deductions', d_no_active_ded: 'No active weekly deductions.',
            d_print_payslip: '🖨 Print payslip', d_paid_days_base: 'Paid days / base pay',
            // --- R5a: dynamic card chrome — Statement, Week Deposit, Savings/Release, Release History, Pay ---
            d_stat_claims: 'Claims', d_stat_charges: 'Charges', d_stat_add_income: 'Additional income',
            d_total_claims: 'Total claims', d_total_charges: 'Total charges', d_total_income: 'Total income',
            d_select_emp_stmt: 'Select an employee above to see their statement.', d_current_deductions: 'Current deductions — full breakdown',
            d_no_current_cc: 'No current claims or charges for this employee.', d_add_income_breakdown: 'Additional income — full breakdown',
            d_claimant_account: 'Claimant account', d_weekly_rate: 'Weekly rate', d_weeks_to_zero: 'Weeks to $0', d_paid_so_far: 'Paid so far',
            d_print_schedule: '🖨 Print schedule', d_th_deducted: 'Deducted', d_th_running_balance: 'Running balance',
            d_no_schedule_claim: 'No schedule to project — the claim is resolved, or needs a start date and weekly amount.',
            d_no_schedule_charge: 'No schedule to project — the charge is resolved, or needs a start date and weekly amount.',
            d_weekly: 'Weekly', d_remaining: 'Remaining',
            d_goal: 'Goal', d_weekly_saving: 'Weekly saving', d_saved_so_far: 'Saved so far', d_remaining_to_goal: 'Remaining to goal',
            d_of_goal: 'of goal', d_release: '🔓 Release', d_early_release: '⏰ Early Release', d_th_saved_week: 'Saved that week',
            d_total_saved: 'Total saved', d_active_deposits: 'Active deposits', d_total_remaining: 'Total remaining', d_no_deposits: 'No deposits found.',
            d_ready_now: 'Ready to release now', d_total_tracked: 'Total tracked', d_wid_savings: 'Week in Deposit savings',
            d_nothing_savings: 'Nothing to show — no open Week in Deposit savings and no Inactive employees with an unreleased last paycheck (matching the current filters).',
            d_pending_elsewhere: 'Pending/outstanding elsewhere', d_eligible_date: 'Eligible date', d_check_issued: 'Check issued (Thu)',
            d_handed_over: 'Handed over (Sat)', d_not_eligible_until: 'Not eligible until',
            d_total_releases: 'Total Releases', d_net_released_emp: 'Net Released to Employees', d_total_applied_ded: 'Total Applied to Deductions',
            d_early_releases: 'Early Releases', d_no_releases: 'No releases recorded yet (matching the current filters).',
            d_base_pay: 'Base Pay', d_additional_income_c: 'Additional Income', d_original_amount: 'Original Amount',
            d_total_deductions_c: 'Total Deductions', d_final_released: 'Final Amount Released', d_requested_via: 'Requested via approval?',
            d_applied_to: 'Applied to', d_no_other_outstanding: 'No other outstanding claims or charges at the time of release.', d_by: 'by',
            d_no_pending_release: 'No pending release requests.', d_net_to_release: 'Net to Release', d_requested: 'Requested', d_plan: 'Plan',
            d_no_other_cc: 'No other outstanding claims or charges.', d_approve: 'Approve', d_reject: '✕ Reject', d_requested_by: 'requested by',
            d_no_provider_set: 'No one is set to <strong>Provider</strong> pay yet. Go to the Employees tab and switch a person\'s Pay to <em>Provider</em>.',
            d_amount_this_week: 'Amount this week', d_notes_optional: 'Notes (optional)', d_provider_notes_ph: 'e.g. invoice #, what for', d_total_this_week: 'Total this week',
            d_dp_setup: '⚙️ <strong>One-time setup needed.</strong> The daily-pay tables don\'t exist in your database yet, so entries can\'t be saved. Ask your admin to run the short SQL setup (provided with this update) in Supabase → SQL Editor. Everything else in the app keeps working normally.',
            d_no_daily_set: 'No one is set to <strong>Daily Rate</strong> yet. Go to the Employees tab and switch a person\'s Pay to <em>Daily</em> (the ↺ button in the Pay column).',
            d_week_total: 'Week Total',
            // --- R5a: dynamic card chrome — Companies, Invoices, Bills, Approvals, Log, Notifications, Messages, Home, Changelog, Users/Sessions ---
            d_no_companies: 'No companies yet.', d_created: 'Created', d_manager_phone: 'Manager Phone',
            d_no_line_items: 'No line items.', d_no_line_items_hint: 'No line items yet — click "+ Add Line", or just save with the total below alone.', d_desc_route_ph: 'Description / route', d_rate_ph: 'Rate', d_qty_ph: 'Qty', d_extra_ph: 'Extra', d_amount_ph: 'Amount',
            d_stat_unpaid: 'Unpaid', d_invoiced_month: 'Invoiced This Month', d_total_invoices: 'Total Invoices', d_no_invoices: 'No invoices found.',
            d_overdue: 'Overdue', d_total_bills: 'Total Bills', d_no_bills: 'No bills found.',
            d_no_pending: 'No pending requests.', d_th_requested_by: 'Requested By', d_th_record: 'Record', d_th_old: 'Old', d_th_new: 'New', d_th_requested: 'Requested',
            d_record: 'Record', d_old_value: 'Old value', d_new_value: 'New value',
            d_no_changes_logged: 'No changes logged yet.',
            d_no_notifs: 'No notifications in this range.',
            d_no_convos: 'No conversations yet. Tap + to start one.', d_you_prefix: 'You:', d_new_conversation: 'New conversation', d_pick_person: '— Pick a person —', d_open_chat: 'Open chat',
            d_home_active_emps: 'Active Employees', d_home_open_claims: 'Open Claims', d_home_active_charges: 'Active Charges', d_home_income_week: 'Income This Week', d_home_expiring: 'Expiring Soon', d_home_unread: 'Unread Notifications',
            d_no_versions: 'No versions logged yet.', d_current: 'Current',
            d_no_sessions: 'No active sessions.', d_th_user: 'User', d_th_started: 'Started', d_th_last_seen: 'Last seen', d_th_ends: 'Ends', d_sign_out_btn: 'Sign out', d_this_device: 'This device',
            d_no_failed: 'No failed sign-ins in the last 7 days.', d_th_type: 'Type', d_th_who: 'Who', d_th_failed: 'Failed', d_th_last_attempt: 'Last attempt',
            d_no_users: 'No users found.', d_restricted: 'Restricted', d_id_btn: '🪪 ID', d_reset_pw: '🔑 Reset', d_reset_2fa: '🔐 Reset 2FA',
            d_no_gso: 'No global sign-outs yet.', d_th_initiator: 'Initiator', d_th_scope: 'Scope', d_th_grace: 'Grace', d_th_affected: 'Affected', d_th_reason: 'Reason', d_all_companies: 'All companies'
        },
        es: {
            welcome_prefix: 'Bienvenido,', role_label: 'Rol:', company_label: 'Compañía:',
            synchronized: 'Sincronizado', change_password_btn: 'Cambiar Contraseña', sign_out_btn: 'Cerrar Sesión',
            change_password_title: 'Cambiar Mi Contraseña', current_password: 'Contraseña Actual',
            new_password: 'Nueva Contraseña', confirm_new_password: 'Confirmar Nueva Contraseña',
            save_password: 'Guardar Contraseña', cancel: 'Cancelar',
            group_logistics: 'Logística', group_hr: 'RR. HH. y Nómina', group_admin: 'Administración',
            tab_tracker: 'Rastreador de Rutas', tab_report: 'Informe Diario', tab_vehicles: 'Flota',
            tab_notifications: 'Notificaciones', tab_employees: 'Empleados', tab_claims: 'Reclamos y Cargos',
            tab_charges: 'Cargos e Ingresos', tab_income: 'Ingresos', tab_dailypay: 'Pago Diario', tab_statement: 'Estado de Cuenta',
            tab_payroll: 'Nómina', tab_settings: 'Configuración', tab_users: 'Usuarios', tab_companies: 'Compañías',
            tab_approvals: 'Aprobaciones', tab_log: 'Registro', tab_data: 'Sincronización de Datos', tab_changelog: 'Historial de Cambios',
            login_title: 'Iniciar Sesión', username_label: 'Usuario', username_ph: 'Ingrese su usuario',
            password_label: 'Contraseña', sign_in_btn: 'Iniciar Sesión',
            timeout_notice: 'Se cerró su sesión después de 5 minutos de inactividad.',
            language_label: 'Idioma',
            language_note: 'Elija su idioma. Esto se guarda solo en este dispositivo, así que otras personas conectadas en otro lugar mantienen su propia preferencia. (También disponible en la pantalla de inicio de sesión.)',
            appearance_label: 'Apariencia',
            clear_filters: '✕ Limpiar filtros', sort_by: 'Ordenar por',
            new_contact: 'Nuevo Contacto', next_id: 'Próximo ID', basic_info: 'Información básica',
            first_name: 'Nombre', last_name: 'Apellido', person_type: 'Tipo de Persona',
            department: 'Departamento', role_title: 'Puesto / Cargo', start_date: 'Fecha de Inicio',
            contact_info: 'Información de contacto', phone: 'Teléfono', email: 'Correo electrónico',
            identification: 'Identificación', ssn_itin: 'SSN o ITIN #', type_label: 'Tipo',
            dl_or_state_id: 'Licencia de Conducir o ID Estatal #', dl_expiration: 'Vencimiento de Licencia/ID Estatal',
            work_permit: 'Permiso de Trabajo #', work_permit_exp: 'Vencimiento del Permiso de Trabajo',
            medical_card: 'Tarjeta Médica', medical_card_exp: 'Vencimiento de Tarjeta Médica', notes: 'Notas',
            pay: 'Pago', pay_type: 'Tipo de Pago', base_weekly_pay: 'Pago Semanal Base ($)',
            employee_note: 'Elija <strong>Pago Diario</strong> para cualquier persona cuyo pago cambie semana a semana — ingrese sus montos día a día en la pestaña <strong>Pago Diario</strong>. Al editar, deje <strong>SSN/ITIN</strong> en blanco para mantener el número guardado sin cambios. La licencia de conducir, el permiso de trabajo, la tarjeta médica y las notas se muestran abiertamente en el directorio; el SSN/ITIN permanece oculto.',
            add_employee: '+ Agregar Empleado', cancel_edit: 'Cancelar edición',
            search_employees_ph: 'Buscar nombre, ID, departamento, tipo...',
            export_csv: 'Exportar CSV', import_csv: 'Importar CSV',
            th_id: 'ID', th_name: 'Nombre', th_type: 'Tipo', th_department: 'Departamento',
            th_start: 'Inicio', th_pay: 'Pago', th_status: 'Estado', th_action: 'Acción',
            new_claim: 'Nuevo Reclamo', next_claim_id: 'Próximo ID de Reclamo', claimant_account: 'Cuenta del reclamante',
            company_field: 'Compañía', employee_field: 'Empleado', carrier_claim_num: 'N.º de reclamo del transportista',
            customer_claim_num: 'N.º de reclamo del cliente', type_of_damage: 'Tipo de daño', claim_amount: 'Monto del reclamo',
            weekly_deduction: 'Deducción semanal', start_deduction_date: 'Fecha de inicio de deducción',
            end_deduction_date: 'Fecha de fin de deducción', status_field: 'Estado', absorbed_amount: 'Monto absorbido',
            weeks_needed_note: 'Semanas necesarias = monto del reclamo ÷ deducción semanal (redondeado hacia arriba), calculado automáticamente.',
            save_claim: '+ Guardar Reclamo', weekly_deduction_rate: 'Tasa de deducción semanal',
            new_weekly_amount: 'Nuevo monto semanal', effective_date: 'Fecha de vigencia', add_rate_change: 'Agregar cambio de tasa',
            pause_resume: 'Pausar / Reanudar', paused_date: 'Fecha de pausa', expected_resume: 'Reanudación esperada (opcional)',
            record_pause: 'Registrar pausa', search_claims_ph: 'Buscar ID de Reclamo, Empleado, cuenta, compañía...',
            import_excel_csv: 'Importar Excel/CSV',
            th_claim_id: 'ID de Reclamo', th_employee: 'Empleado', th_emp_id: 'ID Empleado', th_claimant_acct: 'Cuenta Reclamante',
            th_company: 'Compañía', th_carrier: 'N.º Transportista', th_customer: 'N.º Cliente', th_damage_type: 'Tipo de Daño',
            th_amount: 'Monto', th_weeks: 'Semanas', th_balance: 'Saldo', th_absorbed: 'Absorbido', th_ends: 'Finaliza',
            employee_applies_both: 'Empleado <span style="color:var(--text-muted); font-weight:400;">— para el nuevo cargo abajo</span>',
            new_charge: 'Nuevo Cargo', next_charge_id: 'Próximo ID de Cargo', charge_type: 'Tipo de cargo', charge_amount: 'Monto del cargo',
            save_charge: '+ Guardar Cargo', search_charges_ph: 'Buscar ID de cargo, empleado, tipo, estado...',
            new_additional_income: 'Nuevo Ingreso Adicional', next_income_id: 'Próximo ID de Ingreso', income_type: 'Tipo de ingreso',
            total_amount: 'Monto total', weekly_amount: 'Monto semanal', end_date: 'Fecha de fin',
            income_note: 'El ingreso adicional se <strong>suma</strong> al pago del empleado cada semana (lo opuesto a un cargo) — el monto semanal se paga hasta alcanzar el total, y luego se detiene automáticamente.',
            save_income: '+ Guardar Ingreso', search_income_ph: 'Buscar ID de ingreso, empleado, tipo, estado...',
            th_charge_id: 'ID de Cargo', th_income_id: 'ID de Ingreso', th_type: 'Tipo', th_weekly: 'Semanal', th_remaining: 'Restante',
            // --- R1: shell, login 2FA step, overlays ---
            twofa_menu: 'Autenticación de Dos Factores', signout_other_devices: 'Cerrar sesión en mis otros dispositivos',
            two_step_title: 'Verificación en dos pasos',
            two_step_help: 'Ingrese el código de 6 dígitos de su app de autenticación. También puede usar uno de sus códigos de recuperación.',
            verify_btn: 'Verificar', back_to_signin: '← Volver a iniciar sesión',
            twofa_setup_title: 'Configurar la autenticación de dos factores',
            twofa_step1: '1. Agregue esta cuenta a una app de autenticación',
            twofa_apps_note: 'Use Google Authenticator, Microsoft Authenticator, Authy, 1Password o cualquier app TOTP.',
            twofa_open_app: '📲 Abrir en la app de autenticación', twofa_manual_key: 'O ingrese esta clave manualmente:',
            copy_btn: 'Copiar', twofa_step2_label: '2. Ingrese el código de 6 dígitos que muestra',
            twofa_verify_on: 'Verificar y activar', try_again_btn: 'Intentar de nuevo', skip_for_now: 'Omitir por ahora',
            twofa_is_on: '✅ La autenticación de dos factores está activada', twofa_save_recovery: 'Guarde sus códigos de recuperación',
            twofa_recovery_help: 'Cada código funciona una sola vez. Si pierde su teléfono, un código de recuperación le permite iniciar sesión. Guárdelos en un lugar seguro: solo se muestran ahora.',
            twofa_copy_codes: 'Copiar códigos', twofa_saved_ack: 'He guardado estos códigos de recuperación', done_btn: 'Listo',
            twofa_intro_mandatory: 'Su rol recomienda la autenticación de dos factores. Configúrela ahora u omítala: le recordaremos de nuevo en 15 días.',
            twofa_intro_optional: 'Agregue un segundo paso al iniciar sesión para mayor seguridad.',
            unusual_activity_title: 'Actividad de inicio de sesión inusual', gso_cancel_admin: 'Cancelar (admin)',
            gso_title: '🚪 Cerrar sesión a todos los usuarios', gso_everyone_pre: 'Todos',
            gso_everyone_post: 'recibirán un aviso con cuenta regresiva y luego se cerrará su sesión en todos los dispositivos. Su trabajo sin guardar se perderá.',
            gso_grace_period: 'Período de gracia', mins_5: '5 minutos', mins_10: '10 minutos', mins_15: '15 minutos',
            mins_2: '2 minutos', mins_1: '1 minuto', gso_reason_label: 'Motivo (opcional — visible para todos)',
            gso_reason_ph: 'p. ej. mantenimiento del sistema', gso_type_pre: 'Escriba', gso_type_post: 'para confirmar',
            gso_start: 'Iniciar cierre de sesión', gso_scope_all: 'en todas las compañías', gso_scope_company: 'en su compañía',
            idle_title: '¿Sigue ahí?', idle_pre: 'Se cerrará su sesión en',
            idle_post: 's por inactividad. Cualquier cambio sin guardar podría perderse.', idle_stay: 'Seguir conectado',
            // --- R2: Settings, Home, Notifications ---
            id_config: 'Configuración de ID',
            id_config_note: 'Los cambios aquí solo afectan a los <strong>nuevos</strong> ID en adelante — los ID de empleado, reclamo y cargo ya asignados no cambiarán. El <strong>prefijo del ID es el código de la compañía</strong> (definido al agregar una compañía), así que cambie de compañía arriba para controlarlo.',
            emp_id_digits: 'Dígitos del ID de empleado', claim_id_digits: 'Dígitos del ID de reclamo', charge_id_digits: 'Dígitos del ID de cargo',
            charge_id_suffix: 'Sufijo del ID de cargo', save_id_format: 'Guardar formato de ID',
            damage_type_panel: 'Tipo de daño (Reclamos)', add_damage_type: 'Agregar un nuevo tipo de daño', damage_type_ph: 'p. ej. Daño por agua',
            add_btn: 'Agregar', charge_type_panel: 'Tipo de cargo (Cargos)', add_charge_type: 'Agregar un nuevo tipo de cargo', charge_type_ph: 'p. ej. Adelanto',
            th_charge_type: 'Tipo de cargo', income_type_panel: 'Tipo de ingreso adicional', add_income_type: 'Agregar un nuevo tipo de ingreso',
            income_type_ph: 'p. ej. Bono', th_income_type: 'Tipo de ingreso',
            home_subtitle: 'Así están las cosas ahora mismo.',
            notif_note: 'Los reclamos, cargos e ingresos adicionales que se le asignen aparecen aquí. Toque uno para ir directo a él. Las cuentas de Solo Lectura solo ven los suyos; los demás ven los de toda su compañía, igual que en el resto de la app.',
            date_range: 'Rango de fechas', range_all: 'Todo el tiempo', range_30: 'Últimos 30 días', range_60: 'Últimos 60 días',
            range_90: 'Últimos 90 días', range_365: 'Último año', sort_short: 'Ordenar', opt_date: 'Fecha', mark_all_read: 'Marcar todo como leído',
            // --- R3: Logistics (Tracker, Report, Fleet, Expiring) ---
            log_new_route: 'Registrar nueva ruta', delivery_date: 'Fecha de entrega', route_type: 'Tipo de ruta', third_man: '3er hombre',
            driver: 'Conductor', route_num: 'N.º de ruta', route_id: 'ID de ruta', miles: 'Millas', manifest_stops: 'Paradas del manifiesto',
            pullbacks: 'Devoluciones', incompletes: 'Incompletas', dedicated_flat_pay: 'Pago fijo dedicado', deductions: 'Deducciones',
            extra_pay: 'Pago extra', add_route: '+ Agregar ruta', th_regded: 'Reg/Ded', th_loaded: 'Paradas cargadas',
            th_completed: 'Paradas completadas', th_mileage_pay: 'Pago por millaje', th_fuel_pay: 'Pago de combustible', th_total_daily: 'Pago diario total',
            th_total_route: 'Pago total por ruta',
            year_label: 'Año', week_label: 'Semana', expand_all: '➕ Expandir todo', collapse_all: '➖ Contraer todo', row_labels: 'Etiquetas de fila',
            th_delivery_area: 'Área de entrega*', th_miles2: 'Millas**', th_manifest2: 'Paradas del manifiesto**', th_pullbacks2: 'Devoluciones**',
            th_loaded2: 'Paradas cargadas*', th_incompletes2: 'Incompletas*', th_completed2: 'Paradas completadas*', th_mileage2: 'Pago por millaje*',
            th_fuel2: 'Pago de combustible**', th_thirdman2: '3er hombre**', th_dedicated_flat: 'Fijo dedicado*', th_deductions2: 'Deducciones*',
            th_extra2: 'Pago extra*', th_total_route2: 'Pago total por ruta*',
            add_vehicle_title: 'Agregar vehículo', truck_num: 'N.º de camión', truck_num_ph: 'N.º ID de la compañía', make: 'Marca', make_ph: 'p. ej. Freightliner',
            model: 'Modelo', model_ph: 'p. ej. Cascadia', license_plate: 'Placa', reg_expiry: 'Vencimiento de registro',
            ins_company: 'Compañía de seguro', policy_number: 'Número de póliza', ins_expiry: 'Vencimiento del seguro', add_vehicle_btn: '+ Agregar vehículo',
            sched_maint: '📅 Programar mantenimiento', truck: 'Camión', date_label: 'Fecha', description: 'Descripción',
            sched_desc_ph: 'p. ej. Cambio de aceite, Inspección DOT', schedule_btn: '+ Programar',
            vehicle_search_ph: 'Buscar n.º de camión, año, marca, modelo, placa, VIN...', export_btn: '⬇️ Exportar', import_btn: '⬆️ Importar',
            opt_vehicle: 'Vehículo', opt_plate: 'Placa', opt_reg_exp: 'Venc. de registro',
            expiring_title: 'Documentos por vencer',
            expiring_note: 'Registro y seguro de la Flota, más licencia de conducir, permiso de trabajo y tarjeta médica de Empleados — todo en un solo lugar, lo más próximo primero. Los ya vencidos aparecen arriba.',
            show_within: 'Mostrar dentro de', days_30: '30 días', days_60: '60 días', days_90: '90 días', year_1: '1 año',
            everything_on_file: 'Todo en el archivo', category: 'Categoría', all_categories: 'Todas las categorías', fleet_only: 'Solo Flota',
            emp_docs_only: 'Solo documentos de empleados', expiring_search_ph: 'Buscar nombre, n.º de camión...',
            // --- R3b: HR/Payroll ---
            all_types: 'Todos los tipos', contractor: 'Contratista', opt_employee: 'Empleado', opt_provider: 'Proveedor', opt_staff: 'Personal',
            active_opt: 'Activo', inactive_opt: 'Inactivo', all_statuses: 'Todos los estados', active_only: 'Solo activos',
            search_name_id_ph: 'Buscar nombre o ID...', prev_btn: '◀ Ant.', next_btn: 'Sig. ▶', this_week: 'Esta semana',
            print_btn: '🖨 Imprimir', saved_flash: 'Guardado ✓', select_employee_opt: '— Seleccionar empleado —',
            optional_ph: 'opcional', save_changes: '💾 Guardar cambios',
            dailypay_title: 'Hoja de pago diario', import_registry: 'Importar registro',
            dailypay_note: 'Ingrese el pago de cada persona por los días que trabajó (dom–sáb). Toque <strong>OFF</strong> para los días libres — esos se omiten del total semanal. Las entradas se guardan automáticamente y se conservan por semana, así que puede consultar cualquier semana pasada con las flechas. Aquí solo aparecen las personas con <strong>Tarifa diaria</strong> (cambie el tipo de pago de una persona en la pestaña Empleados).',
            weekdeposit_note: 'Estos se leen de los cargos de <strong>Semana de Fondo</strong> ya registrados en la pestaña Cargos e Ingresos — una meta de ahorro, acumulada semana a semana. Esta vista no crea nuevos; agregue un nuevo depósito igual que cualquier otro cargo, usando "Semana de Fondo" como tipo de cargo.',
            edit_deposit: 'Editar depósito', savings_goal: 'Meta de ahorro ($)', weekly_saving: 'Ahorro semanal ($)',
            deducting_opt: 'Deduciendo', paid_opt: 'Pagado', absorbed_opt: 'Absorbido',
            summary_report_excel: '📊 Reporte resumen (Excel)', summary_report_pdf: '📊 Reporte resumen (PDF)',
            providerpay_title: 'Pago a proveedores',
            providerpay_note: 'Ingrese el pago de cada proveedor por la semana — un solo monto, ya que los proveedores no tienen tarifa fija. Se guarda automáticamente y se conserva por semana, así que puede consultar cualquier semana pasada con las flechas. Aquí solo aparecen las personas con tipo de pago <strong>Proveedor</strong> (cambie el tipo de pago de una persona en la pestaña Empleados). Alimenta la Nómina igual que el Pago diario. <strong>Vinculado a Cuentas por pagar:</strong> cualquier factura sin pagar cuyo proveedor coincida con el nombre de un proveedor aparece bajo ese proveedor — marque una o más y toque “Pagar seleccionadas” para marcar esas facturas como Pagadas y sumar su total al monto de esta semana.',
            payroll_title: 'Resumen de nómina', print_all: '🖨 Imprimir todo',
            payroll_note: 'Pago neto = pago base + pago por rutas (conductores) + ingreso adicional − deducciones semanales activas (reclamos + cargos que se están deduciendo actualmente). El pago base es el <strong>salario semanal</strong> fijo para las personas Semanales, o el total del <strong>Pago diario</strong> de esta semana para las personas con tarifa diaria. El pago por rutas, el ingreso adicional y el pago diario usan la semana actual.',
            savings_release_title: 'Ahorros y elegibilidad de liberación',
            savingsrelease_note: 'Los cheques se emiten los jueves y se entregan los sábados. La Semana de Fondo no puede liberarse antes de <strong>90 días</strong> después de la última fecha trabajada de un empleado; el pago de la última semana trabajada de ese mismo empleado no puede liberarse antes de <strong>30 días</strong> después de esa fecha. "Pendiente" incluye cualquier reclamo o cargo — de cualquier estado — con saldo real, o (solo reclamos) un monto absorbido restante.',
            search_employee_ph: 'Buscar empleado...', week_in_deposit_opt: 'Semana de Fondo', last_paycheck_opt: 'Último cheque',
            all_eligibility: 'Toda elegibilidad', ready_release_now: 'Listo para liberar ahora', not_yet_eligible: 'Aún no elegible',
            release_history_title: 'Historial de liberaciones',
            releasehistory_note: 'Registro permanente de cada liberación de Semana de Fondo y Último Cheque — monto original, lo que se dedujo hacia otros reclamos/cargos, y lo que realmente recibió el empleado.',
            search_emp_releasedby_ph: 'Buscar empleado, liberado por...',
            early_ontime: 'Anticipadas y a tiempo', early_only: 'Solo anticipadas', ontime_only: 'Solo a tiempo',
            // --- R4: Messages, Invoices, Bills, Users, Companies, Approvals, Log, Data Sync, Changelog ---
            dm_search_ph: 'Buscar conversaciones...', pill_all: 'Todas', pill_general: 'General', pill_missing_day: 'Día faltante',
            pill_claims: 'Reclamos', pill_charges: 'Cargos', pill_income: 'Ingresos', dm_compose_ph: 'Escriba un mensaje...',
            dm_empty_state: 'Seleccione una persona a la izquierda para iniciar una conversación.',
            new_invoice_title: 'Nueva factura', edit_invoice_title: 'Editar factura', save_invoice_btn: '+ Guardar factura', update_invoice_btn: '✎ Actualizar factura',
            inv_number: 'Factura n.º', inv_customer: 'Cliente', inv_date: 'Fecha de factura', due_date: 'Fecha de vencimiento', bill_to: 'Facturar a',
            unpaid_opt: 'Sin pagar', void_opt: 'Anulada',
            inv_number_ph: 'p. ej. 0169', inv_customer_ph: 'p. ej. Tramo', inv_billto_ph: 'Compañía, dirección, contacto — como aparece en la factura',
            line_items: 'Conceptos', add_line: '+ Agregar línea',
            invoice_search_ph: 'Buscar factura n.º, cliente, notas...', all_customers: 'Todos los clientes',
            new_bill_title: 'Nueva cuenta', edit_bill_title: 'Editar cuenta', save_bill_btn: '+ Guardar cuenta', update_bill_btn: '✎ Actualizar cuenta',
            vendor: 'Proveedor', vendor_bill_num: 'N.º de cuenta del proveedor', bill_date: 'Fecha de la cuenta', amount_label: 'Monto',
            bill_vendor_ph: 'p. ej. ABC Fuel Co, o elija un proveedor', bill_number_ph: 'p. ej. INV-9001',
            bill_search_ph: 'Buscar proveedor, cuenta n.º, notas...', all_vendors: 'Todos los proveedores',
            create_user_title: 'Crear nuevo perfil de usuario', role_field: 'Rol', assign_employee: 'Asignar a empleado',
            create_user_btn: '+ Crear usuario', system_users: 'Usuarios del sistema', refresh_btn: '↻ Actualizar',
            active_sessions: 'Sesiones activas', session_signout_note: 'Cerrar una sesión surte efecto de inmediato.',
            failed_signins: 'Inicios de sesión fallidos recientes',
            failed_signins_note: 'Últimos 7 días. Una cuenta se bloquea 5 minutos tras 5 fallos; una red se bloquea 15 minutos tras 30.',
            gso_history: 'Historial de cierre de sesión global',
            gso_history_note: 'Cada acción de \'Cerrar sesión de todos\': quién la inició, cuándo, por qué y a cuántos afectó.',
            add_company_title: 'Agregar compañía', add_company_btn: '+ Agregar compañía', save_changes_plain: 'Guardar cambios', editing_prefix: 'Editando',
            company_section: 'Compañía', company_code: 'Código de compañía (3–4 caracteres)', company_name: 'Nombre de la compañía',
            ownership_contact: 'Propiedad y contacto', owner_label: 'Propietario', manager_label: 'Gerente', manager_phone: 'Teléfono del gerente',
            company_code_ph: 'p. ej. 3FL', company_name_ph: 'p. ej. 3 Of Life LLC', owner_ph: 'Nombre del propietario', phone_ph: '(555) 555-5555',
            email_ph: 'nombre@ejemplo.com', manager_ph: 'Nombre del gerente', companies_title: 'Compañías',
            pending_approvals: 'Aprobaciones pendientes',
            approvals_note: 'Los cambios financieros bloqueados (tarifa de pago base, monto del reclamo, deducción semanal) solicitados por usuarios Medium aparecen aquí para la aprobación del Administrador.',
            pending_release_requests: 'Solicitudes de liberación pendientes',
            release_requests_note: 'La liberación de Semana de Fondo o Último Cheque de un usuario Medium — normal o anticipada — siempre llega aquí primero. Nada se libera hasta que un Administrador lo apruebe.',
            change_log_title: 'Registro de cambios',
            log_note: 'Cada cambio aplicado a empleados, reclamos, cargos y rutas se registra aquí.',
            export_data_title: 'Exportar datos', download_excel_backup: '⬇️ Descargar respaldo Excel (solo Rastreador de rutas)',
            export_all_data: '⬇️ Exportar todos los datos (un solo archivo)',
            export_all_note: 'Un archivo .xlsx con una hoja separada para Empleados, Reclamos, Cargos, Ingresos adicionales, Vehículos, Rutas, Pago diario y Pago a proveedores — todo a lo que tiene acceso, en una sola descarga. El SSN/ITIN del empleado nunca se incluye en ninguna exportación.',
            import_all_title: 'Importar todos los datos (un solo archivo)',
            import_all_note: 'Suba un archivo exportado desde <strong>Exportar todos los datos</strong> arriba (o editado a mano para coincidir con su diseño de columnas) para restaurar Reclamos, Cargos, Ingresos adicionales, Vehículos, Rutas, Pago diario y Pago a proveedores en un solo paso — vinculados a los empleados existentes por ID de empleado. No toca a los Empleados en sí; use Importar CSV en la pestaña Empleados para eso.',
            import_sync_routes_title: 'Importar y sincronizar rutas desde Excel (Pestaña: Rastreador)',
            admin_danger_title: 'Zona de gestión y restablecimiento del Administrador',
            admin_danger_note: 'Estas acciones están restringidas solo a usuarios <strong>Administrador</strong>.',
            del_all_routes: '🗑️ Eliminar todas las rutas', del_all_claims: '🗑️ Eliminar todos los reclamos', del_all_charges: '🗑️ Eliminar todos los cargos',
            del_all_users: '🗑️ Eliminar todos los usuarios', reset_all_except_users: '⚠️ Restablecer todos los datos (excepto usuarios)',
            gso_signout_note: 'Da a todos una advertencia con cuenta regresiva y luego los cierra en todos los dispositivos. Los Administradores afectan su propia compañía; el Súper Admin afecta a todos.',
            sysreset_title: 'Restablecimiento del sistema — Solo Súper Admin',
            sysreset_note: 'Elimina todas las cuentas de usuario excepto los Súper Admin, y borra el Registro de auditoría y las Aprobaciones pendientes. Las compañías y todo lo que les pertenece — empleados, reclamos, cargos, rutas, ingresos — <strong>no</strong> se tocan. No se puede deshacer.',
            reset_system_btn: '☢️ Restablecer sistema (conservar compañías y Súper Admin)',
            changelog_title: 'Registro de cambios',
            changelog_note: 'Cada cambio entregado a esta app, más reciente primero — almacenado en el servidor para que este historial sobreviva incluso a cambios del archivo de la app. Solo visible para el Súper Admin.',
            search_results_title: 'Resultados de búsqueda',
            // --- R4b: record-grid sort-dropdown options ---
            sort_kind: 'Clase', sort_start_ded: 'Inicio ded.', sort_start: 'Inicio', sort_base: 'Base (sem)',
            sort_gross: 'Bruto', sort_net: 'Neto', sort_bill_num: 'Cuenta n.º', sort_employee_id: 'ID de empleado',
            sort_created: 'Creado', sort_code: 'Código', sort_requested: 'Solicitado', sort_requested_by: 'Solicitado por',
            sort_table: 'Tabla', sort_field: 'Campo', sort_when: 'Cuándo', sort_who: 'Quién',
            // --- R5a: dynamic card chrome — Employees & Fleet ---
            d_type: 'Tipo', d_department: 'Departamento', d_start_date: 'Fecha de inicio', d_pay: 'Pago', d_status: 'Estado',
            d_edit: 'Editar', d_delete: '✕ Eliminar', d_phone: 'Teléfono', d_email: 'Correo', d_ssn_itin: 'SSN / ITIN',
            d_dl_stateid: 'Licencia de conducir / ID estatal', d_dl_exp: 'Vencimiento de licencia', d_wp_num: 'Permiso de trabajo n.º', d_wp_exp: 'Vencimiento del permiso de trabajo',
            d_medcard: 'Tarjeta médica', d_medcard_exp: 'Vencimiento de tarjeta médica', d_role_title: 'Rol / Cargo', d_notes: 'Notas',
            d_status_history: 'Historial de estado', d_generate_user: 'Generar usuario', d_loading: 'Cargando…',
            d_no_status_changes: 'Aún no hay cambios de estado registrados.', d_th_date: 'Fecha', d_th_change: 'Cambio', d_th_by: 'Por',
            d_no_employees: 'No se encontraron empleados.', d_no_vehicles: 'Aún no hay vehículos.', d_nothing_expiring: 'Nada por vencer en este período.',
            d_no_upcoming_maint: 'No hay mantenimiento programado próximo.', d_no_service_records: 'Aún no hay registros de servicio.',
            d_already_expired: 'Ya vencidos', d_within_14: 'Dentro de 14 días', d_total_shown: 'Total mostrado',
            d_edit_vehicle_record: '✎ Editar registro de vehículo', d_edit_employee_record: '✎ Editar registro de empleado',
            d_stat_fleet: 'Flota', d_stat_reg_exp: 'Registro por vencer/vencido', d_stat_ins_exp: 'Seguro por vencer/vencido',
            d_th_id: 'ID', d_th_truck: 'Camión n.º', d_th_vehicle: 'Vehículo', d_th_plate: 'Placa', d_th_reg_exp: 'Venc. de registro',
            d_th_ins_co: 'Cía. de seguro', d_th_ins_exp: 'Venc. del seguro',
            d_reg_expiry: 'Vencimiento de registro', d_insurance_company: 'Compañía de seguro', d_policy_num: 'Póliza n.º', d_insurance_expiry: 'Vencimiento del seguro',
            d_license_plate: 'Placa', d_vin: 'VIN', d_service_log: 'Registro de servicio', d_mileage_at_service: 'Millaje al servicio',
            d_next_service_due: 'Próximo servicio a las', d_add: '+ Agregar', d_service_desc_ph: 'p. ej. Cambio de aceite, Rotación de llantas',
            // --- R5a: dynamic card chrome — Claims, Charges, Income ---
            d_no_cc: 'No se encontraron reclamos ni cargos.', d_th_kind: 'Clase', d_employee: 'Empleado', d_employee_id: 'ID de empleado',
            d_claimant_acct: 'Cuenta del reclamante', d_company: 'Compañía', d_carrier_claim: 'N.º de reclamo del transportista', d_customer_claim: 'N.º de reclamo del cliente',
            d_type_damage: 'Tipo de daño', d_claim_amount: 'Monto del reclamo', d_weeks: 'Semanas', d_balance: 'Saldo', d_absorbed: 'Absorbido',
            d_start_ded: 'Inicio ded.', d_end_ded: 'Fin ded.', d_edit_full: '✎ Editar',
            d_charge_type: 'Tipo de cargo', d_amount: 'Monto', d_weekly_deduction: 'Deducción semanal',
            d_income_type: 'Tipo de ingreso', d_weekly_amount: 'Monto semanal', d_start: 'Inicio', d_ends: 'Termina',
            d_no_income: 'No se encontraron ingresos adicionales.',
            d_income_setup_note: 'Ejecute el SQL de configuración de ingresos (la tabla <strong>additional_income</strong>) para empezar a registrar ingresos adicionales.',
            d_th_effective: 'Vigente', d_th_weekly: 'Semanal', d_no_rate_changes: 'Sin cambios de tarifa — usando el monto semanal base.',
            d_th_paused: 'Pausado', d_th_resume: 'Reanudar', d_no_pauses: 'Aún no hay pausas registradas.',
            // --- R5a: dynamic card chrome — Payroll ---
            d_no_people_match: 'Nadie coincide con estos filtros.', d_th_name: 'Nombre',
            d_base_wk: 'Base (sem)', d_route_wk: 'Ruta (sem)', d_income_wk: 'Ingreso (sem)', d_gross: 'Bruto', d_deductions_h: 'Deducciones', d_net: 'Neto',
            d_base_pay_wk: 'Pago base (sem)', d_route_pay_wk: 'Pago por ruta (sem)', d_weekly_deductions: 'Deducciones semanales', d_net_pay: 'Pago neto',
            d_people: 'Personas', d_gross_wk: 'Bruto (sem)', d_deductions_wk: 'Deducciones (sem)', d_net_pay_wk: 'Pago neto (sem)',
            d_th_day: 'Día', d_th_pay: 'Pago', d_base_daily_total: 'Base (total diario)', d_provider_pay: 'Pago a proveedor', d_weekly_salary: 'Salario semanal',
            d_route_pay_dot: 'Pago por ruta', d_th_route: 'Ruta', d_route_total: 'Total de ruta',
            d_no_daily_pay: 'Sin pago diario ingresado para', d_no_provider_pay: 'Sin pago a proveedor ingresado para',
            d_additional_income: 'Ingreso adicional', d_income_total: 'Total de ingresos', d_total_deductions: 'Total de deducciones', d_no_active_ded: 'Sin deducciones semanales activas.',
            d_print_payslip: '🖨 Imprimir recibo', d_paid_days_base: 'Días pagados / pago base',
            // --- R5a: dynamic card chrome — Statement, Week Deposit, Savings/Release, Release History, Pay ---
            d_stat_claims: 'Reclamos', d_stat_charges: 'Cargos', d_stat_add_income: 'Ingreso adicional',
            d_total_claims: 'Total de reclamos', d_total_charges: 'Total de cargos', d_total_income: 'Total de ingresos',
            d_select_emp_stmt: 'Seleccione un empleado arriba para ver su estado de cuenta.', d_current_deductions: 'Deducciones actuales — desglose completo',
            d_no_current_cc: 'Sin reclamos ni cargos actuales para este empleado.', d_add_income_breakdown: 'Ingreso adicional — desglose completo',
            d_claimant_account: 'Cuenta del reclamante', d_weekly_rate: 'Tarifa semanal', d_weeks_to_zero: 'Semanas hasta $0', d_paid_so_far: 'Pagado hasta ahora',
            d_print_schedule: '🖨 Imprimir cronograma', d_th_deducted: 'Deducido', d_th_running_balance: 'Saldo acumulado',
            d_no_schedule_claim: 'Sin cronograma que proyectar — el reclamo está resuelto o necesita una fecha de inicio y un monto semanal.',
            d_no_schedule_charge: 'Sin cronograma que proyectar — el cargo está resuelto o necesita una fecha de inicio y un monto semanal.',
            d_weekly: 'Semanal', d_remaining: 'Restante',
            d_goal: 'Meta', d_weekly_saving: 'Ahorro semanal', d_saved_so_far: 'Ahorrado hasta ahora', d_remaining_to_goal: 'Falta para la meta',
            d_of_goal: 'de la meta', d_release: '🔓 Liberar', d_early_release: '⏰ Liberación anticipada', d_th_saved_week: 'Ahorrado esa semana',
            d_total_saved: 'Total ahorrado', d_active_deposits: 'Depósitos activos', d_total_remaining: 'Total restante', d_no_deposits: 'No se encontraron depósitos.',
            d_ready_now: 'Listo para liberar ahora', d_total_tracked: 'Total en seguimiento', d_wid_savings: 'Ahorros de Semana de Fondo',
            d_nothing_savings: 'Nada que mostrar — no hay ahorros de Semana de Fondo abiertos ni empleados Inactivos con un último cheque sin liberar (según los filtros actuales).',
            d_pending_elsewhere: 'Pendiente en otro lugar', d_eligible_date: 'Fecha de elegibilidad', d_check_issued: 'Cheque emitido (jue)',
            d_handed_over: 'Entregado (sáb)', d_not_eligible_until: 'No elegible hasta',
            d_total_releases: 'Total de liberaciones', d_net_released_emp: 'Neto liberado a empleados', d_total_applied_ded: 'Total aplicado a deducciones',
            d_early_releases: 'Liberaciones anticipadas', d_no_releases: 'Aún no hay liberaciones registradas (según los filtros actuales).',
            d_base_pay: 'Pago base', d_additional_income_c: 'Ingreso adicional', d_original_amount: 'Monto original',
            d_total_deductions_c: 'Total de deducciones', d_final_released: 'Monto final liberado', d_requested_via: '¿Solicitado por aprobación?',
            d_applied_to: 'Aplicado a', d_no_other_outstanding: 'Sin otros reclamos o cargos pendientes al momento de la liberación.', d_by: 'por',
            d_no_pending_release: 'No hay solicitudes de liberación pendientes.', d_net_to_release: 'Neto a liberar', d_requested: 'Solicitado', d_plan: 'Plan',
            d_no_other_cc: 'Sin otros reclamos o cargos pendientes.', d_approve: 'Aprobar', d_reject: '✕ Rechazar', d_requested_by: 'solicitado por',
            d_no_provider_set: 'Nadie está configurado con pago <strong>Proveedor</strong> aún. Vaya a la pestaña Empleados y cambie el Pago de una persona a <em>Proveedor</em>.',
            d_amount_this_week: 'Monto de esta semana', d_notes_optional: 'Notas (opcional)', d_provider_notes_ph: 'p. ej. n.º de factura, concepto', d_total_this_week: 'Total de esta semana',
            d_dp_setup: '⚙️ <strong>Se necesita configuración única.</strong> Las tablas de pago diario aún no existen en su base de datos, por lo que no se pueden guardar entradas. Pida a su administrador que ejecute la breve configuración SQL (incluida con esta actualización) en Supabase → SQL Editor. Todo lo demás en la app sigue funcionando normalmente.',
            d_no_daily_set: 'Nadie está configurado con <strong>Tarifa diaria</strong> aún. Vaya a la pestaña Empleados y cambie el Pago de una persona a <em>Diaria</em> (el botón ↺ en la columna Pago).',
            d_week_total: 'Total semanal',
            // --- R5a: dynamic card chrome — Companies, Invoices, Bills, Approvals, Log, Notifications, Messages, Home, Changelog, Users/Sessions ---
            d_no_companies: 'Aún no hay compañías.', d_created: 'Creado', d_manager_phone: 'Teléfono del gerente',
            d_no_line_items: 'Sin conceptos.', d_no_line_items_hint: 'Aún no hay conceptos — haga clic en "+ Agregar línea", o simplemente guarde solo con el total de abajo.', d_desc_route_ph: 'Descripción / ruta', d_rate_ph: 'Tarifa', d_qty_ph: 'Cant.', d_extra_ph: 'Extra', d_amount_ph: 'Monto',
            d_stat_unpaid: 'Sin pagar', d_invoiced_month: 'Facturado este mes', d_total_invoices: 'Total de facturas', d_no_invoices: 'No se encontraron facturas.',
            d_overdue: 'Vencidas', d_total_bills: 'Total de cuentas', d_no_bills: 'No se encontraron cuentas.',
            d_no_pending: 'No hay solicitudes pendientes.', d_th_requested_by: 'Solicitado por', d_th_record: 'Registro', d_th_old: 'Anterior', d_th_new: 'Nuevo', d_th_requested: 'Solicitado',
            d_record: 'Registro', d_old_value: 'Valor anterior', d_new_value: 'Valor nuevo',
            d_no_changes_logged: 'Aún no hay cambios registrados.',
            d_no_notifs: 'No hay notificaciones en este rango.',
            d_no_convos: 'Aún no hay conversaciones. Toque + para iniciar una.', d_you_prefix: 'Tú:', d_new_conversation: 'Nueva conversación', d_pick_person: '— Elegir una persona —', d_open_chat: 'Abrir chat',
            d_home_active_emps: 'Empleados activos', d_home_open_claims: 'Reclamos abiertos', d_home_active_charges: 'Cargos activos', d_home_income_week: 'Ingreso de esta semana', d_home_expiring: 'Por vencer pronto', d_home_unread: 'Notificaciones sin leer',
            d_no_versions: 'Aún no hay versiones registradas.', d_current: 'Actual',
            d_no_sessions: 'No hay sesiones activas.', d_th_user: 'Usuario', d_th_started: 'Iniciada', d_th_last_seen: 'Última actividad', d_th_ends: 'Termina', d_sign_out_btn: 'Cerrar sesión', d_this_device: 'Este dispositivo',
            d_no_failed: 'No hay inicios de sesión fallidos en los últimos 7 días.', d_th_type: 'Tipo', d_th_who: 'Quién', d_th_failed: 'Fallidos', d_th_last_attempt: 'Último intento',
            d_no_users: 'No se encontraron usuarios.', d_restricted: 'Restringido', d_id_btn: '🪪 ID', d_reset_pw: '🔑 Restablecer', d_reset_2fa: '🔐 Restablecer 2FA',
            d_no_gso: 'Aún no hay cierres de sesión globales.', d_th_initiator: 'Iniciador', d_th_scope: 'Alcance', d_th_grace: 'Gracia', d_th_affected: 'Afectados', d_th_reason: 'Motivo', d_all_companies: 'Todas las compañías'
        }
    };

    // The English/Spanish switcher is live. Coverage spans every tab's fixed
    // UI plus the dynamically-rendered record cards; any still-untranslated
    // string (a handful of pop-up messages, enum/status values) falls back to
    // English automatically via the ?? below, so a missing key never breaks a
    // screen. The two picker blocks (login screen + Settings) are visible.
    const LANGUAGE_SWITCH_HIDDEN = false;
    function currentLang() {
        if (LANGUAGE_SWITCH_HIDDEN) return 'en';
        try {
            const saved = localStorage.getItem('tracker_lang');
            if (saved === 'en' || saved === 'es') return saved;
            // First run with no saved choice: follow the device language for
            // Spanish, otherwise English. Not persisted — only an explicit pick
            // (a picker button) writes tracker_lang, so this stays a soft default.
            const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
            return nav.startsWith('es') ? 'es' : 'en';
        } catch (e) { return 'en'; }
    }
    function t(key) {
        const lang = currentLang();
        return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) ?? TRANSLATIONS.en[key];
    }

    function applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const val = t(el.getAttribute('data-i18n'));
            if (val === undefined) return;
            // A translation value containing HTML markup (e.g. <strong> in a
            // note box) fully replaces this element's contents — there's
            // nothing else inside it worth preserving.
            if (/<[a-z][\s\S]*>/i.test(val)) { el.innerHTML = val; return; }
            // Some tagged elements (panel headers with a caret span, tab
            // buttons with a badge span) have element children alongside
            // their text — only swap the first text node so those don't
            // get wiped out.
            const hasElementChildren = Array.from(el.childNodes).some(n => n.nodeType === 1);
            if (hasElementChildren) {
                const textNode = Array.from(el.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
                if (textNode) textNode.textContent = val + ' ';
                else el.insertBefore(document.createTextNode(val + ' '), el.firstChild);
            } else {
                el.textContent = val;
            }
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const val = t(el.getAttribute('data-i18n-placeholder'));
            if (val !== undefined) el.placeholder = val;
        });
    }

    function setLanguage(lang) {
        try { localStorage.setItem('tracker_lang', lang === 'es' ? 'es' : 'en'); } catch (e) {}
        applyTranslations();
        updateLanguageButtons();
    }

    function updateLanguageButtons() {
        const cur = currentLang();
        const enBtn = document.getElementById('lang-btn-en'), esBtn = document.getElementById('lang-btn-es');
        const loginEnBtn = document.getElementById('login-lang-btn-en'), loginEsBtn = document.getElementById('login-lang-btn-es');
        [enBtn, loginEnBtn].forEach(b => { if (b) b.style.background = cur === 'en' ? 'var(--navy)' : '#64748b'; });
        [esBtn, loginEsBtn].forEach(b => { if (b) b.style.background = cur === 'es' ? 'var(--navy)' : '#64748b'; });
    }

    // Applies to whichever selector set is passed in — lets both the Settings
    // panel and the login screen (different button IDs) share this logic.
    function setTheme(theme, idPrefix) {
        try {
            const d = document.documentElement;
            d.removeAttribute('data-flavor');
            if (theme === 'dark' || theme === 'dark-emerald' || theme === 'indigo') {
                d.setAttribute('data-theme', theme);
            } else if (theme === 'carbon') {
                // Carbon reuses every dark-mode rule via data-theme="dark",
                // then recolors through the [data-flavor="carbon"] token block.
                d.setAttribute('data-theme', 'dark');
                d.setAttribute('data-flavor', 'carbon');
            } else {
                d.removeAttribute('data-theme');
                theme = 'light';
            }
            localStorage.setItem('tracker_theme', theme);
        } catch (e) { /* storage unavailable — theme still applies for this session */ }
        updateThemeButtons();
    }
    function updateThemeButtons() {
        let cur = 'light';
        try { cur = localStorage.getItem('tracker_theme') || 'light'; } catch (e) {}
        // Settings tab — unchanged text-button behavior.
        const lb = document.getElementById('theme-btn-light');
        const ob = document.getElementById('theme-btn-ocean');
        const eb = document.getElementById('theme-btn-emerald');
        if (lb) { lb.style.background = cur === 'light' ? 'var(--navy)' : '#64748b'; lb.textContent = cur === 'light' ? '☀ Light (current)' : '☀ Light'; }
        if (ob) { ob.style.background = cur === 'dark' ? 'var(--navy)' : '#64748b'; ob.textContent = cur === 'dark' ? '🌊 Ocean (current)' : '🌊 Ocean'; }
        if (eb) { eb.style.background = cur === 'dark-emerald' ? 'var(--navy)' : '#64748b'; eb.textContent = cur === 'dark-emerald' ? '🟢 Emerald (current)' : '🟢 Emerald'; }
        // Login screen — circular swatches, active one gets a ring instead of text/background changes.
        const swatchFor = { light: 'login-theme-btn-light', dark: 'login-theme-btn-ocean', 'dark-emerald': 'login-theme-btn-emerald', indigo: 'login-theme-btn-indigo', carbon: 'login-theme-btn-carbon' };
        ['login-theme-btn-light', 'login-theme-btn-ocean', 'login-theme-btn-emerald', 'login-theme-btn-indigo', 'login-theme-btn-carbon'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', id === swatchFor[cur]);
        });
        // Header dropdown — same idea, quick access without signing out.
        const headerSwatchFor = { light: 'header-theme-btn-light', dark: 'header-theme-btn-ocean', 'dark-emerald': 'header-theme-btn-emerald', indigo: 'header-theme-btn-indigo', carbon: 'header-theme-btn-carbon' };
        ['header-theme-btn-light', 'header-theme-btn-ocean', 'header-theme-btn-emerald', 'header-theme-btn-indigo', 'header-theme-btn-carbon'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', id === headerSwatchFor[cur]);
        });
        // Sidebar account bar (desktop) — same idea again.
        const sidebarSwatchFor = { light: 'sidebar-theme-btn-light', dark: 'sidebar-theme-btn-ocean', 'dark-emerald': 'sidebar-theme-btn-emerald', indigo: 'sidebar-theme-btn-indigo', carbon: 'sidebar-theme-btn-carbon' };
        ['sidebar-theme-btn-light', 'sidebar-theme-btn-ocean', 'sidebar-theme-btn-emerald', 'sidebar-theme-btn-indigo', 'sidebar-theme-btn-carbon'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', id === sidebarSwatchFor[cur]);
        });
    }

    function renderSettingsLists() {
        updateThemeButtons();
        const dBody = document.getElementById('damage-types-tbody');
        if(dBody) {
            dBody.innerHTML = '';
            damageTypes.forEach(d => {
                dBody.insertAdjacentHTML('beforeend', `<tr><td>${escHtml(d)}</td><td style="text-align:center;"><button class="del-btn" onclick="removeDamageType('${escJsAttr(d)}')">✕</button></td></tr>`);
            });
        }

        const cBody = document.getElementById('charge-types-tbody');
        if(cBody) {
            cBody.innerHTML = '';
            chargeTypes.forEach(ct => {
                cBody.insertAdjacentHTML('beforeend', `<tr><td>${escHtml(ct)}</td><td style="text-align:center;"><button class="del-btn" onclick="removeChargeType('${escJsAttr(ct)}')">✕</button></td></tr>`);
            });
        }

        const iBody = document.getElementById('income-types-tbody');
        if(iBody) {
            iBody.innerHTML = '';
            incomeTypes.forEach(it => {
                iBody.insertAdjacentHTML('beforeend', `<tr><td>${escHtml(it)}</td><td style="text-align:center;"><button class="del-btn" onclick="removeIncomeType('${escJsAttr(it)}')">✕</button></td></tr>`);
            });
        }
    }

    document.getElementById('add-damage-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const val = document.getElementById('new-damage-input').value.trim();
        if(!val || damageTypes.includes(val)) return;
        await supabaseClient.rpc('add_type_value', { p_actor: currentUsername, p_kind: 'damage', p_value: val });
        damageTypes.push(val);
        document.getElementById('new-damage-input').value = '';
        renderSettingsLists();
        populateDropdowns();
        populateClaimFilters();
    });

    async function removeDamageType(name) {
        if (!name) { alert('Error: could not identify which damage type to delete — try refreshing the page.'); return; }
        const { error } = await supabaseClient.rpc('remove_type_value', { p_actor: currentUsername, p_kind: 'damage', p_value: name });
        if (error) { alert('Error: ' + error.message); return; }
        damageTypes = damageTypes.filter(d => d !== name);
        renderSettingsLists();
        populateDropdowns();
        populateClaimFilters();
    }

    document.getElementById('add-charge-type-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const val = document.getElementById('new-charge-type-input').value.trim();
        if(!val || chargeTypes.includes(val)) return;
        await supabaseClient.rpc('add_type_value', { p_actor: currentUsername, p_kind: 'charge', p_value: val });
        chargeTypes.push(val);
        document.getElementById('new-charge-type-input').value = '';
        renderSettingsLists();
        populateDropdowns();
    });

    async function removeChargeType(name) {
        if (!name) { alert('Error: could not identify which charge type to delete — try refreshing the page.'); return; }
        const { error } = await supabaseClient.rpc('remove_type_value', { p_actor: currentUsername, p_kind: 'charge', p_value: name });
        if (error) { alert('Error: ' + error.message); return; }
        chargeTypes = chargeTypes.filter(ct => ct !== name);
        renderSettingsLists();
        populateDropdowns();
    }

    document.getElementById('add-income-type-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const val = document.getElementById('new-income-type-input').value.trim();
        if(!val || incomeTypes.includes(val)) return;
        const { error } = await supabaseClient.rpc('add_type_value', { p_actor: currentUsername, p_kind: 'income', p_value: val });
        if (error) { alert(isMissingTable(error) ? 'Run the income setup SQL first (the income_types table).' : ('Error: ' + error.message)); return; }
        incomeTypes.push(val);
        document.getElementById('new-income-type-input').value = '';
        renderSettingsLists();
        populateDropdowns();
    });

    async function removeIncomeType(name) {
        if (!name) { alert('Error: could not identify which income type to delete — try refreshing the page.'); return; }
        const { error } = await supabaseClient.rpc('remove_type_value', { p_actor: currentUsername, p_kind: 'income', p_value: name });
        if (error) { alert('Error: ' + error.message); return; }
        incomeTypes = incomeTypes.filter(it => it !== name);
        renderSettingsLists();
        populateDropdowns();
    }

    document.getElementById('id-config-form').addEventListener('submit', function(e) {
        e.preventDefault();
        settings.empDigits = parseInt(document.getElementById('set-emp-digits').value) || 4;
        settings.claimDigits = parseInt(document.getElementById('set-claim-digits').value) || 5;
        settings.chargeDigits = parseInt(document.getElementById('set-charge-digits').value) || 5;
        settings.chargeSuffix = document.getElementById('set-charge-suffix').value.trim();
        alert('ID settings updated for future records!');
    });

    // --- USERS MANAGEMENT & INDIVIDUAL DELETION ---
    // Roles the current actor is allowed to assign (Admins can't grant SuperAdmin).
    function allowedRolesForActor() {
        if (currentUserRole === 'SuperAdmin') return ['User', 'Medium', 'Administrator', 'SuperAdmin'];
        if (currentUserRole === 'Administrator') return ['User', 'Medium', 'Administrator'];
        if (currentUserRole === 'Medium') return ['User'];
        return [];
    }
    const ROLE_LABELS = { User: 'User', Medium: 'Medium', Administrator: 'Administrator', SuperAdmin: 'Super Admin' };
    function populateUserRoleOptions() {
        const sel = document.getElementById('new-user-role');
        if (!sel) return;
        sel.innerHTML = allowedRolesForActor().map(r => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join('');
    }
    // Change an existing user's role (Administrators + Super Admins only; the
    // server enforces the same limits — Admins can't grant/alter SuperAdmin).
    async function changeUserRole(username, newRole, oldRole) {
        if (newRole === oldRole) return;
        if (!confirm(`Change ${username}'s role from ${oldRole} to ${newRole}?`)) { fetchUsersList(); return; }
        const { error } = await supabaseClient.rpc('set_user_role', { p_actor: currentUsername, p_target: username, p_new_role: newRole });
        if (error) { alert('Error: ' + error.message); fetchUsersList(); return; }
        fetchUsersList();
    }

    // ===== Sessions & sign-in attempts ====================================
    // Who is signed in, and a way to sign them out. list_sessions returns a
    // surrogate id per session and never the token itself, so this screen can
    // show and revoke sessions without ever being able to impersonate anyone.
    function fmtWhen(iso) {
        if (!iso) return '—';
        const d = new Date(iso), mins = Math.round((Date.now() - d.getTime()) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        if (mins < 1440) return Math.round(mins / 60) + 'h ago';
        return d.toLocaleDateString();
    }

    async function loadSessions() {
        const body = document.getElementById('sessions-body');
        const count = document.getElementById('sessions-count');
        if (!body) return;
        body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_loading')}</div>`;
        const { data, error } = await supabaseClient.rpc('list_sessions', {
            p_actor: currentUsername, p_company: currentCompany
        });
        if (error) { body.innerHTML = `<div style="grid-column:1/-1; color:#ef4444; padding:10px;">${escHtml(error.message)}</div>`; return; }
        const rows = data || [];
        if (count) count.textContent = `(${rows.length})`;
        if (!rows.length) { body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_no_sessions')}</div>`; return; }
        // Only an Administrator or SuperAdmin may sign someone else out; anyone
        // may end their own session.
        const canRevokeOthers = currentUserRole === 'SuperAdmin' || currentUserRole === 'Administrator';
        const trs = rows.map(r => {
            const mine = r.username === currentUsername;
            const allowed = mine || canRevokeOthers;
            const action = (allowed && !r.is_current)
                ? `<button type="button" class="btn-small del-btn" style="margin:0;" onclick="revokeSession(${r.id}, '${escJsAttr(r.username)}')">${t('d_sign_out_btn')}</button>`
                : '';
            return `<tr>
                <td>${escHtml(r.username)}${r.is_current ? ` <span class="status-badge status-active">${t('d_this_device')}</span>` : ''}</td>
                <td><span class="type-pill" style="font-size:9px; padding:1px 6px;">${escHtml(r.role === 'User' ? 'View Only' : r.role)}</span></td>
                <td style="white-space:nowrap;">${fmtWhen(r.created_at)}</td>
                <td style="white-space:nowrap;">${fmtWhen(r.last_seen)}</td>
                <td style="white-space:nowrap;">${new Date(r.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
                <td style="text-align:center;">${action}</td>
            </tr>`;
        }).join('');
        body.className = '';
        body.innerHTML = `<div class="table-wrapper"><table><thead><tr>
            <th>${t('d_th_user')}</th><th>${t('role_field')}</th><th>${t('d_th_started')}</th><th>${t('d_th_last_seen')}</th><th>${t('d_th_ends')}</th><th>${t('th_action')}</th>
        </tr></thead><tbody>${trs}</tbody></table></div>`;
    }

    async function revokeSession(id, who) {
        if (!confirm(`Sign out this session for ${who}? They will need to sign in again.`)) return;
        const { error } = await supabaseClient.rpc('revoke_session', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        loadSessions();
    }

    async function signOutOtherDevices() {
        if (!confirm('Sign out every other device signed in as you? This device stays signed in.')) return;
        const { data, error } = await supabaseClient.rpc('revoke_my_other_sessions', { p_actor: currentUsername });
        if (error) { alert('Error: ' + error.message); return; }
        const n = parseInt(data, 10) || 0;
        alert(n ? `Signed out ${n} other device${n === 1 ? '' : 's'}.` : 'No other devices were signed in.');
        if (document.getElementById('sessions-body')) loadSessions();
    }

    async function loadLoginAttempts() {
        const body = document.getElementById('login-attempts-body');
        const count = document.getElementById('login-attempts-count');
        if (!body) return;
        body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_loading')}</div>`;
        const { data, error } = await supabaseClient.rpc('list_login_attempts', { p_actor: currentUsername });
        if (error) { body.innerHTML = `<div style="grid-column:1/-1; color:#ef4444; padding:10px;">${escHtml(error.message)}</div>`; return; }
        const rows = data || [];
        if (count) count.textContent = `(${rows.length})`;
        if (!rows.length) { body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_no_failed')}</div>`; return; }
        const trs = rows.map(r => {
            const locked = r.locked_until && new Date(r.locked_until) > new Date();
            return `<tr>
                <td><span class="type-pill" style="font-size:9px; padding:1px 6px;">${r.kind === 'network' ? 'Network' : 'Account'}</span></td>
                <td style="font-family:var(--mono);">${escHtml(r.subject)}${(r.kind !== 'network' && r.emp_id) ? ` <span style="color:var(--text-muted);">(${escHtml(r.emp_id)})</span>` : ''}</td>
                <td style="text-align:center; color:${r.fail_count >= 5 ? '#dc2626' : 'var(--text-muted)'}; font-weight:700;">${r.fail_count}</td>
                <td style="text-align:center;">${locked ? '<span class="exp-pill exp-over">locked</span>' : ''}</td>
                <td style="white-space:nowrap; font-family:var(--mono);">${fmtWhen(r.last_fail_at)}</td>
            </tr>`;
        }).join('');
        body.className = '';
        body.innerHTML = `<div class="table-wrapper"><table><thead><tr>
            <th>${t('d_th_type')}</th><th>${t('d_th_who')}</th><th>${t('d_th_failed')}</th><th>${t('status_field')}</th><th>${t('d_th_last_attempt')}</th>
        </tr></thead><tbody>${trs}</tbody></table></div>`;
    }

    async function fetchUsersList() {
        const container = document.getElementById('users-table-body');
        if(!container) return;

        container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_loading')}</div>`;

        let data, error;
        try {
            ({ data, error } = await supabaseClient.rpc('list_users', { p_actor: currentUsername, p_company: currentCompany }));
        } catch (e) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">Could not load users: ${e && e.message ? e.message : e}</div>`;
            console.error('fetchUsersList (network/client):', e);
            return;
        }
        if (error) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">${error.message}</div>`;
            return;
        }

        // Fill the "assign to employee" dropdown — excluding employees already
        // linked to a user. Wrapped separately so a problem here can't blank
        // the user list below it.
        try {
            const takenEmpIds = new Set((data || []).map(u => u.employee_id).filter(Boolean));
            const empSel = document.getElementById('new-user-employee');
            if (empSel) {
                const avail = employees.filter(emp => !takenEmpIds.has(emp.id))
                    .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, undefined, { sensitivity: 'base' }));
                empSel.innerHTML = `<option value="">${t('select_employee_opt')}</option>` +
                    avail.map(emp => `<option value="${emp.id}">${employeeOptionLabel(emp)}</option>`).join('');
            }
        } catch (e) { console.error('assign-to-employee dropdown:', e); }

        if (!data || !data.length) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_users')}</div>`;
            return;
        }

        data = applySort(data, 'users', {
            username: u => u.username || '', employee_id: u => u.employee_id || '',
            role: u => u.role || '', created: u => u.created_at || ''
        });

        // One table on every screen size; the .table-wrapper scrolls sideways
        // on a narrow phone rather than switching to cards.
        container.className = '';
        let rows = '';
        data.forEach(u => {
            try {
                const canManage = u.can_manage && (currentUserRole === 'SuperAdmin' || currentUserRole === 'Administrator');
                let roleCell = `<span class="type-pill">${u.role}</span>`;
                if (canManage) {
                    const roles = allowedRolesForActor();
                    const opts = roles.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
                    roleCell = `<select onchange="changeUserRole('${u.username}', this.value, '${u.role}')" style="width:auto; min-height:34px; padding:4px 6px; font-size:12px;">${opts}</select>`;
                }
                const twofaBtn = u.twofa_enabled ? `<button class="btn-small" style="margin:0 4px 0 0; padding:0.3rem 0.6rem; font-size:0.75rem;" onclick="resetUser2FA('${u.username}')" title="Turn off this user's 2FA (device lost)">${t('d_reset_2fa')}</button>` : '';
                const actionHtml = u.can_manage
                    ? `<button class="btn-small" style="margin:0 4px 0 0; padding:0.3rem 0.6rem; font-size:0.75rem;" onclick="editUserEmployeeId('${u.username}', '${u.employee_id || ''}')">${t('d_id_btn')}</button><button class="btn-small" style="margin:0 4px 0 0; padding:0.3rem 0.6rem; font-size:0.75rem;" onclick="resetUserPassword('${u.username}')">${t('d_reset_pw')}</button>${twofaBtn}<button class="del-btn" onclick="deleteUser('${u.username}')">✕</button>`
                    : `<span style="color:#94a3b8; font-size:11px;">${t('d_restricted')}</span>`;
                rows += `<tr>
                    <td>${u.username}${u.twofa_enabled ? ' <span title="Two-factor on" style="font-size:11px;">🔐</span>' : ''}</td>
                    <td class="id-cell">${u.employee_id || '-'}</td>
                    <td>${roleCell}</td>
                    <td style="white-space:nowrap;">${new Date(u.created_at).toLocaleDateString()}</td>
                    <td style="text-align:center; white-space:nowrap;">${actionHtml}</td>
                </tr>`;
            } catch (e) { console.error('user row render failed for', u && u.username, e); }
        });
        container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
            <th>${t('username_label')}</th><th>${t('sort_employee_id')}</th><th>${t('role_field')}</th><th>${t('d_created')}</th><th>${t('th_action')}</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
        updateRecSortUI('users');
    }

    async function resetUserPassword(usernameToReset) {
        const newPass = prompt(`Enter a new password for "${usernameToReset}":`);
        if (newPass === null) return; // cancelled
        if (!newPass || newPass.length < 8) {
            alert('Password must be at least 8 characters.');
            return;
        }

        const { error } = await supabaseClient.rpc('reset_user_password', {
            p_actor: currentUsername, p_target: usernameToReset, p_new_password: newPass
        });
        if (error) {
            alert('Error resetting password: ' + error.message);
        } else {
            alert(`Password for "${usernameToReset}" has been reset.`);
        }
    }

    // Change (or clear) which employee a user account is linked to, without
    // deleting and recreating the account. The RPC itself enforces that an
    // employee can only ever be linked to one account at a time and that the
    // employee belongs to this user's own company.
    async function editUserEmployeeId(username, currentId) {
        const val = prompt(`Employee ID for "${username}" (leave blank to unlink):`, currentId || '');
        if (val === null) return; // cancelled
        const newId = val.trim() || null;
        if (newId === (currentId || null)) return; // unchanged
        const { error } = await supabaseClient.rpc('set_user_employee_id', {
            p_actor: currentUsername, p_target: username, p_employee_id: newId
        });
        if (error) {
            alert('Error: ' + error.message);
        } else {
            fetchUsersList();
        }
    }

    async function deleteUser(usernameToDel) {
        if (confirm(`Are you sure you want to delete user "${usernameToDel}"?`)) {
            const { error } = await supabaseClient.rpc('delete_user', {
                p_actor: currentUsername, p_target: usernameToDel
            });
            if (error) {
                alert('Error deleting user: ' + error.message);
            } else {
                alert(`User "${usernameToDel}" deleted successfully.`);
                fetchUsersList();
            }
        }
    }

    document.getElementById('create-user-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const username = document.getElementById('new-username').value.trim();
        const password = document.getElementById('new-user-pass').value;
        const role = document.getElementById('new-user-role').value;
        const employeeId = document.getElementById('new-user-employee').value;
        if (role !== 'SuperAdmin' && !employeeId) { alert('Please assign this user to an employee.'); return; }
        let userCo = writeCompany();
        if (role !== 'SuperAdmin' && !userCo) { alert('Select a specific company first (top-right dropdown) before creating a user.'); return; }
        const { error } = await supabaseClient.rpc('create_user', {
            p_actor: currentUsername, p_username: username, p_password: password, p_role: role,
            p_company: userCo, p_employee_id: employeeId || null
        });
        if (error) alert('Error: ' + error.message);
        else {
            alert('User created successfully!');
            document.getElementById('create-user-form').reset();
            fetchUsersList();
        }
    });

    // --- ADMINISTRATOR MANAGEMENT & RESET FUNCTIONS ---
    // Bulk actions: allowed for Administrator (own company) and SuperAdmin.
    // Scope: a company must be selected. Deletes are limited to that company.
    function dangerScope() {
        if (currentUserRole !== 'Administrator' && currentUserRole !== 'SuperAdmin') {
            alert('Access denied. Administrator privileges required.');
            return undefined;
        }
        const co = (currentUserRole === 'SuperAdmin') ? currentCompany : (currentUser ? currentUser.company_code : null);
        if (!co) {
            alert('Select a specific company first (top-right dropdown). Bulk actions apply to one company at a time.');
            return undefined;
        }
        return co;
    }

    async function adminDeleteAllRoutes() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(`Delete ALL route records for company ${co}?`)) {
            const { error } = await supabaseClient.rpc('delete_all_routes', { p_actor: currentUsername, p_company: co });
            if (error) alert('Error: ' + error.message);
            else alert('Routes deleted for ' + co + '.');
            fetchRoutesFromCloud();
        }
    }

    async function adminDeleteAllUsers() {
        if (currentUserRole !== 'Administrator' && currentUserRole !== 'SuperAdmin') {
            alert('Access denied. Administrator privileges required.');
            return;
        }
        if (confirm("WARNING: This deletes ALL user accounts EXCEPT your own. Proceed?")) {
            const { error } = await supabaseClient.rpc('delete_all_other_users', { p_actor: currentUsername });
            if (error) alert('Error: ' + error.message);
            else { alert('All other users deleted. Your account was kept.'); fetchUsersList(); }
        }
    }

    async function adminDeleteAllClaims() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(`Delete ALL claims for company ${co}?`)) {
            const { error } = await supabaseClient.rpc('delete_all_claims', { p_actor: currentUsername, p_company: co });
            if (error) alert('Error: ' + error.message);
            else alert('Claims deleted for ' + co + '.');
            fetchClaimsFromCloud();
        }
    }

    async function adminDeleteAllCharges() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(`Delete ALL charges for company ${co}?`)) {
            const { error } = await supabaseClient.rpc('delete_all_charges', { p_actor: currentUsername, p_company: co });
            if (error) alert('Error: ' + error.message);
            else alert('Charges deleted for ' + co + '.');
            fetchChargesFromCloud();
        }
    }

    async function adminResetAllDataExceptUsers() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(`CRITICAL: Wipe ALL operational data (routes, employees, claims, charges) for company ${co}, except user accounts. Cannot be undone. Proceed?`)) {
            try {
                const { error } = await supabaseClient.rpc('reset_company_data', { p_actor: currentUsername, p_company: co });
                if (error) {
                    alert('Error resetting data: ' + error.message);
                } else {
                    alert('Operational data reset for ' + co + '.');
                }
                fetchAllDataFromCloud();
            } catch (err) {
                alert('Error resetting data: ' + err.message);
            }
        }
    }

    // System-wide reset, Super Admin only. Every user account except Super
    // Admins, the audit Log, and pending Approvals are cleared; companies and
    // everything that belongs to them are untouched. Requires typing a exact
    // phrase to confirm, given the scale of what this removes.
    async function superAdminResetSystem() {
        if (currentUserRole !== 'SuperAdmin') return;
        const typed = prompt('This removes every user account except Super Admins, and clears the Log and Approvals. Companies and their data are kept.\n\nType RESET SYSTEM to confirm:');
        if (typed !== 'RESET SYSTEM') { if (typed !== null) alert('Not confirmed — nothing was changed.'); return; }
        try {
            const { error } = await supabaseClient.rpc('reset_system_data', { p_actor: currentUsername });
            if (error) { alert('Error: ' + error.message); return; }
            alert('System reset complete. Every non-Super Admin account was removed; the Log and Approvals are cleared. Company data is untouched.');
            fetchUsersList();
            renderLog();
            renderApprovals();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    }

    // --- LOGISTICS ROUTE MATH & DB PAYLOAD BUILDER ---
    function buildRoutePayload(rawData) {
        const rates = {
            mileage: 0.60, fuel: 0.40, stop: 18.25, incomplete: 9.125, thirdMan: 125.00, base: 300.00
        };

        const loadedStops = (rawData.manifest || 0) - (rawData.pullbacks || 0);
        const completedStops = loadedStops - (rawData.incompletes || 0);
        const mileagePay = (rawData.miles || 0) * rates.mileage;
        const fuelPay = (rawData.miles || 0) * rates.fuel;
        const stopPay = completedStops * rates.stop;
        const incPay = (rawData.incompletes || 0) * rates.incomplete;
        const thirdManPay = (rawData.third_man_status === 'NYC' || rawData.third_man_status === 'Y') ? rates.thirdMan : 0;
        const totalDaily = mileagePay + fuelPay + stopPay + incPay + thirdManPay + rates.base;
        const finalPay = (rawData.type === 'Dedicated') ? (rawData.dedicated_flat || 0) : (totalDaily - (rawData.deductions || 0) + (rawData.extra_pay || 0));
        
        return {
            id: rawData.id || Date.now(),
            date: rawData.date,
            contractor: rawData.contractor || '3 OF LIFE LLC',
            type: rawData.type || 'Regular',
            driver: rawData.driver || '',
            route_num: rawData.route_num || '',
            route_id: rawData.route_id || '',
            third_man_status: rawData.third_man_status || 'None',
            miles: parseFloat(rawData.miles || 0),
            manifest: parseInt(rawData.manifest || 0),
            pullbacks: parseInt(rawData.pullbacks || 0),
            incompletes: parseInt(rawData.incompletes || 0),
            dedicated_flat: parseFloat(rawData.dedicated_flat || 0),
            deductions: parseFloat(rawData.deductions || 0),
            extra_pay: parseFloat(rawData.extra_pay || 0),
            loaded_stops: loadedStops,
            completed_stops: completedStops,
            mileage_pay: mileagePay,
            fuel_pay: fuelPay,
            total_daily: totalDaily,
            final_pay: finalPay,
            year: getYear(rawData.date),
            week: getWeekNumber(rawData.date).toString()
        };
    }

    document.getElementById('route-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        let rawData = {
            id: editingRouteId || Date.now(),
            date: document.getElementById('f-date').value,
            contractor: document.getElementById('f-contractor').value,
            type: document.getElementById('f-type').value,
            driver: document.getElementById('f-driver').value,
            route_num: document.getElementById('f-routeNum').value,
            route_id: document.getElementById('f-routeId').value,
            third_man_status: document.getElementById('f-3rdman').value,
            miles: document.getElementById('f-miles').value,
            manifest: document.getElementById('f-manifest').value,
            pullbacks: document.getElementById('f-pullbacks').value,
            incompletes: document.getElementById('f-incompletes').value,
            dedicated_flat: document.getElementById('f-dedicated').value,
            deductions: document.getElementById('f-deductions').value,
            extra_pay: document.getElementById('f-extra').value
        };

        const selCode = document.getElementById('f-contractor').value;
        const selCompany = (companies || []).find(c => c.code === selCode);
        const routeCo = selCode || requireWriteCompany();
        if (!routeCo) { alert('Please select a Company for this route.'); return; }
        // store the company name in the route's contractor field (keeps the
        // Daily Report grouping working), and scope the record by its code
        rawData.contractor = selCompany ? selCompany.name : (rawData.contractor || selCode);

        if (editingRouteId) {
            // edit_route diffs each key in p_fields against the row's
            // current value and only writes (and audits) the ones that
            // actually changed — but 'id' has no business being in that
            // diff set at all (it happens to always match its own current
            // value here, so the RPC's equal-value skip saves it, but
            // that's incidental, not something to depend on for a primary
            // key column), so it's stripped out explicitly before sending.
            const { id: _unusedId, ...routeFields } = rawData;
            const { data, error } = await supabaseClient.rpc('edit_route', { p_actor: currentUsername, p_id: parseInt(editingRouteId), p_fields: routeFields });
            if (error) { alert('Error: ' + error.message); return; }
            cancelRouteEdit();
            fetchRoutesFromCloud();
            return;
        }

        const payload = buildRoutePayload(rawData);
        payload.company_code = routeCo;
        const { error } = await supabaseClient.rpc('create_route', { p_actor: currentUsername, p_fields: payload });
        if (error) alert('Error: ' + error.message);
        else {
            document.getElementById('route-form').reset();
            fetchRoutesFromCloud();
        }
    });

    // --- EXCEL FILE IMPORT HANDLER (TARGETS 'TRACKER' TAB & SKIPS METADATA ROW) ---
    document.getElementById('file-upload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                
                let targetSheetName = workbook.SheetNames.find(name => name.trim().toLowerCase() === 'tracker');
                if (!targetSheetName) {
                    targetSheetName = workbook.SheetNames[0];
                }
                
                const worksheet = workbook.Sheets[targetSheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { range: 1 });
                
                if (!json.length) {
                    alert(`The '${targetSheetName}' tab in the Excel file is empty.`);
                    return;
                }

                const importCo = requireWriteCompany();
                if (!importCo) return;
                let newRoutes = [];
                json.forEach((row, index) => {
                    let dStr = row['Delivery Date'] || row['delivery_date'] || row['Date'] || new Date().toISOString().split('T')[0];
                    
                    if (typeof dStr === 'number') {
                        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                        dStr = new Date(excelEpoch.getTime() + dStr * 86400000).toISOString().split('T')[0];
                    }

                    let rawData = {
                        id: Date.now() + index,
                        date: dStr,
                        contractor: row['Contractor'] || row['contractor'] || '3 OF LIFE LLC',
                        type: row['Regular/Dedicated'] || row['Route Type'] || row['Reg/Ded'] || row['type'] || 'Regular',
                        driver: row['Driver'] || row['driver'] || 'Unknown',
                        route_num: row['Route #'] || row['route_num'] || '',
                        route_id: row['Route ID'] || row['route_id'] || '',
                        third_man_status: row['3rd. Man'] || row['3rd Man'] || row['third_man_status'] || 'None',
                        miles: parseFloat(row['Miles'] || row['miles'] || 0),
                        manifest: parseInt(row['Manifest Stops'] || row['manifest'] || 0),
                        pullbacks: parseInt(row['Pullbacks'] || row['pullbacks'] || 0),
                        incompletes: parseInt(row['Incompletes'] || row['incompletes'] || 0),
                        dedicated_flat: parseFloat(row['Dedicated Flat'] || row['Dedicated Flat Pay'] || row['dedicated_flat'] || 0),
                        deductions: parseFloat(row['Deductions'] || row['deductions'] || 0),
                        extra_pay: parseFloat(row['Extra Pay'] || row['extra_pay'] || 0)
                    };
                    const rp = buildRoutePayload(rawData);
                    rp.company_code = importCo;
                    newRoutes.push(rp);
                });

                const { error } = await supabaseClient.rpc('create_routes_batch', { p_actor: currentUsername, p_rows: newRoutes });
                if (error) {
                    alert('Error syncing routes to Supabase: ' + error.message);
                } else {
                    alert(`Successfully imported and synced ${newRoutes.length} routes from the '${targetSheetName}' tab!`);
                    document.getElementById('file-upload').value = '';
                    fetchRoutesFromCloud();
                }
            } catch (err) {
                alert('Error parsing Excel file: ' + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    });

    function renderTracker() {
        const tbody = document.getElementById('tracker-body');
        const filtered = getFilteredRoutes();
        tbody.innerHTML = filtered.length ? '' : '<tr><td colspan="17" style="text-align:center;">No route records.</td></tr>';
        filtered.forEach(r => {
            tbody.insertAdjacentHTML('beforeend', `
                <tr>
                    <td>${r.date}</td><td style="text-align:center">${escHtml(r.contractor)}</td><td style="text-align:center">${escHtml(r.type)}</td><td style="text-align:center">${escHtml(r.driver)}</td>
                    <td style="text-align:center">${escHtml(r.route_num || '-')}</td><td style="text-align:center">${escHtml(r.route_id || '-')}</td>
                    <td>${r.miles}</td><td>${r.manifest}</td><td>${r.pullbacks || '-'}</td><td>${r.loaded_stops}</td>
                    <td>${r.incompletes || '-'}</td><td>${r.completed_stops}</td><td>${formatMoney(r.mileage_pay)}</td><td>${formatMoney(r.fuel_pay)}</td>
                    <td class="money">${formatMoney(r.total_daily)}</td><td class="money">${formatMoney(r.final_pay)}</td>
                    <td style="text-align:center; white-space:nowrap;">${canEdit() ? `<button class="btn-small" style="padding:0.3rem 0.5rem;font-size:0.75rem;margin:0 3px 0 0;" onclick="editRoute(${r.id})">✎</button>` : ''}<button class="del-btn" onclick="deleteRoute(${r.id})">X</button></td>
                </tr>`);
        });
    }

    async function deleteRoute(id) {
        if(confirm("Delete this route?")) {
            const { error } = await supabaseClient.rpc('delete_route', { p_actor: currentUsername, p_id: id });
            if (error) alert('Error: ' + error.message);
            fetchRoutesFromCloud();
        }
    }

    function toggleFilter(category, value) {
        if(filters[category].has(value)) filters[category].delete(value);
        else filters[category].add(value);
        document.getElementById('clr-' + category).classList.toggle('active', filters[category].size > 0);
        updateUI();
    }
    function clearFilter(category) {
        filters[category].clear();
        document.getElementById('clr-' + category).classList.remove('active');
        updateUI();
    }
    function updateSlicerUI() {
        const uniques = { contractor: new Set(), year: new Set(), week: new Set(), date: new Set(), thirdMan: new Set() };
        routes.forEach(r => {
            uniques.contractor.add(r.contractor || '3 OF LIFE LLC');
            uniques.year.add(r.year || getYear(r.date));
            uniques.week.add(r.week || getWeekNumber(r.date).toString());
            uniques.date.add(r.date);
            uniques.thirdMan.add(r.third_man_status || 'None');
        });
        ['contractor', 'year', 'week', 'date', 'thirdMan'].forEach(cat => {
            const container = document.getElementById('slicer-' + cat);
            if (!container) return;
            container.innerHTML = '';
            Array.from(uniques[cat]).sort().forEach(val => {
                const el = document.createElement('div');
                el.className = 'slicer-item' + (filters[cat].has(val) ? ' selected' : '');
                el.textContent = val;
                el.onclick = () => toggleFilter(cat, val);
                container.appendChild(el);
            });
        });
    }

    function toggleNode(id) { expandedState[id] = !expandedState[id]; renderDailyReport(); }
    function toggleAllNodes(state) {
        routes.forEach(r => {
            const y = r.year || getYear(r.date);
            const w = r.week || getWeekNumber(r.date).toString();
            expandedState[`y-${y}`] = state;
            expandedState[`w-${y}-${w}`] = state;
        });
        renderDailyReport();
    }
    function getFilteredRoutes() {
        return routes.filter(r => {
            const y = r.year || getYear(r.date);
            const w = r.week || getWeekNumber(r.date).toString();
            const cont = r.contractor || '3 OF LIFE LLC';
            const tm = r.third_man_status || 'None';

            if(filters.contractor.size && !filters.contractor.has(cont)) return false;
            if(filters.year.size && !filters.year.has(y)) return false;
            if(filters.week.size && !filters.week.has(w)) return false;
            if(filters.date.size && !filters.date.has(r.date)) return false;
            if(filters.thirdMan.size && !filters.thirdMan.has(tm)) return false;
            return true;
        });
    }

    function sumObject() { return { routes:0, miles:0, manifest:0, pullbacks:0, loaded:0, incompletes:0, completed:0, milPay:0, fuelPay:0, thirdManPay:0, dedFlat:0, deductions:0, extra:0, totalPay:0 }; }
    function addSums(target, r) {
        target.routes++;
        target.miles += parseFloat(r.miles || 0);
        target.manifest += parseInt(r.manifest || 0);
        target.pullbacks += parseInt(r.pullbacks || 0);
        target.loaded += parseInt(r.loaded_stops || 0);
        target.incompletes += parseInt(r.incompletes || 0);
        target.completed += parseInt(r.completed_stops || 0);
        target.milPay += parseFloat(r.mileage_pay || 0);
        target.fuelPay += parseFloat(r.fuel_pay || 0);
        target.thirdManPay += (r.third_man_status === 'NYC' || r.third_man_status === 'Y') ? 125 : 0;
        target.dedFlat += parseFloat(r.dedicated_flat || 0);
        target.deductions += parseFloat(r.deductions || 0);
        target.extra += parseFloat(r.extra_pay || 0);
        target.totalPay += parseFloat(r.final_pay || 0);
    }

    function renderRowHTML(label, sums, cssClass, iconNodeId, isVisible) {
        if(!isVisible) return '';
        let iconHtml = iconNodeId ? `<span class="toggle-btn" onclick="toggleNode('${iconNodeId}')">${expandedState[iconNodeId] ? '-' : '+'}</span>` : '';
        return `
            <tr class="${cssClass}">
                <td style="text-align:left;">${iconHtml} ${label}</td>
                <td>${sums.routes}</td><td>${numFmt(sums.miles)}</td><td>${sums.manifest}</td>
                <td>${sums.pullbacks || ''}</td><td>${sums.loaded}</td><td>${sums.incompletes || ''}</td>
                <td>${sums.completed}</td><td>${formatMoney(sums.milPay)}</td><td>${formatMoney(sums.fuelPay)}</td>
                <td>${formatMoney(sums.thirdManPay)}</td><td>${sums.dedFlat > 0 ? formatMoney(sums.dedFlat) : ''}</td>
                <td>${sums.deductions > 0 ? formatMoney(sums.deductions) : ''}</td><td>${sums.extra > 0 ? formatMoney(sums.extra) : ''}</td>
                <td class="money">${formatMoney(sums.totalPay)}</td>
            </tr>`;
    }

    // --- VEHICLES ----------------------------------------------------------
    let vehicles = [];
    let vehicleServices = {}; // vehicle_id -> [{id, service_date, description, type}]
    let editingVehicleId = null;

    async function fetchVehiclesFromCloud() {
        try {
            const [vq, sq] = await Promise.all([
                supabaseClient.rpc('get_vehicles', { p_actor: currentUsername, p_company: currentCompany }),
                supabaseClient.rpc('get_vehicle_services', { p_actor: currentUsername, p_company: currentCompany })
            ]);
            if (vq.error) { console.error('get_vehicles:', vq.error); vehicles = []; }
            else vehicles = vq.data || [];
            const svc = {};
            if (sq.error) { console.error('get_vehicle_services:', sq.error); }
            else (sq.data || []).forEach(s => { (svc[s.vehicle_id] = svc[s.vehicle_id] || []).push(s); });
            vehicleServices = svc;
        } catch (e) { console.error('fetchVehiclesFromCloud:', e); }
        renderVehicles();
    }

    // ===== FINANCIAL: Invoices (accounts receivable) =====================
    let invoices = [];
    let invoiceLineItems = {}; // invoice_id -> [{id, line_date, description, rate, qty, extra, amount}]
    let editingInvoiceId = null;
    let invoiceDraftLines = []; // rows currently in the New/Edit Invoice line-item editor, before saving

    async function fetchInvoicesFromCloud() {
        try {
            const [iq, lq] = await Promise.all([
                supabaseClient.rpc('get_invoices', { p_actor: currentUsername, p_company: currentCompany }),
                supabaseClient.rpc('get_invoice_line_items', { p_actor: currentUsername, p_company: currentCompany })
            ]);
            if (iq.error) { console.error('get_invoices:', iq.error); invoices = []; }
            else invoices = iq.data || [];
            const map = {};
            if (lq.error) { console.error('get_invoice_line_items:', lq.error); }
            else (lq.data || []).forEach(li => { (map[li.invoice_id] = map[li.invoice_id] || []).push(li); });
            invoiceLineItems = map;
        } catch (e) { console.error('fetchInvoicesFromCloud:', e); }
        renderInvoices();
    }

    // Draft line-item editor — a small in-memory table the person builds up
    // with "+ Add Line" before ever saving, mirroring how the sample
    // invoices are laid out (date, description/route, rate, extra, amount).
    // Amount auto-fills from rate*qty+extra as those change, but stays a
    // normal editable field so an odd line (like the sample's $570
    // extra-only row with no rate) can still be entered directly.
    function addInvoiceLineItemRow(row) {
        invoiceDraftLines.push(row || { line_date: '', description: '', rate: '', qty: 1, extra: '', amount: '' });
        renderInvoiceLineItemEditor();
    }
    function removeInvoiceLineItemRow(idx) {
        invoiceDraftLines.splice(idx, 1);
        renderInvoiceLineItemEditor();
    }
    function updateInvoiceLineItemRow(idx, field, value) {
        const row = invoiceDraftLines[idx];
        if (!row) return;
        row[field] = value;
        if (field === 'rate' || field === 'qty' || field === 'extra') {
            const rate = parseFloat(row.rate) || 0, qty = parseFloat(row.qty) || 1, extra = parseFloat(row.extra) || 0;
            row.amount = +(rate * qty + extra).toFixed(2);
        }
        renderInvoiceLineItemEditor();
    }
    function invoiceDraftTotal() {
        return invoiceDraftLines.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0);
    }
    function renderInvoiceLineItemEditor() {
        const el = document.getElementById('inv-line-items-editor');
        if (!el) return;
        if (!invoiceDraftLines.length) {
            el.innerHTML = `<div style="color:var(--text-muted); font-size:12px; padding:4px 0;">${t('d_no_line_items_hint')}</div>`;
        } else {
            el.innerHTML = invoiceDraftLines.map((r, i) => `
                <div class="form-row" style="margin:0 0 6px; align-items:center;">
                    <div class="field"><input type="date" value="${r.line_date || ''}" onchange="updateInvoiceLineItemRow(${i},'line_date',this.value)"></div>
                    <div class="field field-wide"><input type="text" placeholder="${t('d_desc_route_ph')}" value="${escHtml(r.description || '')}" oninput="updateInvoiceLineItemRow(${i},'description',this.value)"></div>
                    <div class="field"><input type="number" step="0.01" placeholder="${t('d_rate_ph')}" value="${r.rate ?? ''}" oninput="updateInvoiceLineItemRow(${i},'rate',this.value)"></div>
                    <div class="field" style="max-width:70px;"><input type="number" step="1" placeholder="${t('d_qty_ph')}" value="${r.qty ?? 1}" oninput="updateInvoiceLineItemRow(${i},'qty',this.value)"></div>
                    <div class="field"><input type="number" step="0.01" placeholder="${t('d_extra_ph')}" value="${r.extra ?? ''}" oninput="updateInvoiceLineItemRow(${i},'extra',this.value)"></div>
                    <div class="field"><input type="number" step="0.01" placeholder="${t('d_amount_ph')}" value="${r.amount ?? ''}" oninput="updateInvoiceLineItemRow(${i},'amount',this.value)"></div>
                    <span class="del-btn" onclick="removeInvoiceLineItemRow(${i})">✕</span>
                </div>`).join('');
        }
        const totalEl = document.getElementById('inv-line-items-total');
        if (totalEl) totalEl.textContent = 'Total: ' + formatMoney(invoiceDraftTotal());
    }

    function nextInvoiceNumber() {
        let max = 0;
        invoices.forEach(i => { max = Math.max(max, extractIdNumber(i.invoice_id)); });
        return max;
    }

    async function saveInvoice() {
        if (!canEdit()) return;
        const co = requireWriteCompany();
        if (!co) return;
        const customer = document.getElementById('inv-customer').value.trim();
        if (!customer) { alert('Enter a customer name.'); return; }
        const lineItemsPayload = invoiceDraftLines
            .filter(r => r.description || r.amount)
            .map(r => ({ line_date: r.line_date || null, description: r.description || '', rate: r.rate === '' ? null : parseFloat(r.rate), qty: parseFloat(r.qty) || 1, extra: r.extra === '' ? null : parseFloat(r.extra), amount: parseFloat(r.amount) || 0 }));
        const total = invoiceDraftTotal();

        if (editingInvoiceId) {
            const { error } = await supabaseClient.rpc('update_invoice', {
                p_actor: currentUsername, p_id: editingInvoiceId,
                p_invoice_number: document.getElementById('inv-number').value.trim() || null,
                p_customer_name: customer, p_bill_to: document.getElementById('inv-bill-to').value.trim() || null,
                p_invoice_date: document.getElementById('inv-date').value || null, p_due_date: document.getElementById('inv-due-date').value || null,
                p_status: document.getElementById('inv-status').value, p_notes: document.getElementById('inv-notes').value.trim() || null
            });
            if (error) { alert('Error: ' + error.message); return; }
        } else {
            const invoiceId = `${idPrefix()}${String(nextInvoiceNumber() + 1).padStart(settings.chargeDigits, '0')}INV`;
            const { error } = await supabaseClient.rpc('create_invoice', {
                p_actor: currentUsername, p_id: invoiceId, p_company: co,
                p_invoice_number: document.getElementById('inv-number').value.trim() || null,
                p_customer_name: customer, p_bill_to: document.getElementById('inv-bill-to').value.trim() || null,
                p_invoice_date: document.getElementById('inv-date').value || null, p_due_date: document.getElementById('inv-due-date').value || null,
                p_status: document.getElementById('inv-status').value, p_notes: document.getElementById('inv-notes').value.trim() || null,
                p_total_amount: total, p_line_items: lineItemsPayload
            });
            if (error) { alert('Error: ' + error.message); return; }
        }
        cancelInvoiceEdit();
        fetchInvoicesFromCloud();
    }

    function editInvoice(id) {
        const inv = invoices.find(i => i.invoice_id === id);
        if (!inv) return;
        editingInvoiceId = id;
        document.getElementById('inv-number').value = inv.invoice_number || '';
        document.getElementById('inv-customer').value = inv.customer_name || '';
        document.getElementById('inv-date').value = inv.invoice_date || '';
        document.getElementById('inv-due-date').value = inv.due_date || '';
        document.getElementById('inv-status').value = inv.status || 'Unpaid';
        document.getElementById('inv-bill-to').value = inv.bill_to || '';
        document.getElementById('inv-notes').value = inv.notes || '';
        // Line items for an existing invoice are managed inline in its own
        // expanded card (add/delete one at a time) — the top editor here is
        // for header fields only once an invoice already exists, so it's
        // deliberately left empty on edit rather than reloading its lines.
        invoiceDraftLines = [];
        renderInvoiceLineItemEditor();
        document.getElementById('invoice-form-title').textContent = t('edit_invoice_title');
        document.getElementById('invoice-save-btn').textContent = t('update_invoice_btn');
        document.getElementById('invoice-cancel-btn').style.display = 'inline-block';
        document.getElementById('invoice-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function cancelInvoiceEdit() {
        editingInvoiceId = null;
        ['inv-number', 'inv-customer', 'inv-date', 'inv-due-date', 'inv-bill-to', 'inv-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('inv-status').value = 'Unpaid';
        invoiceDraftLines = [];
        renderInvoiceLineItemEditor();
        document.getElementById('invoice-form-title').textContent = t('new_invoice_title');
        document.getElementById('invoice-save-btn').textContent = t('save_invoice_btn');
        document.getElementById('invoice-cancel-btn').style.display = 'none';
    }

    async function deleteInvoice(id) {
        if (!canEdit()) return;
        if (!confirm('Delete invoice ' + id + ' and all its line items?')) return;
        const { error } = await supabaseClient.rpc('delete_invoice', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        fetchInvoicesFromCloud();
    }

    async function addInvoiceLineItemToExisting(invoiceId) {
        if (!canEdit()) return;
        const dateEl = document.getElementById(`ili-date-${invoiceId}`);
        const descEl = document.getElementById(`ili-desc-${invoiceId}`);
        const rateEl = document.getElementById(`ili-rate-${invoiceId}`);
        const qtyEl = document.getElementById(`ili-qty-${invoiceId}`);
        const extraEl = document.getElementById(`ili-extra-${invoiceId}`);
        const amountEl = document.getElementById(`ili-amount-${invoiceId}`);
        if (!descEl.value.trim()) { alert('Enter a description.'); return; }
        const { error } = await supabaseClient.rpc('add_invoice_line_item', {
            p_actor: currentUsername, p_invoice_id: invoiceId,
            p_line_date: dateEl.value || null, p_description: descEl.value.trim(),
            p_rate: rateEl.value === '' ? null : parseFloat(rateEl.value),
            p_qty: qtyEl.value === '' ? 1 : parseFloat(qtyEl.value),
            p_extra: extraEl.value === '' ? null : parseFloat(extraEl.value),
            p_amount: parseFloat(amountEl.value) || 0
        });
        if (error) { alert('Error: ' + error.message); return; }
        recExpanded.invoices.add(invoiceId);
        fetchInvoicesFromCloud();
    }

    async function deleteInvoiceLineItem(id, invoiceId) {
        if (!canEdit()) return;
        const { error } = await supabaseClient.rpc('delete_invoice_line_item', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        recExpanded.invoices.add(invoiceId);
        fetchInvoicesFromCloud();
    }

    function invoiceDetailHtml(inv) {
        const editable = canEdit();
        const lines = (invoiceLineItems[inv.invoice_id] || []).slice().sort((a, b) => String(a.line_date || '').localeCompare(String(b.line_date || '')) || a.id - b.id);
        const rows = lines.length
            ? lines.map(li => `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:12px;">
                    <span>${li.line_date ? escHtml(li.line_date) + ' — ' : ''}${escHtml(li.description)}${li.rate != null ? ` · rate ${formatMoney(li.rate)}` : ''}${li.qty && li.qty != 1 ? ` × ${li.qty}` : ''}${li.extra ? ` + ${formatMoney(li.extra)} extra` : ''} <strong>${formatMoney(li.amount)}</strong></span>
                    ${editable ? `<span class="del-btn" onclick="deleteInvoiceLineItem(${li.id}, '${escJsAttr(inv.invoice_id)}')">✕</span>` : ''}
                </div>`).join('')
            : `<div style="color:var(--text-muted); font-size:12px;">${t('d_no_line_items')}</div>`;
        return `
            <div class="rec-detail-grid">
                <div><div class="k">${t('bill_to')}</div><div class="v" style="white-space:pre-line;">${inv.bill_to ? escHtml(inv.bill_to) : '-'}</div></div>
                <div><div class="k">${t('due_date')}</div><div class="v">${inv.due_date || '-'}</div></div>
                <div><div class="k">${t('notes')}</div><div class="v">${inv.notes ? escHtml(inv.notes) : '-'}</div></div>
            </div>
            <div class="detail-subhead" style="margin-top:10px;">${t('line_items')}</div>
            ${editable ? `
            <div class="form-row" style="margin:6px 0;">
                <div class="field"><input type="date" id="ili-date-${inv.invoice_id}"></div>
                <div class="field field-wide"><input type="text" id="ili-desc-${inv.invoice_id}" placeholder="${t('d_desc_route_ph')}"></div>
                <div class="field"><input type="number" step="0.01" id="ili-rate-${inv.invoice_id}" placeholder="${t('d_rate_ph')}"></div>
                <div class="field" style="max-width:70px;"><input type="number" step="1" id="ili-qty-${inv.invoice_id}" placeholder="${t('d_qty_ph')}" value="1"></div>
                <div class="field"><input type="number" step="0.01" id="ili-extra-${inv.invoice_id}" placeholder="${t('d_extra_ph')}"></div>
                <div class="field"><input type="number" step="0.01" id="ili-amount-${inv.invoice_id}" placeholder="${t('d_amount_ph')}"></div>
                <button type="button" class="btn-small" style="background:var(--navy);" onclick="addInvoiceLineItemToExisting('${escJsAttr(inv.invoice_id)}')">${t('d_add')}</button>
            </div>` : ''}
            <div>${rows}</div>
            <div style="text-align:right; font-weight:700; margin-top:6px; font-family:var(--mono);">Total: ${formatMoney(inv.total_amount)}</div>
            <div class="rec-actions" style="margin-top:10px;">
                ${attachBtnHtml('invoice', inv.invoice_id)}
                ${editable ? `<button class="btn-small" style="background:var(--navy);margin:0;" onclick="editInvoice('${escJsAttr(inv.invoice_id)}')">${t('d_edit')}</button>
                <button class="del-btn" onclick="deleteInvoice('${escJsAttr(inv.invoice_id)}')">${t('d_delete')}</button>` : ''}
            </div>`;
    }

    function renderInvoices() {
        const grid = document.getElementById('invoice-stats-grid');
        if (grid) {
            const unpaid = invoices.filter(i => i.status === 'Unpaid');
            const unpaidTotal = unpaid.reduce((a, i) => a + (parseFloat(i.total_amount) || 0), 0);
            const monthStart = todayStr().slice(0, 7) + '-01';
            // Voided invoices are cancelled — excluded from the money total.
            const thisMonth = invoices.filter(i => i.invoice_date && i.invoice_date >= monthStart && i.status !== 'Void');
            const thisMonthTotal = thisMonth.reduce((a, i) => a + (parseFloat(i.total_amount) || 0), 0);
            grid.innerHTML = `
                <div class="stat-card"><div class="stat-label">${t('d_stat_unpaid')}</div><div class="stat-value">${unpaid.length}</div><div style="font-size:10px; color:var(--text-muted);">${formatMoney(unpaidTotal)}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_invoiced_month')}</div><div class="stat-value">${formatMoney(thisMonthTotal)}</div><div style="font-size:10px; color:var(--text-muted);">${thisMonth.length} invoice(s)</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_total_invoices')}</div><div class="stat-value">${invoices.length}</div></div>`;
        }
        // Customer filter options (distinct customers), preserving selection.
        const custSel = document.getElementById('invoice-customer-filter');
        if (custSel) {
            const prev = custSel.value;
            const customers = Array.from(new Set(invoices.map(i => i.customer_name).filter(Boolean)))
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            custSel.innerHTML = `<option value="">${t('all_customers')}</option>` + customers.map(c => `<option value="${escHtml(c)}">${escHtml(c)}</option>`).join('');
            custSel.value = prev || '';
        }

        const query = (document.getElementById('invoice-search')?.value || '').toLowerCase();
        const statusF = document.getElementById('invoice-status-filter')?.value || '';
        const custF = document.getElementById('invoice-customer-filter')?.value || '';

        let list = invoices.filter(i => {
            const matchQ = !query || `${i.invoice_number || ''} ${i.customer_name || ''} ${i.notes || ''}`.toLowerCase().includes(query);
            const matchS = !statusF || i.status === statusF;
            const matchC = !custF || i.customer_name === custF;
            return matchQ && matchS && matchC;
        });

        list = applySort(list, 'invoices', {
            number: i => i.invoice_number || '',
            customer: i => i.customer_name || '',
            date: i => i.invoice_date || '',
            due: i => i.due_date || '',
            amount: i => parseFloat(i.total_amount) || 0,
            status: i => i.status || ''
        });
        updateRecSortUI('invoices');

        const container = document.getElementById('invoices-tbody');
        if (!container) return;
        container.className = 'record-grid';
        if (!list.length) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_invoices')}</div>`; return; }
        container.innerHTML = '';

        // Group into Unpaid first, then Paid, then Void (then any other status).
        const order = ['Unpaid', 'Paid', 'Void'];
        const groups = {};
        list.forEach(i => { const s = i.status || '(no status)'; (groups[s] = groups[s] || []).push(i); });
        const statuses = Object.keys(groups).sort((a, b) => {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            return ((ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)) || a.localeCompare(b);
        });
        statuses.forEach(status => {
            const items = groups[status];
            const collapsed = collapsedStatusGroups.invoices.has(status);
            const groupTotal = items.reduce((a, i) => a + (parseFloat(i.total_amount) || 0), 0);
            container.insertAdjacentHTML('beforeend', `<div class="rec-group-header" style="grid-column:1/-1; cursor:pointer;" onclick="toggleStatusGroup('invoices','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem;">(${items.length}) · ${formatMoney(groupTotal)}</span></div>`);
            if (collapsed) return;
            items.forEach(inv => {
                const open = recExpanded.invoices.has(inv.invoice_id);
                container.insertAdjacentHTML('beforeend', `
                    <div class="rec-card${open ? ' open' : ''}" id="rec-invoices-${inv.invoice_id}">
                        <div class="rec-card-head" onclick="toggleRecCard('invoices','${inv.invoice_id}')">
                            <span class="rec-caret" data-caret="invoices-${inv.invoice_id}">${open ? '▾' : '▸'}</span>
                            <span class="rec-title">${inv.invoice_number ? `#${escHtml(inv.invoice_number)} — ` : ''}${escHtml(inv.customer_name)}</span>
                            <span class="rec-sub">${inv.invoice_date || '-'}</span>
                            ${attachInd('invoice', inv.invoice_id)}
                            <span class="rec-right"><span class="status-badge status-${inv.status}">${inv.status}</span> ${formatMoney(inv.total_amount)}</span>
                        </div>
                        <div class="rec-card-body">${invoiceDetailHtml(inv)}</div>
                    </div>`);
            });
        });
    }

    // ===== FINANCIAL: Bills (accounts payable — what we owe vendors) ======
    let bills = [];
    let editingBillId = null;

    async function fetchBillsFromCloud() {
        try {
            const { data, error } = await supabaseClient.rpc('get_bills', { p_actor: currentUsername, p_company: currentCompany });
            if (error) { console.error('get_bills:', error); bills = []; }
            else bills = data || [];
        } catch (e) { console.error('fetchBillsFromCloud:', e); }
        renderBills();
    }

    function nextBillNumber() {
        let max = 0;
        bills.forEach(b => { max = Math.max(max, extractIdNumber(b.bill_id)); });
        return max;
    }

    async function saveBill() {
        if (!canEdit()) return;
        const co = requireWriteCompany();
        if (!co) return;
        const vendor = document.getElementById('bill-vendor').value.trim();
        if (!vendor) { alert('Enter a vendor name.'); return; }
        const amount = parseFloat(document.getElementById('bill-amount').value) || 0;
        const payload = {
            p_vendor_name: vendor, p_bill_number: document.getElementById('bill-number').value.trim() || null,
            p_bill_date: document.getElementById('bill-date').value || null, p_due_date: document.getElementById('bill-due-date').value || null,
            p_amount: amount, p_status: document.getElementById('bill-status').value, p_notes: document.getElementById('bill-notes').value.trim() || null
        };
        let error;
        if (editingBillId) {
            ({ error } = await supabaseClient.rpc('update_bill', { p_actor: currentUsername, p_id: editingBillId, ...payload }));
        } else {
            const billId = `${idPrefix()}${String(nextBillNumber() + 1).padStart(settings.chargeDigits, '0')}BIL`;
            ({ error } = await supabaseClient.rpc('create_bill', { p_actor: currentUsername, p_id: billId, p_company: co, ...payload }));
        }
        if (error) { alert('Error: ' + error.message); return; }
        cancelBillEdit();
        fetchBillsFromCloud();
    }

    function editBill(id) {
        const b = bills.find(x => x.bill_id === id);
        if (!b) return;
        editingBillId = id;
        document.getElementById('bill-vendor').value = b.vendor_name || '';
        document.getElementById('bill-number').value = b.bill_number || '';
        document.getElementById('bill-date').value = b.bill_date || '';
        document.getElementById('bill-due-date').value = b.due_date || '';
        document.getElementById('bill-amount').value = b.amount || '';
        document.getElementById('bill-status').value = b.status || 'Unpaid';
        document.getElementById('bill-notes').value = b.notes || '';
        document.getElementById('bill-form-title').textContent = t('edit_bill_title');
        document.getElementById('bill-save-btn').textContent = t('update_bill_btn');
        document.getElementById('bill-cancel-btn').style.display = 'inline-block';
        document.getElementById('bill-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function cancelBillEdit() {
        editingBillId = null;
        ['bill-vendor', 'bill-number', 'bill-date', 'bill-due-date', 'bill-amount', 'bill-notes'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
        document.getElementById('bill-status').value = 'Unpaid';
        document.getElementById('bill-form-title').textContent = t('new_bill_title');
        document.getElementById('bill-save-btn').textContent = t('save_bill_btn');
        document.getElementById('bill-cancel-btn').style.display = 'none';
    }

    async function deleteBill(id) {
        if (!canEdit()) return;
        if (!confirm('Delete bill ' + id + '?')) return;
        const { error } = await supabaseClient.rpc('delete_bill', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        fetchBillsFromCloud();
    }

    // Suggests names from the Provider Pay roster (employees whose pay
    // type is "Provider") in the Vendor field's autocomplete, since many
    // bills payable are actually from providers already in the system —
    // picking a suggestion just fills in their name as plain text, it
    // doesn't require the vendor to be a provider (a fuel company, an
    // insurance bill, etc. can still be typed in freely).
    function populateBillVendorProviders() {
        const dl = document.getElementById('bill-vendor-providers');
        if (!dl) return;
        const providerNames = employees
            .filter(e => getPayType(e.id) === 'Provider')
            .map(e => `${e.first_name} ${e.last_name}`.trim())
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        dl.innerHTML = providerNames.map(n => `<option value="${escHtml(n)}">`).join('');
    }

    function renderBills() {
        populateBillVendorProviders();
        const grid = document.getElementById('bill-stats-grid');
        if (grid) {
            const unpaid = bills.filter(b => b.status === 'Unpaid');
            const unpaidTotal = unpaid.reduce((a, b) => a + (parseFloat(b.amount) || 0), 0);
            const overdue = unpaid.filter(b => b.due_date && b.due_date < todayStr());
            grid.innerHTML = `
                <div class="stat-card"><div class="stat-label">${t('d_stat_unpaid')}</div><div class="stat-value">${unpaid.length}</div><div style="font-size:10px; color:var(--text-muted);">${formatMoney(unpaidTotal)}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_overdue')}</div><div class="stat-value">${overdue.length}</div></div>
                <div class="stat-card"><div class="stat-label">${t('d_total_bills')}</div><div class="stat-value">${bills.length}</div></div>`;
        }
        // Vendor filter options (distinct vendors), preserving selection.
        const venSel = document.getElementById('bill-vendor-filter');
        if (venSel) {
            const prev = venSel.value;
            const vendors = Array.from(new Set(bills.map(b => b.vendor_name).filter(Boolean)))
                .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
            venSel.innerHTML = `<option value="">${t('all_vendors')}</option>` + vendors.map(v => `<option value="${escHtml(v)}">${escHtml(v)}</option>`).join('');
            venSel.value = prev || '';
        }

        const query = (document.getElementById('bill-search')?.value || '').toLowerCase();
        const statusF = document.getElementById('bill-status-filter')?.value || '';
        const vendorF = document.getElementById('bill-vendor-filter')?.value || '';

        let list = bills.filter(b => {
            const matchQ = !query || `${b.bill_number || ''} ${b.vendor_name || ''} ${b.notes || ''}`.toLowerCase().includes(query);
            const matchS = !statusF || b.status === statusF;
            const matchV = !vendorF || b.vendor_name === vendorF;
            return matchQ && matchS && matchV;
        });

        list = applySort(list, 'bills', {
            number: b => b.bill_number || '',
            vendor: b => b.vendor_name || '',
            date: b => b.bill_date || '',
            due: b => b.due_date || '',
            amount: b => parseFloat(b.amount) || 0,
            status: b => b.status || ''
        });
        updateRecSortUI('bills');

        const container = document.getElementById('bills-tbody');
        if (!container) return;
        container.className = 'record-grid';
        if (!list.length) { container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_bills')}</div>`; return; }
        container.innerHTML = '';
        const editable = canEdit();

        // Group into Unpaid first, then Paid, then Void (then any other status).
        const order = ['Unpaid', 'Paid', 'Void'];
        const groups = {};
        list.forEach(b => { const s = b.status || '(no status)'; (groups[s] = groups[s] || []).push(b); });
        const statuses = Object.keys(groups).sort((a, b) => {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            return ((ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)) || a.localeCompare(b);
        });
        statuses.forEach(status => {
            const items = groups[status];
            const collapsed = collapsedStatusGroups.bills.has(status);
            const groupTotal = items.reduce((a, b) => a + (parseFloat(b.amount) || 0), 0);
            container.insertAdjacentHTML('beforeend', `<div class="rec-group-header" style="grid-column:1/-1; cursor:pointer;" onclick="toggleStatusGroup('bills','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${status}</span> <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem;">(${items.length}) · ${formatMoney(groupTotal)}</span></div>`);
            if (collapsed) return;
            items.forEach(b => {
                const open = recExpanded.bills.has(b.bill_id);
                container.insertAdjacentHTML('beforeend', `
                    <div class="rec-card${open ? ' open' : ''}" id="rec-bills-${b.bill_id}">
                        <div class="rec-card-head" onclick="toggleRecCard('bills','${b.bill_id}')">
                            <span class="rec-caret" data-caret="bills-${b.bill_id}">${open ? '▾' : '▸'}</span>
                            <span class="rec-title">${escHtml(b.vendor_name)}</span>
                            <span class="rec-sub">${b.bill_number ? '#' + escHtml(b.bill_number) : ''} ${b.due_date ? '· due ' + b.due_date : ''}</span>
                            ${attachInd('bill', b.bill_id)}
                            <span class="rec-right"><span class="status-badge status-${b.status}">${b.status}</span> ${formatMoney(b.amount)}</span>
                        </div>
                        <div class="rec-card-body">
                            <div class="rec-detail-grid">
                                <div><div class="k">${t('bill_date')}</div><div class="v">${b.bill_date || '-'}</div></div>
                                <div><div class="k">${t('notes')}</div><div class="v">${b.notes ? escHtml(b.notes) : '-'}</div></div>
                            </div>
                            <div class="rec-actions" style="margin-top:10px;">
                                ${attachBtnHtml('bill', b.bill_id)}
                                ${editable ? `<button class="btn-small" style="background:var(--navy);margin:0;" onclick="editBill('${escJsAttr(b.bill_id)}')">${t('d_edit')}</button>
                                <button class="del-btn" onclick="deleteBill('${escJsAttr(b.bill_id)}')">${t('d_delete')}</button>` : ''}
                            </div>
                        </div>
                    </div>`);
            });
        });
    }

    document.getElementById('vehicle-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!canEdit()) return;
        const co = requireWriteCompany();
        if (!co) return;
        const payload = {
            company_code: co,
            truck_number: document.getElementById('vTruckNum').value.trim() || null,
            year: document.getElementById('vYear').value.trim(),
            make: document.getElementById('vMake').value.trim(),
            model: document.getElementById('vModel').value.trim(),
            plate: document.getElementById('vPlate').value.trim() || null,
            vin: document.getElementById('vVin').value.trim() || null,
            reg_expiry: document.getElementById('vRegExp').value || null,
            insurance_company: document.getElementById('vInsCo').value.trim() || null,
            insurance_policy: document.getElementById('vInsPol').value.trim() || null,
            insurance_expiry: document.getElementById('vInsExp').value || null,
            notes: document.getElementById('vNotes').value.trim() || null
        };
        let error;
        if (editingVehicleId) {
            ({ error } = await supabaseClient.rpc('update_vehicle', {
                p_actor: currentUsername, p_id: editingVehicleId, p_truck_number: payload.truck_number,
                p_year: payload.year, p_make: payload.make, p_model: payload.model, p_plate: payload.plate,
                p_vin: payload.vin, p_reg_expiry: payload.reg_expiry, p_insurance_company: payload.insurance_company,
                p_insurance_policy: payload.insurance_policy, p_insurance_expiry: payload.insurance_expiry, p_notes: payload.notes
            }));
        } else {
            const id = `${idPrefix()}${String(vehicles.length + 1).padStart(4, '0')}V`;
            ({ error } = await supabaseClient.rpc('create_vehicle', {
                p_actor: currentUsername, p_id: id, p_company: payload.company_code, p_truck_number: payload.truck_number,
                p_year: payload.year, p_make: payload.make, p_model: payload.model, p_plate: payload.plate,
                p_vin: payload.vin, p_reg_expiry: payload.reg_expiry, p_insurance_company: payload.insurance_company,
                p_insurance_policy: payload.insurance_policy, p_insurance_expiry: payload.insurance_expiry, p_notes: payload.notes
            }));
        }
        if (error) { alert('Error: ' + error.message); return; }
        cancelVehicleEdit();
        this.reset();
        fetchVehiclesFromCloud();
    });

    function editVehicle(id) {
        const v = vehicles.find(x => x.id === id);
        if (!v) return;
        editingVehicleId = id;
        document.getElementById('vTruckNum').value = v.truck_number || '';
        document.getElementById('vYear').value = v.year || '';
        document.getElementById('vMake').value = v.make || '';
        document.getElementById('vModel').value = v.model || '';
        document.getElementById('vPlate').value = v.plate || '';
        document.getElementById('vVin').value = v.vin || '';
        document.getElementById('vRegExp').value = v.reg_expiry || '';
        document.getElementById('vInsCo').value = v.insurance_company || '';
        document.getElementById('vInsPol').value = v.insurance_policy || '';
        document.getElementById('vInsExp').value = v.insurance_expiry || '';
        document.getElementById('vNotes').value = v.notes || '';
        document.getElementById('vehicle-save-btn').textContent = 'Save Changes';
        document.getElementById('vehicle-cancel-btn').style.display = 'inline-block';
        document.getElementById('vehicle-form-panel').scrollIntoView({ behavior: 'smooth' });
    }

    function cancelVehicleEdit() {
        editingVehicleId = null;
        document.getElementById('vehicle-save-btn').textContent = '+ Add Vehicle';
        document.getElementById('vehicle-cancel-btn').style.display = 'none';
        document.getElementById('vehicle-form').reset();
    }

    async function deleteVehicle(id) {
        if (!canEdit()) return;
        if (!confirm('Delete this vehicle and its whole service log?')) return;
        const { error } = await supabaseClient.rpc('delete_vehicle', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        fetchVehiclesFromCloud();
    }

    async function addVehicleService(vehicleId) {
        if (!canEdit()) return;
        const dateEl = document.getElementById(`vs-date-${vehicleId}`);
        const descEl = document.getElementById(`vs-desc-${vehicleId}`);
        const typeEl = document.getElementById(`vs-type-${vehicleId}`);
        const mileageEl = document.getElementById(`vs-mileage-${vehicleId}`);
        const nextMileageEl = document.getElementById(`vs-next-mileage-${vehicleId}`);
        if (!dateEl.value || !descEl.value.trim()) { alert('Enter both a date and a description.'); return; }
        const { error } = await supabaseClient.rpc('add_vehicle_service', {
            p_actor: currentUsername, p_vehicle_id: vehicleId, p_service_date: dateEl.value,
            p_description: descEl.value.trim(), p_type: typeEl.value,
            p_mileage_at_service: mileageEl.value ? parseInt(mileageEl.value, 10) : null,
            p_next_service_mileage: nextMileageEl.value ? parseInt(nextMileageEl.value, 10) : null
        });
        if (error) { alert('Error: ' + error.message); return; }
        recExpanded.vehicles.add(vehicleId);
        fetchVehiclesFromCloud();
    }

    async function deleteVehicleService(id, vehicleId) {
        if (!canEdit() || !id) return;
        const { error } = await supabaseClient.rpc('delete_vehicle_service', { p_actor: currentUsername, p_id: id });
        if (error) { alert('Error: ' + error.message); return; }
        recExpanded.vehicles.add(vehicleId);
        fetchVehiclesFromCloud();
    }

    function vehicleLabel(v) {
        return `${v.truck_number ? `#${v.truck_number} — ` : ''}${v.year || ''} ${v.make || ''} ${v.model || ''}`.trim();
    }

    // Quick top-level scheduler — a shortcut for the exact same
    // add_vehicle_service RPC the per-vehicle Service Log form already
    // uses (type hardcoded to 'Scheduled'), just without needing to first
    // find and expand that specific truck's card.
    function populateScheduleMaintenanceTruckDropdown() {
        const sel = document.getElementById('sched-maint-truck');
        if (!sel) return;
        const sorted = vehicles.slice().sort((a, b) => vehicleLabel(a).localeCompare(vehicleLabel(b), undefined, { sensitivity: 'base' }));
        sel.innerHTML = '<option value="">— Select truck —</option>' + sorted.map(v => `<option value="${v.id}">${escHtml(vehicleLabel(v))}</option>`).join('');
    }

    async function scheduleMaintenance() {
        if (!canEdit()) return;
        const truckEl = document.getElementById('sched-maint-truck');
        const dateEl = document.getElementById('sched-maint-date');
        const descEl = document.getElementById('sched-maint-desc');
        if (!truckEl.value) { alert('Pick a truck.'); return; }
        if (!dateEl.value || !descEl.value.trim()) { alert('Enter both a date and a description.'); return; }
        const { error } = await supabaseClient.rpc('add_vehicle_service', {
            p_actor: currentUsername, p_vehicle_id: truckEl.value, p_service_date: dateEl.value,
            p_description: descEl.value.trim(), p_type: 'Scheduled',
            p_mileage_at_service: null, p_next_service_mileage: null
        });
        if (error) { alert('Error: ' + error.message); return; }
        dateEl.value = ''; descEl.value = '';
        await fetchVehiclesFromCloud();
    }

    // Expand that truck's card in the list below and scroll to it — used
    // when tapping an item in the Upcoming Maintenance list, so picking a
    // reminder actually takes you to the truck it's about.
    function jumpToVehicle(vehicleId) {
        recExpanded.vehicles.add(vehicleId);
        renderVehicles();
        document.getElementById(`rec-vehicles-${vehicleId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Aggregates every truck's Scheduled (not yet Performed) service
    // records into one soonest-first list, instead of having to open each
    // truck's own card one at a time to see what's coming up — same idea
    // as Expiring Documents, but for maintenance instead of paperwork.
    function renderUpcomingMaintenance() {
        const container = document.getElementById('upcoming-maint-list');
        if (!container) return;
        const today = todayStr();
        const editable = canEdit();
        const rows = [];
        vehicles.forEach(v => {
            (vehicleServices[v.id] || []).forEach(s => {
                if (s.type === 'Scheduled' && s.service_date >= today) rows.push({ ...s, vehicleId: v.id, vehicleLabel: vehicleLabel(v) });
            });
        });
        rows.sort((a, b) => String(a.service_date).localeCompare(String(b.service_date)));
        if (!rows.length) {
            container.innerHTML = `<div style="color:var(--text-muted); font-size:12px; padding:6px 0;">${t('d_no_upcoming_maint')}</div>`;
            return;
        }
        container.innerHTML = rows.map(r => `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 4px; border-bottom:1px solid var(--border); font-size:13px; cursor:pointer;" onclick="jumpToVehicle('${escJsAttr(r.vehicleId)}')">
                <span><strong>${r.service_date}</strong> — ${escHtml(r.vehicleLabel)} · ${escHtml(r.description)}${expBadge(r.service_date, 14) || ''}</span>
                ${editable ? `<span class="del-btn" onclick="event.stopPropagation(); deleteVehicleService(${r.id}, '${escJsAttr(r.vehicleId)}')">✕</span>` : ''}
            </div>`).join('');
    }

    // Shared service-log block — used by both the desktop detail row and the
    // mobile card body, same pattern as employeeDetailHtml.
    function vehicleDetailHtml(v) {
        const editable = canEdit();
        const services = (vehicleServices[v.id] || []).slice().sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)));
        const rows = services.length
            ? services.map(s => `<div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border); font-size:12px;">
                    <span><strong>${s.service_date}</strong> — ${escHtml(s.description)} <span class="status-badge ${s.type === 'Performed' ? 'status-active' : ''}" style="margin-left:6px;">${s.type}</span>${s.mileage_at_service ? ` · ${Number(s.mileage_at_service).toLocaleString()} mi` : ''}${s.next_service_mileage ? ` <span style="color:var(--text-muted);">(next at ${Number(s.next_service_mileage).toLocaleString()} mi)</span>` : ''}</span>
                    ${editable ? `<span class="del-btn" onclick="deleteVehicleService(${s.id}, '${escJsAttr(v.id)}')">✕</span>` : ''}
                </div>`).join('')
            : `<div style="color:var(--text-muted); font-size:12px;" data-i18n="d_no_service_records">No service records yet.</div>`;
        return `
            <div class="rec-detail-grid">
                <div><div class="k" data-i18n="d_license_plate">License plate</div><div class="v">${v.plate ? escHtml(v.plate) : '-'}</div></div>
                <div><div class="k" data-i18n="d_vin">VIN</div><div class="v">${v.vin ? escHtml(v.vin) : '-'}</div></div>
                <div><div class="k" data-i18n="d_notes">Notes</div><div class="v">${v.notes ? escHtml(v.notes) : '-'}</div></div>
            </div>
            ${docSlotsHtml('vehicle', v.id, ['registration', 'insurance'])}
            <div class="detail-subhead" style="margin-top:10px;" data-i18n="d_service_log">Service Log</div>
            ${editable ? `
            <div class="form-row" style="margin:6px 0;">
                <div class="field"><input type="date" id="vs-date-${v.id}"></div>
                <div class="field field-wide"><input type="text" id="vs-desc-${v.id}" placeholder="e.g. Oil Change, Tire Rotation" data-i18n-placeholder="d_service_desc_ph"></div>
                <div class="field"><select id="vs-type-${v.id}"><option value="Performed">Performed</option><option value="Scheduled">Scheduled</option></select></div>
                <div class="field"><label style="font-size:9px;" data-i18n="d_mileage_at_service">Mileage at service</label><input type="number" min="0" id="vs-mileage-${v.id}" placeholder="e.g. 45210"></div>
                <div class="field"><label style="font-size:9px;" data-i18n="d_next_service_due">Next service due at</label><input type="number" min="0" id="vs-next-mileage-${v.id}" placeholder="e.g. 50210"></div>
                <button type="button" class="btn-small" style="background:var(--navy);" onclick="addVehicleService('${escJsAttr(v.id)}')" data-i18n="d_add">+ Add</button>
            </div>` : ''}
            <div>${rows}</div>
            <div class="rec-actions" style="margin-top:10px;">
                ${attachBtnHtml('vehicle', v.id)}
                ${editable ? `<button class="btn-small" style="background:var(--navy);margin:0;" onclick="editVehicle('${escJsAttr(v.id)}')" data-i18n="d_edit">Edit</button>
                <button class="del-btn" onclick="deleteVehicle('${escJsAttr(v.id)}')" data-i18n="d_delete">✕ Delete</button>` : ''}
            </div>`;
    }

    // Home dashboard — a company-wide snapshot built entirely from data
    // already loaded for other tabs (no separate fetch needed), so it's
    // always in sync with whatever's currently in memory. Only shown to
    // Administrator/Medium/SuperAdmin — View Only's whole model is "your
    // own records only", and these are company-wide aggregates, so it's
    // hidden from them the same way Fleet/Settings/etc. already are rather
    // than trying to build a scoped-down version of it.
    // "The 30-day check" — an Inactive employee's last paycheck — needs a
    // real human decision (release it, or leave it pending) once it's
    // eligible. This surfaces that as a standing reminder starting
    // Wednesday of each week and staying up through the rest of the week,
    // not just a one-time notice — and deliberately has no dismiss button
    // anywhere, since it's meant to keep showing until someone actually
    // acts on the Savings & Release Eligibility report (release it, or at
    // minimum make a decision there), not just be clicked away.
    function isWednesdayOrLater() {
        const day = new Date().getDay(); // 0=Sun..6=Sat, local time — this is a reminder for a person checking the app on a given day, so local time is what matters here, not UTC
        return day >= 3 && day <= 6;
    }
    function getOverdueReleaseDecisions() {
        return employees.filter(e => e.status === 'Inactive').filter(e => {
            const d = getEmpDetail(e.id);
            if (d.last_paycheck_released_at) return false;
            const eligible = lastWeekPayEligibleDate(e.id);
            return eligible && todayStr() >= eligible;
        });
    }
    function renderReleaseDecisionReminder() {
        const el = document.getElementById('release-decision-reminder');
        if (!el) return;
        if (!canEdit() || !isWednesdayOrLater()) { el.innerHTML = ''; el.style.display = 'none'; return; }
        const overdue = getOverdueReleaseDecisions();
        if (!overdue.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
        el.style.display = 'block';
        el.innerHTML = `
            <div class="note-box" style="border-left:3px solid #7c3aed;">
                <strong>🔔 ${overdue.length} last-paycheck decision(s) still pending</strong> — eligible for release, waiting on a manual decision:
                <div style="margin-top:6px;">${overdue.map(e => escHtml(e.first_name + ' ' + e.last_name)).join(', ')}</div>
                <div style="margin-top:8px;"><button type="button" class="btn-small" style="margin:0;background:#7c3aed;" onclick="openHomeShortcut('tab-savingsreport')">Review now</button></div>
            </div>`;
    }

    function renderHomeDashboard() {
        renderReleaseDecisionReminder();
        const grid = document.getElementById('home-stats-grid');
        if (!grid) return;

        const welcomeName = (currentUser && currentUser.first_name) ? currentUser.first_name : currentUsername;
        const welcomeEl = document.getElementById('home-welcome');
        if (welcomeEl) welcomeEl.textContent = `${t('welcome_prefix')} ${welcomeName}`;

        const activeEmployees = employees.filter(e => e.status === 'Active').length;

        const openClaims = claims.filter(c => claimBalance(c) > 0.004);
        const openClaimsTotal = openClaims.reduce((a, c) => a + claimBalance(c), 0);

        const otherCharges = charges.filter(c => c.charge_type !== WEEK_DEPOSIT_TYPE);
        const openCharges = otherCharges.filter(c => chargeBalance(c) > 0.004);
        const openChargesTotal = openCharges.reduce((a, c) => a + chargeBalance(c), 0);

        const savingsGoals = charges.filter(c => c.charge_type === WEEK_DEPOSIT_TYPE);
        const savingsInProgress = savingsGoals.filter(c => chargeBalance(c) > 0.004).length;
        const savingsSavedTotal = savingsGoals.reduce((a, c) => {
            const goal = Math.max(0, parseFloat(c.amount) || 0);
            return a + Math.max(0, goal - chargeBalance(c));
        }, 0);

        const weekStart = ymd(weekStartSunday(new Date()));
        const weekEndExclusive = ymd(new Date(new Date(weekStart + 'T00:00:00Z').getTime() + 7 * 86400000));
        const incomeThisWeek = additionalIncome.filter(i => i.start_date && i.start_date >= weekStart && i.start_date < weekEndExclusive);
        const incomeThisWeekTotal = incomeThisWeek.reduce((a, i) => a + (parseFloat(i.amount) || 0), 0);

        const expiringSoon = (typeof buildExpiringDocumentsList === 'function' ? buildExpiringDocumentsList() : []).filter(d => d.days !== null && d.days <= 30).length;
        const unreadNotifs = notifications.filter(n => !n.read_at).length;

        const card = (label, value, sub, onclick) => `
            <div class="stat-card"${onclick ? ` style="cursor:pointer;" onclick="${onclick}"` : ''}>
                <div class="stat-label">${label}</div>
                <div class="stat-value">${value}</div>
                ${sub ? `<div style="font-size:10px; color:var(--text-muted); margin-top:2px;">${sub}</div>` : ''}
            </div>`;

        grid.innerHTML =
            card(t('d_home_active_emps'), activeEmployees, '', "openHomeShortcut('tab-employees')") +
            card(t('d_home_open_claims'), openClaims.length, formatMoney(openClaimsTotal) + ' outstanding', "openHomeShortcut('tab-claims')") +
            card(t('d_home_active_charges'), openCharges.length, formatMoney(openChargesTotal) + ' outstanding', "openHomeShortcut('tab-claims')") +
            card('Semana de Fondo', savingsInProgress + ' in progress', formatMoney(savingsSavedTotal) + ' saved so far', "openHomeShortcut('tab-weekdeposit')") +
            card(t('d_home_income_week'), formatMoney(incomeThisWeekTotal), incomeThisWeek.length + ' record(s)', "openHomeShortcut('tab-income')") +
            card(t('d_stat_fleet'), vehicles.length, 'truck(s)', "openHomeShortcut('tab-vehicles')") +
            card(t('d_home_expiring'), expiringSoon, 'within 30 days', "openHomeShortcut('tab-expiring')") +
            card(t('d_home_unread'), unreadNotifs, '', "openHomeShortcut('tab-notifications')");
    }

    // Home's stat cards jump to a real group's tab — reuses the same
    // group-lookup TAB_GROUPS already has, so a card always opens through
    // the right group (marking that group's header active, expanding its
    // sub-tab row) instead of just switching tab-content in isolation.
    function openHomeShortcut(tabName) {
        const groupId = Object.keys(TAB_GROUPS).find(g => TAB_GROUPS[g].includes(tabName));
        if (groupId) { openGroup(groupId); }
        openTab(null, tabName);
        const btn = document.getElementById('btn-' + tabName);
        if (btn) btn.classList.add('active');
    }

    function renderVehicles() {
        populateScheduleMaintenanceTruckDropdown();
        renderUpcomingMaintenance();
        const query = (document.getElementById('vehicle-search')?.value || '').toLowerCase();
        let list = vehicles.filter(v => {
            if (!query) return true;
            const hay = `${v.id} ${v.truck_number || ''} ${v.year} ${v.make} ${v.model} ${v.plate || ''} ${v.vin || ''}`.toLowerCase();
            return hay.includes(query);
        });
        list = applySort(list, 'vehicles', {
            truck: v => v.truck_number || '',
            vehicle: v => `${v.year} ${v.make} ${v.model}`,
            plate: v => v.plate || '',
            regexp: v => v.reg_expiry || '',
            insexp: v => v.insurance_expiry || ''
        });

        const grid = document.getElementById('vehicle-stats-grid');
        if (grid) {
            const expiringReg = vehicles.filter(v => v.reg_expiry && expBadge(v.reg_expiry, 30)).length;
            const expiringIns = vehicles.filter(v => v.insurance_expiry && expBadge(v.insurance_expiry, 30)).length;
            grid.innerHTML = `
                <div class="stat-card"><div class="stat-label" data-i18n="d_stat_fleet">Fleet</div><div class="stat-value">${vehicles.length}</div></div>
                <div class="stat-card"><div class="stat-label" data-i18n="d_stat_reg_exp">Reg. expiring/expired</div><div class="stat-value">${expiringReg}</div></div>
                <div class="stat-card"><div class="stat-label" data-i18n="d_stat_ins_exp">Insurance expiring/expired</div><div class="stat-value">${expiringIns}</div></div>`;
        }

        const container = document.getElementById('vehicles-tbody');
        const editable = canEdit();

        if (isDesktopView()) {
            container.className = '';
            if (!list.length) { container.innerHTML = `<div style="text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_vehicles')}</div>`; return; }
            let rows = '';
            list.forEach(v => {
                const open = recExpanded.vehicles.has(v.id);
                rows += `<tr style="cursor:pointer;" onclick="toggleRecCard('vehicles','${v.id}')">
                    <td class="id-cell"><span class="rec-caret" data-caret="vehicles-${v.id}">${open ? '▾' : '▸'}</span> ${v.id} ${attachInd('vehicle', v.id)}</td>
                    <td>${v.truck_number ? escHtml(v.truck_number) : '-'}</td>
                    <td>${escHtml(v.year)} ${escHtml(v.make)} ${escHtml(v.model)}</td>
                    <td>${v.plate ? escHtml(v.plate) : '-'}</td>
                    <td>${v.reg_expiry || '-'}${expBadge(v.reg_expiry, 30)}</td>
                    <td>${v.insurance_company ? escHtml(v.insurance_company) : '-'}</td>
                    <td>${v.insurance_expiry || '-'}${expBadge(v.insurance_expiry, 30)}</td>
                </tr>
                <tr class="rec-card${open ? ' open' : ''}" id="rec-vehicles-${v.id}" style="display:${open ? 'table-row' : 'none'};">
                    <td colspan="7" style="padding:12px; background:var(--surface-2);">${vehicleDetailHtml(v)}</td>
                </tr>`;
            });
            container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
                <th data-i18n="d_th_id">ID</th><th data-i18n="d_th_truck">Truck #</th><th data-i18n="d_th_vehicle">Vehicle</th><th data-i18n="d_th_plate">Plate</th><th data-i18n="d_th_reg_exp">Reg. Expiry</th><th data-i18n="d_th_ins_co">Insurance Co.</th><th data-i18n="d_th_ins_exp">Insurance Expiry</th>
            </tr></thead><tbody>${rows}</tbody></table></div>`;
            updateRecSortUI('vehicles');
            applyTranslations();
            return;
        }

        container.className = 'record-grid';
        container.innerHTML = list.length ? '' : `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_vehicles')}</div>`;
        list.forEach(v => {
            const open = recExpanded.vehicles.has(v.id);
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-vehicles-${v.id}">
                    <div class="rec-card-head" onclick="toggleRecCard('vehicles','${v.id}')">
                        <span class="rec-caret" data-caret="vehicles-${v.id}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${v.truck_number ? `#${escHtml(v.truck_number)} — ` : ''}${escHtml(v.year)} ${escHtml(v.make)} ${escHtml(v.model)}</span>
                        <span class="rec-sub">${v.plate ? escHtml(v.plate) : v.id}</span>
                        ${attachInd('vehicle', v.id)}
                        <span class="rec-right">${expBadge(v.reg_expiry, 30) || expBadge(v.insurance_expiry, 30)}</span>
                    </div>
                    <div class="rec-card-body">
                        <div class="rec-detail-grid">
                            <div><div class="k" data-i18n="d_reg_expiry">Registration expiry</div><div class="v">${v.reg_expiry || '-'}${expBadge(v.reg_expiry, 30)}</div></div>
                            <div><div class="k" data-i18n="d_insurance_company">Insurance company</div><div class="v">${v.insurance_company ? escHtml(v.insurance_company) : '-'}</div></div>
                            <div><div class="k" data-i18n="d_policy_num">Policy #</div><div class="v">${v.insurance_policy ? escHtml(v.insurance_policy) : '-'}</div></div>
                            <div><div class="k" data-i18n="d_insurance_expiry">Insurance expiry</div><div class="v">${v.insurance_expiry || '-'}${expBadge(v.insurance_expiry, 30)}</div></div>
                        </div>
                        ${vehicleDetailHtml(v)}
                    </div>
                </div>`);
        });
        updateRecSortUI('vehicles');
        applyTranslations();
    }

    function renderDailyReport() {
        const tbody = document.getElementById('report-body');
        const tfoot = document.getElementById('report-foot');
        if(!tbody) return;

        const filtered = getFilteredRoutes();
        if (!filtered.length) {
            tbody.innerHTML = '<tr><td colspan="15" style="text-align:center; padding: 2rem;">No route data available.</td></tr>';
            tfoot.innerHTML = '';
            return;
        }

        const pivot = {}; const grandTotals = sumObject();
        filtered.forEach(r => {
            const y = r.year || getYear(r.date);
            const w = r.week || getWeekNumber(r.date).toString();
            const d = r.date;

            if(!pivot[y]) pivot[y] = { sums: sumObject(), weeks: {} };
            if(!pivot[y].weeks[w]) pivot[y].weeks[w] = { sums: sumObject(), dates: {} };
            if(!pivot[y].weeks[w].dates[d]) pivot[y].weeks[w].dates[d] = sumObject();

            addSums(pivot[y].sums, r);
            addSums(pivot[y].weeks[w].sums, r);
            addSums(pivot[y].weeks[w].dates[d], r);
            addSums(grandTotals, r);
        });

        let html = '';
        Object.keys(pivot).sort().forEach(year => {
            const yNodeId = `y-${year}`;
            if(expandedState[yNodeId] === undefined) expandedState[yNodeId] = true;
            html += renderRowHTML(year, pivot[year].sums, 'row-year', yNodeId, true);
            if(expandedState[yNodeId]) {
                Object.keys(pivot[year].weeks).sort((a,b)=>parseInt(a)-parseInt(b)).forEach(week => {
                    const wNodeId = `w-${year}-${week}`;
                    if(expandedState[wNodeId] === undefined) expandedState[wNodeId] = false;
                    html += renderRowHTML(`Week ${week}`, pivot[year].weeks[week].sums, 'row-week indent-1', wNodeId, true);
                    if(expandedState[wNodeId]) {
                        Object.keys(pivot[year].weeks[week].dates).sort().forEach(date => {
                            html += renderRowHTML(date, pivot[year].weeks[week].dates[date], 'row-date indent-2', null, true);
                        });
                    }
                });
            }
        });
        tbody.innerHTML = html;
        tfoot.innerHTML = renderRowHTML('Grand Total', grandTotals, 'grand-total', null, true);
    }

    function updateUI() { updateSlicerUI(); renderTracker(); renderDailyReport(); }

    // ===== EXPORT / IMPORT ALL DATA =========================================
    // Row-builders — one per table, reused by both the individual export
    // buttons and the combined "Export All" workbook so there's exactly one
    // place that defines each table's export columns.
    function buildEmployeesExportRows() {
        return employees.map(emp => {
            const d = getEmpDetail(emp.id);
            return {
                'ID': emp.id, 'First Name': emp.first_name, 'Last Name': emp.last_name, 'Person Type': emp.person_type,
                'Department': emp.department || '', 'Role Title': emp.role_title || '', 'Start Date': emp.start_date || '',
                'Status': emp.status, 'Pay Rate': emp.pay_rate || 0, 'Pay Type': getPayType(emp.id),
                'Phone': d.phone || '', 'Email': d.email || '', 'ID Type': d.id_type || 'SSN',
                'Driver License': d.driver_license || '', 'DL Expiration': d.dl_expiration || '',
                'Work Permit': d.work_permit || '', 'Work Permit Exp': d.work_permit_exp || '',
                'Medical Card': d.medical_card || 'No', 'Medical Card Exp': d.medical_card_exp || '', 'Notes': d.notes || ''
            };
        });
    }
    function buildClaimsExportRows() {
        return claims.map(c => ({
            'Claim ID': c.claim_id, 'Employee ID': c.employee_id, 'Claimant Account': c.claimant_account || '',
            'Company': c.company_name || '', 'Carrier Claim #': c.carrier_claim_number || '', 'Customer Claim #': c.customer_claim_number || '',
            'Damage Type': c.damage_type || '', 'Claim Amount': c.claim_amount, 'Weekly Deduction': c.weekly_deduction,
            'Start Date': c.start_date || '', 'End Date': c.end_date || '', 'Status': c.status,
            'Absorbed Amount': c.absorbed_amount || 0, 'Notes': c.notes || ''
        }));
    }
    function buildChargesExportRows() {
        return charges.map(ch => ({
            'Charge ID': ch.charge_id, 'Employee ID': ch.employee_id, 'Charge Type': ch.charge_type,
            'Amount': ch.amount, 'Weekly Deduction': ch.weekly_deduction, 'Start Date': ch.start_date || '',
            'End Date': ch.end_date || '', 'Status': ch.status, 'Notes': ch.notes || ''
        }));
    }
    function buildIncomeExportRows() {
        return additionalIncome.map(i => ({
            'Income ID': i.income_id, 'Employee ID': i.employee_id, 'Income Type': i.income_type,
            'Amount': i.amount, 'Weekly Amount': i.weekly_amount, 'Start Date': i.start_date || '',
            'End Date': i.end_date || '', 'Status': i.status, 'Notes': i.notes || ''
        }));
    }
    function buildVehiclesExportRows() {
        return vehicles.map(v => ({
            'Vehicle ID': v.id, 'Truck #': v.truck_number || '', 'Year': v.year || '', 'Make': v.make || '',
            'Model': v.model || '', 'Plate': v.plate || '', 'VIN': v.vin || '', 'Reg Expiry': v.reg_expiry || '',
            'Insurance Company': v.insurance_company || '', 'Insurance Policy': v.insurance_policy || '',
            'Insurance Expiry': v.insurance_expiry || '', 'Notes': v.notes || ''
        }));
    }
    function buildRoutesExportRows() { return routes.map(r => ({ ...r })); }
    async function buildDailyPayExportRows() {
        const { data, error } = await supabaseClient.rpc('get_daily_pay', { p_actor: currentUsername, p_company: currentCompany, p_year: null, p_week: null });
        if (error) { console.error('buildDailyPayExportRows:', error); return []; }
        return (data || []).map(r => ({ 'Employee ID': r.employee_id, 'Year': r.year, 'Week': r.week, 'Day Index': r.day_index, 'Amount': r.amount, 'Is Off': r.is_off ? 'Yes' : 'No' }));
    }
    async function buildProviderPayExportRows() {
        const { data, error } = await supabaseClient.rpc('get_provider_pay', { p_actor: currentUsername, p_company: currentCompany, p_year: null, p_week: null });
        if (error) { console.error('buildProviderPayExportRows:', error); return []; }
        return (data || []).map(r => ({ 'Employee ID': r.employee_id, 'Year': r.year, 'Week': r.week, 'Amount': r.amount, 'Notes': r.notes || '' }));
    }

    // sheets: [{ name, rows }] — every export, individual or combined, goes
    // through this so the format is always identical either way.
    // ===== SUMMARY REPORTS (Payroll/Claims/Charges/Income/Week in Deposit) =
    // Report-style output, not raw row dumps: a title, generated date, and
    // labeled stat lines grouped under section headings. Excel uses
    // aoa_to_sheet (array-of-arrays) rather than json_to_sheet specifically
    // so it reads like a report (title, sections) instead of a data table
    // with headers. PDF reuses the same #print-area + attemptPrint()
    // machinery every other print button already uses — proven, and
    // already handles the iOS-standalone limitation correctly.
    function reportToAOA(report) {
        const aoa = [[report.title], [report.subtitle || ''], [`Generated ${new Date().toLocaleString()}`], []];
        report.sections.forEach(sec => {
            aoa.push([sec.heading]);
            sec.rows.forEach(r => aoa.push(r));
            aoa.push([]);
        });
        return aoa;
    }
    function downloadReportExcel(report, filename) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(reportToAOA(report));
        ws['!cols'] = [{ wch: 34 }, { wch: 22 }];
        XLSX.utils.book_append_sheet(wb, ws, 'Summary');
        XLSX.writeFile(wb, filename);
    }
    function printReport(report) {
        const body = report.sections.map(sec => `
            <h2 style="margin-top:18px;">${escHtml(sec.heading)}</h2>
            <table><tbody>${sec.rows.map(r => `<tr><td>${escHtml(r[0])}</td><td>${escHtml(String(r[1]))}</td></tr>`).join('')}</tbody></table>`).join('');
        document.getElementById('print-area').innerHTML = `
            <h1>${escHtml(report.title)}</h1>
            <div class="print-meta">${escHtml(report.subtitle || '')} · Generated ${new Date().toLocaleString()}</div>
            ${body}`;
        attemptPrint();
    }

    function buildPayrollSummaryReport() {
        const calc = lastPayrollCalc || [];
        const totalGross = calc.reduce((a, c) => a + c.gross, 0);
        const totalDed = calc.reduce((a, c) => a + c.ded, 0);
        const totalNet = calc.reduce((a, c) => a + c.net, 0);
        const byType = {};
        calc.forEach(c => {
            const t = c.payType || 'Weekly';
            if (!byType[t]) byType[t] = { count: 0, net: 0 };
            byType[t].count++; byType[t].net += c.net;
        });
        return {
            title: 'Payroll Summary Report',
            subtitle: `Week of ${fmtWeekLabel(payrollSunday())} · ${currentCompany || 'All companies'}`,
            sections: [
                { heading: 'Overview', rows: [
                    ['People', calc.length],
                    ['Total Gross', formatMoney(totalGross)],
                    ['Total Deductions', formatMoney(totalDed)],
                    ['Total Net Pay', formatMoney(totalNet)]
                ]},
                { heading: 'By Pay Type', rows: Object.keys(byType).map(t => [t, `${byType[t].count} people · ${formatMoney(byType[t].net)} net`]) }
            ]
        };
    }

    function buildClaimsSummaryReport() {
        const totalAmount = claims.reduce((a, c) => a + (parseFloat(c.claim_amount) || 0), 0);
        const totalAbsorbed = claims.reduce((a, c) => a + (parseFloat(c.absorbed_amount) || 0), 0);
        const totalBalance = claims.reduce((a, c) => a + claimBalance(c), 0);
        const byStatus = {}, byType = {};
        claims.forEach(c => {
            byStatus[c.status] = (byStatus[c.status] || 0) + 1;
            const t = c.damage_type || 'Unspecified';
            if (!byType[t]) byType[t] = { count: 0, amount: 0 };
            byType[t].count++; byType[t].amount += parseFloat(c.claim_amount) || 0;
        });
        return {
            title: 'Claims Summary Report',
            subtitle: `${currentCompany || 'All companies'} · As of ${todayStr()}`,
            sections: [
                { heading: 'Overview', rows: [
                    ['Total Claims', claims.length],
                    ['Total Claimed', formatMoney(totalAmount)],
                    ['Total Absorbed', formatMoney(totalAbsorbed)],
                    ['Total Balance Remaining', formatMoney(totalBalance)]
                ]},
                { heading: 'By Status', rows: Object.keys(byStatus).map(s => [s, byStatus[s]]) },
                { heading: 'By Damage Type', rows: Object.keys(byType).map(t => [t, `${byType[t].count} claims · ${formatMoney(byType[t].amount)}`]) }
            ]
        };
    }

    function buildChargesSummaryReport() {
        const totalAmount = charges.reduce((a, c) => a + (parseFloat(c.amount) || 0), 0);
        const totalBalance = charges.reduce((a, c) => a + chargeBalance(c), 0);
        const byStatus = {}, byType = {};
        charges.forEach(c => {
            byStatus[c.status] = (byStatus[c.status] || 0) + 1;
            const t = c.charge_type || 'Unspecified';
            if (!byType[t]) byType[t] = { count: 0, amount: 0 };
            byType[t].count++; byType[t].amount += parseFloat(c.amount) || 0;
        });
        return {
            title: 'Charges Summary Report',
            subtitle: `${currentCompany || 'All companies'} · As of ${todayStr()}`,
            sections: [
                { heading: 'Overview', rows: [
                    ['Total Charges', charges.length],
                    ['Total Charged', formatMoney(totalAmount)],
                    ['Total Balance Remaining', formatMoney(totalBalance)]
                ]},
                { heading: 'By Status', rows: Object.keys(byStatus).map(s => [s, byStatus[s]]) },
                { heading: 'By Charge Type', rows: Object.keys(byType).map(t => [t, `${byType[t].count} charges · ${formatMoney(byType[t].amount)}`]) }
            ]
        };
    }

    function buildIncomeSummaryReport() {
        const totalAmount = additionalIncome.reduce((a, i) => a + (parseFloat(i.amount) || 0), 0);
        const totalRemaining = additionalIncome.reduce((a, i) => a + incomeRemaining(i), 0);
        const byStatus = {}, byType = {};
        additionalIncome.forEach(i => {
            byStatus[i.status] = (byStatus[i.status] || 0) + 1;
            const t = i.income_type || 'Unspecified';
            if (!byType[t]) byType[t] = { count: 0, amount: 0 };
            byType[t].count++; byType[t].amount += parseFloat(i.amount) || 0;
        });
        return {
            title: 'Additional Income Summary Report',
            subtitle: `${currentCompany || 'All companies'} · As of ${todayStr()}`,
            sections: [
                { heading: 'Overview', rows: [
                    ['Total Income Records', additionalIncome.length],
                    ['Total Income', formatMoney(totalAmount)],
                    ['Total Remaining To Pay', formatMoney(totalRemaining)]
                ]},
                { heading: 'By Status', rows: Object.keys(byStatus).map(s => [s, byStatus[s]]) },
                { heading: 'By Income Type', rows: Object.keys(byType).map(t => [t, `${byType[t].count} records · ${formatMoney(byType[t].amount)}`]) }
            ]
        };
    }

    function buildWeekDepositSummaryReport() {
        const deposits = charges.filter(c => c.charge_type === WEEK_DEPOSIT_TYPE);
        let totalGoal = 0, totalSaved = 0, totalRemaining = 0;
        const byStatus = {};
        deposits.forEach(c => {
            const goal = Math.max(0, parseFloat(c.amount) || 0);
            const remaining = chargeBalance(c);
            totalGoal += goal; totalRemaining += remaining;
            totalSaved += Math.max(0, +(goal - remaining).toFixed(2));
            byStatus[c.status] = (byStatus[c.status] || 0) + 1;
        });
        const avgPct = totalGoal > 0 ? Math.round((totalSaved / totalGoal) * 100) : 0;
        return {
            title: 'Week in Deposit Summary Report',
            subtitle: `${currentCompany || 'All companies'} · As of ${todayStr()}`,
            sections: [
                { heading: 'Overview', rows: [
                    ['Total Deposits', deposits.length],
                    ['Total Goal', formatMoney(totalGoal)],
                    ['Total Saved', formatMoney(totalSaved)],
                    ['Total Remaining', formatMoney(totalRemaining)],
                    ['Average % of Goal Reached', avgPct + '%']
                ]},
                { heading: 'By Status', rows: Object.keys(byStatus).map(s => [s, byStatus[s]]) }
            ]
        };
    }

    function downloadWorkbook(sheets, filename) {
        const wb = XLSX.utils.book_new();
        sheets.forEach(s => {
            const ws = XLSX.utils.json_to_sheet(s.rows.length ? s.rows : [{ 'No data': 'This section is empty' }]);
            XLSX.utils.book_append_sheet(wb, ws, s.name.substring(0, 31)); // Excel sheet-name length limit
        });
        XLSX.writeFile(wb, filename);
    }

    function exportClaimsExcel() { downloadWorkbook([{ name: 'Claims', rows: buildClaimsExportRows() }], 'claims_export.xlsx'); }
    function exportChargesExcel() { downloadWorkbook([{ name: 'Charges', rows: buildChargesExportRows() }], 'charges_export.xlsx'); }
    function exportIncomeExcel() { downloadWorkbook([{ name: 'Additional Income', rows: buildIncomeExportRows() }], 'income_export.xlsx'); }
    function exportVehiclesExcel() { downloadWorkbook([{ name: 'Vehicles', rows: buildVehiclesExportRows() }], 'vehicles_export.xlsx'); }
    async function exportDailyPayExcel() { downloadWorkbook([{ name: 'Daily Pay', rows: await buildDailyPayExportRows() }], 'daily_pay_export.xlsx'); }
    async function exportProviderPayExcel() { downloadWorkbook([{ name: 'Provider Pay', rows: await buildProviderPayExportRows() }], 'provider_pay_export.xlsx'); }

    async function exportAllData(evt) {
        const btn = evt && evt.target;
        if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
        try {
            const sheets = [
                { name: 'Employees', rows: buildEmployeesExportRows() },
                { name: 'Claims', rows: buildClaimsExportRows() },
                { name: 'Charges', rows: buildChargesExportRows() },
                { name: 'Additional Income', rows: buildIncomeExportRows() },
                { name: 'Vehicles', rows: buildVehiclesExportRows() },
                { name: 'Routes', rows: buildRoutesExportRows() },
                { name: 'Daily Pay', rows: await buildDailyPayExportRows() },
                { name: 'Provider Pay', rows: await buildProviderPayExportRows() }
            ];
            const scope = currentUserRole === 'SuperAdmin' && !currentCompany ? 'AllCompanies' : (currentCompany || 'Export');
            downloadWorkbook(sheets, `Full_Backup_${scope}_${todayStr()}.xlsx`);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '⬇️ Export All Data (single file)'; }
        }
    }

    function exportExcel() {
        if(!routes.length) return alert("No data to export!");
        const ws = XLSX.utils.json_to_sheet(routes);
        const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Tracker");
        XLSX.writeFile(wb, "Unified_Dashboard_Backup.xlsx");
    }

    renderVersionBadge();
    updateThemeButtons();
    applyTranslations();
    updateLanguageButtons();
    if (sessionStorage.getItem('logout_reason') === 'idle') {
        sessionStorage.removeItem('logout_reason');
        const notice = document.getElementById('login-timeout-notice');
        if (notice) notice.style.display = 'block';
    } else if (sessionStorage.getItem('logout_reason') === 'global') {
        sessionStorage.removeItem('logout_reason');
        const notice = document.getElementById('login-timeout-notice');
        if (notice) { notice.textContent = 'You were signed out by an administrator. Please sign in again.'; notice.style.display = 'block'; }
    }
    checkExistingSession();

    // ---- Service worker: app-shell caching, rewritten from scratch -------
    // Registers sw.js, which caches the app shell (this page, manifest,
    // icons) and serves network-first — see sw.js itself for the full
    // explanation. This has nothing to do with touch/scroll handling (a
    // service worker can't see touch events at all); that fix lives
    // entirely in this file, separately, above.
    //
    // Also handles auto-reload when a NEW service worker takes over (e.g.
    // after this app is updated and redeployed), so a tab that's been open
    // a while never keeps running against a stale cached shell. Guarded so
    // it only fires on a real update — not on the very first-ever install,
    // where the page also transitions from "no controller" to "controlled"
    // but there's nothing to actually refresh.
    if ('serviceWorker' in navigator) {
        let hadController = !!navigator.serviceWorker.controller;
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (!hadController) { hadController = true; return; } // first-ever install, not an update
            if (refreshing) return;
            refreshing = true;
            window.location.reload();
        });
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js').catch((err) => console.error('Service worker registration failed:', err));
        });
    }

    // ---- Install experience: PC, Android, iOS — each platform differs ----
    // Chrome/Edge (desktop and Android) fire a real 'beforeinstallprompt'
    // event this app can hook a button up to. iOS Safari has no such
    // event at all — Apple only allows installing via Share → "Add to
    // Home Screen", done manually by the person, so the best this can do
    // there is show clear instructions. Both are skipped entirely once
    // the app is already running installed (standalone), and either can
    // be dismissed, which is remembered so it doesn't nag every visit.
    (function setupInstallExperience() {
        function isStandalone() {
            return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
        }
        if (isStandalone()) return;
        if (localStorage.getItem('tracker_install_dismissed') === '1') return;

        let banner = null;
        function dismiss() {
            localStorage.setItem('tracker_install_dismissed', '1');
            if (banner) { banner.remove(); banner = null; }
        }
        function buildBanner(message, installLabel) {
            banner = document.createElement('div');
            banner.id = 'install-banner';
            banner.style.cssText = 'position:fixed; left:0; right:0; bottom:0; z-index:10000; background:var(--surface, #fff); color:var(--text, #111); border-top:1px solid var(--border, #ddd); box-shadow:0 -2px 10px rgba(0,0,0,0.12); padding:10px 14px; display:flex; align-items:center; gap:10px; font-size:13px; line-height:1.35;';
            const text = document.createElement('div');
            text.style.cssText = 'flex:1;';
            text.textContent = message;
            banner.appendChild(text);
            let installBtn = null;
            if (installLabel) {
                installBtn = document.createElement('button');
                installBtn.textContent = installLabel;
                installBtn.style.cssText = 'background:var(--primary, #0b6e64); color:#fff; border:none; padding:8px 14px; border-radius:6px; font-weight:700; cursor:pointer; white-space:nowrap;';
                banner.appendChild(installBtn);
            }
            const closeBtn = document.createElement('button');
            closeBtn.textContent = '✕';
            closeBtn.setAttribute('aria-label', 'Dismiss');
            closeBtn.style.cssText = 'background:none; border:none; font-size:16px; color:var(--text-muted, #666); cursor:pointer; padding:4px 8px;';
            closeBtn.onclick = dismiss;
            banner.appendChild(closeBtn);
            document.body.appendChild(banner);
            return installBtn;
        }

        const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
        if (isIOS) {
            // No install event exists on iOS — this is the only path available.
            buildBanner('Install this app: tap Share, then "Add to Home Screen".', null);
            return;
        }

        // Android Chrome, desktop Chrome/Edge, and any other browser that
        // supports the real install prompt. Browsers without support for
        // this (e.g. Firefox) simply never fire the event, so nothing
        // shows there — nothing broken, just no install path available
        // from inside the app on that browser.
        let deferredPrompt = null;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            const installBtn = buildBanner('Install this app for quicker access.', 'Install');
            installBtn.addEventListener('click', () => {
                installBtn.disabled = true;
                deferredPrompt.prompt();
                deferredPrompt.userChoice.finally(() => {
                    deferredPrompt = null;
                    if (banner) { banner.remove(); banner = null; }
                });
            });
        });

        window.addEventListener('appinstalled', () => {
            localStorage.setItem('tracker_install_dismissed', '1');
            if (banner) { banner.remove(); banner = null; }
        });
    })();

    // ---- Pull-to-refresh: standalone/installed mode ONLY -----------------
    // A normal browser tab (Chrome, Safari, Edge — desktop or mobile)
    // already has its own native swipe-down-to-refresh built into the
    // browser chrome itself when the page is scrolled to the top. No code
    // is needed for that case, and this deliberately does NOT attach
    // anything there — that's exactly the situation the earlier custom
    // pull-to-refresh broke scrolling in.
    //
    // Once installed (Add to Home Screen / desktop install), the app runs
    // standalone with no browser chrome at all — there's no native
    // gesture available there, which is the ONLY situation this code now
    // runs in. isStandalone() below gates the entire thing; in a regular
    // browser tab this whole block is a no-op and nothing here ever
    // executes.
    (function setupPullToRefresh() {
        function isStandalone() {
            return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
        }
        if (!isStandalone()) return; // regular browser tab — its own native gesture already handles this

        const indicator = document.createElement('div');
        indicator.id = 'ptr-indicator';
        // pointer-events:none — this is purely a visual cue and must never
        // be able to intercept a tap on whatever's underneath it.
        indicator.style.cssText = 'position:fixed; top:0; left:0; right:0; display:flex; align-items:center; justify-content:center; height:0; overflow:hidden; background:var(--surface); color:var(--primary); font-size:13px; font-weight:700; z-index:9999; transition:height 0.15s ease; box-shadow:0 2px 6px rgba(0,0,0,0.08); pointer-events:none;';
        indicator.textContent = '↓ Pull to refresh';
        document.body.prepend(indicator);

        let startY = null, pulling = false, refreshing = false;
        const THRESHOLD = 70;

        // Nested scroll areas (the sidebar drawer, message threads, etc.)
        // scroll independently of the page — window.scrollY stays 0 while
        // someone scrolls inside one of those, which would otherwise look
        // identical to "at the top of the page, pulling down to refresh."
        // Walking up from the actual touch target avoids fighting with any
        // such area, current or future.
        function isInsideOwnScrollArea(el) {
            while (el && el !== document.body && el !== document.documentElement) {
                const style = window.getComputedStyle(el);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return true;
                el = el.parentElement;
            }
            return false;
        }

        document.addEventListener('touchstart', (e) => {
            if (refreshing) return;
            if (window.scrollY > 0) { startY = null; return; }
            const authVisible = document.getElementById('auth-container') && document.getElementById('auth-container').style.display !== 'none';
            if (authVisible) { startY = null; return; } // don't fight the login screen
            if (isInsideOwnScrollArea(e.target)) { startY = null; return; }
            startY = e.touches[0].clientY;
            pulling = true;
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!pulling || startY === null || refreshing) return;
            const delta = e.touches[0].clientY - startY;
            if (delta <= 0) { indicator.style.height = '0'; return; }
            const capped = Math.min(delta * 0.5, 90); // resistance, so it doesn't feel like it's flying open
            indicator.style.height = capped + 'px';
            indicator.textContent = capped >= THRESHOLD ? '↑ Release to refresh' : '↓ Pull to refresh';
        }, { passive: true });

        document.addEventListener('touchend', () => {
            if (!pulling) return;
            pulling = false;
            const height = parseInt(indicator.style.height, 10) || 0;
            if (height >= THRESHOLD && !refreshing) {
                refreshing = true;
                indicator.textContent = '⟳ Refreshing…';
                indicator.style.height = '50px';
                fetchAllDataFromCloud()
                    .catch((err) => console.error('Pull-to-refresh failed:', err))
                    .finally(() => {
                        refreshing = false;
                        indicator.style.height = '0';
                    });
            } else {
                indicator.style.height = '0';
            }
            startY = null;
        });
    })();
