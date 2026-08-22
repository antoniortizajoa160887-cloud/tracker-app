/* Tracker app — part 2/8: 10-auth.js
   Auth & session security — two-level tab navigation config, TOTP two-factor auth, the unusual-activity heads-up, Sign Out All Users (grace period + countdown), and account-menu 2FA management.
   Split out of the original single-file index.html for maintainability; classic
   script, loaded in order with its siblings and sharing one global scope. */
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
        if (!confirm(t('c_cancel_signout'))) return;
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
            alert(t('a_2fa_off'));
            closeTwofaManage();
        } catch (err) {
            errEl.textContent = 'Could not reach the server: ' + (err && err.message ? err.message : err);
        }
    }

    // Admin reset: turn off another user's 2FA (device-lost recovery). Server
    // restricts this to Administrator/SuperAdmin.
    async function resetUser2FA(usernameToReset) {
        if (!confirm(t('c_reset_2fa').replace('{user}', usernameToReset))) return;
        try {
            const { error } = await supabaseClient.rpc('disable_2fa', { p_actor: currentUsername, p_target: usernameToReset });
            if (error) { alert(error.message); return; }
            alert(t('a_2fa_reset_for').replace('{user}', usernameToReset));
            fetchUsersList();
        } catch (err) {
            alert(t('err_could_not_reach') + (err && err.message ? err.message : err));
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
        if (typeof updateMyAvatar === 'function') updateMyAvatar();  // header avatar + account-menu photo actions

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
