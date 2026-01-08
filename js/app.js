document.addEventListener('DOMContentLoaded', () => {
    // ============================================
    // CONFIGURATION & STATE
    // ============================================
    
    const socketProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = `${socketProto}//${window.location.host}/ws`;
    let socket;

    // State
    let isConnected = false;
    let isAiEnabled = false;
    let isMicEnabled = false;
    let isSystemAudioEnabled = false;
    let pendingMicDevice = null;
    let pendingLoopbackDevice = null;
    let settingsLoaded = false;
    let activeTabName = 'chat';
    let settingsBaseline = null; // stable string of last-saved settings form state
    let currentSessionId = null;
    let sessionStartTime = null;
    let messageCount = 0;
    let allNotes = [];
    let transcriptDisplayMode = 'raw';
    const transcriptMessagesById = new Map(); // id -> { rawText, cleanText, textSpan, timeDiv, role }
    let transcriptAiMode = 'off';

    // ============================================
    // DOM REFERENCES
    // ============================================
    
    const chatContainer = document.getElementById('chat-container');
    const manualInput = document.getElementById('manual-input');
    const sendBtn = document.getElementById('send-btn');
    const connectionStatus = document.getElementById('connection-status');
    const connectionDot = document.getElementById('connection-dot');
    const activityStatus = document.getElementById('activity-status');
    const micSelect = document.getElementById('setting-mic');
    const loopbackSelect = document.getElementById('setting-loopback');
    const aiToggleBtn = document.getElementById('toggle-ai');
    const micToggleBtn = document.getElementById('toggle-mic');
    const systemAudioToggleBtn = document.getElementById('toggle-audio');
    const newSessionBtn = document.getElementById('new-session-btn');
    const tabTitle = document.getElementById('tab-title');
    const tabSubtitle = document.getElementById('tab-subtitle');

    // Live session context
    const sessionContextBody = document.getElementById('session-context-body');
    const sessionContextInput = document.getElementById('session-context-input');
    const contextToggleBtn = document.getElementById('context-toggle-btn');
    const contextClearBtn = document.getElementById('context-clear-btn');
    const sessionContextSubtitle = document.getElementById('session-context-subtitle');
    
    // Session info
    const sessionIdEl = document.getElementById('session-id');
    const sessionDurationEl = document.getElementById('session-duration');
    const sessionMsgCountEl = document.getElementById('session-msg-count');
    
    // Notes
    const notesPointsSession = document.getElementById('notes-points-session');
    const notesEmptyState = document.getElementById('notes-empty-state');
    const manualNoteInput = document.getElementById('manual-note-input');
    const addNoteBtn = document.getElementById('add-note-btn');
    const notesRefreshBtn = document.getElementById('notes-refresh-btn');
    const notesClearBtn = document.getElementById('notes-clear-btn');
    const notesExportBtn = document.getElementById('notes-export-btn');
    const notesGrid = document.getElementById('notes-grid');
    const notesFullEmpty = document.getElementById('notes-full-empty');

    // ============================================
    // TOAST NOTIFICATIONS
    // ============================================
    
    const toastContainer = (() => {
        const el = document.createElement('div');
        el.className = 'toast-container';
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('aria-relevant', 'additions');
        document.body.appendChild(el);
        return el;
    })();

    const toastLastShownAtByKey = new Map();
    const toastTimersById = new Map();
    let toastIdSeq = 0;

    function notify(type, message, options = {}) {
        const msg = (typeof message === 'string' ? message : String(message || '')).trim();
        if (!msg) return;

        const {
            durationMs = 3200,
            dedupeKey = msg,
            dedupeWindowMs = 2000,
            persist = false
        } = options;

        const now = Date.now();
        const last = toastLastShownAtByKey.get(dedupeKey);
        if (last && now - last < dedupeWindowMs) return;
        toastLastShownAtByKey.set(dedupeKey, now);

        const toastId = ++toastIdSeq;
        const toastEl = document.createElement('div');
        toastEl.className = `toast toast--${type || 'info'}`;
        toastEl.dataset.toastId = String(toastId);

        const iconEl = document.createElement('div');
        iconEl.className = 'toast-icon';
        if (type === 'success') iconEl.innerHTML = '<i class="fa-solid fa-check"></i>';
        else if (type === 'error') iconEl.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i>';
        else if (type === 'warning') iconEl.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i>';
        else iconEl.innerHTML = '<i class="fa-solid fa-circle-info"></i>';

        const bodyEl = document.createElement('div');
        bodyEl.className = 'toast-body';

        const msgEl = document.createElement('div');
        msgEl.className = 'toast-message';
        msgEl.textContent = msg;
        bodyEl.appendChild(msgEl);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.type = 'button';
        closeBtn.title = 'Dismiss';
        closeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';

        function dismiss() {
            const t = toastTimersById.get(toastId);
            if (t) {
                clearTimeout(t);
                toastTimersById.delete(toastId);
            }
            toastEl.classList.remove('show');
            setTimeout(() => toastEl.remove(), 160);
        }

        closeBtn.addEventListener('click', dismiss);
        toastEl.addEventListener('click', (e) => {
            if (e.target === closeBtn || closeBtn.contains(e.target)) return;
            dismiss();
        });

        toastEl.appendChild(iconEl);
        toastEl.appendChild(bodyEl);
        toastEl.appendChild(closeBtn);
        toastContainer.appendChild(toastEl);

        while (toastContainer.children.length > 3) {
            toastContainer.removeChild(toastContainer.firstElementChild);
        }

        requestAnimationFrame(() => toastEl.classList.add('show'));

        if (!persist) {
            const timer = setTimeout(dismiss, Math.max(800, durationMs));
            toastTimersById.set(toastId, timer);
        }
    }

    // ============================================
    // WEBSOCKET
    // ============================================
    
    let reconnectAttempts = 0;
    const maxReconnectAttempts = Infinity;

    function setConnectionState(state, detailText) {
        if (connectionDot) {
            connectionDot.classList.remove('connected', 'disconnected', 'connecting');
            connectionDot.classList.add(state);
        }

        if (!connectionStatus) return;
        if (state === 'connected') connectionStatus.textContent = 'Connected';
        else if (state === 'connecting') connectionStatus.textContent = detailText || 'Connecting…';
        else connectionStatus.textContent = detailText || 'Disconnected';
    }

    function setActivity(text) {
        if (!activityStatus) return;
        const msg = (text || '').trim();
        if (!msg) {
            activityStatus.classList.add('hidden');
            activityStatus.textContent = '';
            return;
        }
        activityStatus.textContent = msg;
        activityStatus.classList.remove('hidden');
    }
    
    function tryAutoStartAudio() {
        if (settingsLoaded && isConnected && socket && socket.readyState === WebSocket.OPEN) {
            if (isMicEnabled || isSystemAudioEnabled) {
                console.log('Auto-starting audio capture (mic=' + isMicEnabled + ', system=' + isSystemAudioEnabled + ')');
                socket.send(JSON.stringify({ type: 'start_audio' }));
            }
        }
    }

    function connectData() {
        setConnectionState('connecting');
        socket = new WebSocket(socketUrl);

        socket.onopen = () => {
            console.log("WebSocket Connected");
            isConnected = true;
            reconnectAttempts = 0;
            setConnectionState('connected');
            tryAutoStartAudio();
        };

        socket.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleMessage(data);
        };

        socket.onclose = (event) => {
            const code = event?.code;
            const reason = event?.reason;
            const wasClean = event?.wasClean;
            console.log("WebSocket Disconnected", { code, reason, wasClean });
            isConnected = false;
            setConnectionState('disconnected', code ? `Disconnected (${code})` : 'Disconnected');
            
            reconnectAttempts++;
            if (reconnectAttempts <= maxReconnectAttempts) {
                const delay = Math.min(10000, Math.round(500 * Math.pow(1.6, reconnectAttempts - 1)));
                setConnectionState('connecting', `Reconnecting… (${Math.min(reconnectAttempts, 99)})`);
                setTimeout(connectData, delay);
            }
        };

        socket.onerror = (err) => {
            console.error("WebSocket Error:", err);
        };
    }

    function handleMessage(data) {
        switch (data.type) {
            case 'transcription':
                upsertTranscriptMessage(data, { isUpdate: false });
                messageCount++;
                updateSessionInfo();
                break;

            case 'transcription_update':
                upsertTranscriptMessage(data, { isUpdate: true });
                break;

            case 'speaker_renamed':
                updateSpeakerLabels(data.speaker_id || data.speakerId, data.speaker_label || data.speakerLabel);
                break;
                
            case 'llm_chunk':
                appendToLastAssistantMessage(data.text);
                break;
                
            case 'llm_start':
                pendingAssistantText = '';
                if (assistantFlushRaf) {
                    cancelAnimationFrame(assistantFlushRaf);
                    assistantFlushRaf = null;
                }
                const now = new Date();
                const timeStr = now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');
                currentAssistantTextSpan = addMessage("", 'assistant', timeStr);
                messageCount++;
                updateSessionInfo();
                break;
                
            case 'llm_end':
                if (assistantFlushRaf) {
                    cancelAnimationFrame(assistantFlushRaf);
                    assistantFlushRaf = null;
                }
                flushAssistantPending();
                currentAssistantTextSpan = null;
                pendingAssistantText = '';
                break;
                
            case 'notes_update':
                allNotes = data.notes || [];
                renderNotes();
                break;
                
            case 'note_added':
                allNotes.push(data.note);
                renderNotes();
                notify('success', 'Note added', { durationMs: 1500 });
                break;
                
            case 'note_updated':
                const idx = allNotes.findIndex(n => n.id === data.note.id);
                if (idx !== -1) allNotes[idx] = data.note;
                renderNotes();
                break;
                
            case 'note_deleted':
                allNotes = allNotes.filter(n => n.id !== data.note_id);
                renderNotes();
                break;
                
            case 'notes_cleared':
                allNotes = [];
                renderNotes();
                notify('info', 'Notes cleared', { durationMs: 1500 });
                break;
                
            case 'session_info':
                currentSessionId = data.session_id;
                sessionStartTime = new Date(data.started_at);
                messageCount = 0;
                updateSessionInfo();
                transcriptMessagesById.clear();
                // Clear chat for new session
                if (chatContainer.children.length > 1) {
                    chatContainer.innerHTML = '';
                    addSystemMessage('New session started.');
                }
                setSessionContextText('');
                break;

            case 'session_context':
                setSessionContextText(typeof data.context === 'string' ? data.context : '');
                break;
                
            case 'assistant_policy':
                if (data.allow === false && data.show_withheld === true) {
                    notify('info', `Assistant withheld: ${data.reason || 'not appropriate now'}`, {
                        dedupeKey: `withheld:${data.reason || ''}`,
                        durationMs: 2600
                    });
                }
                break;
                
            case 'status':
                const msg = typeof data.message === 'string' ? data.message : '';
                if (msg.startsWith('Audio:')) {
                    setActivity(msg.replace(/^Audio:\s*/i, ''));

                    if (/capture\s+stopped\.?$/i.test(msg)) return;

                    if (/disabled|failed|error|did not start|recording did not start|nothing to capture|ignoring/i.test(msg)) {
                        notify('warning', msg, {
                            dedupeKey: `audio:${msg.toLowerCase()}`,
                            dedupeWindowMs: 6000,
                            durationMs: 3400
                        });
                    }
                    return;
                }
                console.log("Status:", data.message);
                break;
                
            case 'error':
                notify('error', `Error: ${data.message}`, {
                    dedupeKey: `err:${typeof data.message === 'string' ? data.message : String(data.message)}`,
                    dedupeWindowMs: 4000,
                    durationMs: 4200
                });

                if (typeof data.message === 'string' && data.message.startsWith('Audio:')) {
                    setActivity(data.message.replace(/^Audio:\s*/i, ''));
                }

                if (typeof data.message === 'string' && data.message.includes('AI_ASSISTANT_ENABLE_AUDIO=1')) {
                    isMicEnabled = false;
                    micToggleBtn.classList.remove('active');
                }
                break;
        }
    }

    // ============================================
    // SESSION INFO
    // ============================================
    
    function updateSessionInfo() {
        if (sessionIdEl && currentSessionId) {
            sessionIdEl.textContent = currentSessionId;
        }
        if (sessionMsgCountEl) {
            sessionMsgCountEl.textContent = messageCount;
        }
    }
    
    // Session duration timer
    setInterval(() => {
        if (sessionDurationEl && sessionStartTime) {
            const diff = Math.floor((Date.now() - sessionStartTime.getTime()) / 1000);
            const mins = Math.floor(diff / 60);
            const secs = diff % 60;
            sessionDurationEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
    }, 1000);

    // ============================================
    // NOTES RENDERING
    // ============================================
    
    function renderNotes() {
        // Session sidebar notes
        if (notesPointsSession) {
            notesPointsSession.innerHTML = '';
            const sessionNotes = allNotes.filter(n => !n.completed);
            
            if (sessionNotes.length === 0) {
                if (notesEmptyState) notesEmptyState.classList.remove('hidden');
            } else {
                if (notesEmptyState) notesEmptyState.classList.add('hidden');
                sessionNotes.forEach(note => {
                    notesPointsSession.appendChild(createNoteElement(note, true));
                });
            }
        }
        
        // Full notes grid
        if (notesGrid) {
            const activeFilter = document.querySelector('.notes-filter-btn.active')?.dataset.filter || 'all';
            let filteredNotes = allNotes;
            
            if (activeFilter === 'ai') {
                filteredNotes = allNotes.filter(n => n.source === 'ai');
            } else if (activeFilter === 'manual') {
                filteredNotes = allNotes.filter(n => n.source === 'manual');
            } else if (activeFilter === 'pinned') {
                filteredNotes = allNotes.filter(n => n.pinned);
            }
            
            notesGrid.innerHTML = '';
            if (filteredNotes.length === 0) {
                if (notesFullEmpty) notesFullEmpty.classList.remove('hidden');
            } else {
                if (notesFullEmpty) notesFullEmpty.classList.add('hidden');
                filteredNotes.forEach(note => {
                    notesGrid.appendChild(createNoteElement(note, false));
                });
            }
        }
    }
    
    function createNoteElement(note, compact = false) {
        const div = document.createElement('div');
        div.className = 'note-item';
        if (note.pinned) div.classList.add('pinned');
        if (note.completed) div.classList.add('completed');
        div.dataset.noteId = note.id;
        
        // Content
        const content = document.createElement('div');
        content.className = 'note-content';
        content.textContent = note.content;
        div.appendChild(content);
        
        // Timestamp and category
        const meta = document.createElement('div');
        meta.className = 'note-timestamp';
        let metaText = note.timestamp;
        if (note.category && note.category !== 'general') {
            metaText += ` • ${note.category}`;
        }
        if (note.source === 'ai') {
            metaText += ' • AI';
        }
        meta.textContent = metaText;
        div.appendChild(meta);
        
        // Actions
        const actions = document.createElement('div');
        actions.className = 'note-item-actions';
        
        // Pin button
        const pinBtn = document.createElement('button');
        pinBtn.innerHTML = note.pinned ? '<i class="fa-solid fa-thumbtack"></i>' : '<i class="fa-regular fa-thumbtack"></i>';
        pinBtn.title = note.pinned ? 'Unpin' : 'Pin';
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            updateNote(note.id, { pinned: !note.pinned });
        });
        actions.appendChild(pinBtn);
        
        // Complete button
        const completeBtn = document.createElement('button');
        completeBtn.innerHTML = note.completed ? '<i class="fa-solid fa-rotate-left"></i>' : '<i class="fa-solid fa-check"></i>';
        completeBtn.title = note.completed ? 'Restore' : 'Mark done';
        completeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            updateNote(note.id, { completed: !note.completed });
        });
        actions.appendChild(completeBtn);
        
        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
        deleteBtn.title = 'Delete';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteNote(note.id);
        });
        actions.appendChild(deleteBtn);
        
        div.appendChild(actions);
        
        return div;
    }
    
    function updateNote(noteId, updates) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'update_note',
                note_id: noteId,
                updates: updates
            }));
        }
    }
    
    function deleteNote(noteId) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'delete_note',
                note_id: noteId
            }));
        }
    }
    
    function addManualNote() {
        const content = manualNoteInput?.value.trim();
        if (!content) return;
        
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'add_note',
                content: content
            }));
            manualNoteInput.value = '';
        }
    }

    // ============================================
    // CHAT UI
    // ============================================
    
    function addSystemMessage(text) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message system';

        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'avatar';
        avatarDiv.innerHTML = '<i class="fa-solid fa-info"></i>';

        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'bubble';
        bubbleDiv.textContent = text;

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(bubbleDiv);

        chatContainer.appendChild(messageDiv);
        scrollToBottom();
    }

    function getTranscriptDisplayText(rawText, cleanText) {
        if (transcriptDisplayMode === 'clean' && cleanText) return cleanText;
        return rawText || '';
    }

    function upsertTranscriptMessage(data, { isUpdate }) {
        const id = data && data.id ? String(data.id) : null;
        const role = data && data.source ? data.source : 'user';
        const timestamp = data && typeof data.timestamp === 'string' ? data.timestamp : '';
        const rawText = data && typeof data.text === 'string' ? data.text : '';
        const speakerId = data && typeof data.speaker_id === 'string'
            ? data.speaker_id
            : (data && typeof data.speakerId === 'string' ? data.speakerId : '');
        const speakerLabel = data && typeof data.speaker_label === 'string'
            ? data.speaker_label
            : (data && typeof data.speakerLabel === 'string' ? data.speakerLabel : '');
        const hasCleanKey = data && (Object.prototype.hasOwnProperty.call(data, 'clean_text') || Object.prototype.hasOwnProperty.call(data, 'cleanText'));
        const cleanText = data && typeof data.clean_text === 'string'
            ? data.clean_text
            : (data && typeof data.cleanText === 'string' ? data.cleanText : '');

        if (!id) {
            addMessage(rawText, role, timestamp);
            return;
        }

        const existing = transcriptMessagesById.get(id);
        if (existing) {
            if (typeof rawText === 'string' && rawText) existing.rawText = rawText;
            if (hasCleanKey) existing.cleanText = (typeof cleanText === 'string' ? cleanText : '') || '';
            if (existing.textSpan) existing.textSpan.textContent = getTranscriptDisplayText(existing.rawText, existing.cleanText);
            if (existing.timeDiv && timestamp) existing.timeDiv.textContent = timestamp;
            if (typeof speakerId === 'string' && speakerId.trim()) existing.speakerId = speakerId.trim();
            if (typeof speakerLabel === 'string' && speakerLabel.trim()) {
                existing.senderLabel = speakerLabel.trim();
                if (existing.senderDiv && existing.role === 'third_party') existing.senderDiv.textContent = existing.senderLabel;
            }
            if (existing.senderDiv && existing.role === 'third_party' && existing.speakerId && !existing.renameBound) {
                existing.renameBound = true;
                existing.senderDiv.title = 'Click to rename speaker';
                existing.senderDiv.style.cursor = 'pointer';
                existing.senderDiv.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    requestRenameSpeaker(existing.speakerId, existing.senderDiv.textContent || '');
                });
            }
            return;
        }

        // If we get an update before the create, treat it as a create.
        const span = addMessage(getTranscriptDisplayText(rawText, cleanText), role, timestamp, { id, rawText, cleanText, speakerId, speakerLabel });
        // addMessage stores into transcriptMessagesById when id provided.
        if (!isUpdate) return;
        // For safety: avoid counting this as a new message if it's an update-only event.
    }

    function addMessage(text, role, timestamp, meta = null) {
        const normalizedRole = (() => {
            const r = (role || '').toString().trim().toLowerCase();
            if (r === 'loopback' || r === 'third-party' || r === 'third_party') return 'third_party';
            if (r === 'ai') return 'assistant';
            if (r === 'you') return 'user';
            return r || 'user';
        })();

        const cssClass =
            normalizedRole === 'assistant'
                ? 'assistant'
                : (normalizedRole === 'system' ? 'system' : (normalizedRole === 'third_party' ? 'third-party' : 'user'));

        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${cssClass}`;

        const avatarDiv = document.createElement('div');
        avatarDiv.className = 'avatar';
        
        if (normalizedRole === 'assistant') {
            avatarDiv.innerHTML = '<i class="fa-solid fa-robot"></i>';
        } else if (normalizedRole === 'third_party') {
            avatarDiv.innerHTML = '<i class="fa-solid fa-desktop"></i>';
        } else if (normalizedRole === 'system') {
            avatarDiv.innerHTML = '<i class="fa-solid fa-info"></i>';
        } else {
            avatarDiv.innerHTML = '<i class="fa-solid fa-user"></i>';
        }

        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'bubble';

        if (normalizedRole !== 'system') {
            const senderDiv = document.createElement('div');
            senderDiv.className = 'sender';
            const requestedSpeaker = (meta && typeof meta.speakerLabel === 'string') ? meta.speakerLabel.trim() : '';
            if (normalizedRole === 'assistant') senderDiv.textContent = 'AI';
            else if (normalizedRole === 'third_party') senderDiv.textContent = requestedSpeaker || 'Third-Party';
            else senderDiv.textContent = 'You';
            bubbleDiv.appendChild(senderDiv);
        }

        const textSpan = document.createElement('span');
        textSpan.className = 'content-text';
        textSpan.textContent = text;
        bubbleDiv.appendChild(textSpan);

        let timeDiv = null;
        if (timestamp) {
            timeDiv = document.createElement('div');
            timeDiv.className = 'timestamp';
            timeDiv.textContent = timestamp;
            bubbleDiv.appendChild(timeDiv);
        }

        messageDiv.appendChild(avatarDiv);
        messageDiv.appendChild(bubbleDiv);

        chatContainer.appendChild(messageDiv);
        scrollToBottom();

        const id = meta && meta.id ? String(meta.id) : null;
        if (id) {
            messageDiv.dataset.transcriptId = id;
            const senderDiv = messageDiv.querySelector('.sender');
            const senderLabel = senderDiv ? senderDiv.textContent : '';
            const speakerId = (meta && typeof meta.speakerId === 'string') ? meta.speakerId.trim() : '';
            if (senderDiv && normalizedRole === 'third_party' && speakerId) {
                senderDiv.title = 'Click to rename speaker';
                senderDiv.style.cursor = 'pointer';
                senderDiv.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    requestRenameSpeaker(speakerId, senderDiv.textContent || '');
                });
            }
            transcriptMessagesById.set(id, {
                rawText: (meta.rawText ?? text) || '',
                cleanText: (meta.cleanText ?? '') || '',
                textSpan,
                timeDiv,
                senderDiv,
                senderLabel,
                speakerId: speakerId || null,
                renameBound: !!(senderDiv && normalizedRole === 'third_party' && speakerId),
                role: normalizedRole,
            });
        }

        return textSpan;
    }

    let currentAssistantTextSpan = null;
    let pendingAssistantText = '';
    let assistantFlushRaf = null;

    function appendToLastAssistantMessage(text) {
        pendingAssistantText += (text || '');
        scheduleAssistantFlush();
    }

    function scheduleAssistantFlush() {
        if (assistantFlushRaf) return;
        assistantFlushRaf = requestAnimationFrame(() => {
            assistantFlushRaf = null;
            flushAssistantPending();
        });
    }

    function flushAssistantPending() {
        if (!pendingAssistantText) return;

        if (!currentAssistantTextSpan) {
            const msgs = chatContainer.querySelectorAll('.message.assistant .bubble .content-text');
            if (msgs.length > 0) {
                currentAssistantTextSpan = msgs[msgs.length - 1];
            }
        }

        if (!currentAssistantTextSpan) {
            currentAssistantTextSpan = addMessage("", 'assistant', "");
        }

        currentAssistantTextSpan.textContent += pendingAssistantText;
        pendingAssistantText = '';

        if (currentAssistantTextSpan) {
            scrollToBottom();
        }
    }

    function updateSpeakerLabels(speakerId, speakerLabel) {
        const sid = String(speakerId || '').trim();
        if (!sid) return;
        const label = String(speakerLabel || '').trim();
        if (!label) return;
        for (const v of transcriptMessagesById.values()) {
            if (!v || v.role !== 'third_party') continue;
            if (String(v.speakerId || '').trim() !== sid) continue;
            v.senderLabel = label;
            if (v.senderDiv) v.senderDiv.textContent = label;
        }
    }

    function requestRenameSpeaker(speakerId, currentLabel) {
        const sid = String(speakerId || '').trim();
        if (!sid) return;
        const initial = String(currentLabel || '').trim();
        const next = prompt('Rename speaker (leave blank to reset):', initial);
        if (next === null) return;

        if (!socket || socket.readyState !== WebSocket.OPEN) {
            notify('error', 'Not connected.', { durationMs: 2500 });
            return;
        }

        socket.send(JSON.stringify({ type: 'rename_speaker', speaker_id: sid, name: next }));
    }

    function setTranscriptDisplayMode(mode) {
        transcriptDisplayMode = (mode === 'clean') ? 'clean' : 'raw';
        for (const v of transcriptMessagesById.values()) {
            if (v?.textSpan) v.textSpan.textContent = getTranscriptDisplayText(v.rawText, v.cleanText);
        }
    }

    function syncTranscriptControls() {
        const transcriptDisplayEl = document.getElementById('setting-transcript-display');
        if (transcriptDisplayEl) {
            const enabled = transcriptAiMode !== 'off';
            transcriptDisplayEl.disabled = !enabled;
            if (!enabled) {
                transcriptDisplayEl.value = 'raw';
                setTranscriptDisplayMode('raw');
            }
        }
    }

    function scrollToBottom() {
        chatContainer.scrollTop = chatContainer.scrollHeight;
    }

    function normalizeJsonValueForCompare(value) {
        if (value === null || value === undefined) return null;
        if (Array.isArray(value)) return value.map(normalizeJsonValueForCompare);
        if (typeof value !== 'object') return value;

        const out = {};
        Object.keys(value).sort().forEach(k => {
            out[k] = normalizeJsonValueForCompare(value[k]);
        });
        return out;
    }

    function stableStringifyForCompare(value) {
        try {
            return JSON.stringify(normalizeJsonValueForCompare(value));
        } catch (e) {
            return '';
        }
    }

    function getSelectedMicDeviceForCompareAndSave() {
        const selected = String(micSelect?.value || '').trim();
        if (selected) return selected;
        const pending = String(pendingMicDevice || '').trim();
        return pending || null;
    }

    function getSelectedLoopbackDeviceForCompareAndSave() {
        const selected = String(loopbackSelect?.value || '').trim();
        if (selected) return selected;
        const pending = String(pendingLoopbackDevice || '').trim();
        return pending || null;
    }

    function extraHeadersCompareToken() {
        const extraHeadersEl = document.getElementById('setting-extra-headers');
        const raw = String(extraHeadersEl?.value || '').trim();
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Extra headers must be a JSON object');
            }
            return normalizeJsonValueForCompare(parsed);
        } catch (e) {
            return { __invalid_json__: raw };
        }
    }

    function getSettingsFormStateForCompare() {
        return {
            // API
            api_provider: document.getElementById('setting-provider')?.value,
            api_key: document.getElementById('setting-api-key')?.value,
            base_url: document.getElementById('setting-base-url')?.value,
            model: document.getElementById('setting-model')?.value,
            api_extra_headers: extraHeadersCompareToken(),

            // Assistant
            system_prompt: document.getElementById('setting-prompt')?.value,
            auto_respond: !!document.getElementById('setting-auto-respond')?.checked,
            web_search_enabled: !!document.getElementById('setting-web-search')?.checked,
            ai_min_interval_seconds: parseFloat(document.getElementById('setting-ai-interval')?.value) || 8,

            // Notes
            notes_enabled: !!document.getElementById('setting-notes-enabled')?.checked,
            notes_interval_seconds: parseInt(document.getElementById('setting-notes-interval')?.value) || 30,
            notes_on_interaction_only: !!document.getElementById('setting-notes-interaction-only')?.checked,
            notes_format: document.getElementById('setting-notes-format')?.value,
            notes_prompt: document.getElementById('setting-notes-prompt')?.value,
            notes_context_messages: parseInt(document.getElementById('setting-notes-context')?.value) || 10,
            notes_smart_enabled: !!document.getElementById('setting-notes-smart')?.checked,
            notes_smart_max_ai_notes: parseInt(document.getElementById('setting-notes-max-ai')?.value) || 18,
            notes_extract_decisions: !!document.getElementById('setting-notes-decisions')?.checked,
            notes_extract_actions: !!document.getElementById('setting-notes-actions')?.checked,
            notes_extract_risks: !!document.getElementById('setting-notes-risks')?.checked,
            notes_extract_facts: !!document.getElementById('setting-notes-facts')?.checked,

            // Transcript
            transcript_merge_enabled: !!document.getElementById('setting-transcript-merge')?.checked,
            transcript_merge_window_seconds: parseFloat(document.getElementById('setting-transcript-merge-window')?.value) || 4,
            transcript_ai_mode: document.getElementById('setting-transcript-ai-mode')?.value,
            transcript_display_mode: document.getElementById('setting-transcript-display')?.value,

            // Audio
            mic_device: getSelectedMicDeviceForCompareAndSave(),
            loopback_device: getSelectedLoopbackDeviceForCompareAndSave(),
            speech_vad_enabled: !!document.getElementById('setting-vad-enabled')?.checked,
            speech_vad_threshold: parseFloat(document.getElementById('setting-vad-threshold')?.value) || 0.5,
            speech_denoise_enabled: !!document.getElementById('setting-denoise-enabled')?.checked,
            speech_denoise_strength: parseFloat(document.getElementById('setting-denoise-strength')?.value) || 0.8,
            whisper_vad_filter: !!document.getElementById('setting-whisper-vad')?.checked,
            whisper_model_size: document.getElementById('setting-whisper-model-size')?.value,
            whisper_device: document.getElementById('setting-whisper-device')?.value,
            speaker_diarization_enabled: !!document.getElementById('setting-speaker-diarization')?.checked,

            // Policy
            policy_enabled: !!document.getElementById('setting-policy-enabled')?.checked,
            policy_prompt: document.getElementById('setting-policy-prompt')?.value,
            policy_show_withheld: !!document.getElementById('setting-policy-show-withheld')?.checked,
            policy_min_interval_seconds: parseFloat(document.getElementById('setting-policy-interval')?.value) || 4,

            // Advanced
            autosave_enabled: !!document.getElementById('setting-autosave')?.checked,
            session_timeout_minutes: parseInt(document.getElementById('setting-session-timeout')?.value) || 30,
            verbose_logging: !!document.getElementById('setting-verbose')?.checked,
        };
    }

    function markSettingsBaselineNow() {
        settingsBaseline = stableStringifyForCompare(getSettingsFormStateForCompare());
    }

    function hasUnsavedSettingsChanges() {
        if (!settingsBaseline) return false;
        const now = stableStringifyForCompare(getSettingsFormStateForCompare());
        return now !== settingsBaseline;
    }

    async function confirmSaveSettingsBeforeLeavingTab() {
        if (!hasUnsavedSettingsChanges()) return true;

        const save = confirm('You have unsaved Settings changes.\n\nSave changes before leaving?');
        if (save) {
            const ok = await saveSettings();
            return !!ok;
        }

        const discard = confirm('Discard your unsaved changes and leave Settings?');
        if (!discard) return false;

        // Best-effort revert UI back to last saved settings so returning to Settings is consistent.
        try {
            await loadSettings();
        } catch (e) {
            // ignore
        }
        return true;
    }

    // ============================================
    // LIVE SESSION CONTEXT
    // ============================================

    let sessionContextDraft = '';
    let sessionContextSendTimer = null;
    let isContextExpanded = false;

    function setContextExpanded(expanded) {
        isContextExpanded = !!expanded;
        if (sessionContextBody) {
            if (isContextExpanded) sessionContextBody.classList.remove('hidden');
            else sessionContextBody.classList.add('hidden');
        }
        if (contextToggleBtn) {
            contextToggleBtn.classList.toggle('expanded', isContextExpanded);
        }
    }

    function setSessionContextText(text) {
        const value = (typeof text === 'string' ? text : '').trim();
        sessionContextDraft = value;
        if (sessionContextInput && sessionContextInput.value !== value) {
            sessionContextInput.value = value;
        }
        if (sessionContextSubtitle) {
            sessionContextSubtitle.textContent = value ? 'Session context (used by AI)' : 'Optional session context (used by AI)';
        }
        if (value && !isContextExpanded) setContextExpanded(true);
        if (!value && isContextExpanded) setContextExpanded(false);
    }

    function sendSessionContextNow() {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(JSON.stringify({ type: 'set_session_context', context: sessionContextDraft }));
    }

    function scheduleSessionContextSend() {
        if (sessionContextSendTimer) clearTimeout(sessionContextSendTimer);
        sessionContextSendTimer = setTimeout(() => {
            sessionContextSendTimer = null;
            sendSessionContextNow();
        }, 550);
    }

    sessionContextInput?.addEventListener('input', () => {
        sessionContextDraft = (sessionContextInput.value || '').trim();
        scheduleSessionContextSend();
    });

    contextToggleBtn?.addEventListener('click', () => {
        setContextExpanded(!isContextExpanded);
    });

    contextClearBtn?.addEventListener('click', () => {
        setSessionContextText('');
        sendSessionContextNow();
        notify('info', 'Context cleared', { durationMs: 1500, dedupeKey: 'ctx-cleared' });
    });

    // default collapsed
    setContextExpanded(false);

    // ============================================
    // TAB NAVIGATION
    // ============================================
    
    const tabTitles = {
        chat: { title: 'Current Session', subtitle: 'Real-time transcription & AI analysis' },
        notes: { title: 'Notes', subtitle: 'Manage AI-generated and manual notes' },
        history: { title: 'History', subtitle: 'Browse past sessions' },
        settings: { title: 'Settings', subtitle: 'Configure your AI assistant' }
    };

    function applyTabSelection(tabName, btn) {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

        btn?.classList.add('active');
        const tab = document.getElementById(`tab-${tabName}`);
        if (tab) tab.classList.add('active');

        // Update header
        const info = tabTitles[tabName] || {};
        if (tabTitle) tabTitle.textContent = info.title || tabName;
        if (tabSubtitle) tabSubtitle.textContent = info.subtitle || '';

        activeTabName = tabName;

        // Render notes when switching to notes tab
        if (tabName === 'notes') {
            renderNotes();
        }
        // Load history when switching to history tab
        if (tabName === 'history') {
            loadHistory();
        }
    }

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', async () => {
            const tabName = btn.dataset.tab;
            if (!tabName || tabName === activeTabName) return;

            if (activeTabName === 'settings' && tabName !== 'settings') {
                const okToLeave = await confirmSaveSettingsBeforeLeavingTab();
                if (!okToLeave) return;
            }

            applyTabSelection(tabName, btn);
        });
    });

    // ============================================
    // SETTINGS NAVIGATION
    // ============================================
    
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.settings-panel').forEach(p => p.classList.add('hidden'));

            btn.classList.add('active');
            const section = btn.dataset.settingsSection;
            const panel = document.getElementById(`settings-${section}`);
            if (panel) panel.classList.remove('hidden');
        });
    });

    // Notes filter buttons
    document.querySelectorAll('.notes-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.notes-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderNotes();
        });
    });

    // ============================================
    // MANUAL INPUT
    // ============================================
    
    function sendManualMessage() {
        const text = manualInput.value.trim();
        if (!text) return;

        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'manual_input',
                text: text
            }));
        }

        manualInput.value = '';
    }

    sendBtn?.addEventListener('click', sendManualMessage);
    manualInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendManualMessage();
    });

    // Manual notes
    addNoteBtn?.addEventListener('click', addManualNote);
    manualNoteInput?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addManualNote();
    });

    // Notes toolbar
    notesRefreshBtn?.addEventListener('click', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'refresh_notes' }));
            notify('info', 'Generating notes...', { durationMs: 2000 });
        }
    });

    notesClearBtn?.addEventListener('click', () => {
        if (confirm('Clear all notes for this session?')) {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'clear_notes' }));
            }
        }
    });

    notesExportBtn?.addEventListener('click', exportNotes);
    document.getElementById('export-all-notes-btn')?.addEventListener('click', exportNotes);

    function exportNotes() {
        if (allNotes.length === 0) {
            notify('warning', 'No notes to export');
            return;
        }
        
        let markdown = `# Session Notes\n\n`;
        markdown += `**Session:** ${currentSessionId || 'Unknown'}\n`;
        markdown += `**Date:** ${new Date().toLocaleString()}\n\n`;
        markdown += `---\n\n`;
        
        const pinnedNotes = allNotes.filter(n => n.pinned);
        const regularNotes = allNotes.filter(n => !n.pinned && !n.completed);
        const completedNotes = allNotes.filter(n => n.completed);
        
        if (pinnedNotes.length > 0) {
            markdown += `## 📌 Pinned\n\n`;
            pinnedNotes.forEach(n => {
                markdown += `- ${n.content}\n`;
            });
            markdown += `\n`;
        }
        
        if (regularNotes.length > 0) {
            markdown += `## Notes\n\n`;
            regularNotes.forEach(n => {
                const prefix = n.source === 'ai' ? '🤖 ' : '';
                markdown += `- ${prefix}${n.content}\n`;
            });
            markdown += `\n`;
        }
        
        if (completedNotes.length > 0) {
            markdown += `## ✓ Completed\n\n`;
            completedNotes.forEach(n => {
                markdown += `- ~~${n.content}~~\n`;
            });
        }
        
        const blob = new Blob([markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `notes-${currentSessionId || 'session'}.md`;
        a.click();
        URL.revokeObjectURL(url);
        
        notify('success', 'Notes exported');
    }

    // ============================================
    // TOGGLE BUTTONS
    // ============================================
    
    aiToggleBtn?.addEventListener('click', async () => {
        isAiEnabled = !isAiEnabled;

        if (isAiEnabled) {
            aiToggleBtn.classList.add('active');
        } else {
            aiToggleBtn.classList.remove('active');
        }

        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ai_enabled: isAiEnabled })
            });
            notify('info', isAiEnabled ? 'AI enabled' : 'AI disabled', { durationMs: 1500 });

            if (isAiEnabled && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'ai_run_now' }));
            }
        } catch (e) {
            console.error("Failed to update AI settings", e);
        }
    });

    micToggleBtn?.addEventListener('click', async () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            notify('warning', 'Not connected to server.');
            isMicEnabled = false;
            micToggleBtn.classList.remove('active');
            return;
        }

        isMicEnabled = !isMicEnabled;
        if (isMicEnabled) {
            micToggleBtn.classList.add('active');
        } else {
            micToggleBtn.classList.remove('active');
        }

        try {
            // Include mic_device so the backend knows which device to use
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    mic_enabled: isMicEnabled,
                    mic_device: micSelect?.value || null
                })
            });

            socket.send(JSON.stringify({ type: 'stop_audio' }));
            if (isMicEnabled || isSystemAudioEnabled) {
                socket.send(JSON.stringify({ type: 'start_audio' }));
            }
        } catch (e) {
            console.error('Failed to update mic settings', e);
            notify('error', 'Failed to update mic setting.', { durationMs: 4200 });
        }
    });

    systemAudioToggleBtn?.addEventListener('click', async () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            notify('warning', 'Not connected to server.');
            isSystemAudioEnabled = false;
            systemAudioToggleBtn.classList.remove('active');
            return;
        }

        isSystemAudioEnabled = !isSystemAudioEnabled;
        if (isSystemAudioEnabled) {
            systemAudioToggleBtn.classList.add('active');
        } else {
            systemAudioToggleBtn.classList.remove('active');
        }

        try {
            // Include loopback_device so the backend knows which device to use
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    loopback_enabled: isSystemAudioEnabled,
                    loopback_device: loopbackSelect?.value || null
                })
            });

            socket.send(JSON.stringify({ type: 'stop_audio' }));
            if (isMicEnabled || isSystemAudioEnabled) {
                socket.send(JSON.stringify({ type: 'start_audio' }));
            }
        } catch (e) {
            console.error('Failed to update system audio settings', e);
            notify('error', 'Failed to update system audio setting.', { durationMs: 4200 });
        }
    });

    // New Session button
    newSessionBtn?.addEventListener('click', () => {
        if (confirm('Start a new session? Current session will be saved.')) {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'new_session' }));
                allNotes = [];
                renderNotes();
                notify('success', 'New session started');
            }
        }
    });

    // ============================================
    // SETTINGS RANGE SLIDERS
    // ============================================
    
    function setupRangeSlider(inputId, valueId, suffix = '', transform = v => v) {
        const input = document.getElementById(inputId);
        const valueEl = document.getElementById(valueId);
        if (input && valueEl) {
            input.addEventListener('input', () => {
                valueEl.textContent = transform(input.value) + suffix;
            });
        }
    }
    
    setupRangeSlider('setting-ai-interval', 'ai-interval-value', 's');
    setupRangeSlider('setting-notes-interval', 'notes-interval-value', 's');
    setupRangeSlider('setting-notes-context', 'notes-context-value');
    setupRangeSlider('setting-transcript-merge-window', 'transcript-merge-window-value', 's');
    setupRangeSlider('setting-vad-threshold', 'vad-threshold-value', '', v => parseFloat(v).toFixed(2));
    setupRangeSlider('setting-denoise-strength', 'denoise-strength-value');
    setupRangeSlider('setting-policy-interval', 'policy-interval-value', 's');
    setupRangeSlider('setting-session-timeout', 'session-timeout-value', 'm');

    // ============================================
    // DEVICE LOADING
    // ============================================
    
    async function loadDevices() {
        try {
            const res = await fetch('/api/devices');
            const payload = await res.json();

            const microphones = Array.isArray(payload) ? payload : (payload.microphones || []);
            const loopbacks = Array.isArray(payload) ? [] : (payload.loopbacks || []);

            function setSelectValueCompat(selectEl, desired) {
                if (!selectEl) return;
                const want = String(desired || '').trim();
                if (!want) return;

                // Try direct match (new configs use device id/index).
                selectEl.value = want;
                if (selectEl.value === want) return;

                // Back-compat: old configs stored device name; match by displayed text.
                const opts = Array.from(selectEl.options || []);
                const match = opts.find(o => String(o.textContent || '').trim() === want)
                    || opts.find(o => String(o.textContent || '').trim().startsWith(want + ' (#'));
                if (match) selectEl.value = match.value;
            }

            if (micSelect) {
                micSelect.innerHTML = '<option value="">(Select microphone)</option>';
                const micNameCounts = new Map();
                microphones.forEach(d => {
                    const k = String(d?.name || '').trim().toLowerCase();
                    if (!k) return;
                    micNameCounts.set(k, (micNameCounts.get(k) || 0) + 1);
                });
                microphones.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = (d && (d.id ?? d.name)) ? String(d.id ?? d.name) : '';
                    const name = String(d?.name || '').trim();
                    const k = name.toLowerCase();
                    const dup = name && (micNameCounts.get(k) || 0) > 1;
                    opt.textContent = dup ? `${name} (#${d.id ?? ''})` : name;
                    micSelect.appendChild(opt);
                });

                if (pendingMicDevice) {
                    setSelectValueCompat(micSelect, pendingMicDevice);
                    pendingMicDevice = null;
                }
            }

            if (loopbackSelect) {
                loopbackSelect.innerHTML = '<option value="">(Auto / Default)</option>';
                const loopNameCounts = new Map();
                loopbacks.forEach(d => {
                    const k = String(d?.name || '').trim().toLowerCase();
                    if (!k) return;
                    loopNameCounts.set(k, (loopNameCounts.get(k) || 0) + 1);
                });
                loopbacks.forEach(d => {
                    const opt = document.createElement('option');
                    opt.value = (d && (d.id ?? d.name)) ? String(d.id ?? d.name) : '';
                    const name = String(d?.name || '').trim();
                    const k = name.toLowerCase();
                    const dup = name && (loopNameCounts.get(k) || 0) > 1;
                    opt.textContent = dup ? `${name} (#${d.id ?? ''})` : name;
                    loopbackSelect.appendChild(opt);
                });

                if (pendingLoopbackDevice !== null) {
                    setSelectValueCompat(loopbackSelect, pendingLoopbackDevice || '');
                    pendingLoopbackDevice = null;
                }
            }
        } catch (e) {
            console.error("Failed to load devices", e);
        }
    }

    // ============================================
    // SETTINGS LOAD/SAVE
    // ============================================

    const providerPresets = {
        openrouter: {
            base_url: 'https://openrouter.ai/api/v1',
            model: 'openai/gpt-4o-mini',
        },
        openai: {
            base_url: 'https://api.openai.com/v1',
            model: 'gpt-4o-mini',
        },
        canopywave: {
            base_url: 'https://inference.canopywave.io/v1',
            model: 'deepseek/deepseek-chat-v3.1',
        },
        huggingface: {
            base_url: 'https://router.huggingface.co/v1',
            model: 'HuggingFaceTB/SmolLM2-1.7B-Instruct:groq',
        },
        custom: {},
    };

    function normalizeProvider(p) {
        const v = String(p || '').trim().toLowerCase().replace(/[-\\s]+/g, '_');
        if (v === 'canopy' || v === 'canopy_wave') return 'canopywave';
        if (v === 'hugging_face' || v === 'hf') return 'huggingface';
        if (v === 'open_router') return 'openrouter';
        if (v in providerPresets) return v;
        return 'custom';
    }

    function inferProviderFromBaseUrl(baseUrl) {
        const u = String(baseUrl || '').trim().toLowerCase();
        if (!u) return 'custom';
        if (u.includes('openrouter.ai')) return 'openrouter';
        if (u.includes('api.openai.com')) return 'openai';
        if (u.includes('inference.canopywave.io')) return 'canopywave';
        if (u.includes('router.huggingface.co') || u.includes('api-inference.huggingface.co')) return 'huggingface';
        return 'custom';
    }

    function formatExtraHeaders(val) {
        if (!val || typeof val !== 'object') return '';
        try {
            return JSON.stringify(val, null, 2);
        } catch (e) {
            return '';
        }
    }

    function parseExtraHeadersOrNull() {
        const extraHeadersEl = document.getElementById('setting-extra-headers');
        const raw = (extraHeadersEl?.value || '').trim();
        if (!raw) return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('Extra headers must be a JSON object');
            }
            return parsed;
        } catch (e) {
            notify('error', `Extra headers JSON is invalid: ${e?.message || e}`, { durationMs: 6000 });
            return null;
        }
    }

    function applyProviderPreset(provider) {
        const p = normalizeProvider(provider);
        const preset = providerPresets[p] || {};
        const baseUrlEl = document.getElementById('setting-base-url');
        const modelEl = document.getElementById('setting-model');
        if (baseUrlEl && preset.base_url) baseUrlEl.value = preset.base_url;
        if (modelEl && preset.model) modelEl.value = preset.model;
    }
    
    async function loadSettings() {
        try {
            const res = await fetch('/api/settings');
            if (!res.ok) return;
            const data = await res.json();
            const cfg = data && data.config ? data.config : null;
            if (!cfg) return;

            // API settings
            const providerEl = document.getElementById('setting-provider');
            const apiKeyEl = document.getElementById('setting-api-key');
            const baseUrlEl = document.getElementById('setting-base-url');
            const modelEl = document.getElementById('setting-model');
            const extraHeadersEl = document.getElementById('setting-extra-headers');
            if (providerEl) providerEl.value = normalizeProvider(cfg.api_provider || inferProviderFromBaseUrl(cfg.base_url));
            if (apiKeyEl) apiKeyEl.value = cfg.api_key || '';
            if (baseUrlEl) baseUrlEl.value = cfg.base_url || '';
            if (modelEl) modelEl.value = cfg.model || '';
            if (extraHeadersEl) extraHeadersEl.value = formatExtraHeaders(cfg.api_extra_headers);

            // Assistant settings
            const promptEl = document.getElementById('setting-prompt');
            const autoRespondEl = document.getElementById('setting-auto-respond');
            const webSearchEl = document.getElementById('setting-web-search');
            const aiIntervalEl = document.getElementById('setting-ai-interval');
            if (promptEl) promptEl.value = cfg.system_prompt || '';
            if (autoRespondEl) autoRespondEl.checked = !!cfg.auto_respond;
            if (webSearchEl) webSearchEl.checked = !!cfg.web_search_enabled;
            if (aiIntervalEl) {
                aiIntervalEl.value = cfg.ai_min_interval_seconds || 8;
                document.getElementById('ai-interval-value')?.textContent && (document.getElementById('ai-interval-value').textContent = aiIntervalEl.value + 's');
            }

            // Notes settings
            const notesEnabledEl = document.getElementById('setting-notes-enabled');
            const notesIntervalEl = document.getElementById('setting-notes-interval');
            const notesInteractionOnlyEl = document.getElementById('setting-notes-interaction-only');
            const notesFormatEl = document.getElementById('setting-notes-format');
            const notesPromptEl = document.getElementById('setting-notes-prompt');
            const notesContextEl = document.getElementById('setting-notes-context');
            const notesSmartEl = document.getElementById('setting-notes-smart');
            const notesMaxAiEl = document.getElementById('setting-notes-max-ai');
            const notesDecisionsEl = document.getElementById('setting-notes-decisions');
            const notesActionsEl = document.getElementById('setting-notes-actions');
            const notesRisksEl = document.getElementById('setting-notes-risks');
            const notesFactsEl = document.getElementById('setting-notes-facts');
            
            if (notesEnabledEl) notesEnabledEl.checked = cfg.notes_enabled !== false;
            if (notesIntervalEl) {
                notesIntervalEl.value = cfg.notes_interval_seconds || 30;
                document.getElementById('notes-interval-value')?.textContent && (document.getElementById('notes-interval-value').textContent = notesIntervalEl.value + 's');
            }
            if (notesInteractionOnlyEl) notesInteractionOnlyEl.checked = cfg.notes_on_interaction_only === true;
            if (notesFormatEl) notesFormatEl.value = cfg.notes_format || 'bullets';
            if (notesPromptEl) notesPromptEl.value = cfg.notes_prompt || '';
            if (notesContextEl) {
                notesContextEl.value = cfg.notes_context_messages || 10;
                document.getElementById('notes-context-value')?.textContent && (document.getElementById('notes-context-value').textContent = notesContextEl.value);
            }
            if (notesSmartEl) notesSmartEl.checked = cfg.notes_smart_enabled !== false;
            if (notesMaxAiEl) {
                notesMaxAiEl.value = cfg.notes_smart_max_ai_notes || 18;
                document.getElementById('notes-max-ai-value')?.textContent && (document.getElementById('notes-max-ai-value').textContent = notesMaxAiEl.value);
            }
            if (notesDecisionsEl) notesDecisionsEl.checked = cfg.notes_extract_decisions !== false;
            if (notesActionsEl) notesActionsEl.checked = cfg.notes_extract_actions !== false;
            if (notesRisksEl) notesRisksEl.checked = cfg.notes_extract_risks !== false;
            if (notesFactsEl) notesFactsEl.checked = cfg.notes_extract_facts !== false;

            // Transcript settings
            const transcriptMergeEl = document.getElementById('setting-transcript-merge');
            const transcriptMergeWindowEl = document.getElementById('setting-transcript-merge-window');
            const transcriptAiModeEl = document.getElementById('setting-transcript-ai-mode');
            const transcriptDisplayEl = document.getElementById('setting-transcript-display');

            if (transcriptMergeEl) transcriptMergeEl.checked = cfg.transcript_merge_enabled !== false;
            if (transcriptMergeWindowEl) {
                transcriptMergeWindowEl.value = cfg.transcript_merge_window_seconds ?? 4;
                document.getElementById('transcript-merge-window-value')?.textContent && (document.getElementById('transcript-merge-window-value').textContent = transcriptMergeWindowEl.value + 's');
            }
            if (transcriptAiModeEl) {
                const mode = (cfg.transcript_ai_mode || (cfg.transcript_ai_cleanup_enabled ? 'cleanup' : 'off'));
                transcriptAiMode = (mode === 'paraphrase' || mode === 'cleanup') ? mode : 'off';
                transcriptAiModeEl.value = transcriptAiMode;
            }
            if (transcriptDisplayEl) transcriptDisplayEl.value = (cfg.transcript_display_mode === 'clean') ? 'clean' : 'raw';
            setTranscriptDisplayMode(cfg.transcript_display_mode === 'clean' ? 'clean' : 'raw');
            syncTranscriptControls();

            // Audio settings
            const vadEnabledEl = document.getElementById('setting-vad-enabled');
            const vadThresholdEl = document.getElementById('setting-vad-threshold');
            const denoiseEnabledEl = document.getElementById('setting-denoise-enabled');
            const denoiseStrengthEl = document.getElementById('setting-denoise-strength');
            const whisperModelSizeEl = document.getElementById('setting-whisper-model-size');
            const whisperDeviceEl = document.getElementById('setting-whisper-device');
            const speakerDiarizationEl = document.getElementById('setting-speaker-diarization');
            const whisperVadEl = document.getElementById('setting-whisper-vad');
            
            if (vadEnabledEl) vadEnabledEl.checked = cfg.speech_vad_enabled !== false;
            if (vadThresholdEl) {
                vadThresholdEl.value = cfg.speech_vad_threshold || 0.5;
                document.getElementById('vad-threshold-value')?.textContent && (document.getElementById('vad-threshold-value').textContent = parseFloat(vadThresholdEl.value).toFixed(2));
            }
            if (denoiseEnabledEl) denoiseEnabledEl.checked = !!cfg.speech_denoise_enabled;
            if (denoiseStrengthEl) {
                denoiseStrengthEl.value = cfg.speech_denoise_strength || 0.8;
                document.getElementById('denoise-strength-value')?.textContent && (document.getElementById('denoise-strength-value').textContent = denoiseStrengthEl.value);
            }
            if (whisperModelSizeEl) {
                const desired = String(cfg.whisper_model_size || 'tiny').trim() || 'tiny';
                const hasOption = Array.from(whisperModelSizeEl.options || []).some(o => o?.value === desired);
                if (!hasOption) {
                    const opt = document.createElement('option');
                    opt.value = desired;
                    opt.textContent = `${desired} (custom)`;
                    whisperModelSizeEl.appendChild(opt);
                }
                whisperModelSizeEl.value = desired;
            }
            if (whisperDeviceEl) {
                const d = String(cfg.whisper_device || 'cpu').trim().toLowerCase();
                whisperDeviceEl.value = (d === 'cuda' || d === 'gpu') ? 'cuda' : 'cpu';
            }
            if (speakerDiarizationEl) speakerDiarizationEl.checked = !!cfg.speaker_diarization_enabled;
            if (whisperVadEl) whisperVadEl.checked = cfg.whisper_vad_filter !== false;

            // Policy settings
            const policyEnabledEl = document.getElementById('setting-policy-enabled');
            const policyPromptEl = document.getElementById('setting-policy-prompt');
            const policyShowWithheldEl = document.getElementById('setting-policy-show-withheld');
            const policyIntervalEl = document.getElementById('setting-policy-interval');
            
            if (policyEnabledEl) policyEnabledEl.checked = cfg.policy_enabled !== false;
            if (policyPromptEl) policyPromptEl.value = cfg.policy_prompt || '';
            if (policyShowWithheldEl) policyShowWithheldEl.checked = cfg.policy_show_withheld !== false;
            if (policyIntervalEl) {
                policyIntervalEl.value = cfg.policy_min_interval_seconds || 4;
                document.getElementById('policy-interval-value')?.textContent && (document.getElementById('policy-interval-value').textContent = policyIntervalEl.value + 's');
            }

            // Advanced settings
            const autosaveEl = document.getElementById('setting-autosave');
            const sessionTimeoutEl = document.getElementById('setting-session-timeout');
            const verboseEl = document.getElementById('setting-verbose');
            
            if (autosaveEl) autosaveEl.checked = cfg.autosave_enabled !== false;
            if (sessionTimeoutEl) {
                sessionTimeoutEl.value = cfg.session_timeout_minutes || 30;
                document.getElementById('session-timeout-value')?.textContent && (document.getElementById('session-timeout-value').textContent = sessionTimeoutEl.value + 'm');
            }
            if (verboseEl) verboseEl.checked = !!cfg.verbose_logging;

            // Toggle states
            isAiEnabled = cfg.ai_enabled === true;
            if (isAiEnabled) aiToggleBtn?.classList.add('active');
            else aiToggleBtn?.classList.remove('active');

            isMicEnabled = cfg.mic_enabled === true;
            if (isMicEnabled) micToggleBtn?.classList.add('active');
            else micToggleBtn?.classList.remove('active');

            isSystemAudioEnabled = !!cfg.loopback_enabled;
            if (isSystemAudioEnabled) systemAudioToggleBtn?.classList.add('active');
            else systemAudioToggleBtn?.classList.remove('active');

            // Device selection
            pendingMicDevice = cfg.mic_device || null;
            if (pendingMicDevice && micSelect) micSelect.value = pendingMicDevice;

            pendingLoopbackDevice = cfg.loopback_device || '';
            if (loopbackSelect) loopbackSelect.value = pendingLoopbackDevice;

            markSettingsBaselineNow();
            settingsLoaded = true;
            tryAutoStartAudio();
            loadPresets();
        } catch (e) {
            console.error('Failed to load settings', e);
        }
    }

    document.getElementById('save-settings')?.addEventListener('click', saveSettings);

    document.getElementById('setting-provider')?.addEventListener('change', (e) => {
        applyProviderPreset(e?.target?.value);
    });

    document.getElementById('setting-transcript-ai-mode')?.addEventListener('change', (e) => {
        transcriptAiMode = String(e?.target?.value || 'off');
        syncTranscriptControls();
    });

    document.getElementById('setting-transcript-display')?.addEventListener('change', (e) => {
        setTranscriptDisplayMode(String(e?.target?.value || 'raw'));
    });

    // Reset + presets
    const presetSelectEl = document.getElementById('preset-select');
    const presetNameEl = document.getElementById('preset-name');
    const presetIncludeKeyEl = document.getElementById('preset-include-api-key');

    async function loadPresets() {
        if (!presetSelectEl) return;
        try {
            const res = await fetch('/api/presets');
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.status !== 'ok') return;
            const presets = Array.isArray(data.presets) ? data.presets : [];

            const current = presetSelectEl.value;
            presetSelectEl.innerHTML = '<option value=\"\">(Select preset)</option>';
            for (const p of presets) {
                const name = String(p?.name || '').trim();
                if (!name) continue;
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                presetSelectEl.appendChild(opt);
            }
            if (current) presetSelectEl.value = current;
        } catch (e) {
            console.error('Failed to load presets', e);
        }
    }

    async function applyPreset(name) {
        const presetName = String(name || '').trim();
        if (!presetName) return;

        const res = await fetch(`/api/presets/${encodeURIComponent(presetName)}/apply`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.status !== 'ok') {
            const msg = data.message || `HTTP ${res.status}`;
            notify('error', `Failed to apply preset: ${msg}`, { durationMs: 6000 });
            return;
        }

        notify('success', `Preset applied: ${presetName}`, { durationMs: 2500 });
        await loadSettings();

        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'stop_audio' }));
            if (isMicEnabled || isSystemAudioEnabled) {
                socket.send(JSON.stringify({ type: 'start_audio' }));
            }
        }
    }

    document.getElementById('preset-apply-btn')?.addEventListener('click', async () => {
        const name = presetSelectEl?.value;
        if (!name) {
            notify('warning', 'Select a preset first');
            return;
        }
        await applyPreset(name);
    });

    document.getElementById('preset-save-btn')?.addEventListener('click', async () => {
        const name = String(presetNameEl?.value || '').trim();
        if (!name) {
            notify('warning', 'Enter a preset name');
            return;
        }

        const includeKey = !!presetIncludeKeyEl?.checked;

        try {
            const res = await fetch('/api/presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, include_api_key: includeKey }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.status !== 'ok') {
                const msg = data.message || `HTTP ${res.status}`;
                notify('error', `Failed to save preset: ${msg}`, { durationMs: 6000 });
                return;
            }
            notify('success', `Preset saved: ${data.name || name}`, { durationMs: 2500 });
            presetNameEl && (presetNameEl.value = '');
            await loadPresets();
            if (presetSelectEl) presetSelectEl.value = String(data.name || name);
        } catch (e) {
            notify('error', `Failed to save preset: ${e?.message || e}`, { durationMs: 6000 });
        }
    });

    document.getElementById('preset-delete-btn')?.addEventListener('click', async () => {
        const name = presetSelectEl?.value;
        if (!name) {
            notify('warning', 'Select a preset first');
            return;
        }
        if (!confirm(`Delete preset \"${name}\"?`)) return;

        try {
            const res = await fetch(`/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.status !== 'ok') {
                const msg = data.message || `HTTP ${res.status}`;
                notify('error', `Failed to delete preset: ${msg}`, { durationMs: 6000 });
                return;
            }
            notify('success', `Preset deleted: ${name}`, { durationMs: 2500 });
            await loadPresets();
            if (presetSelectEl) presetSelectEl.value = '';
        } catch (e) {
            notify('error', `Failed to delete preset: ${e?.message || e}`, { durationMs: 6000 });
        }
    });

    document.getElementById('reset-settings')?.addEventListener('click', async () => {
        if (!confirm('Reset all settings to defaults?')) return;
        try {
            const res = await fetch('/api/settings/reset', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.status !== 'ok') {
                const msg = data.message || `HTTP ${res.status}`;
                notify('error', `Reset failed: ${msg}`, { durationMs: 6000 });
                return;
            }
            notify('success', 'Settings reset to defaults', { durationMs: 2500 });
            await loadSettings();

            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'stop_audio' }));
                if (isMicEnabled || isSystemAudioEnabled) {
                    socket.send(JSON.stringify({ type: 'start_audio' }));
                }
            }
        } catch (e) {
            notify('error', `Reset failed: ${e?.message || e}`, { durationMs: 6000 });
        }
    });

    async function saveSettings() {
        const extraHeaders = parseExtraHeadersOrNull();
        if (extraHeaders === null) return false;

        const cfg = {
            // API
            api_provider: document.getElementById('setting-provider')?.value,
            api_key: document.getElementById('setting-api-key')?.value,
            base_url: document.getElementById('setting-base-url')?.value,
            model: document.getElementById('setting-model')?.value,
            api_extra_headers: extraHeaders,
            
            // Assistant
            system_prompt: document.getElementById('setting-prompt')?.value,
            auto_respond: document.getElementById('setting-auto-respond')?.checked,
            web_search_enabled: document.getElementById('setting-web-search')?.checked,
            ai_min_interval_seconds: parseFloat(document.getElementById('setting-ai-interval')?.value) || 8,
            
            // Notes
            notes_enabled: document.getElementById('setting-notes-enabled')?.checked,
            notes_interval_seconds: parseInt(document.getElementById('setting-notes-interval')?.value) || 30,
            notes_on_interaction_only: document.getElementById('setting-notes-interaction-only')?.checked,
            notes_format: document.getElementById('setting-notes-format')?.value,
            notes_prompt: document.getElementById('setting-notes-prompt')?.value,
            notes_context_messages: parseInt(document.getElementById('setting-notes-context')?.value) || 10,
            notes_smart_enabled: document.getElementById('setting-notes-smart')?.checked,
            notes_smart_max_ai_notes: parseInt(document.getElementById('setting-notes-max-ai')?.value) || 18,
            notes_extract_decisions: document.getElementById('setting-notes-decisions')?.checked,
            notes_extract_actions: document.getElementById('setting-notes-actions')?.checked,
            notes_extract_risks: document.getElementById('setting-notes-risks')?.checked,
            notes_extract_facts: document.getElementById('setting-notes-facts')?.checked,

            // Transcript
            transcript_merge_enabled: document.getElementById('setting-transcript-merge')?.checked,
            transcript_merge_window_seconds: parseFloat(document.getElementById('setting-transcript-merge-window')?.value) || 4,
            transcript_ai_mode: document.getElementById('setting-transcript-ai-mode')?.value,
            transcript_display_mode: document.getElementById('setting-transcript-display')?.value,
             
            // Audio
            mic_device: getSelectedMicDeviceForCompareAndSave(),
            loopback_device: getSelectedLoopbackDeviceForCompareAndSave(),
            speech_vad_enabled: document.getElementById('setting-vad-enabled')?.checked,
            speech_vad_threshold: parseFloat(document.getElementById('setting-vad-threshold')?.value) || 0.5,
            speech_denoise_enabled: document.getElementById('setting-denoise-enabled')?.checked,
            speech_denoise_strength: parseFloat(document.getElementById('setting-denoise-strength')?.value) || 0.8,
            whisper_vad_filter: document.getElementById('setting-whisper-vad')?.checked,
            whisper_model_size: document.getElementById('setting-whisper-model-size')?.value,
            whisper_device: document.getElementById('setting-whisper-device')?.value,
            speaker_diarization_enabled: document.getElementById('setting-speaker-diarization')?.checked,
            
            // Policy
            policy_enabled: document.getElementById('setting-policy-enabled')?.checked,
            policy_prompt: document.getElementById('setting-policy-prompt')?.value,
            policy_show_withheld: document.getElementById('setting-policy-show-withheld')?.checked,
            policy_min_interval_seconds: parseFloat(document.getElementById('setting-policy-interval')?.value) || 4,
            
            // Advanced
            autosave_enabled: document.getElementById('setting-autosave')?.checked,
            session_timeout_minutes: parseInt(document.getElementById('setting-session-timeout')?.value) || 30,
            verbose_logging: document.getElementById('setting-verbose')?.checked,
            
            // Current toggle states
            ai_enabled: isAiEnabled,
            mic_enabled: isMicEnabled,
            loopback_enabled: isSystemAudioEnabled,
        };

        try {
            const res = await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cfg)
            });

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`HTTP ${res.status}: ${text}`);
            }
            transcriptAiMode = String(cfg.transcript_ai_mode || 'off');
            syncTranscriptControls();
            setTranscriptDisplayMode(cfg.transcript_display_mode);

            markSettingsBaselineNow();
            notify('success', 'Settings saved.', { durationMs: 2000, dedupeKey: 'settings-saved' });
            return true;
        } catch (e) {
            notify('error', `Error saving settings: ${e && e.message ? e.message : e}`, {
                durationMs: 5000,
                dedupeWindowMs: 2000
            });
            return false;
        }
    }

    // Test API button
    document.getElementById('test-api-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('test-api-btn');
        try {
            btn && (btn.disabled = true);
            notify('info', 'Testing API connection...', { durationMs: 2000, dedupeKey: 'test-conn' });

            const extraHeaders = parseExtraHeadersOrNull();
            if (extraHeaders === null) return;

            const payload = {
                api_provider: document.getElementById('setting-provider')?.value,
                api_key: document.getElementById('setting-api-key')?.value,
                base_url: document.getElementById('setting-base-url')?.value,
                model: document.getElementById('setting-model')?.value,
                api_extra_headers: extraHeaders,
            };

            const res = await fetch('/api/test_connection', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.status !== 'ok') {
                const msg = data.message || `HTTP ${res.status}`;
                notify('error', `Connection failed: ${msg}`, { durationMs: 6000, dedupeKey: `test-fail:${msg}` });
                return;
            }

            const latency = typeof data.latency_ms === 'number' ? `${data.latency_ms}ms` : 'unknown latency';
            const modelFound = data.model_list_ok
                ? (data.model_found === true ? 'model found' : (data.model_found === false ? 'model not in /models' : 'model unknown'))
                : 'model list unavailable';

            notify('success', `Connection OK (${latency}, ${modelFound})`, { durationMs: 3500, dedupeKey: 'test-ok' });
        } catch (e) {
            notify('error', `Connection test error: ${e?.message || e}`, { durationMs: 6000 });
        } finally {
            btn && (btn.disabled = false);
        }
    });

    // ============================================
    // HISTORY
    // ============================================

    document.getElementById('setting-notes-max-ai')?.addEventListener('input', (e) => {
        const v = e?.target?.value;
        if (v !== undefined && v !== null) {
            document.getElementById('notes-max-ai-value')?.textContent && (document.getElementById('notes-max-ai-value').textContent = String(v));
        }
    });
    
    const historyList = document.getElementById('history-list');
    const historyContent = document.getElementById('history-content');
    const historySearch = document.getElementById('history-search');
    let allSessions = [];

    async function loadHistory() {
        try {
            const res = await fetch('/api/sessions');
            const data = await res.json();
            allSessions = data.sessions || [];
            renderHistoryList();
        } catch (e) {
            console.error('Failed to load history', e);
        }
    }

    function renderHistoryList(filter = '') {
        if (!historyList) return;
        
        historyList.innerHTML = '';
        const filtered = filter 
            ? allSessions.filter(s => s.title.toLowerCase().includes(filter.toLowerCase()))
            : allSessions;
        
        if (filtered.length === 0) {
            historyList.innerHTML = '<div class="empty-state"><p>No sessions found</p></div>';
            return;
        }
        
        filtered.forEach(session => {
            const item = document.createElement('div');
            item.className = 'history-item';
            item.dataset.sessionId = session.id;
            
            const title = document.createElement('div');
            title.className = 'history-item-title';
            title.textContent = session.title;
            
            const meta = document.createElement('div');
            meta.className = 'history-item-meta';
            const date = new Date(session.started_at);
            meta.innerHTML = `<span>${date.toLocaleDateString()}</span><span>${session.message_count} messages</span><span>${session.note_count} notes</span>`;
            
            item.appendChild(title);
            item.appendChild(meta);
            
            item.addEventListener('click', () => loadSessionDetail(session.id));
            
            historyList.appendChild(item);
        });
    }

    async function loadSessionDetail(sessionId) {
        try {
            const res = await fetch(`/api/sessions/${sessionId}`);
            const data = await res.json();
            
            if (data.session) {
                renderSessionDetail(data.session);
                
                // Highlight active item
                document.querySelectorAll('.history-item').forEach(el => {
                    el.classList.toggle('active', el.dataset.sessionId === sessionId);
                });
            }
        } catch (e) {
            console.error('Failed to load session', e);
        }
    }

    function switchToTab(tabName) {
        const btn = document.querySelector(`.nav-item[data-tab="${tabName}"]`);
        if (btn) btn.click();
    }

    function loadSessionIntoLive(session) {
        if (!session || !session.id) return;

        if (confirm(`Load session "${session.title || session.id}" into Live Session? This will replace the current chat view.`)) {
            (async () => {
                try {
                    const res = await fetch(`/api/sessions/${session.id}/load`, { method: 'POST' });
                    const data = await res.json();
                    if (!res.ok || data.status !== 'ok' || !data.session) {
                        throw new Error(data.message || `HTTP ${res.status}`);
                    }

                    const loaded = data.session;

                    // Update Live Session state
                    currentSessionId = loaded.id;
                    sessionStartTime = loaded.started_at ? new Date(loaded.started_at) : new Date();
                    messageCount = Array.isArray(loaded.transcript) ? loaded.transcript.length : 0;
                    updateSessionInfo();

                    // Replace chat with loaded transcript
                    chatContainer.innerHTML = '';
                    addSystemMessage(`Loaded session: ${loaded.title || loaded.id}`);
                    (loaded.transcript || []).forEach(msg => {
                        addMessage(msg.text || '', msg.source || 'user', msg.timestamp || '');
                    });

                    // Load notes too (so Notes tab matches)
                    allNotes = loaded.notes || [];
                    renderNotes();

                    // Load session context (if present)
                    setSessionContextText(typeof loaded.context === 'string' ? loaded.context : '');

                    notify('success', 'Session loaded into Live Session', { durationMs: 2000 });
                    switchToTab('chat');
                } catch (e) {
                    notify('error', `Failed to load session: ${e?.message || e}`, { durationMs: 4200 });
                }
            })();
        }
    }

    function renderSessionDetail(session) {
        if (!historyContent) return;
        
        historyContent.innerHTML = '';
        
        const header = document.createElement('div');
        header.className = 'history-detail-header';

        const title = document.createElement('h3');
        title.textContent = session.title || 'Untitled Session';

        const meta = document.createElement('p');
        meta.className = 'text-muted';
        meta.textContent = session.started_at ? new Date(session.started_at).toLocaleString() : '';

        const actions = document.createElement('div');
        actions.className = 'history-detail-actions';

        const loadBtn = document.createElement('button');
        loadBtn.className = 'secondary-btn';
        loadBtn.type = 'button';
        loadBtn.innerHTML = '<i class="fa-solid fa-arrow-right-to-bracket"></i> Load into Live';
        loadBtn.addEventListener('click', () => loadSessionIntoLive(session));

        actions.appendChild(loadBtn);

        header.appendChild(title);
        header.appendChild(meta);
        header.appendChild(actions);
        historyContent.appendChild(header);
        
        // Transcript
        if (session.transcript && session.transcript.length > 0) {
            const transcriptSection = document.createElement('div');
            transcriptSection.className = 'history-section';
            transcriptSection.innerHTML = '<h4>Transcript</h4>';
            
            const chatDiv = document.createElement('div');
            chatDiv.className = 'chat-container';
            chatDiv.style.maxHeight = '400px';
            
            session.transcript.forEach(msg => {
                const source = (msg?.source || '').toString().trim().toLowerCase();
                const normalizedSource =
                    (source === 'loopback' || source === 'third-party' || source === 'third_party')
                        ? 'third_party'
                        : (source === 'ai' ? 'assistant' : (source || 'user'));

                const msgDiv = document.createElement('div');
                msgDiv.className =
                    normalizedSource === 'assistant'
                        ? 'message assistant'
                        : (normalizedSource === 'third_party' ? 'message third-party' : 'message user');

                const icon =
                    normalizedSource === 'assistant'
                        ? 'robot'
                        : (normalizedSource === 'third_party' ? 'desktop' : 'user');

                const sender =
                    normalizedSource === 'assistant'
                        ? 'AI'
                        : (normalizedSource === 'third_party' ? 'Third-Party' : 'You');

                const bubble = document.createElement('div');
                bubble.className = 'bubble';
                bubble.innerHTML = `
                    <div class="sender">${sender}</div>
                    <span class="content-text"></span>
                    <div class="timestamp">${msg.timestamp || ''}</div>
                `;
                bubble.querySelector('.content-text').textContent = msg.text || '';

                msgDiv.innerHTML = `<div class="avatar"><i class="fa-solid fa-${icon}"></i></div>`;
                msgDiv.appendChild(bubble);
                chatDiv.appendChild(msgDiv);
            });
            
            transcriptSection.appendChild(chatDiv);
            historyContent.appendChild(transcriptSection);
        }
        
        // Notes
        if (session.notes && session.notes.length > 0) {
            const notesSection = document.createElement('div');
            notesSection.className = 'history-section';
            notesSection.innerHTML = '<h4>Notes</h4>';
            
            const notesList = document.createElement('ul');
            notesList.className = 'notes-list';
            
            session.notes.forEach(note => {
                const li = document.createElement('li');
                li.textContent = note.content;
                if (note.pinned) li.classList.add('pinned');
                if (note.completed) li.classList.add('completed');
                notesList.appendChild(li);
            });
            
            notesSection.appendChild(notesList);
            historyContent.appendChild(notesSection);
        }
    }

    historySearch?.addEventListener('input', (e) => {
        renderHistoryList(e.target.value);
    });

    // Clear history button
    document.getElementById('clear-history-btn')?.addEventListener('click', async () => {
        if (confirm('Delete ALL session history? This cannot be undone.')) {
            try {
                const res = await fetch('/api/sessions', { method: 'DELETE' });
                const data = await res.json();
                if (data.status === 'ok') {
                    notify('success', `Cleared ${data.deleted} session(s).`, { durationMs: 3000 });
                    allSessions = [];
                    renderHistoryList();
                    if (historyContent) {
                        historyContent.innerHTML = '<div class="history-empty"><i class="fa-solid fa-clock-rotate-left"></i><p>Select a session from the list to view its transcript and notes</p></div>';
                    }
                } else {
                    notify('error', data.message || 'Failed to clear history');
                }
            } catch (e) {
                notify('error', `Error clearing history: ${e.message}`);
            }
        }
    });

    // Export all data button
    document.getElementById('export-data-btn')?.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/sessions');
            const data = await res.json();
            
            const exportData = {
                exported_at: new Date().toISOString(),
                sessions: data.sessions || []
            };
            
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `ai-assistant-export-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            notify('success', 'Data exported');
        } catch (e) {
            notify('error', 'Failed to export data');
        }
    });

    // ============================================
    // INITIALIZATION
    // ============================================
    
    connectData();
    loadSettings();
    loadDevices();
});
