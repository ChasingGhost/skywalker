'use strict';

// ---------- Constants ----------
const LUX_PER_FC = 10.7639;
const ASSUMED_PHONE_APERTURE = 1.8; // typical phone main lens; calibration absorbs the difference
const MID_GREY = 0.18;              // linear reflectance a reflected meter targets
const INCIDENT_C = 2.5;             // lux = 2.5 * 2^EV100 (calibration constant C = 250)
const HISTORY_LEN = 120;

const APERTURES = [1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3, 7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 32];
const SHUTTERS = [30, 25, 20, 15, 13, 10, 8, 6, 5, 4, 3.2, 2.5, 2, 1.6, 1.3, 1, 0.8, 0.6, 0.5, 0.4, 0.3,
  1 / 4, 1 / 5, 1 / 6, 1 / 8, 1 / 10, 1 / 13, 1 / 15, 1 / 20, 1 / 25, 1 / 30, 1 / 40, 1 / 50, 1 / 60, 1 / 80,
  1 / 100, 1 / 125, 1 / 160, 1 / 200, 1 / 250, 1 / 320, 1 / 400, 1 / 500, 1 / 640, 1 / 800, 1 / 1000,
  1 / 1250, 1 / 1600, 1 / 2000, 1 / 2500, 1 / 3200, 1 / 4000, 1 / 5000, 1 / 6400, 1 / 8000];
const ISOS = [50, 64, 80, 100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 12800, 25600];

const GUIDE = [
  { name: 'Hallway / stairs', min: 100, max: 200 },
  { name: 'Living room', min: 150, max: 300 },
  { name: 'Bedroom', min: 100, max: 300 },
  { name: 'Office / desk work', min: 300, max: 500 },
  { name: 'Classroom', min: 300, max: 500 },
  { name: 'Reading', min: 300, max: 750 },
  { name: 'Kitchen counter', min: 300, max: 750 },
  { name: 'Retail / store', min: 500, max: 1000 },
  { name: 'Detailed work / crafts', min: 750, max: 1500 },
  { name: 'Video calls / streaming', min: 500, max: 1500 },
  { name: 'Plants: low light', min: 500, max: 2500 },
  { name: 'Plants: medium light', min: 2500, max: 10000 },
  { name: 'Plants: bright light', min: 10000, max: 50000 },
];

const LEVELS = [
  [1, 'Very dark'], [50, 'Dim'], [300, 'Indoor'], [1000, 'Bright indoor'],
  [10000, 'Overcast'], [50000, 'Daylight'], [Infinity, 'Direct sun'],
];

// ---------- Storage helpers (never let storage failures break the app) ----------
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// ---------- State ----------
const settings = Object.assign({
  unit: 'lux', smoothing: 0.3, sourcePref: 'auto', wake: 'on', calib: 0,
  iso: 100, expMode: 'aperture', aperture: 8, shutter: 1 / 125, nd: 0, comp: 0,
  meterMode: 'average', facing: 'environment', guidePreset: 3,
}, load('slm.settings', {}));

const state = {
  running: false,
  held: false,
  source: null,     // 'sensor' | 'camera'
  quality: null,    // 'good' | 'ok' | 'weak'
  rawEv: null,      // smoothed EV100 before calibration
  stats: { min: Infinity, max: -Infinity, sum: 0, n: 0 },
  history: [],
  log: load('slm.log', []),
};

const cam = { stream: null, track: null, timer: null, manual: false, exp: 0, expMin: 0, expMax: 0, iso: 100, settle: 0 };
let sensor = null;
let wakeLock = null;

const $ = (id) => document.getElementById(id);

// ---------- Math ----------
const log2 = Math.log2;
const evToLux = (ev) => INCIDENT_C * Math.pow(2, ev);
const luxToEv = (lux) => log2(Math.max(lux, 1e-4) / INCIDENT_C);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function nearest(list, value) {
  let best = list[0], bestD = Infinity;
  for (const v of list) {
    const d = Math.abs(log2(v / value));
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

function currentEv() {
  return state.rawEv == null ? null : state.rawEv + settings.calib;
}

// ---------- Formatting ----------
function fmtNum(v) {
  if (v == null || !isFinite(v)) return '--';
  if (v >= 1000) return Math.round(v).toLocaleString();
  if (v >= 10) return String(Math.round(v));
  if (v >= 1) return v.toFixed(1);
  return v.toFixed(2);
}
function fmtLight(lux) {
  return fmtNum(settings.unit === 'fc' ? lux / LUX_PER_FC : lux);
}
function fmtShutter(t) {
  if (t >= 1) return `${+t.toFixed(1)}"`;
  return `1/${Math.round(1 / t)}`;
}
function fmtAperture(n) { return `f/${n}`; }
function levelName(lux) {
  for (const [limit, name] of LEVELS) if (lux < limit) return name;
  return '';
}

// ---------- Measuring: ambient light sensor ----------
function startSensor() {
  return new Promise((resolve) => {
    if (!('AmbientLightSensor' in window)) return resolve(false);
    try {
      sensor = new AmbientLightSensor({ frequency: 5 });
      let started = false;
      sensor.addEventListener('reading', () => {
        if (!started) { started = true; resolve(true); }
        onLux(sensor.illuminance, 'sensor', 'good');
      });
      sensor.addEventListener('error', () => {
        stopSensor();
        if (!started) resolve(false);
      });
      sensor.start();
      setTimeout(() => { if (!started) { stopSensor(); resolve(false); } }, 2500);
    } catch {
      sensor = null;
      resolve(false);
    }
  });
}
function stopSensor() {
  if (sensor) { try { sensor.stop(); } catch { /* ignore */ } }
  sensor = null;
}

// ---------- Measuring: camera ----------
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return false;
  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: settings.facing }, width: { ideal: 320 }, height: { ideal: 240 } },
    });
  } catch {
    return false;
  }
  cam.track = cam.stream.getVideoTracks()[0];
  const video = $('video');
  video.srcObject = cam.stream;
  await video.play().catch(() => {});
  $('video').parentElement.classList.add('show');
  await lockExposure();
  cam.timer = setInterval(sampleFrame, 150);
  return true;
}

// Lock the camera exposure where the browser allows it. A locked exposure lets
// us turn pixel brightness into real light levels; auto exposure hides them.
async function lockExposure() {
  cam.manual = false;
  const caps = cam.track.getCapabilities ? cam.track.getCapabilities() : {};
  if (!caps.exposureMode || !caps.exposureMode.includes('manual') || !caps.exposureTime) return;
  cam.expMin = caps.exposureTime.min;
  cam.expMax = caps.exposureTime.max;
  cam.exp = clamp(100, cam.expMin, cam.expMax); // units of 100 µs -> 10 ms
  const adv = { exposureMode: 'manual', exposureTime: cam.exp };
  if (caps.iso) {
    cam.iso = clamp(100, caps.iso.min, caps.iso.max);
    adv.iso = cam.iso;
  }
  try {
    await cam.track.applyConstraints({ advanced: [adv] });
    cam.manual = true;
    cam.settle = 3;
  } catch { /* stay on auto */ }
}

async function setExposureTime(exp) {
  cam.exp = clamp(exp, cam.expMin, cam.expMax);
  try { await cam.track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureTime: cam.exp }] }); } catch { /* ignore */ }
  cam.settle = 3; // skip a few frames while the sensor catches up
}

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function sampleFrame() {
  const video = $('video');
  if (!video.videoWidth) return;
  const canvas = $('sample');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  let x0 = 0, y0 = 0, w = canvas.width, h = canvas.height;
  if (settings.meterMode === 'spot') {
    w = Math.round(canvas.width * 0.22);
    h = w;
    x0 = Math.round((canvas.width - w) / 2);
    y0 = Math.round((canvas.height - h) / 2);
  }
  const px = ctx.getImageData(x0, y0, w, h).data;
  let sum = 0, clipped = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i] > 250 || px[i + 1] > 250 || px[i + 2] > 250) clipped++;
    sum += 0.2126 * srgbToLinear(px[i]) + 0.7152 * srgbToLinear(px[i + 1]) + 0.0722 * srgbToLinear(px[i + 2]);
  }
  const y = Math.max(sum / n, 1e-5);

  if (cam.settle > 0) { cam.settle--; return; }

  const s = cam.track.getSettings ? cam.track.getSettings() : {};
  const exp = cam.manual ? cam.exp : s.exposureTime;
  const iso = cam.manual ? cam.iso : s.iso;

  // Auto-range the locked exposure so the frame stays in a measurable band.
  if (cam.manual) {
    if ((y > 0.6 || clipped / n > 0.2) && cam.exp > cam.expMin) return void setExposureTime(cam.exp / 4);
    if (y < 0.01 && cam.exp < cam.expMax) return void setExposureTime(cam.exp * 4);
  }

  if (exp && iso) {
    const t = exp * 1e-4;
    const ev = log2(ASSUMED_PHONE_APERTURE ** 2 / t) - log2(iso / 100) + log2(y / MID_GREY);
    onEv(ev, 'camera', 'ok');
  } else {
    // The browser hides exposure details: only a rough, relative estimate is possible.
    const ev = log2(ASSUMED_PHONE_APERTURE ** 2 * 60) + log2(y / MID_GREY);
    onEv(ev, 'camera', 'weak');
  }
}

function stopCamera() {
  clearInterval(cam.timer);
  cam.timer = null;
  if (cam.stream) cam.stream.getTracks().forEach((t) => t.stop());
  cam.stream = null;
  cam.track = null;
  $('video').srcObject = null;
  $('video').parentElement.classList.remove('show');
}

// ---------- Readings pipeline ----------
function onLux(lux, source, quality) { onEv(luxToEv(lux), source, quality); }

function onEv(ev, source, quality) {
  if (!isFinite(ev)) return;
  state.source = source;
  state.quality = quality;
  if (state.held) return;
  const k = Number(settings.smoothing);
  // Smooth in EV (log space) so dim and bright light respond equally fast.
  state.rawEv = state.rawEv == null ? ev : state.rawEv + k * (ev - state.rawEv);

  const lux = evToLux(currentEv());
  const st = state.stats;
  st.min = Math.min(st.min, lux);
  st.max = Math.max(st.max, lux);
  st.sum += lux;
  st.n++;
  state.history.push(currentEv());
  if (state.history.length > HISTORY_LEN) state.history.shift();
  render();
}

async function start() {
  $('startBtn').disabled = true;
  let ok = false;
  if (settings.sourcePref !== 'camera') ok = await startSensor();
  if (ok) state.source = 'sensor';
  else if (settings.sourcePref !== 'sensor' && (ok = await startCamera())) state.source = 'camera';
  $('startBtn').disabled = false;
  if (!ok) {
    $('hint').textContent = settings.sourcePref === 'sensor'
      ? 'This device or browser does not expose a light sensor. Switch the light source to Automatic or Camera in Settings.'
      : 'Could not access the light sensor or the camera. Allow camera access for this site, then try again.';
    return;
  }
  state.running = true;
  $('startBtn').textContent = 'Stop';
  $('holdBtn').disabled = false;
  $('saveBtn').disabled = false;
  $('hint').textContent = state.source === 'camera'
    ? 'Point the camera at the scene or toward the light. Use Spot metering to measure one subject.'
    : 'Using the ambient light sensor, usually near the top edge of the screen. Keep it uncovered.';
  if (settings.wake === 'on') requestWake();
  render();
}

function stop() {
  stopSensor();
  stopCamera();
  state.running = false;
  state.held = false;
  $('startBtn').textContent = 'Start';
  $('holdBtn').disabled = true;
  $('holdBtn').classList.remove('active-hold');
  $('holdBtn').textContent = 'Hold';
  releaseWake();
  render();
}

async function requestWake() {
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { wakeLock = null; }
}
function releaseWake() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running && settings.wake === 'on') requestWake();
});

// ---------- Rendering ----------
function render() {
  const ev = currentEv();
  const lux = ev == null ? null : evToLux(ev);

  const badge = $('sourceBadge');
  if (!state.running) {
    badge.className = 'badge badge-off';
    badge.textContent = 'Not measuring';
  } else if (state.source === 'sensor') {
    badge.className = 'badge badge-good';
    badge.textContent = 'Light sensor';
  } else if (state.quality === 'weak') {
    badge.className = 'badge badge-weak';
    badge.textContent = 'Camera: rough estimate';
  } else {
    badge.className = 'badge badge-ok';
    badge.textContent = settings.calib ? 'Camera: calibrated' : 'Camera';
  }

  $('mainValue').textContent = lux == null ? '--' : fmtLight(lux);
  $('mainValue').classList.toggle('held', state.held);
  $('mainUnit').textContent = settings.unit === 'fc' ? 'foot-candles' : 'lux';
  $('evValue').textContent = ev == null ? '--' : ev.toFixed(1);
  $('altLabel').textContent = settings.unit === 'fc' ? 'lux' : 'foot-candles';
  $('altValue').textContent = lux == null ? '--' : fmtNum(settings.unit === 'fc' ? lux : lux / LUX_PER_FC);
  $('levelValue').textContent = lux == null ? '--' : levelName(lux);

  const st = state.stats;
  $('minValue').textContent = st.n ? fmtLight(st.min) : '--';
  $('avgValue').textContent = st.n ? fmtLight(st.sum / st.n) : '--';
  $('maxValue').textContent = st.n ? fmtLight(st.max) : '--';

  drawGauge(lux);
  drawHistory();
  renderExposure();
  renderGuide(lux);
}

// Gauge spans 0.1 lx to 100,000 lx on a log scale.
function drawGauge(lux) {
  const c = $('gauge');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height, cx = W / 2, cy = H - 10, r = 130;
  ctx.clearRect(0, 0, W, H);
  const a0 = Math.PI, a1 = 2 * Math.PI;
  const grad = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
  grad.addColorStop(0, '#2b3a67');
  grad.addColorStop(0.5, '#ffb020');
  grad.addColorStop(1, '#fff3c4');
  ctx.lineWidth = 14;
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#2f3440';
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();

  ctx.fillStyle = '#9aa1ad';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  [0.1, 1, 10, 100, 1000, 10000, 100000].forEach((v, i) => {
    const a = a0 + (i / 6) * Math.PI;
    const label = v >= 1000 ? `${v / 1000}k` : String(v);
    ctx.fillText(label, cx + Math.cos(a) * (r - 26), cy + Math.sin(a) * (r - 26) + 4);
  });

  if (lux == null) return;
  const f = clamp((Math.log10(lux) + 1) / 6, 0, 1);
  ctx.strokeStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + f * Math.PI); ctx.stroke();
}

function drawHistory() {
  const c = $('history');
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  const hist = state.history;
  if (hist.length < 2) return;
  let lo = Math.min(...hist), hi = Math.max(...hist);
  if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1; }
  ctx.strokeStyle = '#ffb020';
  ctx.lineWidth = 3;
  ctx.beginPath();
  hist.forEach((ev, i) => {
    const x = (i / (HISTORY_LEN - 1)) * W;
    const y = H - 10 - ((ev - lo) / (hi - lo)) * (H - 20);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ---------- Exposure calculator ----------
function exposureEv() {
  if ($('evManualToggle').checked) {
    const v = parseFloat($('evManual').value);
    return isFinite(v) ? v : null;
  }
  return currentEv();
}

function renderExposure() {
  const ev100 = exposureEv();
  $('evUsed').textContent = ev100 == null ? '--' : ev100.toFixed(1);
  const body = $('equivBody');
  if (ev100 == null) {
    $('expResult').textContent = '--';
    $('expWarn').textContent = 'Start the meter or enter an EV by hand.';
    body.innerHTML = '';
    return;
  }
  // Settings EV: higher ISO needs less light; compensation and ND need more exposure.
  const evs = ev100 + log2(settings.iso / 100) - settings.comp - settings.nd;
  const pow = Math.pow(2, evs);

  let N, t;
  if (settings.expMode === 'aperture') {
    N = settings.aperture;
    t = (N * N) / pow;
  } else {
    t = settings.shutter;
    N = Math.sqrt(t * pow);
  }
  const tStd = nearest(SHUTTERS, t);
  const nStd = nearest(APERTURES, N);
  $('expResult').textContent = `${fmtAperture(nStd)} · ${fmtShutter(tStd)} · ISO ${settings.iso}`;

  const warns = [];
  if (t > 30) warns.push('Longer than 30 s: use Bulb mode, a wider aperture or higher ISO.');
  else if (t > 1 / 30) warns.push('Slow shutter: use a tripod or steady support.');
  if (t < 1 / 8000) warns.push('Faster than 1/8000: stop down, lower ISO or add ND.');
  if (N < APERTURES[0] || N > APERTURES[APERTURES.length - 1]) warns.push('Aperture outside normal lens range: change ISO or shutter.');
  $('expWarn').textContent = warns.join(' ');

  body.innerHTML = APERTURES.filter((a) => a >= 1.4 && a <= 22)
    .map((a) => {
      const tt = (a * a) / pow;
      const cls = a === nStd ? ' class="current"' : '';
      const shown = tt > 30 ? `${Math.round(tt)}" (bulb)` : tt < 1 / 8000 ? '< 1/8000' : fmtShutter(nearest(SHUTTERS, tt));
      return `<tr${cls}><td>${fmtAperture(a)}</td><td>${shown}</td></tr>`;
    }).join('');
}

// ---------- Guide ----------
function renderGuide(lux) {
  const p = GUIDE[settings.guidePreset];
  const el = $('guideVerdict');
  el.className = 'verdict';
  if (lux == null || !p) {
    el.textContent = 'Start the meter to compare.';
    return;
  }
  const range = `${p.min.toLocaleString()}–${p.max.toLocaleString()} lux`;
  const now = `${fmtNum(lux)} lux`;
  if (lux < p.min) {
    el.classList.add('low');
    el.textContent = `${now}: too dark for ${p.name.toLowerCase()} (recommended ${range}).`;
  } else if (lux > p.max) {
    el.classList.add('high');
    el.textContent = `${now}: brighter than needed for ${p.name.toLowerCase()} (recommended ${range}).`;
  } else {
    el.classList.add('good');
    el.textContent = `${now}: right for ${p.name.toLowerCase()} (recommended ${range}).`;
  }
}

// ---------- Log ----------
function renderLog() {
  const list = $('logList');
  $('logEmpty').classList.toggle('hidden', state.log.length > 0);
  list.innerHTML = '';
  state.log.slice().reverse().forEach((r) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const lv = document.createElement('div');
    lv.className = 'lv';
    lv.textContent = `${fmtNum(r.lux)} lux · EV ${r.ev.toFixed(1)}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${new Date(r.t).toLocaleString()} · ${r.source}${r.note ? ' · ' + r.note : ''}`;
    info.append(lv, meta);
    const del = document.createElement('button');
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      state.log = state.log.filter((x) => x !== r);
      store('slm.log', state.log);
      renderLog();
    });
    li.append(info, del);
    list.append(li);
  });
}

function exportCsv() {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const rows = [['time', 'lux', 'foot_candles', 'ev100', 'source', 'note']].concat(
    state.log.map((r) => [new Date(r.t).toISOString(), r.lux.toFixed(2), (r.lux / LUX_PER_FC).toFixed(2), r.ev.toFixed(2), r.source, r.note || '']),
  );
  const csv = rows.map((r) => r.map(esc).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `light-readings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Wiring ----------
function fillSelect(el, items, fmt, selected) {
  el.innerHTML = items.map((v, i) => `<option value="${i}">${fmt(v)}</option>`).join('');
  const idx = items.indexOf(selected);
  el.value = String(idx >= 0 ? idx : 0);
}

function saveSettings() { store('slm.settings', settings); }

function init() {
  // Tabs
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    if (b.dataset.tab === 'log') renderLog();
  }));

  // Meter controls
  $('startBtn').addEventListener('click', () => (state.running ? stop() : start()));
  $('holdBtn').addEventListener('click', () => {
    state.held = !state.held;
    $('holdBtn').classList.toggle('active-hold', state.held);
    $('holdBtn').textContent = state.held ? 'Release' : 'Hold';
    render();
  });
  $('resetBtn').addEventListener('click', () => {
    state.stats = { min: Infinity, max: -Infinity, sum: 0, n: 0 };
    state.history = [];
    render();
  });
  $('saveBtn').addEventListener('click', () => {
    const ev = currentEv();
    if (ev == null) return;
    const note = window.prompt('Add a note (optional), e.g. "kitchen counter"', '') ?? null;
    if (note === null) return;
    state.log.push({ t: Date.now(), lux: evToLux(ev), ev, source: state.source, note: note.trim() });
    store('slm.log', state.log);
    $('saveBtn').textContent = 'Saved ✓';
    setTimeout(() => { $('saveBtn').textContent = 'Save reading'; }, 1200);
  });

  $('meterMode').value = settings.meterMode;
  $('spotRing').classList.toggle('hidden', settings.meterMode !== 'spot');
  $('meterMode').addEventListener('change', (e) => {
    settings.meterMode = e.target.value;
    $('spotRing').classList.toggle('hidden', settings.meterMode !== 'spot');
    saveSettings();
  });
  $('facing').value = settings.facing;
  $('facing').addEventListener('change', async (e) => {
    settings.facing = e.target.value;
    saveSettings();
    if (state.running && state.source === 'camera') { stopCamera(); await startCamera(); }
  });

  // Exposure controls
  fillSelect($('iso'), ISOS, (v) => v, settings.iso);
  fillSelect($('aperture'), APERTURES, fmtAperture, settings.aperture);
  fillSelect($('shutter'), SHUTTERS, fmtShutter, nearest(SHUTTERS, settings.shutter));
  fillSelect($('nd'), [0, 1, 2, 3, 4, 6, 10, 13, 15], (v) => (v ? `${v} (ND${2 ** v})` : 'None'), settings.nd);
  $('iso').addEventListener('change', (e) => { settings.iso = ISOS[e.target.value]; saveSettings(); renderExposure(); });
  $('aperture').addEventListener('change', (e) => { settings.aperture = APERTURES[e.target.value]; saveSettings(); renderExposure(); });
  $('shutter').addEventListener('change', (e) => { settings.shutter = SHUTTERS[e.target.value]; saveSettings(); renderExposure(); });
  $('nd').addEventListener('change', (e) => { settings.nd = [0, 1, 2, 3, 4, 6, 10, 13, 15][e.target.value]; saveSettings(); renderExposure(); });
  $('comp').value = settings.comp;
  $('comp').addEventListener('input', (e) => { settings.comp = parseFloat(e.target.value) || 0; saveSettings(); renderExposure(); });
  const syncMode = () => {
    $('apertureWrap').classList.toggle('hidden', settings.expMode !== 'aperture');
    $('shutterWrap').classList.toggle('hidden', settings.expMode !== 'shutter');
  };
  $('expMode').value = settings.expMode;
  syncMode();
  $('expMode').addEventListener('change', (e) => { settings.expMode = e.target.value; syncMode(); saveSettings(); renderExposure(); });
  $('evManualToggle').addEventListener('change', (e) => { $('evManual').disabled = !e.target.checked; renderExposure(); });
  $('evManual').addEventListener('input', renderExposure);

  // Guide
  $('guideBody').innerHTML = GUIDE.map((g) => `<tr><td>${g.name}</td><td>${g.min.toLocaleString()}–${g.max.toLocaleString()}</td></tr>`).join('');
  $('guidePreset').innerHTML = GUIDE.map((g, i) => `<option value="${i}">${g.name}</option>`).join('');
  $('guidePreset').value = String(settings.guidePreset);
  $('guidePreset').addEventListener('change', (e) => { settings.guidePreset = Number(e.target.value); saveSettings(); render(); });

  // Log
  $('exportBtn').addEventListener('click', exportCsv);
  $('clearLogBtn').addEventListener('click', () => {
    if (!state.log.length || !window.confirm('Delete all saved readings?')) return;
    state.log = [];
    store('slm.log', state.log);
    renderLog();
  });

  // Settings
  $('unit').value = settings.unit;
  $('unit').addEventListener('change', (e) => { settings.unit = e.target.value; saveSettings(); render(); });
  $('smoothing').value = String(settings.smoothing);
  $('smoothing').addEventListener('change', (e) => { settings.smoothing = Number(e.target.value); saveSettings(); });
  $('sourcePref').value = settings.sourcePref;
  $('sourcePref').addEventListener('change', (e) => { settings.sourcePref = e.target.value; saveSettings(); if (state.running) { stop(); start(); } });
  $('wake').value = settings.wake;
  $('wake').addEventListener('change', (e) => {
    settings.wake = e.target.value;
    saveSettings();
    if (settings.wake === 'on' && state.running) requestWake(); else releaseWake();
  });

  const syncCalib = () => {
    $('calibOffset').value = settings.calib.toFixed(2);
    $('calibStatus').textContent = settings.calib
      ? `Readings are corrected by ${settings.calib > 0 ? '+' : ''}${settings.calib.toFixed(2)} stops (×${Math.pow(2, settings.calib).toFixed(2)}).`
      : 'Not calibrated.';
  };
  syncCalib();
  $('calibBtn').addEventListener('click', () => {
    const known = parseFloat($('calibLux').value);
    if (state.rawEv == null) { $('calibStatus').textContent = 'Start the meter first, then calibrate.'; return; }
    if (!(known > 0)) { $('calibStatus').textContent = 'Enter the known light level in lux.'; return; }
    settings.calib = luxToEv(known) - state.rawEv;
    saveSettings();
    syncCalib();
    render();
  });
  $('calibReset').addEventListener('click', () => { settings.calib = 0; saveSettings(); syncCalib(); render(); });
  $('calibOffset').addEventListener('change', (e) => {
    settings.calib = parseFloat(e.target.value) || 0;
    saveSettings();
    syncCalib();
    render();
  });

  render();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
