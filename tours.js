const KEY_LANG = 'tlc.tour.lang';
const KEY_PAGE = page => `tlc.tour.${page}`;
const KEY_RESUME = 'tlc.tour.resume';

export const HEADER_STEPS = [
  { id: 'nav', sel: '#menuBtn, #navLinks', title: 'tour.steps.nav.0', body: 'tour.steps.nav.1' },
];

export const TOURS = {
  main: [
    { id: 'ask', sel: '#form', title: 'tour.steps.ask.0', body: 'tour.steps.ask.1' },
    { id: 'examples', sel: '#examples', title: 'tour.steps.examples.0', body: 'tour.steps.examples.1' },
    { id: 'map', sel: '#map .map-head, #map', title: 'tour.steps.map.0', body: 'tour.steps.map.1' },
    { id: 'legend', sel: '#legend', title: 'tour.steps.legend.0', body: 'tour.steps.legend.1' },
    { id: 'disagree', sel: '#disagree .sec-bar, #disagree', title: 'tour.steps.disagree.0', body: 'tour.steps.disagree.1' },
    { id: 'library', sel: '#library .sec-bar, #library', title: 'tour.steps.library.0', body: 'tour.steps.library.1' },
    ...HEADER_STEPS,
  ],
};

function sGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function sSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function ssGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch {} }
function ssDel(k) { try { sessionStorage.removeItem(k); } catch {} }

const lookup = (obj, k) => k.split('.').reduce((o, p) => o?.[p], obj);

export function checkTourTranslations(STR) {
  const missing = [];
  for (const [lang, dict] of Object.entries(STR)) {
    if (!dict?.aria?.tour) missing.push(`${lang}.aria.tour`);
    const tr = dict?.tour;
    if (typeof tr?.step !== 'function') missing.push(`${lang}.tour.step`);
    for (const k of ['back', 'next', 'done', 'lang_title', 'lang_body']) {
      if (typeof tr?.[k] !== 'string' || !tr[k]) missing.push(`${lang}.tour.${k}`);
    }
    for (const [page, list] of Object.entries(TOURS)) {
      for (const s of list) {
        if (typeof lookup(dict, s.title) !== 'string') missing.push(`${lang}.${s.title} (${page}:${s.id})`);
        if (typeof lookup(dict, s.body) !== 'string') missing.push(`${lang}.${s.body} (${page}:${s.id})`);
      }
    }
  }
  return missing;
}

function isVisible(el) {
  if (!el || el.hidden || el.closest('[hidden]')) return false;
  const st = getComputedStyle(el);
  if (st.display === 'none' || st.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findTarget(sel) {
  if (!sel) return null;
  for (const part of sel.split(',')) {
    const q = part.trim();
    if (!q) continue;
    for (const el of document.querySelectorAll(q)) if (isVisible(el)) return el;
  }
  return null;
}

export function initTour({ lang, T, LANGS, path, ready = true }) {
  if (!ready) return;

  const tourBtn = document.getElementById('tourBtn');
  let layer = null, spot = null, card = null, active = null, raf = 0;

  function ensureLayer() {
    if (layer) return;
    layer = document.createElement('div');
    layer.className = 'tour-layer';
    layer.hidden = true;
    layer.innerHTML = `<div class="tour-spot" aria-hidden="true"></div>
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tourTitle" tabindex="-1">
        <div class="tour-head"><span class="tour-step" id="tourStep"></span><button type="button" class="tour-close" id="tourClose">×</button></div>
        <h3 class="tour-title" id="tourTitle"></h3>
        <p class="tour-body" id="tourBody"></p>
        <div class="tour-langs" id="tourLangs" hidden></div>
        <div class="tour-foot"><button type="button" class="tour-act" id="tourBack"></button><button type="button" class="tour-act primary" id="tourNext"></button></div>
      </div>`;
    document.body.appendChild(layer);
    spot = layer.querySelector('.tour-spot');
    card = layer.querySelector('.tour-card');

    layer.querySelector('#tourClose').setAttribute('aria-label', T.aria.close);
    layer.querySelector('#tourBack').textContent = T.tour.back;
    layer.querySelector('#tourClose').addEventListener('click', () => finish(true));
    layer.querySelector('#tourBack').addEventListener('click', () => go(-1));
    layer.querySelector('#tourNext').addEventListener('click', () => {
      if (!active) return;
      if (active.steps[active.idx]?.langStep) sSet(KEY_LANG, 'done');
      if (active.idx >= active.steps.length - 1) finish(true);
      else go(1);
    });
    layer.querySelector('#tourLangs').addEventListener('click', e => {
      const btn = e.target.closest('[data-tlang]');
      if (!btn || !active) return;
      const nextLang = btn.dataset.tlang;
      sSet(KEY_LANG, 'done');
      if (nextLang === lang) {
        if (active.idx < active.steps.length - 1) go(1);
        else finish(true);
        return;
      }
      ssSet(KEY_RESUME, JSON.stringify({ page: active.page, nextStep: active.idx + 1, withLang: active.withLang }));
      sSet('lang', nextLang);
      const u = new URL(location.href);
      u.searchParams.set('lang', nextLang);
      u.hash = '';
      location.href = u;
    });
  }

  function buildSteps(page, withLang) {
    const out = [];
    if (withLang) out.push({ id: 'lang', langStep: true, title: 'tour.lang_title', body: 'tour.lang_body' });
    for (const s of (TOURS[page] || [])) {
      if (!s.sel || findTarget(s.sel)) out.push(s);
    }
    return out;
  }

  function position() {
    if (!active || layer.hidden) return;
    const step = active.steps[active.idx];
    const el = step?.sel ? findTarget(step.sel) : null;
    const cw = card.offsetWidth, ch = card.offsetHeight, vw = innerWidth, vh = innerHeight, pad = 8, gap = 14;
    if (!el) {
      layer.classList.add('centered');
      spot.hidden = true;
      card.style.left = Math.max(12, Math.round((vw - cw) / 2)) + 'px';
      card.style.top = Math.max(12, Math.round((vh - ch) / 2)) + 'px';
      return;
    }
    layer.classList.remove('centered');
    spot.hidden = false;
    const r = el.getBoundingClientRect();
    const sx = Math.max(4, r.left - pad);
    const sy = Math.max(4, r.top - pad);
    const sr = Math.min(vw - 4, r.right + pad);
    const sb = Math.min(vh - 4, r.bottom + pad);
    const sw = Math.max(24, sr - sx);
    const sh = Math.max(24, sb - sy);
    spot.style.left = sx + 'px';
    spot.style.top = sy + 'px';
    spot.style.width = sw + 'px';
    spot.style.height = sh + 'px';

    let top = sb + gap;
    if (top + ch > vh - 12) {
      const above = sy - gap - ch;
      top = above >= 12 ? above : (vh - sb >= sy ? Math.max(12, vh - ch - 12) : 12);
    }
    const left = Math.max(12, Math.min(vw - cw - 12, sx + (sw - cw) / 2));
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
  }

  function schedulePos() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(position);
  }

  function renderStep() {
    if (!active) return;
    const step = active.steps[active.idx];
    if (!step) { finish(true); return; }
    const total = active.steps.length, n = active.idx + 1;

    layer.querySelector('#tourStep').textContent = T.tour.step(n, total);
    layer.querySelector('#tourTitle').textContent = path(step.title) || '';
    layer.querySelector('#tourBody').textContent = path(step.body) || '';

    const langsEl = layer.querySelector('#tourLangs');
    if (step.langStep) {
      langsEl.hidden = false;
      langsEl.innerHTML = Object.entries(LANGS).map(([k, v]) => `<button type="button" class="tour-lang${k === lang ? ' on' : ''}" data-tlang="${k}">${v}</button>`).join('');
    } else {
      langsEl.hidden = true;
      langsEl.innerHTML = '';
    }

    const back = layer.querySelector('#tourBack'), next = layer.querySelector('#tourNext');
    back.hidden = active.idx === 0;
    next.textContent = active.idx >= total - 1 ? T.tour.done : T.tour.next;

    const el = step.sel ? findTarget(step.sel) : null;
    if (el && !el.closest('.top') && getComputedStyle(el).position !== 'fixed') {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }
    position();
    requestAnimationFrame(position);
  }

  function go(delta) {
    if (!active) return;
    const nextIdx = active.idx + delta;
    if (nextIdx < 0 || nextIdx >= active.steps.length) return;
    active.idx = nextIdx;
    renderStep();
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(true); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (active.steps[active.idx]?.langStep) sSet(KEY_LANG, 'done');
      if (active.idx >= active.steps.length - 1) finish(true);
      else go(1);
    }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
  }

  function finish(markDone) {
    if (!active) return;
    const { page, prevFocus } = active;
    active = null;
    if (markDone) sSet(KEY_PAGE(page), 'done');
    layer.hidden = true;
    cancelAnimationFrame(raf);
    removeEventListener('resize', schedulePos);
    removeEventListener('scroll', schedulePos, true);
    removeEventListener('keydown', onKey, true);
    if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
  }

  function startTour(page = 'main', { force = false, startIdx = 0, withLang = null } = {}) {
    if (!force && sGet(KEY_PAGE(page)) === 'done') return;
    const includeLang = withLang ?? (sGet(KEY_LANG) !== 'done');
    const steps = buildSteps(page, includeLang);
    if (!steps.length) return;
    ensureLayer();
    const prevFocus = active?.prevFocus || document.activeElement;
    active = { page, steps, idx: Math.max(0, Math.min(startIdx, steps.length - 1)), withLang: includeLang, prevFocus };
    layer.hidden = false;
    addEventListener('resize', schedulePos);
    addEventListener('scroll', schedulePos, true);
    addEventListener('keydown', onKey, true);
    renderStep();
    card.focus();
  }

  window.addEventListener('tlc:tour', e => startTour(e.detail?.page || 'main', { force: true, withLang: false }));
  tourBtn?.addEventListener('click', () => window.dispatchEvent(new CustomEvent('tlc:tour', { detail: { page: 'main' } })));
  document.addEventListener('change', e => {
    if (e.target?.id === 'lang' && active) ssSet(KEY_RESUME, JSON.stringify({ page: active.page, nextStep: active.idx, withLang: active.withLang }));
  }, { capture: true });

  setTimeout(() => {
    const raw = ssGet(KEY_RESUME);
    if (raw) {
      ssDel(KEY_RESUME);
      try {
        const r = JSON.parse(raw);
        if (r && r.page) { startTour(r.page, { force: true, startIdx: r.nextStep || 0, withLang: !!r.withLang }); return; }
      } catch {}
    }
    startTour('main');
  }, 120);
}
