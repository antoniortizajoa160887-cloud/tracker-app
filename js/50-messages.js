/* Tracker app — part 6/8: 50-messages.js
   Direct messaging — per-person, per-item threads, with file attachments and emoji.
   Split out of the original single-file index.html for maintainability; classic
   script, loaded in order with its siblings and sharing one global scope. */
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
        if (!person) { alert(t('a_pick_person')); return; }
        if (!topic) { alert(t('a_pick_topic')); return; }
        let ref = null;
        if (topic === 'Missing Day') {
            ref = document.getElementById('dm-new-ref')?.value || '';
            if (!ref) { alert(t('a_pick_date')); return; }
        } else if (topic === 'Claims' || topic === 'Charges' || topic === 'Income') {
            ref = document.getElementById('dm-new-ref')?.value || '';
            if (!ref) { alert(t('a_pick_which').replace('{kind}', topic.toLowerCase().replace(/s$/, ''))); return; }
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
                    <div class="msg-bubble">${m.body ? escHtml(m.body) : ''}${m.attach_path ? `${m.body ? '<br>' : ''}${dmFileChip(m, label)}` : ''}</div>
                    ${m.mine ? `<span class="msg-bubble-del" onclick="deleteDirectMessage(${m.id})">✕ Delete</span>` : ''}
                </div>`;
        });
        if (body) { body.innerHTML = html; if (force || !isSame || nearBottom) body.scrollTop = body.scrollHeight; }
    }

    async function sendDirectMessage() {
        if (!dmActiveUser || !dmActiveTopic) { alert(t('a_pick_convo')); return; }
        const el = document.getElementById('dm-compose-text');
        const text = (el.value || '').trim();
        if (!text) return;
        el.disabled = true;
        const { error } = await supabaseClient.rpc('dm_send', { p_actor: currentUsername, p_recipient: dmActiveUser, p_body: text, p_topic: dmActiveTopic, p_ref_id: dmActiveRef });
        el.disabled = false;
        if (error) { alert(t('err_prefix') + error.message); el.focus(); return; }
        el.value = '';
        await fetchDmThread();
        renderDmThread(true);
        await fetchDmThreads();
        renderDmThreads();
        el.focus();
    }

    async function deleteDirectMessage(id) {
        if (!confirm(t('c_del_message'))) return;
        const { error } = await supabaseClient.rpc('dm_delete_message', { p_actor: currentUsername, p_id: id });
        if (error) { alert(t('err_prefix') + error.message); return; }
        await fetchDmThread();
        renderDmThread(true);
        await fetchDmThreads();
        renderDmThreads();
    }

    // ---- Emoji picker: full categorized set with search (v3.64) ----------
    // One compact dataset drives both category browsing AND search — each
    // entry is [emoji, "keywords"]. Category tabs, a search box and a
    // recently-used row (remembered per device in localStorage) make the whole
    // emoji set reachable from any chat. insertDmEmoji stays the entry point.
    const EMOJI_CATS = [
        { id: 'recent', icon: '🕘', items: null },
        { id: 'smileys', icon: '😀', items: [
            ['😀','grin'],['😃','smile happy'],['😄','happy'],['😁','beam grin'],['😆','laugh'],['😅','sweat laugh'],['🤣','rofl laughing'],['😂','joy tears laugh'],['🙂','slight smile'],['🙃','upside down'],['😉','wink'],['😊','blush smile'],['😇','angel halo'],['🥰','love hearts'],['😍','heart eyes love'],['🤩','star struck'],['😘','blow kiss'],['😗','kiss'],['☺️','smile'],['😚','kiss'],['😙','kiss'],['🥲','tear smile'],['😋','yum tasty'],['😛','tongue'],['😜','wink tongue'],['🤪','zany goofy'],['😝','tongue'],['🤑','money mouth'],['🤗','hug'],['🤭','giggle oops'],['🤫','shh quiet'],['🤔','thinking'],['🤐','zipper mouth'],['🤨','raised eyebrow'],['😐','neutral'],['😑','expressionless'],['😶','no mouth'],['😏','smirk'],['😒','unamused'],['🙄','eye roll'],['😬','grimace'],['🤥','lying'],['😌','relieved calm'],['😔','pensive sad'],['😪','sleepy'],['🤤','drool'],['😴','sleep zzz'],['😷','mask sick'],['🤒','sick thermometer'],['🤕','hurt injured'],['🤢','nauseated sick'],['🤮','vomit sick'],['🤧','sneeze'],['🥵','hot'],['🥶','cold freezing'],['🥴','woozy'],['😵','dizzy'],['🤯','mind blown'],['🤠','cowboy'],['🥳','party celebrate'],['😎','cool sunglasses'],['🤓','nerd'],['🧐','monocle'],['😕','confused'],['😟','worried'],['🙁','frown'],['☹️','frown'],['😮','open mouth wow'],['😯','hushed'],['😲','astonished shocked'],['😳','flushed embarrassed'],['🥺','pleading puppy'],['😦','frown'],['😧','anguished'],['😨','fearful scared'],['😰','anxious'],['😥','sad'],['😢','cry sad'],['😭','sob crying'],['😱','scream'],['😖','confounded'],['😣','persevere'],['😞','disappointed'],['😓','sweat'],['😩','weary'],['😫','tired'],['🥱','yawn bored'],['😤','triumph steam mad'],['😡','rage angry mad'],['😠','angry mad'],['🤬','cursing swear'],['😈','devil smiling'],['👿','imp angry'],['💀','skull dead'],['☠️','skull crossbones'],['💩','poop'],['🤡','clown'],['👹','ogre'],['👺','goblin'],['👻','ghost'],['👽','alien'],['👾','space invader'],['🤖','robot'],['😺','cat'],['😸','cat grin'],['😹','cat joy'],['😻','cat love'],['😼','cat smirk'],['😽','cat kiss'],['🙀','cat weary'],['😿','cat cry'],['😾','cat pout'],
            ['👋','wave hello hi bye'],['🤚','raised back hand'],['🖐️','hand fingers'],['✋','raised hand stop'],['🖖','vulcan spock'],['👌','ok'],['🤌','pinched fingers'],['🤏','pinch small'],['✌️','victory peace'],['🤞','fingers crossed luck'],['🤟','love you'],['🤘','rock horns'],['🤙','call me shaka'],['👈','point left'],['👉','point right'],['👆','point up'],['🖕','middle finger'],['👇','point down'],['☝️','point up'],['👍','thumbs up like yes good'],['👎','thumbs down no bad'],['✊','fist raised'],['👊','fist bump punch'],['🤛','fist left'],['🤜','fist right'],['👏','clap applause'],['🙌','raise hands praise'],['👐','open hands'],['🤲','palms up'],['🤝','handshake deal agree'],['🙏','pray thanks please'],['✍️','writing hand'],['💅','nail polish'],['🤳','selfie'],['💪','muscle strong flex'],['🦾','mechanical arm'],['🦵','leg'],['🦶','foot'],['👂','ear listen'],['👃','nose'],['🧠','brain'],['🫀','heart organ'],['🦷','tooth'],['👀','eyes look'],['👁️','eye'],['👅','tongue'],['👄','lips mouth'],['👶','baby'],['🧒','child'],['👦','boy'],['👧','girl'],['🧑','person'],['👨','man'],['👩','woman'],['🧔','beard'],['👴','old man'],['👵','old woman'],['🙍','frowning person'],['🙎','pouting person'],['🙅','no gesture'],['🙆','ok gesture'],['💁','info desk person'],['🙋','raising hand'],['🧏','deaf person'],['🙇','bow sorry'],['🤦','facepalm'],['🤷','shrug'],['🧑‍💼','office worker'],['👮','police officer'],['🕵️','detective'],['💂','guard'],['👷','construction worker'],['🤴','prince'],['👸','princess'],['👳','turban'],['👲','cap'],['🧕','headscarf'],['🤵','tuxedo'],['👰','bride'],['🤰','pregnant'],['🤱','breastfeeding'],['👼','angel baby'],['🎅','santa'],['🤶','mrs claus'],['🦸','superhero'],['🦹','supervillain'],['🧙','mage wizard'],['🧚','fairy'],['🧛','vampire'],['🧜','merperson'],['🧝','elf'],['🧞','genie'],['🧟','zombie'],['💆','massage'],['💇','haircut'],['🚶','walking'],['🧍','standing'],['🧎','kneeling'],['🏃','running'],['💃','dancer'],['🕺','man dancing'],['👯','bunny ears'],['🧖','sauna'],['🧗','climbing'],['🤺','fencing'],['🏇','horse racing'],['⛷️','skier'],['🏂','snowboarder'],['🏌️','golfer'],['🏄','surfing'],['🚣','rowing'],['🏊','swimming'],['⛹️','ball player'],['🏋️','weightlifter'],['🚴','cycling'],['🚵','mountain biking'],['🤸','cartwheel'],['🤼','wrestling'],['🤽','water polo'],['🤾','handball'],['🤹','juggling'],['🧘','yoga meditate'],['🛀','bath'],['🛌','sleeping'],['👭','two women'],['👫','couple'],['👬','two men'],['💏','kiss couple'],['💑','couple heart'],['👪','family'],['🗣️','speaking head'],['👤','silhouette person'],['👥','silhouette people'],['👣','footprints'],
            ['❤️','red heart love'],['🧡','orange heart'],['💛','yellow heart'],['💚','green heart'],['💙','blue heart'],['💜','purple heart'],['🖤','black heart'],['🤍','white heart'],['🤎','brown heart'],['💔','broken heart'],['❣️','heart exclamation'],['💕','two hearts'],['💞','revolving hearts'],['💓','beating heart'],['💗','growing heart'],['💖','sparkling heart'],['💘','cupid arrow heart'],['💝','heart gift'],['💟','heart decoration'],
        ]},
        { id: 'animals', icon: '🐶', items: [
            ['🐶','dog'],['🐱','cat'],['🐭','mouse'],['🐹','hamster'],['🐰','rabbit'],['🦊','fox'],['🐻','bear'],['🐼','panda'],['🐻‍❄️','polar bear'],['🐨','koala'],['🐯','tiger'],['🦁','lion'],['🐮','cow'],['🐷','pig'],['🐽','pig nose'],['🐸','frog'],['🐵','monkey'],['🙈','see no evil monkey'],['🙉','hear no evil monkey'],['🙊','speak no evil monkey'],['🐒','monkey'],['🐔','chicken'],['🐧','penguin'],['🐦','bird'],['🐤','baby chick'],['🐣','hatching'],['🦆','duck'],['🦅','eagle'],['🦉','owl'],['🦇','bat'],['🐺','wolf'],['🐗','boar'],['🐴','horse face'],['🦄','unicorn'],['🐝','bee honeybee'],['🐛','bug caterpillar'],['🦋','butterfly'],['🐌','snail'],['🐞','ladybug'],['🐜','ant'],['🦟','mosquito'],['🦗','cricket'],['🕷️','spider'],['🕸️','web'],['🦂','scorpion'],['🐢','turtle'],['🐍','snake'],['🦎','lizard'],['🦖','t-rex dino'],['🦕','dinosaur'],['🐙','octopus'],['🦑','squid'],['🦐','shrimp'],['🦞','lobster'],['🦀','crab'],['🐡','blowfish'],['🐠','fish tropical'],['🐟','fish'],['🐬','dolphin'],['🐳','whale'],['🐋','whale'],['🦈','shark'],['🐊','crocodile'],['🐅','tiger'],['🐆','leopard'],['🦓','zebra'],['🦍','gorilla'],['🦧','orangutan'],['🐘','elephant'],['🦛','hippo'],['🦏','rhino'],['🐪','camel'],['🐫','camel'],['🦒','giraffe'],['🦘','kangaroo'],['🐃','buffalo'],['🐄','cow'],['🐎','horse'],['🐖','pig'],['🐏','ram'],['🐑','ewe sheep'],['🐐','goat'],['🦌','deer'],['🐕','dog'],['🐩','poodle'],['🦮','guide dog'],['🐈','cat'],['🐓','rooster'],['🦃','turkey'],['🦚','peacock'],['🦜','parrot'],['🦢','swan'],['🕊️','dove peace'],['🐇','rabbit'],['🦝','raccoon'],['🦨','skunk'],['🦡','badger'],['🦔','hedgehog'],['🐁','mouse'],['🐀','rat'],['🐿️','chipmunk'],['🦥','sloth'],['🦦','otter'],['🐾','paw prints'],['🐉','dragon'],['🐲','dragon face'],
            ['💐','bouquet flowers'],['🌸','cherry blossom'],['💮','white flower'],['🏵️','rosette'],['🌹','rose'],['🥀','wilted flower'],['🌺','hibiscus'],['🌻','sunflower'],['🌼','flower'],['🌷','tulip'],['🌱','seedling'],['🌲','evergreen tree'],['🌳','tree'],['🌴','palm tree'],['🌵','cactus'],['🌾','wheat'],['🌿','herb'],['☘️','shamrock'],['🍀','four leaf clover luck'],['🍁','maple leaf'],['🍂','fallen leaves'],['🍃','leaf wind'],['🍄','mushroom'],['🌰','chestnut'],['🌍','earth globe'],['🌎','earth americas'],['🌏','earth asia'],['🌕','full moon'],['🌖','moon'],['🌗','moon'],['🌘','moon'],['🌑','new moon'],['🌒','moon'],['🌓','moon'],['🌔','moon'],['🌙','crescent moon'],['🌚','new moon face'],['🌝','full moon face'],['🌞','sun face'],['⭐','star'],['🌟','glowing star'],['💫','dizzy stars'],['✨','sparkles'],['☄️','comet'],['🌠','shooting star'],['🌌','milky way'],['☀️','sun'],['🌤️','sun cloud'],['⛅','partly cloudy'],['🌥️','cloud sun'],['☁️','cloud'],['🌦️','rain sun'],['🌧️','rain'],['⛈️','thunderstorm'],['🌩️','lightning'],['🌨️','snow cloud'],['❄️','snowflake'],['☃️','snowman'],['⛄','snowman'],['🌬️','wind'],['💨','dash wind'],['🌪️','tornado'],['🌫️','fog'],['🌈','rainbow'],['💧','droplet'],['💦','sweat drops'],['🔥','fire flame'],['🌊','wave ocean water'],
        ]},
        { id: 'food', icon: '🍔', items: [
            ['🍏','green apple'],['🍎','apple'],['🍐','pear'],['🍊','orange tangerine'],['🍋','lemon'],['🍌','banana'],['🍉','watermelon'],['🍇','grapes'],['🍓','strawberry'],['🫐','blueberries'],['🍈','melon'],['🍒','cherries'],['🍑','peach'],['🥭','mango'],['🍍','pineapple'],['🥥','coconut'],['🥝','kiwi'],['🍅','tomato'],['🍆','eggplant'],['🥑','avocado'],['🥦','broccoli'],['🥬','leafy greens'],['🥒','cucumber'],['🌶️','hot pepper spicy'],['🫑','bell pepper'],['🌽','corn'],['🥕','carrot'],['🧄','garlic'],['🧅','onion'],['🥔','potato'],['🍠','sweet potato'],['🥐','croissant'],['🥯','bagel'],['🍞','bread'],['🥖','baguette'],['🥨','pretzel'],['🧀','cheese'],['🥚','egg'],['🍳','fried egg cooking'],['🧈','butter'],['🥞','pancakes'],['🧇','waffle'],['🥓','bacon'],['🥩','steak meat'],['🍗','poultry chicken leg'],['🍖','meat bone'],['🌭','hot dog'],['🍔','hamburger burger'],['🍟','fries'],['🍕','pizza'],['🥪','sandwich'],['🥙','stuffed flatbread'],['🧆','falafel'],['🌮','taco'],['🌯','burrito'],['🫔','tamale'],['🥗','salad'],['🥘','pan food paella'],['🫕','fondue'],['🍲','stew pot'],['🍜','ramen noodles'],['🍝','spaghetti pasta'],['🍛','curry rice'],['🍣','sushi'],['🍱','bento box'],['🥟','dumpling'],['🦪','oyster'],['🍤','fried shrimp'],['🍙','rice ball'],['🍚','rice'],['🍘','rice cracker'],['🥠','fortune cookie'],['🥮','moon cake'],['🍢','oden'],['🍡','dango'],['🍧','shaved ice'],['🍨','ice cream'],['🍦','soft serve'],['🥧','pie'],['🧁','cupcake'],['🍰','shortcake'],['🎂','birthday cake'],['🍮','custard flan'],['🍭','lollipop'],['🍬','candy'],['🍫','chocolate'],['🍿','popcorn'],['🍩','doughnut donut'],['🍪','cookie'],['🌰','chestnut'],['🥜','peanuts'],['🍯','honey'],['🥛','milk glass'],['🍼','baby bottle'],['☕','coffee hot'],['🍵','tea'],['🧃','juice box'],['🥤','cup straw soda'],['🧋','bubble tea boba'],['🍶','sake'],['🍺','beer'],['🍻','beers cheers'],['🥂','clink champagne cheers'],['🍷','wine'],['🥃','whiskey tumbler'],['🍸','cocktail martini'],['🍹','tropical drink'],['🧉','mate'],['🍽️','plate fork knife'],['🍴','fork and knife'],['🥄','spoon'],['🧂','salt'],
        ]},
        { id: 'activities', icon: '⚽', items: [
            ['⚽','soccer football'],['🏀','basketball'],['🏈','american football'],['⚾','baseball'],['🥎','softball'],['🎾','tennis'],['🏐','volleyball'],['🏉','rugby'],['🥏','frisbee'],['🎱','pool 8 ball'],['🪀','yoyo'],['🏓','ping pong table tennis'],['🏸','badminton'],['🏒','ice hockey'],['🏑','field hockey'],['🥍','lacrosse'],['🏏','cricket'],['🥅','goal net'],['⛳','golf flag'],['🪁','kite'],['🏹','bow arrow archery'],['🎣','fishing'],['🤿','diving mask'],['🥊','boxing glove'],['🥋','martial arts'],['🎽','running shirt'],['🛹','skateboard'],['🛼','roller skate'],['🛷','sled'],['⛸️','ice skate'],['🥌','curling'],['🎿','skis'],['🛶','canoe'],['🏆','trophy winner'],['🥇','gold medal 1st'],['🥈','silver medal 2nd'],['🥉','bronze medal 3rd'],['🏅','sports medal'],['🎖️','military medal'],['🏵️','rosette'],['🎗️','reminder ribbon'],['🎫','ticket'],['🎟️','admission tickets'],['🎪','circus tent'],['🤹','juggling'],['🎭','performing arts theater'],['🩰','ballet'],['🎨','artist palette paint'],['🎬','clapper movie film'],['🎤','microphone sing karaoke'],['🎧','headphone'],['🎼','musical score'],['🎹','piano keyboard'],['🥁','drum'],['🎷','saxophone'],['🎺','trumpet'],['🪗','accordion'],['🎸','guitar'],['🪕','banjo'],['🎻','violin'],['🎲','dice game'],['♟️','chess pawn'],['🎯','direct hit dart target'],['🎳','bowling'],['🎮','video game controller'],['🕹️','joystick'],['🎰','slot machine'],['🧩','puzzle piece'],['🧸','teddy bear toy'],['🪅','pinata'],['🪩','disco ball'],['🎊','confetti ball'],['🎉','party popper'],['🎈','balloon'],['🎏','carp streamer'],['🎐','wind chime'],['🎎','dolls'],['🎀','ribbon'],['🎁','gift wrapped present'],
        ]},
        { id: 'travel', icon: '✈️', items: [
            ['🚗','car automobile'],['🚕','taxi'],['🚙','suv'],['🚌','bus'],['🚎','trolleybus'],['🏎️','race car'],['🚓','police car'],['🚑','ambulance'],['🚒','fire engine truck'],['🚐','minibus van'],['🛻','pickup truck'],['🚚','delivery truck'],['🚛','semi truck lorry'],['🚜','tractor'],['🦽','wheelchair'],['🛴','kick scooter'],['🚲','bicycle bike'],['🛵','motor scooter'],['🏍️','motorcycle'],['🛺','auto rickshaw'],['🚨','police light siren'],['🚔','oncoming police car'],['🚍','oncoming bus'],['🚘','oncoming car'],['🚖','oncoming taxi'],['🚡','aerial tramway'],['🚠','mountain cableway'],['🚟','suspension railway'],['🚃','railway car'],['🚋','tram car'],['🚞','mountain railway'],['🚝','monorail'],['🚄','bullet train'],['🚅','bullet train'],['🚈','light rail'],['🚂','locomotive steam'],['🚆','train'],['🚇','metro subway'],['🚊','tram'],['🚉','station'],['✈️','airplane flight'],['🛫','departure takeoff'],['🛬','arrival landing'],['🛩️','small airplane'],['💺','seat'],['🚁','helicopter'],['🚀','rocket launch'],['🛸','flying saucer ufo'],['🛰️','satellite'],['🚢','ship'],['⛴️','ferry'],['🛳️','passenger ship cruise'],['🛥️','motor boat'],['⛵','sailboat'],['🚤','speedboat'],['🛶','canoe'],['⚓','anchor'],['⛽','fuel pump gas'],['🚧','construction barrier'],['🚦','traffic light'],['🚥','horizontal traffic light'],['🗺️','world map'],['🧭','compass'],['🗿','moai statue'],['🗽','statue of liberty'],['🗼','tokyo tower'],['🏰','castle'],['🏯','japanese castle'],['🏟️','stadium'],['🎡','ferris wheel'],['🎢','roller coaster'],['🎠','carousel'],['⛲','fountain'],['⛱️','umbrella beach'],['🏖️','beach'],['🏝️','desert island'],['🏜️','desert'],['🌋','volcano'],['⛰️','mountain'],['🏔️','snow mountain'],['🗻','mount fuji'],['🏕️','camping'],['⛺','tent'],['🏠','house home'],['🏡','house garden'],['🏘️','houses'],['🏚️','derelict house'],['🏗️','building construction'],['🏭','factory'],['🏢','office building'],['🏬','department store'],['🏣','post office japan'],['🏤','post office'],['🏥','hospital'],['🏦','bank'],['🏨','hotel'],['🏪','convenience store'],['🏫','school'],['🏩','love hotel'],['💒','wedding chapel'],['🏛️','classical building'],['⛪','church'],['🕌','mosque'],['🛕','hindu temple'],['🕍','synagogue'],['🕋','kaaba'],['⛩️','shinto shrine'],['🛤️','railway track'],['🛣️','motorway'],['🌁','foggy'],['🌃','night stars'],['🏙️','cityscape'],['🌄','sunrise mountains'],['🌅','sunrise'],['🌆','city dusk'],['🌇','sunset'],['🌉','bridge night'],['🎆','fireworks'],['🎇','sparkler'],['🧨','firecracker'],
        ]},
        { id: 'objects', icon: '💡', items: [
            ['⌚','watch'],['📱','mobile phone'],['📲','phone arrow'],['💻','laptop computer'],['⌨️','keyboard'],['🖥️','desktop computer'],['🖨️','printer'],['🖱️','computer mouse'],['🖲️','trackball'],['🕹️','joystick'],['🗜️','clamp'],['💽','computer disk'],['💾','floppy disk save'],['💿','optical disc cd'],['📀','dvd'],['📼','videocassette'],['📷','camera photo'],['📸','camera flash'],['📹','video camera'],['🎥','movie camera'],['📽️','film projector'],['🎞️','film frames'],['📞','telephone receiver'],['☎️','telephone'],['📟','pager'],['📠','fax'],['📺','television tv'],['📻','radio'],['🎙️','studio microphone'],['🎚️','level slider'],['🎛️','control knobs'],['⏱️','stopwatch'],['⏲️','timer clock'],['⏰','alarm clock'],['🕰️','mantelpiece clock'],['⌛','hourglass done'],['⏳','hourglass'],['📡','satellite antenna'],['🔋','battery'],['🔌','plug'],['💡','light bulb idea'],['🔦','flashlight'],['🕯️','candle'],['🪔','oil lamp'],['🧯','fire extinguisher'],['🛢️','oil drum'],['💸','money flying'],['💵','dollar cash'],['💴','yen banknote'],['💶','euro banknote'],['💷','pound banknote'],['🪙','coin'],['💰','money bag'],['💳','credit card'],['🧾','receipt invoice'],['💎','gem stone diamond'],['⚖️','balance scale'],['🪜','ladder'],['🧰','toolbox'],['🪛','screwdriver'],['🔧','wrench'],['🔨','hammer'],['⚒️','hammer pick'],['🛠️','hammer and wrench tools'],['⛏️','pick'],['🪚','saw'],['🔩','nut and bolt'],['⚙️','gear settings'],['🧱','brick'],['⛓️','chains'],['🧲','magnet'],['🔫','water pistol'],['💣','bomb'],['🧨','firecracker dynamite'],['🪓','axe'],['🔪','kitchen knife'],['🗡️','dagger'],['⚔️','crossed swords'],['🛡️','shield'],['🚬','cigarette'],['⚰️','coffin'],['⚱️','funeral urn'],['🏺','amphora'],['🔮','crystal ball'],['📿','prayer beads'],['🧿','nazar amulet'],['💈','barber pole'],['🔭','telescope'],['🔬','microscope'],['🕳️','hole'],['💊','pill medicine'],['💉','syringe shot'],['🩸','blood drop'],['🩹','adhesive bandage'],['🩺','stethoscope'],['🌡️','thermometer'],['🧬','dna'],['🦠','microbe germ virus'],['🧫','petri dish'],['🧪','test tube'],['⚗️','alembic chemistry'],['🧹','broom'],['🧺','basket'],['🧻','toilet paper'],['🚽','toilet'],['🚰','potable water'],['🚿','shower'],['🛁','bathtub'],['🧼','soap'],['🪥','toothbrush'],['🪒','razor'],['🧴','lotion bottle'],['🧷','safety pin'],['🧵','thread'],['🧶','yarn'],['🧽','sponge'],['🔑','key'],['🗝️','old key'],['🔒','locked'],['🔓','unlocked'],['🔏','lock pen'],['🔐','lock key'],['🚪','door'],['🪟','window'],['🛏️','bed'],['🛋️','couch lamp'],['🪑','chair'],['🖼️','framed picture'],['🛒','shopping cart'],['🎁','gift present'],['🪄','magic wand'],['📦','package box'],['📫','mailbox closed flag up'],['📮','postbox'],['📪','mailbox closed'],['📬','mailbox open flag up'],['✉️','envelope'],['📧','e-mail'],['📨','incoming envelope'],['📩','envelope arrow'],['📤','outbox tray'],['📥','inbox tray'],['📜','scroll'],['📃','page curl'],['📄','page document'],['📑','bookmark tabs'],['🧾','receipt'],['📊','bar chart'],['📈','chart increasing up'],['📉','chart decreasing down'],['🗒️','spiral notepad'],['🗓️','spiral calendar'],['📆','tear off calendar'],['📅','calendar date'],['📇','card index'],['🗃️','card file box'],['🗄️','file cabinet'],['📋','clipboard'],['📌','pushpin'],['📍','round pushpin location'],['📎','paperclip'],['🖇️','linked paperclips'],['📏','straight ruler'],['📐','triangular ruler'],['✂️','scissors cut'],['🖊️','pen'],['🖋️','fountain pen'],['✒️','black nib'],['🖌️','paintbrush'],['🖍️','crayon'],['📝','memo pencil note'],['✏️','pencil'],['🔍','magnifying glass search left'],['🔎','magnifying glass search right'],['🔏','locked pen'],['📁','file folder'],['📂','open file folder'],['🗂️','card index dividers'],['📔','notebook decorative'],['📕','closed book red'],['📗','green book'],['📘','blue book'],['📙','orange book'],['📚','books'],['📓','notebook'],['📒','ledger'],['📃','page'],['📖','open book read'],['🔖','bookmark'],['🏷️','label tag price'],['📰','newspaper'],['🗞️','rolled newspaper'],
        ]},
        { id: 'symbols', icon: '❤️', items: [
            ['✅','check mark button yes done'],['✔️','check mark'],['☑️','check box'],['❌','cross mark no'],['❎','cross mark button'],['➕','plus add'],['➖','minus subtract'],['➗','divide'],['✖️','multiply'],['➰','curly loop'],['➿','double loop'],['♾️','infinity'],['❓','question mark'],['❔','white question'],['❗','exclamation'],['❕','white exclamation'],['‼️','double exclamation'],['⁉️','exclamation question'],['💯','hundred perfect score'],['🔥','fire hot lit'],['⭐','star'],['🌟','glowing star'],['✨','sparkles'],['⚡','high voltage lightning'],['💫','dizzy'],['💢','anger symbol'],['💥','collision boom'],['💦','sweat droplets'],['💨','dashing wind'],['💤','zzz sleep'],['⚠️','warning'],['🚸','children crossing'],['⛔','no entry'],['🚫','prohibited no'],['🚳','no bicycles'],['🚭','no smoking'],['🔞','no under eighteen'],['📵','no mobile phones'],['❗','red exclamation'],['🔅','dim button'],['🔆','bright button'],['〽️','part alternation'],['⚜️','fleur de lis'],['🔱','trident'],['📛','name badge'],['🔰','japanese beginner'],['⭕','hollow red circle'],['✳️','eight spoked asterisk'],['✴️','eight pointed star'],['❇️','sparkle'],['🌐','globe meridians'],['💠','diamond dot'],['Ⓜ️','circled m'],['🌀','cyclone'],['♻️','recycle'],['🏧','atm'],['🚾','water closet wc'],['♿','wheelchair accessible'],['🅿️','parking'],['🛗','elevator'],['🚹','mens room'],['🚺','womens room'],['🚼','baby symbol'],['🚻','restroom'],['🚮','litter bin'],['🎦','cinema'],['📶','signal bars'],['🈁','japanese here'],['🔣','input symbols'],['ℹ️','information'],['🔤','abc latin'],['🔡','abcd lower'],['🔠','ABCD upper'],['🆖','ng button'],['🆗','ok button'],['🆙','up button'],['🆒','cool button'],['🆕','new button'],['🆓','free button'],['0️⃣','zero'],['1️⃣','one'],['2️⃣','two'],['3️⃣','three'],['4️⃣','four'],['5️⃣','five'],['6️⃣','six'],['7️⃣','seven'],['8️⃣','eight'],['9️⃣','nine'],['🔟','ten'],['🔢','numbers'],['#️⃣','hash keycap'],['*️⃣','asterisk keycap'],['⏏️','eject'],['▶️','play'],['⏸️','pause'],['⏯️','play or pause'],['⏹️','stop'],['⏺️','record'],['⏭️','next track'],['⏮️','last track previous'],['⏩','fast forward'],['⏪','rewind'],['⏫','fast up'],['⏬','fast down'],['◀️','reverse play'],['🔼','up button'],['🔽','down button'],['🔀','shuffle'],['🔁','repeat'],['🔂','repeat one'],['➡️','right arrow'],['⬅️','left arrow'],['⬆️','up arrow'],['⬇️','down arrow'],['↗️','up right arrow'],['↘️','down right arrow'],['↙️','down left arrow'],['↖️','up left arrow'],['↕️','up down arrow'],['↔️','left right arrow'],['↩️','right arrow curving left'],['↪️','left arrow curving right'],['⤴️','arrow up curve'],['⤵️','arrow down curve'],['🔃','clockwise arrows'],['🔄','counterclockwise arrows refresh sync'],['🔙','back arrow'],['🔚','end arrow'],['🔛','on arrow'],['🔜','soon arrow'],['🔝','top arrow'],['🛐','place of worship'],['⚛️','atom'],['🕉️','om'],['✡️','star of david'],['☸️','wheel of dharma'],['☯️','yin yang'],['✝️','latin cross'],['☦️','orthodox cross'],['☪️','star and crescent'],['☮️','peace symbol'],['🕎','menorah'],['🔯','six pointed star'],['♈','aries'],['♉','taurus'],['♊','gemini'],['♋','cancer'],['♌','leo'],['♍','virgo'],['♎','libra'],['♏','scorpio'],['♐','sagittarius'],['♑','capricorn'],['♒','aquarius'],['♓','pisces'],['⛎','ophiuchus'],['🆔','id'],['⚛️','atom'],['🉑','acceptable'],['☢️','radioactive'],['☣️','biohazard'],['📴','phone off'],['📳','vibration mode'],['🈶','not free of charge'],['🈚','free of charge'],['🈸','application'],['🈺','open for business'],['🈷️','monthly amount'],['✴️','star'],['🆚','versus vs'],['💮','white flower'],['🉐','bargain'],['㊙️','secret'],['㊗️','congratulations'],['🈴','passing grade'],['🈵','no vacancy full'],['🈹','discount'],['🈲','prohibited'],['🅰️','a blood type'],['🅱️','b blood type'],['🆎','ab blood type'],['🆑','cl'],['🅾️','o blood type'],['🆘','sos help'],['❌','x'],['🛑','stop sign'],['⛑️','rescue helmet'],['🔰','beginner'],['♠️','spade suit'],['♥️','heart suit'],['♦️','diamond suit'],['♣️','club suit'],['🃏','joker'],['🀄','mahjong red dragon'],['🎴','flower playing cards'],['🔇','muted speaker mute'],['🔈','speaker low'],['🔉','speaker medium'],['🔊','speaker loud volume'],['📢','loudspeaker'],['📣','megaphone'],['📯','postal horn'],['🔔','bell notification'],['🔕','bell slash muted'],['🎵','musical note'],['🎶','musical notes'],['💲','heavy dollar'],['💱','currency exchange'],['™️','trade mark'],['©️','copyright'],['®️','registered'],['〰️','wavy dash'],['➕','plus'],
        ]},
        { id: 'flags', icon: '🏳️', items: [
            ['🏁','chequered flag finish race'],['🚩','triangular flag'],['🎌','crossed flags'],['🏴','black flag'],['🏳️','white flag'],['🏳️‍🌈','rainbow pride flag'],['🏴‍☠️','pirate flag'],['🇺🇸','united states usa america'],['🇪🇸','spain espana'],['🇲🇽','mexico'],['🇬🇧','united kingdom uk britain'],['🇨🇦','canada'],['🇫🇷','france'],['🇩🇪','germany'],['🇮🇹','italy'],['🇵🇹','portugal'],['🇧🇷','brazil'],['🇦🇷','argentina'],['🇨🇴','colombia'],['🇬🇹','guatemala'],['🇸🇻','el salvador'],['🇭🇳','honduras'],['🇳🇮','nicaragua'],['🇨🇷','costa rica'],['🇵🇦','panama'],['🇩🇴','dominican republic'],['🇨🇺','cuba'],['🇵🇷','puerto rico'],['🇻🇪','venezuela'],['🇪🇨','ecuador'],['🇵🇪','peru'],['🇨🇱','chile'],['🇧🇴','bolivia'],['🇺🇾','uruguay'],['🇵🇾','paraguay'],['🇯🇵','japan'],['🇨🇳','china'],['🇰🇷','south korea'],['🇮🇳','india'],['🇷🇺','russia'],['🇦🇺','australia'],['🇳🇿','new zealand'],['🇿🇦','south africa'],['🇳🇬','nigeria'],['🇰🇪','kenya'],['🇪🇬','egypt'],['🇸🇦','saudi arabia'],['🇦🇪','united arab emirates uae'],['🇮🇱','israel'],['🇹🇷','turkey'],['🇬🇷','greece'],['🇳🇱','netherlands'],['🇧🇪','belgium'],['🇨🇭','switzerland'],['🇦🇹','austria'],['🇸🇪','sweden'],['🇳🇴','norway'],['🇩🇰','denmark'],['🇫🇮','finland'],['🇮🇪','ireland'],['🇵🇱','poland'],['🇺🇦','ukraine'],['🇨🇿','czechia'],['🇷🇴','romania'],['🇭🇺','hungary'],['🇵🇭','philippines'],['🇮🇩','indonesia'],['🇹🇭','thailand'],['🇻🇳','vietnam'],['🇲🇾','malaysia'],['🇸🇬','singapore'],['🇵🇰','pakistan'],['🇧🇩','bangladesh'],
        ]},
    ];
    let dmEmojiCat = 'smileys';
    let dmEmojiQuery = '';

    function dmEmojiRecent() {
        try { return JSON.parse(localStorage.getItem('dm_recent_emojis') || '[]'); } catch (e) { return []; }
    }
    function dmEmojiPushRecent(e) {
        try {
            let r = dmEmojiRecent().filter(x => x !== e);
            r.unshift(e);
            localStorage.setItem('dm_recent_emojis', JSON.stringify(r.slice(0, 24)));
        } catch (e2) {}
    }
    function dmEmojiCatItems(id) {
        if (id === 'recent') return dmEmojiRecent().map(e => [e, '']);
        const c = EMOJI_CATS.find(x => x.id === id);
        return c && c.items ? c.items : [];
    }
    function dmEmojiAll() {
        const out = [];
        EMOJI_CATS.forEach(c => { if (c.items) out.push(...c.items); });
        return out;
    }
    function dmRenderEmojiGrid() {
        const g = document.getElementById('dm-emoji-grid');
        if (!g) return;
        const q = dmEmojiQuery.trim().toLowerCase();
        let items;
        if (q) {
            items = dmEmojiAll().filter(([e, kw]) => e === dmEmojiQuery.trim() || (kw && kw.indexOf(q) !== -1)).slice(0, 140);
        } else {
            items = dmEmojiCatItems(dmEmojiCat);
        }
        if (!items.length) {
            g.innerHTML = `<div class="dm-emoji-none">${(!q && dmEmojiCat === 'recent') ? t('em_no_recent') : t('em_no_match')}</div>`;
            return;
        }
        g.innerHTML = items.map(([e]) => `<button type="button" title="${escHtml(e)}" onclick="insertDmEmoji('${e}')">${e}</button>`).join('');
    }
    function dmSetEmojiCat(id) {
        dmEmojiCat = id;
        dmEmojiQuery = '';
        const si = document.getElementById('dm-emoji-search-input');
        if (si) si.value = '';
        document.querySelectorAll('.dm-emoji-cat').forEach(b => b.classList.toggle('active', b.getAttribute('data-cat') === id));
        dmRenderEmojiGrid();
    }
    function dmEmojiOnSearch(v) {
        dmEmojiQuery = v || '';
        const active = dmEmojiQuery.trim() ? '__none__' : dmEmojiCat;
        document.querySelectorAll('.dm-emoji-cat').forEach(b => b.classList.toggle('active', b.getAttribute('data-cat') === active));
        dmRenderEmojiGrid();
    }
    function renderDmEmojiPanel() {
        const p = document.getElementById('dm-emoji-panel');
        if (!p) return;
        p.style.flexDirection = 'column';
        p.style.flexWrap = 'nowrap';
        p.style.maxHeight = '300px';
        p.style.overflow = 'hidden';
        if (dmEmojiCat === 'recent' && !dmEmojiRecent().length) dmEmojiCat = 'smileys';
        const cats = EMOJI_CATS.map(c => `<button type="button" class="dm-emoji-cat${c.id === dmEmojiCat ? ' active' : ''}" data-cat="${c.id}" title="${escHtml(c.id)}" onclick="dmSetEmojiCat('${c.id}')">${c.icon}</button>`).join('');
        p.innerHTML =
            `<div class="dm-emoji-search"><input id="dm-emoji-search-input" type="text" placeholder="${escHtml(t('em_search_ph'))}" oninput="dmEmojiOnSearch(this.value)" autocomplete="off"></div>` +
            `<div class="dm-emoji-cats">${cats}</div>` +
            `<div id="dm-emoji-grid" class="dm-emoji-grid"></div>`;
        dmEmojiQuery = '';
        dmRenderEmojiGrid();
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
        dmEmojiPushRecent(e);
    }

    // ---- Attaching a file to a chat --------------------------------------
    // Files live on the record the thread is about, so they can only be sent
    // from a Claim / Charge / Income conversation — the file is attached to
    // that record (visible in its Files) AND shown here in the thread.
    function dmTopicEntityType(topic) {
        return topic === 'Claims' ? 'claim' : topic === 'Charges' ? 'charge' : topic === 'Income' ? 'income' : null;
    }
    function dmFileChip(m, label) {
        const icon = m.attach_kind === 'photo' ? '📷' : m.attach_kind === 'video' ? '🎬' : '📄';
        const size = m.attach_size ? ' · ' + formatBytes(m.attach_size) : '';
        return `<button type="button" class="btn-small" style="margin:2px 0 0; background:var(--excel-blue);" onclick="openChatFile(${m.id})">${icon} ${escHtml(m.attach_name || 'file')}${size}</button>`;
    }

    // Open the file viewer on this chat's attachments as a gallery, so ‹/› page
    // through every file in the open conversation (chronological), starting at
    // the clicked one. Attribution: the sender uploaded it, at the message time;
    // mime is left blank so the file-name extension drives the render mode.
    function openChatFile(msgId) {
        const atts = (dmThreadMsgs || []).filter(m => m.attach_path);
        if (!atts.length) return;
        const label = dmActivePersonLabel();
        const items = atts.map(m => ({
            path: m.attach_path,
            name: m.attach_name || 'file',
            mime: '',
            by: m.mine ? (currentUsername || '') : (label || ''),
            at: m.created_at || '',
            size: m.attach_size
        }));
        const idx = Math.max(0, atts.findIndex(m => m.id === msgId));
        openFileGallery(items, idx);
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
        if (!dmActiveUser || !dmActiveTopic) { alert(t('a_pick_convo')); return; }
        const entityType = dmTopicEntityType(dmActiveTopic);
        if (!entityType || !dmActiveRef) {
            alert(t('a_share_file_hint'));
            return;
        }
        if (!canUploadTo(entityType, dmActiveRef)) {
            alert(t('a_own_files_only'));
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
        if (!dmActiveUser || !dmActiveTopic) { alert(t('a_pick_convo')); return; }
        const entityType = dmTopicEntityType(dmActiveTopic);
        if (!entityType || !dmActiveRef) return;
        if (!canUploadTo(entityType, dmActiveRef)) {
            alert(t('a_own_files_only'));
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
                alert(t('err_could_not_send') + (e && e.message ? e.message : e));
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
                    <td>${enumLabel(emp.person_type)}</td>
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
                            <div><div class="k" data-i18n="d_type">Type</div><div class="v">${enumLabel(emp.person_type)}</div></div>
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
        alert(title + t('a_edit_prompt_hint'));
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
            if (!isFinite(n)) { alert(t('a_must_be_number').replace('{field}', k.replace(/_/g, ' '))); return false; }
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
        if (error) alert(t('err_prefix') + error.message);
        else { renderApprovals(); fetchAllDataFromCloud(); }
    }

    async function rejectChange(id) {
        if (!confirm(t('c_reject_change'))) return;
        const { error } = await supabaseClient.rpc('reject_change', { p_actor: currentUsername, p_id: id });
        if (error) alert(t('err_prefix') + error.message);
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
        if (!confirm(t('c_approve_release'))) return;
        const { error } = await supabaseClient.rpc('approve_release_request', { p_actor: currentUsername, p_request_id: id });
        if (error) { alert(t('err_prefix') + error.message); return; }
        renderReleaseRequests();
        await fetchChargesFromCloud();
        await fetchClaimsFromCloud();
        await loadChargeHistory();
        await loadEmployeeDetails();
        alert(t('a_release_done'));
    }

    async function rejectReleaseRequest(id) {
        if (!confirm(t('c_reject_release'))) return;
        const { error } = await supabaseClient.rpc('reject_release_request', { p_actor: currentUsername, p_request_id: id, p_reason: null });
        if (error) { alert(t('err_prefix') + error.message); return; }
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
