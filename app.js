/* 60s Studio — veri özel GitHub reposunda (BlackwispKaan/Youtube) durur.
   Site her kullanıcının kendi GitHub token'ıyla GitHub API üzerinden okur/yazar.
   localhost'ta token yoksa "demo modu": dosyaları yerel sunucudan okur, yazmaz. */

const REPO = { owner: 'BlackwispKaan', repo: 'Youtube', branch: 'main' };
const WORKER_NAME = 'Askeri Ücretli Çalışan'; // arka plan Claude'un ekipteki adı
const DEFAULT_MEMBERS = ['Kağan', 'Samet', 'Yiğit'];
const WORDS_PER_SEC = 2.6; // ~155 kelime/dk anlatım hızı
// Geçici bakım modu (Kağan 2026-10-08): site ve worker durduruldu. Açmak için false yapıp deploy_site.sh ile yayınla
// (worker: Görev Zamanlayıcı "60sStudioWorker" yeniden etkinleştirilir).
const MAINTENANCE = true;

const STATUS = {
  queued_research: { label: 'Araştırma sırada', step: 0 },
  researching:     { label: 'Araştırılıyor', step: 0 },
  queued_regen:    { label: 'Yeniden öneriliyor', step: 1 },
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
function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; $('#modal .modal-card').classList.remove('wide'); }

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
  async del(path, message) {
    const cur = await this.get(path);
    if (!cur) return null;
    return this.req(`contents/${encodeURI(path)}`, { method: 'DELETE', body: JSON.stringify({ message, sha: cur.sha, branch: REPO.branch }) });
  }
  async list(path) {
    const j = await this.req(`contents/${encodeURI(path)}?ref=${REPO.branch}&t=${Date.now()}`);
    return Array.isArray(j) ? j.map((x) => ({ name: x.name, type: x.type })) : [];
  }
  // Son commit'ler = ekibin ve Claude'un yaptığı her değişikliğin kaydı (etkinlik akışı için).
  async commits(n = 60) {
    const j = await this.req(`commits?sha=${REPO.branch}&per_page=${n}&t=${Date.now()}`);
    return (j || []).map((c) => ({ msg: c.commit.message.split('\n')[0], at: c.commit.author.date }));
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
  async del(path) { this.mem.set(path, null); return {}; }
  async blobUrl(path) {
    // GitHub'daki gibi blob: oynatıcıda ileri/geri sarma yerel sunucunun Range desteğine bağlı kalmasın
    const r = await fetch(`../${path}`); if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return URL.createObjectURL(await r.blob());
  }
  async commits() {
    // Demo: commit yok, oyunların log kayıtlarından üret
    return [...S.games.values()].flatMap((g) => (g.log || []).map((l) => ({ msg: `[${l.by}] ${g.title}: ${l.msg}`, at: l.at })))
      .sort((a, b) => b.at.localeCompare(a.at));
  }
  async list(path) {
    const r = await fetch(`../${path}/`, { cache: 'no-store' });
    if (!r.ok) return [];
    const html = await r.text();
    const names = [...html.matchAll(/href="([^"?#]+)"/g)].map((m) => decodeURIComponent(m[1]));
    const fromMem = [...this.mem.keys()].filter((k) => k.startsWith(path + '/')).map((k) => { const rest = k.slice(path.length + 1); return rest.includes('/') ? rest.split('/')[0] + '/' : rest; });
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
  revView: {}, // slug -> incelenen sürüm
  revTime: {}, // slug -> oynatıcı konumu (yeniden çizimde korunur)
  revDraft: {}, // slug -> yazılmakta olan not
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
  if (S.games.get(slug)?.status === 'review') setTimeout(() => refreshReviewCounts(slug), 0);
  const list = S.pending.get(slug) || [];
  list.push({ op, label });
  S.pending.set(slug, list);
  clearTimeout(S.saveTimers.get(slug));
  setSaveState('saving');
  S.saveTimers.set(slug, setTimeout(() => flush(slug), 900));
}
// Süren bir kayıt varsa önce onu bekler: "Not ekle"den hemen sonra "Yeniden oluştur"a basılınca not kaybolmasın.
const flushing = new Map();
async function flush(slug) {
  const prev = flushing.get(slug);
  if (prev) await prev;
  const list = S.pending.get(slug) || [];
  if (!list.length) return;
  S.pending.set(slug, []);
  const p = (async () => {
    try {
      await mutateGame(slug, (g) => list.forEach((x) => x.op(g)), [...new Set(list.map((x) => x.label))].join(', '));
      setSaveState('saved');
    } catch (e) {
      console.error(e); setSaveState('error'); toast('Kaydedilemedi: ' + e.message, true);
    }
  })();
  flushing.set(slug, p);
  await p;
  if (flushing.get(slug) === p) flushing.delete(slug);
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
      if (x.type === 'sfx') return;  // ses efektleri ekibe sorulmaz; worker kurguda seçer
      const base = { id: `${s.id}${o.id}n${j}`, type: x.type, section: `S${i + 1}`, desc: x.desc, file: x.file, source: x.source || '', search: x.search || '', refs: x.refs || [] };
      if (x.chosen === 'none') return;
      if (x.designed) {
        out.push({ ...base, auto: true, chosen: 'designed', chosenTitle: `Tasarım: ${x.desc}`, chosenExplicit: true, done: true, doneBy: WORKER_NAME });
        seen.add(base.file); return;
      }
      if (x.candidates?.length) {
        // Meme/sfx adaylarını Claude indirdi; ekip sadece seçer. Seçilmezse ilk aday kullanılır.
        if (x.chosen === 'custom' && x.custom?.url) {
          out.push({ ...base, auto: true, chosen: 'custom', chosenTitle: `Kendi linki: ${x.custom.url}${x.custom.note ? ` (${x.custom.note})` : ''}`, customUrl: x.custom.url, chosenExplicit: true, done: true, doneBy: WORKER_NAME });
          seen.add(base.file);
          return;
        }
        const c = x.candidates.find((k) => k.id === x.chosen) || x.candidates[0];
        out.push({ ...base, auto: true, chosen: c.id, chosenTitle: c.title, chosenExplicit: !!x.chosen && x.chosen !== 'custom', done: true, doneBy: WORKER_NAME });
        seen.add(base.file);
      } else add(base);
    });
  });
  return out;
}
function missingChoices(g) {
  // Seçili seçeneklerde, adayı olan ama ekibin henüz seçim yapmadığı meme/sfx ihtiyaçları
  return g.sections.flatMap((s) => (selectedOpt(s)?.needs || []).filter((n) => n.type !== 'sfx' && n.candidates?.length && (!n.chosen || (n.chosen === 'custom' && !n.custom?.url))));
}
function materialsMarkdown(g) {
  // Ekip için sade liste: hangi bölüm, ne kaydedilecek, hangi adla. Claude/worker'ın kendi hazırladıkları (meme/sfx/anlatım) burada yok.
  const mats = g.materials.filter((m) => !m.auto);
  const folder = g.settings?.mediaFolderUrl ? `[Drive: ${g.slug}](${g.settings.mediaFolderUrl})` : `Drive'daki \`${g.slug}/\` klasörü`;
  const icon = { gameplay: '🎮', meme: '😂', sfx: '🔊' };
  const secs = g.sections.map((s, i) => {
    const items = mats.filter((m) => m.section === `S${i + 1}`);
    if (!items.length) return '';
    return `## S${i + 1} · ${s.time} — ${s.title}\n${items.map((m) => `- [${m.done ? 'x' : ' '}] ${icon[m.type] || '•'} \`${m.file}\` — ${m.desc}${m.type !== 'gameplay' && m.search ? ` (ara: "${m.search}")` : ''}`).join('\n')}`;
  }).filter(Boolean).join('\n\n');
  return `# ${g.title} — Toplanacak materyaller (${mats.length})

Hepsini ${folder} içine, **tam olarak yazan dosya adıyla** koyun.
Klipleri 2 sn kadar uzun kesin, kırpmayı ${WORKER_NAME} yapar. Mümkünse 1080p.

${secs || '_Sizden istenen materyal yok._'}
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
        <div class="row" style="flex-wrap:nowrap">
          <input id="tokIn" type="password" placeholder="github_pat_… veya ghp_…" value="${esc(tok)}" autocomplete="off" spellcheck="false" autocapitalize="off" style="flex:1;min-width:0">
          <button type="button" class="btn small" id="tokShow" title="Göster / gizle">👁 Göster</button>
          <button type="button" class="btn small" id="tokCopy" title="Panoya kopyala">📋 Kopyala</button>
        </div>
        <span class="small muted" id="tokLen"></span>
        <span class="small muted">📱 Telefona aktarmak için: bilgisayarda <b>Kopyala</b> → kendine mesaj at (WhatsApp/Discord) → telefonda yapıştır. 93 karakteri elle yazmak hataya çok açık.</span>
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
  const tokIn = $('#tokIn');
  const showLen = () => { const v = tokIn.value.replace(/\s+/g, ''); $('#tokLen').textContent = v ? `${v.length} karakter · ${v.startsWith('github_pat_') ? 'fine-grained (~93 olmalı)' : v.startsWith('ghp_') ? 'classic (40 olmalı)' : '⚠️ github_pat_ veya ghp_ ile başlamıyor'}` : ''; };
  tokIn.oninput = showLen; showLen();
  $('#tokShow').onclick = () => { const h = tokIn.type === 'password'; tokIn.type = h ? 'text' : 'password'; $('#tokShow').textContent = h ? '🙈 Gizle' : '👁 Göster'; };
  $('#tokCopy').onclick = async () => {
    const v = tokIn.value.replace(/\s+/g, '');
    if (!v) return toast('Kopyalanacak token yok', true);
    try { await navigator.clipboard.writeText(v); toast('Token kopyalandı ✓ — kimseyle paylaşma'); }
    catch { tokIn.type = 'text'; tokIn.select(); toast('Otomatik kopyalanamadı; seçili metni Ctrl+C ile kopyala', true); }
  };
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
  app.classList.add('wide');
  app.innerHTML = `
    <div class="home-layout">
    <aside class="activity-panel">
      <div class="row"><h2>🕘 Son etkinlikler</h2></div>
      <div class="act-filters" id="actWho"></div>
      <select id="actGame" class="act-game"></select>
      <div id="activity" class="activity"><span class="spinner"></span></div>
    </aside>
    <div class="home-main">
    <div class="hero">
      <h1>60 saniyede oyunlar</h1>
      <p class="muted" style="margin:0">Yeni bir oyun yaz. ${WORKER_NAME} araştırır, senaryoyu bölüm bölüm 3 seçenekle hazırlar.</p>
    </div>
    ${workerBanner()}
    ${S.store.demo ? '<div class="card small" style="margin-bottom:16px;border-color:var(--warn)">⚠️ <b>Demo modu</b>: yerel dosyalar okunuyor, değişiklikler kaydedilmez. Kaydetmek için ⚙ ile token gir.</div>' : ''}
    <form class="new-game card" id="newGame" style="margin-bottom:24px">
      <input type="text" id="newGameName" placeholder="Oyun adı (örn. Elden Ring)" required maxlength="60">
      <button class="btn btn-primary" type="submit">+ Yeni oyun</button>
    </form>
    <section class="card tasks" id="taskList"><div class="row"><h2>🗂️ ${WORKER_NAME}'ın iş listesi</h2><span class="spacer"></span><span class="spinner" style="width:16px;height:16px;border-width:2px"></span></div></section>
    <div class="row" style="margin-bottom:12px"><h2>Oyunlar</h2><span class="muted small">${games.length}</span><span class="spacer"></span>
      ${archivedCount ? `<button class="btn btn-ghost small" id="toggleArchive">${S.showArchived ? 'Arşivi gizle' : `Arşiv (${archivedCount})`}</button>` : ''}</div>
    ${games.length ? `<div class="game-grid">${games.map((g) => {
      const st = STATUS[g.status]?.step ?? 0;
      const s = stats(g);
      return `<div class="card game-card ${g.archived ? 'archived' : ''}" data-open="${esc(g.slug)}" role="link" tabindex="0">
        <div class="row">${statusPill(g)}<span class="spacer"></span>
          ${driveLink(g, 'icon-btn sm')}
          <button class="icon-btn sm" data-edit="${esc(g.slug)}" title="Projeyi düzenle" aria-label="Projeyi düzenle">⋯</button></div>
        <h3 lang="en">${esc(g.title)}</h3>
        <div class="progress"><span style="width:${Math.round((st / 5) * 100)}%"></span></div>
        <div class="row small muted"><span>${g.status === 'choosing' ? `${s.chosen}/${s.total} bölüm seçildi` : esc(STEPS[st])}</span><span class="spacer"></span>${ownersHtml(g)}</div>
      </div>`;
    }).join('')}</div>` : '<div class="card empty muted">Henüz oyun yok.</div>'}
    </div></div>
  `;
  document.querySelectorAll('[data-open]').forEach((c) => {
    c.onclick = (e) => { if (!e.target.closest('a,button')) location.hash = `#/game/${c.dataset.open}`; };
    c.onkeydown = (e) => { if (e.key === 'Enter') location.hash = `#/game/${c.dataset.open}`; };
  });
  document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = () => editGameModal(b.dataset.edit));
  const ta = $('#toggleArchive'); if (ta) ta.onclick = () => { S.showArchived = !S.showArchived; renderHome(); };
  renderTaskList();
  renderActivity();

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
// Her ekip üyesine sabit renk (kırmızı / mavi / yeşil …), çalışan sayısı kadar kafa yan yana
const MEMBER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7', '#ec4899'];
const memberColor = (name) => { const i = S.members.indexOf(name); return MEMBER_COLORS[(i >= 0 ? i : [...name].reduce((h, c) => h + c.charCodeAt(0), 0)) % MEMBER_COLORS.length]; };
const headSvg = (name) => `<svg class="head" viewBox="0 0 24 24" aria-hidden="true" style="color:${memberColor(name)}"><circle cx="12" cy="8" r="4.2" fill="currentColor"/><path d="M3.5 21c.6-4.4 4.2-7 8.5-7s7.9 2.6 8.5 7z" fill="currentColor"/></svg>`;
function ownersHtml(g, strong = false) {
  const os = owners(g);
  if (!os.length) return '<span class="muted">—</span>';
  return `<span class="owners" title="${esc(os.join(', '))}"><span class="heads">${os.map(headSvg).join('')}</span>${os.map((n) => `<span class="owner-name" style="color:${memberColor(n)}${strong ? ';font-weight:600' : ''}">${esc(n)}</span>`).join('<span class="muted">,</span> ')}</span>`;
}
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
  const back = g.status === 'collecting';
  return `<div class="pipeline">${STEPS.map((s, i) => `<div class="step ${i < cur ? 'done' : ''} ${i === cur ? 'current' : ''} ${back && s === 'Seçim' ? 'go-back' : ''}" ${back && s === 'Seçim' ? 'title="Seçim aşamasına geri dön" role="button" tabindex="0"' : ''}><div class="bar"></div>${s}</div>`).join('')}</div>`;
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
  return `<div class="cands">${n.candidates.map((c) => {
    const pv = (f) => `${c.pvBase || `games/${slug}/previews/`}${f}`;
    const on = n.chosen === c.id;
    const isSfx = !!c.audio;
    return `<div class="cand ${on ? 'chosen' : ''}" data-cand="${esc(c.id)}">
      <button type="button" class="cand-media ${isSfx ? 'sfx' : ''}" data-play="${esc(pv(isSfx ? c.audio : c.video))}" data-kind="${isSfx ? 'sfx' : 'meme'}" title="Önizle">
        ${isSfx ? '<span class="sfx-icon">🔊</span>' : `<img data-src="${esc(pv(c.thumb))}" alt="">`}
        ${c.style ? `<span class="style-badge ${c.style}">${c.style === 'green' ? 'Green screen' : 'Tam video'}${c.vertical ? ' · dikey' : ''}</span>` : ''}
        <span class="play-badge">▶</span>
      </button>
      <div class="cand-title">${esc(c.title)}${c.duration ? ` <span class="muted">· ${Math.round(c.duration)} sn</span>` : ''}${c.tr ? `<div class="small muted">${esc(c.tr)}</div>` : ''}</div>
      <div class="cand-actions">
        <button type="button" class="btn cand-pick ${on ? 'btn-primary' : ''}" data-pick="${esc(sec.id)}|${esc(o.id)}|${esc(n.file)}|${esc(c.id)}">${on ? '✓ Seçildi' : 'Seç'}</button>
        <a class="small muted" href="${esc(c.page)}" target="_blank" rel="noopener">kaynak ↗</a>
      </div>
    </div>`;
  }).join('')}${isOptional(n) ? noneCandHtml(sec, o, n) : ''}${customCandHtml(sec, o, n)}</div>`;
}
// Bindirme de ara klip de isteğe bağlı: sadece biri, ikisi ya da hiçbiri seçilebilir
const isOptional = (n) => !!(n.optional || n.role === 'overlay' || n.role === 'cutaway');
function noneCandHtml(sec, o, n) {
  const on = n.chosen === 'none';
  const key = `${esc(sec.id)}|${esc(o.id)}|${esc(n.file)}`;
  return `<div class="cand none ${on ? 'chosen' : ''}" data-cand="none">
    <div class="cand-media custom-media"><span>🚫</span><b>Kullanma</b><small>${n.role === 'overlay' ? 'bindirme yok' : 'ara klip yok'}</small></div>
    <div class="cand-actions"><button type="button" class="btn cand-pick ${on ? 'btn-primary' : ''}" data-pick="${key}|none">${on ? '✓ Seçildi' : 'Seç'}</button></div>
  </div>`;
}
function customCandHtml(sec, o, n) {
  const on = n.chosen === 'custom';
  const key = `${esc(sec.id)}|${esc(o.id)}|${esc(n.file)}`;
  return `<div class="cand custom ${on ? 'chosen' : ''}" data-cand="custom">
    <div class="cand-media custom-media"><span>✍️</span><b>Başka klip</b><small>kendi linkimi vereceğim</small></div>
    <div class="custom-form" ${on ? '' : 'hidden'}>
      <input type="url" class="custom-url" data-custom="${key}" placeholder="YouTube / TikTok / Tenor / myinstants linki" value="${esc(n.custom?.url || '')}">
      <input type="text" class="custom-note" data-custom-note="${key}" placeholder="Not (ör. 0:12–0:15 arası)" value="${esc(n.custom?.note || '')}">
    </div>
    <div class="cand-actions"><button type="button" class="btn cand-pick ${on ? 'btn-primary' : ''}" data-pick="${key}|custom">${on ? '✓ Seçildi' : 'Seç'}</button></div>
  </div>`;
}

function needHtml(slug, sec, o, n) {
  const key = `${esc(sec.id)}|${esc(o.id)}|${esc(n.file)}`;
  const showDesc = !(n.role === 'cutaway' && !n.added);  // ara klipte başlık zaten "Ara klip"; etiket ayrıca gösteriliyor
  const head = `<div class="need-head">${showDesc ? `<span class="need-desc">${n.role ? esc(n.desc) : `${esc(TYPE_LABEL[n.type] || n.type)}: ${esc(n.desc)}`}</span>` : ''}${n.type === 'meme' ? ` <button type="button" class="at-chip" data-at="${key}" title="Bu meme anlatıcı hangi kelimeyi söylerken ekrana girsin? Tıkla, değiştir. Boş bırakırsan ${WORKER_NAME} seçer.">⏱ giriş anı: ${n.at ? `“${esc(n.at.replace(/"/g, ''))}”` : 'otomatik · belirle'}</button>` : ''}${n.candidates?.length && !n.chosen ? ` <span class="small" style="color:var(--warn)">· birini seç</span>` : ''}
    ${n.added ? `<button type="button" class="link-btn small need-del" data-del="${key}">kaldır</button>` : ''}
    ${n.type === 'meme' ? `<button type="button" class="link-btn small need-fb ${n.feedback && !n.feedbackDone ? 'on' : ''}" data-fb="${key}" title="Alakasız: bu meme repliğe uymuyor mu? Sebebini yaz, ${WORKER_NAME} değiştirsin ve ders çıkarsın.">${n.feedback && !n.feedbackDone ? '👎 bildirildi · geri al' : '👎'}</button>` : ''}</div>
    ${n.why ? `<div class="need-why">💡 ${esc(n.why)}</div>` : ''}
    ${n.review ? `<div class="need-warn">⚠️ ${esc(n.review)}</div>` : ''}
    ${n.feedback && !n.feedbackDone ? `<div class="need-note">👎 ${esc(n.feedback.by)}: “${esc(n.feedback.reason || 'alakasız')}” · alttan <b>Tekrar yap</b>'a basınca işlenir</div>` : ''}`;
  const label = n.role === 'cutaway' && n.label ? `<div class="cut-label"><span>${esc(n.label)}</span></div>` : '';
  if (n.designed) return head + `<div class="designed" title="${WORKER_NAME} çizer, seçim gerekmez.">🎨 Hazır tasarım</div>`;
  return head + label + (n.candidates?.length ? candidatesHtml(slug, sec, o, n) : refsHtml(n.refs));
}

// Örnek videolara göre (SAMPLE_BREAKDOWN): oyun üstü bindirme (≤1) + opsiyonel ara klip (≤1) + ses efekti
const ROLE_HEAD = {
  overlay: ['🟩 Oyun ekranına bindirme', 'Oyun görüntüsü durmadan üstüne konur.'],
  cutaway: ['🎬 Ara klip', ' Oyun 2–3 sn durur, etiketli tam ekran klip girer. Videoda toplam 3–4 tane yeterli.'],
  sfx: ['🔊 Ses efekti', ''],
  meme: ['🎬 Meme', ''],
};
// "Ekranda" satırı sabit metin değil, ekibin o anki seçimlerinden üretilir (2026-10-07: sabit metin seçilmemiş FBI klibini anlatıyordu)
function flowHtml(sec, o) {
  const pick = (n) => {
    if (!n || n.chosen === 'none' || !n.chosen) return null;
    if (n.chosen === 'custom') return n.custom?.url ? 'kendi verdiğiniz klip' : null;
    return (n.candidates || []).find((c) => c.id === n.chosen)?.title || null;
  };
  const at = (n) => (n?.at ? ` <span class="muted">(“${esc(n.at.replace(/"/g, ''))}”)</span>` : '');
  const ov = (o.needs || []).find((n) => n.role === 'overlay');
  const cu = (o.needs || []).find((n) => n.role === 'cutaway');
  const parts = ['🎮 Oyun görüntüsü + altyazı'];
  if (pick(ov)) parts.push(`🟩 üstüne <b>${esc(pick(ov))}</b>${at(ov)}`);
  if (pick(cu)) parts.push(`🎬 ara klip: <b>${esc(pick(cu))}</b>${at(cu)}`);
  return parts.join(' → ');
}
function roleBlocksHtml(slug, sec, o) {
  // Ses efektleri ekibe sorulmaz (2026-10-07): klip/green screen kendi sesini taşır, gerekirse worker kurguda ekler
  const needs = (o.needs || []).filter((n) => n.type !== 'gameplay' && n.type !== 'sfx');
  if (!needs.length) return '<span class="muted small">Bu seçenekte meme yok, sadece oyun görüntüsü + altyazı.</span>';
  const roleOf = (n) => n.role || (n.type === 'sfx' ? 'sfx' : 'meme');
  return ['overlay', 'cutaway', 'meme'].map((r) => {
    const list = needs.filter((n) => roleOf(n) === r);
    if (!list.length) return '';
    const [h, hint] = ROLE_HEAD[r];
    const key = (n) => `${esc(sec.id)}|${esc(o.id)}|${esc(n.file)}`;
    const extra = r === 'overlay' ? list.map((n) => `<button type="button" class="link-btn small green-add" data-green-add="${key(n)}">+ Green screen kataloğundan seç</button>`).join('')
      : r === 'cutaway' ? list.map((n) => `<button type="button" class="link-btn small canon-into" data-canon-into="${key(n)}">+ Meme Kanonu'ndan seç</button>`).join('') : '';
    return `<div class="role role-${r}"><div class="role-head"${hint ? ` title="${esc(hint)}"` : ''}>${h}</div>${list.map((n) => needHtml(slug, sec, o, n)).join('')}${extra}</div>`;
  }).join('');
}
function optionHtml(sec, o, slug) {
  const on = sec.selected === o.id;
  return `<div class="opt ${on ? 'selected' : ''}" data-sec="${esc(sec.id)}" data-opt="${esc(o.id)}" role="button" tabindex="0">
    <span class="radio"></span>
    <div class="opt-en"><span class="opt-letter">${esc(o.id.toUpperCase())}</span>“${esc(o.narration)}”</div>
    <div class="opt-tr">🇹🇷 ${esc(o.tr)}</div>
    <button type="button" class="link-btn small peek-btn">▸ ayrıntıları göster</button>
    <div class="opt-meta">
      <dl class="opt-desc">
        <dt>Ekranda</dt><dd class="flow" data-flow="${esc(sec.id)}|${esc(o.id)}">${flowHtml(sec, o)}</dd>
        ${(o.needs || []).some((n) => n.type === 'gameplay') ? `<dt>Ek görüntü</dt><dd>${o.needs.filter((n) => n.type === 'gameplay').map((n) => `<div>${esc(n.desc)} <code>${esc(n.file)}</code></div>`).join('')}</dd>` : ''}
      </dl>
      ${roleBlocksHtml(slug, sec, o)}
      ${(o.needs || []).some((n) => n.role === 'cutaway') ? '' : `<button type="button" class="link-btn small canon-add" data-canon-add="${esc(sec.id)}|${esc(o.id)}">+ Ara klip ekle (Meme Kanonu)</button>`}
    </div>
  </div>`;
}

function sectionHtml(sec, i, editable, opening, slug, g) {
  const collecting = g?.status === 'collecting';
  return `<section class="card ${sec.selected ? 'has-sel' : ''} ${collecting ? 'collecting' : ''}" id="sec-${esc(sec.id)}">
    <div class="section-head"><span class="section-time">${esc(sec.time)}</span><h2>${esc(sec.title)}</h2><span class="section-num">S${i + 1}</span></div>
    <div class="muted small" style="margin-top:4px">${esc(sec.goal || '')}</div>
    ${collecting ? secMaterialsHtml(g, i) + `<button type="button" class="btn small reopen-btn">✏️ Seçimi değiştir</button>` : ''}
    <div class="need-box"><b>🎮 Gereken oyun görüntüsü</b><ul>${(sec.gameplay || []).map((x) => `<li>${esc(x.desc)} <code>${esc(x.file)}</code></li>`).join('')}</ul></div>
    <div class="options">${sec.options.map((o) => optionHtml(sec, o, slug)).join('')}</div>
    <details class="sec-tools" ${sec.note || sec.regen ? 'open' : ''}><summary class="small muted">✏️ Not ekle / bu bölümü yeniden öner</summary>
    <textarea class="note-input" data-note="${esc(sec.id)}" placeholder="${sec.regen ? 'Yeni tema / istek: ör. “Pauselock esprisi olsun, oyunu durdurup kaçan oyunculara gönderme”' : 'Bu bölüm için not / kendi fikrin (opsiyonel)'}" ${editable ? '' : 'disabled'}>${esc(sec.note || '')}</textarea>
    <div class="row" style="margin-top:8px">
      <button type="button" class="btn ${sec.regen ? 'btn-primary' : 'btn-ghost'} small regen-btn" data-regen="${esc(sec.id)}" ${editable ? '' : 'disabled'}>${sec.regen ? '🔄 Yeniden önerilecek ✓' : '🔄 Bu bölümü yeniden öner'}</button>
      <span class="small muted">${sec.regen ? 'Alttan <b>Tekrar yap</b>\'a bas.' : 'Notuna yeni temayı yaz, sonra işaretle.'}</span>
    </div></details>
  </section>`;
}

// Materyal aşaması: üstte sadece ilerleme + Drive; her bölümün materyali kendi kartında (secMaterialsHtml)
function materialsSummaryHtml(g) {
  const mats = (g.materials || []).filter((m) => !m.auto);
  const done = mats.filter((m) => m.done).length;
  return `<section class="card" id="materials">
    <div class="row"><h2>📦 Materyaller</h2><span class="pill">${done}/${mats.length} toplandı</span><span class="spacer"></span>
      <button class="btn btn-ghost back-to-choose">← Seçime geri dön</button>
      <button class="btn btn-ghost" id="showExport">Tüm listeyi göster / indir</button></div>
    <div class="small muted" style="margin-top:10px">Her bölümün toplanacak görüntüleri aşağıda kendi kartında. Topladıkça kutuyu işaretleyin.
      ${g.settings.mediaFolderUrl ? `Dosyaları listedeki adlarla bu klasöre yükleyin: ${driveLink(g)}` : 'Drive klasörü henüz bağlı değil.'}
      Tek bir bölümü değiştirmek için o bölümdeki <b>✏️ Seçimi değiştir</b>, hepsine dönmek için <b>← Seçime geri dön</b>.</div>
  </section>`;
}
function secMaterialsHtml(g, i) {
  const mats = (g.materials || []).filter((m) => m.section === `S${i + 1}` && !m.auto);
  if (!mats.length) return '';
  return `<div class="sec-mats"><div class="sec-mats-head">📦 Bu bölüm için toplanacaklar</div>${mats.map((m) => `
      <label class="mat ${m.done ? 'done' : ''}">
        <input type="checkbox" data-mat="${esc(m.file || m.id)}" ${m.done ? 'checked' : ''}>
        <div style="flex:1;min-width:0">
          <div class="mat-desc">${esc(m.desc)}</div>
          <div class="small muted"><code>${esc(m.file)}</code>${m.doneBy ? ` · ✓ ${esc(m.doneBy)}` : ''}</div>
        </div>
      </label>`).join('')}</div>`;
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

/* ---------- İnceleme: sürümler + oynatıcı + zaman damgalı notlar → "yeniden oluştur" ---------- */
const fmtT = (t) => (t == null ? 'Genel' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`);
const latestVersion = (g) => (g.versions || []).reduce((a, v) => (!a || v.v > a.v ? v : a), null);
const draftNotes = (g, v) => (g.reviewNotes || []).filter((n) => n.v === v).sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
const capLabel = (v) => CAPTIONS.find((c) => c.v === v)?.label || v;
function sentNotes(g, v) {
  return (g.revisions || []).filter((r) => r.v === v).flatMap((r) => [
    ...(r.notes || []).map((n) => ({ ...n, rev: r })),
    ...(r.general ? [{ t: null, text: r.general, by: r.by, reply: r.generalReply, state: r.generalState, rev: r }] : []),
    ...(r.captions ? [{ t: null, text: `Altyazı → ${capLabel(r.captions)}`, by: r.by, reply: r.status === 'done' ? 'uygulandı' : '', rev: r }] : []),
    ...(r.selection || []).map((x, k) => ({ t: null, text: `Seçim: ${x}`, by: r.by, reply: r.selectionReplies?.[k] || (r.status === 'done' ? 'uygulandı' : ''), rev: r })),
    ...(r.text && !r.notes ? [{ t: null, text: r.text, by: r.by, reply: r.reply, rev: r }] : []),
  ]).sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
}
// İncelemede ekip seçimleri de değiştirebilir: sürümün `selection` anlık görüntüsüyle şimdiki seçimler karşılaştırılır.
function selectionDiff(g) {
  const snap = latestVersion(g)?.selection; if (!snap) return [];
  const out = [];
  g.sections.forEach((s, i) => {
    const old = snap[s.id]; if (!old) return;
    if (old.opt !== s.selected) { out.push(`S${i + 1}: seçenek ${String(old.opt || '-').toUpperCase()} → ${String(s.selected || '-').toUpperCase()}`); return; }
    (selectedOpt(s)?.needs || []).filter((n) => n.role === 'overlay' || n.role === 'cutaway').forEach((n) => {
      const nm = (id) => (!id || id === 'none' ? 'Kullanma' : id === 'custom' ? `Başka klip${n.custom?.url ? ` (${n.custom.url})` : ''}` : (n.candidates || []).find((c) => c.id === id)?.title || id);
      const kind = n.role === 'cutaway' ? 'ara klip' : 'green screen';
      const was = old.needs?.[n.file] ?? null, now = n.chosen ?? null;
      if ((was || 'none') !== (now || 'none')) out.push(`S${i + 1} ${kind}: ${nm(was)} → ${nm(now)}`);
      else if (now && now !== 'none' && (old.at?.[n.file] || '') !== (n.at || '')) out.push(`S${i + 1} ${kind} giriş anı → “${n.at || 'otomatik'}”`);
    });
  });
  return out;
}
function pendingChanges(g) {
  const lv = latestVersion(g); if (!lv) return 0;
  return draftNotes(g, lv.v).length + ((g.reviewGeneral || '').trim() ? 1 : 0) + (lv.captions && g.settings?.captions !== lv.captions ? 1 : 0) + selectionDiff(g).length;
}
const selDiffHtml = (g) => { const d = selectionDiff(g); return d.length ? `<div class="sel-diff"><b class="small">Seçim değişiklikleri</b>${d.map((x) => `<div class="small">• ${esc(x)}</div>`).join('')}</div>` : ''; };
function refreshReviewCounts(slug) {
  const g = S.games.get(slug); const rb = $('#rebuildBtn'); if (!g || !rb) return;
  const n = pendingChanges(g);
  rb.disabled = !n; rb.textContent = `🔄 Videoyu yeniden oluştur${n ? ` (${n})` : ''}`;
  const d = $('#selDiffBox'); if (d) d.innerHTML = selDiffHtml(g);
}
function notesHtml(g, sel, canEdit, busy) {
  const lv = latestVersion(g);
  const drafts = canEdit && sel.v === lv.v ? draftNotes(g, sel.v) : [];
  const sent = sentNotes(g, sel.v);
  if (!drafts.length && !sent.length) return canEdit && sel.v === lv.v ? '<p class="small muted" style="margin:0">Henüz not yok. Videoyu durdurduğun anda yazdığın not o saniyeye bağlanır.</p>' : '';
  return drafts.map((n) => `<div class="note"><button type="button" class="note-t tl-go" data-t="${n.t ?? 0}">${fmtT(n.t)}</button>
      <div class="note-body">${esc(n.text)}<div class="small muted">${esc(n.by)} · gönderilmedi</div></div>
      <button type="button" class="note-del" data-del-note="${esc(n.id)}" title="Notu sil">✕</button></div>`).join('')
    + sent.map((n) => `<div class="note sent"><button type="button" class="note-t tl-go" data-t="${n.t ?? 0}">${fmtT(n.t)}</button>
      <div class="note-body">${esc(n.text)}<div class="small muted">${esc(n.by || n.rev.by)} · ${n.rev.via === 'sohbet' ? 'sohbetten aktarıldı' : fmtDate(n.rev.at)}</div>
      ${n.reply ? `<div class="note-reply ${esc(n.state || '')}">${n.state === 'skipped' ? '↷' : n.state === 'question' ? '❓' : '✓'} ${esc(n.reply)}${n.rev.outV ? ` <span class="muted">→ v${n.rev.outV}</span>` : ''}</div>`
        : `<div class="note-reply wait">${busy ? `⏳ ${WORKER_NAME} uyguluyor` : 'sırada'}</div>`}</div></div>`).join('');
}
function reviewHtml(g) {
  const vs = (g.versions || []).slice().sort((a, b) => a.v - b.v);
  if (!vs.length) return `<section class="card" id="review"><h2>🎬 Kurgu</h2><p class="muted">Henüz video yok.</p></section>`;
  const lv = latestVersion(g);
  const busy = ['queued_edit', 'editing', 'queued_revision'].includes(g.status);
  const canEdit = g.status === 'review';
  const sel = vs.find((v) => v.v === S.revView[g.slug]) || lv;
  const live = canEdit && sel.v === lv.v;
  const ICON = { section: '📍', cutaway: '🎞', overlay: '🟩' };
  const KIND = { cutaway: 'ara klip', overlay: 'green screen' };
  const tl = sel.timeline || [];
  const pend = pendingChanges(g);
  return `<section class="card review" id="review">
    <div class="row"><h2>🎬 Kurgu</h2>
      <div class="seg ver-seg">${vs.map((v) => `<button type="button" data-ver="${v.v}" class="${v.v === sel.v ? 'on' : ''}">v${v.v}</button>`).join('')}</div>
      <span class="spacer"></span>
      <span class="small muted">${sel.duration ? `${Math.round(sel.duration)} sn · ` : ''}${sel.captions ? `altyazı: ${esc(capLabel(sel.captions))} · ` : ''}${fmtDate(sel.at)}</span>
    </div>
    ${sel.notes ? `<p class="small ver-notes"><b>${esc(sel.by || WORKER_NAME)}:</b> ${esc(sel.notes)}</p>` : ''}
    <div class="review-grid">
      <div class="player">
        ${sel.preview ? `<video id="revVideo" playsinline controls preload="auto" data-src="${esc(sel.preview)}"></video><div class="player-loading" id="revLoading"><span class="spinner"></span></div>`
          : `<div class="player-empty small muted">Bu sürümün site önizlemesi yok (sadece son sürümler tutulur).<br>Drive: <code>${esc((sel.file || '').split(/[\\/]/).slice(-2).join('/'))}</code></div>`}
        <div class="small muted player-meta">Önizleme 720p · tam kalite Drive'da: <code>${esc((sel.file || '').split(/[\\/]/).slice(-2).join('/'))}</code> ${driveLink(g, 'link-btn')}</div>
      </div>
      <div class="side">
        <div class="side-title">Ekranda neler var <span class="small muted">· tıklayınca o ana gider</span></div>
        <div class="tl-list">${tl.length ? tl.map((it) => `<div class="tl-row tl-${esc(it.type)}">
            <button type="button" class="tl-go" data-t="${it.t}"><span class="tl-time">${fmtT(it.t)}</span><span class="tl-ico">${ICON[it.type] || '•'}</span>
              <span class="tl-label">${it.type === 'section' ? `<b>${esc(it.sec)}</b> ${esc(it.label)}` : `${esc(it.label)} <span class="muted">(${KIND[it.type] || it.type})</span>`}</span></button>
            ${live && it.type !== 'section' ? `<button type="button" class="tl-act" data-note-at="${it.t}" data-note-label="${esc(it.label)}" title="Bu öğe için not yaz">✎</button><button type="button" class="tl-act" data-rm-at="${it.t}" data-rm-label="${esc(it.label)}" title="“Kaldırılsın” notu ekle">🗑</button>` : ''}
          </div>`).join('') : '<p class="small muted">Bu sürüm için zaman çizelgesi yok.</p>'}</div>
      </div>
    </div>
    ${live ? `<div class="composer">
        <button type="button" class="pill note-time" id="noteTime" title="Notun bağlanacağı an. Tıklayınca videonun şu anki zamanını alır.">⏱ <span>0:00</span></button>
        <textarea id="noteText" rows="2" placeholder="Bu anda ne değişsin? Örn: “green screen yanlış yerde, kaldır”. Ctrl+Enter ile ekle."></textarea>
        <button type="button" class="btn btn-primary" id="noteAdd">Not ekle</button>
      </div>` : ''}
    <div class="notes" id="revNotes">${notesHtml(g, sel, canEdit, busy)}</div>
    ${live ? `<div class="review-foot">
        <div class="row"><span class="small" style="font-weight:600">Altyazı</span>
          <div class="seg" id="capSegR">${CAPTIONS.map((c) => `<button type="button" data-cap="${c.v}" class="${g.settings.captions === c.v ? 'on' : ''}" title="${esc(c.hint)}">${c.label}</button>`).join('')}</div>
          ${lv.captions && g.settings.captions !== lv.captions ? `<span class="small" style="color:var(--warn)">v${lv.v}'de “${esc(capLabel(lv.captions))}” · yeniden oluşturunca değişir</span>` : ''}</div>
        <div id="selDiffBox">${selDiffHtml(g)}</div>
        <textarea id="revGeneral" class="note-input" rows="2" placeholder="Genel not (opsiyonel): videonun bütünüyle ilgili istek">${esc(g.reviewGeneral || '')}</textarea>
        <div class="row"><button class="btn btn-primary" id="rebuildBtn" ${pend ? '' : 'disabled'}>🔄 Videoyu yeniden oluştur${pend ? ` (${pend})` : ''}</button>
          <span class="small muted">${WORKER_NAME} notları uygular, v${lv.v + 1}'i hazırlar.</span><span class="spacer"></span>
          <button class="btn" id="approve">✓ Onayla, bitti</button></div>
      </div>` : ''}
    ${busy ? `<div class="busy-note"><span class="spinner"></span> <b>${WORKER_NAME}</b> ${g.status === 'queued_edit' ? 'kurguya başlayacak' : g.status === 'editing' ? `çalışıyor: v${lv.v + 1} hazırlanıyor` : `notları sıraya aldı: v${lv.v + 1} hazırlanacak`}. Bitince burada görünür.</div>` : ''}
    ${g.status === 'done' ? `<div class="small" style="color:var(--good)">✓ Onaylandı. Yayın için tam kalite dosya Drive'da.</div>` : ''}
  </section>`;
}

function bindReview(slug) {
  const cur = () => S.games.get(slug);
  const rerender = () => { const v = $('#revVideo'); if (v) S.revTime[slug] = v.currentTime; const t = $('#noteText'); if (t) S.revDraft[slug] = t.value; renderGame(slug); };
  document.querySelectorAll('.ver-seg button').forEach((b) => b.onclick = () => { S.revView[slug] = +b.dataset.ver; S.revTime[slug] = 0; renderGame(slug); });
  const v = $('#revVideo');
  let noteT = null; // notun bağlanacağı an (null = oynatıcının anlık zamanı)
  const tEl = $('#noteTime span');
  const now = () => (v ? Math.round(v.currentTime * 10) / 10 : 0);
  const showT = () => { if (tEl) tEl.textContent = fmtT(noteT ?? now()); };
  if (v) {
    bindMedia(v);
    blob(v.dataset.src).then((u) => {
      v.src = u; $('#revLoading')?.remove();
      if (S.revTime[slug]) v.addEventListener('loadedmetadata', () => { v.currentTime = S.revTime[slug]; showT(); }, { once: true });
    }).catch(() => { const l = $('#revLoading'); if (l) l.innerHTML = '<span class="small muted">Video yüklenemedi</span>'; });
    v.addEventListener('timeupdate', () => { if (noteT == null) showT(); });
    v.addEventListener('play', () => { noteT = null; showT(); });
  }
  const seek = (t) => { if (!v) return; v.currentTime = Math.max(0, +t || 0); noteT = null; showT(); };
  document.querySelectorAll('.tl-go').forEach((b) => b.onclick = () => seek(b.dataset.t));
  const txt = $('#noteText');
  const addNote = (t, text) => {
    const lv = latestVersion(cur());
    const n = { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), v: lv.v, t: t == null ? null : Math.round(t * 10) / 10, text, by: S.user, at: nowIso() };
    queueOp(slug, (x) => { (x.reviewNotes = x.reviewNotes || []).push(n); }, `v${lv.v} notu ${fmtT(n.t)}`);
  };
  if (txt) {
    txt.value = S.revDraft[slug] || '';
    txt.onfocus = () => { if (v && !v.paused) v.pause(); if (noteT == null) noteT = now(); showT(); };
    txt.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#noteAdd').click(); } };
    $('#noteAdd').onclick = () => {
      const text = txt.value.trim(); if (!text) return txt.focus();
      addNote(noteT ?? now(), text); S.revDraft[slug] = ''; txt.value = ''; noteT = null; rerender();
    };
  }
  $('#noteTime')?.addEventListener('click', () => { noteT = now(); showT(); });
  document.querySelectorAll('[data-note-at]').forEach((b) => b.onclick = () => {
    seek(b.dataset.noteAt); noteT = +b.dataset.noteAt; showT();
    if (txt) { txt.value = `${b.dataset.noteLabel}: `; txt.focus(); txt.setSelectionRange(txt.value.length, txt.value.length); }
  });
  document.querySelectorAll('[data-rm-at]').forEach((b) => b.onclick = () => {
    addNote(+b.dataset.rmAt, `${b.dataset.rmLabel}: kaldırılsın`); toast('Not eklendi: kaldırılsın'); rerender();
  });
  document.querySelectorAll('[data-del-note]').forEach((b) => b.onclick = () => {
    const id = b.dataset.delNote;
    queueOp(slug, (x) => { x.reviewNotes = (x.reviewNotes || []).filter((n) => n.id !== id); }, 'not silindi'); rerender();
  });
  document.querySelectorAll('#capSegR button').forEach((b) => b.onclick = () => {
    const c = b.dataset.cap; queueOp(slug, (x) => { x.settings.captions = c; }, `altyazı: ${c}`); rerender();
  });
  const gen = $('#revGeneral');
  if (gen) gen.onchange = () => { const val = gen.value; queueOp(slug, (x) => { x.reviewGeneral = val; }, 'genel not'); rerender(); };
  const rb = $('#rebuildBtn');
  if (rb) rb.onclick = async () => {
    if (gen && gen.value !== (cur().reviewGeneral || '')) { const val = gen.value; queueOp(slug, (x) => { x.reviewGeneral = val; }, 'genel not'); }
    await flush(slug);
    const g = cur(); const lv = latestVersion(g); const n = pendingChanges(g);
    if (!n) return toast('Gönderilecek not yok');
    if (!confirm(`${n} değişiklik ${WORKER_NAME}'a gönderilsin mi? v${lv.v + 1} hazırlanacak.`)) return;
    rb.disabled = true;
    const id = 'r' + Date.now().toString(36);
    try {
      await mutateGame(slug, (x) => {
        const notes = (x.reviewNotes || []).filter((m) => m.v === lv.v).sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9)).map(({ v: _v, ...m }) => m);
        const capChanged = lv.captions && x.settings.captions !== lv.captions;
        const selection = selectionDiff(x);
        (x.revisions = x.revisions || []).push({ id, at: nowIso(), by: S.user, v: lv.v, notes, general: (x.reviewGeneral || '').trim(),
          ...(capChanged ? { captions: x.settings.captions } : {}), ...(selection.length ? { selection } : {}), status: 'queued' });
        x.reviewNotes = (x.reviewNotes || []).filter((m) => m.v !== lv.v);
        x.reviewGeneral = '';
        x.status = 'queued_revision';
        logLine(x, `v${lv.v} için ${notes.length} not gönderildi, yeniden oluşturma istendi.`);
      }, `v${lv.v} düzeltme istendi`);
      await enqueue('revise', slug, { revision: id });
      toast('Kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Gönderilemedi: ' + e.message, true); rb.disabled = false; }
  };
  const ap = $('#approve');
  if (ap) ap.onclick = async () => {
    if (pendingChanges(cur()) && !confirm('Gönderilmemiş notlar var. Yine de onaylansın mı?')) return;
    await flush(slug);
    await mutateGame(slug, (x) => { x.status = 'done'; logLine(x, `v${latestVersion(x).v} onaylandı.`); }, 'onaylandı');
    toast('Tebrikler! 🎉'); renderGame(slug);
  };
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
  const reviewing = (g.versions || []).length > 0 && ['queued_edit', 'editing', 'queued_revision', 'review', 'done'].includes(g.status);
  const st = stats(g);
  const stale = g.status === 'collecting' && g.exportSig && g.exportSig !== selectionSig(g);
  app.innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">← Tüm oyunlar</a>
    <div class="row" style="margin-top:8px"><h1 lang="en">${esc(g.title)}</h1><span class="spacer"></span>${driveLink(g)}${statusPill(g)}</div>
    <div class="row small muted" style="margin-top:4px">
      <span>Çalışanlar:</span> ${ownersHtml(g, true)}
      ${!owners(g).includes(S.user) ? `<button class="btn btn-ghost small" id="takeOwner" style="padding:3px 10px">Ben de katılayım</button>` : ''}
      <button class="btn btn-ghost small" id="editGame" style="padding:3px 10px">⋯ Düzenle</button>
      <span class="spacer"></span><span id="saveState"></span>
    </div>
    ${pipelineHtml(g)}
    <div class="stack" style="margin-top:20px">
      ${workerBanner()}
      ${['queued_research', 'researching'].includes(g.status) ? `<div class="card empty"><span class="spinner"></span><h2 style="margin-top:12px">${g.status === 'researching' ? `${WORKER_NAME} araştırıyor…` : `${WORKER_NAME} araştırma yapacak`}</h2><p class="muted">Kağan'ın bilgisayarı açıkken işlenir; senaryo seçenekleri hazır olunca burada görünür.</p></div>` : ''}
      ${g.status === 'queued_regen' ? `<div class="card" style="border-color:var(--info)"><span class="spinner"></span> <b>${WORKER_NAME} yeni seçenekler hazırlıyor:</b> ${esc((g.regenSections || []).map((id) => 'S' + (g.sections.findIndex((s) => s.id === id) + 1)).join(', ') || 'tüm video')}. Bitince seçimlere devam edebilirsiniz.</div>` : ''}
      ${['queued_edit', 'editing', 'queued_revision'].includes(g.status) && !reviewing ? `<div class="card empty"><span class="spinner"></span><h2 style="margin-top:12px">${esc(STATUS[g.status].label)}</h2><p class="muted">${WORKER_NAME} kurguyu hazırlıyor. Bittiğinde video linki aşağıda görünecek.</p></div>` : ''}
      ${g.summary ? `<details class="card"><summary>Oyun özeti</summary><p>${esc(g.summary)}</p><p class="small muted">Detaylı araştırma: repo içinde <code>games/${esc(g.slug)}/research.md</code></p></details>` : ''}
      ${(g.versions || []).length || g.status === 'review' ? reviewHtml(g) : ''}
      ${g.status === 'collecting' ? materialsSummaryHtml(g) : (g.materials || []).length && !reviewing && !['choosing', 'queued_regen'].includes(g.status) ? materialsHtml(g) : ''}
      ${stale ? `<div class="card" style="border-color:var(--warn)">⚠️ Seçimler çıktıdan sonra değişti. Materyal listesini güncellemek için <b>Çıktı al</b>'a tekrar bas.</div>` : ''}
      ${g.sections?.length && reviewing ? `<details class="card script-details"><summary><b>📝 Senaryo ve seçimler</b> <span class="small muted">· ${g.status === 'review' ? 'meme / seçenek değiştirebilirsiniz; değişiklikler “Videoyu yeniden oluştur”a eklenir' : 'salt okunur'}</span></summary>
        <div class="stack" style="margin-top:14px">${g.sections.map((s, i) => sectionHtml(s, i, false, g.opening, g.slug, g)).join('')}</div></details>` : ''}
      ${g.sections?.length && !reviewing ? `
        <section class="card">
          <div class="row"><h2>Altyazı</h2><span class="spacer"></span>
            <div class="seg" id="capSeg">${CAPTIONS.map((c) => `<button type="button" data-cap="${c.v}" class="${g.settings.captions === c.v ? 'on' : ''}" ${editable ? '' : 'disabled'}>${c.label}</button>`).join('')}</div></div>
          <p class="small muted" id="capHint" style="margin:10px 0 0">${esc(CAPTIONS.find((c) => c.v === g.settings.captions)?.hint)}</p>
        </section>
        <section class="card">
          <div class="row"><h2>🎯 Genel tema / istek</h2><span class="spacer"></span>
            <label class="chip small"><input type="checkbox" id="regenAll" ${g.regenAll ? 'checked' : ''} ${editable ? '' : 'disabled'}> Tüm videoyu buna göre yeniden öner</label></div>
          <textarea id="briefIn" class="note-input" rows="2" placeholder="Opsiyonel. Videonun genel havası veya mutlaka olmasını istediğiniz espri. Örn: “Pauselock meme'i ana espri olsun, final de ona bağlansın.”" ${editable ? '' : 'disabled'}>${esc(g.brief || '')}</textarea>
        </section>
        ${g.sections.map((s, i) => sectionHtml(s, i, editable, g.opening, g.slug, g)).join('')}` : ''}
      ${(g.log || []).length ? `<details class="card"><summary>Geçmiş</summary><div class="log">${g.log.slice().reverse().map((l) => `<div>${fmtDate(l.at)} · <b>${esc(l.by)}</b> · ${esc(l.msg)}</div>`).join('')}</div></details>` : ''}
    </div>
    ${g.sections?.length && editable ? `<div class="footer-bar"><div class="footer-inner">
      <span class="stat"><b id="stChosen">${st.chosen}/${st.total}</b> <span class="small muted">bölüm</span></span>
      <span class="stat"><b id="stSecs">≈${st.secs}</b> <span class="small muted">sn anlatım</span></span>
      <span class="stat" title="Seçili seçeneklerde kullanılacak tam ekran ara klip sayısı (hedef 3–4)"><b id="stCuts">${cutCount(g)}</b> <span class="small muted">ara klip</span></span>
      <span class="sec-nav">${g.sections.map((s, i) => `<button type="button" class="sec-dot ${s.selected ? 'done' : ''}" data-go="${esc(s.id)}" title="S${i + 1} · ${esc(s.title)}${s.selected ? ' · seçildi: ' + s.selected.toUpperCase() : ' · seçim yok'}">${i + 1}</button>`).join('')}</span>
      <span class="spacer"></span>
      <button class="btn" id="regenBtn" ${regenCount(g) ? '' : 'hidden'}>🔄 Tekrar yap (<span id="regenN">${regenCount(g)}</span>)</button>
      ${g.status === 'collecting' ? `<button class="btn" id="startBtn">▶ Başla</button>` : ''}
      <button class="btn btn-primary" id="exportBtn" ${st.chosen === st.total ? '' : 'disabled'}>${exportFresh(g) ? '📋 Çıktıyı göster' : 'Çıktı al'}</button>
    </div></div>` : ''}
  `;
  bindGame(g);
}

// Çıktıyı etkileyen her şeyin imzası: seçili seçenekler, meme/ses seçimleri, kendi linkler, altyazı.
// Değişmediyse "Çıktı al" yeniden oluşturmaz, kayıtlı çıktıyı gösterir.
function selectionSig(g) {
  const raw = JSON.stringify([g.settings?.captions, ...g.sections.map((s) => {
    const o = selectedOpt(s);
    return [s.selected || '-', ...(o?.needs || []).map((n) => [n.file, n.chosen || '', n.custom?.url || '', n.at || ''])];
  })]);
  let h = 5381; for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return 'v3:' + (h >>> 0).toString(36);
}
const exportFresh = (g) => !!(g.materials?.length && g.exportSig && g.exportSig === selectionSig(g));

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
// Önizleme ses düzeyi: tek genel ayar (bu tarayıcıda saklanır). Bir videonun sesini değiştirince hepsine uygulanır.
const VOL = { v: Math.min(1, Math.max(0, parseFloat(ls.get('studio.vol') ?? '0.35'))), muted: ls.get('studio.mute') === '1' };
const volIcon = () => (VOL.muted || VOL.v === 0 ? '🔇' : VOL.v < 0.5 ? '🔉' : '🔊');
function applyVolume(src) {
  document.querySelectorAll('video.cand-video, audio').forEach((m) => { if (m !== src) { m.volume = VOL.v; m.muted = VOL.muted; } });
  if (currentAudio && currentAudio !== src) { currentAudio.volume = VOL.v; currentAudio.muted = VOL.muted; }
  const b = document.getElementById('volBtn'); if (b) b.textContent = volIcon();
  const r = document.getElementById('volRange'); if (r && document.activeElement !== r) r.value = Math.round(VOL.v * 100);
}
function setVolume(v, muted, src) {
  VOL.v = Math.min(1, Math.max(0, v)); VOL.muted = !!muted;
  ls.set('studio.vol', String(VOL.v)); ls.set('studio.mute', VOL.muted ? '1' : '0');
  applyVolume(src);
}
function bindMedia(m) {
  m.volume = VOL.v; m.muted = VOL.muted;
  m.addEventListener('volumechange', () => { if (m.volume !== VOL.v || m.muted !== VOL.muted) setVolume(m.volume, m.muted, m); });
}
function initVolumeControl() {
  const btn = document.getElementById('volBtn'), pop = document.getElementById('volPop'), r = document.getElementById('volRange');
  if (!btn) return;
  btn.textContent = volIcon(); r.value = Math.round(VOL.v * 100);
  btn.onclick = (e) => { e.stopPropagation(); pop.hidden = !pop.hidden; };
  r.oninput = () => setVolume(r.value / 100, false);
  document.getElementById('volMute').onclick = () => setVolume(VOL.v, !VOL.muted);
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target) && e.target !== btn) pop.hidden = true; });
}

async function playPreview(el) {
  const path = el.dataset.play;
  if (el.dataset.kind === 'sfx') {
    if (currentAudio) { currentAudio.pause(); if (currentAudio._el === el) { currentAudio = null; el.classList.remove('playing'); return; } currentAudio._el.classList.remove('playing'); }
    el.classList.add('loading');
    try {
      const a = new Audio(await blob(path)); a._el = el; currentAudio = a; bindMedia(a);
      a.onended = () => { el.classList.remove('playing'); currentAudio = null; };
      el.classList.add('playing'); await a.play();
    } catch { toast('Ses yüklenemedi', true); } finally { el.classList.remove('loading'); }
    return;
  }
  el.classList.add('loading');
  try {
    const v = document.createElement('video');
    v.src = await blob(path); v.controls = true; v.autoplay = true; v.playsInline = true; v.className = 'cand-video'; bindMedia(v);
    v.onclick = (ev) => ev.stopPropagation();
    el.replaceWith(v);
  } catch { toast('Video yüklenemedi', true); el.classList.remove('loading'); }
}

const feedbackCount = (g) => g.sections.reduce((k, s) => k + s.options.reduce((m, o) => m + (o.needs || []).filter((n) => n.feedback && !n.feedbackDone).length, 0), 0);
const regenCount = (g) => (g.regenAll ? g.sections.length : g.sections.filter((s) => s.regen).length) + feedbackCount(g);

/* ---------- Meme Kanonu galerisi ---------- */
async function canonModal(onAdd) {
  openModal(`<h2>🏆 Meme Kanonu</h2><div class="empty"><span class="spinner"></span></div>`);
  if (!S.canon) S.canon = (await readJSON('_studio/memes/canon.json'))?.data || [];
  const pv = (f) => `_studio/memes/previews/${f}`;
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    const list = S.canon.filter((c) => !ql || [c.name, c.tr, c.use, ...(c.tags || [])].join(' ').toLowerCase().includes(ql));
    $('#canonGrid').innerHTML = list.map((c) => `<div class="cand" data-cid="${esc(c.id)}">
      <button type="button" class="cand-media" data-play="${esc(pv(c.video))}" data-kind="meme"><img data-src="${esc(pv(c.thumb))}" alt=""><span class="play-badge">▶</span></button>
      <div class="cand-title"><b>${esc(c.name)}</b><div class="small muted">${esc(c.tr)}</div><div class="small">🎯 ${esc(c.use)}</div></div>
      <div class="cand-actions"><button type="button" class="btn canon-pick" data-cid="${esc(c.id)}">Seç</button></div></div>`).join('') || '<p class="muted">Sonuç yok.</p>';
    hydrateThumbs();
    document.querySelectorAll('#canonGrid .cand-media').forEach((el) => el.onclick = () => playPreview(el));
    document.querySelectorAll('.canon-pick').forEach((b) => b.onclick = () => {
      const c = S.canon.find((x) => x.id === b.dataset.cid);
      // Seçenek zaten belli; tek tıkla ekle. Anı (kelime) sonradan ⏱ etiketinden yazılabilir.
      closeModal(); onAdd(c, ''); toast(`${c.name} eklendi ✓ · istersen ⏱ ile anını belirt`);
    });
  };
  $('#modalBody').innerHTML = `<h2>🏆 Meme Kanonu</h2>
    <p class="small muted" style="margin-top:0">Herkesin bildiği ${S.canon.length} meme, orijinal sahneleriyle. Önizlemek için tıkla, eklemek için <b>Seç</b> (tek tık).</p>
    <input type="text" id="canonQ" placeholder="Ara: polis, kaçış, şaşkınlık, para, ölüm, siyasi…" style="width:100%;margin-bottom:10px">
    <div id="canonGrid" class="cands canon-grid"></div>`;
  $('#modal .modal-card').classList.add('wide');
  $('#canonQ').oninput = (e) => draw(e.target.value);
  draw();
}

// Green Screen Kataloğu (oyun ekranına bindirme için) — _studio/memes/greens.json
async function greensModal(onPick) {
  openModal(`<h2>🟩 Green Screen Kataloğu</h2><div class="empty"><span class="spinner"></span></div>`);
  if (!S.greens) S.greens = (await readJSON('_studio/memes/greens.json'))?.data || [];
  const pv = (c, f) => `${c.pvBase || '_studio/memes/previews/'}${f}`;
  const draw = (q = '') => {
    const ql = q.toLowerCase();
    const list = S.greens.filter((c) => !ql || [c.name, c.tr, c.use, ...(c.tags || [])].join(' ').toLowerCase().includes(ql));
    $('#greenGrid').innerHTML = list.map((c) => `<div class="cand">
      <button type="button" class="cand-media" data-play="${esc(pv(c, c.video))}" data-kind="meme"><img data-src="${esc(pv(c, c.thumb))}" alt=""><span class="play-badge">▶</span></button>
      <div class="cand-title"><b>${esc(c.name)}</b><div class="small muted">${esc(c.tr || '')}</div>${c.use ? `<div class="small">🎯 ${esc(c.use)}</div>` : ''}</div>
      <div class="cand-actions"><button type="button" class="btn green-pick" data-gid="${esc(c.id)}">Seç</button></div></div>`).join('') || '<p class="muted">Sonuç yok.</p>';
    hydrateThumbs();
    document.querySelectorAll('#greenGrid .cand-media').forEach((el) => el.onclick = () => playPreview(el));
    document.querySelectorAll('.green-pick').forEach((b) => b.onclick = () => {
      const c = S.greens.find((x) => x.id === b.dataset.gid);
      closeModal(); onPick(c); toast(`${c.name} seçildi ✓`);
    });
  };
  $('#modalBody').innerHTML = `<h2>🟩 Green Screen Kataloğu</h2>
    <p class="small muted" style="margin-top:0">${S.greens.length} green screen meme. Oyun görüntüsünün üstüne bindirilir. Önizlemek için tıkla, kullanmak için <b>Seç</b>.</p>
    <input type="text" id="greenQ" placeholder="Ara: patlama, para, polis, emoji, gözlük, iskelet…" style="width:100%;margin-bottom:10px">
    <div id="greenGrid" class="cands canon-grid"></div>`;
  $('#modal .modal-card').classList.add('wide');
  $('#greenQ').oninput = (e) => draw(e.target.value);
  draw();
}

const cutCount = (g) => g.sections.reduce((k, s) => k + ((selectedOpt(s)?.needs || []).filter((n) => n.type === 'meme' && n.chosen !== 'none' && (n.role === 'cutaway' || !n.role)).length), 0);
function updateFooter(g) {
  const cc = $('#stCuts'); if (cc) { const n = cutCount(g); cc.textContent = n; cc.style.color = n > 5 ? 'var(--warn)' : ''; }
  const st = stats(g);
  const rb = $('#regenBtn'); if (rb) { const n = regenCount(g); rb.hidden = !n; $('#regenN').textContent = n; }
  const c = $('#stChosen'); if (c) c.textContent = `${st.chosen}/${st.total}`;
  document.querySelectorAll('.sec-dot').forEach((d) => d.classList.toggle('done', !!g.sections.find((x) => x.id === d.dataset.go)?.selected));
  const s = $('#stSecs'); if (s) { s.textContent = `≈${st.secs}`; s.style.color = st.secs > 58 ? 'var(--bad)' : ''; }
  const b = $('#exportBtn'); if (b) { b.disabled = st.chosen !== st.total; b.textContent = exportFresh(g) ? '📋 Çıktıyı göster' : 'Çıktı al'; }
}

function bindGame(g0) {
  const slug = g0.slug;
  // Kayıttan sonra S.games yeni nesneyi tutar; handler'lar her zaman güncel nesneyi kullanmalı.
  const cur = () => S.games.get(slug);
  const g = new Proxy({}, { get: (_, k) => cur()[k] });
  const editable = ['choosing', 'collecting'].includes(g.status);
  const selEditable = editable || g.status === 'review'; // incelemede de meme/seçenek seçimi değişebilir
  const take = $('#takeOwner');
  if (take) take.onclick = () => { queueOp(slug, (x) => { x.owners = [...new Set([...owners(x), S.user])]; x.owner = x.owners[0]; logLine(x, `${S.user} projeye katıldı.`); }, 'çalışan eklendi'); renderGame(slug); };
  $('#editGame').onclick = () => editGameModal(slug);

  hydrateThumbs();
  document.querySelectorAll('.cand-media[data-play]').forEach((el) => el.onclick = (ev) => { ev.stopPropagation(); playPreview(el); });
  document.querySelectorAll('.cand-pick').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    if (!selEditable) return toast('Bu aşamada seçimler kilitli.');
    if (!b.closest('.opt')?.classList.contains('selected')) return toast('Önce bu seçeneği seç, sonra memeyi.');
    const [sid, oid, file, cid] = b.dataset.pick.split('|');
    const find = (x) => x.sections.find((s) => s.id === sid).options.find((o) => o.id === oid).needs.find((n) => n.file === file);
    const nd = find(g);
    const val = nd.chosen === cid ? (isOptional(nd) ? 'none' : null) : cid;
    queueOp(slug, (x) => { find(x).chosen = val; }, `${file} → ${val || 'boş'}`);
    const box = b.closest('.cands');
    box.querySelectorAll('.cand').forEach((c) => {
      const on = c.dataset.cand === val;
      c.classList.toggle('chosen', on);
      const pb = c.querySelector('.cand-pick'); pb.classList.toggle('btn-primary', on); pb.textContent = on ? '✓ Seçildi' : 'Seç';
    });
    const hint = box.previousElementSibling?.querySelector('.muted.small'); if (hint) hint.textContent = `· ${val ? '✓ seçildi' : 'birini seç'}`;
    const form = box.querySelector('.custom-form'); if (form) { form.hidden = val !== 'custom'; if (val === 'custom') form.querySelector('input').focus(); }
    const fl = document.querySelector(`[data-flow="${sid}|${oid}"]`);
    if (fl) { const sec = cur().sections.find((x) => x.id === sid); fl.innerHTML = flowHtml(sec, sec.options.find((x) => x.id === oid)); }
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
  const findNeed = (x, sid, oid, file) => x.sections.find((s) => s.id === sid).options.find((o) => o.id === oid).needs.find((n) => n.file === file);
  // + Kanondan meme ekle
  document.querySelectorAll('.canon-add').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    if (!selEditable) return toast('Bu aşamada seçimler kilitli.');
    const [sid, oid] = b.dataset.canonAdd.split('|');
    canonModal(async (c, at) => {
      const idx = g.sections.findIndex((s) => s.id === sid) + 1;
      const file = `S${idx}_meme_${c.id}.mp4`, who = S.user;
      queueOp(slug, (x) => {
        const o = x.sections.find((s) => s.id === sid).options.find((o) => o.id === oid);
        o.needs = o.needs || [];
        if (o.needs.some((n) => n.file === file)) return;
        o.needs.push({ type: 'meme', role: 'cutaway', optional: true, label: '', file, desc: `${c.name} (${c.tr})`, at, added: true, addedBy: who,
          candidates: [{ id: c.lib, title: c.name, source: 'canon', page: c.page, duration: c.duration, style: c.style, thumb: c.thumb, video: c.video, pvBase: '_studio/memes/previews/' }], chosen: c.lib });
      }, `${file} kanondan eklendi`);
      renderGame(slug);
    });
  });
  // ⏱ Giriş anı: anlatımın kelimelerine tıklayarak seç (1. tık = kelime, 2. tık = aralık)
  const atLabel = (v) => (v ? `⏱ giriş anı: “${v}”` : '⏱ giriş anı: otomatik · belirle');
  const clean = (t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  document.querySelectorAll('.at-chip').forEach((chip) => chip.onclick = (ev) => {
    ev.stopPropagation();
    if (!selEditable) return toast('Bu aşamada seçimler kilitli.');
    document.querySelectorAll('.at-picker').forEach((x) => x.remove());
    const [sid, oid, file] = chip.dataset.at.split('|');
    const opt = g.sections.find((x) => x.id === sid).options.find((x) => x.id === oid);
    const words = opt.narration.split(/\s+/).filter(Boolean);
    const cur = clean((findNeed(g, sid, oid, file).at || '').replace(/"/g, '')).toLowerCase();
    let a = -1, b = -1;
    if (cur) {  // mevcut değer anlatımda geçiyorsa işaretle
      const cw = cur.split(/\s+/);
      for (let i = 0; i + cw.length <= words.length; i++) {
        if (cw.every((w, k) => clean(words[i + k]).toLowerCase() === w)) { a = i; b = i + cw.length - 1; break; }
      }
    }
    const box = document.createElement('div');
    box.className = 'at-picker';
    box.onclick = (e) => e.stopPropagation();
    const paint = () => {
      box.querySelectorAll('.w').forEach((w) => w.classList.toggle('on', a >= 0 && +w.dataset.i >= a && +w.dataset.i <= b));
      box.querySelector('.at-prev').textContent = a >= 0 ? `“${clean(words.slice(a, b + 1).join(' '))}”` : 'otomatik (Askeri Ücretli Çalışan seçer)';
    };
    box.innerHTML = `<div class="small muted">Meme anlatıcı hangi kelimeyi söylerken girsin? <b>Kelimeye tıkla</b>; birden fazla kelime için ikinci kelimeye de tıkla.</div>
      <div class="at-words">${words.map((w, i) => `<button type="button" class="w" data-i="${i}">${esc(w)}</button>`).join('')}</div>
      <div class="row small" style="margin-top:8px;gap:8px"><span>Seçim: <b class="at-prev"></b></span><span class="spacer"></span>
        <button type="button" class="btn small" data-act="auto">Otomatik</button>
        <button type="button" class="btn small" data-act="close">Vazgeç</button>
        <button type="button" class="btn btn-primary small" data-act="save">✓ Kaydet</button></div>`;
    box.querySelectorAll('.w').forEach((w) => w.onclick = () => {
      const i = +w.dataset.i;
      if (a >= 0 && a === b && i !== a) { a = Math.min(a, i); b = Math.max(b, i); } else { a = b = i; }
      paint();
    });
    const save = (v) => {
      queueOp(slug, (x) => { findNeed(x, sid, oid, file).at = v; }, `${file} anı`);
      chip.textContent = atLabel(v); box.remove();
    };
    box.querySelector('[data-act="save"]').onclick = () => save(a >= 0 ? clean(words.slice(a, b + 1).join(' ')) : '');
    box.querySelector('[data-act="auto"]').onclick = () => save('');
    box.querySelector('[data-act="close"]').onclick = () => box.remove();
    chip.closest('.need-head').after(box); paint();
  });
  document.querySelectorAll('.back-to-choose, .step.go-back').forEach((b) => b.onclick = async () => {
    if (!confirm('Seçim aşamasına geri dönülsün mü? Materyal listesi silinir (Drive\'daki liste de kaldırılır); seçimler bitince tekrar "Çıktı al".')) return;
    try {
      await flush(slug);
      await mutateGame(slug, (x) => {
        x.status = 'choosing';
        for (const k of ['materials', 'exportSig', 'exportedAt', 'exportedBy']) delete x[k];
        logLine(x, `${S.user} seçim aşamasına geri döndü; materyal listesi sıfırlandı.`);
      }, 'seçime geri dönüldü');
      try { await S.store.del(`games/${slug}/MATERIALS.md`, `[${S.user}] ${cur().title}: materyal listesi kaldırıldı`); } catch (e) { console.warn(e); }
      toast('Seçim aşamasına dönüldü ✓'); renderGame(slug);
    } catch (e) { toast('Olmadı: ' + e.message, true); }
  });
  document.querySelectorAll('.canon-into').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    if (!selEditable) return toast('Bu aşamada seçimler kilitli.');
    const [sid, oid, file] = b.dataset.canonInto.split('|');
    canonModal((c) => {
      queueOp(slug, (x) => {
        const n = findNeed(x, sid, oid, file);
        n.candidates = n.candidates || [];
        if (!n.candidates.some((k) => k.id === c.lib)) {
          n.candidates.push({ id: c.lib, title: c.name, tr: c.tr, canon: c.id, source: 'canon', page: c.page, duration: c.duration, style: c.style,
            thumb: c.thumb, video: c.video, pvBase: '_studio/memes/previews/', ...(c.clip ? { clip: c.clip } : {}), addedBy: S.user });
        }
        n.chosen = c.lib;
      }, `${file} → kanon: ${c.id}`);
      renderGame(slug);
    });
  });
  document.querySelectorAll('.green-add').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    if (!selEditable) return toast('Bu aşamada seçimler kilitli.');
    const [sid, oid, file] = b.dataset.greenAdd.split('|');
    greensModal((c) => {
      queueOp(slug, (x) => {
        const n = findNeed(x, sid, oid, file);
        n.candidates = n.candidates || [];
        if (!n.candidates.some((k) => k.id === c.lib)) {
          n.candidates.push({ id: c.lib, title: c.name, tr: c.tr, source: 'greens', page: c.page, duration: c.duration, style: 'green',
            thumb: c.thumb, video: c.video, pvBase: c.pvBase, ...(c.clip ? { clip: c.clip } : {}), addedBy: S.user });
        }
        n.chosen = c.lib;
      }, `${file} → katalog: ${c.id}`);
      renderGame(slug);
    });
  });
  document.querySelectorAll('.reopen-btn').forEach((b) => b.onclick = () => {
    const sec = b.closest('section'); const on = sec.classList.toggle('reopen');
    b.textContent = on ? '✓ Değiştirmeyi bitir' : '✏️ Seçimi değiştir';
  });
  document.querySelectorAll('.sec-dot').forEach((d) => d.onclick = () => document.getElementById('sec-' + d.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  document.querySelectorAll('.need-fb').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    if (!editable) return toast('Bu aşamada seçimler kilitli.');
    const [sid, oid, file] = b.dataset.fb.split('|');
    const n = findNeed(g, sid, oid, file), who = S.user;
    if (n.feedback && !n.feedbackDone) {
      queueOp(slug, (x) => { delete findNeed(x, sid, oid, file).feedback; }, `${file} 👎 geri alındı`);
    } else {
      const reason = prompt('Bu meme neden uymuyor? (kısa yaz, örn. "repliği tekrar ediyor", "alakasız", "komik değil")', '');
      if (reason === null) return;
      queueOp(slug, (x) => { const m = findNeed(x, sid, oid, file); m.feedback = { by: who, at: nowIso(), reason: reason.trim() }; delete m.feedbackDone; }, `${file} 👎`);
    }
    renderGame(slug);
  });
  document.querySelectorAll('.need-del').forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    const [sid, oid, file] = b.dataset.del.split('|');
    queueOp(slug, (x) => { const o = x.sections.find((s) => s.id === sid).options.find((o) => o.id === oid); o.needs = o.needs.filter((n) => n.file !== file); }, `${file} kaldırıldı`);
    renderGame(slug);
  });

  document.querySelectorAll('.opt').forEach((btn) => btn.onclick = (ev) => {
    if (ev.target.closest('.cands, .refs, .at-picker')) return;
    if (ev.target.closest('.peek-btn')) { const on = btn.classList.toggle('peek'); ev.target.textContent = on ? '▾ ayrıntıları gizle' : '▸ ayrıntıları göster'; return; }
    if (!selEditable) return toast('Bu aşamada seçimler kilitli.');
    const sid = btn.dataset.sec, oid = btn.dataset.opt;
    const sec = g.sections.find((s) => s.id === sid);
    const val = sec.selected === oid ? null : oid;
    queueOp(slug, (x) => { x.sections.find((s) => s.id === sid).selected = val; }, `${sid} → ${val || 'boş'}`);
    btn.parentElement.querySelectorAll('.opt').forEach((b) => b.classList.toggle('selected', b.dataset.opt === val));
    btn.closest('section').classList.toggle('has-sel', !!val);
    if (val) btn.classList.remove('peek');
    updateFooter(g);
  });
  document.querySelectorAll('.regen-btn').forEach((b) => b.onclick = () => {
    const sid = b.dataset.regen;
    const sec = g.sections.find((s) => s.id === sid);
    const val = !sec.regen;
    const note = document.querySelector(`[data-note="${sid}"]`).value.trim();
    if (val && !note) { toast('Önce not kutusuna yeni temayı / isteğini yaz.', true); document.querySelector(`[data-note="${sid}"]`).focus(); return; }
    queueOp(slug, (x) => { const s = x.sections.find((s) => s.id === sid); s.regen = val; s.note = note; }, `${sid} yeniden öner: ${val ? 'evet' : 'hayır'}`);
    b.classList.toggle('btn-primary', val); b.classList.toggle('btn-ghost', !val);
    b.textContent = val ? '🔄 Yeniden önerilecek ✓' : '🔄 Bu bölümü yeniden öner';
    updateFooter(g);
  });
  const brief = $('#briefIn');
  if (brief) brief.onchange = () => { const v = brief.value.trim(); queueOp(slug, (x) => { x.brief = v; }, 'genel tema'); };
  const ra = $('#regenAll');
  if (ra) ra.onchange = () => {
    if (ra.checked && !$('#briefIn').value.trim()) { ra.checked = false; toast('Önce genel tema alanına isteğini yaz.', true); $('#briefIn').focus(); return; }
    const v = ra.checked, b = $('#briefIn').value.trim();
    queueOp(slug, (x) => { x.regenAll = v; x.brief = b; }, `tüm video yeniden: ${v}`); updateFooter(g);
  };
  const rgb = $('#regenBtn');
  if (rgb) rgb.onclick = async () => {
    const ids = g.regenAll ? g.sections.map((s) => s.id) : g.sections.filter((s) => s.regen).map((s) => s.id);
    const fb = feedbackCount(g);
    if (!ids.length && !fb) return;
    const parts = [ids.length ? `${g.regenAll ? 'Tüm video' : ids.length + ' bölüm'} notlarınıza göre yeniden önerilecek (bu bölümlerdeki seçimler sıfırlanır)` : '',
      fb ? `${fb} meme 👎 geri bildirimine göre değiştirilecek` : ''].filter(Boolean);
    if (!confirm(parts.join('\n') + '.\nDevam?')) return;
    rgb.disabled = true;
    try {
      await flush(slug);
      await mutateGame(slug, (x) => {
        if (ids.length) { x.status = 'queued_regen'; x.regenSections = ids; }
        logLine(x, [ids.length ? `Yeniden öneri istendi: ${g.regenAll ? 'tüm video' : ids.map((id) => 'S' + (x.sections.findIndex((s) => s.id === id) + 1)).join(', ')}.` : '', fb ? `${fb} meme için 👎 geri bildirimi gönderildi.` : ''].filter(Boolean).join(' '));
      }, 'yeniden öneri istendi');
      await enqueue('regenerate', slug, { sections: ids, brief: g.brief || '', all: !!g.regenAll, feedback: fb > 0 });
      toast('Kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Gönderilemedi: ' + e.message, true); rgb.disabled = false; }
  };
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
  if (exp) exp.onclick = async (ev, force = false) => {
    await flush(slug);
    if (!force && exportFresh(cur())) return exportModal(cur()); // değişiklik yok → kayıtlı çıktı
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
      toast('Çıktı oluşturuldu ✓ — Drive klasörüne de birkaç dakika içinde kopyalanır');
    } catch (e) { toast('Çıktı alınamadı: ' + e.message, true); exp.disabled = false; exp.textContent = 'Çıktı al'; }
  };
  const show = $('#showExport'); if (show) show.onclick = () => exportModal(g);

  const start = $('#startBtn');
  if (start) start.onclick = async () => {
    const missing = g.materials.filter((m) => !m.done).length;
    if (!g.settings.mediaFolderUrl && !confirm('Google Drive klasör linki girilmedi. Yine de başlansın mı?')) return;
    if (missing && !confirm(`${missing} materyal henüz işaretlenmedi. Eksiklerle başlansın mı? (${WORKER_NAME} eksikleri kendisi tamamlamaya çalışır)`)) return;
    start.disabled = true;
    try {
      await flush(slug);
      await mutateGame(slug, (x) => { x.status = 'queued_edit'; logLine(x, 'Kurgu başlatıldı.'); }, 'kurgu başlatıldı');
      await enqueue('build', slug);
      toast('Kurgu kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Başlatılamadı: ' + e.message, true); start.disabled = false; }
  };
  bindReview(slug);
}

function exportModal(g) {
  const md = materialsMarkdown(g);
  openModal(`
    <h2>📋 ${esc(g.title)}: Çıktı</h2>
    <p class="muted small">Oluşturan: <b>${esc(g.exportedBy || '?')}</b> · ${fmtDate(g.exportedAt)}${exportFresh(g) ? ' · <span style="color:var(--good)">güncel ✓</span>' : ' · <span style="color:var(--warn)">seçimler değişti, yeniden oluşturun</span>'}<br>
      Bu liste oyunun Drive klasöründe de <code>MATERIALS.md</code> olarak duruyor. Materyalleri topladıkça aşağıdaki Materyaller kartında kutuları işaretleyin, hepsi bitince <b>▶ Başla</b>.</p>
    <div class="script-box" id="mdBox">${esc(md)}</div>
    <div class="row" style="margin-top:12px">
      <button class="btn btn-primary" id="mdCopy">Kopyala</button>
      <button class="btn" id="mdDl">.md indir</button>
      ${g.settings?.mediaFolderUrl ? driveLink(g) : ''}
      <span class="spacer"></span>
      <button class="btn btn-ghost" id="mdRegen" title="Seçimler aynı olsa da listeyi baştan oluştur">↻ Yeniden oluştur</button>
    </div>`);
  $('#mdRegen').onclick = () => { closeModal(); const b = $('#exportBtn'); if (b && b.onclick) b.onclick(null, true); };
  const copy = async (t) => { try { await navigator.clipboard.writeText(t); toast('Kopyalandı ✓'); } catch { toast('Kopyalanamadı', true); } };
  $('#mdCopy').onclick = () => copy(md);
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
    <p class="muted" style="margin:0 0 20px">API anahtarları tarayıcıda şifrelenir; sadece Kağan'ın bilgisayarındaki ${WORKER_NAME} çözebilir. Kaydedilen anahtar burada bir daha gösterilmez, sadece değiştirilebilir.</p>
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

/* ---------- worker durumu (Kağan'ın PC'sindeki arka plan Claude) ---------- */
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('tr-TR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
const JOB_LABEL = { new_game: 'araştırma', regenerate: 'yeniden öneri', build: 'kurgu', revise: 'düzeltme', refresh_media: 'meme adaylarını yenileme' };
function jobName(j) {
  const m = /^\d{8}T\d{6}-([a-z_]+)-(.+)$/.exec(j || '');
  if (!m) return j || '';
  return `${S.games.get(m[2])?.title || m[2]}: ${JOB_LABEL[m[1]] || m[1]}`;
}
function workerView(w0) {
  if (!w0) return null;
  const w = { ...w0, job: jobName(w0.job) };
  const ageH = (Date.now() - new Date(w.at).getTime()) / 36e5;
  if (w.state === 'running' && ageH > 3) return { cls: 'warn', short: '⚠️ Worker yanıt vermiyor', long: `Son durum ${fmtTime(w.at)}: "${w.job}" çalışıyordu ama 3 saattir haber yok. Kağan'ın bilgisayarı kapanmış olabilir; açılınca iş devam eder.` };
  if (w.state === 'running') return { cls: 'run', short: '🟢 Çalışıyor', long: `${WORKER_NAME} şu işi yapıyor: ${w.job}` };
  if (w.state === 'limited') {
    const reset = w.resetAt ? fmtTime(w.resetAt) : 'bilinmiyor';
    return { cls: 'warn', short: `⏸ Limit doldu · ${reset}`, long: `${WORKER_NAME}'ın Claude kullanım limiti doldu, "${w.job}" yarım kaldı. ${reset} civarında limit sıfırlanınca kaldığı yerden otomatik devam edecek. (${w.message})`, banner: true };
  }
  if (w.state === 'error') return { cls: 'bad', short: '⚠️ Worker hatası', long: `"${w.job || ''}" işinde hata oldu: ${w.message}. Kuyruktaki iş 5 dakika sonra tekrar denenecek; tekrarlarsa Kağan'a haber verin.`, banner: true };
  return { cls: 'idle', short: '● Boşta', long: `Worker boşta. ${w.message || ''} (${fmtTime(w.at)})` };
}
async function loadWorkerStatus() {
  try { S.worker = (await readJSON('config/worker_status.json'))?.data || null; } catch { S.worker = null; }
  const v = workerView(S.worker), el = $('#workerState');
  if (!el) return;
  if (!v) { el.hidden = true; return; }
  el.hidden = false; el.className = `worker-pill ${v.cls}`; el.textContent = v.short; el.title = v.long;
  el.onclick = () => openModal(`<h2>${WORKER_NAME}</h2><p>${esc(v.long)}</p><p class="small muted">Son güncelleme: ${fmtDate(S.worker.at)}</p>`);
}
function workerBanner() {
  const v = workerView(S.worker);
  return v?.banner || v?.cls === 'warn' ? `<div class="card worker-banner ${v.cls}">${esc(v.short)}: ${esc(v.long)}</div>` : '';
}

/* ---------- iş listesi (kuyruk + worker durumu) ---------- */
const sinceText = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'az önce' : m < 60 ? `${m} dk` : m < 1440 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${Math.floor(m / 1440)} gün`;
};
async function renderTaskList() {
  const box = $('#taskList'); if (!box) return;
  let jobs = [];
  try {
    const files = (await S.store.list('queue')).filter((f) => f.type === 'file' && f.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name));
    jobs = await Promise.all(files.map(async (f) => ({ name: f.name.replace(/\.json$/, ''), ...((await readJSON(`queue/${f.name}`))?.data || {}) })));
  } catch {}
  const w = S.worker;
  const running = ['running', 'limited'].includes(w?.state) ? w.job : null;
  const v = workerView(w);
  const line = (j, i) => {
    const isRun = j.name === running;
    const title = S.games.get(j.slug)?.title || j.slug;
    const extra = j.type === 'regenerate' && j.payload?.sections ? ` (${j.payload.all ? 'tüm video' : j.payload.sections.length + ' bölüm'})` : '';
    return `<div class="task ${isRun ? 'run' : ''}">
      <span class="task-n">${isRun ? (w.state === 'limited' ? '⏸' : '▶') : i + 1}</span>
      <div style="flex:1;min-width:0"><b>${esc(title)}</b>: ${esc(JOB_LABEL[j.type] || j.type)}${esc(extra)}
        <div class="small muted">${esc(j.by || '?')} istedi · ${isRun ? (w.state === 'limited' ? 'limit nedeniyle yarım kaldı' : `çalışıyor (${sinceText(w.at)})`) : `sırada (${sinceText(j.at)})`}</div></div>
      <a class="small" href="#/game/${encodeURIComponent(j.slug)}">aç →</a>
    </div>`;
  };
  const state = v ? `<span class="worker-pill ${v.cls}" title="${esc(v.long)}">${esc(v.short)}</span>` : '';
  const limitRow = w?.state === 'limited' ? `<div class="task-alert warn">⏸ <div><b>${WORKER_NAME}'ın Claude kullanım limiti doldu.</b> ${jobs.length ? `${jobs.length} iş bekliyor` : 'Yeni işler bekleyecek'}; ${w.resetAt ? `<b>${esc(fmtTime(w.resetAt))}</b> civarında limit sıfırlanınca` : 'limit sıfırlanınca'} kaldığı yerden kendiliğinden devam edecek. Bu arada seçim yapmaya devam edebilirsiniz.</div></div>`
    : w?.state === 'error' ? `<div class="task-alert bad">⚠️ <div><b>Son işte hata oldu.</b> ${esc((w.message || '').slice(0, 200))} — 5 dk sonra tekrar denenecek; tekrarlarsa Kağan'a haber verin.</div></div>` : '';
  box.innerHTML = `<div class="row"><h2>🗂️ ${WORKER_NAME}'ın iş listesi</h2><span class="spacer"></span>${state}</div>${limitRow}
    ${jobs.length ? `<div class="tasks-list">${jobs.map(line).join('')}</div>
      <p class="small muted" style="margin:8px 0 0">İşler sırayla yapılır; bir araştırma ~15–30 dk sürer. Kağan'ın bilgisayarı kapalıysa açılınca devam eder.</p>`
    : `<p class="muted small" style="margin:8px 0 0">Kuyruk boş, ${WORKER_NAME} yeni iş bekliyor. ${w?.message && w.state === 'idle' ? esc(w.message.replace(/Son is bitti: (\S+)/, (_, j) => `Son biten iş: ${jobName(j)}`).replace(/kuyrukta (\d+) is var/, 'kuyrukta $1 iş var')) : ''}</p>`}`;
}

/* ---------- etkinlik akışı (sol panel) ---------- */
function humanizeAction(t) {
  return [...new Set([...new Set(t.split(', '))].map((p) => {
    let m;
    if ((m = /^s(\d+) → ([a-z]+)$/i.exec(p))) return `S${m[1]} için ${m[2].toUpperCase()} seçeneğini seçti`;
    if ((m = /^s(\d+) → boş$/i.exec(p))) return `S${m[1]} seçimini kaldırdı`;
    if ((m = /^(S\d+)_\w+\.\w+ → (boş|custom|\w+)$/.exec(p))) return m[2] === 'boş' ? `${m[1]} meme/ses seçimini kaldırdı` : m[2] === 'custom' ? `${m[1]} için kendi linkini seçti` : `${m[1]} için meme/ses adayı seçti`;
    if ((m = /^(S\d+)_\w+\.\w+ kendi linki$/.exec(p))) return `${m[1]} için kendi linkini girdi`;
    if ((m = /^s(\d+) notu$/i.exec(p))) return `S${m[1]} notunu yazdı`;
    if ((m = /^s(\d+) yeniden öner: (evet|hayır)$/i.exec(p))) return m[2] === 'evet' ? `S${m[1]} bölümünü yeniden öneri için işaretledi` : `S${m[1]} yeniden öneri işaretini kaldırdı`;
    if ((m = /^materyal (✓|✗) (.+)$/.exec(p))) return `${m[2]} materyalini ${m[1] === '✓' ? 'tamamladı' : 'geri aldı'}`;
    if ((m = /^altyazı: (\w+)$/.exec(p))) return `altyazıyı "${(CAPTIONS.find((c) => c.v === m[1]) || {}).label || m[1]}" yaptı`;
    return p;
  }))].join(', ');
}
function parseActivity(c) {
  const m = /^\[([^\]]+)\]\s*(.*)$/.exec(c.msg);
  if (!m) return { who: 'Claude (geliştirme)', icon: '🛠', text: c.msg, game: null, at: c.at, system: true };
  const isWorker = /^Claude( \(worker\))?$|^Worker$|^Askeri Ücretli Çalışan$/.test(m[1]);
  const who = isWorker ? WORKER_NAME : m[1], rest = m[2];
  if (isWorker && /^durum: /.test(rest)) {
    // "[Worker] durum: <state> | <mesaj> | job=<iş> | reset=<iso>" → anlamlı satır; eski biçim (sadece state) atlanır
    const d = /^durum: (\w+)(.*)$/.exec(rest);
    if (!d) return { who: WORKER_NAME, icon: '🤖', text: rest.replace(/^[^:]+: /, ''), title: (/^([^:]+):/.exec(rest) || [])[1], game: null, at: c.at };
    const parts = Object.fromEntries(d[2].split(' | ').slice(1).filter((p) => p.includes('=')).map((p) => [p.split('=')[0], p.slice(p.indexOf('=') + 1)]));
    const job = parts.job ? jobName(parts.job) : '';
    const slug = (/^\d{8}T\d{6}-[a-z_]+-(.+)$/.exec(parts.job || '') || [])[1] || null;
    const base = { who: WORKER_NAME, at: c.at, game: slug, title: slug ? S.games.get(slug)?.title : null };
    if (d[1] === 'running') return parts.job ? { ...base, icon: '▶', text: `işe başladı: ${job}` } : null;
    if (d[1] === 'idle') return d[2].includes('Son is bitti') ? { ...base, icon: '✅', text: 'işi bitirdi' + (/kuyrukta (\d+)/.exec(d[2]) ? ` (sırada ${/kuyrukta (\d+)/.exec(d[2])[1]} iş var)` : '') } : null;
    if (d[1] === 'limited') return { ...base, icon: '⏸', alert: 'warn', text: `Claude kullanım limiti doldu${job ? `, "${job}" yarım kaldı` : ''}. ${parts.reset ? `${fmtTime(parts.reset)} civarında kendiliğinden devam edecek.` : 'Limit sıfırlanınca devam edecek.'}` };
    if (d[1] === 'error') return { ...base, icon: '⚠️', alert: 'bad', text: `hata oldu${job ? ` (${job})` : ''}: ${d[2].split(' | ')[1] || ''}`.slice(0, 220) };
    return null;
  }
  if (/^iş kuyruğu: /.test(rest)) {
    const [, type, slug] = /^iş kuyruğu: (\S+) (\S+)/.exec(rest) || [];
    return { who, icon: '📥', text: `${S.games.get(slug)?.title || slug} için ${JOB_LABEL[type] || type} işini kuyruğa ekledi`, game: slug, at: c.at };
  }
  const ng = /^Yeni oyun: (.+)$/.exec(rest);
  if (ng) { const sl = slugify(ng[1]); return { who, icon: '🆕', text: 'yeni oyun ekledi', title: S.games.get(sl)?.title || ng[1], game: S.games.has(sl) ? sl : null, at: c.at }; }
  const g = /^([^:]+): (.*)$/.exec(rest);
  if (!g) return { who, icon: who === WORKER_NAME ? '🤖' : '✏️', text: rest, game: null, at: c.at };
  const raw = g[1].trim(), found = [...S.games.values()].find((x) => x.title === raw || x.slug === raw.toLowerCase());
  const slug = found?.slug || null, title = found?.title || raw;
  const icon = who === WORKER_NAME ? '🤖' : /çıktı|başlatıldı|onaylandı|düzeltme/i.test(g[2]) ? '🚦' : '✏️';
  return { who, icon, text: humanizeAction(g[2]), title, game: slug, at: c.at };
}
async function renderActivity() {
  const box = $('#activity'); if (!box) return;
  let items = [];
  try { items = (await S.store.commits(80)).map(parseActivity).filter(Boolean); } catch (e) { box.innerHTML = `<p class="small muted">Geçmiş yüklenemedi.</p>`; return; }
  // Aynı kişi + aynı oyun, 15 dk içindeki ardışık değişiklikleri tek satırda topla
  const grouped = [];
  for (const it of items) {
    const last = grouped[grouped.length - 1];
    if (last && !it.system && last.who === it.who && last.game === it.game && last.title === it.title &&
        Math.abs(new Date(last.at) - new Date(it.at)) < 15 * 60000 && last.texts.length < 6) { last.texts.push(it.text); continue; }
    grouped.push({ ...it, texts: [it.text] });
  }
  // Filtreler (tarayıcıda hatırlanır): kişi + oyun
  const fw = ls.get('studio.actWho', 'all'), fg = ls.get('studio.actGame', 'all');
  const people = [...S.members, WORKER_NAME];
  const chip = (v, label) => `<button type="button" class="chip-btn ${fw === v ? 'on' : ''}" data-who="${esc(v)}">${esc(label)}</button>`;
  $('#actWho').innerHTML = chip('all', 'Hepsi') + people.map((p) => chip(p, p === WORKER_NAME ? '🤖 Çalışan' : p)).join('') + chip('system', '🛠 Sistem');
  $('#actGame').innerHTML = `<option value="all">Tüm oyunlar</option>` + [...S.games.values()].map((x) => `<option value="${esc(x.slug)}" ${fg === x.slug ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
  document.querySelectorAll('#actWho .chip-btn').forEach((b) => b.onclick = () => { ls.set('studio.actWho', b.dataset.who); renderActivity(); });
  $('#actGame').onchange = (e) => { ls.set('studio.actGame', e.target.value); renderActivity(); };
  const rows = grouped.filter((g) => (fw === 'system' ? g.system : !g.system && (fw === 'all' || g.who === fw)) && (fg === 'all' || g.game === fg)).slice(0, 60);
  box.innerHTML = rows.length ? rows.map((g) => `
    <div class="act ${g.alert ? 'alert ' + g.alert : ''}">
      <span class="act-icon">${g.icon}</span>
      <div style="min-width:0">
        <div><b>${esc(g.who)}</b>${g.title ? ` · ${g.game ? `<a href="#/game/${encodeURIComponent(g.game)}">${esc(g.title)}</a>` : esc(g.title)}` : ''}</div>
        <div class="act-text">${[...new Set(g.texts)].map(esc).join('<br>')}</div>
        <div class="small muted">${sinceText(g.at)}${sinceText(g.at) === 'az önce' ? '' : ' önce'} · ${fmtDate(g.at)}</div>
      </div>
    </div>`).join('') : '<p class="small muted">Henüz etkinlik yok.</p>';
}

/* ---------- sürüm rozeti + yeni sürüm uyarısı ---------- */
const APP_V = +((document.querySelector('script[src*="app.js"]')?.getAttribute('src') || '').match(/v=(\d+)/) || [])[1] || 0;
async function checkVersion() {
  let info;
  try { info = await (await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })).json(); } catch { return; }
  const badge = $('#verBadge');
  const mine = (info.history || []).find((h) => h.v === APP_V) || info;
  badge.hidden = false;
  badge.textContent = `Sürüm ${APP_V || '?'} · ${fmtDate(mine.at)}`;
  badge.onclick = () => openModal(`<h2>Sürüm geçmişi</h2>
    <p class="small muted" style="margin-top:0">Açık olan: <b>${APP_V}</b> · Yayındaki son: <b>${info.v}</b></p>
    <div class="log">${(info.history || []).map((h) => `<div class="act"><span class="act-icon">${h.v === APP_V ? '●' : ''}</span><div><b>v${h.v}</b> · ${fmtDate(h.at)}<div class="act-text">${esc(h.msg)}</div></div></div>`).join('')}</div>`);
  const nb = $('#newVersion');
  if (info.v > APP_V) { nb.hidden = false; nb.innerHTML = `🆕 Yeni sürüm var (v${info.v}): ${esc(info.msg)} <button class="btn btn-primary small" onclick="location.reload()">Yenile</button>`; }
}

/* ---------- router / boot ---------- */
async function route() {
  if (MAINTENANCE) return;
  if (!S.user) { $('#app').innerHTML = `<div class="card empty"><h2>Önce sağ üstten ismini seç 👆</h2></div>`; return; }
  const h = location.hash.replace(/^#/, '') || '/';
  const m = h.match(/^\/game\/(.+)$/);
  $('#app').classList.remove('wide');
  loadWorkerStatus();
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
  await loadWorkerStatus();
  try {
    const c = await readJSON('config/studio.json'); S.config = c?.data || {};
    const a = $('#driveRoot'); if (a && S.config.driveRootUrl) { a.href = S.config.driveRootUrl; a.innerHTML = DRIVE_SVG; a.hidden = false; }
  } catch {}
  if (S.user && !S.members.includes(S.user)) S.user = null;
  initVolumeControl();
  renderUserSelect();
  await route();
}

applyTheme();
checkVersion(); setInterval(checkVersion, 5 * 60 * 1000);
$('#settingsBtn').onclick = () => settingsModal();
$('#modalClose').onclick = closeModal;
$('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
window.addEventListener('beforeunload', (e) => { if ([...S.pending.values()].some((l) => l.length)) { e.preventDefault(); e.returnValue = ''; } });

(function init() {
  if (MAINTENANCE) {
    $('#app').innerHTML = `<div class="card empty"><h2>⏸ 60s Studio geçici olarak kapalı</h2>
      <p class="muted">Site ve ${WORKER_NAME} şu an durduruldu. Yeniden açıldığında kaldığımız yerden devam edeceğiz; oyunlar, seçimler ve videolar yerinde duruyor.</p></div>`;
    const us = $('#userSelect'); if (us) us.disabled = true;
    return;
  }
  const tok = ls.get('studio.token');
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (tok) S.store = new GitHubStore(tok);
  else if (local) S.store = new LocalDemoStore();
  else { S.store = null; renderUserSelect(); settingsModal(true); return; }
  boot();
})();
