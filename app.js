import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STR, LANGS, pickLang } from './i18n.js?v=10';
import { initTour } from './tours.js?v=1';

const $ = s => document.querySelector(s);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SCALE = 10;

// ───────────── language ─────────────
const lang = pickLang(), T = { ...STR.en, ...STR[lang] };
document.documentElement.lang = lang;
const year = y => y < 0 ? `${T.circa} ${-y} ${T.bce}` : y < 1500 ? `${T.circa} ${y} ${T.ce}` : `${y}`;
const path = k => k.split('.').reduce((o, p) => o?.[p], T);
document.querySelectorAll('[data-t]').forEach(el => { el.textContent = path(el.dataset.t); });
document.querySelectorAll('[data-th]').forEach(el => { el.innerHTML = path(el.dataset.th); });
$('#h1').innerHTML = `${esc(T.h1[0])}<br>${esc(T.h1[1])} <em>${esc(T.h1[2])}</em>`;
$('#q').placeholder = T.placeholder;
document.querySelectorAll('[data-a]').forEach(el => { el.setAttribute('aria-label', T.aria[el.dataset.a]); });
$('#lang').innerHTML = Object.entries(LANGS).map(([k, v]) => `<option value="${k}"${k === lang ? ' selected' : ''}>${v}</option>`).join('');
$('#lang').addEventListener('change', e => { try { localStorage.setItem('lang', e.target.value); } catch {} const u = new URL(location.href); u.searchParams.set('lang', e.target.value); u.hash = ''; location.href = u; });

const topNav = $('#topNav'), menuBtn = $('#menuBtn');
function closeMenu() {
  if (!topNav.classList.contains('open')) return;
  topNav.classList.remove('open');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.textContent = '☰';
}
menuBtn.addEventListener('click', e => {
  e.stopPropagation();
  const open = topNav.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.textContent = open ? '×' : '☰';
});
$('#navLinks').addEventListener('click', e => { if (e.target.closest('a')) closeMenu(); });
document.addEventListener('click', e => { if (!e.target.closest('#topNav')) closeMenu(); });

// ───────────── data ─────────────
const status = $('#status');
const [corpus, extra, vecBuf, posBuf] = await Promise.all([
  fetch('data/corpus.json').then(r => r.json()),
  fetch('data/themes.json').then(r => r.json()),
  fetch('data/vec.bin').then(r => r.arrayBuffer()),
  fetch('data/pos.bin').then(r => r.arrayBuffer()),
]);
const { trads, books, passages: P } = corpus;
const N = P.length, VEC = new Int8Array(vecBuf), POS = new Float32Array(posBuf), D = VEC.length / N, MODEL = extra.model;
const ERAS = [
  { max: -200, color: '#e8a855' },
  { max: 600, color: '#e86f52' },
  { max: 1500, color: '#d96ba0' },
  { max: 1800, color: '#9b7fe6' },
  { max: 1900, color: '#4fb6c9' },
  { max: Infinity, color: '#6ee094' },
];
const eraOf = i => { const y = books[P[i][0]].year; return ERAS.findIndex(e => y <= e.max); };
let colorMode = 'trad'; // 'trad' | 'age'
const tradOf = i => books[P[i][0]].trad;
const groupOf = i => colorMode === 'age' ? eraOf(i) : tradOf(i);
const colorOf = i => colorMode === 'age' ? ERAS[eraOf(i)].color : trads[tradOf(i)].color;
const tradName = t => (T.trads && T.trads[t]) || trads[t].name;
const place = p => T.places[p] || p;
$('#eyebrow').textContent = T.eyebrow(N.toLocaleString(lang), books.length);

// similarity of a query vector with every passage
function scoreAll(q) {
  const s = new Float32Array(N);
  for (let i = 0, o = 0; i < N; i++) { let a = 0; for (let k = 0; k < D; k++) a += q[k] * VEC[o++]; s[i] = a; }
  return s;
}
const vecOf = i => VEC.subarray(i * D, (i + 1) * D);
function ranked(q) {
  const s = scoreAll(q), idx = Array.from({ length: N }, (_, i) => i).sort((a, b) => s[b] - s[a]);
  return { idx, s, meaning: true };
}
// take the best passages, but keep many different voices
function diverse(idx, k, { perBook = 2, perTrad = 3, skip = () => false } = {}) {
  const nb = {}, nt = {}, out = [];
  for (const i of idx) {
    if (skip(i)) continue;
    const b = P[i][0], t = books[b].trad;
    if ((nb[b] || 0) >= perBook || (nt[t] || 0) >= perTrad) continue;
    nb[b] = (nb[b] || 0) + 1; nt[t] = (nt[t] || 0) + 1; out.push(i);
    if (out.length >= k) break;
  }
  return out;
}

// ───────────── the models (in a worker) ─────────────
let modelReady = false, modelFailed = false, started = false, waiting = null, reqId = 0, worker = null;
const pending = new Map();
const mb = x => Math.round(x / 1048576);
const call = msg => new Promise((resolve, reject) => { const id = ++reqId; pending.set(id, { resolve, reject }); getWorker().postMessage({ ...msg, id }); });
const quillHTML = msg => `<span class="quill-work"><span class="quill-anim" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><g class="q-pen"><path d="M20.2 3.8c-3.6-.5-7.8 1.4-10.6 4.2L5 12.6 3.5 19.5l6.9-1.5 4.6-4.6c2.8-2.8 4.7-7 4.2-10.6Z"/><path d="M19.5 4.5 3.5 20.5"/></g><path class="q-ink" d="M3.5 21.8h15"/></svg></span><span class="quill-msg">${esc(msg)}</span></span>`;
function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js?v=3', { type: 'module' });
  worker.onerror = () => fail();
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'progress') status.textContent = T.s_progress(mb(m.loaded), mb(m.total));
    else if (m.type === 'trprogress') {
      if (m.loaded < m.total) {
        const txt = T.s_trload(mb(m.loaded), mb(m.total));
        status.innerHTML = quillHTML(txt);
        document.querySelectorAll('.quill-msg').forEach(el => { el.textContent = txt; });
      }
    }
    else if (m.type === 'ready') { modelReady = true; setReady(); if (waiting) { const w = waiting; waiting = null; ask(w); } }
    else if (m.type === 'error') fail();
    else if (m.type === 'result') { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(m.error) : p.resolve(m.value); }
  };
  return worker;
}
function setReady() { status.textContent = T.s_ready; status.classList.add('ok'); }
function startModel() {
  if (started) return; started = true;
  status.textContent = T.s_loading(MODEL.sizeMB);
  try { getWorker().postMessage({ type: 'init', model: MODEL }); } catch { fail(); }
}
function fail() {
  modelFailed = true; status.classList.remove('ok'); status.textContent = T.s_failed;
  for (const p of pending.values()) p.reject('worker failed'); pending.clear();
  if (waiting) { const w = waiting; waiting = null; ask(w); }
}
const embed = text => call({ type: 'embed', text });
function keywordRank(text) {
  const words = [...new Set(text.toLowerCase().match(/[a-z]{4,}/g) || [])];
  const s = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = P[i][2].toLowerCase(); let a = 0; for (const w of words) if (t.includes(w)) a++; s[i] = a / Math.sqrt(60 + t.length); }
  return { idx: Array.from({ length: N }, (_, i) => i).sort((a, b) => s[b] - s[a]), s, meaning: false };
}

// ───────────── translation, on the device ─────────────
// First choice: the translator that is built into the browser. Second choice: a small model in the worker.
const native = {};
const limit = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
async function translate(text, from, to) {
  if ('Translator' in self) {
    try {
      const key = `${from}-${to}`;
      if (!(key in native)) {
        // Some browsers have this interface but never answer. Then we stop and use the worker.
        const a = await limit(self.Translator.availability({ sourceLanguage: from, targetLanguage: to }), 2500);
        native[key] = a === 'unavailable' ? null : await limit(self.Translator.create({ sourceLanguage: from, targetLanguage: to }), 30000);
      }
      if (native[key]) return await limit(native[key].translate(text), 30000);
    } catch { native[`${from}-${to}`] = null; }
  }
  return call({ type: 'translate', pair: `${from}-${to}`, text });
}
const trCache = new Map();
async function translatePassage(i, box) {
  const quote = box.querySelector('blockquote'), btn = box.querySelector('.acts [data-act="tr"]');
  const existing = box.querySelector(':scope > .mt');
  if (existing) {
    if (existing.dataset.busy) return;
    if (existing.dataset.fail) existing.remove();
    else {
      const show = existing.hidden;
      existing.hidden = !show;
      quote.textContent = show ? trCache.get(i) : P[i][2];
      btn?.classList.toggle('on', show);
      return;
    }
  }
  btn?.classList.add('on');
  const english = P[i][2];
  quote.style.opacity = 0.45;
  const note = document.createElement('div'); note.className = 'mt'; note.dataset.busy = '1'; note.innerHTML = quillHTML(T.translating); quote.after(note);
  try {
    if (!trCache.has(i)) trCache.set(i, await translate(english, 'en', lang));
    delete note.dataset.busy;
    quote.textContent = trCache.get(i);
    note.innerHTML = `<div class="ex-head"><span>${esc(books[P[i][0]].tr ? T.mt_note : T.mt_note_en)}</span><button type="button" class="ex-fold" data-act="tr" aria-label="${esc(T.aria.close)}">−</button></div><details><summary>${esc(T.original)}</summary><p>${esc(english)}</p></details>`;
  } catch { delete note.dataset.busy; note.dataset.fail = '1'; note.textContent = T.tr_fail; btn?.classList.remove('on'); }
  quote.style.opacity = 1;
  if (modelReady) setReady();
}
const trButton = () => lang === 'en' ? '' : `<button data-act="tr">${esc(T.translate)}</button>`;

// ───────────── plain-language explanations ─────────────
// Written before, one per passage, in data/explain.json. The file loads on the first request.
const exButton = () => `<button data-act="ex">${esc(T.explain)}</button>`;
let explainData = null;
const exCache = new Map();
async function explainPassage(i, box) {
  const btn = box.querySelector('.acts [data-act="ex"], :scope > [data-act="ex"]');
  const existing = box.querySelector(':scope > .ex');
  if (existing) {
    if (existing.dataset.busy) return;
    if (existing.dataset.fail) existing.remove();
    else {
      existing.hidden = !existing.hidden;
      btn?.classList.toggle('on', !existing.hidden);
      return;
    }
  }
  btn?.classList.add('on');
  const el = document.createElement('div'); el.className = 'ex'; el.dataset.busy = '1'; el.innerHTML = quillHTML(T.ex_loading);
  (box.querySelector(':scope > .note') || box.querySelector('.cite')).after(el);
  let english;
  try {
    explainData ??= fetch('data/explain.json?v=3').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    english = (await explainData)[i];
  } catch { explainData = null; }
  delete el.dataset.busy;
  if (!english) { el.dataset.fail = '1'; el.textContent = T.ex_fail; btn?.classList.remove('on'); return; }
  const show = (text, extra = '') => { el.innerHTML = `<div class="ex-head"><b>${esc(T.ex_label)}</b><button type="button" class="ex-fold" data-act="ex" data-i="${i}" aria-label="${esc(T.aria.close)}">−</button></div><p>${esc(text)}</p>${extra}`; };
  if (lang === 'en') { show(english); return; }
  el.dataset.busy = '1';
  show(english, `<div class="mt">${quillHTML(T.translating)}</div>`);
  try {
    if (!exCache.has(i)) exCache.set(i, await translate(english, 'en', lang));
    delete el.dataset.busy;
    show(exCache.get(i), `<div class="mt">${esc(T.ex_mt)}<details><summary>${esc(T.ex_original)}</summary><p>${esc(english)}</p></details></div>`);
  } catch { delete el.dataset.busy; show(english); }
}

// ───────────── answers ─────────────
let current = null;
const cardsEl = $('#cards');
function cardHTML(i, delay = 0) {
  const [b, cite, text] = P[i], bk = books[b], t = trads[bk.trad];
  return `<article class="card" style="--c:${t.color};animation-delay:${delay}ms" data-i="${i}">
    <div class="trad">${esc(tradName(bk.trad))} · ${esc(place(bk.place))} · ${year(bk.year)}</div>
    <blockquote class="${text.length > 480 ? 'long' : ''}">${esc(text)}</blockquote>
    <div class="cite"><b>${esc(bk.author)}</b> — ${esc(cite)}${bk.tr ? `<div class="tr">${esc(T.translated_by)} ${esc(bk.tr)}</div>` : ''}</div>
    <div class="acts">${exButton()}${trButton()}<button data-act="echo">${esc(T.echoes)}</button><button data-act="map">${esc(T.onmap)}</button><a href="https://www.gutenberg.org/ebooks/${bk.pg}" target="_blank" rel="noopener">${esc(T.source)}</a></div>
  </article>`;
}
const CRISIS = /suicid|suizid|selbstmord|kill myself|end my life|want to die|wish i was dead|not want to live|don'?t want to live|self[- ]?harm|hurt myself|quitarme la vida|matarme|no quiero vivir|me tuer|envie de mourir|en finir avec la vie|plus envie de vivre|umbringen|nicht mehr leben|sterben will/i;
function showAnswers(text, r, english) {
  current = r;
  $('#answers').hidden = false;
  $('#answersBody').hidden = false;
  const fold = document.querySelector('[data-fold="answersBody"]');
  if (fold) { fold.textContent = '−'; fold.setAttribute('aria-expanded', 'true'); }
  $('#asked').textContent = `“${text}”`;
  $('#crisis').hidden = !CRISIS.test(text + ' ' + (english || ''));
  cardsEl.innerHTML = '';
  r.used = new Set();
  addCards(9);
  const top = [...r.used];
  $('#how').textContent = (r.meaning ? T.how(N.toLocaleString(lang)) : T.how_kw) + (english ? ' ' + T.how_tr(english) : '');
  drawTimeline(top);
  highlight(r.idx.slice(0, 160), top);
  $('#answers').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function addCards(k) {
  const r = current; const pick = diverse(r.idx, k, { skip: i => r.used.has(i) || P[i][2].length < 70 });
  pick.forEach((i, n) => { r.used.add(i); cardsEl.insertAdjacentHTML('beforeend', cardHTML(i, n * 70)); });
}
function drawTimeline(list) {
  const x = y => ((y + 600) / 2550) * 100;
  const ticks = [-500, 0, 500, 1000, 1500, 1900].map(y => `<i style="left:${x(y)}%">${y < 0 ? `${-y} ${T.bce}` : y === 0 ? `1 ${T.ce}` : y}</i>`).join('');
  const seen = new Set();
  const dots = list.filter(i => !seen.has(P[i][0]) && seen.add(P[i][0])).map(i => { const b = books[P[i][0]]; return `<b style="left:${x(b.year)}%;--c:${trads[b.trad].color}" data-i="${i}"><span>${esc(b.author.split(' (')[0])}</span></b>`; }).join('');
  $('#timeline').innerHTML = ticks + dots;
}
async function ask(text) {
  text = text.trim(); if (!text) return;
  if (!modelReady && !modelFailed) { waiting = text; startModel(); status.textContent = T.s_wait; return; }
  if (modelFailed) return showAnswers(text, keywordRank(text));
  let english = null;
  if (lang !== 'en') {
    status.classList.remove('ok'); status.innerHTML = quillHTML(T.s_trq);
    try { english = await translate(text, lang, 'en'); } catch { english = null; }
    setReady();
  }
  try { showAnswers(text, ranked(await embed(english || text)), english); } catch { showAnswers(text, keywordRank(english || text), english); }
}
$('#form').addEventListener('submit', e => { e.preventDefault(); ask($('#q').value); });
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask($('#q').value); } });
$('#q').addEventListener('focus', startModel, { once: true });
setTimeout(startModel, 2500);
$('#more').addEventListener('click', () => addCards(6));
const exText = i => (T.examples && T.examples[i]) || extra.examples[i].text;
$('#examples').innerHTML = extra.examples.map((e, i) => `<button data-e="${i}">${esc(exText(i))}</button>`).join('');
$('#examples').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const i = +b.dataset.e; $('#q').value = exText(i); showAnswers(exText(i), ranked(extra.examples[i].vec)); });
status.textContent = T.s_open;

document.addEventListener('click', e => {
  const foldBtn = e.target.closest('[data-fold]');
  if (foldBtn) {
    const body = document.getElementById(foldBtn.dataset.fold);
    if (body) {
      const open = body.hidden;
      body.hidden = !open;
      foldBtn.textContent = open ? '−' : '+';
      foldBtn.setAttribute('aria-expanded', String(open));
    }
    return;
  }
  const debHead = e.target.closest('[data-fold-debate]');
  if (debHead) {
    const sides = debHead.nextElementSibling, btn = debHead.querySelector('.sec-fold');
    if (sides) {
      const open = sides.hidden;
      sides.hidden = !open;
      if (btn) { btn.textContent = open ? '−' : '+'; btn.setAttribute('aria-expanded', String(open)); }
    }
    return;
  }
  const act = e.target.closest('[data-act]'); const host = e.target.closest('[data-i]');
  if (!host) return; const i = +host.dataset.i;
  if (act && act.dataset.act === 'ex') explainPassage(i, act.closest('.card, .drawer-main, .side'));
  else if (act && act.dataset.act === 'tr') translatePassage(i, act.closest('.card, .drawer-main'));
  else if (act && act.dataset.act === 'map') { $('#map').scrollIntoView({ behavior: 'smooth' }); flyTo(i); openDrawer(i); }
  else if (act || host.matches('.timeline b, .echo, .side blockquote')) openDrawer(i);
});

// ───────────── drawer: one passage and its echoes ─────────────
const drawer = $('#drawer');
function openDrawer(i) {
  const [b, cite, text] = P[i], bk = books[b], t = trads[bk.trad];
  const r = ranked(vecOf(i));
  const echoes = diverse(r.idx, 6, { perBook: 1, perTrad: 2, skip: j => j === i || tradOf(j) === bk.trad || P[j][2].length < 70 });
  $('#drawerBody').innerHTML = `<div class="drawer-main" style="--c:${t.color}" data-i="${i}"><div class="trad">${esc(tradName(bk.trad))} · ${esc(place(bk.place))} · ${year(bk.year)}</div>
    <blockquote>${esc(text)}</blockquote>
    <div class="cite"><b>${esc(bk.author)}</b> — ${esc(cite)}</div>
    <div class="note">${bk.tr ? `${esc(T.Translated_by)} ${esc(bk.tr)}. ` : ''}<a href="https://www.gutenberg.org/ebooks/${bk.pg}" target="_blank" rel="noopener">${esc(T.readfull)}</a></div>
    <div class="acts">${exButton()}${trButton()}</div></div>
    <h5>${esc(T.echoes)}</h5><p class="note">${esc(T.other_peoples)}</p>
    ${echoes.map(j => { const k = books[P[j][0]], tt = trads[k.trad]; return `<div class="echo" style="--c:${tt.color}" data-i="${j}"><p>${esc(P[j][2].length > 420 ? P[j][2].slice(0, 400).replace(/\s\S*$/, '') + '…' : P[j][2])}</p><small><b>${esc(tradName(k.trad))}</b> · ${esc(k.author)} — ${esc(P[j][1])} · ${year(k.year)}</small></div>`; }).join('')}`;
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); drawer.scrollTop = 0;
  highlight(r.idx.slice(0, 60), [i, ...echoes]);
  select(i);
}
$('#closeDrawer').addEventListener('click', () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); });
addEventListener('keydown', e => { if (e.key === 'Escape') { $('#closeDrawer').click(); closeMenu(); } });

// ───────────── disagreements ─────────────
const debTitle = di => (T.debates && T.debates[di][0]) || extra.debates[di].title;
const sideLabel = (di, si) => (T.debates && T.debates[di][1][si]) || extra.debates[di].sides[si].label;
$('#debates').innerHTML = extra.debates.map((d, di) => `<div class="debate"><div class="debate-head" data-fold-debate><h3>${esc(debTitle(di))}</h3><button type="button" class="sec-fold" aria-expanded="true" aria-label="${esc(T.aria.close)}">−</button></div><div class="sides">${d.sides.map((s, si) => sideHTML(di, si, 0)).join('')}</div></div>`).join('');
function sideHTML(di, si, n) {
  const s = extra.debates[di].sides[si], i = s.picks[n % s.picks.length], bk = books[P[i][0]], t = trads[bk.trad];
  return `<div class="side" style="--c:${t.color}" data-d="${di}" data-s="${si}" data-n="${n}"><h4>${esc(sideLabel(di, si))}</h4><div class="who">${esc(bk.author.split(' (')[0])} · ${esc(tradName(bk.trad))}</div>
    <blockquote data-i="${i}">${esc(P[i][2])}</blockquote><div class="cite">${esc(P[i][1])} · ${year(bk.year)}</div><button data-act="ex" data-i="${i}">${esc(T.explain)}</button>${s.picks.length > 1 ? `<button data-next>${esc(T.another)}</button>` : ''}</div>`;
}
$('#debates').addEventListener('click', e => { if (!e.target.matches('[data-next]')) return; const el = e.target.closest('.side'); el.outerHTML = sideHTML(+el.dataset.d, +el.dataset.s, +el.dataset.n + 1); });

// ───────────── library ─────────────
$('#books').innerHTML = books.map((b, i) => ({ b, i })).sort((x, y) => x.b.year - y.b.year).map(({ b }) => `<div class="book" style="--c:${trads[b.trad].color}"><i></i><div class="t"><b>${esc(b.work)}</b> · ${esc(b.author)}<small>${year(b.year)} · ${esc(place(b.place))} · ${esc(tradName(b.trad))}${b.tr ? ` · ${esc(T.translated_by)} ${esc(b.tr)}` : ''}</small></div><a class="n" href="https://www.gutenberg.org/ebooks/${b.pg}" target="_blank" rel="noopener">${b.n} ${esc(T.passages)}</a></div>`).join('');

fetch('https://thelongconversation.goatcounter.com/counter/TOTAL.json')
  .then(r => r.ok ? r.json() : null)
  .then(d => { if (d && d.count_unique) $('.foot').textContent += ` · ${T.visitors}: ${d.count_unique}`; })
  .catch(() => {});

// ───────────── the 3D map ─────────────
const canvas = $('#sky');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(0x090b12);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
const homeVec = () => new THREE.Vector3(5, 2.2, 17).multiplyScalar(innerWidth < 800 ? 1.35 : 1);
const HOME = homeVec(); camera.position.copy(HOME);
const controls = new OrbitControls(camera, canvas);
Object.assign(controls, { enableZoom: false, enablePan: false, enableDamping: true, dampingFactor: 0.06, rotateSpeed: 0.5, autoRotate: true, autoRotateSpeed: 0.35, minDistance: 2.5, maxDistance: 40 });
controls.touches.ONE = THREE.TOUCH.ROTATE;
controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
canvas.style.touchAction = 'pan-y'; // 1-finger vertical swipe scrolls the page; horizontal drag or 2 fingers turn/pinch-zoom the map

const geo = new THREE.BufferGeometry();
const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N), hi = new Float32Array(N), vis = new Float32Array(N).fill(1);
const tc = trads.map(t => new THREE.Color(t.color)), ec = ERAS.map(e => new THREE.Color(e.color));
for (let i = 0; i < N; i++) {
  for (let k = 0; k < 3; k++) pos[i * 3 + k] = POS[i * 3 + k] * SCALE;
  const c = tc[tradOf(i)]; col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  size[i] = 0.75 + ((i * 2654435761 >>> 0) % 1000) / 1000 * 0.7;
}
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
geo.setAttribute('aHi', new THREE.BufferAttribute(hi, 1));
geo.setAttribute('aVis', new THREE.BufferAttribute(vis, 1));
const mat = new THREE.ShaderMaterial({
  uniforms: { uPx: { value: 1 }, uDim: { value: 0 }, uTime: { value: 0 } },
  vertexShader: `attribute vec3 color; attribute float aSize, aHi, aVis; uniform float uPx, uDim, uTime; varying vec3 vC; varying float vA;
    void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
      float tw = 0.82 + 0.18 * sin(uTime * 1.3 + position.x * 37.0 + position.y * 17.0);
      gl_PointSize = uPx * aSize * mix(1.0, 3.4, aHi) * tw / -mv.z;
      vC = mix(color, vec3(1.0, 0.96, 0.84), aHi * 0.45);
      vA = aVis * mix(mix(0.85, 0.13, uDim), 1.6, aHi); }`,
  fragmentShader: `varying vec3 vC; varying float vA; void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); a = a * a * (0.6 + 0.4 * a) + smoothstep(0.12, 0.0, d) * 0.6; gl_FragColor = vec4(vC * a * vA, 1.0); }`,
  blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true,
});
scene.add(new THREE.Points(geo, mat));

// far background dust
{
  const n = 1800, p = new Float32Array(n * 3); let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < n; i++) { const r = 45 + rnd() * 50, a = rnd() * 6.283, z = rnd() * 2 - 1, q = Math.sqrt(1 - z * z); p.set([r * q * Math.cos(a), r * z, r * q * Math.sin(a)], i * 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x5a6078, size: 0.16, sizeAttenuation: true, transparent: true, opacity: 0.7, depthTest: false })));
}
// threads between the passages of one answer
const threadGeo = new THREE.BufferGeometry();
const threadMat = new THREE.LineBasicMaterial({ color: 0xe8b86d, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthTest: false });
const threads = new THREE.LineSegments(threadGeo, threadMat);
threads.frustumCulled = false; // prevent stale empty boundingSphere from culling rotated networks
scene.add(threads);
// ring around the selected passage
const ring = new THREE.Mesh(new THREE.RingGeometry(0.2, 0.23, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide }));
ring.visible = false; ring.frustumCulled = false; scene.add(ring);

let dimTarget = 0;
function highlight(glow, strong) {
  hi.fill(0);
  glow.forEach((i, n) => { hi[i] = Math.max(hi[i], 0.5 * (1 - n / glow.length) + 0.12); });
  strong.forEach(i => { hi[i] = 1; });
  geo.attributes.aHi.needsUpdate = true; dimTarget = 1;
  const seg = [];
  for (let a = 1; a < strong.length; a++) { const i = strong[0], j = strong[a]; seg.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]); }
  for (let a = 1; a + 1 < strong.length; a++) { const i = strong[a], j = strong[a + 1]; seg.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]); }
  threadGeo.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
  threadGeo.computeBoundingSphere();
}
function clearHighlight() { hi.fill(0); geo.attributes.aHi.needsUpdate = true; dimTarget = 0; threadGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3)); ring.visible = false; }
function select(i) { ring.position.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); ring.visible = true; }

// camera moves
let fly = null, dist = HOME.length();
function flyTo(i) {
  const mob = innerWidth <= 720;
  const p = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1] - (mob ? 1.1 : 0), pos[i * 3 + 2]);
  fly = { target: p, dist: mob ? 9 : 7 }; controls.autoRotate = false;
}
$('#zin').onclick = () => { fly = { target: controls.target.clone(), dist: Math.max(2.5, dist * 0.65) }; };
$('#zout').onclick = () => { fly = { target: controls.target.clone(), dist: Math.min(40, dist / 0.65) }; };
$('#zreset').onclick = () => { fly = { target: new THREE.Vector3(), dist: homeVec().length() }; controls.autoRotate = true; clearHighlight(); };
canvas.addEventListener('touchstart', () => { controls.enableZoom = true; }, { passive: true });
canvas.addEventListener('wheel', e => { controls.enableZoom = false; if (!e.ctrlKey) return; e.preventDefault(); fly = { target: controls.target.clone(), dist: Math.min(40, Math.max(2.5, dist * (e.deltaY > 0 ? 1.15 : 0.87))) }; }, { passive: false });
controls.addEventListener('start', () => { controls.autoRotate = false; fly = null; });

// legend
const off = new Set();
let legFolded = false;
function syncMapGroups() {
  for (let i = 0; i < N; i++) {
    const c = colorMode === 'age' ? ec[eraOf(i)] : tc[tradOf(i)];
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    vis[i] = off.has(groupOf(i)) ? 0 : 1;
  }
  geo.attributes.color.needsUpdate = true;
  geo.attributes.aVis.needsUpdate = true;
}
function renderLegend() {
  const items = colorMode === 'age'
    ? ERAS.map((e, i) => ({ color: e.color, label: T.eras[i] }))
    : trads.map((t, i) => ({ color: t.color, label: tradName(i) }));
  const allOff = off.size >= items.length;
  $('#legend').innerHTML = `<div class="leg-bar"><div class="leg-mode"><span>${esc(T.color_by)}:</span><button type="button" data-mode="trad" class="${colorMode === 'trad' ? 'on' : ''}">${esc(T.by_trad)}</button><button type="button" data-mode="age" class="${colorMode === 'age' ? 'on' : ''}">${esc(T.by_age)}</button></div><button type="button" class="leg-all" data-all>${esc(allOff ? T.all_on : T.all_off)}</button><button type="button" class="ex-fold leg-fold" data-leg-fold aria-expanded="${!legFolded}" aria-label="${esc(T.aria.close)}">${legFolded ? '+' : '−'}</button></div>` +
    `<div class="leg-items"${legFolded ? ' hidden' : ''}>` + items.map((it, i) => `<button type="button" style="--c:${it.color}" data-t="${i}" class="${off.has(i) ? 'off' : ''}"><i></i>${esc(it.label)}</button>`).join('') + `</div>`;
}
renderLegend();
$('#legend').addEventListener('click', e => {
  const foldBtn = e.target.closest('[data-leg-fold]');
  if (foldBtn) {
    legFolded = !legFolded;
    const itemsEl = $('#legend .leg-items');
    if (itemsEl) itemsEl.hidden = legFolded;
    foldBtn.textContent = legFolded ? '+' : '−';
    foldBtn.setAttribute('aria-expanded', String(!legFolded));
    return;
  }
  const modeBtn = e.target.closest('[data-mode]');
  if (modeBtn) {
    if (modeBtn.dataset.mode === colorMode) return;
    colorMode = modeBtn.dataset.mode;
    off.clear();
    renderLegend();
    syncMapGroups();
    return;
  }
  const allBtn = e.target.closest('[data-all]');
  if (allBtn) {
    const count = colorMode === 'age' ? ERAS.length : trads.length;
    if (off.size >= count) off.clear();
    else for (let i = 0; i < count; i++) off.add(i);
    renderLegend();
    syncMapGroups();
    return;
  }
  const b = e.target.closest('[data-t]'); if (!b) return;
  const t = +b.dataset.t, count = colorMode === 'age' ? ERAS.length : trads.length;
  off.has(t) ? off.delete(t) : off.add(t);
  b.classList.toggle('off', off.has(t));
  const allEl = $('#legend [data-all]');
  if (allEl) allEl.textContent = off.size >= count ? T.all_on : T.all_off;
  for (let i = 0; i < N; i++) vis[i] = off.has(groupOf(i)) ? 0 : 1;
  geo.attributes.aVis.needsUpdate = true;
});

// theme labels
const labelsEl = $('#labels');
const labelEls = extra.themes.map((t, i) => { const b = document.createElement('button'); b.textContent = T.themes[i]; b.onclick = () => { $('#q').value = ''; showAnswers(T.themes[i], ranked(t.vec)); }; labelsEl.appendChild(b); return b; });
const labelPos = extra.themes.map(t => new THREE.Vector3(...t.pos).multiplyScalar(SCALE * 1.12));

// picking
const tip = $('#tip'), snapEl = $('#snap');
let mouse = null, hover = -1, downAt = null, dragged = false, pickX = 0, pickY = 0, snapped = false;
const m4 = new THREE.Matrix4();
function pick(mx, my, touch = false) {
  m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); const e = m4.elements, w = innerWidth, h = innerHeight;
  const net = dimTarget > 0.1, baseR = touch ? 22 * 22 : 14 * 14;
  let best = -1, bd = net ? 48 * 48 : baseR, bestTier = 0, bx = mx, by = my;
  for (let i = 0; i < N; i++) {
    if (!vis[i]) continue;
    const hVal = hi[i];
    const tier = net ? (hVal > 0.9 ? 2 : hVal > 0 ? 1 : 0) : 0;
    if (tier < bestTier) continue;
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15]; if (cw <= 0) continue;
    const px = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw * 0.5 + 0.5) * w;
    const py = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw * 0.5) * h;
    const sx = px - mx, sy = py - my, d = sx * sx + sy * sy;
    const maxD = tier === 2 ? 48 * 48 : tier === 1 ? 28 * 28 : baseR;
    if (d > maxD) continue;
    if (tier > bestTier || d < bd) { bestTier = tier; bd = d; best = i; bx = px; by = py; }
  }
  pickX = bx; pickY = by; snapped = best >= 0 && bestTier > 0;
  return best;
}
canvas.addEventListener('pointermove', e => {
  if (e.pointerType !== 'touch') mouse = [e.clientX, e.clientY];
  const slop = e.pointerType === 'touch' ? 12 : 5;
  if (downAt && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > slop) dragged = true;
});
canvas.addEventListener('pointerleave', () => { mouse = null; snapped = false; snapEl.hidden = true; tip.hidden = true; hover = -1; });
canvas.addEventListener('pointercancel', () => { downAt = null; dragged = false; mouse = null; snapped = false; snapEl.hidden = true; tip.hidden = true; hover = -1; });
canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; dragged = false; snapped = false; snapEl.hidden = true; tip.hidden = true; hover = -1; });
canvas.addEventListener('pointerup', e => {
  const isTouch = e.pointerType === 'touch', slop = isTouch ? 12 : 5;
  const wasTap = downAt && !dragged && Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) <= slop;
  downAt = null; dragged = false;
  if (isTouch) { mouse = null; snapped = false; snapEl.hidden = true; tip.hidden = true; hover = -1; }
  if (!wasTap) return;
  const i = pick(e.clientX, e.clientY, isTouch); if (i >= 0) { openDrawer(i); flyTo(i); }
});

function resize() { renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); mat.uniforms.uPx.value = innerHeight * 0.17 * renderer.getPixelRatio(); }
addEventListener('resize', resize); resize();

const mapSec = $('#map'), v3 = new THREE.Vector3(); let frame = 0;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; if (reduce) controls.autoRotate = false;
function tick(t) {
  requestAnimationFrame(tick); frame++;
  mat.uniforms.uTime.value = reduce ? 0 : t / 1000;
  mat.uniforms.uDim.value += (dimTarget - mat.uniforms.uDim.value) * 0.06;
  dist = camera.position.distanceTo(controls.target);
  if (fly) {
    controls.target.lerp(fly.target, 0.07);
    const d = dist + (fly.dist - dist) * 0.07; v3.copy(camera.position).sub(controls.target).setLength(d); camera.position.copy(controls.target).add(v3);
    if (Math.abs(fly.dist - dist) < 0.02 && controls.target.distanceTo(fly.target) < 0.02) fly = null;
  }
  controls.update();
  if (ring.visible) { ring.quaternion.copy(camera.quaternion); const s = 1 + 0.15 * Math.sin(t / 400); ring.scale.setScalar(s * camera.position.distanceTo(ring.position) / 12); }
  renderer.render(scene, camera);

  // labels show only when the map section fills the screen
  const r = mapSec.getBoundingClientRect(), inMap = r.top < innerHeight * 0.45 && r.bottom > innerHeight * 0.55;
  labelsEl.classList.toggle('on', inMap && !drawer.classList.contains('open'));
  if (inMap && frame % 2 === 0) {
    // nearest labels first; a label that would cover another one stays hidden
    const cand = [], mob = innerWidth <= 720, topPad = mob ? 145 : 65, botPad = mob ? (legFolded ? 70 : 155) : 50;
    for (let i = 0; i < labelEls.length; i++) {
      v3.copy(labelPos[i]).project(camera);
      if (v3.z > 1) { labelEls[i].style.display = 'none'; continue; }
      cand.push({ i, x: (v3.x * 0.5 + 0.5) * innerWidth, y: (0.5 - v3.y * 0.5) * innerHeight, d: camera.position.distanceTo(labelPos[i]), w: T.themes[i].length * 11 + 34 });
    }
    cand.sort((a, b) => a.d - b.d); const placed = [];
    for (const c of cand) {
      const el = labelEls[c.i];
      if (c.x < c.w * 0.45 + 6 || c.x > innerWidth - c.w * 0.45 - 6 || c.y < topPad || c.y > innerHeight - botPad) { el.style.display = 'none'; continue; }
      if (placed.some(p => Math.abs(p.x - c.x) < (p.w + c.w) / 2 && Math.abs(p.y - c.y) < 30)) { el.style.display = 'none'; continue; }
      placed.push(c); el.style.display = ''; el.style.left = c.x + 'px'; el.style.top = c.y + 'px';
      el.style.opacity = Math.max(0.35, Math.min(1, 1.7 - c.d / 22));
    }
  }
  if (dimTarget > 0.1 || frame % 3 === 0) {
    const i = mouse && inMap && !downAt ? pick(mouse[0], mouse[1]) : -1;
    if (i < 0) snapped = false;
    if (i !== hover) {
      hover = i;
      if (i < 0) tip.hidden = true;
      else { const bk = books[P[i][0]], tx = P[i][2]; tip.hidden = false; tip.style.setProperty('--c', colorOf(i)); tip.innerHTML = `${esc(tx.length > 190 ? tx.slice(0, 180).replace(/\s\S*$/, '') + '…' : tx)}<small>${esc(bk.author)} — ${esc(P[i][1])} · ${year(bk.year)}</small>`; }
    }
    if (hover >= 0 && snapped && !downAt) {
      snapEl.hidden = false;
      snapEl.style.setProperty('--c', colorOf(hover));
      snapEl.style.left = pickX + 'px';
      snapEl.style.top = pickY + 'px';
      canvas.style.cursor = 'none';
      tip.style.left = Math.min(pickX + 18, innerWidth - 360) + 'px';
      tip.style.top = Math.min(pickY + 18, innerHeight - 160) + 'px';
    } else {
      snapEl.hidden = true;
      canvas.style.cursor = hover >= 0 ? 'pointer' : 'grab';
      if (hover >= 0 && mouse) {
        tip.style.left = Math.min(mouse[0] + 18, innerWidth - 360) + 'px';
        tip.style.top = Math.min(mouse[1] + 18, innerHeight - 160) + 'px';
      }
    }
  }
}
requestAnimationFrame(tick);
initTour({ lang, T, LANGS, path, ready: true });
