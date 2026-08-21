/* Tracker app — part 4/8: 30-attach-import-deposit.js
   Attachments, Excel/CSV import (individual + combined), Week in Deposit ("semana de fondo"), and the 90/30-day release-eligibility logic.
   Split out of the original single-file index.html for maintainability; classic
   script, loaded in order with its siblings and sharing one global scope. */
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
        listEl.innerHTML = rows.map((a, i) => `
            <div style="display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--border); font-size:12.5px;">
                <span style="font-size:16px;">${icon[a.kind] || '📄'}</span>
                <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escHtml(a.file_name)}">${escHtml(a.file_name)}${(!attachCtx.docLabel && a.doc_label) ? ` <span class="type-pill" style="font-size:9px; padding:1px 6px;">${escHtml(DOC_LABELS[a.doc_label] || a.doc_label)}</span>` : ''}</span>
                <span style="color:var(--text-muted); white-space:nowrap;">${formatBytes(a.size_bytes)}</span>
                <button type="button" class="btn-small" style="margin:0; padding:3px 9px;" onclick="openFileFromList(${i})">View</button>
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
                alert(t('err_could_not_upload') + (e && e.message ? e.message : e));
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
        const next = prompt(t('p_rename_file'), base);
        if (next === null) return;
        const finalName = sanitizeAttachName(next) + (ext ? '.' + ext : '');
        if (finalName === current) return;
        const { error } = await supabaseClient.rpc('rename_attachment', {
            p_actor: currentUsername, p_id: id, p_file_name: finalName
        });
        if (error) { alert(t('err_prefix') + error.message); return; }
        loadAttachmentsList();
    }

    // ---- In-app file viewer ----------------------------------------------
    // Opening a file never leaves the app and never opens a new browser tab.
    // We fetch the signed URL as an in-memory blob (connect-src already allows
    // the Supabase host) and render it from a blob: URL inside the
    // #file-viewer-overlay modal. currentViewer holds the live blob URL so the
    // Download button can reuse it and closeFileViewer can revoke it (no leaks).
    let currentViewer = null;   // { url, blob, name }
    let fvZoom = 1;             // image zoom scale (1 = fit)
    let fvRot = 0;             // image rotation in degrees (0/90/180/270)
    let fvFlipX = 1, fvFlipY = 1;   // image flip (±1 on each axis)
    // Prev/Next gallery: the viewer holds a small playlist so you can page
    // through a set of files (a record's Files, or a chat's attachments)
    // without closing and reopening. Each item: { path, name, mime, by, at }.
    let fvItems = [];
    let fvIndex = 0;
    let fvReq = 0;             // race guard — newest fvShow wins on fast paging

    // Best-effort MIME so we can pick a render mode even for old rows that were
    // stored without one — fall back to the file-name extension.
    function fvGuessMime(name, mime) {
        if (mime) return mime;
        const ext = (splitExt(name).ext || '').toLowerCase();
        const map = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
            mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', m4v: 'video/x-m4v',
            mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', oga: 'audio/ogg',
            pdf: 'application/pdf'
        };
        return map[ext] || '';
    }

    // Read a Blob into a data: URL. Used so images render from data: (allowed by
    // img-src in every CSP version, and invisible to the service worker) rather
    // than a blob:/cross-origin URL that a stale cache or worker can break.
    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(fr.error || new Error('read failed'));
            fr.readAsDataURL(blob);
        });
    }

    // Open a set of files with prev/next, starting at `index`. Both call sites
    // (a record's Files list, a chat thread) build the item list and hand it
    // here; a single-item list simply hides the nav.
    function openFileGallery(items, index) {
        const overlay = document.getElementById('file-viewer-overlay');
        if (!overlay) return;
        fvItems = Array.isArray(items) ? items : [];
        if (!fvItems.length) return;
        overlay.style.display = 'flex';
        fvShow(Math.max(0, Math.min(index || 0, fvItems.length - 1)));
    }

    // Backward-compatible single-file entry (kept for any caller that opens one
    // file by its fields). Wraps it as a one-item gallery — nav auto-hides.
    function viewAttachment(path, fileName, mime, uploadedBy, uploadedAt) {
        openFileGallery([{ path: path, name: fileName, mime: mime, by: uploadedBy, at: uploadedAt }], 0);
    }

    async function fvShow(index) {
        const overlay = document.getElementById('file-viewer-overlay');
        const body = document.getElementById('file-viewer-body');
        const titleEl = document.getElementById('file-viewer-title');
        const metaEl = document.getElementById('file-viewer-meta');
        const zoomBar = document.getElementById('file-viewer-zoom');
        if (!overlay || !body) return;
        if (index < 0 || index >= fvItems.length) return;
        fvIndex = index;
        const it = fvItems[index] || {};
        const path = it.path;
        fvReset();          // revoke any previous blob, clear old media
        fvZoom = 1; fvRot = 0; fvFlipX = 1; fvFlipY = 1;
        const name = it.name || (path ? String(path).split('/').pop() : 'file');
        titleEl.textContent = name;
        // Attribution — who uploaded + the exact date/time (both guarded).
        let when = '';
        if (it.at) { const d = new Date(it.at); if (!isNaN(d.getTime())) when = d.toLocaleString(); }
        const who = (it.by && String(it.by).trim()) ? String(it.by) : '—';
        metaEl.innerHTML = `${escHtml(t('fv_uploaded_by'))} <strong>${escHtml(who)}</strong>${when ? ' · ' + escHtml(when) : ''}`;
        zoomBar.style.display = 'none';
        body.innerHTML = `<div style="margin:auto; color:#cbd5e1; font-size:13px; padding:24px;">${escHtml(t('fv_loading'))}</div>`;
        fvUpdateNav();
        const myReq = ++fvReq;   // paging fast? only the newest request may render
        try {
            const r = await efAttach({ action: 'sign-download', path });
            if (myReq !== fvReq) return;              // superseded before the URL came back
            const src = r.signedUrl;
            currentViewer = { signedUrl: src, name: name };
            const kind = fvGuessMime(name, it.mime);
            if (kind.indexOf('image/') === 0) {
                // Inline the image as a data: URL. We fetch the bytes (cross-origin
                // to Supabase — always allowed by connect-src) and hand them to the
                // <img> as data:. This renders under EVERY version of the CSP
                // (img-src has always allowed data:) and is never seen by the
                // service worker — so photos show even on a device carrying a stale
                // cached HTML/CSP or an old service worker. (A same-origin blob:
                // URL got intercepted by the worker on iPhone; a direct
                // cross-origin <img src> was blocked by a stale CSP on desktop.)
                // margin:auto centres it and lets it scroll (not clip) when taller
                // than the box — e.g. a portrait phone photo on a small screen.
                const resp = await fetch(src);
                if (myReq !== fvReq) return;
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const blob = await resp.blob();
                if (myReq !== fvReq) return;
                const dataUrl = await blobToDataURL(blob);
                if (myReq !== fvReq) return;
                currentViewer.blob = blob;            // reuse for Download, no re-fetch
                body.innerHTML = `<img id="file-viewer-img" src="${dataUrl}" alt="${escHtml(name)}" style="margin:auto; max-width:100%; max-height:82vh; display:block; transform-origin:center center; transition:transform 0.08s linear;">`;
                zoomBar.style.display = 'inline-flex';
                fvLabelImgTools();
                fvApplyZoom();
            } else if (kind.indexOf('video/') === 0) {
                body.innerHTML = `<video src="${escHtml(src)}" controls playsinline style="margin:auto; max-width:100%; max-height:82vh; outline:none;"></video>`;
            } else if (kind.indexOf('audio/') === 0) {
                body.innerHTML = `<div style="margin:auto; padding:28px; width:100%; box-sizing:border-box;"><audio src="${escHtml(src)}" controls style="width:100%;"></audio></div>`;
            } else if (kind === 'application/pdf') {
                body.innerHTML = `<iframe src="${escHtml(src)}" title="${escHtml(name)}" style="width:100%; height:82vh; border:0; background:#fff;"></iframe>`;
            } else {
                // Info + Download for types the browser can't render inline.
                const sz = it.size ? formatBytes(it.size) : '';
                const typeLabel = kind || (splitExt(name).ext ? splitExt(name).ext.toUpperCase() : '');
                body.innerHTML = `<div style="margin:auto; text-align:center; color:#e2e8f0; padding:40px 22px;">
                    <div style="font-size:54px; line-height:1;">📄</div>
                    <div style="margin-top:12px; font-weight:600; word-break:break-word;">${escHtml(name)}</div>
                    <div style="margin-top:4px; font-size:12px; color:#94a3b8;">${escHtml(typeLabel)}${sz ? ' · ' + escHtml(sz) : ''}</div>
                    <div style="margin-top:14px; font-size:12.5px; color:#cbd5e1; max-width:340px; margin-left:auto; margin-right:auto;">${escHtml(t('fv_no_preview'))}</div>
                </div>`;
            }
        } catch (e) {
            console.error('file viewer:', e);
            body.innerHTML = `<div style="margin:auto; color:#fca5a5; font-size:13px; padding:28px; text-align:center;">${escHtml(t('fv_error'))}<br><span style="color:#94a3b8; font-size:11px;">${escHtml(e && e.message ? e.message : String(e))}</span></div>`;
        }
    }

    // Localize the image-tool button tooltips (applyTranslations only covers
    // text + placeholders, not title/aria-label, so set them here at open time).
    function fvLabelImgTools() {
        const set = (id, key) => { const b = document.getElementById(id); if (b) { b.title = t(key); b.setAttribute('aria-label', t(key)); } };
        set('fv-btn-zoomout', 'fv_zoom_out'); set('fv-btn-zoomreset', 'fv_zoom_reset'); set('fv-btn-zoomin', 'fv_zoom_in');
        set('fv-btn-rotl', 'fv_rotate_left'); set('fv-btn-rotr', 'fv_rotate_right');
        set('fv-btn-fliph', 'fv_flip_h'); set('fv-btn-flipv', 'fv_flip_v');
    }

    // Apply the combined image transform: rotation + flip + zoom, about the
    // centre. margin:auto (set in the markup) keeps it centred and, because the
    // body is overflow:auto, still scrollable to every edge when it overflows.
    function fvApplyZoom() {
        const img = document.getElementById('file-viewer-img');
        if (!img) return;
        img.style.transform = 'rotate(' + fvRot + 'deg) scaleX(' + (fvZoom * fvFlipX) + ') scaleY(' + (fvZoom * fvFlipY) + ')';
    }

    // dir: +1 zoom in, -1 zoom out, 0 reset to fit. Clamped 0.25×–5×.
    function fileViewerZoom(dir) {
        if (dir === 0) fvZoom = 1;
        else fvZoom = Math.min(5, Math.max(0.25, +(fvZoom + dir * 0.25).toFixed(2)));
        fvApplyZoom();
    }

    // Rotate the image 90° left (-1) or right (+1), kept in 0–359.
    function fvRotate(dir) {
        fvRot = ((fvRot + dir * 90) % 360 + 360) % 360;
        fvApplyZoom();
    }

    // Flip (mirror) the image horizontally ('h') or vertically ('v').
    function fvFlip(axis) {
        if (axis === 'v') fvFlipY = -fvFlipY; else fvFlipX = -fvFlipX;
        fvApplyZoom();
    }

    // Open a record's Files list as a gallery, starting at the clicked row.
    // attachListCache already holds the rendered rows, in order.
    function openFileFromList(i) {
        const items = (attachListCache || []).map(a => ({
            path: a.storage_path, name: a.file_name, mime: a.mime_type, by: a.uploaded_by, at: a.uploaded_at, size: a.size_bytes
        }));
        openFileGallery(items, i);
    }

    function fvPrev() { if (fvIndex > 0) fvShow(fvIndex - 1); }
    function fvNext() { if (fvIndex < fvItems.length - 1) fvShow(fvIndex + 1); }

    // Show/hide the ‹ pos › nav and reflect position + end-of-list disabling.
    function fvUpdateNav() {
        const nav = document.getElementById('file-viewer-nav');
        const pos = document.getElementById('file-viewer-pos');
        const prev = document.getElementById('file-viewer-prev');
        const next = document.getElementById('file-viewer-next');
        if (!nav) return;
        if (fvItems.length <= 1) { nav.style.display = 'none'; return; }
        nav.style.display = 'inline-flex';
        if (pos) pos.textContent = (fvIndex + 1) + ' / ' + fvItems.length;
        if (prev) { const d = fvIndex <= 0; prev.disabled = d; prev.style.opacity = d ? '0.4' : ''; prev.title = t('fv_prev'); prev.setAttribute('aria-label', t('fv_prev')); }
        if (next) { const d = fvIndex >= fvItems.length - 1; next.disabled = d; next.style.opacity = d ? '0.4' : ''; next.title = t('fv_next'); next.setAttribute('aria-label', t('fv_next')); }
    }

    // Ctrl/⌘ + wheel zooms the image, matching the buttons.
    function fvWheelZoom(e) {
        const ov = document.getElementById('file-viewer-overlay');
        if (!ov || ov.style.display === 'none') return;
        if (!document.getElementById('file-viewer-img')) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        fileViewerZoom(e.deltaY < 0 ? 1 : -1);
    }

    // Save the currently-open file. A cross-origin <a download> is ignored by
    // browsers, so fetch the signed URL to a blob first, then download that —
    // stays entirely in-app, no navigation. The fetch is cross-origin, so the
    // service worker never touches it.
    async function downloadCurrentFile() {
        if (!currentViewer || (!currentViewer.signedUrl && !currentViewer.blob)) return;
        const btn = document.getElementById('file-viewer-download');
        try {
            if (btn) btn.disabled = true;
            // Images already hold their bytes (fetched for display) — reuse them.
            let blob = currentViewer.blob;
            if (!blob) {
                const resp = await fetch(currentViewer.signedUrl);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                blob = await resp.blob();
            }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = currentViewer.name || 'file';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 10000);
        } catch (e) {
            console.error('download:', e);
            alert(t('fv_error'));
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    function fvReset() {
        const body = document.getElementById('file-viewer-body');
        if (body) {
            const v = body.querySelector('video, audio');
            if (v) { try { v.pause(); } catch (e) {} }
            body.innerHTML = '';
        }
        currentViewer = null;
    }

    function closeFileViewer() {
        const ov = document.getElementById('file-viewer-overlay');
        if (ov) ov.style.display = 'none';
        fvReset();
        fvItems = []; fvIndex = 0;
    }

    // Esc closes the viewer; ←/→ page prev/next (unless a media/input control has
    // focus, so video scrubbing and typing keep the arrows); Ctrl/⌘+wheel zooms.
    // Attached once at load.
    document.addEventListener('keydown', (e) => {
        const ov = document.getElementById('file-viewer-overlay');
        if (!ov || ov.style.display === 'none') return;
        if (e.key === 'Escape') { closeFileViewer(); return; }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && fvItems.length > 1) {
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (/^(VIDEO|AUDIO|IFRAME|INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
            e.preventDefault();
            if (e.key === 'ArrowLeft') fvPrev(); else fvNext();
        }
    });
    document.addEventListener('wheel', fvWheelZoom, { passive: false });

    async function deleteAttachmentUi(id, path) {
        if (!canEdit()) return;
        if (!confirm(t('c_del_file'))) return;
        const { data, error } = await supabaseClient.rpc('delete_attachment', { p_actor: currentUsername, p_id: id });
        if (error) { alert(t('err_prefix') + error.message); return; }
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
        if(confirm(t('c_del_claim').replace('{id}', id))) {
            const { error } = await supabaseClient.rpc('delete_claim', { p_actor: currentUsername, p_id: id });
            if (error) alert(t('err_prefix') + error.message);
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
        if (!canEdit()) { alert(t('a_no_import_perm')); event.target.value = ''; return; }
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
        if (!canEdit()) { alert(t('a_no_import_perm')); event.target.value = ''; return; }
        const co = requireWriteCompany();
        if (!co) { event.target.value = ''; return; }
        const reader = new FileReader();
        reader.onload = async function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                const sheetName = workbook.SheetNames[0];
                const ws = workbook.Sheets[sheetName];
                if (!ws['!ref']) { alert(t('a_file_empty')); return; }
                const range = XLSX.utils.decode_range(ws['!ref']);

                // Date columns: column B (index 1) onward, for as long as the
                // header row holds a real Excel date (numeric cell type).
                let dateColCount = 0;
                while (true) {
                    const cell = ws[XLSX.utils.encode_cell({ r: 0, c: 1 + dateColCount })];
                    if (!cell || cell.t !== 'n') break;
                    dateColCount++;
                }
                if (dateColCount < 1) { alert(t('a_no_date_cols')); return; }

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
                if (goalCol < 0) { alert(t('a_no_goal_col')); return; }

                // Rebuild the week dates from column B's date, stepping +7
                // days per column, rather than trusting every stored date —
                // this file's later columns can roll into the next year but
                // keep the same year number as the first pass through the
                // calendar, which would otherwise place those weeks before
                // the ones they actually follow.
                const baseCell = ws[XLSX.utils.encode_cell({ r: 0, c: 1 })];
                const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                const baseDate = new Date(excelEpoch.getTime() + baseCell.v * 86400000);
                if (isNaN(baseDate)) { alert(t('a_no_first_week')); return; }
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
                alert(t('err_importing_file') + err.message);
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
        if (!canEdit()) { alert(t('a_no_import_perm')); event.target.value = ''; return; }
        const wb = await readWorkbookFromEvent(event); if (!wb) return;
        const rows = sheetRows(wb, wb.SheetNames.find(n => n.toLowerCase().includes('income')) || wb.SheetNames[0]) || [];
        const res = await processIncomeRows(rows);
        alert(`Imported ${res.imported} income record(s).${res.skipped ? ` ${res.skipped} skipped:\n` + res.errors.slice(0, 10).join('\n') : ''}`);
        event.target.value = '';
        fetchIncomeFromCloud();
    }
    async function importVehiclesExcel(event) {
        if (!canEdit()) { alert(t('a_no_import_perm')); event.target.value = ''; return; }
        const wb = await readWorkbookFromEvent(event); if (!wb) return;
        const rows = sheetRows(wb, wb.SheetNames.find(n => n.toLowerCase().includes('vehicle')) || wb.SheetNames[0]) || [];
        const res = await processVehicleRows(rows);
        alert(`Imported ${res.imported} vehicle(s).${res.skipped ? ` ${res.skipped} skipped:\n` + res.errors.slice(0, 10).join('\n') : ''}`);
        event.target.value = '';
        fetchVehiclesFromCloud();
    }
    async function importProviderPayExcel(event) {
        if (!canEdit()) { alert(t('a_no_import_perm')); event.target.value = ''; return; }
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
        if (!canEdit()) { alert(t('a_no_import_perm')); event.target.value = ''; return; }
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
        if (!canEdit()) { alert(t('a_no_import_perm')); event.target.value = ''; return; }
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
                alert(t('err_parsing_file') + err.message);
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
            if (!ws['!ref']) { alert(t('a_sheet_empty')); return; }

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
                alert(t('a_no_7days').replace('{sheet}', sheetName));
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

            if (!entries.length && !unmatched.length) { alert(t('a_no_dailypay_rows')); return; }

            let msg = '';
            if (entries.length) {
                const { data: result, error } = await supabaseClient.rpc('import_daily_pay_batch', { p_actor: currentUsername, p_entries: entries });
                if (error) { alert(t('err_importing') + error.message); return; }
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
            alert(t('err_parsing_sheet') + err.message);
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
        if (!canEdit()) { alert(t('a_no_import_perm')); return; }
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
            if (!rows.length) { alert(t('a_no_data_rows').replace('{sheet}', sheetName)); return; }

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

            if (!newClaims.length) { alert(t('a_no_matching_cols').replace('{n}', rows.length).replace('{sheet}', sheetName)); return; }

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
            alert(t('err_importing_file') + err.message);
        }
    }

    // --- CHARGES ---
    document.getElementById('charge-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        if (!canEdit()) return;
        const chargeEmpId = document.getElementById('ci-employee').value;
        if (!chargeEmpId) { alert(t('a_select_emp_top')); return; }
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
            if (error) { alert(t('err_prefix') + error.message); return; }
            if (data) alert(data);
            cancelChargeEdit();
            fetchChargesFromCloud();
        } else {
            const chargeCo = requireWriteCompany();
            if (!chargeCo) return;
            const chargeId = `${idPrefix()}${String(charges.length + 1).padStart(settings.chargeDigits, '0')}${settings.chargeSuffix}`;
            const payload = Object.assign({ charge_id: chargeId, company_code: chargeCo }, fields);
            const { error } = await supabaseClient.rpc('create_charge', { p_actor: currentUsername, p_fields: payload });
            if (error) { alert(t('err_saving_charge') + error.message); return; }
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
        if(confirm(t('c_del_charge').replace('{id}', id))) {
            const { error } = await supabaseClient.rpc('delete_charge', { p_actor: currentUsername, p_id: id });
            if (error) alert(t('err_prefix') + error.message);
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
        if (error) { alert(t('err_prefix') + error.message); return; }
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
                        <span style="font-size:13px;"><span class="type-pill">${c.charge_id}</span> <b>${escHtml(empName(c.employee_id))}</b> · <span class="status-badge status-${c.status}">${enumLabel(c.status)}</span></span>
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
            rows += `<div class="detail-subhead" style="margin:12px 0 6px; cursor:pointer;" onclick="toggleStatusGroup('weekdeposit','${status}')"><span class="rec-caret">${collapsed ? '▸' : '▾'}</span> <span class="status-badge status-${status}">${enumLabel(status)}</span> <span style="color:var(--text-muted); font-weight:400; text-transform:none; letter-spacing:normal;">(${group.length})</span></div>`;
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
        if (!editingEmpId) { alert(t('a_save_emp_first')); return; }
        const found = lastDailyPayWorked[editingEmpId];
        if (!found) { alert(t('a_no_dailypay_emp')); return; }
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
        if (!confirm(t('c_mark_inactive').replace('{name}', name))) return;
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
                alert(t('a_not_releasable').replace('{date}', eligibleDate));
                return;
            }
            if (!eligibleDate) {
                if (!confirm(t('c_no_ldw_90'))) return;
            }
        } else {
            if (!confirm(t('a_early_release_date').replace('{date}', eligibleDate || t('a_ldw_unknown')).replace('{tail}', currentUserRole === 'Medium' ? t('a_will_send_admin') : t('a_continue_q')))) return;
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
        if (d.last_paycheck_released_at) { alert(t('a_paycheck_released')); return; }
        const eligibleDate = lastWeekPayEligibleDate(empId);
        if (!isEarly) {
            if (eligibleDate && todayStr() < eligibleDate) {
                alert(t('a_not_releasable2').replace('{date}', eligibleDate));
                return;
            }
            if (!eligibleDate) {
                if (!confirm(t('c_no_ldw_30'))) return;
            }
        } else {
            if (!confirm(t('a_early_release_date').replace('{date}', eligibleDate || t('a_ldw_unknown')).replace('{tail}', currentUserRole === 'Medium' ? t('a_will_send_admin') : t('a_continue_q')))) return;
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
        if (totals.overCommitted) { alert(t('a_over_committed')); return; }
        if (currentReleaseMode === 'paycheck' && stmt.saved <= 0) { alert(t('a_enter_paycheck')); return; }
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
            if (error) { alert(t('err_prefix') + error.message); return; }
            closeReleaseStatement();
            alert(t('a_sent_approval'));
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
        if (error) { alert(t('err_prefix') + error.message); return; }
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
