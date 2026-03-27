/* ── SnoozeSquad Client ── */
const socket = io();

// ─── State ─────────────────────────────────────────────────────────
let myRoomCode = null;
let mySid = null;
let myName = '';
let currentState = null;
let activeAlarmId = null;
let ringAudioCtx = null;
let ringInterval = null;

// ─── DOM refs ───────────────────────────────────────────────────────
const viewLanding = document.getElementById('view-landing');
const viewRoom    = document.getElementById('view-room');

const createNameInput = document.getElementById('create-name');
const joinNameInput   = document.getElementById('join-name');
const joinCodeInput   = document.getElementById('join-code');
const landingError    = document.getElementById('landing-error');

const btnCreate     = document.getElementById('btn-create');
const btnJoin       = document.getElementById('btn-join');
const btnCopyCode   = document.getElementById('btn-copy-code');
const btnCancelAlarm = document.getElementById('btn-cancel-alarm');
const btnAddProposal = document.getElementById('btn-add-proposal');
const btnDismiss    = document.getElementById('btn-dismiss');

const roomCodeDisplay = document.getElementById('room-code-display');
const headerUsername  = document.getElementById('header-username');
const memberList      = document.getElementById('member-list');
const proposalsList   = document.getElementById('proposals-list');
const noProposalsMsg  = document.getElementById('no-proposals-msg');
const noAlarmMsg      = document.getElementById('no-alarm-msg');
const activeAlarmBanner = document.getElementById('active-alarm-banner');
const alarmBannerLabel  = document.getElementById('alarm-banner-label');
const alarmBannerTime   = document.getElementById('alarm-banner-time');
const alarmOverlay     = document.getElementById('alarm-overlay');
const alarmRingLabel   = document.getElementById('alarm-ring-label');
const proposalTimeInput = document.getElementById('proposal-time');
const proposalLabelInput = document.getElementById('proposal-label');

// ─── View switching ─────────────────────────────────────────────────
function showRoom() {
  viewLanding.classList.remove('active');
  viewRoom.classList.add('active');
  viewRoom.style.display = 'flex';
  viewLanding.style.display = 'none';
}

// ─── Sarcastic join/create ──────────────────────────────────────────
btnCreate.addEventListener('click', () => {
  const name = createNameInput.value.trim();
  if (!name) { flashError('Come on, at least pretend to have a name.'); return; }
  myName = name;
  socket.emit('create_room', { name });
});

btnJoin.addEventListener('click', () => {
  const name = joinNameInput.value.trim();
  const code = joinCodeInput.value.trim().toUpperCase();
  if (!name) { flashError('Your friends need to know who to blame. Enter a name.'); return; }
  if (!code || code.length !== 6) { flashError('That doesn\'t look like a valid 6-character room code, champ.'); return; }
  myName = name;
  socket.emit('join_room_req', { name, code });
});

btnCopyCode.addEventListener('click', () => {
  navigator.clipboard.writeText(myRoomCode)
    .then(() => { btnCopyCode.textContent = '✅'; setTimeout(() => btnCopyCode.textContent = '📋', 2000); })
    .catch(() => { btnCopyCode.textContent = '😤'; setTimeout(() => btnCopyCode.textContent = '📋', 2000); });
});

// ─── Add Proposal ───────────────────────────────────────────────────
btnAddProposal.addEventListener('click', () => {
  const timeVal = proposalTimeInput.value;
  const label   = proposalLabelInput.value.trim();
  if (!timeVal) { alert('Pick a time. Even bad ones count.'); return; }
  const time_utc = new Date(timeVal).getTime();
  if (time_utc <= Date.now()) { alert('That time has already passed. Impressive dedication to sleeping in, though.'); return; }
  socket.emit('add_proposal', { time_utc, label });
  proposalTimeInput.value = '';
  proposalLabelInput.value = '';
});

// ─── Cancel Alarm ───────────────────────────────────────────────────
btnCancelAlarm.addEventListener('click', () => {
  if (confirm('Cancel the alarm? Your friends will never let you live this down.')) {
    socket.emit('cancel_alarm', {});
  }
});

// ─── Dismiss ────────────────────────────────────────────────────────
btnDismiss.addEventListener('click', () => {
  stopRinging();
  alarmOverlay.classList.add('hidden');
  socket.emit('dismiss_alarm', {});
});

// ─── Socket Events ──────────────────────────────────────────────────
socket.on('room_joined', ({ code, your_sid }) => {
  myRoomCode = code;
  mySid = your_sid;
  roomCodeDisplay.textContent = code;
  headerUsername.textContent = `👤 ${myName}`;
  showRoom();
  landingError.classList.add('hidden');
  landingError.textContent = '';
});

socket.on('error', ({ msg }) => {
  flashError(msg);
});

socket.on('state_update', (state) => {
  currentState = state;
  renderMembers(state.members);
  renderProposals(state.proposals, state.members.length);
  renderActiveAlarm(state.active_alarm);
});

socket.on('alarm_ring', ({ alarm_id, label }) => {
  activeAlarmId = alarm_id;
  alarmRingLabel.textContent = label || 'Time to face the music. And by music we mean your alarm.';
  alarmOverlay.classList.remove('hidden');
  startRinging();
});

socket.on('alarm_cancelled', () => {
  activeAlarmBanner.classList.add('hidden');
  noAlarmMsg.classList.remove('hidden');
});

// ─── Render Functions ────────────────────────────────────────────────
function renderMembers(members) {
  memberList.innerHTML = '';
  members.forEach(m => {
    const isMe = m.sid === mySid;
    const isAwake = m.status === 'awake';
    const li = document.createElement('li');
    li.className = `member-item ${isAwake ? 'awake' : 'asleep'}`;
    li.innerHTML = `
      <div class="member-status-dot"></div>
      <span class="member-name">${escHtml(m.name)}${isMe ? ' <span style="opacity:0.5;font-size:0.75em">(you)</span>' : ''}</span>
      <span class="member-status-text">${isAwake ? '☀️ Awake' : '😴 Asleep'}</span>
    `;
    memberList.appendChild(li);
  });
}

function renderProposals(proposals, totalMembers) {
  proposalsList.innerHTML = '';
  if (!proposals || proposals.length === 0) {
    noProposalsMsg.style.display = 'block';
    return;
  }
  noProposalsMsg.style.display = 'none';

  const sorted = [...proposals].sort((a, b) => b.votes.length - a.votes.length);

  sorted.forEach(prop => {
    const myVote = prop.votes.includes(mySid);
    const voteCount = prop.votes.length;
    const pct = totalMembers > 0 ? Math.round((voteCount / totalMembers) * 100) : 0;
    const localTime = formatLocalTime(prop.time_utc);
    const li = document.createElement('li');
    li.className = 'proposal-item';
    li.innerHTML = `
      <div class="proposal-info">
        <div class="proposal-label">${escHtml(prop.label)}</div>
        <div class="proposal-time">🕐 ${localTime} (your local time)</div>
        <div class="proposal-proposer">Proposed by ${escHtml(prop.proposer)}</div>
        <div class="vote-bar-wrap"><div class="vote-bar" style="width:${pct}%"></div></div>
      </div>
      <button class="vote-btn ${myVote ? 'voted' : ''}" data-id="${prop.id}">
        ${myVote ? '✓' : '+'} ${voteCount} vote${voteCount !== 1 ? 's' : ''}
      </button>
    `;
    proposalsList.appendChild(li);
  });

  // Attach vote listeners
  proposalsList.querySelectorAll('.vote-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('vote_proposal', { prop_id: btn.dataset.id });
    });
  });
}

function renderActiveAlarm(alarm) {
  if (!alarm || alarm.fired === false && Date.now() < alarm.time_utc - 1000) {
    // Alarm is set but hasn't fired yet
    if (alarm) {
      activeAlarmBanner.classList.remove('hidden');
      noAlarmMsg.classList.add('hidden');
      alarmBannerLabel.textContent = alarm.label;
      alarmBannerTime.textContent = `🕐 Rings at ${formatLocalTime(alarm.time_utc)} (your local time)`;
    } else {
      activeAlarmBanner.classList.add('hidden');
      noAlarmMsg.classList.remove('hidden');
    }
  } else if (alarm) {
    activeAlarmBanner.classList.remove('hidden');
    noAlarmMsg.classList.add('hidden');
    alarmBannerLabel.textContent = alarm.label;
    alarmBannerTime.textContent = `🕐 Rings at ${formatLocalTime(alarm.time_utc)} (your local time)`;
  } else {
    activeAlarmBanner.classList.add('hidden');
    noAlarmMsg.classList.remove('hidden');
  }
}

// ─── Alarm Sound (Web Audio API) ─────────────────────────────────────
function startRinging() {
  stopRinging();
  playBeep();
  ringInterval = setInterval(playBeep, 1200);
}

function stopRinging() {
  if (ringInterval) { clearInterval(ringInterval); ringInterval = null; }
  if (ringAudioCtx) { ringAudioCtx.close(); ringAudioCtx = null; }
}

function playBeep() {
  try {
    ringAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const notes = [880, 1100, 880, 1320];
    notes.forEach((freq, i) => {
      const osc = ringAudioCtx.createOscillator();
      const gain = ringAudioCtx.createGain();
      osc.connect(gain); gain.connect(ringAudioCtx.destination);
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ringAudioCtx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, ringAudioCtx.currentTime + i * 0.18 + 0.15);
      osc.start(ringAudioCtx.currentTime + i * 0.18);
      osc.stop(ringAudioCtx.currentTime + i * 0.18 + 0.2);
    });
  } catch(e) { /* browser audio blocked */ }
}

// ─── Helpers ────────────────────────────────────────────────────────
function formatLocalTime(epochMs) {
  const d = new Date(epochMs);
  return d.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function flashError(msg) {
  landingError.textContent = msg;
  landingError.classList.remove('hidden');
}

// ─── Pre-fill datetime-local min to now ─────────────────────────────
(function setMinTime() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  if (proposalTimeInput) proposalTimeInput.min = now.toISOString().slice(0, 16);
})();
