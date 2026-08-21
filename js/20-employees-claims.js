/* Tracker app — part 3/8: 20-employees-claims.js
   Employees & Claims/Charges — idle-timeout + global listeners, cloud fetchers, the employee directory, the claims and charges forms, and the combined Claims & Charges list.
   Split out of the original single-file index.html for maintainability; classic
   script, loaded in order with its siblings and sharing one global scope. */
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
                alert(t('a_pw_updated'));
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
        if (!c) { alert(t('a_select_company_first')); return null; }
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
        if (code.length < 3 || code.length > 4) { alert(t('a_company_code_len')); return; }
        if (!name) { alert(t('a_enter_company_name')); return; }

        if (editingCompanyCode) {
            const { error } = await supabaseClient.rpc('edit_company', {
                p_actor: currentUsername, p_code: editingCompanyCode, p_name: name,
                p_owner: owner || null, p_phone: phone || null, p_email: email || null,
                p_manager: manager || null, p_manager_phone: managerPhone || null
            });
            if (error) { alert(t('err_prefix') + error.message); return; }
            cancelCompanyEdit();
            loadCompanies();
            return;
        }

        const { data, error } = await supabaseClient.rpc('create_company', {
            p_actor: currentUsername, p_code: code, p_name: name,
            p_owner: owner || null, p_phone: phone || null, p_email: email || null,
            p_manager: manager || null, p_manager_phone: managerPhone || null
        });
        if (error) { alert(t('err_prefix') + error.message); return; }
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
            alert(t('a_copied'));
        } catch (e) {
            alert(text); // clipboard unavailable — show it plainly so it can be copied by hand
        }
    }

    async function deleteCompany(code) {
        if (!confirm(t('c_del_company').replace('{code}', code))) return;
        const { error } = await supabaseClient.rpc('delete_company', { p_actor: currentUsername, p_code: code });
        if (error) alert(t('err_prefix') + error.message);
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
            alert(t('a_print_ios'));
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
                alert(t('a_emp_details_missing'));
            } else if (error) { console.error('saveEmployeeDetails:', error); alert(t('err_could_not_save') + error.message); }
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
            if (error) { alert(t('err_prefix') + error.message); return; }
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
            if (error) { alert(t('err_prefix') + error.message); return; }
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
                    : `<span class="status-badge ${emp.status === 'Active' ? 'status-active' : 'status-quit'}">${enumLabel(emp.status)}</span>`;
                const open = recExpanded.employees.has(emp.id);
                rows += `<tr style="cursor:pointer;" onclick="toggleRecCard('employees','${emp.id}')">
                    <td class="id-cell"><span class="rec-caret" data-caret="employees-${emp.id}">${open ? '▾' : '▸'}</span> ${emp.id} ${attachInd('employee', emp.id)}</td>
                    <td>${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</td>
                    <td>${enumLabel(emp.person_type)}</td>
                    <td>${escHtml(emp.department) || '-'}</td>
                    <td>${emp.start_date || '-'}</td>
                    <td>${enumLabel(pt)}${payToggle}</td>
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
                : `<span class="status-badge ${emp.status === 'Active' ? 'status-active' : 'status-quit'}">${enumLabel(emp.status)}</span>`;
            const open = recExpanded.employees.has(emp.id);
            container.insertAdjacentHTML('beforeend', `
                <div class="rec-card${open ? ' open' : ''}" id="rec-employees-${emp.id}">
                    <div class="rec-card-head" onclick="toggleRecCard('employees','${emp.id}')">
                        <span class="rec-caret" data-caret="employees-${emp.id}">${open ? '▾' : '▸'}</span>
                        <span class="rec-title">${escHtml(emp.first_name)} ${escHtml(emp.last_name)}</span>
                        <span class="rec-sub">${emp.id}</span>
                        ${attachInd('employee', emp.id)}
                        <span class="rec-right"><span class="pay-pill ${pt === 'Daily' ? 'pay-daily' : pt === 'Provider' ? 'pay-provider' : 'pay-weekly'}">${enumLabel(pt)}</span> <span class="status-badge ${emp.status === 'Active' ? 'status-active' : 'status-quit'}">${enumLabel(emp.status)}</span></span>
                    </div>
                    <div class="rec-card-body">
                        <div class="rec-detail-grid">
                            <div><div class="k" data-i18n="d_type">Type</div><div class="v">${enumLabel(emp.person_type)}</div></div>
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
                            <span class="rec-qs-item"><span class="rec-qs-label" data-i18n="d_pay">Pay</span> ${enumLabel(pt)}${payToggle}</span>
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
        if (error) { alert(t('err_prefix') + error.message); fetchEmployeesFromCloud(); return; }
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
        if (!canEdit()) { alert(t('a_no_import_perm')); return; }
        const co = requireWriteCompany();
        if (!co) return;

        const text = await file.text();
        const rows = parseCsvText(text);
        if (rows.length < 2) { alert(t('a_csv_empty')); return; }

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
        if (idx.first < 0 || idx.last < 0) { alert(t('a_csv_cols')); return; }

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
        alert(t('a_import_done').replace('{ok}', ok).replace('{fail}', fail ? t('a_import_fail_suffix').replace('{n}', fail) : ''));
        fetchEmployeesFromCloud();
    }

    async function deleteEmployee(id) {
        if(confirm(t('c_del_employee').replace('{id}', id))) {
            const { error } = await supabaseClient.rpc('delete_employee', { p_actor: currentUsername, p_id: id });
            if (error) alert(t('err_prefix') + error.message);
            else fetchEmployeesFromCloud();
        }
    }

    async function generateEmployeeUser(empId) {
        if (!canEdit()) return;
        const emp = employees.find(e => e.id === empId);
        if (!emp) return;
        const name = `${emp.first_name} ${emp.last_name || ''}`.trim();
        if (!confirm(t('c_gen_login').replace('{name}', name))) return;
        const { data, error } = await supabaseClient.rpc('provision_employee_account', { p_actor: currentUsername, p_employee_id: empId });
        if (error) { alert(t('err_prefix') + error.message); return; }
        const row = Array.isArray(data) ? data[0] : data;
        if (!row || !row.new_username) { alert(t('a_no_account')); return; }
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
        if (!claimEmpId) { alert(t('a_select_valid_emp')); return; }

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
            if (error) { alert(t('err_prefix') + error.message); return; }
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
            if (error) { alert(t('err_saving_claim') + error.message); return; }
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
                rows += `<tr class="rec-group-row" style="cursor:pointer;" onclick="toggleStatusGroup('cc','${status}')"><td colspan="13"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> ${statusBadge(status)} <span style="color:var(--text-muted); font-weight:400;">(${items.length})</span></td></tr>`;
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
                        <td>${statusBadge(r.status)}</td>
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
            container.insertAdjacentHTML('beforeend', `<div class="rec-group-header" style="grid-column:1/-1; cursor:pointer;" onclick="toggleStatusGroup('cc','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> ${statusBadge(status)} <span style="color:var(--text-muted); font-weight:400; font-size:0.75rem;">(${items.length})</span></div>`);
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
                            <span class="rec-right"${balColor}>${formatMoney(bal)} ${statusBadge(r.status)}</span>
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
                <tr><td>Status</td><td>${enumLabel(c.status)}</td></tr>
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
                <tr><td>Status</td><td>${enumLabel(ch.status)}</td></tr>
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
        if (!empId) { alert(t('a_select_emp_first')); return; }
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
