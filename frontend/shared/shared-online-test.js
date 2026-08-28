// Global variables for Student Picker and Online Test configuration
var _spAllStudents = [];
var _spSelectedRolls = new Set();
var _spDrillClass = null;
var _spDrillSection = null;
var _spOnConfirm = null;

var _otSelectedRolls = [];
var _oteEditingTestId = null;
var _oteEditedQuestionKeys = [];
var _oteCachedQuestions = {};
var _oteTestDataCache = {}; // testId -> {keys, questions, testData}
// Fallback helper functions
var _otEscapeHtml = window.escapeHtml || function (str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
};

var _otEscapeForOnclickString = window.escapeForOnclickString || function (str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'");
};

/* ═══════════════════════════════════════════════════════════
   DATETIME PICKER ROUTINES
   ═══════════════════════════════════════════════════════════ */

var _dtField = null;      // 'live' | 'ends'
var _dtYear = null;
var _dtMonth = null;      // 0-based
var _dtSelY = null;
var _dtSelM = null;
var _dtSelD = null;
var _dtSelH = null;
var _dtSelMin = null;

function openDtPicker(field) {
    _dtField = field;
    // Ensure _dtConfirm is the original (not patched by agOpenDatePicker)
    if (typeof _dtConfirmOriginal !== 'undefined') {
        _dtConfirm = _dtConfirmOriginal;
    }
    // Pre-fill from existing hidden value if any
    const existing = document.getElementById(`ot-${field}-at`)?.value;
    const base = existing ? new Date(existing) : new Date();
    _dtYear = base.getFullYear();
    _dtMonth = base.getMonth();
    if (existing && !isNaN(base)) {
        _dtSelY = base.getFullYear();
        _dtSelM = base.getMonth();
        _dtSelD = base.getDate();
        _dtSelH = base.getHours();
        _dtSelMin = base.getMinutes();
    } else {
        _dtSelY = _dtSelM = _dtSelD = _dtSelH = _dtSelMin = null;
    }
    _dtRender();
    const overlay = document.getElementById('dt-picker-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });
}

function _dtClose() {
    const overlay = document.getElementById('dt-picker-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.style.display = 'none'; }, 200);
    _dtField = null;
    // Restore original _dtConfirm if it was patched (e.g. by agOpenDatePicker)
    if (typeof _dtConfirmOriginal !== 'undefined') {
        _dtConfirm = _dtConfirmOriginal;
    }
}

function _dtRender() {
    const box = document.getElementById('dt-picker-box');
    if (!box) return;
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const today = new Date();
    const firstDay = new Date(_dtYear, _dtMonth, 1).getDay();
    const daysInMonth = new Date(_dtYear, _dtMonth + 1, 0).getDate();

    // Build calendar grid
    let cells = '';
    // Day headers
    cells += DAYS.map(d => `<div style="font-size:0.7rem;font-weight:700;color:var(--text-muted);text-align:center;padding:4px 0">${d}</div>`).join('');
    // Empty lead cells
    for (let i = 0; i < firstDay; i++) cells += '<div></div>';
    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
        const isSelected = (_dtSelY === _dtYear && _dtSelM === _dtMonth && _dtSelD === d);
        const isToday = (today.getFullYear() === _dtYear && today.getMonth() === _dtMonth && today.getDate() === d);
        const bg = isSelected ? 'var(--accent)' : isToday ? 'rgba(86,169,255,0.13)' : 'transparent';
        const col = isSelected ? '#fff' : 'var(--text)';
        const fw = (isSelected || isToday) ? '700' : '400';
        const bord = isToday && !isSelected ? '1.5px solid var(--accent)' : '1.5px solid transparent';
        cells += `<div onclick="_dtPickDay(${d})" style="text-align:center;padding:7px 2px;border-radius:8px;cursor:pointer;font-size:0.85rem;background:${bg};color:${col};font-weight:${fw};border:${bord};transition:background .12s" onmouseover="if(!${isSelected})this.style.background='rgba(86,169,255,0.18)'" onmouseout="this.style.background='${bg}'">${d}</div>`;
    }

    // Time pickers
    const hVal = _dtSelH !== null ? String(_dtSelH).padStart(2, '0') : '--';
    const mVal = _dtSelMin !== null ? String(_dtSelMin).padStart(2, '0') : '--';

    // Hour options
    let hOpts = '';
    for (let h = 0; h < 24; h++) {
        const label = String(h).padStart(2, '0');
        const sel = _dtSelH === h;
        hOpts += `<option value="${h}" ${sel ? 'selected' : ''}>${label}</option>`;
    }
    // Minute options (every 5 min)
    let mOpts = '';
    for (let m = 0; m < 60; m += 5) {
        const label = String(m).padStart(2, '0');
        const sel = _dtSelMin !== null && Math.round(_dtSelMin / 5) * 5 % 60 === m;
        mOpts += `<option value="${m}" ${sel ? 'selected' : ''}>${label}</option>`;
    }

    const canConfirm = (_dtSelY !== null && _dtSelD !== null && _dtSelH !== null && _dtSelMin !== null);
    const fieldLabel = _dtField.endsWith('live') ? '🟢 Goes Live At' : '🔴 Last Attempt By';

    box.innerHTML = `
      <div style="padding:16px 18px 10px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between">
          <span style="font-size:0.85rem;font-weight:700;color:var(--text)">${fieldLabel}</span>
          <button onclick="_dtClose()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);border-radius:7px;width:26px;height:26px;cursor:pointer;color:var(--text-muted);font-size:0.85rem;display:flex;align-items:center;justify-content:center" onmouseover="this.style.background='rgba(255,107,107,0.15)';this.style.color='#ff6b6b'" onmouseout="this.style.background='rgba(255,255,255,0.06)';this.style.color='var(--text-muted)'">✕</button>
        </div>
      </div>
      <div style="padding:14px 16px">
        <!-- Month navigation -->
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <button onclick="_dtPrevMonth()" style="background:var(--bg-input);border:1.5px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text);font-size:1rem;display:flex;align-items:center;justify-content:center;transition:all .13s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">‹</button>
          <span style="font-size:0.9rem;font-weight:700;color:var(--text)">${MONTHS[_dtMonth]} ${_dtYear}</span>
          <button onclick="_dtNextMonth()" style="background:var(--bg-input);border:1.5px solid var(--border);border-radius:8px;width:30px;height:30px;cursor:pointer;color:var(--text);font-size:1rem;display:flex;align-items:center;justify-content:center;transition:all .13s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">›</button>
        </div>
        <!-- Calendar grid -->
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:14px">
          ${cells}
        </div>
        <!-- Time row -->
        <div style="display:flex;align-items:center;gap:8px;background:var(--bg-input);border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:14px">
          <span style="font-size:0.85rem;color:var(--text-muted);flex-shrink:0">⏰ Time</span>
          <select onchange="_dtSetHour(this.value)" style="flex:1;background:var(--bg);border:1.5px solid var(--border);border-radius:7px;padding:6px 8px;color:var(--text);font-size:0.88rem;font-family:inherit;outline:none;cursor:pointer">${hOpts}</select>
          <span style="color:var(--text-muted);font-weight:700">:</span>
          <select onchange="_dtSetMin(this.value)" style="flex:1;background:var(--bg);border:1.5px solid var(--border);border-radius:7px;padding:6px 8px;color:var(--text);font-size:0.88rem;font-family:inherit;outline:none;cursor:pointer">${mOpts}</select>
        </div>
        <!-- Confirm button -->
        <button onclick="_dtConfirm()" ${canConfirm ? '' : 'disabled'} style="width:100%;padding:10px;background:${canConfirm ? 'linear-gradient(135deg,var(--accent),var(--accent-2))' : 'var(--bg-input)'};border:none;border-radius:10px;color:${canConfirm ? '#fff' : 'var(--text-muted)'};font-size:0.88rem;font-weight:700;font-family:inherit;cursor:${canConfirm ? 'pointer' : 'not-allowed'};transition:all .15s;box-shadow:${canConfirm ? '0 4px 14px rgba(86,169,255,0.25)' : 'none'}">
          ${canConfirm ? '✅ Confirm' : 'Select a date & time'}
        </button>
      </div>`;
}

function _dtPrevMonth() {
    _dtMonth--;
    if (_dtMonth < 0) { _dtMonth = 11; _dtYear--; }
    _dtRender();
}
function _dtNextMonth() {
    _dtMonth++;
    if (_dtMonth > 11) { _dtMonth = 0; _dtYear++; }
    _dtRender();
}
function _dtPickDay(d) {
    _dtSelY = _dtYear; _dtSelM = _dtMonth; _dtSelD = d;
    // Default time to 09:00 if not yet set
    if (_dtSelH === null) _dtSelH = 9;
    if (_dtSelMin === null) _dtSelMin = 0;
    _dtRender();
}
function _dtSetHour(v) { _dtSelH = parseInt(v, 10); _dtRender(); }
function _dtSetMin(v) { _dtSelMin = parseInt(v, 10); _dtRender(); }

function _dtConfirm() {
    if (_dtSelY === null || _dtSelD === null || _dtSelH === null || _dtSelMin === null) return;
    const dt = new Date(_dtSelY, _dtSelM, _dtSelD, _dtSelH, _dtSelMin);
    // Store as ISO string in the hidden input
    const iso = `${_dtSelY}-${String(_dtSelM + 1).padStart(2, '0')}-${String(_dtSelD).padStart(2, '0')}T${String(_dtSelH).padStart(2, '0')}:${String(_dtSelMin).padStart(2, '0')}`;
    const hidden = document.getElementById(`ot-${_dtField}-at`);
    if (hidden) { hidden.value = iso; hidden.dispatchEvent(new Event('change', { bubbles: true })); }
    _dtClose();
}

// Close picker when clicking on the overlay backdrop (not the box).
// We use capture:false so inline onclick handlers inside the box fire first.
document.addEventListener('click', function (e) {
    var overlay = document.getElementById('dt-picker-overlay');
    if (!overlay || overlay.style.display !== 'flex') return;
    // Only close if the click landed directly on the backdrop overlay element itself
    if (e.target === overlay) {
        _dtClose();
    }
});


function _otFmtDt(val) {
    if (!val) return '';
    const d = new Date(val);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' +
        d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function otUpdateScheduleGap() {
    const lv = document.getElementById('ot-live-at')?.value;
    const ev = document.getElementById('ot-ends-at')?.value;
    const gap = document.getElementById('ot-schedule-gap');
    const lp = document.getElementById('ot-live-preview');
    const ep = document.getElementById('ot-ends-preview');
    const lText = document.getElementById('ot-live-display-text');
    const eText = document.getElementById('ot-ends-display-text');

    if (lText) lText.textContent = lv ? _otFmtDt(lv) : 'Select date & time';
    if (eText) eText.textContent = ev ? _otFmtDt(ev) : 'Select date & time';
    if (lp) lp.textContent = _otFmtDt(lv);
    if (ep) ep.textContent = _otFmtDt(ev);
    if (!gap) return;
    if (!lv || !ev) { gap.style.display = 'none'; return; }
    const diff = new Date(ev) - new Date(lv);
    if (diff <= 0) {
        gap.style.display = 'block';
        gap.textContent = '⚠ End time must be after start time';
        gap.style.color = 'var(--error)';
        return;
    }
    const days = Math.floor(diff / 86400000);
    const hrs = Math.floor((diff % 86400000) / 3600000);
    const mins = Math.floor((diff % 3600000) / 60000);
    let s = '🗓 Window: ';
    if (days) s += `${days}d `;
    if (hrs) s += `${hrs}h `;
    if (mins) s += `${mins}m`;
    gap.textContent = s.trim() || '< 1 minute';
    gap.style.color = 'var(--accent)';
    gap.style.display = 'block';
}

// Support alias expected by choosePaperType
function _otUpdateScheduleGap() {
    otUpdateScheduleGap();
}

function otUpdateDurPreview() {
    const durationInput = document.getElementById('ot-duration');
    const preview = document.getElementById('ot-dur-preview');
    if (!durationInput || !preview) return;
    const minutes = Math.max(5, parseInt(durationInput.value || '0', 10) || 0);
    preview.textContent = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ''} duration` : `${minutes} minute${minutes === 1 ? '' : 's'} duration`;
}

document.addEventListener('change', function (e) {
    if (e.target.id === 'ot-live-at' || e.target.id === 'ot-ends-at') otUpdateScheduleGap();
    if (e.target.id === 'ot-duration') otUpdateDurPreview();
});

document.addEventListener('input', function (e) {
    if (e.target.id === 'ot-live-at' || e.target.id === 'ot-ends-at') otUpdateScheduleGap();
    if (e.target.id === 'ot-duration') otUpdateDurPreview();
});

/* ═══════════════════════════════════════════════════════════
   STRICT MODE ROUTINES
   ═══════════════════════════════════════════════════════════ */
function _updateStrictLabel() {
    const toggle = document.getElementById('ot-strict-toggle');
    const thumb = document.getElementById('ot-strict-thumb');
    const text = document.getElementById('ot-strict-text');
    if (toggle) {
        toggle.style.background = _otStrictEnabled ? 'var(--success)' : 'rgba(255,255,255,0.1)';
        toggle.style.borderColor = _otStrictEnabled ? 'var(--success)' : 'var(--border)';
    }
    if (thumb) {
        thumb.style.transform = _otStrictEnabled ? 'translateX(16px)' : 'translateX(0)';
        thumb.style.background = _otStrictEnabled ? '#fff' : 'var(--text-muted)';
    }
    if (text) text.textContent = _otStrictEnabled ? 'Strict Mode On' : 'Disabled';
}

function toggleStrictMode() {
    _otStrictEnabled = !_otStrictEnabled;
    _updateStrictLabel();
}

/* ═══════════════════════════════════════════════════════════
   STUDENT PICKER MODAL ROUTINES
   ═══════════════════════════════════════════════════════════ */
function openStudentPicker(initialRolls = []) {
    _spSelectedRolls = new Set(initialRolls);
    _spDrillClass = null;
    _spDrillSection = null;
    var modal = document.getElementById('student-picker-modal');
    if (modal) modal.style.display = 'flex';
    // If data not yet cached, show loading and fetch
    if (!_allRegisteredStudents || !_allRegisteredStudents.length) {
        var content = document.getElementById('sp-content');
        if (content) content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.85rem">⏳ Loading students…</div>';
        var apiBase = typeof API_BASE !== 'undefined' ? API_BASE : '';
        fetch(apiBase + '/api/admin/registered-students', { credentials: 'include', cache: 'no-store' })
            .then(function (r) { if (r.ok) return r.json(); })
            .then(function (data) { if (data) { _allRegisteredStudents = data; _spAllStudents = data; if (typeof _spRender === 'function') _spRender(); } })
            .catch(function () { });
    } else {
        _spAllStudents = _allRegisteredStudents;
        if (typeof _spRender === 'function') _spRender();
    }
}

function closeStudentPicker() {
    const modal = document.getElementById('student-picker-modal');
    if (modal) modal.style.display = 'none';
}

function confirmStudentSelection() {
    if (typeof _spOnConfirm === 'function') {
        _spOnConfirm([..._spSelectedRolls]);
    }
    closeStudentPicker();
}

function openStudentPickerForOnlineTest() {
    _spOnConfirm = function (rolls) {
        _otSelectedRolls = rolls;
        _otUpdateAssignedSummary();
    };
    openStudentPicker(_otSelectedRolls);
}

function _otUpdateAssignedSummary() {
    const el = document.getElementById('ot-assigned-summary');
    if (!el) return;
    if (!_otSelectedRolls.length) {
        el.innerHTML = 'No students selected yet.';
        return;
    }
    el.innerHTML = `<span style="color:var(--success);font-weight:700">${_otSelectedRolls.length} student${_otSelectedRolls.length !== 1 ? 's' : ''} selected</span>
    <span style="color:var(--text-muted);margin-left:6px;font-size:0.78rem">${_otSelectedRolls.slice(0, 8).join(', ')}${_otSelectedRolls.length > 8 ? ` …+${_otSelectedRolls.length - 8} more` : ''}</span>`;
}

function closeOnlineTestDetails() {
    const modal = document.getElementById('online-test-details-modal');
    if (modal) modal.style.display = 'none';
    const deleteBtn = document.getElementById('ot-delete-btn');
    if (deleteBtn) deleteBtn.style.display = 'none';
}

async function deleteOnlineTest() {
    if (!_oteEditingTestId) return;
    if (!confirm("Are you sure you want to delete this test? This action cannot be undone.")) return;

    const deleteBtn = document.getElementById('ot-delete-btn');
    if (deleteBtn) {
        deleteBtn.disabled = true;
        deleteBtn.textContent = "⏳ Deleting…";
    }

    try {
        const r = await fetch(`${API_BASE}/api/admin/online-tests/${_oteEditingTestId}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const data = await r.json();
        if (!r.ok || !data.success) throw new Error(data.error || 'Failed to delete test');

        closeOnlineTestDetails();
        delete _oteTestDataCache[_oteEditingTestId];
        _oteEditingTestId = null;

        showOtSuccessToast('Online test deleted successfully!');
        if (typeof trLoadAndRender === 'function') {
            trLoadAndRender();
        }
    } catch (err) {
        showOtError(err.message || 'Failed to delete test');
    } finally {
        if (deleteBtn) {
            deleteBtn.disabled = false;
            deleteBtn.textContent = "🗑 Delete Test";
        }
    }
}

/* ═══════════════════════════════════════════════════════════
   ASSIGN ONLINE TEST SUBMISSION (BASKET PATH)
   ═══════════════════════════════════════════════════════════ */
async function assignOnlineTest() {
    const testName = document.getElementById('ot-name')?.value.trim();
    if (!testName) {
        showOtError('Please enter a test name.');
        return;
    }

    // A wrong-answer penalty of 0 is a legitimate choice, so never let `|| -1`
    // swallow it - fall back only when the field is blank or not a number.
    const _otNum = (id, fallback) => {
        const n = parseFloat(document.getElementById(id)?.value);
        return Number.isFinite(n) ? n : fallback;
    };
    const marksCorrect = _otNum('ot-marks-correct', 4);
    const marksWrong = _otNum('ot-marks-wrong', -1);
    const liveAtVal = document.getElementById('ot-live-at')?.value;
    const endsAtVal = document.getElementById('ot-ends-at')?.value;
    const durationMinutes = parseInt(document.getElementById('ot-duration')?.value, 10) || 90;
    const maxAttempts = parseInt(document.getElementById('ot-max-attempts')?.value, 10) || 1;
    const isStrict = !!_otStrictEnabled;

    if (!liveAtVal || !endsAtVal) {
        showOtError('Please select both start and end date/time.');
        return;
    }
    const liveAt = new Date(liveAtVal).getTime();
    const endsAt = new Date(endsAtVal).getTime();

    if (endsAt <= liveAt) {
        showOtError('End time must be after start time.');
        return;
    }

    if (!_otSelectedRolls.length) {
        showOtError('Please select at least one student.');
        return;
    }

    const isEdit = (_oteEditingTestId !== null);
    const method = isEdit ? 'PUT' : 'POST';
    const url = isEdit ? `${API_BASE}/api/admin/online-tests/${_oteEditingTestId}` : `${API_BASE}/api/admin/online-tests`;

    const finalQuestionKeys = isEdit ? _oteEditedQuestionKeys : (() => {
        if (typeof paperBasket === 'undefined' || !paperBasket || !paperBasket.size) return [];
        return [...paperBasket.values()].map(item => ({
            chapter: item.chapter === '(No Chapter)' ? '' : (item.chapter || ''),
            lecture: item.lecture,
            questionIndex: item.questionIndex,
            source: item.source || 'bank'
        }));
    })();

    if (!isEdit && (!finalQuestionKeys || !finalQuestionKeys.length)) {
        showOtError('Your question basket is empty.');
        return;
    }
    if (isEdit && (!finalQuestionKeys || !finalQuestionKeys.length)) {
        showOtError('Please select at least one question.');
        return;
    }

    const assignBtn = document.getElementById('ot-assign-btn');
    if (assignBtn) {
        assignBtn.disabled = true;
        assignBtn.textContent = isEdit ? '⏳ Saving…' : '⏳ Assigning…';
    }

    showOtError(''); // Clear any previous error

    try {
        const resp = await fetch(url, {
            method: method,
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                testName,
                questionKeys: finalQuestionKeys,
                marksCorrect,
                marksWrong,
                liveAt,
                endsAt,
                durationMinutes,
                assignedRolls: _otSelectedRolls,
                maxAttempts,
                isStrict
            })
        });

        const data = await resp.json();
        if (!resp.ok || !data.success) throw new Error(data.error || (isEdit ? 'Failed to update test' : 'Failed to assign online test'));

        closeOnlineTestDetails();

        if (isEdit) {
            delete _oteTestDataCache[_oteEditingTestId];
            showOtSuccessToast('Online test updated successfully!');
            // Reload results dashboard/reports
            if (typeof trLoadAndRender === 'function') {
                trLoadAndRender();
            }
        } else {
            // Reset basket
            if (typeof clearPaperBasket === 'function') {
                clearPaperBasket();
            }
            showOtSuccessToast(`Online test assigned to ${_otSelectedRolls.length} student${_otSelectedRolls.length !== 1 ? 's' : ''}!`);
        }
    } catch (err) {
        showOtError(err.message || (isEdit ? 'Failed to update test' : 'Failed to assign online test'));
    } finally {
        if (assignBtn) {
            assignBtn.disabled = false;
            assignBtn.textContent = isEdit ? '💾 Save Changes' : '🚀 Assign Test';
        }
    }
}

function showOtError(msg) {
    const errEl = document.getElementById('ot-error');
    if (!errEl) return;
    if (msg) {
        errEl.textContent = msg;
        errEl.style.display = 'block';
    } else {
        errEl.style.display = 'none';
    }
}

/* ═══════════════════════════════════════════════════════════
   AG (AUTO-GENERATE) ONLINE TEST — SEPARATE STATE & HELPERS
   These mirror the main OT functions but operate on the
   ag-sub-online panel which has its own set of element IDs.
   ═══════════════════════════════════════════════════════════ */

var _agDtField = null;   // 'live' | 'ends'  (for ag date picker)

/* --- Duration preview for ag panel --- */
function agOtUpdateDurPreview() {
    var input = document.getElementById('ag-ot-duration');
    var preview = document.getElementById('ag-ot-dur-preview');
    if (!input || !preview) return;
    var minutes = Math.max(5, parseInt(input.value || '0', 10) || 0);
    preview.textContent = minutes >= 60
        ? Math.floor(minutes / 60) + 'h ' + (minutes % 60 ? (minutes % 60) + 'm' : '') + ' duration'
        : minutes + ' minute' + (minutes === 1 ? '' : 's') + ' duration';
}

/* --- Student picker for ag panel --- */
function agOpenStudentPicker() {
    _spOnConfirm = function (rolls) {
        _agOtAssignedRolls = rolls;
        _agOtUpdateAssignedSummary();
    };
    openStudentPicker(_agOtAssignedRolls || []);
}

function _agOtUpdateAssignedSummary() {
    var el = document.getElementById('ag-ot-assigned-summary');
    if (!el) return;
    if (!_agOtAssignedRolls.length) {
        el.innerHTML = 'No students selected yet.';
        return;
    }
    el.innerHTML = '<span style="color:var(--success);font-weight:700">' + _agOtAssignedRolls.length + ' student' + (_agOtAssignedRolls.length !== 1 ? 's' : '') + ' selected</span>'
        + '<span style="color:var(--text-muted);margin-left:6px;font-size:0.78rem">'
        + _agOtAssignedRolls.slice(0, 8).join(', ')
        + (_agOtAssignedRolls.length > 8 ? ' …+' + (_agOtAssignedRolls.length - 8) + ' more' : '')
        + '</span>';
}

/* --- Date-time picker for ag panel ---
   Re-uses the same dt-picker-overlay / dt-picker-box DOM but
   writes back to the ag-ot-* hidden inputs instead of ot-*.       */
function agOpenDatePicker(field) {
    _agDtField = field;
    // Temporarily redirect _dtField so the shared _dtConfirm writes
    // to the right hidden input. We swap it back in agDtConfirm.
    _dtField = 'ag-ot-' + field;   // e.g. 'ag-ot-live'
    var existing = document.getElementById('ag-ot-' + field + '-at') && document.getElementById('ag-ot-' + field + '-at').value;
    var base = existing ? new Date(existing) : new Date();
    _dtYear = base.getFullYear();
    _dtMonth = base.getMonth();
    if (existing && !isNaN(base)) {
        _dtSelY = base.getFullYear();
        _dtSelM = base.getMonth();
        _dtSelD = base.getDate();
        _dtSelH = base.getHours();
        _dtSelMin = base.getMinutes();
    } else {
        _dtSelY = _dtSelM = _dtSelD = _dtSelH = _dtSelMin = null;
    }
    // Patch _dtConfirm to write to ag inputs then restore
    _dtConfirm = function () {
        if (_dtSelY === null || _dtSelD === null || _dtSelH === null || _dtSelMin === null) return;
        var iso = _dtSelY + '-' + String(_dtSelM + 1).padStart(2, '0') + '-' + String(_dtSelD).padStart(2, '0')
            + 'T' + String(_dtSelH).padStart(2, '0') + ':' + String(_dtSelMin).padStart(2, '0');
        var hidden = document.getElementById('ag-ot-' + _agDtField + '-at');
        if (hidden) {
            hidden.value = iso;
            hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Update display text
        var displayText = document.getElementById('ag-ot-' + _agDtField + '-display-text');
        if (displayText) displayText.textContent = _otFmtDt(iso);
        _dtClose();
        _dtConfirm = _dtConfirmOriginal;  // restore original
        _agOtUpdateScheduleGap();
    };
    _dtRender();
    var overlay = document.getElementById('dt-picker-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    requestAnimationFrame(function () { overlay.style.opacity = '1'; });
}

// Keep a reference to the original _dtConfirm so we can restore it
var _dtConfirmOriginal = _dtConfirm;

function _agOtUpdateScheduleGap() {
    var lv = document.getElementById('ag-ot-live-at') && document.getElementById('ag-ot-live-at').value;
    var ev = document.getElementById('ag-ot-ends-at') && document.getElementById('ag-ot-ends-at').value;
    var gap = document.getElementById('ag-ot-schedule-gap');
    var lText = document.getElementById('ag-ot-live-display-text');
    var eText = document.getElementById('ag-ot-ends-display-text');
    if (lText) lText.textContent = lv ? _otFmtDt(lv) : 'Select date & time';
    if (eText) eText.textContent = ev ? _otFmtDt(ev) : 'Select date & time';
    if (!gap) return;
    if (!lv || !ev) { gap.style.display = 'none'; return; }
    var diff = new Date(ev) - new Date(lv);
    if (diff <= 0) {
        gap.style.display = 'block';
        gap.textContent = '⚠ End time must be after start time';
        gap.style.color = 'var(--error)';
        return;
    }
    var days = Math.floor(diff / 86400000);
    var hrs = Math.floor((diff % 86400000) / 3600000);
    var mins = Math.floor((diff % 3600000) / 60000);
    var s = '🗓 Window: ';
    if (days) s += days + 'd ';
    if (hrs) s += hrs + 'h ';
    if (mins) s += mins + 'm';
    gap.textContent = s.trim() || '< 1 minute';
    gap.style.color = 'var(--accent)';
    gap.style.display = 'block';
}

/* ═══════════════════════════════════════════════════════════
   FIX 2: openStudentPicker patch moved to DOMContentLoaded.
   The IIFE at file-parse time ran before shared-student.js
   (also defer) had defined _spRender, causing a race condition.
   DOMContentLoaded fires after ALL defer scripts have run.
   ═══════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════
   FIX 1 & 4: closeOnlineTestDetails — direct reassignment.
   The IIFE was capturing _original before shared-paper.js ran,
   causing a reference error in some load orders. A plain
   assignment always wins and is safe to call multiple times.
   ═══════════════════════════════════════════════════════════ */
closeOnlineTestDetails = function () {
    var modal = document.getElementById('online-test-details-modal');
    if (modal) modal.style.display = 'none';
    var del = document.getElementById('ot-delete-btn');
    if (del) del.style.display = 'none';
};

/* ═══════════════════════════════════════════════════════════
   FIX: Ensure X button & Cancel button always work.
   Both call closeOnlineTestDetails() which is defined above.
   Also ensure closePaperTypeChooser works.
   ═══════════════════════════════════════════════════════════ */
if (typeof closePaperTypeChooser === 'undefined') {
    window.closePaperTypeChooser = function () {
        var el = document.getElementById('paper-type-chooser');
        if (el) el.style.display = 'none';
    };
}

/* ═══════════════════════════════════════════════════════════
   FIX: choosePaperType — open online-test-details-modal or
   paper type chooser if not handled by developer.js / client.js.
   Only registers if the function is missing at load time.
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {

    /* ── FIX 2: patch openStudentPicker here, after all defer scripts
       (including shared-student.js) have fully executed.
       The previous top-level IIFE ran at parse time and missed _spRender. ── */
    openStudentPicker = function (initialRolls) {
        _spSelectedRolls = new Set(initialRolls || []);
        _spDrillClass = null;
        _spDrillSection = null;
        var modal = document.getElementById('student-picker-modal');
        if (modal) modal.style.display = 'flex';
        if (!_allRegisteredStudents || !_allRegisteredStudents.length) {
            var content = document.getElementById('sp-content');
            if (content) content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.85rem">⏳ Loading students…</div>';
            var apiBase = typeof API_BASE !== 'undefined' ? API_BASE : '';
            fetch(apiBase + '/api/admin/registered-students', { credentials: 'include', cache: 'no-store' })
                .then(function (r) { if (r.ok) return r.json(); })
                .then(function (data) { if (data) { _allRegisteredStudents = data; _spAllStudents = data; if (typeof _spRender === 'function') _spRender(); } })
                .catch(function () { });
        } else {
            _spAllStudents = _allRegisteredStudents;
            if (typeof _spRender === 'function') _spRender();
        }
    };

    /* ── FIX 1: choosePaperType — open online-test-details-modal with
       display:flex (not display:block).  Only installs a fallback if
       shared-paper.js didn't define it; if it did, we wrap it to ensure
       the modal always gets display:flex regardless. ── */
    var _originalChoosePaperType = (typeof choosePaperType === 'function') ? choosePaperType : null;
    window.choosePaperType = function (type) {
        // Close the chooser first
        var chooser = document.getElementById('paper-type-chooser');
        if (chooser) chooser.style.display = 'none';

        if (type === 'online') {
            // Always open with display:flex — the key fix
            var modal = document.getElementById('online-test-details-modal');
            if (modal) modal.style.display = 'flex';
            // Reset modal state
            _oteEditingTestId = null;
            const titleEl = document.getElementById('ot-modal-title');
            if (titleEl) titleEl.textContent = "Configure Online Test";
            const subtitleEl = document.getElementById('ot-modal-subtitle');
            if (subtitleEl) subtitleEl.textContent = "Set up & assign this test to students";
            const btnEl = document.getElementById('ot-assign-btn');
            if (btnEl) btnEl.innerHTML = "🚀 Assign Test";
            const qSec = document.getElementById('ot-questions-section');
            if (qSec) qSec.style.display = 'none';

            _otSelectedRolls = [];
            _otStrictEnabled = false;
            _updateStrictLabel();
            _otUpdateAssignedSummary();
            otUpdateScheduleGap();
            otUpdateDurPreview();
        } else if (_originalChoosePaperType) {
            // Let shared-paper.js handle offline/other types
            _originalChoosePaperType(type);
        }
    };

    // Wire up ag-ot hidden input change events for schedule gap
    var agLive = document.getElementById('ag-ot-live-at');
    var agEnds = document.getElementById('ag-ot-ends-at');
    if (agLive) agLive.addEventListener('change', _agOtUpdateScheduleGap);
    if (agEnds) agEnds.addEventListener('change', _agOtUpdateScheduleGap);

    // Init ag duration preview
    agOtUpdateDurPreview();
    // Init main duration preview
    otUpdateDurPreview();
});

/* ═══════════════════════════════════════════════════════════
   ONLINE TEST EDITING ROUTINES (ADDED)
   ═══════════════════════════════════════════════════════════ */
async function trEditCurrentOnlineTest() {
    const testData = typeof _trCurrentTestData !== 'undefined' ? _trCurrentTestData : null;
    if (!testData || testData.type !== "online_test") return;

    const modal = document.getElementById('online-test-details-modal');
    if (!modal) return;
    const fullOt = (typeof _trOnlineTests !== 'undefined' ? _trOnlineTests : []).find(ot => ot.id === testData.id) || {};

    // Populate form fields immediately from already-loaded data
    _oteEditingTestId = testData.id;
    const titleEl = document.getElementById('ot-modal-title');
    if (titleEl) titleEl.textContent = "Edit Online Test";
    const subtitleEl = document.getElementById('ot-modal-subtitle');
    if (subtitleEl) subtitleEl.textContent = "Modify settings for this test";
    const assignBtn = document.getElementById('ot-assign-btn');
    if (assignBtn) assignBtn.innerHTML = "💾 Save Changes";
    const deleteBtn = document.getElementById('ot-delete-btn');
    if (deleteBtn) deleteBtn.style.display = '';

    const nameInput = document.getElementById('ot-name');
    if (nameInput) nameInput.value = testData.testName || "";
    const mcInput = document.getElementById('ot-marks-correct');
    if (mcInput) mcInput.value = testData.marksCorrect ?? 4;
    const mwInput = document.getElementById('ot-marks-wrong');
    if (mwInput) mwInput.value = testData.marksWrong ?? -1;

    const toIsoString = (d) => {
        if (isNaN(d.getTime())) return "";
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const liveInput = document.getElementById('ot-live-at');
    if (liveInput) liveInput.value = toIsoString(new Date(testData.liveAt));
    const endsInput = document.getElementById('ot-ends-at');
    if (endsInput) endsInput.value = toIsoString(new Date(testData.endsAt));

    const durInput = document.getElementById('ot-duration');
    if (durInput) durInput.value = fullOt.durationMinutes || 90;
    const maxInput = document.getElementById('ot-max-attempts');
    if (maxInput) maxInput.value = fullOt.maxAttempts || 1;
    _otStrictEnabled = !!fullOt.isStrict;
    _updateStrictLabel();
    _otSelectedRolls = fullOt.assignedRolls || [];
    _otUpdateAssignedSummary();
    otUpdateScheduleGap();
    otUpdateDurPreview();

    // Show modal immediately (no loading overlay)
    modal.style.display = 'flex';

    // Load question data in background (needed for save)
    _loadQuestionDataInBackground(testData.id);
}

async function _loadQuestionDataInBackground(testId) {
    try {
        const cached = _oteTestDataCache[testId];
        let resData;
        if (cached) {
            resData = cached;
        } else {
            const r = await fetch(`${API_BASE}/api/admin/online-tests/${testId}/questions`, { credentials: "include" });
            if (!r.ok) throw new Error("Failed to load test questions");
            resData = await r.json();
            _oteTestDataCache[testId] = resData;
        }
        _oteEditedQuestionKeys = (resData.keys || []).map(k => ({ ...k, source: k.source || 'bank' }));
        _oteCachedQuestions = {};
        if (Array.isArray(resData.questions)) {
            resData.questions.forEach((q, i) => {
                const k = _oteEditedQuestionKeys[i];
                if (k) {
                    const keyStr = `${k.chapter || ""}||${k.lecture || k.topic || ""}||${k.questionIndex}`;
                    _oteCachedQuestions[keyStr] = q;
                }
            });
        }
    } catch (err) {
        console.error("Background question load failed:", err);
    }
}

function oteRenderEditedQuestions() {
    const listContainer = document.getElementById('ot-questions-list');
    const badge = document.getElementById('ot-question-count-badge');
    if (!listContainer) return;

    if (badge) badge.textContent = _oteEditedQuestionKeys.length;

    if (!_oteEditedQuestionKeys.length) {
        listContainer.innerHTML = `<div style="text-align:center;padding:20px;font-size:0.85rem;color:var(--text-muted)">No questions in this test. Click "Add Question" to add questions.</div>`;
        return;
    }

    listContainer.innerHTML = _oteEditedQuestionKeys.map((k, index) => {
        const keyStr = `${k.chapter || ""}||${k.lecture || k.topic || ""}||${k.questionIndex}`;
        const qObj = _oteCachedQuestions[keyStr] || {};
        const txt = qObj.questionText || qObj.text || "Unloaded Question Content";
        const snippet = txt.length > 80 ? txt.slice(0, 80) + '...' : txt;
        return `
            <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;transition:border-color .15s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
                <div style="min-width:0;flex:1">
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
                        <span style="font-size:0.7rem;font-weight:800;color:var(--accent);background:rgba(86,169,255,0.1);padding:2px 8px;border-radius:4px">Q${index + 1}</span>
                        <span style="font-size:0.72rem;font-weight:600;color:var(--text-muted)">${k.chapter || "(No Chapter)"}</span>
                        <span style="font-size:0.72rem;color:var(--text-dim)">· ${k.lecture || k.topic || "General"}</span>
                    </div>
                    <div style="font-size:0.85rem;color:var(--text);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
                        ${_otEscapeHtml(snippet)}
                    </div>
                </div>
                <button type="button" onclick="oteRemoveQuestion(${index})" 
                    style="flex-shrink:0;background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.2);border-radius:6px;color:var(--error);padding:6px 8px;font-size:0.75rem;font-weight:600;cursor:pointer;transition:all .15s;font-family:inherit;white-space:nowrap"
                    onmouseover="this.style.background='var(--error)';this.style.color='#fff'"
                    onmouseout="this.style.background='rgba(255,107,107,0.08)';this.style.color='var(--error)'"
                    title="Remove this question">
                    ✕ Remove
                </button>
            </div>
        `;
    }).join('');
}

function oteRemoveQuestion(index) {
    _oteEditedQuestionKeys.splice(index, 1);
    oteRenderEditedQuestions();
}

var _oteQpSelectedChapter = "";
var _oteQpSelectedLecture = "";

function openQuestionSelectorForEdit() {
    const modal = document.getElementById('ote-question-picker-modal');
    if (modal) modal.style.display = 'flex';

    // Populate chapters
    const chapSelect = document.getElementById('ote-qp-chapter-select');
    const lecSelect = document.getElementById('ote-qp-lecture-select');
    const list = document.getElementById('ote-qp-questions-list');

    if (chapSelect && typeof allQuestions !== 'undefined') {
        const chapters = [...new Set(allQuestions.map(q => q.chapter || "(No Chapter)"))].sort();
        chapSelect.innerHTML = `<option value="">-- Choose Chapter --</option>` +
            chapters.map(c => `<option value="${_otEscapeHtml(c)}">${_otEscapeHtml(c)}</option>`).join('');
    }
    if (lecSelect) {
        lecSelect.innerHTML = `<option value="">-- Choose Topic --</option>`;
    }
    if (list) {
        list.innerHTML = `<div style="text-align:center;padding:40px;font-size:0.82rem;color:var(--text-muted)">Please select a chapter and topic to browse questions.</div>`;
    }

    _oteQpSelectedChapter = "";
    _oteQpSelectedLecture = "";
}

function closeQuestionSelectorForEdit() {
    const modal = document.getElementById('ote-question-picker-modal');
    if (modal) modal.style.display = 'none';
}

function oteQpOnChapterChange(chapter) {
    _oteQpSelectedChapter = chapter;
    _oteQpSelectedLecture = "";

    const lecSelect = document.getElementById('ote-qp-lecture-select');
    const list = document.getElementById('ote-qp-questions-list');
    if (list) {
        list.innerHTML = `<div style="text-align:center;padding:40px;font-size:0.82rem;color:var(--text-muted)">Please select a topic.</div>`;
    }

    if (!chapter || typeof allQuestions === 'undefined') {
        if (lecSelect) lecSelect.innerHTML = `<option value="">-- Choose Topic --</option>`;
        return;
    }

    const rows = allQuestions.filter(q => (q.chapter || "(No Chapter)") === chapter);
    const lectures = [...new Set(rows.map(q => q.lecture))].sort();

    if (lecSelect) {
        lecSelect.innerHTML = `<option value="">-- Choose Topic --</option>` +
            lectures.map(l => `<option value="${_otEscapeHtml(l)}">${_otEscapeHtml(l)}</option>`).join('');
    }
}

async function oteQpOnLectureChange(lecture) {
    _oteQpSelectedLecture = lecture;
    oteQpRenderQuestions();
}

async function oteQpRenderQuestions() {
    const list = document.getElementById('ote-qp-questions-list');
    if (!list) return;

    if (!_oteQpSelectedChapter || !_oteQpSelectedLecture) {
        list.innerHTML = `<div style="text-align:center;padding:40px;font-size:0.82rem;color:var(--text-muted)">Please select a chapter and topic.</div>`;
        return;
    }

    list.innerHTML = `<div style="text-align:center;padding:40px;font-size:0.82rem;color:var(--text-muted)">⏳ Loading questions...</div>`;

    try {
        if (typeof ensureChapterLoaded === 'function') {
            await ensureChapterLoaded(_oteQpSelectedChapter);
        }

        if (typeof allQuestions === 'undefined') return;
        const row = allQuestions.find(q => (q.chapter || "(No Chapter)") === _oteQpSelectedChapter && String(q.lecture) === String(_oteQpSelectedLecture));
        if (!row || !Array.isArray(row.questions) || !row.questions.length) {
            list.innerHTML = `<div style="text-align:center;padding:40px;font-size:0.82rem;color:var(--text-muted)">No questions found in this topic.</div>`;
            return;
        }

        list.innerHTML = row.questions.map((q, index) => {
            const isAdded = _oteEditedQuestionKeys.some(k =>
                (k.chapter || null) === (row.chapter || null) &&
                String(k.lecture || k.topic) === String(row.lecture) &&
                k.questionIndex === index
            );

            const keyStr = `${row.chapter || ""}||${row.lecture || ""}||${index}`;
            _oteCachedQuestions[keyStr] = q;

            const txt = q.questionText || q.text || "";
            const snippet = txt.length > 90 ? txt.slice(0, 90) + '...' : txt;

            return `
                <div style="background:var(--bg-card);border:1px solid var(--border);border-radius:10px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:12px;transition:border-color .15s" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
                    <div style="min-width:0;flex:1">
                        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
                            <span style="font-size:0.68rem;font-weight:700;color:var(--text-muted);background:var(--bg-input);padding:1px 7px;border-radius:4px">Q${index + 1}</span>
                            <span style="font-size:0.7rem;color:var(--text-dim)">${row.chapter || "(No Chapter)"}</span>
                        </div>
                        <div style="font-size:0.82rem;color:var(--text);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.4">
                            ${_otEscapeHtml(snippet)}
                        </div>
                    </div>
                    <button type="button" 
                        ${isAdded ? 'disabled' : ''} 
                        onclick="oteAddQuestionToTest('${_otEscapeForOnclickString(row.chapter)}', '${_otEscapeForOnclickString(row.lecture)}', ${index})" 
                        class="btn btn-primary" 
                        style="padding:6px 12px;font-size:0.78rem;font-weight:700;flex-shrink:0;white-space:nowrap;border-radius:7px;${isAdded ? 'background:rgba(46,210,180,0.1);color:var(--success);border:1px solid rgba(46,210,180,0.3);' : 'background:var(--accent);color:#fff;border:none'};cursor:${isAdded ? 'default' : 'pointer'};transition:all .15s;font-family:inherit">
                        ${isAdded ? '✓ Added' : '+ Add to Test'}
                    </button>
                </div>
            `;
        }).join('');

    } catch (e) {
        list.innerHTML = `<div style="text-align:center;padding:40px;font-size:0.82rem;color:var(--error)">Failed to load questions. Error: ${e.message}</div>`;
    }
}

function oteAddQuestionToTest(chapter, lecture, questionIndex) {
    const keyStr = `${chapter || ""}||${lecture || ""}||${questionIndex}`;
    const cached = _oteCachedQuestions[keyStr];
    const key = { chapter, lecture, questionIndex, source: (cached && cached._source) || 'bank' };
    _oteEditedQuestionKeys.push(key);
    oteRenderEditedQuestions();
    oteQpRenderQuestions();
}

async function trPrepareAndEditOnlineTest(testObj, className, sectionName) {
    if (!testObj || typeof testObj !== 'object') return;

    // Set variables for context
    _trCurrentClass = className;
    _trCurrentSection = sectionName;
    _trCurrentTestData = {
        type: "online_test",
        id: testObj.id,
        testName: testObj.testName || testObj.name || "",
        marksCorrect: testObj.marksCorrect ?? 4,
        marksWrong: testObj.marksWrong ?? -1,
        liveAt: testObj.liveAt,
        endsAt: testObj.endsAt,
    };

    // Open editing modal
    await trEditCurrentOnlineTest();
}
