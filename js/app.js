/* ============================================================
   LifeLink — original prototype logic, running on Firebase
   instead of Supabase. Same screens, same rules, same flow.
   ============================================================ */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

import * as CFG from './config.js';

// Read the keys defensively: if config.js gets pasted over and loses a name,
// the app should still start and say what's wrong rather than dying silently.
const firebaseConfig = CFG.firebaseConfig || CFG.default || {};
const isConfigured = Object.keys(firebaseConfig).length > 0
  && !Object.values(firebaseConfig)
    .some((v) => String(v).includes('PASTE_') || String(v).includes('YOUR-PROJECT-ID'));

/* ============================================================
   SPLASH SCREEN CLEANUP
   ============================================================ */
const splashEl = document.getElementById('splashScreen');
if (splashEl) {
  splashEl.addEventListener('animationend', function (e) {
    if (e.animationName === 'splashFadeOut') splashEl.remove();
  });
  setTimeout(() => { if (splashEl.parentNode) splashEl.remove(); }, 2600);
}

/* ============================================================
   FIREBASE CLIENT
   ============================================================ */
let app = null;
let auth = null;
let fdb = null;
let storage = null;

if (isConfigured) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    fdb = getFirestore(app);
    storage = getStorage(app);
  } catch (err) {
    console.error('Firebase failed to start', err);
  }
}

// The tabs and screens must keep working even when Firebase is unavailable,
// so the page tells you what is wrong instead of going dead.
if (!app) {
  const banner = document.getElementById('configBanner');
  banner.style.display = 'block';
  if (isConfigured) {
    banner.innerHTML = '<b>Could not connect to Firebase.</b> '
      + 'Check that the keys in <code>js/config.js</code> are correct and that you are online. '
      + 'Press F12 and open the Console tab for the exact message.';
  }
}

// Donors and hospitals sign in anonymously in the background so that
// Firestore rules can tell a real browser session from a random script.
// The admin signs in with a real email/password account instead.
if (auth) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      state.adminAuthenticated = false;
      signInAnonymously(auth).catch((e) => console.warn('anon auth', e));
      return;
    }
    // A signed-in account with a password (not anonymous) is the administrator.
    // Firebase remembers this across page refreshes, so restore that state.
    const wasAdmin = state.adminAuthenticated;
    state.adminAuthenticated = !user.isAnonymous;
    if (state.adminAuthenticated) {
      document.getElementById('adminSignedInEmail').textContent = user.email || '';
    }
    await refreshAdminPanels();
    if (state.adminAuthenticated && !wasAdmin) refreshSoon();
    renderAll();
  });
}

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'];

/* ============================================================
   STATE (in-memory cache, refreshed from Firestore after every change)
   ============================================================ */
const ELIGIBILITY_DAYS = 122; // ~4 months
const NOTIFICATION_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const BASE = { donors: 0, verified: 0, requests: 0 };

const state = {
  donors: [],
  currentDonor: null,
  currentHospital: null,
  adminAuthenticated: false,
  hospitals: {},
  alerts: [],
};

let selectedMatchAlertId = null;

/* ============================================================
   HELPERS
   ============================================================ */
function maskNIC(nic) {
  if (!nic) return '—';
  if (nic.length <= 4) return nic;
  return nic.slice(0, 4) + '•'.repeat(nic.length - 5) + nic.slice(-1);
}
function nicPatternValid(nic) { return /^([0-9]{9}[vVxX]|[0-9]{12})$/.test(nic.trim()); }
function phonePatternValid(phone) { return /^(?:0\d{9}|\+94\d{9})$/.test(phone.trim()); }
function maskPhone(phone) { if (!phone) return '—'; return phone.slice(0, 4) + '•'.repeat(Math.max(0, phone.length - 6)) + phone.slice(-2); }

function eligibilityInfo(lastDonatedStr) {
  if (!lastDonatedStr) return { eligible: false, reason: "No donation on record yet. First-time donors become eligible after a hospital-confirmed donation.", pct: 0 };
  const last = new Date(lastDonatedStr);
  const next = new Date(last.getTime() + ELIGIBILITY_DAYS * 24 * 60 * 60 * 1000);
  const now = new Date();
  const pct = Math.min(100, Math.max(0, Math.round(((now - last) / (next - last)) * 100)));
  if (now >= next) return { eligible: true, reason: `Eligible since ${next.toLocaleDateString()}. Final medical clearance is still confirmed on-site.`, pct: 100 };
  const daysLeft = Math.ceil((next - now) / (24 * 60 * 60 * 1000));
  return { eligible: false, reason: `Not yet eligible — ${daysLeft} day(s) remain until your 4-month interval ends (${next.toLocaleDateString()}).`, pct };
}

function showMsg(el, text, type) { if (!el) return; el.textContent = text; el.className = 'inline-msg show ' + type; }

function errText(err) {
  const code = (err && err.code) ? String(err.code) : '';
  if (code.includes('permission-denied')) return 'Blocked by the database rules — publish firestore.rules in the Firebase console.';
  if (code.includes('auth/invalid-credential') || code.includes('auth/wrong-password')) {
    return 'Incorrect email or password — or this admin account does not exist yet. '
      + 'If you have not made one, use "Create the administrator" just below this box.';
  }
  if (code.includes('auth/invalid-email')) return 'That email address is empty or not valid — check the Email box.';
  if (code.includes('auth/missing-password')) return 'Please enter a password.';
  if (code.includes('auth/email-already-in-use')) return 'That email already has an account. Use Sign In instead.';
  if (code.includes('auth/weak-password')) return 'Password must be at least 6 characters.';
  if (code.includes('auth/user-not-found')) return 'No admin account with that email yet. Use "Create the administrator" below.';
  if (code.includes('auth/operation-not-allowed')) return 'Enable Email/Password and Anonymous sign-in in the Firebase console.';
  if (code.includes('unavailable') || code.includes('network')) return 'Cannot reach Firebase — check your internet connection.';
  return (err && err.message) ? err.message : 'Something went wrong.';
}

function invLevel(units) { return units <= 6 ? 'critical' : units <= 14 ? 'low' : 'ok'; }
function invPct(units) { return Math.min(100, Math.round((units / 45) * 100)); }

function combinedInventory() {
  const totals = { 'A+': 0, 'A-': 0, 'B+': 0, 'B-': 0, 'O+': 0, 'O-': 0, 'AB+': 0, 'AB-': 0 };
  Object.values(state.hospitals).forEach((h) => { Object.keys(totals).forEach((g) => { totals[g] += h.inventory[g] || 0; }); });
  return totals;
}

function hospitalByName(name) { return Object.values(state.hospitals).find((h) => h.name === name); }

function matchChecklist(donor, alert) {
  const hosp = hospitalByName(alert.hospitalName);
  const elig = eligibilityInfo(donor.lastDonated);
  const cooldownOk = !donor.lastNotifiedAt || (Date.now() - donor.lastNotifiedAt) >= NOTIFICATION_COOLDOWN_MS;
  return {
    verified: { label: 'Verified', pass: donor.verified === true },
    group: { label: 'Blood Group', pass: donor.bloodGroup === alert.bloodGroup },
    district: { label: 'District', pass: !!hosp && donor.district === hosp.district },
    active: { label: 'Active', pass: donor.active !== false },
    eligible: { label: 'Donation Date', pass: elig.eligible },
    cooldown: { label: '24h Cooldown', pass: cooldownOk },
  };
}
function checklistAllPass(cl) { return Object.values(cl).every((c) => c.pass); }
function checklistHTML(cl) {
  return '<div class="criteria-list">' + Object.values(cl).map((c) =>
    `<span class="criteria-chip ${c.pass ? 'pass' : 'fail'}">${c.pass ? '✅' : '▫️'} ${c.label}</span>`
  ).join('') + '</div>';
}
function timeAgo(ts) {
  if (!ts) return '—';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}
function guessDocType(name) {
  if (!name) return null;
  const ext = name.split('.').pop().toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? 'image/' + ext : 'application/pdf';
}

const millis = (ts) => (ts && typeof ts.toMillis === 'function' ? ts.toMillis()
  : ts ? new Date(ts).getTime() : null);

async function readAll(name, ...constraints) {
  const snap = await getDocs(query(collection(fdb, name), ...constraints));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* ============================================================
   FIRESTORE DATA LAYER
   ============================================================ */
const docUrlCache = {};

async function resolveDocUrl(path) {
  if (!path) return null;
  if (docUrlCache[path] !== undefined) return docUrlCache[path];
  try {
    docUrlCache[path] = await getDownloadURL(storageRef(storage, path));
  } catch (e) {
    docUrlCache[path] = null;
  }
  return docUrlCache[path];
}

async function refreshDonors() {
  let rows;
  try {
    rows = await readAll('donors');
  } catch (error) { console.error('refreshDonors', error); return; }

  state.donors = rows.map((row) => ({
    id: row.id, name: row.name, nic: row.nic, phone: row.phone,
    bloodGroup: row.blood_group, district: row.district, lastDonated: row.last_donated,
    verified: row.verified === true,
    verificationStatus: row.verification_status || 'pending',
    rejectionReason: row.rejection_reason || null,
    active: row.active, consent: row.consent,
    docPath: row.doc_path || null,
    docDataUrl: null,
    docName: row.doc_name, docType: guessDocType(row.doc_name),
    lastNotifiedAt: millis(row.last_notified_at),
    createdAt: millis(row.created_at) || 0,
    donations: [], notifications: [],
  })).sort((a, b) => b.createdAt - a.createdAt);

  // Document links are only shown on the admin verification screen, and only
  // for donors still awaiting review — fetching them for everyone was slow.
  if (state.adminAuthenticated) {
    await Promise.all(state.donors
      .filter((d) => d.docPath && d.verificationStatus === 'pending')
      .map(async (d) => { d.docDataUrl = await resolveDocUrl(d.docPath); }));
  }
}

async function refreshHospitals() {
  let rows;
  try {
    rows = await readAll('hospitals');
  } catch (error) { console.error('refreshHospitals', error); return; }

  const map = {};
  rows.forEach((h) => {
    const inv = { 'A+': 0, 'A-': 0, 'B+': 0, 'B-': 0, 'O+': 0, 'O-': 0, 'AB+': 0, 'AB-': 0 };
    Object.entries(h.inventory || {}).forEach(([g, units]) => { inv[g] = units; });
    map[h.code] = { id: h.id, code: h.code, name: h.name, district: h.district, inventory: inv };
  });
  state.hospitals = map;
}

async function refreshAlerts() {
  let alerts; let responses; let notifications;
  try {
    [alerts, responses, notifications] = await Promise.all([
      readAll('alerts'),
      readAll('alert_responses'),
      readAll('donor_notifications'),
    ]);
  } catch (error) { console.error('refreshAlerts', error); return; }

  const hospitalsById = {};
  Object.values(state.hospitals).forEach((h) => { hospitalsById[h.id] = h; });
  const donorName = (id) => {
    const d = state.donors.find((x) => x.id === id);
    return d ? d.name : '—';
  };

  state.alerts = alerts.map((a) => {
    const hosp = hospitalsById[a.hospital_id];
    return {
      id: a.id,
      hospitalId: a.hospital_id,
      hospitalName: hosp ? hosp.name : '—',
      bloodGroup: a.blood_group,
      urgency: a.urgency,
      createdAt: millis(a.created_at) || 0,
      responses: responses.filter((r) => r.alert_id === a.id).map((r) => ({
        donorId: r.donor_id, name: donorName(r.donor_id),
        decision: r.decision, at: millis(r.created_at),
      })),
      matchedDonorIds: notifications.filter((n) => n.alert_id === a.id).map((n) => n.donor_id),
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

async function refreshCurrentDonorExtras() {
  if (!state.currentDonor) return;
  const donorId = state.currentDonor.id;
  let donations; let notifs;
  try {
    [donations, notifs] = await Promise.all([
      readAll('donations', where('donor_id', '==', donorId)),
      readAll('donor_notifications', where('donor_id', '==', donorId)),
    ]);
  } catch (error) { console.error('refreshCurrentDonorExtras', error); return; }

  state.currentDonor.donations = donations
    .map((x) => ({ date: x.donated_on, hospital: x.hospital_name, bloodGroup: x.blood_group }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  state.currentDonor.notifications = notifs.map((x) => {
    const alert = state.alerts.find((a) => a.id === x.alert_id);
    return {
      hospitalName: alert ? alert.hospitalName : '—',
      bloodGroup: alert ? alert.bloodGroup : '—',
      urgency: alert ? alert.urgency : '—',
      at: millis(x.created_at),
    };
  }).sort((a, b) => (b.at || 0) - (a.at || 0));
}

let refreshQueued = false;

/** Reload in the background without making the user wait for the screen. */
function refreshSoon() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refreshAll().catch((err) => console.warn('background refresh failed', err));
  }, 50);
}

async function refreshAll() {
  // Donors and hospitals are independent, so fetch them at the same time.
  // Alerts need both (for names), so they follow.
  await Promise.all([refreshDonors(), refreshHospitals()]);
  await refreshAlerts();
  if (state.currentDonor) {
    const d = state.donors.find((x) => x.id === state.currentDonor.id);
    state.currentDonor = d || null;
    await refreshCurrentDonorExtras();
  }
  if (state.currentHospital) {
    const h = Object.values(state.hospitals).find((x) => x.id === state.currentHospital.id);
    state.currentHospital = h || null;
  }
  renderAll();
}

/* ============================================================
   TAB ROUTING
   ============================================================ */
document.addEventListener('click', function (e) {
  const roleBtn = e.target.closest('.role-tab');
  if (roleBtn) { switchRole(roleBtn.dataset.role); return; }
  const subBtn = e.target.closest('.sub-tab');
  if (subBtn) { switchSub(subBtn.dataset.role, subBtn.dataset.panel); }
});

function switchRole(role) {
  document.querySelectorAll('.role-tab').forEach((b) => b.classList.toggle('active', b.dataset.role === role));
  document.querySelectorAll('.role-view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + role));
  renderAll();
}
function switchSub(role, panel) {
  document.querySelectorAll(`.sub-tab[data-role="${role}"]`).forEach((b) => b.classList.toggle('active', b.dataset.panel === panel));
  document.querySelectorAll(`.sub-panel[data-role="${role}"]`).forEach((p) => p.classList.toggle('active', p.dataset.panel === panel));
  renderAll();
}

function renderAll() { renderDonor(); renderHospital(); renderAdmin(); }

/* ============================================================
   DONOR: REGISTER
   ============================================================ */
document.getElementById('donorForm').addEventListener('submit', async function (e) {
  e.preventDefault();
  const msgEl = document.getElementById('registerMsg');
  const submitBtn = this.querySelector('button[type="submit"]');
  const name = document.getElementById('fullName').value.trim();
  const nic = document.getElementById('nicNumber').value.trim();
  const phone = document.getElementById('phoneNumber').value.trim();
  const bloodGroup = document.getElementById('bloodGroup').value;
  const district = document.getElementById('district').value;
  const lastDonated = document.getElementById('lastDonated').value;
  const consent = document.getElementById('consentCheck').checked;

  if (!nicPatternValid(nic)) { showMsg(msgEl, 'Please enter a valid NIC number.', 'error'); return; }
  if (!phonePatternValid(phone)) { showMsg(msgEl, 'Please enter a valid phone number.', 'error'); return; }
  if (state.donors.some((d) => d.nic === nic)) { showMsg(msgEl, 'A donor with this NIC is already registered. Try Login instead.', 'error'); return; }
  if (!consent) { showMsg(msgEl, 'Please confirm the consent statement before registering.', 'error'); return; }

  submitBtn.disabled = true;
  showMsg(msgEl, 'Submitting…', 'info');

  const fileInput = document.getElementById('verificationDoc');
  const file = fileInput.files[0];
  let docPath = null;
  let docName = null;

  try {
    if (file) {
      showMsg(msgEl, 'Uploading your document…', 'info');
      const path = `donor-docs/${nic}/${Date.now()}-${file.name}`;
      try {
        // Don't let a slow or disabled Storage bucket hold up registration.
        await Promise.race([
          uploadBytes(storageRef(storage, path), file),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('upload timed out')), 20000)),
        ]);
        docPath = path;
        docName = file.name;
      } catch (upErr) {
        console.error('doc upload failed', upErr);
        showMsg(msgEl, 'Document upload was slow, so we saved your registration without it. '
          + 'An admin can still verify you.', 'warning');
      }
    }
    showMsg(msgEl, 'Saving your details…', 'info');

    const ref = await addDoc(collection(fdb, 'donors'), {
      name, nic, phone, blood_group: bloodGroup, district,
      last_donated: lastDonated || null, consent,
      verified: false, verification_status: 'pending', rejection_reason: null,
      active: true, last_notified_at: null,
      doc_path: docPath, doc_name: docName,
      created_at: serverTimestamp(),
    });

    showMsg(msgEl, `Thanks, ${name}. Your profile is created and queued for verification review. Taking you to your profile…`, 'success');
    this.reset();

    // Sign them in from what we already know, so the profile appears at once.
    state.currentDonor = {
      id: ref.id, name, nic, phone, bloodGroup, district,
      lastDonated: lastDonated || null, verified: false,
      verificationStatus: 'pending', rejectionReason: null,
      active: true, consent, docPath, docName, docType: guessDocType(docName),
      docDataUrl: null, lastNotifiedAt: null, createdAt: Date.now(),
      donations: [], notifications: [],
    };
    state.donors.unshift(state.currentDonor);
    renderAll();
    switchSub('donor', 'profile');
    refreshSoon();
  } catch (err) {
    showMsg(msgEl, 'Registration failed: ' + errText(err), 'error');
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('goToRegisterBtn').addEventListener('click', () => switchSub('donor', 'register'));

/* ============================================================
   DONOR: LOGIN / LOGOUT
   ============================================================ */
document.getElementById('donorLoginBtn').addEventListener('click', async function () {
  const msgEl = document.getElementById('donorLoginMsg');
  const nic = document.getElementById('loginNIC').value.trim();
  showMsg(msgEl, 'Checking…', 'info');
  try {
    const found = await readAll('donors', where('nic', '==', nic));
    if (found.length === 0) { showMsg(msgEl, 'No donor found with that NIC. Register first from the Register tab.', 'error'); return; }
    await refreshAll();
    state.currentDonor = state.donors.find((d) => d.id === found[0].id) || null;
    await refreshCurrentDonorExtras();
    showMsg(msgEl, `Welcome back, ${found[0].name}. Taking you to your profile…`, 'success');
    document.getElementById('loginNIC').value = '';
    renderAll();
    setTimeout(() => switchSub('donor', 'profile'), 700);
  } catch (err) {
    showMsg(msgEl, errText(err), 'error');
  }
});
document.getElementById('logoutBtn').addEventListener('click', function () {
  state.currentDonor = null;
  renderAll();
});

/* ============================================================
   DONOR: DATA CONTROLS
   ============================================================ */
document.getElementById('exportDataBtn').addEventListener('click', function () {
  const msgEl = document.getElementById('dataMsg');
  if (!state.currentDonor) return;
  const blob = new Blob([JSON.stringify(state.currentDonor, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'lifelink-my-data.json';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
  showMsg(msgEl, 'Your data has been downloaded as a JSON file.', 'success');
});

document.getElementById('deleteDataBtn').addEventListener('click', async function () {
  const msgEl = document.getElementById('dataMsg');
  if (!state.currentDonor) return;
  if (!this.dataset.confirming) {
    this.dataset.confirming = '1'; this.textContent = 'Click again to confirm';
    showMsg(msgEl, 'This permanently deletes your profile. Click again to confirm.', 'warning');
    return;
  }
  this.dataset.confirming = ''; this.textContent = 'Delete my account';
  try {
    await deleteDoc(doc(fdb, 'donors', state.currentDonor.id));
    state.currentDonor = null;
    await refreshAll();
  } catch (err) {
    showMsg(msgEl, 'Delete failed: ' + errText(err), 'error');
  }
});

document.getElementById('simulateVerifyBtn').addEventListener('click', async function () {
  if (!state.currentDonor) return;
  try {
    await updateDoc(doc(fdb, 'donors', state.currentDonor.id), {
      verified: true, verification_status: 'verified', rejection_reason: null,
    });
    await refreshAll();
  } catch (err) { console.error(err); }
});

document.getElementById('activeToggle').addEventListener('change', async function () {
  if (!state.currentDonor) return;
  const checked = this.checked;
  state.currentDonor.active = checked;
  const donorInList = state.donors.find((d) => d.id === state.currentDonor.id);
  if (donorInList) donorInList.active = checked;
  renderAll();
  try {
    await updateDoc(doc(fdb, 'donors', state.currentDonor.id), { active: checked });
  } catch (err) { console.error('active toggle failed', err); }
});

document.getElementById('logDonationBtn').addEventListener('click', async function () {
  if (!state.currentDonor) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    await addDoc(collection(fdb, 'donations'), {
      donor_id: state.currentDonor.id, donated_on: today,
      hospital_name: null, blood_group: state.currentDonor.bloodGroup,
      created_at: serverTimestamp(),
    });
    await updateDoc(doc(fdb, 'donors', state.currentDonor.id), { last_donated: today });
    await refreshAll();
  } catch (err) { console.error(err); }
});

/* ============================================================
   DONOR RENDER
   ============================================================ */
function renderDonor() {
  const d = state.currentDonor;

  document.getElementById('profileEmptyState').style.display = d ? 'none' : 'block';
  document.getElementById('profileCard').style.display = d ? 'block' : 'none';
  if (d) {
    document.getElementById('pName').textContent = d.name;
    document.getElementById('pNIC').textContent = maskNIC(d.nic);
    document.getElementById('pPhone').textContent = d.phone || '—';
    document.getElementById('pBlood').textContent = d.bloodGroup;
    document.getElementById('pDistrict').textContent = d.district;
    const statusLabel = d.verificationStatus === 'verified' ? 'Verified' : d.verificationStatus === 'rejected' ? 'Rejected' : 'Pending Review';
    const statusClass = d.verificationStatus === 'verified' ? 'status-verified' : d.verificationStatus === 'rejected' ? 'status-rejected' : 'status-pending';
    document.getElementById('pVerified').innerHTML = `<span class="status-badge ${statusClass}">${statusLabel}</span>`;
    const badge = document.getElementById('profileVerifiedBadge');
    badge.textContent = statusLabel;
    badge.className = 'status-badge ' + statusClass;
    const rejNote = document.getElementById('pRejectionNote');
    if (d.verificationStatus === 'rejected' && d.rejectionReason) {
      rejNote.style.display = 'block';
      rejNote.textContent = `Your document was rejected: ${d.rejectionReason}. Please contact NBTS or re-register with a clearer document.`;
    } else {
      rejNote.style.display = 'none';
    }
    document.getElementById('activeToggle').checked = d.active !== false;
  }

  document.getElementById('bloodGroupEmptyState').style.display = d ? 'none' : 'block';
  document.getElementById('bloodGroupCard').style.display = d ? 'block' : 'none';
  if (d) {
    document.getElementById('bgGroup').textContent = d.bloodGroup;
    const elig = eligibilityInfo(d.lastDonated);
    const canMatch = d.verified && elig.eligible;
    document.getElementById('bgEligible').textContent = canMatch ? 'Eligible' : 'Not yet';
    document.getElementById('bgEligibleSub').textContent = d.verified ? 'verification complete' : 'pending verification';
    document.getElementById('eligibilityBar').style.width = elig.pct + '%';
    document.getElementById('eligibilityNote').textContent = elig.reason + (d.verified ? '' : ' You also need document verification before live matching.');
    document.getElementById('simulateVerifyBtn').style.display = d.verified ? 'none' : 'inline-block';
  }

  document.getElementById('historyEmptyState').style.display = d ? 'none' : 'block';
  document.getElementById('historyCard').style.display = d ? 'block' : 'none';
  if (d) {
    const list = document.getElementById('donationHistoryList');
    list.innerHTML = d.donations.length === 0
      ? '<p class="empty-state">No donations logged yet.</p>'
      : d.donations.map((don) => `<div class="response-item">Donated on ${new Date(don.date).toLocaleDateString()}${don.hospital ? ` · ${don.hospital} · ${don.bloodGroup}` : ''}</div>`).join('');
  }

  document.getElementById('requestsLockedState').style.display = d ? 'none' : 'block';
  document.getElementById('requestsUnlockedState').style.display = d ? 'block' : 'none';
  if (d) {
    const alertList = document.getElementById('donorAlertList');
    if (state.alerts.length === 0) {
      alertList.innerHTML = '<p class="empty-state">No active shortage alerts right now.</p>';
    } else {
      alertList.innerHTML = state.alerts.map((a) => {
        const chipClass = a.urgency === 'CRITICAL' ? 'critical' : 'moderate';
        const myResponse = a.responses.find((r) => r.donorId === d.id);

        let actionsHTML;
        if (myResponse) {
          actionsHTML = `<span class="status-badge ${myResponse.decision === 'accepted' ? 'status-verified' : 'status-ineligible'}">${myResponse.decision === 'accepted' ? 'Accepted' : 'Declined'}</span>`;
        } else {
          const cl = matchChecklist(d, a);
          if (a.matchedDonorIds.includes(d.id)) cl.cooldown.pass = true;
          if (!checklistAllPass(cl)) {
            const failed = Object.values(cl).filter((c) => !c.pass).map((c) => c.label).join(', ');
            actionsHTML = `<span class="hint" title="Failing: ${failed}">Not eligible (${failed})</span>`;
          } else {
            actionsHTML = `<div class="lr-actions">
              <button class="apple-btn btn-small btn-accept" data-accept="${a.id}">Accept</button>
              <button class="apple-btn btn-small btn-decline" data-decline="${a.id}">Decline</button>
            </div>`;
          }
        }

        return `<div class="list-row">
          <div>
            <div class="lr-main">${a.hospitalName}</div>
            <div class="lr-sub">Needs ${a.bloodGroup} · ${timeAgo(a.createdAt)}</div>
          </div>
          <span class="chip ${chipClass}">${a.urgency}</span>
          ${actionsHTML}
        </div>`;
      }).join('');

      alertList.querySelectorAll('[data-accept]').forEach((btn) => btn.addEventListener('click', () => respondToAlert(btn.dataset.accept, 'accepted')));
      alertList.querySelectorAll('[data-decline]').forEach((btn) => btn.addEventListener('click', () => respondToAlert(btn.dataset.decline, 'declined')));
    }
  }

  const notifList = document.getElementById('donorNotifList');
  if (!d) {
    notifList.innerHTML = '<p class="empty-state">Login to see your notifications.</p>';
  } else if (d.notifications.length === 0) {
    notifList.innerHTML = '<p class="empty-state">No notifications yet — you\'ll be notified automatically when you pass all matching checks for a nearby request.</p>';
  } else {
    notifList.innerHTML = d.notifications.map((n) =>
      `<div class="notif-item"><b>${n.urgency === 'CRITICAL' ? '🔴' : '🟠'} ${n.hospitalName}</b>Needs ${n.bloodGroup} blood · ${timeAgo(n.at)}</div>`
    ).join('');
  }
}

async function respondToAlert(alertId, decision) {
  const d = state.currentDonor;
  const alert = state.alerts.find((a) => a.id === alertId);
  if (!d || !alert) return;

  // Show the decision immediately; the writes happen behind the scenes.
  alert.responses.push({ donorId: d.id, name: d.name, decision, at: Date.now() });
  renderAll();

  try {
    await addDoc(collection(fdb, 'alert_responses'), {
      alert_id: alertId, donor_id: d.id, decision, created_at: serverTimestamp(),
    });

    if (decision === 'accepted') {
      const today = new Date().toISOString().slice(0, 10);
      await addDoc(collection(fdb, 'donations'), {
        donor_id: d.id, donated_on: today, hospital_name: alert.hospitalName,
        blood_group: alert.bloodGroup, created_at: serverTimestamp(),
      });
      await updateDoc(doc(fdb, 'donors', d.id), { last_donated: today });

      const hosp = Object.values(state.hospitals).find((h) => h.id === alert.hospitalId);
      if (hosp) {
        const inventory = { ...hosp.inventory };
        inventory[alert.bloodGroup] = (inventory[alert.bloodGroup] || 0) + 1;
        await updateDoc(doc(fdb, 'hospitals', hosp.id), { inventory });
      }
    }
  } catch (err) {
    console.error('respond failed', err);
  }

  refreshSoon();
}

/* ============================================================
   HOSPITAL: LOGIN
   ============================================================ */
document.getElementById('hospLoginBtn').addEventListener('click', function () {
  const msgEl = document.getElementById('hospLoginMsg');
  const code = document.getElementById('hospAuthCode').value.trim();
  const hosp = state.hospitals[code];
  if (!hosp) { showMsg(msgEl, 'Authorisation code not recognised.', 'error'); return; }
  state.currentHospital = hosp;
  showMsg(msgEl, `Signed in as ${hosp.name}.`, 'success');
  renderAll();
});

/* ============================================================
   HOSPITAL: CREATE REQUEST
   ============================================================ */
document.getElementById('createRequestBtn').addEventListener('click', async function () {
  const msgEl = document.getElementById('createRequestMsg');
  const h = state.currentHospital;
  if (!h) return;
  const bloodGroup = document.getElementById('reqBloodGroup').value;
  const urgency = document.getElementById('reqUrgency').value;

  this.disabled = true;
  showMsg(msgEl, 'Broadcasting…', 'info');

  try {
    const alertRef = await addDoc(collection(fdb, 'alerts'), {
      hospital_id: h.id, blood_group: bloodGroup, urgency, created_at: serverTimestamp(),
    });

    const pseudoAlert = { bloodGroup, hospitalName: h.name };
    const matchedIds = [];
    state.donors.forEach((d) => {
      const cl = matchChecklist(d, pseudoAlert);
      if (checklistAllPass(cl)) matchedIds.push(d.id);
    });

    if (matchedIds.length > 0) {
      const now = new Date();
      await Promise.all(matchedIds.map((donorId) =>
        addDoc(collection(fdb, 'donor_notifications'), {
          donor_id: donorId, alert_id: alertRef.id, created_at: serverTimestamp(),
        })));
      await Promise.all(matchedIds.map((donorId) =>
        updateDoc(doc(fdb, 'donors', donorId), { last_notified_at: now })));
    }

    selectedMatchAlertId = alertRef.id;
    showMsg(msgEl, `Alert broadcast for ${bloodGroup} (${urgency}). ${matchedIds.length} donor(s) passed all checks and were auto-notified — see "View Matching Donors".`, 'success');
    refreshSoon();
  } catch (err) {
    showMsg(msgEl, 'Failed to create request: ' + errText(err), 'error');
  } finally {
    this.disabled = false;
  }
});

/* ============================================================
   HOSPITAL: INVENTORY
   ============================================================ */
async function adjustInventory(group, delta) {
  const h = state.currentHospital;
  if (!h) return;
  const newUnits = Math.max(0, (h.inventory[group] || 0) + delta);
  h.inventory[group] = newUnits; // optimistic UI
  renderHospital();
  try {
    await updateDoc(doc(fdb, 'hospitals', h.id), { inventory: { ...h.inventory } });
  } catch (err) { console.error('inventory update failed', err); }
  // No full reload here — the +/- buttons should feel instant.
}

/* ============================================================
   HOSPITAL RENDER
   ============================================================ */
function renderHospital() {
  const h = state.currentHospital;
  const locked = !h;

  ['hospDashLocked', 'hospInvLocked', 'hospCreateLocked', 'hospMatchLocked', 'hospHistLocked', 'hospNotifiedLocked'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.style.display = locked ? 'block' : 'none';
  });
  ['hospDashUnlocked', 'hospInvUnlocked', 'hospCreateUnlocked', 'hospMatchUnlocked', 'hospHistUnlocked', 'hospNotifiedUnlocked'].forEach((id) => {
    const el = document.getElementById(id); if (el) el.style.display = locked ? 'none' : 'block';
  });

  if (locked) return;

  const myAlerts = state.alerts.filter((a) => a.hospitalId === h.id);
  const totalUnits = Object.values(h.inventory).reduce((a, b) => a + b, 0);
  const verifiedCount = BASE.verified + state.donors.filter((d) => d.verified).length;
  document.getElementById('hospStatGrid').innerHTML = [
    { label: 'Total Donors', value: (BASE.donors + state.donors.length).toLocaleString(), sub: 'district-wide pool' },
    { label: 'Blood Requests', value: myAlerts.length, sub: myAlerts.filter((a) => a.urgency === 'CRITICAL').length + ' critical' },
    { label: 'Verified Donors', value: verifiedCount.toLocaleString(), sub: 'district-wide' },
    { label: 'Available Units', value: totalUnits, sub: 'this hospital' },
  ].map((s, i) => `<div class="stat-card ${i === 0 ? 'accent' : ''}"><div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div><div class="stat-sub">${s.sub}</div></div>`).join('');

  document.getElementById('hospInventoryGrid').innerHTML = Object.entries(h.inventory).map(([g, units]) => `
    <div class="inv-card">
      <div class="inv-group">${g}</div>
      <div class="inv-count">${units}</div>
      <div class="inv-units">units</div>
      <div class="inv-bar"><div class="inv-bar-fill ${invLevel(units)}" style="width:${invPct(units)}%"></div></div>
      <div class="inv-controls">
        <button data-inv-minus="${g}">−</button>
        <button data-inv-plus="${g}">+</button>
      </div>
    </div>`).join('');
  document.querySelectorAll('[data-inv-plus]').forEach((b) => b.addEventListener('click', () => adjustInventory(b.dataset.invPlus, 1)));
  document.querySelectorAll('[data-inv-minus]').forEach((b) => b.addEventListener('click', () => adjustInventory(b.dataset.invMinus, -1)));

  const select = document.getElementById('matchRequestSelect');
  const prevValue = select.value;
  select.innerHTML = myAlerts.length === 0
    ? '<option value="">No requests yet</option>'
    : myAlerts.map((a) => `<option value="${a.id}">${a.bloodGroup} · ${a.urgency} · ${timeAgo(a.createdAt)}</option>`).join('');
  if (myAlerts.some((a) => a.id === selectedMatchAlertId)) select.value = selectedMatchAlertId;
  else if (myAlerts.some((a) => a.id === prevValue)) select.value = prevValue;
  else if (myAlerts.length) select.value = myAlerts[0].id;
  selectedMatchAlertId = select.value || null;

  const matchList = document.getElementById('matchingDonorsList');
  const selectedAlert = myAlerts.find((a) => a.id === selectedMatchAlertId);
  if (!selectedAlert) {
    matchList.innerHTML = '<p class="empty-state">Create a blood request first, then come back here to see the matching checklist per donor.</p>';
  } else {
    const relevant = state.donors.filter((d) => d.bloodGroup === selectedAlert.bloodGroup);
    matchList.innerHTML = relevant.length === 0
      ? `<p class="empty-state">No registered donors have blood group ${selectedAlert.bloodGroup} yet.</p>`
      : relevant.map((d) => {
        const cl = matchChecklist(d, selectedAlert);
        const notified = selectedAlert.matchedDonorIds.includes(d.id);
        return `<div class="list-row">
            <div style="flex:1;">
              <div class="lr-main">${d.name} · ${d.bloodGroup}</div>
              <div class="lr-sub">${d.district} · NIC ${maskNIC(d.nic)} · ${maskPhone(d.phone)}</div>
              ${checklistHTML(cl)}
            </div>
            ${notified ? '<span class="notified-tag">🔔 Notified</span>' : '<span class="hint">Not notified</span>'}
          </div>`;
      }).join('');
  }

  const notifiedRows = [];
  myAlerts.forEach((a) => {
    a.matchedDonorIds.forEach((donorId) => {
      const d = state.donors.find((x) => x.id === donorId);
      if (d) notifiedRows.push({ donor: d, alert: a });
    });
  });
  const notifiedList = document.getElementById('notifiedDonorsList');
  notifiedList.innerHTML = notifiedRows.length === 0
    ? '<p class="empty-state">No donors have been auto-notified yet. This fills in as soon as a request finds a donor who passes every check.</p>'
    : notifiedRows.map((r) => `<div class="list-row">
        <div><div class="lr-main">${r.donor.name} · ${r.donor.bloodGroup}</div><div class="lr-sub">Notified for ${r.alert.urgency} request · ${timeAgo(r.donor.lastNotifiedAt)}</div></div>
        <span class="status-badge status-verified">Notified</span>
      </div>`).join('');

  document.getElementById('hospRequestHistoryList').innerHTML = myAlerts.length === 0
    ? '<p class="empty-state">No requests broadcast yet.</p>'
    : myAlerts.map((a) => `<div class="list-row">
        <div><div class="lr-main">${a.bloodGroup} · ${a.urgency}</div><div class="lr-sub">${timeAgo(a.createdAt)} · ${a.matchedDonorIds.length} notified · ${a.responses.filter((r) => r.decision === 'accepted').length} accepted, ${a.responses.filter((r) => r.decision === 'declined').length} declined</div></div>
      </div>`).join('');
}
document.getElementById('matchRequestSelect').addEventListener('change', function () {
  selectedMatchAlertId = this.value || null;
  renderHospital();
});

/* ============================================================
   ADMIN: FIRST-RUN SETUP
   You choose the admin email and password here, once. Firebase
   stores the password; it never appears in this file.
   ============================================================ */
async function adminExists() {
  if (!fdb) return true;
  try {
    const snap = await getDoc(doc(fdb, 'config', 'admin'));
    return snap.exists();
  } catch (err) {
    console.warn('admin check failed', err);
    return true;   // on doubt, show the normal login rather than the setup form
  }
}

function showAdminBlock(which) {
  const blocks = {
    setup: document.getElementById('adminSetupBlock'),
    login: document.getElementById('adminLoginBlock'),
    signedIn: document.getElementById('adminSignedInBlock'),
  };
  Object.entries(blocks).forEach(([key, el]) => {
    if (el) el.style.display = key === which ? 'block' : 'none';
  });
}

async function refreshAdminPanels() {
  if (state.adminAuthenticated) { showAdminBlock('signedIn'); return; }
  // If an admin was created in the Firebase console instead of here, the
  // marker document won't exist — so default to the sign-in form and let
  // the user switch to setup with the link underneath it.
  showAdminBlock(await adminExists() ? 'login' : 'setup');
}

document.getElementById('showAdminLoginBtn').addEventListener('click', () => showAdminBlock('login'));

document.getElementById('adminSignOutBtn').addEventListener('click', async () => {
  state.adminAuthenticated = false;
  try {
    await auth.signOut();
  } catch (err) { console.warn(err); }
  showAdminBlock('login');
  renderAll();
});

document.getElementById('showAdminSetupBtn').addEventListener('click', () => showAdminBlock('setup'));

document.getElementById('adminSetupBtn').addEventListener('click', async function () {
  const msgEl = document.getElementById('adminSetupMsg');
  const email = document.getElementById('setupEmail').value.trim();
  const pass = document.getElementById('setupPassword').value;
  const pass2 = document.getElementById('setupPassword2').value;

  if (!email) { showMsg(msgEl, 'Please enter an email address.', 'error'); return; }
  if (pass.length < 6) { showMsg(msgEl, 'Password must be at least 6 characters.', 'error'); return; }
  if (pass !== pass2) { showMsg(msgEl, 'The two passwords do not match.', 'error'); return; }
  if (await adminExists()) {
    showMsg(msgEl, 'An administrator already exists. Use the sign-in form.', 'error');
    await refreshAdminPanels();
    return;
  }

  this.disabled = true;
  showMsg(msgEl, 'Creating…', 'info');
  try {
    await createUserWithEmailAndPassword(auth, email, pass);
    // Creating the account also signs us in with the password provider,
    // which is what the database rules recognise as the administrator.
    await setDoc(doc(fdb, 'config', 'admin'), { email, created_at: serverTimestamp() });
    state.adminAuthenticated = true;
    document.getElementById('adminSignedInEmail').textContent = email;
    showMsg(msgEl, `Administrator created. You are signed in as ${email}.`, 'success');
    document.getElementById('setupPassword').value = '';
    document.getElementById('setupPassword2').value = '';
    await refreshAdminPanels();
    await refreshAll();
    setTimeout(() => switchSub('admin', 'hospitals'), 800);
  } catch (err) {
    showMsg(msgEl, errText(err), 'error');
  } finally {
    this.disabled = false;
  }
});

/* ============================================================
   ADMIN: LOGIN
   ============================================================ */
document.getElementById('adminLoginBtn').addEventListener('click', async function () {
  const msgEl = document.getElementById('adminLoginMsg');
  const email = document.getElementById('adminEmail').value.trim();
  const pass = document.getElementById('adminPassword').value;
  if (!email) {
    showMsg(msgEl, 'Please type the admin email address in the box above. '
      + 'The faint grey text is only an example.', 'error');
    document.getElementById('adminEmail').focus();
    return;
  }
  if (!pass) { showMsg(msgEl, 'Please enter the admin password.', 'error'); return; }
  showMsg(msgEl, 'Checking…', 'info');
  try {
    await signInWithEmailAndPassword(auth, email, pass);
    state.adminAuthenticated = true;
    document.getElementById('adminSignedInEmail').textContent = email;
    showMsg(msgEl, 'Signed in as Admin.', 'success');
    document.getElementById('adminPassword').value = '';

    // If this admin was created in the Firebase console, record the marker now
    // so the setup form never reappears.
    try {
      const marker = await getDoc(doc(fdb, 'config', 'admin'));
      if (!marker.exists()) {
        await setDoc(doc(fdb, 'config', 'admin'), { email, created_at: serverTimestamp() });
      }
    } catch (err) { console.warn('could not record admin marker', err); }

    await refreshAdminPanels();
    await refreshAll();
    setTimeout(() => switchSub('admin', 'hospitals'), 700);
  } catch (err) {
    showMsg(msgEl, errText(err), 'error');
  }
});

/* ============================================================
   ADMIN: MANAGE HOSPITALS
   ============================================================ */
document.getElementById('addHospitalBtn').addEventListener('click', async function () {
  const msgEl = document.getElementById('addHospitalMsg');
  const name = document.getElementById('newHospName').value.trim();
  const code = document.getElementById('newHospCode').value.trim();
  const district = document.getElementById('newHospDistrict').value;
  if (!name || !code) { showMsg(msgEl, 'Please enter both a hospital name and an authorisation code.', 'error'); return; }
  if (state.hospitals[code]) { showMsg(msgEl, 'That authorisation code is already in use.', 'error'); return; }

  const inventory = {};
  BLOOD_GROUPS.forEach((g) => { inventory[g] = 0; });

  this.disabled = true;
  showMsg(msgEl, 'Saving…', 'info');
  try {
    const ref = await addDoc(collection(fdb, 'hospitals'), {
      name, code, district, inventory, created_at: serverTimestamp(),
    });
    // Show it straight away; the background reload confirms it.
    state.hospitals[code] = { id: ref.id, code, name, district, inventory };
    renderAll();
    showMsg(msgEl, `${name} added with code ${code}.`, 'success');
    document.getElementById('newHospName').value = '';
    document.getElementById('newHospCode').value = '';
    refreshSoon();
  } catch (err) {
    showMsg(msgEl, 'Failed to add hospital: ' + errText(err), 'error');
  } finally {
    this.disabled = false;
  }
});

/* ============================================================
   ADMIN: VERIFY DONORS
   ============================================================ */
function applyLocally(donorId, patch) {
  const d = state.donors.find((x) => x.id === donorId);
  if (d) Object.assign(d, patch);
  if (state.currentDonor && state.currentDonor.id === donorId) {
    Object.assign(state.currentDonor, patch);
  }
  renderAll();
}

async function verifyDonor(donorId) {
  applyLocally(donorId, { verified: true, verificationStatus: 'verified', rejectionReason: null });
  try {
    await updateDoc(doc(fdb, 'donors', donorId), {
      verified: true, verification_status: 'verified', rejection_reason: null,
    });
  } catch (err) { console.error(err); }
  refreshSoon();
}

async function rejectDonor(donorId, reason) {
  applyLocally(donorId, { verified: false, verificationStatus: 'rejected', rejectionReason: reason });
  try {
    await updateDoc(doc(fdb, 'donors', donorId), {
      verified: false, verification_status: 'rejected', rejection_reason: reason,
    });
  } catch (err) { console.error(err); }
  refreshSoon();
}

/* ============================================================
   ADMIN RENDER
   ============================================================ */
function renderAdmin() {
  if (!state.adminAuthenticated) {
    const lockMsg = '<p class="empty-state">🔒 Sign in as Admin to view this section.</p>';
    ['adminHospitalList', 'adminVerifyList', 'adminReportList', 'adminUsersDonorList', 'adminUsersHospitalList', 'adminStatGrid', 'adminInventoryGrid'].forEach((id) => {
      const el = document.getElementById(id); if (el) el.innerHTML = lockMsg;
    });
    return;
  }

  document.getElementById('adminHospitalList').innerHTML = Object.keys(state.hospitals).length === 0
    ? '<p class="empty-state">No hospitals added yet.</p>'
    : Object.values(state.hospitals).map((h) => `
      <div class="list-row">
        <div><div class="lr-main">${h.name}</div><div class="lr-sub">Code: ${h.code} · ${h.district} · ${Object.values(h.inventory).reduce((a, b) => a + b, 0)} units in stock</div></div>
      </div>`).join('');

  const pending = state.donors.filter((d) => d.verificationStatus === 'pending');
  const verifyList = document.getElementById('adminVerifyList');
  verifyList.innerHTML = pending.length === 0
    ? '<p class="empty-state">No donors awaiting verification.</p>'
    : pending.map((d) => {
      let docHTML;
      if (!d.docDataUrl) {
        docHTML = '<span class="doc-none">No document uploaded</span>';
      } else if (d.docType && d.docType.startsWith('image/')) {
        docHTML = `<a href="${d.docDataUrl}" target="_blank" title="Click to view full size"><img class="doc-thumb" src="${d.docDataUrl}" alt="${d.docName}"></a>`;
      } else {
        docHTML = `<a class="apple-btn btn-ghost btn-small" href="${d.docDataUrl}" target="_blank">View document (${d.docName || 'file'})</a>`;
      }
      return `<div class="verify-row">
          <div class="doc-row" style="flex:1;">
            ${docHTML}
            <div><div class="lr-main">${d.name} · ${d.bloodGroup}</div><div class="lr-sub">NIC ${maskNIC(d.nic)} · ${d.phone || 'no phone'} · ${d.district}</div></div>
          </div>
          <div class="verify-actions">
            <button class="apple-btn btn-small btn-accept" data-verify="${d.id}">Verify</button>
            <div class="reject-row">
              <input type="text" class="reject-reason-input" id="reject-reason-${d.id}" placeholder="Rejection reason…">
              <button class="apple-btn btn-small btn-decline" data-reject="${d.id}">Reject</button>
            </div>
          </div>
        </div>`;
    }).join('');
  verifyList.querySelectorAll('[data-verify]').forEach((btn) => btn.addEventListener('click', () => verifyDonor(btn.dataset.verify)));
  verifyList.querySelectorAll('[data-reject]').forEach((btn) => btn.addEventListener('click', () => {
    const reasonInput = document.getElementById('reject-reason-' + btn.dataset.reject);
    const reason = reasonInput ? reasonInput.value.trim() : '';
    if (!reason) { reasonInput.focus(); reasonInput.placeholder = 'Reason required…'; return; }
    rejectDonor(btn.dataset.reject, reason);
  }));

  const totalResponses = state.alerts.reduce((sum, a) => sum + a.responses.length, 0);
  const accepted = state.alerts.reduce((sum, a) => sum + a.responses.filter((r) => r.decision === 'accepted').length, 0);
  document.getElementById('adminReportList').innerHTML = [
    `Registered donors: <strong>${state.donors.length}</strong>`,
    `Verified donors: <strong>${state.donors.filter((d) => d.verificationStatus === 'verified').length}</strong>`,
    `Rejected documents: <strong>${state.donors.filter((d) => d.verificationStatus === 'rejected').length}</strong>`,
    `Active shortage alerts: <strong>${state.alerts.length}</strong>`,
    `Donor responses recorded: <strong>${totalResponses}</strong> (${accepted} accepted)`,
    `Hospitals onboarded: <strong>${Object.keys(state.hospitals).length}</strong>`,
  ].map((t) => `<div class="response-item">${t}</div>`).join('');

  document.getElementById('adminUsersDonorList').innerHTML = state.donors.length === 0
    ? '<p class="empty-state">No donors registered yet.</p>'
    : state.donors.map((d) => {
      const statusLabel = d.verificationStatus === 'verified' ? 'Verified' : d.verificationStatus === 'rejected' ? 'Rejected' : 'Pending';
      const statusClass = d.verificationStatus === 'verified' ? 'status-verified' : d.verificationStatus === 'rejected' ? 'status-rejected' : 'status-pending';
      return `<div class="list-row">
        <div><div class="lr-main">${d.name}</div><div class="lr-sub">${d.bloodGroup} · ${d.district} · NIC ${maskNIC(d.nic)} · ${maskPhone(d.phone)}</div></div>
        <span class="status-badge ${statusClass}">${statusLabel}</span>
        <span class="status-badge ${d.active !== false ? 'status-eligible' : 'status-ineligible'}">${d.active !== false ? 'Active' : 'Inactive'}</span>
      </div>`;
    }).join('');
  document.getElementById('adminUsersHospitalList').innerHTML = Object.keys(state.hospitals).length === 0
    ? '<p class="empty-state">No hospitals added yet.</p>'
    : Object.values(state.hospitals).map((h) => `
      <div class="list-row"><div><div class="lr-main">${h.name}</div><div class="lr-sub">Code: ${h.code} · ${h.district}</div></div></div>`).join('');

  const combinedUnits = Object.values(combinedInventory()).reduce((a, b) => a + b, 0);
  document.getElementById('adminStatGrid').innerHTML = [
    { label: 'Total Hospitals', value: Object.keys(state.hospitals).length, sub: 'Colombo District' },
    { label: 'Total Donors', value: (BASE.donors + state.donors.length).toLocaleString(), sub: 'across all hospitals' },
    { label: 'Total Blood Units', value: combinedUnits, sub: 'combined inventory' },
    { label: 'Active Alerts', value: state.alerts.length, sub: state.alerts.filter((a) => a.urgency === 'CRITICAL').length + ' critical' },
  ].map((s, i) => `<div class="stat-card ${i === 0 ? 'accent' : ''}"><div class="stat-label">${s.label}</div><div class="stat-value">${s.value}</div><div class="stat-sub">${s.sub}</div></div>`).join('');

  const ci = combinedInventory();
  document.getElementById('adminInventoryGrid').innerHTML = Object.entries(ci).map(([g, units]) => `
    <div class="inv-card">
      <div class="inv-group">${g}</div><div class="inv-count">${units}</div><div class="inv-units">units</div>
      <div class="inv-bar"><div class="inv-bar-fill ${invLevel(units)}" style="width:${invPct(units)}%"></div></div>
    </div>`).join('');
}

/* ============================================================
   INIT
   ============================================================ */
/* Open straight onto a role when the link says so, e.g. ?role=donor */
(function openRequestedRole() {
  const wanted = new URLSearchParams(location.search).get('role');
  if (['donor', 'hospital', 'admin'].includes(wanted)) switchRole(wanted);
}());

if (app) {
  refreshAdminPanels();
  refreshAll();
} else {
  renderAll();
}
