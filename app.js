// 共通テスト リスニング練習アプリ
// 問題PDF・音声MP3は端末内（IndexedDB）にだけ保存し、サーバーには送らない。
import * as pdfjs from './vendor/pdf.min.mjs';
pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

const YEARS = window.YEARS;
// 試験の種類ごとの大問構成
const KINDS = {
  kyotsu: { ids: ['1A', '1B', '2', '3', '4A', '4B', '5', '6A', '6B'], label: (id) => `第${id[0]}問${id.slice(1)}` },
  center: { ids: ['1', '2', '3', '4'], label: (id) => `第${id}問` },
};
const SPEEDS = [0.5, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];
const $ = (id) => document.getElementById(id);

/* ---------- 保存（設定・履歴は localStorage、素材は IndexedDB） ---------- */
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても動かす */ } },
};

let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('kyote-listening', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', mode);
    const req = fn(tx.objectStore('files'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
const fileKeys = () => idb('readonly', (s) => s.getAllKeys());
const fileGet = (key) => idb('readonly', (s) => s.get(key));
const filePut = (key, blob) => idb('readwrite', (s) => s.put(blob, key));
const fileDel = (key) => idb('readwrite', (s) => s.delete(key));

/* ---------- 状態 ---------- */
const state = {
  kind: store.get('kind', 'kyotsu'),
  years: new Set(store.get('years', [])),
  sections: { kyotsu: new Set(store.get('sections', [])), center: new Set(store.get('csections', [])) },
  speed: store.get('speed', 1.0),
  shuffle: store.get('shuffle', false),
  zoom: store.get('zoom', 1),
  have: new Set(),      // 端末にある素材（例: "2025.pdf"）
  queue: [],            // 出題する {year, section} の並び
  index: 0,
  answers: {},          // 問番号 → 選んだ番号
  graded: false,
  results: [],
};

/* ---------- 素材の読み込み ---------- */
// センター試験は元サイトから直接読み込むので、素材の準備は要らない
const hasYear = (y) => y.remote || (state.have.has(`${y.id}.pdf`) && state.have.has(`${y.id}.mp3`));
const LOCAL_YEARS = YEARS.filter((y) => !y.remote);
const kindYears = () => YEARS.filter((y) => y.kind === state.kind);
const kindSections = () => state.sections[state.kind];

async function refreshHave() {
  try { state.have = new Set(await fileKeys()); } catch { state.have = new Set(); }
}

// リポジトリの materials/ に素材が置かれている場合はそれを取り込む（置かれていなければ何もしない）
async function pullBundled() {
  if (!navigator.onLine || sessionStorage.getItem('bundledChecked')) return;
  sessionStorage.setItem('bundledChecked', '1');
  let found = false;
  for (const y of LOCAL_YEARS) {
    for (const ext of ['pdf', 'mp3']) {
      const key = `${y.id}.${ext}`;
      if (state.have.has(key)) continue;
      for (const name of [key, `${key}.${ext}`]) {
        try {
          const res = await fetch(`materials/${name}`);
          if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) continue;
          await filePut(key, await res.blob());
          found = true;
          break;
        } catch { /* オフラインなどは無視 */ }
      }
    }
  }
  if (found) { await refreshHave(); renderHome(); }
}

// ファイルがどの年度のものかを、サイズ→ファイル名の順で判定する
function identify(file) {
  const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
  const ext = isPdf ? 'pdf' : 'mp3';
  const bySize = LOCAL_YEARS.find((y) => y.sizes[ext] === file.size);
  if (bySize) return { year: bySize, ext };
  const m = file.name.match(/(?:^|\D)(?:20)?(2[1-9])(?:\D|$)/);
  const byName = m && LOCAL_YEARS.find((y) => y.id === `20${m[1]}`);
  return { year: byName || null, ext };
}

async function importFiles(files) {
  const done = [], unknown = [];
  for (const file of files) {
    const { year, ext } = identify(file);
    if (!year) { unknown.push(file.name); continue; }
    await filePut(`${year.id}.${ext}`, file);
    done.push(`${year.id}年 ${ext === 'pdf' ? '問題' : '音声'}`);
  }
  await refreshHave();
  renderHome();
  let msg = done.length ? `読み込みました：${done.join('、')}` : '';
  if (unknown.length) msg += `${msg ? '　' : ''}年度が分からなかったファイル：${unknown.join('、')}（下の年度ごとのボタンから選んでください）`;
  $('importMsg').textContent = msg;
  if (navigator.storage?.persist) navigator.storage.persist();
}

/* ---------- ホーム ---------- */
function chip(label, on, onClick, extraClass = '') {
  const b = document.createElement('button');
  b.className = `chip ${on ? 'on' : ''} ${extraClass}`;
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function renderHome() {
  for (const b of $('kindTabs').children) b.className = b.dataset.kind === state.kind ? 'on' : '';
  // 素材が全年度そろっていれば読み込み欄は出さない（欠けたときだけ予備として出す）
  $('materialsCard').hidden = state.kind !== 'kyotsu' || LOCAL_YEARS.every(hasYear);
  $('centerNote').hidden = state.kind !== 'center';
  const yc = $('yearChips'); yc.replaceChildren();
  for (const y of kindYears()) {
    yc.append(chip(y.short, state.years.has(y.id), () => { toggle(state.years, y.id); renderHome(); }, hasYear(y) ? '' : 'off-mat'));
  }
  const sc = $('sectionChips'); sc.replaceChildren();
  const secs = kindSections();
  for (const id of KINDS[state.kind].ids) {
    sc.append(chip(KINDS[state.kind].label(id), secs.has(id), () => { toggle(secs, id); renderHome(); }));
  }
  const sp = $('speedChips'); sp.replaceChildren();
  for (const s of SPEEDS) sp.append(chip(`${s}x`, state.speed === s, () => { setSpeed(s); renderHome(); }));
  $('shuffle').checked = state.shuffle;

  const mat = $('materials'); mat.replaceChildren();
  for (const y of LOCAL_YEARS) {
    const row = document.createElement('div'); row.className = 'mat-row';
    const name = document.createElement('span'); name.className = 'yr'; name.textContent = y.label;
    row.append(name);
    for (const [ext, label] of [['pdf', '問題'], ['mp3', '音声']]) {
      const key = `${y.id}.${ext}`;
      const b = document.createElement('button');
      const have = state.have.has(key);
      b.className = `mat-btn ${have ? 'have' : ''}`;
      b.textContent = have ? `${label} ✓` : `${label}を選ぶ`;
      b.onclick = () => pickSingle(key, ext, have);
      row.append(b);
    }
    mat.append(row);
  }

  const ready = kindYears().filter((y) => state.years.has(y.id) && hasYear(y));
  const missing = kindYears().filter((y) => state.years.has(y.id) && !hasYear(y));
  const sets = ready.length * secs.size;
  let text = sets ? `${ready.length}回分 × ${secs.size}大問 = ${sets}セット` : '年度と大問を選んでください';
  if (missing.length) text += `（${missing.map((y) => y.id).join('・')}年は素材が未読み込み）`;
  $('selSummary').textContent = text;
  $('startBtn').disabled = !sets;

  store.set('kind', state.kind);
  store.set('years', [...state.years]);
  store.set('sections', [...state.sections.kyotsu]);
  store.set('csections', [...state.sections.center]);
  renderHistory();
}

function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }

function pickSingle(key, ext, have) {
  if (have && !confirm('この素材を選び直しますか？（キャンセルでそのまま）')) return;
  const input = $('singleInput');
  input.accept = ext === 'pdf' ? '.pdf,application/pdf' : '.mp3,audio/mpeg';
  input.value = '';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    await filePut(key, f);
    await refreshHave();
    renderHome();
  };
  input.click();
}

function renderHistory() {
  const hist = store.get('history', []);
  $('historyCard').hidden = !hist.length;
  const box = $('history'); box.replaceChildren();
  for (const h of hist.slice(0, 12)) {
    const row = document.createElement('div'); row.className = 'hist-row';
    const a = document.createElement('span'); a.textContent = `${h.date}　${h.label}`;
    const b = document.createElement('span'); b.textContent = `${h.score}/${h.max}`;
    row.append(a, b); box.append(row);
  }
}

/* ---------- 採点 ---------- */
// 「全部正解の場合のみ得点」のグループに対応する
function grade(section, answers) {
  const grouped = new Set(section.groups.flatMap((g) => g.qs));
  let score = 0, max = 0;
  const perQ = {};
  for (const q of section.qs) {
    perQ[q.n] = answers[q.n] === q.a;
    if (grouped.has(q.n)) continue;
    max += q.p;
    if (perQ[q.n]) score += q.p;
  }
  for (const g of section.groups) {
    max += g.p;
    if (g.qs.every((n) => perQ[n])) score += g.p;
  }
  return { score, max, perQ };
}

/* ---------- 音声 ---------- */
const audio = $('audio');
let audioYear = null, audioUrl = null, seg = { start: 0, end: 0 };

async function loadAudio(year, section) {
  const key = section.audio || year.id;
  if (audioYear === key) return;
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  if (section.audio) {
    audio.src = section.audio;          // センター試験：大問ごとの音声を元サイトから読み込む
  } else {
    audioUrl = URL.createObjectURL(await fileGet(`${year.id}.mp3`));
    audio.src = audioUrl;
  }
  audioYear = key;
  await new Promise((resolve) => {
    if (audio.readyState >= 1) return resolve();
    audio.addEventListener('loadedmetadata', resolve, { once: true });
    audio.addEventListener('error', resolve, { once: true });
  });
}

function setSpeed(s) {
  state.speed = s;
  store.set('speed', s);
  audio.playbackRate = s;
  audio.preservesPitch = true;
  $('speedBtn').textContent = `${s.toFixed(s % 1 && (s * 10) % 1 ? 2 : 1)}x`;
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

function updatePlayer() {
  const len = Math.max(seg.end - seg.start, 1);
  const pos = Math.min(Math.max(audio.currentTime - seg.start, 0), len);
  if (!seeking) $('seek').value = Math.round((pos / len) * 1000);
  $('time').textContent = `${fmt(pos)}/${fmt(len)}`;
  $('playBtn').textContent = audio.paused ? '▶' : '❚❚';
}
let seeking = false;

let lineEnd = null;                  // セリフだけを再生しているときの終了位置
audio.addEventListener('timeupdate', () => {
  if (audio.currentTime >= seg.end) { audio.pause(); audio.currentTime = seg.end; }
  updatePlayer();
});
function watchLineEnd() {
  if (lineEnd == null) return;
  if (audio.paused) { lineEnd = null; return; }
  if (audio.currentTime >= lineEnd) { audio.pause(); lineEnd = null; return; }
  requestAnimationFrame(watchLineEnd);
}
function playLine(s, e) {
  audio.currentTime = Math.max(seg.start, s - 0.15);
  lineEnd = e + 0.3;
  audio.playbackRate = state.speed;
  audio.play().then(() => requestAnimationFrame(watchLineEnd)).catch(() => { lineEnd = null; });
}
audio.addEventListener('durationchange', () => {
  if (seg.whole && isFinite(audio.duration)) { seg.end = audio.duration; updatePlayer(); }
});
audio.addEventListener('play', updatePlayer);
audio.addEventListener('pause', updatePlayer);
audio.addEventListener('ratechange', () => { if (audio.playbackRate !== state.speed) audio.playbackRate = state.speed; });

function seekTo(t) { audio.currentTime = Math.min(Math.max(t, seg.start), seg.end - 0.05); updatePlayer(); }

$('playBtn').onclick = () => {
  lineEnd = null;
  if (audio.paused) {
    if (audio.currentTime >= seg.end - 0.1 || audio.currentTime < seg.start) audio.currentTime = seg.start;
    audio.playbackRate = state.speed;
    audio.play();
  } else audio.pause();
};
$('backBtn').onclick = () => seekTo(audio.currentTime - 5);
$('fwdBtn').onclick = () => seekTo(audio.currentTime + 5);
$('seek').addEventListener('input', () => { seeking = true; });
$('seek').addEventListener('change', (e) => {
  seeking = false;
  seekTo(seg.start + (e.target.value / 1000) * (seg.end - seg.start));
});
$('speedBtn').onclick = () => {
  const menu = $('speedMenu');
  menu.hidden = !menu.hidden;
  menu.replaceChildren(...SPEEDS.map((s) => {
    const b = document.createElement('button');
    b.textContent = `${s}x`;
    b.className = s === state.speed ? 'on' : '';
    b.onclick = () => { setSpeed(s); menu.hidden = true; };
    return b;
  }));
};

/* ---------- 問題PDFの表示 ---------- */
let pdfYear = null, pdfDoc = null, renderToken = 0;

async function loadPdf(year) {
  if (pdfYear === year.id) return;
  const blob = await fileGet(`${year.id}.pdf`);
  pdfDoc?.destroy();
  pdfDoc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
  pdfYear = year.id;
}

async function renderPages(section) {
  const token = ++renderToken;
  const box = $('pages');
  const wrap = $('problem');
  const cssWidth = Math.min(wrap.clientWidth - 16, 900) * state.zoom;
  if (section.images) {
    box.replaceChildren(...section.images.map((src) => {
      const img = new Image();
      img.src = src; img.alt = '問題'; img.style.width = `${cssWidth}px`;
      img.onerror = () => img.replaceWith(message('問題の画像を読み込めませんでした。ネット接続を確認してください。'));
      return img;
    }));
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const canvases = [];
  for (const n of section.pages) {
    const page = await pdfDoc.getPage(n);
    if (token !== renderToken) return;
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min((cssWidth * dpr) / base.width, 4);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${(cssWidth * vp.height) / vp.width}px`;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    if (token !== renderToken) return;
    canvases.push(canvas);
  }
  box.replaceChildren(...canvases);
}

function setZoom(z) {
  state.zoom = Math.min(Math.max(Math.round(z * 100) / 100, 0.6), 3);
  store.set('zoom', state.zoom);
  const cur = current();
  if (cur && (pdfDoc || cur.section.images)) return renderPages(cur.section);
}

/* ---------- 2本指でのズーム（ピンチ） ---------- */
{
  const wrap = $('problem'), pages = $('pages');
  let pinch = null;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  wrap.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    const r = wrap.getBoundingClientRect();
    const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
    const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
    // 指の中心が指している紙面上の位置を覚えておき、拡大後も同じ場所が指の下に来るようにする
    pinch = { d0: dist(e.touches), mx, my, cx: wrap.scrollLeft + mx, cy: wrap.scrollTop + my, ratio: 1 };
  }, { passive: true });
  wrap.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const raw = dist(e.touches) / pinch.d0;
    pinch.ratio = Math.min(Math.max(raw, 0.6 / state.zoom), 3 / state.zoom);
    pages.style.transform = `scale(${pinch.ratio})`;
    wrap.scrollLeft = pinch.cx * pinch.ratio - pinch.mx;
    wrap.scrollTop = pinch.cy * pinch.ratio - pinch.my;
  }, { passive: false });
  const end = async (e) => {
    if (!pinch || e.touches.length >= 2) return;
    const p = pinch; pinch = null;
    const before = state.zoom;
    if (Math.abs(p.ratio - 1) > 0.02) await setZoom(before * p.ratio);   // 仮の拡大を、くっきりした描画に置き換える
    const k = state.zoom / before;
    pages.style.transform = '';
    wrap.scrollLeft = p.cx * k - p.mx;
    wrap.scrollTop = p.cy * k - p.my;
  };
  wrap.addEventListener('touchend', end);
  wrap.addEventListener('touchcancel', end);
}
$('zoomIn').onclick = () => setZoom(state.zoom * 1.25);
$('zoomOut').onclick = () => setZoom(state.zoom / 1.25);

/* ---------- 演習 ---------- */
const current = () => state.queue[state.index];

function show(id) {
  for (const s of ['home', 'practice', 'result']) $(s).hidden = s !== id;
  window.scrollTo(0, 0);
}

function buildQueue() {
  const q = [];
  for (const y of kindYears()) {
    if (!state.years.has(y.id) || !hasYear(y)) continue;
    for (const s of y.sections) if (kindSections().has(s.id)) q.push({ year: y, section: s });
  }
  if (state.shuffle) for (let i = q.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [q[i], q[j]] = [q[j], q[i]];
  }
  return q;
}

const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
let audioUnlocked = false;
function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  audioYear = null;
  audio.src = SILENCE;
  audio.play().then(() => audio.pause()).catch(() => {});
}

async function startQueue(queue) {
  unlockAudio();
  state.queue = queue;
  state.index = 0;
  state.results = [];
  show('practice');
  await openSet();
}

async function openSet() {
  const { year, section } = current();
  state.answers = {};
  state.graded = false;
  audio.pause();
  $('speedMenu').hidden = true;
  $('pTitle').textContent = `${year.short} ${section.label}`;
  $('pProgress').textContent = `${state.index + 1}/${state.queue.length}`;
  $('setScore').textContent = '';
  $('gradeBtn').textContent = '採点する';
  state.dict = { inputs: {}, results: {} };
  setView('problem');
  $('scriptBtn').hidden = true;
  renderAnswers();
  $('pages').replaceChildren(message('問題を読み込んでいます…'));
  $('problem').scrollTo(0, 0);
  try {
    await loadAudio(year, section);
    seg = section.audio
      ? { start: 0, end: isFinite(audio.duration) ? audio.duration : 3600, whole: true }
      : { start: section.start, end: Math.min(section.end, audio.duration || section.end) };
    audio.currentTime = seg.start;
    setSpeed(state.speed);
    updatePlayer();
    // 問題を開いたら自動で再生する（ブラウザに止められた場合は再生ボタンで始められる）
    if (current()?.section === section) audio.play().catch(() => {});
  } catch (e) { console.error(e); }
  try {
    if (!section.images) await loadPdf(year);
    await renderPages(section);
  } catch (e) {
    console.error(e);
    $('pages').replaceChildren(message('問題PDFを表示できませんでした。ホームで素材を選び直してください。'));
  }
}

function message(text) {
  const d = document.createElement('div'); d.className = 'msg'; d.textContent = text; return d;
}

function renderAnswers(result) {
  const { section } = current();
  const box = $('answers'); box.replaceChildren();
  const groupOf = (n) => section.groups.find((g) => g.qs.includes(n));
  for (const q of section.qs) {
    const row = document.createElement('div'); row.className = 'q-row';
    const no = document.createElement('div'); no.className = 'q-no'; no.textContent = `問${q.n}`;
    if (result) { no.classList.add(result.perQ[q.n] ? 'ok' : 'ng'); no.textContent += result.perQ[q.n] ? ' ○' : ' ×'; }
    const opts = document.createElement('div'); opts.className = 'opts';
    for (let i = 1; i <= q.c; i++) {
      const b = document.createElement('button');
      b.className = 'opt'; b.textContent = CIRCLED[i - 1];
      const chosen = state.answers[q.n] === i;
      if (result) {
        b.disabled = true;
        if (i === q.a) b.classList.add('correct');
        else if (chosen) b.classList.add('wrong');
      } else {
        if (chosen) b.classList.add('sel');
        b.onclick = () => { state.answers[q.n] = chosen ? undefined : i; renderAnswers(); };
      }
      opts.append(b);
    }
    row.append(no, opts); box.append(row);
    const g = groupOf(q.n);
    if (g && g.qs[g.qs.length - 1] === q.n) {
      const note = document.createElement('div'); note.className = 'group-note';
      note.textContent = `問${g.qs[0]}〜${q.n}は全部正解で${g.p}点`;
      box.append(note);
    }
  }
}

$('gradeBtn').onclick = async () => {
  const { year, section } = current();
  if (!state.graded) {
    const blank = section.qs.filter((q) => !state.answers[q.n]).length;
    if (blank && !confirm(`未回答が${blank}問あります。採点しますか？`)) return;
    audio.pause();
    const r = grade(section, state.answers);
    state.graded = true;
    state.results.push({ year, section, answers: { ...state.answers }, ...r });
    renderAnswers(r);
    $('setScore').textContent = `${r.score} / ${r.max} 点`;
    $('scriptBtn').hidden = !section.page;      // 台本ページがある大問だけ、採点後に見られる
    $('gradeBtn').textContent = state.index + 1 < state.queue.length ? '次へ' : '結果を見る';
    return;
  }
  if (state.index + 1 < state.queue.length) { state.index++; await openSet(); }
  else finish();
};

/* ---------- 台本とディクテーション ---------- */
// 台本：元サイトのページを問題エリアに表示する
// ディクテーション：セリフ（1人の1回分の発話）ごとに聞き取って入力し、採点する
let SCRIPTS = null, view = 'problem';
async function loadScripts() {
  if (!SCRIPTS) {
    try { SCRIPTS = await (await fetch('scripts.json')).json(); } catch { SCRIPTS = {}; }
  }
  return SCRIPTS;
}
const curLines = () => {
  const c = current();
  return (c && SCRIPTS?.[`${c.year.id}|${c.section.id}`]) || [];
};

function setView(mode) {
  const frame = $('scriptFrame');
  const page = current()?.section.page;
  if (mode !== 'problem' && !page) mode = 'problem';
  view = mode;
  if (mode === 'script' && frame.dataset.page !== page) { frame.src = page; frame.dataset.page = page; }
  if (mode === 'problem' && frame.dataset.page) { frame.removeAttribute('src'); delete frame.dataset.page; }
  frame.hidden = mode !== 'script';
  $('pages').hidden = mode !== 'problem';
  $('dict').hidden = mode !== 'dict';
  $('scriptBar').hidden = mode === 'problem' || !curLines().length;
  $('problem').classList.toggle('script', mode === 'script');
  $('problem').classList.toggle('dict-mode', mode === 'dict');
  $('scriptBtn').textContent = mode === 'problem' ? '台本' : '問題';
  $('dictBtn').textContent = mode === 'dict' ? '台本を見る' : 'ディクテーション';
  if (mode === 'dict') renderDict();
  updateDictScore();
}
$('scriptBtn').onclick = async () => {
  if (view === 'problem') { await loadScripts(); setView('script'); } else setView('problem');
};
$('dictBtn').onclick = () => setView(view === 'dict' ? 'script' : 'dict');

// 単語に分ける（大文字小文字・記号の違いは無視し、数字と英単語の数は同じとみなす）
const NUMS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const TENS = { thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
function norm(w) {
  w = w.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9'%$]/g, '').replace(/^'+|'+$/g, '');
  const i = NUMS.indexOf(w);
  if (i >= 0) return String(i);
  if (w in TENS) return String(TENS[w]);
  return w;
}
const words = (text) => text.replace(/(\d),(\d)/g, '$1$2').split(/[\s\-–—―－/]+/).map(norm).filter(Boolean);

// 正解の各単語が、入力のどこかで（順番どおりに）聞き取れていたかを調べる（最長共通部分列）
function compare(expected, typed) {
  const n = expected.length, m = typed.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = expected[i] === typed[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const hit = new Array(n).fill(false);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (expected[i] === typed[j]) { hit[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return hit;
}

function gradeLine(idx) {
  const line = curLines()[idx];
  const typed = words(state.dict.inputs[idx] || '');
  // 元の単語ごとに、その中の語がすべて聞き取れていれば正解として色を付ける
  const orig = line.text.split(/\s+/);
  const parts = orig.map((w) => words(w));
  const flat = parts.flat();
  const hit = compare(flat, typed);
  let k = 0;
  const marks = parts.map((p) => { const ok = p.every((_, i) => hit[k + i]); k += p.length; return p.length ? ok : true; });
  const hits = hit.filter(Boolean).length;
  state.dict.results[idx] = { orig, marks, hits, total: flat.length };
}

function renderDict() {
  const box = $('dict');
  const lines = curLines();
  box.replaceChildren();
  const note = document.createElement('p');
  note.className = 'd-note';
  note.textContent = '▶で1セリフずつ再生できます（再生速度は上の設定が使われます）。聞こえた英語を入力して「採点」を押してください。大文字・記号の違いは無視します。';
  box.append(note);
  let lastQ = null;
  lines.forEach((line, idx) => {
    if (line.q !== lastQ) {
      const h = document.createElement('div'); h.className = 'd-qhead';
      h.textContent = `Question No. ${line.q}`;
      box.append(h); lastQ = line.q;
    }
    const card = document.createElement('div'); card.className = 'd-line';
    const head = document.createElement('div'); head.className = 'd-head';
    const spk = document.createElement('span'); spk.className = 'd-spk'; spk.textContent = line.spk || '―';
    const no = document.createElement('span'); no.className = 'd-no'; no.textContent = `${idx + 1} / ${lines.length}`;
    const play = document.createElement('button'); play.className = 'd-play'; play.textContent = '▶ 再生';
    if (line.s == null) { play.disabled = true; play.textContent = '再生不可'; }
    play.onclick = () => playLine(line.s, line.e);
    head.append(spk, no, play);
    const ta = document.createElement('textarea');
    Object.assign(ta, { rows: 2, placeholder: '聞こえた英語を入力', spellcheck: false });
    ta.setAttribute('autocapitalize', 'off'); ta.setAttribute('autocorrect', 'off'); ta.setAttribute('autocomplete', 'off');
    ta.value = state.dict.inputs[idx] || '';
    ta.oninput = () => { state.dict.inputs[idx] = ta.value; };
    const actions = document.createElement('div'); actions.className = 'd-actions';
    const check = document.createElement('button'); check.className = 'd-check'; check.textContent = '採点';
    const showBtn = document.createElement('button'); showBtn.textContent = '答えを見る';
    const result = document.createElement('div'); result.className = 'd-result';
    const paint = () => {
      const r = state.dict.results[idx];
      result.replaceChildren();
      card.classList.toggle('done', !!r && r.hits === r.total);
      if (!r) return;
      r.orig.forEach((w, i) => {
        const sp = document.createElement('span');
        sp.className = r.shown ? 'shown' : r.marks[i] ? 'hit' : 'miss';
        sp.textContent = w;
        result.append(sp, ' ');
      });
      if (!r.shown) {
        const rate = document.createElement('span'); rate.className = 'd-rate';
        rate.textContent = r.hits === r.total ? `完璧！ ${r.total}/${r.total}語` : `${r.hits}/${r.total}語（${Math.round((r.hits / r.total) * 100)}%）　赤：聞き取れなかった語`;
        result.append(rate);
      }
    };
    check.onclick = () => { gradeLine(idx); paint(); updateDictScore(); };
    showBtn.onclick = () => {
      if (!state.dict.results[idx]) state.dict.results[idx] = { orig: line.text.split(/\s+/), shown: true, hits: 0, total: 0 };
      paint(); updateDictScore();
    };
    actions.append(check, showBtn);
    card.append(head, ta, actions, result);
    box.append(card);
    paint();
  });
}

function updateDictScore() {
  const rs = Object.values(state.dict?.results || {}).filter((r) => !r.shown);
  const hits = rs.reduce((a, r) => a + r.hits, 0), total = rs.reduce((a, r) => a + r.total, 0);
  $('dictScore').textContent = view === 'dict' && total ? `${rs.length}セリフ採点済み　正答率 ${Math.round((hits / total) * 100)}%` : '';
}

$('quitBtn').onclick = () => {
  if (!state.results.length) {
    if (!confirm('練習をやめてホームに戻りますか？')) return;
    audio.pause(); show('home'); renderHome(); return;
  }
  if (confirm('ここまでの結果を表示して終わりますか？')) finish();
};

function finish() {
  audio.pause();
  const total = state.results.reduce((a, r) => a + r.score, 0);
  const max = state.results.reduce((a, r) => a + r.max, 0);
  $('resultTotal').textContent = `合計 ${total} / ${max} 点（${max ? Math.round((total / max) * 100) : 0}%）`;
  const list = $('resultList'); list.replaceChildren();
  for (const r of state.results) {
    const card = document.createElement('div'); card.className = 'res-card';
    const head = document.createElement('div'); head.className = 'res-head';
    const a = document.createElement('span'); a.textContent = `${r.year.short} ${r.section.label}`;
    const b = document.createElement('span'); b.textContent = `${r.score}/${r.max}`;
    head.append(a, b);
    const qs = document.createElement('div'); qs.className = 'res-q';
    for (const q of r.section.qs) {
      const d = document.createElement('div');
      const mine = r.answers[q.n];
      if (!r.perQ[q.n]) d.className = 'ng';
      d.textContent = r.perQ[q.n] ? `問${q.n} ${CIRCLED[q.a - 1]}` : `問${q.n} ${mine ? CIRCLED[mine - 1] : '–'}→${CIRCLED[q.a - 1]}`;
      qs.append(d);
    }
    card.append(head, qs);
    if (r.section.page) {
      const link = document.createElement('a');
      link.className = 'res-link'; link.href = r.section.page; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = '台本を元サイトで見る ↗';
      card.append(link);
    }
    list.append(card);
  }
  $('retryWrongBtn').hidden = !state.results.some((r) => r.score < r.max);

  if (state.results.length) {
    const hist = store.get('history', []);
    const d = new Date();
    const years = [...new Set(state.results.map((r) => r.year.short))].join('・');
    const secs = [...new Set(state.results.map((r) => r.section.label))];
    hist.unshift({
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      label: `${years} ${secs.length > 2 ? `${secs.length}大問` : secs.join('・')}`,
      score: total, max,
    });
    store.set('history', hist.slice(0, 50));
  }
  show('result');
}

$('retryWrongBtn').onclick = () => startQueue(state.results.filter((r) => r.score < r.max).map(({ year, section }) => ({ year, section })));
$('homeBtn').onclick = () => { show('home'); renderHome(); };
$('startBtn').onclick = () => startQueue(buildQueue());
$('clearHistory').onclick = () => { if (confirm('結果の記録を消しますか？')) { store.set('history', []); renderHistory(); } };
for (const b of $('kindTabs').children) b.onclick = () => { state.kind = b.dataset.kind; renderHome(); };
$('shuffle').onchange = (e) => { state.shuffle = e.target.checked; store.set('shuffle', state.shuffle); };
$('importBtn').onclick = () => { $('importInput').value = ''; $('importInput').click(); };
$('importInput').onchange = (e) => importFiles([...e.target.files]);
for (const b of document.querySelectorAll('[data-all]')) {
  b.onclick = () => {
    const [set, all] = b.dataset.all === 'years' ? [state.years, kindYears().map((y) => y.id)] : [kindSections(), KINDS[state.kind].ids];
    const full = all.every((v) => set.has(v));
    all.forEach((v) => (full ? set.delete(v) : set.add(v)));
    renderHome();
  };
}

/* ---------- 上下の境界をドラッグして高さを変える ---------- */
{
  const divider = $('divider'), bottom = $('bottom');
  const saved = store.get('bottomH', null);
  if (saved) bottom.style.height = `${saved}px`;
  const MIN = 64;                       // たたんだときの高さ（採点ボタンだけ残る）
  let startY = 0, startH = 0, moved = false;
  let openH = saved && saved > MIN + 40 ? saved : null;   // 開いているときの高さ
  divider.addEventListener('pointerdown', (e) => {
    startY = e.clientY; startH = bottom.offsetHeight; moved = false;
    divider.setPointerCapture(e.pointerId);
  });
  divider.addEventListener('pointermove', (e) => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    if (Math.abs(e.clientY - startY) > 6) moved = true;
    if (!moved) return;
    const h = Math.min(Math.max(startH + (startY - e.clientY), MIN), window.innerHeight * 0.8);
    bottom.style.height = `${h}px`;
  });
  divider.addEventListener('pointerup', () => {
    if (!moved) {
      // タップ：たたむ ⇄ 開く
      const collapsed = bottom.offsetHeight <= MIN + 40;
      if (!collapsed) openH = bottom.offsetHeight;
      bottom.style.height = collapsed ? `${openH || Math.round(window.innerHeight * 0.42)}px` : `${MIN}px`;
    } else if (bottom.offsetHeight > MIN + 40) openH = bottom.offsetHeight;
    store.set('bottomH', bottom.offsetHeight);
  });
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (!$('practice').hidden && current() && (pdfDoc || current().section.images)) renderPages(current().section); }, 250);
});

/* ---------- 起動 ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
await refreshHave();
setSpeed(SPEEDS.includes(state.speed) ? state.speed : 1.0);
renderHome();
pullBundled();
