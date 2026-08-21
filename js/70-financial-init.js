/* Tracker app — part 8/8: 70-financial-init.js
   Financial (Invoices, Bills), Fleet rendering, Export/Import all data, summary reports, and the app init/bootstrap block (runs last).
   Split out of the original single-file index.html for maintainability; classic
   script, loaded in order with its siblings and sharing one global scope. */
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
