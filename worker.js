// Runs the models away from the page, so that the page stays smooth.
// It has two jobs: the meaning model (search) and small translation models.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2';

let ex = null, model = null;
const translators = {};

function progress(type) {
  const files = {};
  return p => {
    if (p.status === 'progress' && p.total) {
      files[p.file] = [p.loaded, p.total];
      let l = 0, t = 0; for (const k in files) { l += files[k][0]; t += files[k][1]; }
      postMessage({ type, loaded: l, total: t });
    }
  };
}

async function init(m) {
  model = m;
  try {
    ex = await pipeline('feature-extraction', model.name, { dtype: 'q8', progress_callback: progress('progress') });
    postMessage({ type: 'ready' });
  } catch (e) { postMessage({ type: 'error', message: String(e && e.message || e) }); }
}

// Translate sentence by sentence. Long sentences lose quality, and the models have a length limit.
async function translate(pair, text) {
  if (!translators[pair]) translators[pair] = pipeline('translation', `Xenova/opus-mt-${pair}`, { dtype: 'q8', progress_callback: progress('trprogress') });
  const tr = await translators[pair];
  const plain = text.replace(/[“”„«»]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const parts = plain.match(/[^.!?;:]+[.!?;:]+["')]*\s*|[^.!?;:]+$/g) || [plain];
  const out = [];
  for (const s of parts) {
    if (!/[A-Za-zÀ-ÿ]/.test(s)) { out.push(s.trim()); continue; }
    const r = await tr(s.trim(), { max_new_tokens: 300 });
    out.push(r[0].translation_text.trim());
  }
  return out.join(' ');
}

onmessage = async e => {
  const d = e.data;
  if (d.type === 'init') return init(d.model);
  if (d.type === 'embed') {
    try {
      const r = await ex(model.prefix + d.text, { pooling: model.pooling, normalize: true });
      postMessage({ type: 'result', id: d.id, value: Float32Array.from(r.data) });
    } catch (err) { postMessage({ type: 'result', id: d.id, error: String(err) }); }
  }
  if (d.type === 'translate') {
    try { postMessage({ type: 'result', id: d.id, value: await translate(d.pair, d.text) }); }
    catch (err) { postMessage({ type: 'result', id: d.id, error: String(err) }); }
  }
};
