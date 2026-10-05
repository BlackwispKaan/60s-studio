/* 60s Studio — veri özel GitHub reposunda (BlackwispKaan/Youtube) durur.
   Site her kullanıcının kendi GitHub token'ıyla GitHub API üzerinden okur/yazar.
   localhost'ta token yoksa "demo modu": dosyaları yerel sunucudan okur, yazmaz. */

const REPO = { owner: 'BlackwispKaan', repo: 'Youtube', branch: 'main' };
const DEFAULT_MEMBERS = ['Kağan', 'Samet', 'Yiğit'];
const WORDS_PER_SEC = 2.6; // ~155 kelime/dk anlatım hızı

const STATUS = {
  queued_research: { label: 'Araştırma sırada', step: 0 },
  choosing:        { label: 'Seçim yapılıyor', step: 1 },
  collecting:      { label: 'Materyal toplanıyor', step: 2 },
  queued_edit:     { label: 'Kurgu sırada', step: 3 },
  editing:         { label: 'Kurgulanıyor', step: 3 },
  queued_revision: { label: 'Düzeltme sırada', step: 3 },
  review:          { label: 'İncelemede', step: 4 },
  done:            { label: 'Tamamlandı', step: 5 },
};
const STEPS = ['Araştırma', 'Seçim', 'Materyal', 'Kurgu', 'İnceleme', 'Bitti'];
const TECH = {
  T1: 'Literalizasyon', T2: 'Etiket + reaksiyon', T3: 'Ciddi söz / ters görüntü', T4: 'Belgesel dili',
  T5: 'Övgü → itiraf', T6: 'Topluluk klişesi', T7: 'Hard cut / sessizlik', T8: 'SFX punch', T9: 'Callback', T10: 'Espriye bağlı CTA',
};
const TYPE_LABEL = { gameplay: 'Oyun', meme: 'Meme', sfx: 'Ses efekti', voice: 'Anlatıcı' };
const CAPTIONS = [
  { v: 'full', label: 'Tam altyazı', hint: 'Anlatıcının her kelimesi ekranda. Önerilen: sessiz izleyenler ve anadili İngilizce olmayan global izleyici için en yüksek izlenme süresi.' },
  { v: 'keywords', label: 'Vurgu kelimeleri', hint: 'Sadece punchline ve anahtar kelimeler ekranda. Görüntü daha temiz kalır.' },
  { v: 'off', label: 'Kapalı', hint: 'Altyazı yok. Sadece meme etiketleri ve başlıklar gösterilir.' },
];

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64dec(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function slugify(t) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };
  return t.trim().toLowerCase().replace(/[çğıİöşü]/g, (c) => map[c] || c)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
const nowIso = () => new Date().toISOString();
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } };
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 6000 : 2600);
}
function openModal(html) { $('#modalBody').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; }

/* ---------- storage backends ---------- */
class GitHubStore {
  constructor(token) { this.token = token; this.demo = false; }
  async req(path, opts = {}) {
    // Sondaki '/' GitHub'da CORS'suz hata döndürür (tarayıcıda "Failed to fetch"), o yüzden boş path'te eklenmez.
    const r = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}${path ? '/' + path : ''}`, {
      ...opts, cache: 'no-store',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opts.headers || {}) },
    });
    if (r.status === 404) return null;
    if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; e.body = await r.text(); throw e; }
    return r.status === 204 ? {} : r.json();
  }
  async ping() { return this.req(''); }
  async get(path) {
    const j = await this.req(`contents/${encodeURI(path)}?ref=${REPO.branch}&t=${Date.now()}`);
    return j ? { text: b64dec(j.content), sha: j.sha } : null;
  }
  async put(path, text, message, sha) {
    return this.req(`contents/${encodeURI(path)}`, {
      method: 'PUT', body: JSON.stringify({ message, content: b64enc(text), branch: REPO.branch, ...(sha ? { sha } : {}) }),
    });
  }
  async list(path) {
    const j = await this.req(`contents/${encodeURI(path)}?ref=${REPO.branch}&t=${Date.now()}`);
    return Array.isArray(j) ? j.map((x) => ({ name: x.name, type: x.type })) : [];
  }
}
class LocalDemoStore {
  // localhost'ta proje klasörü sunuluyorsa (site/ bir alt klasör) dosyaları okur; yazmalar sadece bellekte.
  constructor() { this.demo = true; this.mem = new Map(); }
  async ping() { return {}; }
  async get(path) {
    if (this.mem.has(path)) return { text: this.mem.get(path), sha: 'mem' };
    const r = await fetch(`../${path}`, { cache: 'no-store' });
    return r.ok ? { text: await r.text(), sha: 'local' } : null;
  }
  async put(path, text) { this.mem.set(path, text); return {}; }
  async list(path) {
    const r = await fetch(`../${path}/`, { cache: 'no-store' });
    if (!r.ok) return [];
    const html = await r.text();
    const names = [...html.matchAll(/href="([^"?#]+)"/g)].map((m) => decodeURIComponent(m[1]));
    const fromMem = [...this.mem.keys()].filter((k) => k.startsWith(path + '/')).map((k) => k.slice(path.length + 1).split('/')[0] + '/');
    return [...new Set([...names, ...fromMem])].filter((n) => !n.startsWith('.') && !n.startsWith('/'))
      .map((n) => ({ name: n.replace(/\/$/, ''), type: n.endsWith('/') ? 'dir' : 'file' }));
  }
}

/* ---------- state ---------- */
const S = {
  store: null,
  user: ls.get('studio.user'),
  members: DEFAULT_MEMBERS,
  games: new Map(), // slug -> game
  pending: new Map(), // slug -> [ops]
  saveTimers: new Map(),
};

async function readJSON(path) { const f = await S.store.get(path); return f ? { data: JSON.parse(f.text), sha: f.sha } : null; }

// Oyun dosyasını en güncel haliyle çekip değişikliği uygular; çakışmada yeniden dener.
async function mutateGame(slug, fn, message) {
  for (let i = 0; i < 4; i++) {
    const cur = await readJSON(`games/${slug}/game.json`);
    if (!cur) throw new Error('Oyun bulunamadı');
    fn(cur.data);
    try {
      await S.store.put(`games/${slug}/game.json`, JSON.stringify(cur.data, null, 2) + '\n', `[${S.user}] ${cur.data.title}: ${message}`, cur.sha);
      S.games.set(slug, cur.data);
      return cur.data;
    } catch (e) {
      if (e.status === 409 || e.status === 422) continue;
      throw e;
    }
  }
  throw new Error('Kaydedilemedi (çakışma). Sayfayı yenileyin.');
}
// Hızlı tıklamaları birleştirip tek commit olarak kaydeder.
function queueOp(slug, op, label) {
  op(S.games.get(slug));
  const list = S.pending.get(slug) || [];
  list.push({ op, label });
  S.pending.set(slug, list);
  clearTimeout(S.saveTimers.get(slug));
  setSaveState('saving');
  S.saveTimers.set(slug, setTimeout(() => flush(slug), 900));
}
async function flush(slug) {
  const list = S.pending.get(slug) || [];
  if (!list.length) return;
  S.pending.set(slug, []);
  try {
    await mutateGame(slug, (g) => list.forEach((x) => x.op(g)), [...new Set(list.map((x) => x.label))].join(', '));
    setSaveState('saved');
  } catch (e) {
    console.error(e); setSaveState('error'); toast('Kaydedilemedi: ' + e.message, true);
  }
}
function setSaveState(s) {
  const el = $('#saveState'); if (!el) return;
  el.textContent = { saving: 'Kaydediliyor…', saved: S.store.demo ? 'Demo: kaydedilmedi' : 'Kaydedildi ✓', error: 'Kayıt hatası' }[s];
  el.style.color = s === 'error' ? 'var(--bad)' : '';
}
async function enqueue(type, slug, payload = {}) {
  const at = nowIso();
  const name = `queue/${at.replace(/[-:.]/g, '').slice(0, 15)}-${type}-${slug}.json`;
  await S.store.put(name, JSON.stringify({ type, slug, by: S.user, at, payload }, null, 2) + '\n', `[${S.user}] iş kuyruğu: ${type} ${slug}`);
}
const logLine = (g, msg) => (g.log = g.log || []).push({ at: nowIso(), by: S.user, msg });

/* ---------- derived ---------- */
const selectedOpt = (sec) => sec.options.find((o) => o.id === sec.selected);
function stats(g) {
  const secs = g.sections || [];
  const chosen = secs.filter((s) => s.selected);
  const words = chosen.reduce((n, s) => n + selectedOpt(s).narration.split(/\s+/).length, 0);
  return { total: secs.length, chosen: chosen.length, words, secs: Math.round(words / WORDS_PER_SEC) };
}
function buildMaterials(g) {
  const prev = new Map((g.materials || []).map((m) => [m.file || m.id, m]));
  const out = []; const seen = new Set();
  const add = (m) => { const k = m.file || m.id; if (seen.has(k)) return; seen.add(k); const p = prev.get(k); out.push({ ...m, done: p ? !!p.done : false, doneBy: p?.doneBy || null }); };
  g.sections.forEach((s, i) => {
    (s.gameplay || []).forEach((x) => add({ id: x.id, type: 'gameplay', section: `S${i + 1}`, desc: x.desc, file: x.file, source: x.source || '' }));
    const o = selectedOpt(s);
    (o?.needs || []).forEach((x, j) => add({ id: `${s.id}${o.id}n${j}`, type: x.type, section: `S${i + 1}`, desc: x.desc, file: x.file, source: x.source || '', search: x.search || '' }));
  });
  return out;
}
function narrationScript(g) {
  return g.sections.map((s, i) => `[S${i + 1} · ${s.time}] ${selectedOpt(s)?.narration || '—'}`).join('\n\n');
}
function materialsMarkdown(g) {
  const mats = g.materials;
  const by = (t) => mats.filter((m) => m.type === t);
  const line = (m) => `- [${m.done ? 'x' : ' '}] **${m.section}** ${m.desc}\n  - Dosya adı: \`${m.file}\`${m.source ? `\n  - Kaynak: ${m.source}` : ''}${m.search ? `\n  - Arama: "${m.search}"` : ''}`;
  const st = stats(g);
  return `# ${g.title} — Materyal Listesi

Çıktı: ${fmtDate(g.exportedAt)} · ${g.exportedBy} · Tahmini anlatım: ~${st.secs} sn (${st.words} kelime)
Altyazı: ${CAPTIONS.find((c) => c.v === g.settings.captions)?.label}

Dosyaları Google Drive'da \`${g.slug}/\` klasörüne, **tam olarak belirtilen dosya adıyla** koyun.
Klipleri biraz uzun kesin (±2 sn pay); kırpmayı ben yaparım. HUD'lu/HUD'suz fark etmez, mümkünse 1080p+.

## 🎮 Oyun görüntüleri (${by('gameplay').length})
${by('gameplay').map(line).join('\n')}

## 😂 Meme / reaksiyon klipleri (${by('meme').length})
${by('meme').map(line).join('\n') || '- (yok)'}

## 🔊 Ses efektleri (${by('sfx').length})
${by('sfx').map(line).join('\n') || '- (yok)'}

## 🎙️ Anlatıcı (ElevenLabs — Claude API ile otomatik üretir, sizin bir şey yapmanız gerekmez)
\`\`\`
${narrationScript(g)}
\`\`\`
`;
}

/* ---------- views ---------- */
function renderUserSelect() {
  const sel = $('#userSelect');
  sel.innerHTML = (S.user ? '' : '<option value="">İsmini seç</option>') + S.members.map((m) => `<option ${m === S.user ? 'selected' : ''}>${esc(m)}</option>`).join('');
  sel.onchange = () => { S.user = sel.value; ls.set('studio.user', S.user); route(); };
}

function settingsModal(firstRun = false) {
  const tok = ls.get('studio.token', '');
  openModal(`
    <h2 style="margin-bottom:8px">${firstRun ? 'Hoş geldin! 👋' : 'Ayarlar'}</h2>
    <p class="muted small" style="margin-top:0">Site, özel repodaki verilere senin GitHub token'ınla erişir. Token sadece bu tarayıcıda saklanır.</p>
    <div class="stack">
      <div class="field">
        <label for="tokIn">GitHub token</label>
        <input id="tokIn" type="password" placeholder="github_pat_… veya ghp_…" value="${esc(tok)}" autocomplete="off">
        <details class="small muted"><summary>Token nasıl alınır?</summary>
          <ol>
            <li>GitHub → sağ üst profil → <b>Settings</b> → en altta <b>Developer settings</b> → <b>Personal access tokens</b>.</li>
            <li><b>Kağan:</b> Fine-grained token → Repository access: <i>Only select repositories → Youtube</i> → Permissions: <b>Contents: Read and write</b>.</li>
            <li><b>Samet / Yiğit:</b> Tokens (classic) → scope olarak sadece <b>repo</b> işaretle. (Önce Kağan'ın seni Youtube reposuna collaborator olarak eklemesi gerekir.)</li>
            <li>Süreyi 1 yıl seç, oluşan token'ı buraya yapıştır.</li>
          </ol>
        </details>
      </div>
      <div class="row">
        <button class="btn btn-primary" id="tokSave">Kaydet ve bağlan</button>
        ${tok ? '<button class="btn btn-ghost" id="tokClear">Token\'ı sil</button>' : ''}
        <span class="spacer"></span>
        <button class="btn btn-ghost" id="themeBtn">Tema: ${ls.get('studio.theme', 'dark') === 'dark' ? 'Koyu' : 'Açık'}</button>
      </div>
      <p id="tokMsg" class="small"></p>
    </div>`);
  $('#tokSave').onclick = async () => {
    const v = $('#tokIn').value.trim();
    if (!v) return;
    $('#tokMsg').textContent = 'Bağlanılıyor…';
    try {
      const st = new GitHubStore(v);
      const r = await st.ping();
      if (!r) throw new Error('Repo bulunamadı. Collaborator olarak eklendin mi?');
      ls.set('studio.token', v); S.store = st; closeModal(); toast('Bağlandı ✓'); await boot();
    } catch (e) { $('#tokMsg').innerHTML = `<span style="color:var(--bad)">Bağlanamadı: ${esc(e.message)}</span>`; }
  };
  const c = $('#tokClear'); if (c) c.onclick = () => { ls.del('studio.token'); location.reload(); };
  $('#themeBtn').onclick = () => { const t = ls.get('studio.theme', 'dark') === 'dark' ? 'light' : 'dark'; ls.set('studio.theme', t); applyTheme(); settingsModal(); };
}
function applyTheme() { document.documentElement.dataset.theme = ls.get('studio.theme', 'dark'); }

async function loadGames() {
  const dirs = (await S.store.list('games')).filter((d) => d.type === 'dir');
  const games = await Promise.all(dirs.map((d) => readJSON(`games/${d.name}/game.json`).catch(() => null)));
  S.games.clear();
  games.filter(Boolean).forEach((g) => S.games.set(g.data.slug, g.data));
}

function statusPill(g) { const s = STATUS[g.status] || { label: g.status }; return `<span class="pill dot st-${esc(g.status)}">${esc(s.label)}</span>`; }

async function renderHome() {
  const app = $('#app');
  app.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  await loadGames();
  const games = [...S.games.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  app.innerHTML = `
    <div class="hero">
      <h1>60 saniyede oyunlar</h1>
      <p class="muted" style="margin:0">Yeni bir oyun yaz. Claude araştırır, senaryoyu bölüm bölüm 3 seçenekle hazırlar.</p>
    </div>
    ${S.store.demo ? '<div class="card small" style="margin-bottom:16px;border-color:var(--warn)">⚠️ <b>Demo modu</b>: yerel dosyalar okunuyor, değişiklikler kaydedilmez. Kaydetmek için ⚙ ile token gir.</div>' : ''}
    <form class="new-game card" id="newGame" style="margin-bottom:24px">
      <input type="text" id="newGameName" placeholder="Oyun adı (örn. Elden Ring)" required maxlength="60">
      <button class="btn btn-primary" type="submit">+ Yeni oyun</button>
    </form>
    <div class="row" style="margin-bottom:12px"><h2>Oyunlar</h2><span class="muted small">${games.length}</span></div>
    ${games.length ? `<div class="game-grid">${games.map((g) => {
      const st = STATUS[g.status]?.step ?? 0;
      const s = stats(g);
      return `<a class="card game-card" href="#/game/${encodeURIComponent(g.slug)}">
        <div class="row">${statusPill(g)}<span class="spacer"></span><span class="small muted">${esc(g.owner)}</span></div>
        <h3>${esc(g.title)}</h3>
        <div class="progress"><span style="width:${Math.round((st / 5) * 100)}%"></span></div>
        <div class="small muted">${g.status === 'choosing' ? `${s.chosen}/${s.total} bölüm seçildi` : esc(STEPS[st])}</div>
      </a>`;
    }).join('')}</div>` : '<div class="card empty muted">Henüz oyun yok.</div>'}
  `;
  $('#newGame').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#newGameName').value.trim();
    const slug = slugify(title);
    if (!slug) return;
    if (S.games.has(slug)) { location.hash = `#/game/${slug}`; return; }
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Oluşturuluyor…';
    try {
      const g = {
        schema: 1, slug, title, owner: S.user, createdBy: S.user, createdAt: nowIso(), status: 'queued_research',
        settings: { captions: 'full', mediaFolderUrl: '' }, summary: '', sections: [], materials: [], versions: [], revisions: [],
        log: [{ at: nowIso(), by: S.user, msg: 'Oyun eklendi, araştırma kuyruğa alındı.' }],
      };
      await S.store.put(`games/${slug}/game.json`, JSON.stringify(g, null, 2) + '\n', `[${S.user}] Yeni oyun: ${title}`);
      await enqueue('new_game', slug);
      S.games.set(slug, g);
      location.hash = `#/game/${slug}`;
    } catch (err) { toast('Oluşturulamadı: ' + err.message, true); btn.disabled = false; btn.textContent = '+ Yeni oyun'; }
  };
}

function pipelineHtml(g) {
  const cur = STATUS[g.status]?.step ?? 0;
  return `<div class="pipeline">${STEPS.map((s, i) => `<div class="step ${i < cur ? 'done' : ''} ${i === cur ? 'current' : ''}"><div class="bar"></div>${s}</div>`).join('')}</div>`;
}

function optionHtml(sec, o) {
  const on = sec.selected === o.id;
  return `<button class="opt ${on ? 'selected' : ''}" data-sec="${esc(sec.id)}" data-opt="${esc(o.id)}" type="button">
    <span class="radio"></span>
    <div class="opt-en"><span class="opt-letter">${esc(o.id.toUpperCase())}</span>“${esc(o.narration)}”</div>
    <div class="opt-tr">🇹🇷 ${esc(o.tr)}</div>
    <dl class="opt-meta">
      <dt>Ekranda</dt><dd>${esc(o.visual)}</dd>
      <dt>Ses</dt><dd>${esc(o.sound)}</dd>
      ${o.needs?.length ? `<dt>Ek ihtiyaç</dt><dd>${o.needs.map((n) => `${esc(TYPE_LABEL[n.type] || n.type)}: ${esc(n.desc)}`).join('<br>')}</dd>` : ''}
      <dt>Teknik</dt><dd>${(o.techniques || []).map((t) => `<span class="tag" title="${esc(TECH[t] || '')}">${esc(t)} ${esc(TECH[t] || '')}</span>`).join('')}</dd>
    </dl>
  </button>`;
}

function sectionHtml(sec, i, editable) {
  return `<section class="card" id="sec-${esc(sec.id)}">
    <div class="section-head"><span class="section-time">${esc(sec.time)}</span><h2>${esc(sec.title)}</h2><span class="section-num">S${i + 1}</span></div>
    <div class="muted small" style="margin-top:4px">${esc(sec.goal || '')}</div>
    <div class="need-box"><b>🎮 Gereken oyun görüntüsü</b><ul>${(sec.gameplay || []).map((x) => `<li>${esc(x.desc)} <code>${esc(x.file)}</code></li>`).join('')}</ul></div>
    <div class="options">${sec.options.map((o) => optionHtml(sec, o)).join('')}</div>
    <textarea class="note-input" data-note="${esc(sec.id)}" placeholder="Bu bölüm için not / kendi fikrin (opsiyonel)" ${editable ? '' : 'disabled'}>${esc(sec.note || '')}</textarea>
  </section>`;
}

function materialsHtml(g) {
  const mats = g.materials || [];
  const done = mats.filter((m) => m.done).length;
  const order = ['gameplay', 'meme', 'sfx'];
  return `<section class="card" id="materials">
    <div class="row"><h2>📦 Materyaller</h2><span class="pill">${done}/${mats.length}</span><span class="spacer"></span>
      <button class="btn btn-ghost" id="showExport">Listeyi göster / indir</button></div>
    <div class="field" style="margin:14px 0">
      <label for="driveIn">Google Drive klasör linki</label>
      <div class="row"><input type="url" id="driveIn" style="flex:1" placeholder="https://drive.google.com/drive/folders/…" value="${esc(g.settings.mediaFolderUrl || '')}">
      ${g.settings.mediaFolderUrl ? `<a class="btn" href="${esc(g.settings.mediaFolderUrl)}" target="_blank" rel="noopener">Aç ↗</a>` : ''}</div>
    </div>
    ${order.map((t) => mats.filter((m) => m.type === t)).filter((l) => l.length).map((list) => list.map((m) => `
      <label class="mat ${m.done ? 'done' : ''}">
        <input type="checkbox" data-mat="${esc(m.file || m.id)}" ${m.done ? 'checked' : ''}>
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:6px"><span class="mat-type t-${esc(m.type)}">${esc(TYPE_LABEL[m.type])}</span><span class="small muted">${esc(m.section)}</span>${m.doneBy ? `<span class="small muted">· ✓ ${esc(m.doneBy)}</span>` : ''}</div>
          <div class="mat-desc">${esc(m.desc)}</div>
          <div class="small muted"><code>${esc(m.file)}</code>${m.source ? ` · ${esc(m.source)}` : ''}${m.search ? ` · 🔎 “${esc(m.search)}”` : ''}</div>
        </div>
      </label>`).join('')).join('')}
    <div class="mat"><span style="width:20px">🎙️</span><div><span class="mat-type t-voice">Anlatıcı</span><div class="mat-desc">ElevenLabs seslendirmesi: Claude API ile tek seferde otomatik üretir.</div></div></div>
  </section>`;
}

function reviewHtml(g) {
  const vs = g.versions || [];
  return `<section class="card stack" id="review">
    <h2>🎬 Videolar</h2>
    ${vs.length ? `<div>${vs.slice().reverse().map((v) => `<div class="version"><b>v${v.v}</b><span class="small muted">${fmtDate(v.at)}</span><span class="small">${esc(v.notes || '')}</span><span class="spacer"></span>${v.url ? `<a class="btn btn-primary" href="${esc(v.url)}" target="_blank" rel="noopener">İzle ↗</a>` : `<code class="small">${esc(v.file || '')}</code>`}</div>`).join('')}</div>` : '<p class="muted">Henüz video yok.</p>'}
    ${g.status === 'review' ? `
      <div class="field"><label for="revIn">Düzeltme isteği</label>
        <textarea id="revIn" rows="4" placeholder="Örn: 0:12'deki meme çok uzun, kısalt. S5'te B seçeneğini dene. Altyazı biraz daha büyük olsun."></textarea></div>
      <div class="row"><button class="btn btn-primary" id="revSend">Düzeltme gönder</button><button class="btn" id="approve">✓ Onayla, bitti</button></div>` : ''}
    ${(g.revisions || []).length ? `<details><summary>Düzeltme geçmişi (${g.revisions.length})</summary>${g.revisions.map((r) => `<div class="version"><span class="small muted">${fmtDate(r.at)} · ${esc(r.by)}</span><span>${esc(r.text)}</span><span class="pill">${r.status === 'done' ? 'yapıldı' : 'sırada'}</span></div>`).join('')}</details>` : ''}
  </section>`;
}

async function renderGame(slug) {
  const app = $('#app');
  if (!S.games.has(slug)) {
    app.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    const r = await readJSON(`games/${slug}/game.json`);
    if (!r) { app.innerHTML = `<div class="card empty">Oyun bulunamadı. <a href="#/">Geri dön</a></div>`; return; }
    S.games.set(slug, r.data);
  }
  const g = S.games.get(slug);
  const editable = ['choosing', 'collecting'].includes(g.status);
  const st = stats(g);
  const stale = g.status === 'collecting' && g.exportSig && g.exportSig !== selectionSig(g);
  app.innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">← Tüm oyunlar</a>
    <div class="row" style="margin-top:8px"><h1>${esc(g.title)}</h1><span class="spacer"></span>${statusPill(g)}</div>
    <div class="row small muted" style="margin-top:4px">
      <span>Sorumlu: <b style="color:var(--text)">${esc(g.owner)}</b></span>
      ${g.owner !== S.user ? `<button class="btn btn-ghost small" id="takeOwner" style="padding:3px 10px">Bende olsun</button>` : ''}
      <span class="spacer"></span><span id="saveState"></span>
    </div>
    ${pipelineHtml(g)}
    <div class="stack" style="margin-top:20px">
      ${g.status === 'queued_research' ? `<div class="card empty"><span class="spinner"></span><h2 style="margin-top:12px">Claude araştırma yapacak</h2><p class="muted">İş kuyrukta. Kağan'ın bilgisayarı açıkken birkaç dakika içinde işlenir ve senaryo seçenekleri burada görünür.</p></div>` : ''}
      ${['queued_edit', 'editing', 'queued_revision'].includes(g.status) ? `<div class="card empty"><span class="spinner"></span><h2 style="margin-top:12px">${esc(STATUS[g.status].label)}</h2><p class="muted">Claude kurguyu hazırlıyor. Bittiğinde video linki aşağıda görünecek.</p></div>` : ''}
      ${g.summary ? `<details class="card"><summary>Oyun özeti</summary><p>${esc(g.summary)}</p><p class="small muted">Detaylı araştırma: repo içinde <code>games/${esc(g.slug)}/research.md</code></p></details>` : ''}
      ${(g.versions || []).length || g.status === 'review' ? reviewHtml(g) : ''}
      ${g.status === 'collecting' || (g.materials || []).length ? materialsHtml(g) : ''}
      ${stale ? `<div class="card" style="border-color:var(--warn)">⚠️ Seçimler çıktıdan sonra değişti. Materyal listesini güncellemek için <b>Çıktı al</b>'a tekrar bas.</div>` : ''}
      ${g.sections?.length ? `
        <section class="card">
          <div class="row"><h2>Altyazı</h2><span class="spacer"></span>
            <div class="seg" id="capSeg">${CAPTIONS.map((c) => `<button type="button" data-cap="${c.v}" class="${g.settings.captions === c.v ? 'on' : ''}" ${editable ? '' : 'disabled'}>${c.label}</button>`).join('')}</div></div>
          <p class="small muted" id="capHint" style="margin:10px 0 0">${esc(CAPTIONS.find((c) => c.v === g.settings.captions)?.hint)}</p>
        </section>
        ${g.sections.map((s, i) => sectionHtml(s, i, editable)).join('')}` : ''}
      ${(g.log || []).length ? `<details class="card"><summary>Geçmiş</summary><div class="log">${g.log.slice().reverse().map((l) => `<div>${fmtDate(l.at)} · <b>${esc(l.by)}</b> · ${esc(l.msg)}</div>`).join('')}</div></details>` : ''}
    </div>
    ${g.sections?.length && editable ? `<div class="footer-bar"><div class="footer-inner">
      <span class="stat"><b id="stChosen">${st.chosen}/${st.total}</b> <span class="small muted">bölüm</span></span>
      <span class="stat"><b id="stSecs">~${st.secs}</b> <span class="small muted">sn anlatım</span></span>
      <span class="spacer"></span>
      ${g.status === 'collecting' ? `<button class="btn" id="startBtn">▶ Başla</button>` : ''}
      <button class="btn btn-primary" id="exportBtn" ${st.chosen === st.total ? '' : 'disabled'}>Çıktı al</button>
    </div></div>` : ''}
  `;
  bindGame(g);
}

function selectionSig(g) { return g.sections.map((s) => s.selected || '-').join(''); }

function updateFooter(g) {
  const st = stats(g);
  const c = $('#stChosen'); if (c) c.textContent = `${st.chosen}/${st.total}`;
  const s = $('#stSecs'); if (s) { s.textContent = `~${st.secs}`; s.style.color = st.secs > 58 ? 'var(--bad)' : ''; }
  const b = $('#exportBtn'); if (b) b.disabled = st.chosen !== st.total;
}

function bindGame(g0) {
  const slug = g0.slug;
  // Kayıttan sonra S.games yeni nesneyi tutar; handler'lar her zaman güncel nesneyi kullanmalı.
  const cur = () => S.games.get(slug);
  const g = new Proxy({}, { get: (_, k) => cur()[k] });
  const editable = ['choosing', 'collecting'].includes(g.status);
  const take = $('#takeOwner');
  if (take) take.onclick = () => { queueOp(slug, (x) => { x.owner = S.user; logLine(x, `${S.user} sorumluluğu aldı.`); }, 'sorumlu değişti'); renderGame(slug); };

  document.querySelectorAll('.opt').forEach((btn) => btn.onclick = () => {
    if (!editable) return toast('Bu aşamada seçimler kilitli.');
    const sid = btn.dataset.sec, oid = btn.dataset.opt;
    const sec = g.sections.find((s) => s.id === sid);
    const val = sec.selected === oid ? null : oid;
    queueOp(slug, (x) => { x.sections.find((s) => s.id === sid).selected = val; }, `${sid} → ${val || 'boş'}`);
    btn.parentElement.querySelectorAll('.opt').forEach((b) => b.classList.toggle('selected', b.dataset.opt === val));
    updateFooter(g);
  });
  document.querySelectorAll('[data-note]').forEach((ta) => ta.onchange = () => {
    const sid = ta.dataset.note, v = ta.value;
    queueOp(slug, (x) => { x.sections.find((s) => s.id === sid).note = v; }, `${sid} notu`);
  });
  document.querySelectorAll('#capSeg button').forEach((b) => b.onclick = () => {
    const v = b.dataset.cap;
    queueOp(slug, (x) => { x.settings.captions = v; }, `altyazı: ${v}`);
    document.querySelectorAll('#capSeg button').forEach((y) => y.classList.toggle('on', y === b));
    $('#capHint').textContent = CAPTIONS.find((c) => c.v === v).hint;
  });
  document.querySelectorAll('[data-mat]').forEach((cb) => cb.onchange = () => {
    const k = cb.dataset.mat, v = cb.checked, who = S.user;
    queueOp(slug, (x) => { const m = x.materials.find((m) => (m.file || m.id) === k); if (m) { m.done = v; m.doneBy = v ? who : null; } }, `materyal ${v ? '✓' : '✗'} ${k}`);
    cb.closest('.mat').classList.toggle('done', v);
  });
  const drive = $('#driveIn');
  if (drive) drive.onchange = () => { const v = drive.value.trim(); queueOp(slug, (x) => { x.settings.mediaFolderUrl = v; }, 'Drive linki'); };

  const exp = $('#exportBtn');
  if (exp) exp.onclick = async () => {
    exp.disabled = true; exp.textContent = 'Hazırlanıyor…';
    try {
      await flush(slug);
      const ng = await mutateGame(slug, (x) => {
        x.materials = buildMaterials(x);
        x.exportedAt = nowIso(); x.exportedBy = S.user; x.exportSig = selectionSig(x);
        x.status = 'collecting';
        logLine(x, 'Çıktı alındı, materyal listesi oluşturuldu.');
      }, 'çıktı alındı');
      await S.store.put(`games/${slug}/MATERIALS.md`, materialsMarkdown(ng), `[${S.user}] ${ng.title}: materyal listesi`,
        (await S.store.get(`games/${slug}/MATERIALS.md`))?.sha);
      await renderGame(slug);
      exportModal(ng);
    } catch (e) { toast('Çıktı alınamadı: ' + e.message, true); exp.disabled = false; exp.textContent = 'Çıktı al'; }
  };
  const show = $('#showExport'); if (show) show.onclick = () => exportModal(g);

  const start = $('#startBtn');
  if (start) start.onclick = async () => {
    const missing = g.materials.filter((m) => !m.done).length;
    if (!g.settings.mediaFolderUrl && !confirm('Google Drive klasör linki girilmedi. Yine de başlansın mı?')) return;
    if (missing && !confirm(`${missing} materyal henüz işaretlenmedi. Eksiklerle başlansın mı? (Claude eksikleri kendisi tamamlamaya çalışır)`)) return;
    start.disabled = true;
    try {
      await flush(slug);
      await mutateGame(slug, (x) => { x.status = 'queued_edit'; logLine(x, 'Kurgu başlatıldı.'); }, 'kurgu başlatıldı');
      await enqueue('build', slug);
      toast('Kurgu kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Başlatılamadı: ' + e.message, true); start.disabled = false; }
  };
  const rev = $('#revSend');
  if (rev) rev.onclick = async () => {
    const text = $('#revIn').value.trim(); if (!text) return;
    rev.disabled = true;
    try {
      await mutateGame(slug, (x) => { (x.revisions = x.revisions || []).push({ at: nowIso(), by: S.user, text, status: 'queued' }); x.status = 'queued_revision'; logLine(x, 'Düzeltme istendi.'); }, 'düzeltme istendi');
      await enqueue('revise', slug, { text });
      toast('Düzeltme kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Gönderilemedi: ' + e.message, true); rev.disabled = false; }
  };
  const ap = $('#approve');
  if (ap) ap.onclick = async () => {
    await mutateGame(slug, (x) => { x.status = 'done'; logLine(x, 'Video onaylandı.'); }, 'onaylandı');
    toast('Tebrikler! 🎉'); renderGame(slug);
  };
}

function exportModal(g) {
  const md = materialsMarkdown(g);
  openModal(`
    <h2>📋 ${esc(g.title)}: Çıktı</h2>
    <p class="muted small">Liste repoya da kaydedildi (<code>games/${esc(g.slug)}/MATERIALS.md</code>). Materyalleri topladıkça sayfadaki kutuları işaretleyin, hepsi bitince <b>▶ Başla</b>.</p>
    <div class="script-box" id="mdBox">${esc(md)}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn btn-primary" id="mdCopy">Kopyala</button>
      <button class="btn" id="mdDl">.md indir</button>
      <button class="btn" id="voCopy">Sadece anlatım metnini kopyala</button>
    </div>`);
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast('Kopyalandı ✓'); } catch { toast('Kopyalanamadı', true); } };
  $('#mdCopy').onclick = () => copy(md);
  $('#voCopy').onclick = () => copy(narrationScript(g));
  $('#mdDl').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = `${g.slug}-materyaller.md`; a.click(); URL.revokeObjectURL(a.href);
  };
}

/* ---------- router / boot ---------- */
async function route() {
  if (!S.user) { $('#app').innerHTML = `<div class="card empty"><h2>Önce sağ üstten ismini seç 👆</h2></div>`; return; }
  const h = location.hash.replace(/^#/, '') || '/';
  const m = h.match(/^\/game\/(.+)$/);
  try {
    if (m) await renderGame(decodeURIComponent(m[1]));
    else await renderHome();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = `<div class="card empty"><h2>Bir hata oldu</h2><p class="muted">${esc(e.message)}</p>${e.status === 401 ? '<p>Token geçersiz veya süresi dolmuş. ⚙ Ayarlar\'dan yenisini gir.</p>' : ''}</div>`;
  }
}
async function boot() {
  try { const t = await readJSON('team.json'); if (t?.data?.members?.length) S.members = t.data.members; } catch {}
  if (S.user && !S.members.includes(S.user)) S.user = null;
  renderUserSelect();
  await route();
}

applyTheme();
$('#settingsBtn').onclick = () => settingsModal();
$('#modalClose').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
window.addEventListener('beforeunload', (e) => { if ([...S.pending.values()].some((l) => l.length)) { e.preventDefault(); e.returnValue = ''; } });

(function init() {
  const tok = ls.get('studio.token');
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (tok) S.store = new GitHubStore(tok);
  else if (local) S.store = new LocalDemoStore();
  else { S.store = null; renderUserSelect(); settingsModal(true); return; }
  boot();
})();
