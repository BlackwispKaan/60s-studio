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
  // Özel repodaki ikili dosyayı (önizleme jpg/mp4/mp3) blob URL olarak döndürür.
  async blobUrl(path) {
    const r = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${encodeURI(path)}?ref=${REPO.branch}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    // GitHub raw yanıtı octet-stream döner; <video>/<audio> için doğru türü veriyoruz.
    const type = { mp4: 'video/mp4', mp3: 'audio/mpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' }[path.split('.').pop()] || '';
    return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
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
  async blobUrl(path) { return `../${path}`; }
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
    (o?.needs || []).forEach((x, j) => {
      const base = { id: `${s.id}${o.id}n${j}`, type: x.type, section: `S${i + 1}`, desc: x.desc, file: x.file, source: x.source || '', search: x.search || '', refs: x.refs || [] };
      if (x.candidates?.length) {
        // Meme/sfx adaylarını Claude indirdi; ekip sadece seçer. Seçilmezse ilk aday kullanılır.
        if (x.chosen === 'custom' && x.custom?.url) {
          out.push({ ...base, auto: true, chosen: 'custom', chosenTitle: `Kendi linki: ${x.custom.url}${x.custom.note ? ` (${x.custom.note})` : ''}`, customUrl: x.custom.url, chosenExplicit: true, done: true, doneBy: 'Claude' });
          seen.add(base.file);
          return;
        }
        const c = x.candidates.find((k) => k.id === x.chosen) || x.candidates[0];
        out.push({ ...base, auto: true, chosen: c.id, chosenTitle: c.title, chosenExplicit: !!x.chosen && x.chosen !== 'custom', done: true, doneBy: 'Claude' });
        seen.add(base.file);
      } else add(base);
    });
  });
  return out;
}
function missingChoices(g) {
  // Seçili seçeneklerde, adayı olan ama ekibin henüz seçim yapmadığı meme/sfx ihtiyaçları
  return g.sections.flatMap((s) => (selectedOpt(s)?.needs || []).filter((n) => n.candidates?.length && (!n.chosen || (n.chosen === 'custom' && !n.custom?.url))));
}
function narrationScript(g) {
  return g.sections.map((s, i) => `[S${i + 1} · ${s.time}] ${selectedOpt(s)?.narration || '—'}`).join('\n\n');
}
function materialsMarkdown(g) {
  const mats = g.materials.filter((m) => !m.auto);
  const autos = g.materials.filter((m) => m.auto);
  const by = (t) => mats.filter((m) => m.type === t);
  const line = (m) => `- [${m.done ? 'x' : ' '}] **${m.section}** ${m.desc}\n  - Dosya adı: \`${m.file}\`${m.source ? `\n  - Kaynak: ${m.source}` : ''}${m.search ? `\n  - Arama: "${m.search}"` : ''}${(m.refs || []).map((r) => `\n  - Örnek: [${r.label}](${r.url})`).join('')}`;
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

## 🤖 Claude'un hazırladıkları (sizin bir şey yapmanız gerekmez) (${autos.length})
${autos.map((m) => `- **${m.section}** ${TYPE_LABEL[m.type]}: ${m.chosenTitle}${m.chosenExplicit ? '' : ' _(seçim yapılmadı, ilk aday)_'} → \`${m.file}\``).join('\n') || '- (yok)'}

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
            <li>⚠️ GitHub'ın 📋 kopyala butonu bazen yanlış/eski kodu kopyalıyor. Kodu <b>fareyle seçip Ctrl+C</b> ile kopyala.</li>
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
    const v = $('#tokIn').value.replace(/\s+/g, '');
    if (!v) return;
    $('#tokMsg').textContent = 'Bağlanılıyor…';
    try {
      const st = new GitHubStore(v);
      const r = await st.ping();
      if (!r) throw new Error('Token geçerli ama Youtube reposunu göremiyor. Token oluştururken Repository access → "Only select repositories" → BlackwispKaan/Youtube seçilmeli (Samet/Yiğit: davet kabul edilmiş olmalı).');
      ls.set('studio.token', v); S.store = st; closeModal(); toast('Bağlandı ✓'); await boot();
    } catch (e) {
      const why = e.status === 401 ? 'GitHub bu token\'ı tanımıyor (geçersiz, silinmiş veya eksik kopyalanmış). "Regenerate" yaptıysan eski token artık çalışmaz; en son oluşan kodu kullan.'
        : e.status === 403 ? 'Token\'ın bu repoya yetkisi yok. Repository access → Youtube ve Contents: Read and write seçili mi?'
        : e.message;
      $('#tokMsg').innerHTML = `<span style="color:var(--bad)">Bağlanamadı: ${esc(why)}</span><br><span class="muted">Token uzunluğu: ${v.length} karakter (fine-grained token ~93 karakterdir, "github_pat_" ile başlar)</span>`;
    }
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
  const all = [...S.games.values()].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const archivedCount = all.filter((g) => g.archived).length;
  const games = all.filter((g) => S.showArchived || !g.archived);
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
    <div class="row" style="margin-bottom:12px"><h2>Oyunlar</h2><span class="muted small">${games.length}</span><span class="spacer"></span>
      ${archivedCount ? `<button class="btn btn-ghost small" id="toggleArchive">${S.showArchived ? 'Arşivi gizle' : `Arşiv (${archivedCount})`}</button>` : ''}</div>
    ${games.length ? `<div class="game-grid">${games.map((g) => {
      const st = STATUS[g.status]?.step ?? 0;
      const s = stats(g);
      return `<div class="card game-card ${g.archived ? 'archived' : ''}" data-open="${esc(g.slug)}" role="link" tabindex="0">
        <div class="row">${statusPill(g)}<span class="spacer"></span>
          ${driveLink(g, 'icon-btn sm')}
          <button class="icon-btn sm" data-edit="${esc(g.slug)}" title="Projeyi düzenle" aria-label="Projeyi düzenle">⋯</button></div>
        <h3>${esc(g.title)}</h3>
        <div class="progress"><span style="width:${Math.round((st / 5) * 100)}%"></span></div>
        <div class="row small muted"><span>${g.status === 'choosing' ? `${s.chosen}/${s.total} bölüm seçildi` : esc(STEPS[st])}</span><span class="spacer"></span><span>👥 ${esc(owners(g).join(', '))}</span></div>
      </div>`;
    }).join('')}</div>` : '<div class="card empty muted">Henüz oyun yok.</div>'}
  `;
  document.querySelectorAll('[data-open]').forEach((c) => {
    c.onclick = (e) => { if (!e.target.closest('a,button')) location.hash = `#/game/${c.dataset.open}`; };
    c.onkeydown = (e) => { if (e.key === 'Enter') location.hash = `#/game/${c.dataset.open}`; };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editGameModal(b.dataset.edit));
  const ta = $('#toggleArchive'); if (ta) ta.onclick = () => { S.showArchived = !S.showArchived; renderHome(); };
  $('#newGame').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#newGameName').value.trim();
    const slug = slugify(title);
    if (!slug) return;
    if (S.games.has(slug)) { location.hash = `#/game/${slug}`; return; }
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Oluşturuluyor…';
    try {
      const g = {
        schema: 1, slug, title, owner: S.user, owners: [S.user], createdBy: S.user, createdAt: nowIso(), status: 'queued_research',
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

const owners = (g) => (g.owners?.length ? g.owners : g.owner ? [g.owner] : []);
const DRIVE_SVG = '<svg viewBox="0 0 87.3 78" width="16" height="16" aria-hidden="true"><path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/><path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/><path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/><path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/><path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/><path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/></svg>';
function driveLink(g, cls = 'btn') {
  const url = g?.settings?.mediaFolderUrl;
  if (!url) return '';
  return `<a class="${cls} drive-link" href="${esc(url)}" target="_blank" rel="noopener" title="Drive klasörünü aç" aria-label="Drive klasörünü aç" onclick="event.stopPropagation()">${DRIVE_SVG}${cls === 'btn' ? '<span>Drive</span>' : ''}</a>`;
}

function editGameModal(slug) {
  const g = S.games.get(slug);
  const cur = owners(g);
  openModal(`
    <h2 style="margin-bottom:14px">Projeyi düzenle</h2>
    <div class="stack">
      <div class="field"><label for="egTitle">Oyun adı</label><input type="text" id="egTitle" value="${esc(g.title)}" maxlength="60"></div>
      <div class="field"><label>Çalışanlar</label>
        <div class="row">${S.members.map((m) => `<label class="chip"><input type="checkbox" value="${esc(m)}" ${cur.includes(m) ? 'checked' : ''}> ${esc(m)}</label>`).join('')}</div></div>
      <div class="field"><label for="egDrive">Drive klasör linki</label><input type="url" id="egDrive" value="${esc(g.settings?.mediaFolderUrl || '')}" placeholder="https://drive.google.com/drive/folders/…"></div>
      <label class="chip"><input type="checkbox" id="egArchived" ${g.archived ? 'checked' : ''}> Arşivle (ana sayfada gizlenir)</label>
      <div class="row"><button class="btn btn-primary" id="egSave">Kaydet</button><button class="btn btn-ghost" id="egCancel">Vazgeç</button></div>
    </div>`);
  $('#egCancel').onclick = closeModal;
  $('#egSave').onclick = async () => {
    const title = $('#egTitle').value.trim() || g.title;
    const os = [...document.querySelectorAll('#modalBody .chip input[type=checkbox][value]')].filter((c) => c.checked).map((c) => c.value);
    if (!os.length) return toast('En az bir çalışan seçin', true);
    const drive = $('#egDrive').value.trim(), archived = $('#egArchived').checked;
    $('#egSave').disabled = true;
    try {
      await mutateGame(slug, (x) => {
        x.title = title; x.owners = os; x.owner = os[0]; x.archived = archived;
        x.settings = { ...(x.settings || {}), mediaFolderUrl: drive };
        logLine(x, `Proje düzenlendi: çalışanlar ${os.join(', ')}${archived ? ', arşivlendi' : ''}.`);
      }, 'proje düzenlendi');
      closeModal(); toast('Kaydedildi ✓'); route();
    } catch (e) { toast('Kaydedilemedi: ' + e.message, true); $('#egSave').disabled = false; }
  };
}

function pipelineHtml(g) {
  const cur = STATUS[g.status]?.step ?? 0;
  return `<div class="pipeline">${STEPS.map((s, i) => `<div class="step ${i < cur ? 'done' : ''} ${i === cur ? 'current' : ''}"><div class="bar"></div>${s}</div>`).join('')}</div>`;
}

const REF_ICON = { youtube: '▶', gif: 'GIF', sfx: '🔊', stock: '🎞', search: '🔎', local: '📁' };
function refsHtml(refs) {
  if (!refs?.length) return '';
  return `<div class="refs">${refs.map((r) => `<a class="ref" href="${esc(r.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">
    ${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : `<span class="ref-icon">${REF_ICON[r.kind] || '🔗'}</span>`}
    <span class="ref-label">${esc(r.label)}</span></a>`).join('')}</div>`;
}

// Claude'un indirdiği meme/sfx adayları: önizleme + "Seç" butonu
function candidatesHtml(slug, sec, o, n) {
  const pv = (f) => `games/${slug}/previews/${f}`;
  return `<div class="cands">${n.candidates.map((c) => {
    const on = n.chosen === c.id;
    const isSfx = !!c.audio;
    return `<div class="cand ${on ? 'chosen' : ''}" data-cand="${esc(c.id)}">
      <button type="button" class="cand-media ${isSfx ? 'sfx' : ''}" data-play="${esc(pv(isSfx ? c.audio : c.video))}" data-kind="${isSfx ? 'sfx' : 'meme'}" title="Önizle">
        ${isSfx ? '<span class="sfx-icon">🔊</span>' : `<img data-src="${esc(pv(c.thumb))}" alt="">`}
        <span class="play-badge">▶</span>
      </button>
      <div class="cand-title">${esc(c.title)}${c.duration ? ` <span class="muted">· ${Math.round(c.duration)} sn</span>` : ''}</div>
      <div class="cand-actions">
        <button type="button" class="btn cand-pick ${on ? 'btn-primary' : ''}" data-pick="${esc(sec.id)}|${esc(o.id)}|${esc(n.file)}|${esc(c.id)}">${on ? '✓ Seçildi' : 'Seç'}</button>
        <a class="small muted" href="${esc(c.page)}" target="_blank" rel="noopener">kaynak ↗</a>
      </div>
    </div>`;
  }).join('')}${customCandHtml(sec, o, n)}</div>`;
}
function customCandHtml(sec, o, n) {
  const on = n.chosen === 'custom';
  const key = `${esc(sec.id)}|${esc(o.id)}|${esc(n.file)}`;
  return `<div class="cand custom ${on ? 'chosen' : ''}" data-cand="custom">
    <div class="cand-media custom-media"><span>✍️</span><b>Hiçbiri</b><small>kendi linkimi vereceğim</small></div>
    <div class="custom-form" ${on ? '' : 'hidden'}>
      <input type="url" class="custom-url" data-custom="${key}" placeholder="YouTube / TikTok / Tenor / myinstants linki" value="${esc(n.custom?.url || '')}">
      <input type="text" class="custom-note" data-custom-note="${key}" placeholder="Not (ör. 0:12–0:15 arası)" value="${esc(n.custom?.note || '')}">
    </div>
    <div class="cand-actions"><button type="button" class="btn cand-pick ${on ? 'btn-primary' : ''}" data-pick="${key}|custom">${on ? '✓ Seçildi' : 'Seç'}</button></div>
  </div>`;
}

function needHtml(slug, sec, o, n) {
  const head = `<div>${esc(TYPE_LABEL[n.type] || n.type)}: ${esc(n.desc)}${n.candidates?.length ? ` <span class="muted small">· ${n.chosen ? '✓ seçildi' : 'birini seç'}</span>` : ''}</div>`;
  return head + (n.candidates?.length ? candidatesHtml(slug, sec, o, n) : refsHtml(n.refs));
}

function optionHtml(sec, o, slug) {
  const on = sec.selected === o.id;
  return `<div class="opt ${on ? 'selected' : ''}" data-sec="${esc(sec.id)}" data-opt="${esc(o.id)}" role="button" tabindex="0">
    <span class="radio"></span>
    <div class="opt-en"><span class="opt-letter">${esc(o.id.toUpperCase())}</span>“${esc(o.narration)}”</div>
    <div class="opt-tr">🇹🇷 ${esc(o.tr)}</div>
    <dl class="opt-meta">
      <dt>Ekranda</dt><dd>${esc(o.visual)}</dd>
      <dt>Ses</dt><dd>${esc(o.sound)}</dd>
      ${o.needs?.length ? `<dt>Ek ihtiyaç</dt><dd>${o.needs.map((n) => needHtml(slug, sec, o, n)).join('')}</dd>` : ''}
      <dt>Teknik</dt><dd>${(o.techniques || []).map((t) => `<span class="tag" title="${esc(TECH[t] || '')}">${esc(t)} ${esc(TECH[t] || '')}</span>`).join('')}</dd>
    </dl>
  </div>`;
}

function sectionHtml(sec, i, editable, opening, slug) {
  return `<section class="card" id="sec-${esc(sec.id)}">
    <div class="section-head"><span class="section-time">${esc(sec.time)}</span><h2>${esc(sec.title)}</h2><span class="section-num">S${i + 1}</span></div>
    <div class="muted small" style="margin-top:4px">${esc(sec.goal || '')}</div>
    ${i === 0 && opening ? `<div class="opening">Sabit açılış: <b>“${esc(opening)}”</b> <span class="muted small">· seçenekler sadece ikinci cümleyi değiştirir</span></div>` : ''}
    <div class="need-box"><b>🎮 Gereken oyun görüntüsü</b><ul>${(sec.gameplay || []).map((x) => `<li>${esc(x.desc)} <code>${esc(x.file)}</code></li>`).join('')}</ul></div>
    <div class="options">${sec.options.map((o) => optionHtml(sec, o, slug)).join('')}</div>
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
    <div class="row small muted" style="margin:12px 0">
      ${g.settings.mediaFolderUrl ? `<span>Oyun görüntülerini bu klasöre, listedeki dosya adlarıyla yükleyin:</span>${driveLink(g)}` : '<span>Drive klasörü henüz bağlı değil, ⋯ Düzenle\'den ekleyin.</span>'}
    </div>
    ${order.map((t) => mats.filter((m) => m.type === t)).filter((l) => l.length).map((list) => list.map((m) => m.auto ? `
      <div class="mat">
        <span style="width:20px;text-align:center">🤖</span>
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:6px"><span class="mat-type t-${esc(m.type)}">${esc(TYPE_LABEL[m.type])}</span><span class="small muted">${esc(m.section)} · Claude hazırladı</span></div>
          <div class="mat-desc">${esc(m.chosenTitle)}${m.chosenExplicit ? '' : ' <span class="small" style="color:var(--warn)">(seçim yapılmadı, ilk aday kullanılacak)</span>'}</div>
          <div class="small muted"><code>${esc(m.file)}</code></div>
        </div>
      </div>` : `
      <label class="mat ${m.done ? 'done' : ''}">
        <input type="checkbox" data-mat="${esc(m.file || m.id)}" ${m.done ? 'checked' : ''}>
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:6px"><span class="mat-type t-${esc(m.type)}">${esc(TYPE_LABEL[m.type])}</span><span class="small muted">${esc(m.section)}</span>${m.doneBy ? `<span class="small muted">· ✓ ${esc(m.doneBy)}</span>` : ''}</div>
          <div class="mat-desc">${esc(m.desc)}</div>
          <div class="small muted"><code>${esc(m.file)}</code>${m.source ? ` · ${esc(m.source)}` : ''}${m.search ? ` · 🔎 “${esc(m.search)}”` : ''}</div>
          ${refsHtml(m.refs)}
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
    <div class="row" style="margin-top:8px"><h1>${esc(g.title)}</h1><span class="spacer"></span>${driveLink(g)}${statusPill(g)}</div>
    <div class="row small muted" style="margin-top:4px">
      <span>👥 Çalışanlar: <b style="color:var(--text)">${esc(owners(g).join(', '))}</b></span>
      ${!owners(g).includes(S.user) ? `<button class="btn btn-ghost small" id="takeOwner" style="padding:3px 10px">Ben de katılayım</button>` : ''}
      <button class="btn btn-ghost small" id="editGame" style="padding:3px 10px">⋯ Düzenle</button>
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
        ${g.sections.map((s, i) => sectionHtml(s, i, editable, g.opening, g.slug)).join('')}` : ''}
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

/* ---------- önizleme medyası (özel repodan blob olarak) ---------- */
const blobCache = new Map();
function blob(path) {
  if (!blobCache.has(path)) blobCache.set(path, S.store.blobUrl(path).catch((e) => { blobCache.delete(path); throw e; }));
  return blobCache.get(path);
}
function hydrateThumbs() {
  const imgs = [...document.querySelectorAll('img[data-src]')];
  const io = new IntersectionObserver((entries) => entries.forEach((en) => {
    if (!en.isIntersecting) return;
    io.unobserve(en.target);
    blob(en.target.dataset.src).then((u) => { en.target.src = u; }).catch(() => en.target.classList.add('broken'));
  }), { rootMargin: '400px' });
  imgs.forEach((i) => io.observe(i));
}
let currentAudio = null;
async function playPreview(el) {
  const path = el.dataset.play;
  if (el.dataset.kind === 'sfx') {
    if (currentAudio) { currentAudio.pause(); if (currentAudio._el === el) { currentAudio = null; el.classList.remove('playing'); return; } currentAudio._el.classList.remove('playing'); }
    el.classList.add('loading');
    try {
      const a = new Audio(await blob(path)); a._el = el; currentAudio = a;
      a.onended = () => { el.classList.remove('playing'); currentAudio = null; };
      el.classList.add('playing'); await a.play();
    } catch { toast('Ses yüklenemedi', true); } finally { el.classList.remove('loading'); }
    return;
  }
  el.classList.add('loading');
  try {
    const v = document.createElement('video');
    v.src = await blob(path); v.controls = true; v.autoplay = true; v.playsInline = true; v.className = 'cand-video';
    v.onclick = (ev) => ev.stopPropagation();
    el.replaceWith(v);
  } catch { toast('Video yüklenemedi', true); el.classList.remove('loading'); }
}

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
  if (take) take.onclick = () => { queueOp(slug, (x) => { x.owners = [...new Set([...owners(x), S.user])]; x.owner = x.owners[0]; logLine(x, `${S.user} projeye katıldı.`); }, 'çalışan eklendi'); renderGame(slug); };
  $('#editGame').onclick = () => editGameModal(slug);

  hydrateThumbs();
  document.querySelectorAll('.cand-media[data-play]').forEach((el) => el.onclick = (ev) => { ev.stopPropagation(); playPreview(el); });
  document.querySelectorAll('.cand-pick').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    if (!editable) return toast('Bu aşamada seçimler kilitli.');
    const [sid, oid, file, cid] = b.dataset.pick.split('|');
    const find = (x) => x.sections.find((s) => s.id === sid).options.find((o) => o.id === oid).needs.find((n) => n.file === file);
    const val = find(g).chosen === cid ? null : cid;
    queueOp(slug, (x) => { find(x).chosen = val; }, `${file} → ${val || 'boş'}`);
    const box = b.closest('.cands');
    box.querySelectorAll('.cand').forEach((c) => {
      const on = c.dataset.cand === val;
      c.classList.toggle('chosen', on);
      const pb = c.querySelector('.cand-pick'); pb.classList.toggle('btn-primary', on); pb.textContent = on ? '✓ Seçildi' : 'Seç';
    });
    const hint = box.previousElementSibling?.querySelector('.muted.small'); if (hint) hint.textContent = `· ${val ? '✓ seçildi' : 'birini seç'}`;
    const form = box.querySelector('.custom-form'); if (form) { form.hidden = val !== 'custom'; if (val === 'custom') form.querySelector('input').focus(); }
  });
  document.querySelectorAll('.custom-form input').forEach((inp) => {
    inp.onclick = (ev) => ev.stopPropagation();
    inp.onchange = () => {
      const [sid, oid, file] = (inp.dataset.custom || inp.dataset.customNote).split('|');
      const form = inp.closest('.custom-form');
      const url = form.querySelector('.custom-url').value.trim(), note = form.querySelector('.custom-note').value.trim(), who = S.user;
      queueOp(slug, (x) => { x.sections.find((s) => s.id === sid).options.find((o) => o.id === oid).needs.find((n) => n.file === file).custom = { url, note, by: who }; }, `${file} kendi linki`);
    };
  });
  document.querySelectorAll('.cands a').forEach((a) => a.addEventListener('click', (ev) => ev.stopPropagation()));

  document.querySelectorAll('.opt').forEach((btn) => btn.onclick = (ev) => {
    if (ev.target.closest('.cands, .refs')) return;
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
    const miss = missingChoices(g).length;
    if (miss && !confirm(`${miss} meme/ses efekti için seçim yapılmadı. Bunlarda ilk aday kullanılacak. Devam edilsin mi?`)) return;
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

/* ---------- entegrasyonlar (API anahtarları şifreli saklanır) ---------- */
const ELEVEN_MODELS = [
  ['eleven_multilingual_v2', 'Multilingual v2 (en doğal, önerilen)'],
  ['eleven_v3', 'Eleven v3 (en duygusal, alpha)'],
  ['eleven_turbo_v2_5', 'Turbo v2.5 (yarı kredi, hızlı)'],
  ['eleven_flash_v2_5', 'Flash v2.5 (yarı kredi, en hızlı)'],
];
async function encryptForWorker(plain) {
  const pk = (await readJSON('config/worker_pubkey.json'))?.data;
  if (!pk) throw new Error('Worker açık anahtarı bulunamadı');
  const key = await crypto.subtle.importKey('jwk', pk.jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(plain)));
  let bin = ''; ct.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}
async function renderIntegrations() {
  const app = $('#app');
  app.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
  const cur = await readJSON('config/integrations.json');
  const el = cur?.data?.elevenlabs || {};
  const num = (id, label, v, min, max, step, hint) => `<div class="field"><label for="${id}">${label} <span class="muted small" id="${id}V">${v}</span></label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"><span class="small muted">${hint}</span></div>`;
  app.innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">← Tüm oyunlar</a>
    <h1 style="margin:8px 0 6px">Entegrasyonlar</h1>
    <p class="muted" style="margin:0 0 20px">API anahtarları tarayıcıda şifrelenir; sadece Kağan'ın bilgisayarındaki Claude çözebilir. Kaydedilen anahtar burada bir daha gösterilmez, sadece değiştirilebilir.</p>
    <section class="card stack">
      <div class="row"><h2>🎙️ ElevenLabs</h2><span class="spacer"></span>
        <span class="pill dot ${el.apiKeyEnc ? 'st-done' : 'st-queued_edit'}">${el.apiKeyEnc ? `Anahtar ayarlı · ${esc(el.apiKeySetBy)} · ${fmtDate(el.apiKeySetAt)}` : 'Anahtar yok'}</span></div>
      <div class="field"><label for="elKey">API anahtarı ${el.apiKeyEnc ? '(değiştirmek için yeni anahtarı yaz)' : ''}</label>
        <input type="password" id="elKey" autocomplete="off" placeholder="${el.apiKeyEnc ? '•••••••• (kayıtlı)' : 'sk_…'}">
        <span class="small muted">ElevenLabs → sol alt <b>Developers</b> → <b>API Keys</b> → Create. İzinlerde Text to Speech ve Voices açık olsun.</span></div>
      <div class="field"><label for="elVoice">Ses kimliği (Voice ID)</label>
        <input type="text" id="elVoice" value="${esc(el.voiceId || '')}" placeholder="örn. 21m00Tcm4TlvDq8ikWAM">
        <span class="small muted">ElevenLabs → Voices → anlatıcı sesinin yanındaki ⋯ → <b>Copy voice ID</b>.</span></div>
      <div class="field"><label for="elModel">Model</label>
        <select id="elModel">${ELEVEN_MODELS.map(([v, l]) => `<option value="${v}" ${el.modelId === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${num('elStab', 'Stabilite', el.stability ?? 0.45, 0, 1, 0.05, 'Düşük = daha duygulu/değişken, yüksek = daha düz ve tutarlı.')}
      ${num('elSim', 'Benzerlik', el.similarity ?? 0.8, 0, 1, 0.05, 'Orijinal sese ne kadar sadık kalsın.')}
      ${num('elStyle', 'Stil abartısı', el.style ?? 0.2, 0, 1, 0.05, 'Yükseldikçe daha "oyunculu" okur (deadpan için düşük tutun).')}
      ${num('elSpeed', 'Hız', el.speed ?? 1.0, 0.7, 1.2, 0.05, '60 saniyeye sığdırmak için 1.0–1.1 iyi çalışır.')}
      <div class="row"><button class="btn btn-primary" id="elSave">Kaydet</button><span id="elMsg" class="small"></span></div>
    </section>`;
  ['elStab', 'elSim', 'elStyle', 'elSpeed'].forEach((id) => { const r = $('#' + id); r.oninput = () => ($('#' + id + 'V').textContent = r.value); });
  $('#elSave').onclick = async () => {
    const btn = $('#elSave'); btn.disabled = true; $('#elMsg').textContent = 'Kaydediliyor…';
    try {
      const keyPlain = $('#elKey').value.replace(/\s+/g, '');
      const enc = keyPlain ? await encryptForWorker(keyPlain) : null;
      for (let i = 0; i < 3; i++) {
        const f = await readJSON('config/integrations.json');
        const data = f?.data || {};
        const e = (data.elevenlabs = { ...(data.elevenlabs || {}) });
        e.voiceId = $('#elVoice').value.trim(); e.modelId = $('#elModel').value;
        e.stability = +$('#elStab').value; e.similarity = +$('#elSim').value; e.style = +$('#elStyle').value; e.speed = +$('#elSpeed').value;
        if (enc) { e.apiKeyEnc = enc; e.apiKeySetBy = S.user; e.apiKeySetAt = nowIso(); }
        try { await S.store.put('config/integrations.json', JSON.stringify(data, null, 2) + '\n', `[${S.user}] ElevenLabs ayarları${enc ? ' (anahtar güncellendi)' : ''}`, f?.sha); break; }
        catch (err) { if (!(err.status === 409 || err.status === 422) || i === 2) throw err; }
      }
      toast('Kaydedildi ✓'); renderIntegrations();
    } catch (err) { $('#elMsg').innerHTML = `<span style="color:var(--bad)">Kaydedilemedi: ${esc(err.message)}</span>`; btn.disabled = false; }
  };
}

/* ---------- router / boot ---------- */
async function route() {
  if (!S.user) { $('#app').innerHTML = `<div class="card empty"><h2>Önce sağ üstten ismini seç 👆</h2></div>`; return; }
  const h = location.hash.replace(/^#/, '') || '/';
  const m = h.match(/^\/game\/(.+)$/);
  try {
    if (m) await renderGame(decodeURIComponent(m[1]));
    else if (h === '/integrations') await renderIntegrations();
    else await renderHome();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = `<div class="card empty"><h2>Bir hata oldu</h2><p class="muted">${esc(e.message)}</p>${e.status === 401 ? '<p>Token geçersiz veya süresi dolmuş. ⚙ Ayarlar\'dan yenisini gir.</p>' : ''}</div>`;
  }
}
async function boot() {
  try { const t = await readJSON('team.json'); if (t?.data?.members?.length) S.members = t.data.members; } catch {}
  try {
    const c = await readJSON('config/studio.json'); S.config = c?.data || {};
    const a = $('#driveRoot'); if (a && S.config.driveRootUrl) { a.href = S.config.driveRootUrl; a.innerHTML = DRIVE_SVG; a.hidden = false; }
  } catch {}
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
