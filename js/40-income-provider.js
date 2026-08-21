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
