/* 60s Studio — veri özel GitHub reposunda (BlackwispKaan/Youtube) durur.
   Site her kullanıcının kendi GitHub token'ıyla GitHub API üzerinden okur/yazar.
   localhost'ta token yoksa "demo modu": dosyaları yerel sunucudan okur, yazmaz.
   Akış (Kağan 2026-10-10): Araştırma → Metin → Materyal → Kontrol → Kurgu → Ses → İnceleme → Yayın. */

const REPO = { owner: 'BlackwispKaan', repo: 'Youtube', branch: 'main' };
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;
const WORKER_NAME = 'Çırak'; // arka plan Claude'un ekipteki adı (eski: Askeri Ücretli Çalışan)
// Yönetici (Kağan 2026-10-10): oyun silme + entegrasyonlar yalnız onun. Kimlik "Ben:" listesinden değil token'ın GitHub
// hesabından gelir; bu site kodu yalnız Kağan'ın yayınlayabildiği ayrı repoda durduğu için eşleme ekipçe değiştirilemez.
const ADMIN = { name: 'Kağan', login: 'BlackwispKaan' };
const LOGINS = { BlackwispKaan: 'Kağan', alonehunter: 'Samet', pirocuksuz: 'Yiğit' };
const DEFAULT_MEMBERS = ['Kağan', 'Samet', 'Yiğit'];
const CLOSING = 'Follow for more games in 60 seconds.';
const WORDS_PER_SEC = 2.6; // ~155 kelime/dk anlatım hızı
const UPLOAD_MAX = 75 * 1024 * 1024; // GitHub blob sınırı 100 MB; base64 ile istek ~%33 büyür
// Geçici bakım modu (Kağan 2026-10-08): site ve worker durduruldu. Açmak için false yapıp deploy_site.sh ile yayınla
// (worker: Görev Zamanlayıcı "60sStudioWorker" yeniden etkinleştirilir).
const MAINTENANCE = false;

const STATUS = {
  queued_research:  { label: 'Araştırma sırada', step: 0 },
  researching:      { label: 'Araştırılıyor', step: 0 },
  script:           { label: 'Metin seçiliyor', step: 1 },
  queued_regen:     { label: 'Yeniden öneriliyor', step: 1 },
  queued_materials: { label: 'Materyal sırada', step: 2 },
  gathering:        { label: 'Materyal toplanıyor', step: 2 },
  materials:        { label: 'Materyal kontrolü', step: 3 },
  queued_build:     { label: 'Kurgu sırada', step: 4 },
  drafting:         { label: 'Kurgulanıyor', step: 4 },
  voicing:          { label: 'Seslendiriliyor', step: 5 },
  review:           { label: 'İncelemede', step: 6 },
  queued_revision:  { label: 'Düzeltme sırada', step: 6 },
  revising:         { label: 'Düzeltiliyor', step: 6 },
  done:             { label: 'Tamamlandı', step: 7 },
};
const LEGACY_STATUS = { choosing: 'script', collecting: 'materials', queued_edit: 'queued_build', editing: 'drafting' };
const stOf = (g) => LEGACY_STATUS[g.status] || g.status;
const STEPS = [
  { name: 'Araştırma', who: 'w', tip: `${WORKER_NAME} oyunu ve topluluğun esprilerini (Reddit, Steam, YouTube yorumları…) araştırır, her bölüm için 3 metin seçeneği yazar.` },
  { name: 'Metin', who: 't', tip: 'Ekip her bölüm için bir replik seçer. Burada meme, ses efekti, süre yok.' },
  { name: 'Materyal', who: 'w', tip: `${WORKER_NAME} oyun görüntülerini, ara klipleri, green screen memeleri ve ses efektlerini bulur.` },
  { name: 'Kontrol', who: 't', tip: 'Ekip materyalleri kontrol eder: eksik görüntüyü yükler ya da link verir, beğenmediğini değiştirir.' },
  { name: 'Kurgu', who: 'w', tip: `${WORKER_NAME} süreleri belirleyen ilk deneme videosunu (taslak, geçici sesle) kurar.` },
  { name: 'Ses', who: 'w', tip: `${WORKER_NAME} anlatıcı sesini (ElevenLabs) ve ses miksajını ekler.` },
  { name: 'İnceleme', who: 't', tip: 'Ekip izler, not yazar, materyal değiştirir → yeni sürüm.' },
  { name: 'Yayın', who: 't', tip: 'Onaylandı; YouTube linki eklenir.' },
];
const KIND = {
  gp:      { label: 'Oyun görüntüsü', icon: '🎮' },
  cutaway: { label: 'Ara klip', icon: '🎬', hint: 'Oyun durur, etiketli tam ekran klip girer (videoda toplam 3–4 yeterli).' },
  green:   { label: 'Green screen', icon: '🟩', hint: 'Oyun görüntüsü durmadan üstüne bindirilir.' },
  sfx:     { label: 'Ses efekti', icon: '🔊', hint: 'Seçilen kelimede çalar.' },
};
const CAPTIONS = [
  { v: 'full', label: 'Tam altyazı', hint: 'Anlatıcının her kelimesi ekranda. Önerilen: sessiz izleyenler ve anadili İngilizce olmayan global izleyici için en yüksek izlenme süresi.' },
  { v: 'keywords', label: 'Vurgu kelimeleri', hint: 'Sadece punchline ve anahtar kelimeler ekranda. Görüntü daha temiz kalır.' },
  { v: 'off', label: 'Kapalı', hint: 'Altyazı yok. Sadece meme etiketleri ve başlıklar gösterilir.' },
];

/* ---------- utils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
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
function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1] || '');
    r.onerror = () => rej(r.error || new Error('Dosya okunamadı'));
    r.readAsDataURL(file);
  });
}
function slugify(t) {
  const map = { ç: 'c', ğ: 'g', ı: 'i', İ: 'i', ö: 'o', ş: 's', ü: 'u' };
  return t.trim().toLowerCase().replace(/[çğıİöşü]/g, (c) => map[c] || c)
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
const safeName = (n) => (String(n).normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+/, '') || 'dosya').slice(-80);
const nowIso = () => new Date().toISOString();
const newId = (p = 'm') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const fmtDate = (iso) => { try { return new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return iso; } };
const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const shortUrl = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 24) + (x.pathname.length > 24 ? '…' : '') : ''); } catch { return u; } };
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
  hdr(extra = {}) { return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra }; }
  async req(path, opts = {}) {
    // Sondaki '/' GitHub'da CORS'suz hata döndürür (tarayıcıda "Failed to fetch"), o yüzden boş path'te eklenmez.
    const r = await fetch(`${API}${path ? '/' + path : ''}`, { ...opts, cache: 'no-store', headers: this.hdr(opts.headers || {}) });
    if (r.status === 404) return null;
    if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; e.body = await r.text(); throw e; }
    return r.status === 204 ? {} : r.json();
  }
  async ping() { return this.req(''); }
  // Token'ın sahibi (GitHub hesabı): "Ben:" seçimi ve yönetici yetkisi buna bağlı
  async whoami() {
    const r = await fetch('https://api.github.com/user', { cache: 'no-store', headers: this.hdr() });
    return r.ok ? (await r.json()).login : null;
  }
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
    const r = await fetch(`${API}/contents/${encodeURI(path)}?ref=${REPO.branch}`, { headers: this.hdr({ Accept: 'application/vnd.github.raw' }) });
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    // GitHub raw yanıtı octet-stream döner; <video>/<audio> için doğru türü veriyoruz.
    const type = { mp4: 'video/mp4', mp3: 'audio/mpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' }[path.split('.').pop()] || '';
    return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
  }
  // Dosya yükleme: tek dosyalık YETİM dala (upload/<slug>/<uid>) yazılır, ana dal şişmez; Çırak dosyayı Drive'a alınca dalı
  // siler (media.py ingest). uploads.github.com tarayıcıya CORS izni vermiyor, git veri API'si veriyor.
  async uploadFile(file, branch, path, onProgress) {
    const b64 = await fileToB64(file);
    const blob = await new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open('POST', `${API}/git/blobs`);
      Object.entries(this.hdr({ 'Content-Type': 'application/json' })).forEach(([k, v]) => x.setRequestHeader(k, v));
      x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
      x.onload = () => (x.status < 300 ? res(JSON.parse(x.responseText))
        : rej(Object.assign(new Error(`GitHub ${x.status}`), { status: x.status, body: x.responseText })));
      x.onerror = () => rej(new Error('Bağlantı koptu'));
      x.send(JSON.stringify({ content: b64, encoding: 'base64' }));
    });
    const post = async (p, body) => {
      const r = await this.req(p, { method: 'POST', body: JSON.stringify(body) });
      if (!r) throw Object.assign(new Error('GitHub 404 (yazma izni yok)'), { status: 404 });
      return r;
    };
    const tree = await post('git/trees', { tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
    const commit = await post('git/commits', { message: `[${S.user}] yükleme: ${path}`, tree: tree.sha, parents: [] });
    await post('git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
    return { branch, path };
  }
}
class LocalDemoStore {
  // localhost'ta proje klasörü sunuluyorsa (site/ bir alt klasör) dosyaları okur; yazmalar sadece bellekte.
  constructor() { this.demo = true; this.mem = new Map(); }
  async ping() { return {}; }
  async whoami() { return ls.get('studio.demoLogin', ADMIN.login); } // demo: ?login denemesi için localStorage
  async get(path) {
    if (this.mem.has(path)) { const t = this.mem.get(path); return t === null ? null : { text: t, sha: 'mem' }; }
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
  async uploadFile(file, branch, path, onProgress) {
    for (let i = 1; i <= 10; i++) { await new Promise((r) => setTimeout(r, 150)); onProgress?.(i / 10); }
    return { branch, path };
  }
  async commits() {
    // Demo: commit yok, oyunların log kayıtlarından üret
    return [...S.games.values()].flatMap((g) => (g.log || []).map((l) => ({ msg: `[${l.by}] ${g.title}: ${l.msg}`, at: l.at })))
      .sort((a, b) => b.at.localeCompare(a.at));
  }
  async list(path) {
    const r = await fetch(`../${path}/`, { cache: 'no-store' });
    const html = r.ok ? await r.text() : '';
    const names = [...html.matchAll(/href="([^"?#]+)"/g)].map((m) => decodeURIComponent(m[1]));
    const fromMem = [...this.mem.entries()].filter(([k, v]) => v !== null && k.startsWith(path + '/'))
      .map(([k]) => { const rest = k.slice(path.length + 1); return rest.includes('/') ? rest.split('/')[0] + '/' : rest; });
    return [...new Set([...names, ...fromMem])].filter((n) => !n.startsWith('.') && !n.startsWith('/'))
      .map((n) => ({ name: n.replace(/\/$/, ''), type: n.endsWith('/') ? 'dir' : 'file' }));
  }
}

/* ---------- state ---------- */
const S = {
  store: null,
  user: ls.get('studio.user'),
  login: null, // token'ın GitHub hesabı
  members: DEFAULT_MEMBERS,
  games: new Map(), // slug -> game
  pending: new Map(), // slug -> [ops]
  saveTimers: new Map(),
  revView: {}, // slug -> incelenen sürüm
  revTime: {}, // slug -> oynatıcı konumu (yeniden çizimde korunur)
  pubEdit: {}, // slug -> yayın linki düzenleniyor
  revDraft: {}, // slug -> yazılmakta olan not
  mediaOpen: {}, // slug -> incelemede materyal kartı açık mı
  uploading: new Map(), // "sid|eid" -> {pct, name, size}
  localMedia: new Map(), // yükleme uid -> bu oturumdaki yerel önizleme (object URL)
  cats: {}, // katalog önbelleği
};
const isAdmin = () => !!S.login && S.login === ADMIN.login;
const lockedName = () => LOGINS[S.login] || null;

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
  setTimeout(() => updateCounts(slug), 0);
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
  return name;
}
const logLine = (g, msg) => (g.log = g.log || []).push({ at: nowIso(), by: S.user, msg });
const whoName = (n) => (n === 'Askeri Ücretli Çalışan' || n === 'Claude (worker)' ? WORKER_NAME : n);

/* ---------- derived ---------- */
const selectedOpt = (sec) => (sec.options || []).find((o) => o.id === sec.selected);
const isV2 = (g) => (g.schema || 1) >= 2;
function stats(g) {
  const secs = g.sections || [];
  const chosen = secs.filter((s) => selectedOpt(s));
  const words = chosen.reduce((n, s) => n + selectedOpt(s).narration.split(/\s+/).length, 0);
  return { total: secs.length, chosen: chosen.length, words, secs: Math.round(words / WORDS_PER_SEC) };
}
const mediaOf = (s) => (s.media = s.media || { gameplay: [], items: [] });
const secIdx = (g, sid) => g.sections.findIndex((s) => s.id === sid);
function findEntry(g, sid, eid) {
  const s = g.sections.find((x) => x.id === sid); if (!s) return null;
  const m = mediaOf(s);
  return (m.gameplay || []).find((x) => x.id === eid) || (m.items || []).find((x) => x.id === eid) || null;
}
const entryKind = (x) => x.kind || 'gp';
const missingSecs = (g) => (g.sections || []).filter((s) => !((s.media?.gameplay || []).some((x) => x.src)));
function itemCounts(g) {
  const c = { cutaway: 0, green: 0, sfx: 0 };
  (g.sections || []).forEach((s) => (s.media?.items || []).forEach((x) => { c[x.kind] = (c[x.kind] || 0) + 1; }));
  return c;
}
// Materyal anlık görüntüsü — _studio/tools/media.py snapshot() ile AYNI biçim (Çırak sürüm yayınlarken mediaBase yazar).
const srcKey = (src) => (src && (src.uid || src.url || src.id || src.lib)) || '';
function mediaSnapshot(g) {
  const out = {};
  (g.sections || []).forEach((s) => {
    const m = s.media || {};
    [...(m.gameplay || []).map((x) => ['gp', x]), ...(m.items || []).map((x) => [x.kind, x])].forEach(([kind, x]) => {
      (out[s.id] = out[s.id] || {})[x.id] = [JSON.stringify([kind, srcKey(x.src), x.at || '', x.range || '', x.label || '']), x.title || x.desc || ''];
    });
  });
  return out;
}
// İncelemede ekibin materyal değişiklikleri (son sürüme göre) → "Videoyu yeniden oluştur"a eklenir
function mediaDiff(g) {
  if (!isV2(g) || !g.mediaBase) return [];
  const cur = mediaSnapshot(g), base = g.mediaBase, out = [];
  const kindTr = (sig) => { try { return (KIND[JSON.parse(sig)[0]]?.label || 'materyal').toLowerCase(); } catch { return 'materyal'; } };
  g.sections.forEach((s, i) => {
    const a = base[s.id] || {}, b = cur[s.id] || {};
    Object.entries(b).forEach(([id, [sig, label]]) => {
      if (!a[id]) out.push(`S${i + 1} ${kindTr(sig)} eklendi: ${label}`);
      else if (a[id][0] !== sig) out.push(`S${i + 1} ${kindTr(sig)} değişti: ${label}`);
    });
    Object.entries(a).forEach(([id, [sig, label]]) => { if (!b[id]) out.push(`S${i + 1} ${kindTr(sig)} kaldırıldı: ${label}`); });
  });
  return out;
}

/* ---------- kimlik ---------- */
function renderUserSelect() {
  const sel = $('#userSelect');
  const fixed = lockedName();
  if (fixed) {
    sel.innerHTML = `<option selected>${esc(fixed)}${fixed === ADMIN.name ? ' 👑' : ''}</option>`;
    sel.disabled = true; sel.classList.add('locked'); // hesaba kilitli: açılır liste değil, düz etiket (ok yok)
    sel.title = `GitHub hesabın: ${S.login}`;
    return;
  }
  // Tanınmayan hesap: Kağan'ın adı (yönetici) ve başka hesaplara bağlı adlar seçilemez
  const mapped = Object.values(LOGINS);
  let free = S.members.filter((m) => m !== ADMIN.name && !mapped.includes(m));
  if (!free.length) free = S.members.filter((m) => m !== ADMIN.name);
  sel.disabled = false; sel.classList.remove('locked');
  sel.title = S.login ? `GitHub hesabın: ${S.login}` : '';
  sel.innerHTML = (S.user ? '' : '<option value="">İsmini seç</option>') + free.map((m) => `<option ${m === S.user ? 'selected' : ''}>${esc(m)}</option>`).join('');
  sel.onchange = () => { S.user = sel.value; ls.set('studio.user', S.user); route(); };
}

function settingsModal(firstRun = false) {
  const tok = ls.get('studio.token', '');
  openModal(`
    <h2 style="margin-bottom:8px">${firstRun ? 'Hoş geldin! 👋' : 'Ayarlar'}</h2>
    <p class="muted small" style="margin-top:0">Site, özel repodaki verilere senin GitHub token'ınla erişir. Token sadece bu tarayıcıda saklanır.
      ${S.login ? `<br>Bağlı hesap: <b>${esc(S.login)}</b>${lockedName() ? ` → ${esc(lockedName())}` : ''}${isAdmin() ? ' · 👑 yönetici' : ''}` : ''}</p>
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

function statusPill(g) {
  if (g.deleteRequested) return '<span class="pill dot st-deleting">Siliniyor</span>';
  const st = stOf(g);
  if (st === 'done' && g.published?.url) return '<span class="pill dot st-published">Yayında</span>';
  const s = STATUS[st] || { label: st }; return `<span class="pill dot st-${esc(st)}">${esc(s.label)}</span>`;
}
function cardSub(g) {
  const st = stOf(g);
  if (st === 'script') { const s = stats(g); return `${s.chosen}/${s.total} bölüm seçildi`; }
  if (st === 'materials') { const m = missingSecs(g).length; return m ? `${m} bölümde görüntü eksik` : 'Materyaller hazır'; }
  if (st === 'review') return `v${latestVersion(g)?.v ?? '?'} inceleniyor`;
  return STEPS[STATUS[st]?.step ?? 0].name;
}

function stageGuideHtml() {
  return `<details class="card stage-guide" ${ls.get('studio.guideSeen') ? '' : 'open'}><summary><b>🧭 Çalışma düzeni</b> <span class="small muted">· 8 aşama, kim ne yapar</span></summary>
    <ol>${STEPS.map((s) => `<li><b>${s.who === 'w' ? '🤖' : '👥'} ${esc(s.name)}</b>: ${esc(s.tip)}</li>`).join('')}</ol>
    <p class="small muted" style="margin:0">🤖 = ${WORKER_NAME} çalışır, siz beklersiniz · 👥 = ekip seçer / kontrol eder. Videonun başı hep “<i>[Oyun] in 60 seconds.</i>”, sonu hep “<i>${esc(CLOSING)}</i>”.</p>
  </details>`;
}

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
      <p class="muted" style="margin:0">Yeni bir oyun yaz. ${WORKER_NAME} oyunu ve topluluğun esprilerini araştırır, her bölüm için seçenekli metin hazırlar.</p>
      ${channelButton()}
    </div>
    ${workerBanner()}
    ${S.store.demo ? '<div class="card small" style="margin-bottom:16px;border-color:var(--warn)">⚠️ <b>Demo modu</b>: yerel dosyalar okunuyor, değişiklikler kaydedilmez. Kaydetmek için ⚙ ile token gir.</div>' : ''}
    <form class="new-game card" id="newGame" style="margin-bottom:16px">
      <input type="text" id="newGameName" placeholder="Oyun adı (örn. Elden Ring)" required maxlength="60">
      <button class="btn btn-primary" type="submit">+ Yeni oyun</button>
    </form>
    ${stageGuideHtml()}
    <section class="card tasks" id="taskList"><div class="row"><h2>🗂️ ${WORKER_NAME}'ın iş listesi</h2><span class="spacer"></span><span class="spinner" style="width:16px;height:16px;border-width:2px"></span></div></section>
    <div class="row" style="margin-bottom:12px"><h2>Oyunlar</h2><span class="muted small">${games.length}</span><span class="spacer"></span>
      ${archivedCount ? `<button class="btn btn-ghost small" id="toggleArchive">${S.showArchived ? 'Arşivi gizle' : `Arşiv (${archivedCount})`}</button>` : ''}</div>
    ${games.length ? `<div class="game-grid">${games.map((g) => {
      const st = STATUS[stOf(g)]?.step ?? 0;
      return `<div class="card game-card ${g.archived ? 'archived' : ''} ${g.deleteRequested ? 'deleting' : ''}" data-open="${esc(g.slug)}" role="link" tabindex="0">
        <div class="row">${statusPill(g)}<span class="spacer"></span>
          ${ytLink(g)}${driveLink(g, 'icon-btn sm')}
          <button class="icon-btn sm" data-edit="${esc(g.slug)}" title="Projeyi düzenle" aria-label="Projeyi düzenle">⋯</button></div>
        <h3 lang="en">${esc(g.title)}</h3>
        <div class="progress"><span style="width:${Math.round((st / (STEPS.length - 1)) * 100)}%"></span></div>
        <div class="row small muted"><span>${esc(cardSub(g))}</span><span class="spacer"></span>${ownersHtml(g)}</div>
      </div>`;
    }).join('')}</div>` : '<div class="card empty muted">Henüz oyun yok.</div>'}
    <section class="card sugg" id="suggBox"><div class="row"><h2>💡 Önerilen oyunlar</h2><span class="spacer"></span><span class="spinner" style="width:16px;height:16px;border-width:2px"></span></div></section>
    </div></div>
  `;
  $$('[data-open]').forEach((c) => {
    c.onclick = (e) => { if (!e.target.closest('a,button')) location.hash = `#/game/${c.dataset.open}`; };
    c.onkeydown = (e) => { if (e.key === 'Enter') location.hash = `#/game/${c.dataset.open}`; };
  });
  $$('[data-edit]').forEach((b) => b.onclick = () => editGameModal(b.dataset.edit));
  const ta = $('#toggleArchive'); if (ta) ta.onclick = () => { S.showArchived = !S.showArchived; renderHome(); };
  const gd = $('.stage-guide'); if (gd) gd.ontoggle = () => { if (!gd.open) ls.set('studio.guideSeen', '1'); };
  renderSuggestions();
  renderTaskList();
  renderActivity();

  $('#newGame').onsubmit = async (e) => {
    e.preventDefault();
    const title = $('#newGameName').value.trim();
    if (!slugify(title)) return;
    const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Oluşturuluyor…';
    try {
      const { slug } = await createGame(title);
      location.hash = `#/game/${slug}`;
    } catch (err) { toast('Oluşturulamadı: ' + err.message, true); btn.disabled = false; btn.textContent = '+ Yeni oyun'; }
  };
}

/* ---------- Önerilen oyunlar (config/suggestions.json: Çırak'ın havuzu, ana sayfada 10'u görünür) ---------- */
// Eşleştirme anahtarı (_studio/tools/suggest.py key() ile aynı mantık): "GTA V" = "Grand Theft Auto V" = "gta-5"
const gameKey = (t) => slugify(String(t || '')).replace('grand-theft-auto', 'gta').replace(/-v$/, '-5')
  .replace(/-(legacy|enhanced|remastered|definitive-edition|game-of-the-year-edition|goty)$/, '').replace(/-/g, '');
const startedKeys = () => new Set([...S.games.values()].flatMap((g) => [gameKey(g.title), gameKey(g.slug)]));
const suggById = (d, id) => (d.pool || []).find((x) => x.id === id);
const suggGone = (x, started) => !x || x.state === 'picked' || x.state === 'dismissed' || started.has(gameKey(x.title));
// Yeni gelecek adaylar: hiç gösterilmeyenler (puana göre), sonra daha önce gösterilip seçilmeyenler (en eskisi önce)
function suggCandidates(d, exclude, started) {
  const ok = (d.pool || []).filter((x) => !exclude.has(x.id) && !suggGone(x, started));
  return [...ok.filter((x) => x.state === 'new').sort((a, b) => (b.score || 0) - (a.score || 0)),
    ...ok.filter((x) => x.state === 'shown').sort((a, b) => String(a.seenAt || '').localeCompare(String(b.seenAt || '')))];
}
const suggFresh = (d, started) => (d.pool || []).filter((x) => x.state === 'new' && !(d.view || []).includes(x.id) && !suggGone(x, started)).length;
async function mutateJSON(path, fn, message) {
  for (let i = 0; i < 4; i++) {
    const cur = await readJSON(path);
    const data = cur?.data || {};
    fn(data);
    try { await S.store.put(path, JSON.stringify(data, null, 2) + '\n', `[${S.user}] ${message}`, cur?.sha); return data; }
    catch (e) { if (e.status === 409 || e.status === 422) continue; throw e; }
  }
  throw new Error('Kaydedilemedi (çakışma). Sayfayı yenileyin.');
}
// Havuzda gösterilmemiş öneri azaldıysa Çırak'a yeni araştırma işi (kuyrukta zaten varsa tekrar açılmaz)
async function ensureSuggestJob(d, started) {
  if (suggFresh(d, started) >= 10) return false;
  try { if ((await S.store.list('queue')).some((f) => f.name.includes('-suggest-'))) return false; } catch {}
  await enqueue('suggest', '_suggest', { reason: 'havuz azaldı' });
  return true;
}
function suggCardHtml(x, started) {
  const gs = x.gameSlug || [...S.games.values()].find((g) => gameKey(g.title) === gameKey(x.title))?.slug;
  const done = started || x.state === 'picked';
  return `<div class="sugg-card ${done ? 'started' : ''}" data-sugg="${esc(x.id)}">
    <div class="sugg-img">${x.image ? `<img src="${esc(x.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc(x.title)}</span>`}
      <span class="sugg-score" title="İlgi + materyal bolluğu + espri potansiyeli (0–100)">🔥 ${esc(x.score ?? '?')}</span></div>
    <div class="sugg-body">
      <h3 lang="en">${esc(x.title)}</h3>
      <div class="small muted">${esc([x.genre, x.year, x.platforms].filter(Boolean).join(' · '))}</div>
      <p class="small sugg-why">${esc(x.why || '')}</p>
      ${x.angle ? `<p class="small sugg-line"><b>😂 Espri:</b> ${esc(x.angle)}</p>` : ''}
      ${x.material ? `<p class="small sugg-line muted"><b>🎞 Materyal:</b> ${esc(x.material)}</p>` : ''}
      ${(x.signals || []).length ? `<div class="sugg-signals">${x.signals.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="sugg-actions">
      ${done ? `<a class="btn small" href="#/game/${esc(gs || '')}">✓ Başladı · aç →</a>`
        : `<button type="button" class="btn btn-primary small" data-sugg-start="${esc(x.id)}">▶ Başla</button>
           <button type="button" class="btn btn-ghost small" data-sugg-hide="${esc(x.id)}" title="Bu öneriyi gizle, yerine yenisi gelsin">Gizle</button>`}
      <span class="spacer"></span>${(x.links || []).map((l) => `<a class="small" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join('')}
    </div>
  </div>`;
}
async function renderSuggestions() {
  const box = $('#suggBox'); if (!box) return;
  let d;
  try { d = (await readJSON('config/suggestions.json'))?.data || { pool: [], view: [] }; } catch { box.innerHTML = '<p class="small muted">Öneriler yüklenemedi.</p>'; return; }
  S.sugg = d;
  const started = startedKeys();
  const list = (d.view || []).map((id) => suggById(d, id)).filter((x) => x && x.state !== 'dismissed');
  const fresh = suggFresh(d, started);
  let queued = false;
  try { queued = (await S.store.list('queue')).some((f) => f.name.includes('-suggest-')); } catch {}
  const open = ls.get('studio.suggOpen', '1') === '1';
  box.innerHTML = `<div class="sugg-head">
      <div class="sugg-title">
        <button type="button" class="link-btn sugg-toggle" id="suggToggle" aria-expanded="${open}"><h2>💡 Önerilen oyunlar ${open ? '▾' : '▸'}</h2></button>
        <div class="small muted">Daha önce yapmadığımız, ilgi çekecek ve materyali bol oyunlar</div>
      </div>
      <div class="sugg-meta">
        <span class="small muted" title="Havuzda henüz gösterilmemiş öneri sayısı">${queued ? `<span class="spinner" style="width:12px;height:12px;border-width:2px"></span> ${WORKER_NAME} yeni öneri arıyor · ` : ''}havuzda ${fresh} yeni${d.updatedAt ? ` · ${fmtDate(d.updatedAt)}` : ''}</span>
        <button type="button" class="btn small" id="suggRefresh" title="Başladığınız ve gizlediğiniz oyunlar çıkar, yerine yenileri gelir. Hiçbirini seçmediyseniz listenin tamamı yenilenir.">🔄 Yenile</button>
      </div>
    </div>
    <div class="sugg-grid" ${open ? '' : 'hidden'}>${list.length ? list.map((x) => suggCardHtml(x, started.has(gameKey(x.title)))).join('')
      : `<p class="small muted">${queued ? `${WORKER_NAME} öneri havuzunu hazırlıyor; birkaç dakika sonra burada.` : `Henüz öneri yok. 🔄 Yenile'ye basınca ${WORKER_NAME} araştırmaya başlar.`}</p>`}</div>`;
  $('#suggToggle').onclick = () => { ls.set('studio.suggOpen', open ? '0' : '1'); renderSuggestions(); };
  $$('[data-sugg-start]').forEach((b) => b.onclick = async () => {
    const x = suggById(S.sugg, b.dataset.suggStart);
    if (!x || !confirm(`“${x.title}” başlasın mı? ${WORKER_NAME} araştırmaya başlar.`)) return;
    b.disabled = true; b.textContent = 'Başlatılıyor…';
    try {
      const { slug } = await createGame(x.title);
      await mutateJSON('config/suggestions.json', (dd) => {
        const y = suggById(dd, x.id); if (y) Object.assign(y, { state: 'picked', pickedBy: S.user, pickedAt: nowIso(), gameSlug: slug });
      }, `öneriler: ${x.title} başlatıldı`);
      toast(`${x.title} başladı ✓ · ${WORKER_NAME} araştırıyor`);
      renderSuggestions(); renderTaskList();
    } catch (e) { toast('Başlatılamadı: ' + e.message, true); b.disabled = false; b.textContent = '▶ Başla'; }
  });
  $$('[data-sugg-hide]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.suggHide; b.disabled = true;
    try {
      const dd = await mutateJSON('config/suggestions.json', (dd) => {
        const y = suggById(dd, id); if (y) Object.assign(y, { state: 'dismissed', dismissedBy: S.user, dismissedAt: nowIso() });
        const view = (dd.view || []).filter((v) => v !== id);
        const next = suggCandidates(dd, new Set(view), startedKeys())[0];
        if (next) view.push(next.id);
        dd.view = view;
      }, `öneriler: ${suggById(S.sugg, id)?.title || id} gizlendi`);
      await ensureSuggestJob(dd, startedKeys());
      renderSuggestions();
    } catch (e) { toast('Olmadı: ' + e.message, true); b.disabled = false; }
  });
  $('#suggRefresh').onclick = async () => {
    const btn = $('#suggRefresh'); btn.disabled = true; btn.textContent = 'Yenileniyor…';
    try {
      let msg = '';
      const dd = await mutateJSON('config/suggestions.json', (dd) => {
        const st = startedKeys(), now = nowIso();
        dd.pool = dd.pool || [];
        // Başlanan oyunlar (öneriden ya da elle açılmış) "picked" olur, bir daha önerilmez
        dd.pool.forEach((y) => { if (y.state !== 'picked' && st.has(gameKey(y.title))) Object.assign(y, { state: 'picked', gameSlug: y.gameSlug || slugify(y.title) }); });
        const cur = (dd.view || []).map((id) => suggById(dd, id)).filter(Boolean);
        const gone = cur.filter((y) => suggGone(y, st));
        let keep = cur.filter((y) => !suggGone(y, st));
        if (!gone.length) { keep.forEach((y) => { y.state = 'shown'; y.seenAt = now; }); keep = []; }
        const view = keep.map((y) => y.id);
        const exclude = new Set([...view, ...(gone.length ? [] : cur.map((y) => y.id))]);
        for (const y of suggCandidates(dd, exclude, st)) { if (view.length >= 10) break; view.push(y.id); }
        for (const y of cur) { if (view.length >= 10) break; if (!view.includes(y.id) && !suggGone(y, st)) view.push(y.id); }
        msg = gone.length ? `${gone.length} öneri çıktı, yerine yenileri geldi` : 'Liste yenilendi';
        dd.view = view;
      }, 'öneriler yenilendi');
      const asked = await ensureSuggestJob(dd, startedKeys());
      toast(`${msg} ✓${asked ? ` · ${WORKER_NAME} yeni öneriler araştıracak` : ''}`);
      renderSuggestions(); renderTaskList();
    } catch (e) { toast('Yenilenemedi: ' + e.message, true); btn.disabled = false; btn.textContent = '🔄 Yenile'; }
  };
}
// Yeni oyun aç (form + öneri kartı): game.json + araştırma işi
async function createGame(title) {
  const slug = slugify(title);
  if (!slug) throw new Error('Geçersiz oyun adı');
  if (S.games.has(slug)) {
    if (S.games.get(slug).deleteRequested) throw new Error('Bu adda bir oyun siliniyor; birkaç dakika sonra tekrar dene.');
    return { slug, existed: true };
  }
  const g = {
    schema: 2, slug, title, owner: S.user, owners: [S.user], createdBy: S.user, createdAt: nowIso(), status: 'queued_research',
    opening: `${title} in 60 seconds.`, closing: CLOSING,
    settings: { captions: 'full', mediaFolderUrl: '' }, summary: '', sections: [], versions: [], revisions: [],
    log: [{ at: nowIso(), by: S.user, msg: 'Oyun eklendi, araştırma kuyruğa alındı.' }],
  };
  await S.store.put(`games/${slug}/game.json`, JSON.stringify(g, null, 2) + '\n', `[${S.user}] Yeni oyun: ${title}`);
  await enqueue('new_game', slug);
  S.games.set(slug, g);
  return { slug, existed: false };
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
const YT_SVG = '<svg viewBox="0 0 28 20" width="20" height="14" aria-hidden="true"><rect width="28" height="20" rx="5" fill="#FF0000"/><path d="M11.2 5.6v8.8L18.8 10z" fill="#fff"/></svg>';
// Yayınlanan videonun linki (Kağan 2026-10-09): son aşamada elle girilir.
function ytId(u) { const m = String(u || '').match(/(?:youtube\.com\/(?:shorts\/|watch\?(?:.*&)?v=|embed\/|live\/)|youtu\.be\/)([\w-]{11})/); return m ? m[1] : null; }
function ytLink(g, cls = 'icon-btn sm') {
  const url = g?.published?.url;
  if (!url) return '';
  return `<a class="${cls} yt-link" href="${esc(url)}" target="_blank" rel="noopener" title="YouTube'da izle" aria-label="YouTube'da izle" onclick="event.stopPropagation()">${YT_SVG}${cls === 'btn' ? "<span>YouTube'da izle</span>" : ''}</a>`;
}
function channelButton() {
  const y = S.config?.youtube;
  if (!y?.channelUrl) return '';
  return `<a class="btn yt-channel" href="${esc(y.channelUrl)}" target="_blank" rel="noopener">${YT_SVG}<span><b>${esc(y.name || 'YouTube')}</b> kanalımız · ${esc(y.handle || '')}</span></a>`;
}
function publishBox(g) {
  const p = g.published;
  if (p?.url && !S.pubEdit[g.slug]) {
    return `<div class="pub-box"><span class="small" style="color:var(--good)">✓ Yayında</span>${ytLink(g, 'btn')}
      <span class="small muted">${esc(p.by || '')}${p.at ? ' · ' + esc(String(p.at).slice(0, 10)) : ''}</span><span class="spacer"></span>
      <button type="button" class="btn btn-ghost small" id="pubEdit">Linki değiştir</button></div>`;
  }
  return `<div class="pub-box"><span class="small" style="color:var(--good)">✓ Onaylandı. Yayın için tam kalite dosya Drive'da.</span>
    <div class="row pub-form"><input type="url" id="pubUrl" placeholder="Yayınlandıysa YouTube linkini yapıştır (youtube.com/shorts/…)" value="${esc(p?.url || '')}">
      <button type="button" class="btn btn-primary" id="pubSave">Kaydet</button>${p?.url ? '<button type="button" class="btn btn-ghost" id="pubCancel">Vazgeç</button>' : ''}</div></div>`;
}
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
      ${isAdmin() ? `<div class="danger-zone"><div class="row"><b>🗑 Oyunu sil</b></div>
        <p class="small muted" style="margin:6px 0 10px">Oyun siteden ve repodan kalkar (git geçmişinde durur). Drive klasörü Google Drive çöp kutusuna gider, 30 gün içinde geri alınabilir.</p>
        <button class="btn btn-danger small" id="egDelete" ${g.deleteRequested ? 'disabled' : ''}>${g.deleteRequested ? 'Silme sırada' : 'Oyunu sil…'}</button></div>` : ''}
    </div>`);
  $('#egCancel').onclick = closeModal;
  const del = $('#egDelete'); if (del) del.onclick = () => deleteGameModal(slug);
  $('#egSave').onclick = async () => {
    const title = $('#egTitle').value.trim() || g.title;
    const os = $$('#modalBody .chip input[type=checkbox][value]').filter((c) => c.checked).map((c) => c.value);
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
// Silme: yalnız yönetici. İş kuyruğa Kağan'ın token'ıyla yazılır; worker (admin_jobs.py) commit yazarını doğrular.
function deleteGameModal(slug) {
  if (!isAdmin()) return;
  const g = S.games.get(slug);
  openModal(`<h2>🗑 ${esc(g.title)} silinsin mi?</h2>
    <p class="small">Oyun siteden ve repodan kaldırılır (git geçmişinde kalır), bekleyen işleri iptal edilir. Drive klasörü Google Drive çöp kutusuna gider, 30 gün içinde geri alınabilir. ${WORKER_NAME} birkaç dakika içinde siler.</p>
    <div class="field"><label for="delConfirm">Onaylamak için oyunun adını yaz: <b lang="en">${esc(g.title)}</b></label><input id="delConfirm" type="text" autocomplete="off"></div>
    <div class="row" style="margin-top:12px"><button class="btn btn-danger" id="delGo" disabled>Sil</button><button class="btn btn-ghost" id="delCancel">Vazgeç</button></div>`);
  const inp = $('#delConfirm'), go = $('#delGo');
  inp.oninput = () => { go.disabled = inp.value.trim() !== g.title; };
  inp.focus();
  $('#delCancel').onclick = closeModal;
  go.onclick = async () => {
    go.disabled = true;
    try {
      await flush(slug);
      const job = await enqueue('delete_game', slug, { login: S.login });
      await mutateGame(slug, (x) => { x.deleteRequested = { by: S.user, at: nowIso(), job }; logLine(x, `${ADMIN.name} oyunun silinmesini istedi.`); }, 'silme istendi');
      closeModal(); toast('Silme kuyruğa alındı ✓'); location.hash = '#/';
    } catch (e) { toast('Olmadı: ' + e.message, true); go.disabled = false; }
  };
}

function pipelineHtml(g) {
  const cur = STATUS[stOf(g)]?.step ?? 0;
  return `<div class="pipeline">${STEPS.map((s, i) => `<div class="step ${i < cur ? 'done' : ''} ${i === cur ? 'current' : ''}" title="${esc(s.tip)}">
    <div class="bar"></div><span class="who">${s.who === 'w' ? '🤖' : '👥'}</span><span class="step-name">${esc(s.name)}</span></div>`).join('')}</div>`;
}

/* ---------- 2) Metin: her bölüm için bir replik (meme / ses / süre yok) ---------- */
// Sabit açılış ve kapanış metnin içinde soluk vurguyla gösterilir (her videoda aynı)
function narrHtml(text, g) {
  let t = String(text || '').trim(), pre = '', post = '';
  const op = g.opening || `${g.title} in 60 seconds.`, cl = g.closing || CLOSING;
  if (op && t.startsWith(op)) { pre = op; t = t.slice(op.length).trim(); }
  if (cl && t.endsWith(cl)) { post = cl; t = t.slice(0, -cl.length).trim(); }
  return `${pre ? `<span class="fixed-line" title="Sabit açılış: her videoda aynı">${esc(pre)}</span> ` : ''}${esc(t)}${post ? ` <span class="fixed-line" title="Sabit kapanış: her videoda aynı">${esc(post)}</span>` : ''}`;
}
function sourcesHtml(o) {
  const list = [...(o.sources || []), ...(o.source ? [o.source] : [])].filter((x) => x?.url);
  return list.length ? `<div class="opt-srcs">${list.map((x) => `<a class="opt-src small" href="${esc(x.url)}" target="_blank" rel="noopener" title="Esprinin kaynağı">💬 ${esc(x.label || shortUrl(x.url))} ↗</a>`).join('')}</div>` : '';
}
function optionHtml(sec, o, g) {
  const on = sec.selected === o.id;
  return `<div class="opt ${on ? 'selected' : ''}" data-sec="${esc(sec.id)}" data-opt="${esc(o.id)}" role="button" tabindex="0">
    <span class="radio"></span>
    <div class="opt-en" lang="en"><span class="opt-letter">${esc(o.id.toUpperCase())}</span>“${narrHtml(o.narration, g)}”</div>
    <div class="opt-tr"><span class="tr-badge">TR</span>${esc(o.tr)}</div>
    ${sourcesHtml(o)}
  </div>`;
}
function scriptSectionHtml(sec, i, g, editable) {
  return `<section class="card ${sec.selected ? 'has-sel' : ''}" id="sec-${esc(sec.id)}">
    <div class="section-head"><span class="section-num">S${i + 1}</span><h2>${esc(sec.title)}</h2></div>
    ${sec.goal ? `<div class="muted small" style="margin-top:4px">${esc(sec.goal)}</div>` : ''}
    <div class="options" style="margin-top:12px">${(sec.options || []).map((o) => optionHtml(sec, o, g)).join('')}</div>
    <details class="sec-tools" ${sec.note || sec.regen ? 'open' : ''}><summary class="small muted">✏️ Not ekle / bu bölümü yeniden öner</summary>
    <textarea class="note-input" data-note="${esc(sec.id)}" placeholder="${sec.regen ? 'Yeni tema / istek: ör. “Pauselock esprisi olsun, oyunu durdurup kaçan oyunculara gönderme”' : 'Bu bölüm için not / kendi fikrin (opsiyonel)'}" ${editable ? '' : 'disabled'}>${esc(sec.note || '')}</textarea>
    <div class="row" style="margin-top:8px">
      <button type="button" class="btn ${sec.regen ? 'btn-primary' : 'btn-ghost'} small regen-btn" data-regen="${esc(sec.id)}" ${editable ? '' : 'disabled'}>${sec.regen ? '🔄 Yeniden önerilecek ✓' : '🔄 Bu bölümü yeniden öner'}</button>
      <span class="small muted">${sec.regen ? 'Alttan <b>Tekrar yap</b>\'a bas.' : 'Notuna yeni temayı yaz, sonra işaretle.'}</span>
    </div></details>
  </section>`;
}
function fixedLinesHtml(g) {
  return `<section class="card fixed-card"><div class="row" style="align-items:flex-start;flex-wrap:nowrap"><span class="lock">🔒</span><div>
    <b>Sabit açılış ve kapanış</b> <span class="small muted">· her videoda aynı</span>
    <div class="small" style="margin-top:4px">Başta: <span class="fixed-line" lang="en">“${esc(g.opening || `${g.title} in 60 seconds.`)}”</span> · Sonda: <span class="fixed-line" lang="en">“${esc(g.closing || CLOSING)}”</span></div>
    <p class="small muted" style="margin:6px 0 0">${WORKER_NAME} her bölüm için oyunun topluluğundan (Reddit, Steam, YouTube yorumları…) bulduğu esprilerle seçenek yazdı. Burada sadece metni seçiyorsunuz; görüntü, meme, ses efekti ve süreler sonraki aşamalarda.</p>
  </div></div></section>`;
}
function scriptSummaryHtml(g, open = false, title = '📝 Metin') {
  if (!g.sections?.length) return '';
  return `<details class="card" ${open ? 'open' : ''}><summary><b>${title}</b> <span class="small muted">· seçilen replikler</span></summary>
    <ol class="script-list">${g.sections.map((s, i) => { const o = selectedOpt(s); return `<li><span class="section-num">S${i + 1} · ${esc(s.title)}</span>
      ${o ? `<div class="opt-en" lang="en">“${narrHtml(o.narration, g)}”</div><div class="opt-tr">${esc(o.tr)}</div>` : '<div class="muted small">seçim yok</div>'}</li>`; }).join('')}</ol></details>`;
}
const regenCount = (g) => (g.regenAll ? g.sections.length : g.sections.filter((s) => s.regen).length);

/* ---------- 4) Kontrol: Çırak'ın bulduğu materyaller + yükleme / link / katalog ---------- */
const pvPath = (g, pv, f) => `${pv.base || `games/${g.slug}/previews/`}${f}`;
function srcLabelHtml(src) {
  if (!src) return '';
  const a = (u, t) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ↗</a>`;
  switch (src.kind) {
    case 'youtube': return `▶ YouTube: ${a(src.url, src.title || shortUrl(src.url))}`;
    case 'link': return `🔗 ${a(src.url, src.title || shortUrl(src.url))}`;
    case 'upload': return `📤 ${esc(src.by || '')} yükledi: <b>${esc(src.name || '')}</b>${src.size ? ` · ${fmtSize(src.size)}` : ''}${src.file ? ' · ✓ Drive\'da' : ` · ${WORKER_NAME} kurguda alacak`}`;
    case 'canon': return `🏆 Meme Kanonu${src.page ? ` · ${a(src.page, 'kaynak')}` : ''}`;
    case 'greens': return `🟩 Green Screen Kataloğu${src.page ? ` · ${a(src.page, 'kaynak')}` : ''}`;
    case 'sfxlib': return `🔊 Ses Efekti Kataloğu${src.page ? ` · ${a(src.page, 'kaynak')}` : ''}`;
    default: return src.page || src.url ? `📚 ${a(src.page || src.url, src.title || 'kaynak')}` : '📚 Kütüphane';
  }
}
function entryMediaHtml(g, x, kind) {
  const src = x.src || {};
  const loc = src.uid && S.localMedia.get(src.uid);
  if (loc) return kind === 'sfx' ? `<audio class="slot-audio" src="${loc}" controls preload="metadata"></audio>`
    : `<video class="slot-video" src="${loc}" controls muted playsinline preload="metadata"></video>`;
  const pv = x.preview;
  if (pv?.audio) return `<button type="button" class="cand-media sfx" data-play="${esc(pvPath(g, pv, pv.audio))}" data-kind="sfx" title="Dinle"><span class="sfx-icon">🔊</span><span class="play-badge">▶</span></button>`;
  if (pv?.video || pv?.thumb) return `<button type="button" class="cand-media" data-play="${esc(pvPath(g, pv, pv.video || pv.thumb))}" data-kind="meme" title="Önizle">${pv.thumb ? `<img data-src="${esc(pvPath(g, pv, pv.thumb))}" alt="">` : ''}<span class="play-badge">▶</span></button>`;
  const why = src.kind === 'upload' ? 'önizleme kurgudan sonra' : src.kind === 'link' ? 'link · önizleme kurgudan sonra' : 'önizleme yok';
  return `<div class="cand-media empty-media"><span>${KIND[kind].icon}</span><small>${why}</small></div>`;
}
function uploadBoxHtml(key) {
  const u = S.uploading.get(key);
  if (!u) return '';
  return `<div class="upbox"><div class="small">📤 <b>${esc(u.name)}</b> · ${fmtSize(u.size)} · <span data-uppct="${esc(key)}">%${Math.round(u.pct * 100)}</span> yükleniyor…</div>
    <div class="upbar-track"><div class="upbar" data-upbar="${esc(key)}" style="width:${Math.round(u.pct * 100)}%"></div></div></div>`;
}
const ACCEPT = { gp: 'video/*', cutaway: 'video/*,image/gif', green: 'video/*', sfx: 'audio/*' };
function dropzoneHtml(key, kind, text) {
  return `<label class="dropzone" data-drop="${esc(key)}" data-kind="${kind}"><input type="file" accept="${ACCEPT[kind]}">
    <span class="dz-icon">📤</span><b>${esc(text || 'Dosyayı sürükle bırak ya da tıkla seç')}</b><span class="small muted">en fazla 75 MB · ${kind === 'sfx' ? 'mp3 / wav' : 'mp4 / mov / webm'}</span></label>`;
}
function linkRowHtml(key, ph) {
  return `<div class="link-row"><input type="url" data-link="${esc(key)}" placeholder="${esc(ph || 'veya link yapıştır (YouTube, TikTok, X, Reddit…)')}"><button type="button" class="btn small" data-link-save="${esc(key)}">Ekle</button></div>`;
}
function gpSlotHtml(g, sec, x, ed) {
  const key = `${sec.id}|${x.id}`;
  const up = uploadBoxHtml(key);
  const rangeIn = ed ? `<label class="range-row">⏱ Hangi saniyeler arası? <input type="text" data-range="${esc(key)}" value="${esc(x.range || '')}" placeholder="ör. 0:12-0:18"></label>`
    : x.range ? `<div class="small muted">⏱ ${esc(x.range)}</div>` : '';
  if (!x.src) {
    return `<div class="slot missing" data-entry="${esc(key)}">
      <div class="row"><span class="kind-badge k-gp">Görüntü yok</span><span class="slot-desc">${esc(x.desc || 'Oyun görüntüsü')}</span><span class="spacer"></span>
        ${ed && x.addedBy ? `<button type="button" class="link-btn small" data-remove="${esc(key)}">Kaldır</button>` : ''}</div>
      ${x.review ? `<div class="need-why">🤖 ${esc(x.review)}</div>` : `<div class="small" style="color:var(--warn);margin-top:4px">${WORKER_NAME} uygun görüntü bulamadı. Kayıt yükle ya da link ver; hangi saniyeleri kullanacağını yaz.</div>`}
      ${ed ? (up || `<div style="margin-top:8px">${dropzoneHtml(key, 'gp')}</div>${linkRowHtml(key)}`) + rangeIn : ''}
    </div>`;
  }
  return `<div class="slot" data-entry="${esc(key)}">
    <div class="slot-media">${entryMediaHtml(g, x, 'gp')}</div>
    <div class="slot-body">
      <div class="slot-desc">${esc(x.desc || 'Oyun görüntüsü')}</div>
      <div class="small muted src-line">${srcLabelHtml(x.src)}</div>
      ${x.review ? `<div class="need-why">🤖 ${esc(x.review)}</div>` : ''}
      ${x.src.error ? `<div class="need-warn">⚠️ ${esc(x.src.error)}</div>` : ''}
      ${rangeIn}${up}
      ${ed && !up ? `<div class="slot-actions"><button type="button" class="link-btn small" data-replace="${esc(key)}">↻ Değiştir</button><button type="button" class="link-btn small" data-remove="${esc(key)}">Kaldır</button></div>
        <div class="replace-box" data-replace-box="${esc(key)}" hidden>${dropzoneHtml(key, 'gp', 'Yeni kayıt: sürükle bırak ya da tıkla seç')}${linkRowHtml(key)}</div>` : ''}
    </div>
  </div>`;
}
function itemHtml(g, sec, x, ed) {
  const key = `${sec.id}|${x.id}`, k = KIND[x.kind] || KIND.cutaway;
  const up = uploadBoxHtml(key);
  return `<div class="item" data-entry="${esc(key)}">
    <div class="slot-media">${entryMediaHtml(g, x, x.kind)}</div>
    <div class="slot-body">
      <div class="item-head"><span class="kind-badge k-${esc(x.kind)}" title="${esc(k.hint || '')}">${k.icon} ${esc(k.label)}</span> <b>${esc(x.title || '')}</b>${x.tr ? ` <span class="small muted">· ${esc(x.tr)}</span>` : ''}</div>
      ${x.why ? `<div class="need-why">💡 ${esc(x.why)}</div>` : ''}
      <div class="row small item-opts">
        ${ed ? `<button type="button" class="at-chip" data-at="${esc(key)}" title="Anlatıcı hangi kelimeyi söylerken girsin? Boş bırakırsan ${WORKER_NAME} seçer.">⏱ ${x.at ? `“${esc(x.at)}”` : 'giriş anı: otomatik'}</button>`
          : x.at ? `<span class="at-chip">⏱ “${esc(x.at)}”</span>` : ''}
        ${x.kind === 'cutaway' ? (ed ? `<label class="label-row">Etiket <input type="text" class="label-in" data-label="${esc(key)}" value="${esc(x.label || '')}" placeholder="ör. ME:" maxlength="40"></label>`
          : x.label ? `<span class="cut-label"><span>${esc(x.label)}</span></span>` : '') : ''}
      </div>
      <div class="small muted src-line">${srcLabelHtml(x.src)}${x.by && x.by !== WORKER_NAME ? ` · ${esc(x.by)} ekledi` : ''}</div>
      ${x.src?.error ? `<div class="need-warn">⚠️ ${esc(x.src.error)}</div>` : ''}
      ${up}
      ${ed && !up ? `<div class="slot-actions"><button type="button" class="link-btn small" data-replace="${esc(key)}">↻ Değiştir</button><button type="button" class="link-btn small" data-remove="${esc(key)}">Kaldır</button></div>` : ''}
    </div>
  </div>`;
}
function mediaSectionHtml(g, sec, i, ed, sub = false) {
  const m = sec.media || { gameplay: [], items: [] };
  const o = selectedOpt(sec);
  const miss = !(m.gameplay || []).some((x) => x.src);
  return `<section class="${sub ? 'media-sub' : 'card'} media-sec" id="sec-${esc(sec.id)}">
    <div class="section-head"><span class="section-num">S${i + 1}</span><h2>${esc(sec.title)}</h2>${miss ? '<span class="pill warn-pill">görüntü eksik</span>' : ''}</div>
    ${o ? `<div class="line-quote"><div class="opt-en" lang="en">“${narrHtml(o.narration, g)}”</div><div class="opt-tr small">${esc(o.tr)}</div></div>` : ''}
    <div class="mblock"><div class="mblock-head">🎮 Oyun görüntüsü</div>
      ${(m.gameplay || []).map((x) => gpSlotHtml(g, sec, x, ed)).join('') || `<p class="small muted">Henüz görüntü yok.</p>`}
      ${ed ? `<button type="button" class="link-btn small" data-add-gp="${esc(sec.id)}">+ Başka görüntü ekle</button>` : ''}</div>
    <div class="mblock"><div class="mblock-head">😂 Memeler ve ses efektleri</div>
      ${(m.items || []).map((x) => itemHtml(g, sec, x, ed)).join('') || '<p class="small muted">Bu bölümde meme yok: oyun görüntüsü + altyazı.</p>'}
      ${ed ? `<div class="add-row">${['cutaway', 'green', 'sfx'].map((k) => `<button type="button" class="btn small" data-add-item="${esc(sec.id)}|${k}" title="${esc(KIND[k].hint)}">+ ${KIND[k].icon} ${KIND[k].label}</button>`).join('')}</div>` : ''}</div>
  </section>`;
}
function mediaHeadHtml(g) {
  return `<section class="card" id="mediaHead">
    <div class="row"><h2>📦 Materyal kontrolü</h2><span class="spacer"></span>${driveLink(g)}<button type="button" class="btn btn-ghost small" id="backToScript">← Metne dön</button></div>
    <p class="small muted" style="margin:10px 0">${WORKER_NAME} her bölüm için oyun görüntüsü, ara klip, green screen ve ses efekti seçti. Önizlemeye tıkla; beğenmediğini <b>↻ Değiştir</b> ya da <b>Kaldır</b>, kataloglardan / linkten / dosyadan yenisini ekle. Görüntü bulunamayan bölümde yükleme alanı var: kaydı sürükle bırak, sonra hangi saniyeler arası kullanılacağını yaz. ${WORKER_NAME} kurguda hepsine bakıp değerlendirir.</p>
    <div class="row small" id="mediaCounts">${mediaCountsHtml(g)}</div>
    <div class="row" style="margin-top:12px"><span class="small" style="font-weight:600">Altyazı</span>
      <div class="seg" id="capSeg">${CAPTIONS.map((x) => `<button type="button" data-cap="${x.v}" class="${g.settings.captions === x.v ? 'on' : ''}" title="${esc(x.hint)}">${x.label}</button>`).join('')}</div></div>
  </section>`;
}
function mediaCountsHtml(g) {
  const miss = missingSecs(g).length, c = itemCounts(g), n = g.sections.length;
  return `<span class="pill">🎮 ${n - miss}/${n} bölümde görüntü var</span>${miss ? `<span class="pill warn-pill">⚠️ ${miss} bölümde eksik</span>` : ''}
    <span class="pill" title="Hedef 3–4">🎬 ${c.cutaway} ara klip</span><span class="pill">🟩 ${c.green} green screen</span><span class="pill">🔊 ${c.sfx} ses efekti</span>`;
}

// Kataloglar: ara klip = Meme Kanonu, green screen = Green Screen Kataloğu, ses = Ses Efekti Kataloğu
const pickOpts = (c) => Object.fromEntries(['hit', 'clip', 'mute'].filter((k) => c[k] != null).map((k) => [k, c[k]]));
const CATALOGS = {
  cutaway: { path: '_studio/memes/canon.json', title: '🏆 Meme Kanonu', ph: 'Ara: polis, kaçış, şaşkınlık, para, ölüm…',
    norm: (c) => ({ title: c.name, tr: c.tr, use: c.use, hay: [c.name, c.tr, c.use, ...(c.tags || []), ...(c.mood || [])].join(' '),
      src: { kind: 'canon', id: c.id, lib: c.lib, page: c.page }, preview: { thumb: c.thumb, video: c.video, base: '_studio/memes/previews/' }, opts: pickOpts(c) }) },
  green: { path: '_studio/memes/greens.json', title: '🟩 Green Screen Kataloğu', ph: 'Ara: patlama, para, gözlük, iskelet, emoji…',
    norm: (c) => ({ title: c.name, tr: c.tr, use: c.use, hay: [c.name, c.tr, c.use, ...(c.tags || [])].join(' '),
      src: { kind: 'greens', id: c.id, lib: c.lib, page: c.page }, preview: { thumb: c.thumb, video: c.video, base: c.pvBase || '_studio/memes/previews/' }, opts: pickOpts(c) }) },
  sfx: { path: '_studio/sfx/catalog.json', title: '🔊 Ses Efekti Kataloğu', ph: 'Ara: bruh, vine boom, alkış, patlama, fail…',
    norm: (c) => ({ title: c.title, tr: '', use: c.duration ? `${c.duration.toFixed(1)} sn` : '', hay: [c.title, ...(c.tags || [])].join(' '),
      src: { kind: 'sfxlib', id: c.id, lib: c.id, page: c.page }, preview: { audio: c.audio, base: '_studio/sfx/previews/' }, opts: {} }) },
};
async function loadCatalog(kind) {
  if (!S.cats[kind]) S.cats[kind] = ((await readJSON(CATALOGS[kind].path))?.data || []).map(CATALOGS[kind].norm);
  return S.cats[kind];
}
// Kaynak seçici: Katalog / Link / Dosya → onPick({title, tr, src, preview, opts}) ya da onPick({file})
function sourceModal(kind, onPick, opts = {}) {
  const tabs = kind === 'gp' ? ['link', 'file'] : ['cat', 'link', 'file'];
  const TL = { cat: '📚 Katalog', link: '🔗 Link', file: '📤 Dosya' };
  openModal(`<h2>${KIND[kind].icon} ${opts.replace ? 'Değiştir' : 'Ekle'}: ${esc(KIND[kind].label)}</h2>
    ${KIND[kind].hint ? `<p class="small muted" style="margin:4px 0 12px">${esc(KIND[kind].hint)}</p>` : ''}
    <div class="seg src-tabs" id="srcTabs">${tabs.map((t) => `<button type="button" data-tab="${t}">${TL[t]}</button>`).join('')}</div>
    <div id="srcPane" style="margin-top:12px"></div>`);
  $('#modal .modal-card').classList.add('wide');
  const pane = $('#srcPane');
  const show = async (t) => {
    $$('#srcTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'link') {
      pane.innerHTML = `<div class="stack"><div class="field"><label for="lnkUrl">Link</label><input type="url" id="lnkUrl" placeholder="YouTube, TikTok, X, Reddit, Tenor, myinstants, doğrudan mp4/mp3…"></div>
        <div class="field"><label for="lnkTitle">Ne olduğunu kısaca yaz <span class="muted small">(opsiyonel)</span></label><input type="text" id="lnkTitle" placeholder="ör. Gandalf - You shall not pass, 0:03-0:06 arası"></div>
        <div class="row"><button type="button" class="btn btn-primary" id="lnkAdd">Ekle</button><span class="small muted">${WORKER_NAME} indirir, keser ve önizlemesini kurgudan sonra koyar.</span></div></div>`;
      $('#lnkUrl').focus();
      $('#lnkAdd').onclick = () => {
        const url = $('#lnkUrl').value.trim();
        if (!/^https?:\/\/\S+$/.test(url)) return toast('Geçerli bir link yapıştır (https://…)', true);
        const title = $('#lnkTitle').value.trim();
        closeModal(); onPick({ title: title || shortUrl(url), src: { kind: 'link', url, title: title || undefined } });
      };
    } else if (t === 'file') {
      pane.innerHTML = dropzoneHtml('modal', kind);
      bindDropzone($('#srcPane .dropzone'), (file) => { closeModal(); onPick({ file }); });
    } else {
      pane.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
      const list = await loadCatalog(kind);
      pane.innerHTML = `<input type="text" id="catQ" placeholder="${esc(CATALOGS[kind].ph)}" style="width:100%;margin-bottom:10px">
        <p class="small muted" style="margin:0 0 8px">${list.length} öğe · önizlemek için tıkla, kullanmak için <b>Seç</b>.</p>
        <div id="catGrid" class="cands canon-grid"></div>`;
      const draw = (q = '') => {
        const ql = q.toLowerCase().trim();
        const hits = list.filter((c) => !ql || c.hay.toLowerCase().includes(ql)).slice(0, 240);
        $('#catGrid').innerHTML = hits.map((c, k) => `<div class="cand">
          ${entryMediaHtml({ slug: '' }, c, kind)}
          <div class="cand-title"><b>${esc(c.title)}</b>${c.tr ? `<div class="small muted">${esc(c.tr)}</div>` : ''}${c.use ? `<div class="small">${kind === 'sfx' ? '⏱' : '🎯'} ${esc(c.use)}</div>` : ''}</div>
          <div class="cand-actions"><button type="button" class="btn cand-pick" data-k="${k}">Seç</button></div></div>`).join('') || '<p class="muted">Sonuç yok.</p>';
        hydrateThumbs();
        $$('#catGrid [data-play]').forEach((el) => el.onclick = () => playPreview(el));
        $$('#catGrid .cand-pick').forEach((b) => b.onclick = () => { const c = hits[+b.dataset.k]; closeModal(); onPick({ title: c.title, tr: c.tr, src: { ...c.src }, preview: { ...c.preview }, opts: { ...c.opts } }); });
      };
      $('#catQ').oninput = (e) => draw(e.target.value);
      $('#catQ').focus();
      draw();
    }
  };
  $$('#srcTabs button').forEach((b) => b.onclick = () => show(b.dataset.tab));
  show(tabs[0]);
}
function bindDropzone(dz, onFile) {
  if (!dz) return;
  const inp = dz.querySelector('input[type=file]');
  inp.onchange = () => { if (inp.files[0]) onFile(inp.files[0]); inp.value = ''; };
  dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) onFile(f); };
}
async function startUpload(slug, sid, eid, file, kind) {
  const okType = { gp: /^video\//, cutaway: /^(video\/|image\/gif)/, green: /^video\//, sfx: /^audio\// }[kind];
  if (!okType.test(file.type || '') && !/\.(mp4|mov|webm|mkv|mp3|wav|ogg|m4a|gif)$/i.test(file.name)) {
    toast(`Bu dosya türü olmaz (${file.type || file.name}). ${kind === 'sfx' ? 'Ses dosyası' : 'Video'} yükle.`, true); return false;
  }
  if (file.size > UPLOAD_MAX) { toast(`Dosya çok büyük (${fmtSize(file.size)}). En fazla 75 MB: kısaltıp yükle ya da link ver.`, true); return false; }
  const key = `${sid}|${eid}`, uid = newId('u');
  const branch = `upload/${slug}/${uid}`, path = safeName(file.name);
  S.uploading.set(key, { pct: 0, name: file.name, size: file.size });
  renderKeep(slug);
  try {
    await S.store.uploadFile(file, branch, path, (p) => {
      const u = S.uploading.get(key); if (u) u.pct = p;
      const bar = document.querySelector(`[data-upbar="${CSS.escape(key)}"]`); if (bar) bar.style.width = `${Math.round(p * 100)}%`;
      const t = document.querySelector(`[data-uppct="${CSS.escape(key)}"]`); if (t) t.textContent = `%${Math.round(p * 100)}`;
    });
    S.localMedia.set(uid, URL.createObjectURL(file));
    const no = secIdx(S.games.get(slug), sid) + 1, who = S.user;
    queueOp(slug, (x) => {
      const e = findEntry(x, sid, eid); if (!e) return;
      e.src = { kind: 'upload', uid, branch, path, name: file.name, size: file.size, by: who, at: nowIso() };
      delete e.preview; delete e.review;
    }, `S${no} ${KIND[kind].label.toLowerCase()} yüklendi (${file.name})`);
    toast('Yüklendi ✓');
    return true;
  } catch (e) {
    toast('Yüklenemedi: ' + (e.status === 403 || e.status === 404 ? 'token\'ın yazma izni yok' : e.status === 413 || e.status === 422 ? 'dosya GitHub için çok büyük, kısalt ya da link ver' : e.message), true);
    return false;
  } finally {
    S.uploading.delete(key); renderKeep(slug);
  }
}
// Kelime seçici (⏱ giriş anı): anlatımın kelimelerine tıklanır (1. tık = kelime, 2. tık = aralık)
function atPicker(slug, chip, sid, eid) {
  $$('.at-picker').forEach((x) => x.remove());
  const g = S.games.get(slug), sec = g.sections.find((s) => s.id === sid), x = findEntry(g, sid, eid);
  const words = (selectedOpt(sec)?.narration || '').split(/\s+/).filter(Boolean);
  const clean = (t) => t.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');
  const cur = clean(x.at || '').toLowerCase();
  let a = -1, b = -1;
  if (cur) {
    const cw = cur.split(/\s+/);
    for (let i = 0; i + cw.length <= words.length; i++) {
      if (cw.every((w, k) => clean(words[i + k]).toLowerCase() === w)) { a = i; b = i + cw.length - 1; break; }
    }
  }
  const box = document.createElement('div');
  box.className = 'at-picker';
  const paint = () => {
    box.querySelectorAll('.w').forEach((w) => w.classList.toggle('on', a >= 0 && +w.dataset.i >= a && +w.dataset.i <= b));
    box.querySelector('.at-prev').textContent = a >= 0 ? `“${clean(words.slice(a, b + 1).join(' '))}”` : `otomatik (${WORKER_NAME} seçer)`;
  };
  box.innerHTML = `<div class="small muted">Anlatıcı hangi kelimeyi söylerken girsin? <b>Kelimeye tıkla</b>; birden fazla kelime için ikinci kelimeye de tıkla.</div>
    <div class="at-words" lang="en">${words.map((w, i) => `<button type="button" class="w" data-i="${i}">${esc(w)}</button>`).join('')}</div>
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
    queueOp(slug, (y) => { const e = findEntry(y, sid, eid); if (e) e.at = v; }, `S${secIdx(g, sid) + 1} ${(x.title || '').slice(0, 30)} giriş anı`);
    chip.textContent = v ? `⏱ “${v}”` : '⏱ giriş anı: otomatik'; box.remove();
  };
  box.querySelector('[data-act="save"]').onclick = () => save(a >= 0 ? clean(words.slice(a, b + 1).join(' ')) : '');
  box.querySelector('[data-act="auto"]').onclick = () => save('');
  box.querySelector('[data-act="close"]').onclick = () => box.remove();
  chip.closest('.item-opts').after(box); paint();
}
function bindMediaEditors(slug, ed) {
  const g = () => S.games.get(slug);
  const parse = (k) => k.split('|');
  const no = (sid) => secIdx(g(), sid) + 1;
  const kindOf = (sid, eid) => { const e = findEntry(g(), sid, eid); return e ? entryKind(e) : 'gp'; };
  if (!ed) return;
  $$('[data-range]').forEach((inp) => inp.onchange = () => {
    const [sid, eid] = parse(inp.dataset.range), v = inp.value.trim();
    queueOp(slug, (x) => { const e = findEntry(x, sid, eid); if (e) e.range = v; }, `S${no(sid)} görüntü aralığı: ${v || 'boş'}`);
  });
  $$('[data-label]').forEach((inp) => inp.onchange = () => {
    const [sid, eid] = parse(inp.dataset.label), v = inp.value.trim();
    queueOp(slug, (x) => { const e = findEntry(x, sid, eid); if (e) e.label = v; }, `S${no(sid)} ara klip etiketi: ${v || 'boş'}`);
  });
  $$('.at-chip[data-at]').forEach((chip) => chip.onclick = () => { const [sid, eid] = parse(chip.dataset.at); atPicker(slug, chip, sid, eid); });
  $$('[data-remove]').forEach((b) => b.onclick = () => {
    const [sid, eid] = parse(b.dataset.remove), e = findEntry(g(), sid, eid);
    if (!e || !confirm(`${KIND[entryKind(e)].label} kaldırılsın mı?\n${e.title || e.desc || ''}`)) return;
    queueOp(slug, (x) => { const m = mediaOf(x.sections.find((s) => s.id === sid)); m.gameplay = (m.gameplay || []).filter((y) => y.id !== eid); m.items = (m.items || []).filter((y) => y.id !== eid); },
      `S${no(sid)} ${KIND[entryKind(e)].label.toLowerCase()} kaldırıldı: ${(e.title || e.desc || '').slice(0, 40)}`);
    renderKeep(slug);
  });
  $$('[data-replace]').forEach((b) => b.onclick = () => {
    const [sid, eid] = parse(b.dataset.replace), kind = kindOf(sid, eid);
    if (kind === 'gp') { const box = document.querySelector(`[data-replace-box="${CSS.escape(b.dataset.replace)}"]`); if (box) box.hidden = !box.hidden; return; }
    sourceModal(kind, (pick) => applyPick(slug, sid, eid, kind, pick, true), { replace: true });
  });
  $$('[data-drop]').forEach((dz) => {
    const [sid, eid] = parse(dz.dataset.drop);
    bindDropzone(dz, (file) => startUpload(slug, sid, eid, file, kindOf(sid, eid)));
  });
  $$('[data-link-save]').forEach((b) => {
    const k = b.dataset.linkSave, [sid, eid] = parse(k);
    const inp = document.querySelector(`[data-link="${CSS.escape(k)}"]`);
    const save = () => {
      const url = inp.value.trim();
      if (!/^https?:\/\/\S+$/.test(url)) return toast('Geçerli bir link yapıştır (https://…)', true);
      queueOp(slug, (x) => { const e = findEntry(x, sid, eid); if (!e) return; e.src = { kind: 'link', url, by: S.user, at: nowIso() }; delete e.preview; delete e.review; },
        `S${no(sid)} görüntü linki eklendi`);
      toast('Link eklendi ✓'); renderKeep(slug);
    };
    b.onclick = save;
    if (inp) inp.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  });
  $$('[data-add-gp]').forEach((b) => b.onclick = () => {
    const sid = b.dataset.addGp;
    const desc = prompt('Bu görüntüde ne olmalı? (kısa açıklama, ör. "Kapıcı ultisini atıyor")', '');
    if (desc === null) return;
    const id = newId('g'), who = S.user;
    queueOp(slug, (x) => { mediaOf(x.sections.find((s) => s.id === sid)).gameplay.push({ id, desc: desc.trim() || 'Ek görüntü', src: null, addedBy: who, by: who }); },
      `S${no(sid)} görüntü yuvası eklendi`);
    renderKeep(slug);
  });
  $$('[data-add-item]').forEach((b) => b.onclick = () => {
    const [sid, kind] = parse(b.dataset.addItem);
    sourceModal(kind, async (pick) => {
      const id = newId('m');
      queueOp(slug, (x) => { const m = mediaOf(x.sections.find((s) => s.id === sid)); (m.items = m.items || []).push({ id, kind, title: pick.file ? pick.file.name : pick.title || '', why: '', at: '', by: S.user }); },
        `S${no(sid)} ${KIND[kind].label.toLowerCase()} eklendi`);
      await applyPick(slug, sid, id, kind, pick, false, true);
    });
  });
}
// Seçilen kaynağı (katalog / link / dosya) bir öğeye uygular
async function applyPick(slug, sid, eid, kind, pick, replacing, isNew = false) {
  const g = S.games.get(slug), no = secIdx(g, sid) + 1;
  if (pick.file) {
    renderKeep(slug);
    const ok = await startUpload(slug, sid, eid, pick.file, kind);
    if (ok) queueOp(slug, (x) => { const e = findEntry(x, sid, eid); if (e) e.title = pick.file.name.replace(/\.[^.]+$/, ''); }, `S${no} ${KIND[kind].label.toLowerCase()} adı`);
    else if (isNew) { queueOp(slug, (x) => { const m = mediaOf(x.sections.find((s) => s.id === sid)); m.items = m.items.filter((y) => y.id !== eid); }, `S${no} boş öğe kaldırıldı`); renderKeep(slug); }
    return;
  }
  queueOp(slug, (x) => {
    const e = findEntry(x, sid, eid); if (!e) return;
    e.src = { ...pick.src, by: S.user, at: nowIso() }; e.title = pick.title || e.title; e.tr = pick.tr || '';
    if (pick.preview) e.preview = pick.preview; else delete e.preview;
    e.opts = { ...(pick.opts || {}) }; delete e.review;
    if (replacing) e.why = '';
    e.by = S.user;
  }, `S${no} ${KIND[kind].label.toLowerCase()} ${replacing ? 'değişti' : 'eklendi'}: ${(pick.title || '').slice(0, 40)}`);
  toast(`${KIND[kind].label}: ${pick.title} ✓`);
  renderKeep(slug);
}
// Yeniden çizerken oynatıcı konumu, yazılmakta olan not ve sayfa kaydırması korunur
function renderKeep(slug) {
  const v = $('#revVideo'); if (v) S.revTime[slug] = v.currentTime;
  const t = $('#noteText'); if (t) S.revDraft[slug] = t.value;
  const mc = $('#mediaCard'); if (mc) S.mediaOpen[slug] = mc.open;
  const y = window.scrollY;
  renderGame(slug).then(() => window.scrollTo(0, y));
}
function updateCounts(slug) {
  const g = S.games.get(slug); if (!g) return;
  const st = stOf(g);
  if (st === 'review') refreshReviewCounts(slug);
  if (st === 'materials') {
    const c = $('#mediaCounts'); if (c) c.innerHTML = mediaCountsHtml(g);
    const b = $('#buildBtn'); if (b) b.disabled = S.uploading.size > 0;
  }
  if (st === 'script') updateScriptFooter(g);
}

/* ---------- İnceleme: sürümler + oynatıcı + zaman damgalı notlar + materyal değişiklikleri → "yeniden oluştur" ---------- */
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
    ...(r.media || []).map((x, k) => ({ t: null, text: `Materyal: ${x}`, by: r.by, reply: r.mediaReplies?.[k] || (r.status === 'done' ? 'uygulandı' : ''), state: r.mediaStates?.[k], rev: r })),
    ...(r.text && !r.notes ? [{ t: null, text: r.text, by: r.by, reply: r.reply, rev: r }] : []),
  ]).sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9));
}
function pendingChanges(g) {
  const lv = latestVersion(g); if (!lv) return 0;
  return draftNotes(g, lv.v).length + ((g.reviewGeneral || '').trim() ? 1 : 0) + (lv.captions && g.settings?.captions !== lv.captions ? 1 : 0) + mediaDiff(g).length;
}
const selDiffHtml = (g) => { const d = mediaDiff(g); return d.length ? `<div class="sel-diff"><b class="small">Materyal değişiklikleri</b>${d.map((x) => `<div class="small">• ${esc(x)}</div>`).join('')}</div>` : ''; };
function refreshReviewCounts(slug) {
  const g = S.games.get(slug); const rb = $('#rebuildBtn'); if (!g || !rb) return;
  const n = pendingChanges(g);
  rb.disabled = !n || S.uploading.size > 0; rb.textContent = `🔄 Videoyu yeniden oluştur${n ? ` (${n})` : ''}`;
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
const BUSY = ['queued_build', 'drafting', 'voicing', 'queued_revision', 'revising'];
function busyText(g) {
  const lv = latestVersion(g), nv = (lv?.v || 0) + 1, st = stOf(g);
  return {
    queued_build: 'kurguya başlayacak',
    drafting: 'ilk deneme videosunu kuruyor (geçici sesle; süreler burada belirlenir)',
    voicing: `anlatıcı sesini ve ses miksajını ekliyor${lv?.draft ? ` (taslak v${lv.v} hazır, aşağıda izleyebilirsiniz)` : ''}`,
    queued_revision: `notları sıraya aldı: v${nv} hazırlanacak`,
    revising: `düzeltiyor: v${nv} hazırlanıyor`,
  }[st] || 'çalışıyor';
}
function reviewHtml(g) {
  const vs = (g.versions || []).slice().sort((a, b) => a.v - b.v);
  const st = stOf(g), busy = BUSY.includes(st);
  if (!vs.length) return `<section class="card" id="review"><h2>🎬 Kurgu</h2>${busy ? `<div class="busy-note"><span class="spinner"></span> <b>${WORKER_NAME}</b> ${esc(busyText(g))}. Bitince burada görünür.</div>` : '<p class="muted">Henüz video yok.</p>'}</section>`;
  const lv = latestVersion(g);
  const canEdit = st === 'review';
  const sel = vs.find((v) => v.v === S.revView[g.slug]) || lv;
  const live = canEdit && sel.v === lv.v;
  const ICON = { section: '📍', cutaway: '🎞', overlay: '🟩', sfx: '🔊' };
  const KINDTL = { cutaway: 'ara klip', overlay: 'green screen', sfx: 'ses efekti' };
  const tl = sel.timeline || [];
  const pend = pendingChanges(g);
  return `<section class="card review" id="review">
    <div class="row"><h2>🎬 Kurgu</h2>
      <div class="seg ver-seg">${vs.map((v) => `<button type="button" data-ver="${v.v}" class="${v.v === sel.v ? 'on' : ''}" title="${v.draft ? 'Taslak: geçici sesle ilk deneme' : ''}">v${v.v}${v.draft ? ' · taslak' : ''}</button>`).join('')}</div>
      <span class="spacer"></span>
      <span class="small muted">${sel.duration ? `${Math.round(sel.duration)} sn · ` : ''}${sel.captions ? `altyazı: ${esc(capLabel(sel.captions))} · ` : ''}${fmtDate(sel.at)}</span>
    </div>
    ${sel.draft ? `<p class="small ver-notes">🧪 <b>Taslak</b>: süreleri belirlemek için geçici sesle kuruldu; asıl anlatıcı sesi bir sonraki sürümde.</p>` : ''}
    ${sel.notes ? `<p class="small ver-notes"><b>${esc(whoName(sel.by || WORKER_NAME))}:</b> ${esc(sel.notes)}</p>` : ''}
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
              <span class="tl-label">${it.type === 'section' ? `<b>${esc(it.sec)}</b> ${esc(it.label)}` : `${esc(it.label)} <span class="muted">(${KINDTL[it.type] || it.type})</span>`}</span></button>
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
          <span class="small muted">${WORKER_NAME} notları ve materyal değişikliklerini uygular, v${lv.v + 1}'i hazırlar.</span><span class="spacer"></span>
          <button class="btn" id="approve">✓ Onayla, bitti</button></div>
      </div>` : ''}
    ${busy ? `<div class="busy-note"><span class="spinner"></span> <b>${WORKER_NAME}</b> ${esc(busyText(g))}. Bitince burada görünür.</div>` : ''}
    ${st === 'done' ? publishBox(g) : ''}
  </section>`;
}
function mediaCardHtml(g, ed) {
  if (!isV2(g) || !g.sections.some((s) => s.media)) return '';
  const open = S.mediaOpen[g.slug] ?? (ed && mediaDiff(g).length > 0);
  return `<details class="card media-card" id="mediaCard" ${open ? 'open' : ''}><summary><b>🎛 Materyaller</b> <span class="small muted">· ${ed ? 'değiştir / ekle / kaldır; değişiklikler “Videoyu yeniden oluştur”a eklenir' : 'salt okunur'}</span></summary>
    <div class="stack" style="margin-top:12px">${g.sections.map((s, i) => mediaSectionHtml(g, s, i, ed, true)).join('')}</div></details>`;
}

function bindReview(slug) {
  const cur = () => S.games.get(slug);
  const ps = $('#pubSave');
  if (ps) ps.onclick = async () => {
    const raw = $('#pubUrl').value.trim(); const id = ytId(raw);
    if (!id) { toast('Bu bir YouTube video linki değil (youtube.com/shorts/… ya da youtu.be/…)', true); return; }
    const url = /\/shorts\//.test(raw) ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`;
    ps.disabled = true;
    try {
      await mutateGame(slug, (x) => { x.published = { url, videoId: id, at: nowIso(), by: S.user }; logLine(x, `Yayın linki eklendi: ${url}`); }, 'yayın linki');
      S.pubEdit[slug] = false; toast('Yayın linki kaydedildi ✓'); renderGame(slug);
    } catch (e) { toast('Kaydedilemedi: ' + e.message, true); ps.disabled = false; }
  };
  const pu = $('#pubUrl'); if (pu) pu.onkeydown = (e) => { if (e.key === 'Enter') $('#pubSave')?.click(); };
  const pe = $('#pubEdit'); if (pe) pe.onclick = () => { S.pubEdit[slug] = true; renderGame(slug); };
  const pc = $('#pubCancel'); if (pc) pc.onclick = () => { S.pubEdit[slug] = false; renderGame(slug); };
  const rerender = () => renderKeep(slug);
  $$('.ver-seg button').forEach((b) => b.onclick = () => { S.revView[slug] = +b.dataset.ver; S.revTime[slug] = 0; renderGame(slug); });
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
  $$('.tl-go').forEach((b) => b.onclick = () => seek(b.dataset.t));
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
  $$('[data-note-at]').forEach((b) => b.onclick = () => {
    seek(b.dataset.noteAt); noteT = +b.dataset.noteAt; showT();
    if (txt) { txt.value = `${b.dataset.noteLabel}: `; txt.focus(); txt.setSelectionRange(txt.value.length, txt.value.length); }
  });
  $$('[data-rm-at]').forEach((b) => b.onclick = () => {
    addNote(+b.dataset.rmAt, `${b.dataset.rmLabel}: kaldırılsın`); toast('Not eklendi: kaldırılsın'); rerender();
  });
  $$('[data-del-note]').forEach((b) => b.onclick = () => {
    const id = b.dataset.delNote;
    queueOp(slug, (x) => { x.reviewNotes = (x.reviewNotes || []).filter((n) => n.id !== id); }, 'not silindi'); rerender();
  });
  $$('#capSegR button').forEach((b) => b.onclick = () => {
    const c = b.dataset.cap; queueOp(slug, (x) => { x.settings.captions = c; }, `altyazı: ${c}`); rerender();
  });
  const gen = $('#revGeneral');
  if (gen) gen.onchange = () => { const val = gen.value; queueOp(slug, (x) => { x.reviewGeneral = val; }, 'genel not'); rerender(); };
  const rb = $('#rebuildBtn');
  if (rb) rb.onclick = async () => {
    if (S.uploading.size) return toast('Yükleme bitmeden gönderilemez', true);
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
        const media = mediaDiff(x);
        (x.revisions = x.revisions || []).push({ id, at: nowIso(), by: S.user, v: lv.v, notes, general: (x.reviewGeneral || '').trim(),
          ...(capChanged ? { captions: x.settings.captions } : {}), ...(media.length ? { media } : {}), status: 'queued' });
        x.reviewNotes = (x.reviewNotes || []).filter((m) => m.v !== lv.v);
        x.reviewGeneral = '';
        x.status = 'queued_revision';
        logLine(x, `v${lv.v} için ${notes.length} not${media.length ? ` + ${media.length} materyal değişikliği` : ''} gönderildi, yeniden oluşturma istendi.`);
      }, `v${lv.v} düzeltme istendi`);
      await enqueue('revise', slug, { revision: id });
      toast('Kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Gönderilemedi: ' + e.message, true); rb.disabled = false; }
  };
  const ap = $('#approve');
  if (ap) ap.onclick = async () => {
    if (pendingChanges(cur()) && !confirm('Gönderilmemiş notlar / materyal değişiklikleri var. Yine de onaylansın mı?')) return;
    await flush(slug);
    await mutateGame(slug, (x) => { x.status = 'done'; logLine(x, `v${latestVersion(x).v} onaylandı.`); }, 'onaylandı');
    toast('Tebrikler! 🎉'); renderGame(slug);
  };
}

/* ---------- oyun sayfası ---------- */
async function renderGame(slug) {
  const app = $('#app');
  if (!S.games.has(slug)) {
    app.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
    const r = await readJSON(`games/${slug}/game.json`);
    if (!r) { app.innerHTML = `<div class="card empty">Oyun bulunamadı. <a href="#/">Geri dön</a></div>`; return; }
    S.games.set(slug, r.data);
  }
  const g = S.games.get(slug);
  const st = stOf(g);
  const secs = g.sections || [];
  let body = '', footer = '';
  if (g.deleteRequested) body += `<div class="card del-banner">🗑 <b>${esc(g.deleteRequested.by || ADMIN.name)}</b> bu oyunun silinmesini istedi; ${WORKER_NAME} birkaç dakika içinde kaldıracak.
    ${isAdmin() ? '<button type="button" class="btn btn-ghost small" id="undoDelete">Vazgeç</button>' : ''}</div>`;
  if (['queued_research', 'researching'].includes(st)) {
    body += `<div class="card empty"><span class="spinner"></span><h2 style="margin-top:12px">${st === 'researching' ? `${WORKER_NAME} araştırıyor…` : `${WORKER_NAME} araştırma yapacak`}</h2>
      <p class="muted">Oyunu ve topluluğun esprilerini (Reddit, Steam, YouTube yorumları…) araştırıyor. Kağan'ın bilgisayarı açıkken işlenir; metin seçenekleri hazır olunca burada görünür.</p></div>`;
  }
  if (st === 'queued_regen') body += `<div class="card" style="border-color:var(--info)"><span class="spinner"></span> <b>${WORKER_NAME} yeni seçenekler hazırlıyor:</b> ${esc((g.regenSections || []).map((id) => 'S' + (secIdx(g, id) + 1)).join(', ') || 'tüm video')}. Bitince seçime devam edebilirsiniz.</div>`;
  if ((st === 'script' || st === 'queued_regen') && secs.length) {
    const editable = st === 'script';
    const s = stats(g);
    body += fixedLinesHtml(g) + `<section class="card">
        <div class="row"><h2>🎯 Genel tema / istek</h2><span class="spacer"></span>
          <label class="chip small"><input type="checkbox" id="regenAll" ${g.regenAll ? 'checked' : ''} ${editable ? '' : 'disabled'}> Tüm metni buna göre yeniden öner</label></div>
        <textarea id="briefIn" class="note-input" rows="2" placeholder="Opsiyonel. Videonun genel havası veya mutlaka olmasını istediğiniz espri. Örn: “Pauselock meme'i ana espri olsun, final de ona bağlansın.”" ${editable ? '' : 'disabled'}>${esc(g.brief || '')}</textarea>
      </section>` + secs.map((x, i) => scriptSectionHtml(x, i, g, editable)).join('');
    if (editable) footer = `<div class="footer-bar"><div class="footer-inner">
      <span class="stat"><b id="stChosen">${s.chosen}/${s.total}</b> <span class="small muted">bölüm</span></span>
      <span class="stat" title="Seçilen repliklerin tahmini anlatım süresi"><b id="stSecs">≈${s.secs}</b> <span class="small muted">sn anlatım</span></span>
      <span class="sec-nav">${secs.map((x, i) => `<button type="button" class="sec-dot ${x.selected ? 'done' : ''}" data-go="${esc(x.id)}" title="S${i + 1} · ${esc(x.title)}${x.selected ? ' · seçildi: ' + x.selected.toUpperCase() : ' · seçim yok'}">${i + 1}</button>`).join('')}</span>
      <span class="spacer"></span>
      <button class="btn" id="regenBtn" ${regenCount(g) ? '' : 'hidden'}>🔄 Tekrar yap (<span id="regenN">${regenCount(g)}</span>)</button>
      <button class="btn btn-primary" id="scriptOk" ${s.chosen === s.total ? '' : 'disabled'} title="Seçilen metinle materyal toplama başlar">✓ Metni onayla → Materyal</button>
    </div></div>`;
  }
  if (['queued_materials', 'gathering'].includes(st)) {
    body += `<div class="card empty"><span class="spinner"></span><h2 style="margin-top:12px">${st === 'gathering' ? `${WORKER_NAME} materyal topluyor…` : `${WORKER_NAME} materyal toplayacak`}</h2>
      <p class="muted">Her bölüm için oyun görüntüsü (önce resmi fragmanlar ve oynanış videoları), ara klip, green screen meme ve ses efekti arıyor. Bulamadığı görüntü için size yükleme alanı açacak.</p></div>` + scriptSummaryHtml(g, true);
  }
  if (st === 'materials') {
    body += mediaHeadHtml(g) + secs.map((x, i) => mediaSectionHtml(g, x, i, true)).join('');
    const miss = missingSecs(g).length;
    footer = `<div class="footer-bar"><div class="footer-inner">
      <span class="stat"><b>${secs.length - miss}/${secs.length}</b> <span class="small muted">bölümde görüntü</span></span>
      <span class="sec-nav">${secs.map((x, i) => `<button type="button" class="sec-dot ${(x.media?.gameplay || []).some((y) => y.src) ? 'done' : ''}" data-go="${esc(x.id)}" title="S${i + 1} · ${esc(x.title)}">${i + 1}</button>`).join('')}</span>
      <span class="spacer"></span>
      <button class="btn btn-primary" id="buildBtn" ${S.uploading.size ? 'disabled' : ''} title="${WORKER_NAME} ilk deneme videosunu kurar, sonra sesi ekler">▶ Kurguya başla</button>
    </div></div>`;
  }
  if (BUSY.includes(st) || ['review', 'done'].includes(st)) {
    body += reviewHtml(g);
    if (isV2(g)) body += mediaCardHtml(g, st === 'review');
    if (st === 'done' || !isV2(g)) body += scriptSummaryHtml(g);
  }
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
      ${body}
      ${g.summary ? `<details class="card"><summary>Oyun özeti</summary><p>${esc(g.summary)}</p><p class="small muted">Detaylı araştırma: repo içinde <code>games/${esc(g.slug)}/research.md</code></p></details>` : ''}
      ${(g.log || []).length ? `<details class="card"><summary>Geçmiş</summary><div class="log">${g.log.slice().reverse().map((l) => `<div>${fmtDate(l.at)} · <b>${esc(whoName(l.by))}</b> · ${esc(l.msg)}</div>`).join('')}</div></details>` : ''}
    </div>
    ${footer}
  `;
  bindGame(slug);
}

function updateScriptFooter(g) {
  const st = stats(g);
  const rb = $('#regenBtn'); if (rb) { const n = regenCount(g); rb.hidden = !n; $('#regenN').textContent = n; }
  const c = $('#stChosen'); if (c) c.textContent = `${st.chosen}/${st.total}`;
  $$('.sec-dot').forEach((d) => d.classList.toggle('done', !!g.sections.find((x) => x.id === d.dataset.go)?.selected));
  const s = $('#stSecs'); if (s) { s.textContent = `≈${st.secs}`; s.style.color = st.secs > 58 ? 'var(--bad)' : ''; }
  const b = $('#scriptOk'); if (b) b.disabled = st.chosen !== st.total;
}

function bindGame(slug) {
  const cur = () => S.games.get(slug);
  const g0 = cur(), st = stOf(g0);
  const take = $('#takeOwner');
  if (take) take.onclick = () => { queueOp(slug, (x) => { x.owners = [...new Set([...owners(x), S.user])]; x.owner = x.owners[0]; logLine(x, `${S.user} projeye katıldı.`); }, 'çalışan eklendi'); renderGame(slug); };
  $('#editGame').onclick = () => editGameModal(slug);
  const ud = $('#undoDelete');
  if (ud) ud.onclick = async () => {
    try {
      const job = cur().deleteRequested?.job;
      if (job) await S.store.del(job, `[${S.user}] ${cur().title}: silme isteği geri alındı`);
      await mutateGame(slug, (x) => { delete x.deleteRequested; logLine(x, 'Silme isteği geri alındı.'); }, 'silme geri alındı');
      toast('Silme iptal edildi ✓'); renderGame(slug);
    } catch (e) { toast('Olmadı: ' + e.message, true); }
  };
  hydrateThumbs();
  $$('[data-play]').forEach((el) => el.onclick = (ev) => { ev.stopPropagation(); playPreview(el); });
  $$('.sec-dot').forEach((d) => d.onclick = () => document.getElementById('sec-' + d.dataset.go)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  $$('#capSeg button').forEach((b) => b.onclick = () => {
    const v = b.dataset.cap;
    queueOp(slug, (x) => { x.settings.captions = v; }, `altyazı: ${v}`);
    $$('#capSeg button').forEach((y) => y.classList.toggle('on', y === b));
  });
  if (st === 'script') bindScript(slug);
  if (st === 'materials') {
    bindMediaEditors(slug, true);
    const back = $('#backToScript');
    if (back) back.onclick = async () => {
      if (!confirm('Metin aşamasına dönülsün mü? Materyaller korunur; metnini değiştirdiğin bölümlere ' + WORKER_NAME + ' yeniden bakar.')) return;
      await flush(slug);
      await mutateGame(slug, (x) => { x.status = 'script'; logLine(x, `${S.user} metin aşamasına döndü.`); }, 'metne geri dönüldü');
      renderGame(slug);
    };
    const bb = $('#buildBtn');
    if (bb) bb.onclick = async () => {
      if (S.uploading.size) return toast('Yükleme bitmesini bekle', true);
      await flush(slug);
      const g = cur(), miss = missingSecs(g);
      const msg = miss.length ? `${miss.length} bölümde oyun görüntüsü yok (${miss.map((s) => 'S' + (secIdx(g, s.id) + 1)).join(', ')}). ${WORKER_NAME} bulabilirse tamamlar, bulamazsa o bölümde elindeki en yakın görüntüyü kullanır.\nYine de kurguya başlansın mı?`
        : `${WORKER_NAME} ilk deneme videosunu kuracak, sonra anlatıcı sesini ekleyecek. Başlansın mı?`;
      if (!confirm(msg)) return;
      bb.disabled = true;
      try {
        await mutateGame(slug, (x) => { x.status = 'queued_build'; x.mediaBase = mediaSnapshot(x); logLine(x, 'Materyaller onaylandı, kurgu başlatıldı.'); }, 'kurgu başlatıldı');
        await enqueue('build', slug);
        toast('Kurgu kuyruğa alındı ✓'); renderGame(slug);
      } catch (e) { toast('Başlatılamadı: ' + e.message, true); bb.disabled = false; }
    };
  }
  if (BUSY.includes(st) || ['review', 'done'].includes(st)) {
    bindMediaEditors(slug, st === 'review');
    const mc = $('#mediaCard'); if (mc) mc.ontoggle = () => { S.mediaOpen[slug] = mc.open; };
    bindReview(slug);
  }
}

function bindScript(slug) {
  const g = new Proxy({}, { get: (_, k) => S.games.get(slug)[k] }); // kayıttan sonra güncel nesne
  $$('.opt').forEach((btn) => btn.onclick = (ev) => {
    if (ev.target.closest('a')) return;
    const sid = btn.dataset.sec, oid = btn.dataset.opt;
    const sec = g.sections.find((s) => s.id === sid);
    const val = sec.selected === oid ? null : oid;
    queueOp(slug, (x) => { x.sections.find((s) => s.id === sid).selected = val; }, `${sid} → ${val || 'boş'}`);
    btn.parentElement.querySelectorAll('.opt').forEach((b) => b.classList.toggle('selected', b.dataset.opt === val));
    btn.closest('section').classList.toggle('has-sel', !!val);
  });
  $$('.opt').forEach((btn) => btn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click(); } });
  $$('.regen-btn').forEach((b) => b.onclick = () => {
    const sid = b.dataset.regen;
    const sec = g.sections.find((s) => s.id === sid);
    const val = !sec.regen;
    const note = document.querySelector(`[data-note="${sid}"]`).value.trim();
    if (val && !note) { toast('Önce not kutusuna yeni temayı / isteğini yaz.', true); document.querySelector(`[data-note="${sid}"]`).focus(); return; }
    queueOp(slug, (x) => { const s = x.sections.find((s) => s.id === sid); s.regen = val; s.note = note; }, `${sid} yeniden öner: ${val ? 'evet' : 'hayır'}`);
    b.classList.toggle('btn-primary', val); b.classList.toggle('btn-ghost', !val);
    b.textContent = val ? '🔄 Yeniden önerilecek ✓' : '🔄 Bu bölümü yeniden öner';
  });
  $$('[data-note]').forEach((ta) => ta.onchange = () => {
    const sid = ta.dataset.note, v = ta.value;
    queueOp(slug, (x) => { x.sections.find((s) => s.id === sid).note = v; }, `${sid} notu`);
  });
  const brief = $('#briefIn');
  if (brief) brief.onchange = () => { const v = brief.value.trim(); queueOp(slug, (x) => { x.brief = v; }, 'genel tema'); };
  const ra = $('#regenAll');
  if (ra) ra.onchange = () => {
    if (ra.checked && !$('#briefIn').value.trim()) { ra.checked = false; toast('Önce genel tema alanına isteğini yaz.', true); $('#briefIn').focus(); return; }
    const v = ra.checked, b = $('#briefIn').value.trim();
    queueOp(slug, (x) => { x.regenAll = v; x.brief = b; }, `tüm metin yeniden: ${v}`);
  };
  const rgb = $('#regenBtn');
  if (rgb) rgb.onclick = async () => {
    const ids = g.regenAll ? g.sections.map((s) => s.id) : g.sections.filter((s) => s.regen).map((s) => s.id);
    if (!ids.length) return;
    if (!confirm(`${g.regenAll ? 'Tüm metin' : ids.length + ' bölüm'} notlarınıza göre yeniden önerilecek (bu bölümlerdeki seçimler sıfırlanır).\nDevam?`)) return;
    rgb.disabled = true;
    try {
      await flush(slug);
      await mutateGame(slug, (x) => {
        x.status = 'queued_regen'; x.regenSections = ids;
        logLine(x, `Yeniden öneri istendi: ${g.regenAll ? 'tüm metin' : ids.map((id) => 'S' + (secIdx(x, id) + 1)).join(', ')}.`);
      }, 'yeniden öneri istendi');
      await enqueue('regenerate', slug, { sections: ids, brief: g.brief || '', all: !!g.regenAll });
      toast('Kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Gönderilemedi: ' + e.message, true); rgb.disabled = false; }
  };
  const ok = $('#scriptOk');
  if (ok) ok.onclick = async () => {
    const s = stats(g);
    if (s.chosen !== s.total) return toast('Her bölüm için bir replik seç', true);
    if (regenCount(g) && !confirm('Yeniden öneri için işaretli bölümler var; onaylarsan işaretler yok sayılır. Devam?')) return;
    if (!confirm(`Metin onaylansın mı? ${WORKER_NAME} her bölüm için oyun görüntüsü, ara klip, green screen ve ses efekti arayacak.`)) return;
    ok.disabled = true;
    try {
      await flush(slug);
      await mutateGame(slug, (x) => {
        x.status = 'queued_materials'; x.scriptApprovedAt = nowIso(); x.scriptApprovedBy = S.user; x.regenAll = false;
        x.sections.forEach((s) => { delete s.regen; });
        logLine(x, `Metin onaylandı (≈${stats(x).secs} sn anlatım), materyal toplama kuyruğa alındı.`);
      }, 'metin onaylandı');
      await enqueue('materials', slug);
      toast('Materyal toplama kuyruğa alındı ✓'); renderGame(slug);
    } catch (e) { toast('Gönderilemedi: ' + e.message, true); ok.disabled = false; }
  };
}

/* ---------- önizleme medyası (özel repodan blob olarak) ---------- */
const blobCache = new Map();
function blob(path) {
  if (!blobCache.has(path)) blobCache.set(path, S.store.blobUrl(path).catch((e) => { blobCache.delete(path); throw e; }));
  return blobCache.get(path);
}
function hydrateThumbs() {
  const imgs = $$('img[data-src]');
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
  $$('video.cand-video, video.slot-video, audio').forEach((m) => { if (m !== src) { m.volume = VOL.v; m.muted = VOL.muted; } });
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

/* ---------- entegrasyonlar (API anahtarları şifreli saklanır; sadece yönetici değiştirir) ---------- */
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
  const ro = !isAdmin();
  const dis = ro ? 'disabled' : '';
  const num = (id, label, v, min, max, step, hint) => `<div class="field"><label for="${id}">${label} <span class="muted small" id="${id}V">${v}</span></label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}" ${dis}><span class="small muted">${hint}</span></div>`;
  app.innerHTML = `
    <a href="#/" class="small muted" style="text-decoration:none">← Tüm oyunlar</a>
    <h1 style="margin:8px 0 6px">Entegrasyonlar</h1>
    <p class="muted" style="margin:0 0 20px">API anahtarları tarayıcıda şifrelenir; sadece Kağan'ın bilgisayarındaki ${WORKER_NAME} çözebilir. Kaydedilen anahtar burada bir daha gösterilmez, sadece değiştirilebilir.</p>
    ${ro ? `<div class="card small" style="margin-bottom:16px;border-color:var(--warn)">🔒 Bu ayarları yalnız ${ADMIN.name} değiştirebilir. Anlatıcı sesi her videoda aynı kalır.</div>` : ''}
    <section class="card stack">
      <div class="row"><h2>🎙️ ElevenLabs</h2><span class="spacer"></span>
        <span class="pill dot ${el.apiKeyEnc ? 'st-done' : 'st-queued_build'}">${el.apiKeyEnc ? `Anahtar ayarlı · ${esc(el.apiKeySetBy)} · ${fmtDate(el.apiKeySetAt)}` : 'Anahtar yok'}</span></div>
      <div class="field"><label for="elKey">API anahtarı ${el.apiKeyEnc ? '(değiştirmek için yeni anahtarı yaz)' : ''}</label>
        <input type="password" id="elKey" autocomplete="off" placeholder="${el.apiKeyEnc ? '•••••••• (kayıtlı)' : 'sk_…'}" ${dis}>
        <span class="small muted">ElevenLabs → sol alt <b>Developers</b> → <b>API Keys</b> → Create. İzinlerde Text to Speech ve Voices açık olsun.</span></div>
      <div class="field"><label for="elVoice">Ses kimliği (Voice ID)</label>
        <input type="text" id="elVoice" value="${esc(el.voiceId || '')}" placeholder="örn. 21m00Tcm4TlvDq8ikWAM" ${dis}>
        <span class="small muted">ElevenLabs → Voices → anlatıcı sesinin yanındaki ⋯ → <b>Copy voice ID</b>.</span></div>
      <div class="field"><label for="elModel">Model</label>
        <select id="elModel" ${dis}>${ELEVEN_MODELS.map(([v, l]) => `<option value="${v}" ${el.modelId === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      ${num('elStab', 'Stabilite', el.stability ?? 0.45, 0, 1, 0.05, 'Düşük = daha duygulu/değişken, yüksek = daha düz ve tutarlı.')}
      ${num('elSim', 'Benzerlik', el.similarity ?? 0.8, 0, 1, 0.05, 'Orijinal sese ne kadar sadık kalsın.')}
      ${num('elStyle', 'Stil abartısı', el.style ?? 0.2, 0, 1, 0.05, 'Yükseldikçe daha "oyunculu" okur (deadpan için düşük tutun).')}
      ${num('elSpeed', 'Hız', el.speed ?? 1.0, 0.7, 1.2, 0.05, '60 saniyeye sığdırmak için 1.0–1.1 iyi çalışır.')}
      ${ro ? '' : '<div class="row"><button class="btn btn-primary" id="elSave">Kaydet</button><span id="elMsg" class="small"></span></div>'}
    </section>`;
  ['elStab', 'elSim', 'elStyle', 'elSpeed'].forEach((id) => { const r = $('#' + id); r.oninput = () => ($('#' + id + 'V').textContent = r.value); });
  const save = $('#elSave');
  if (save) save.onclick = async () => {
    if (!isAdmin()) return toast(`Yalnız ${ADMIN.name} değiştirebilir`, true);
    save.disabled = true; $('#elMsg').textContent = 'Kaydediliyor…';
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
    } catch (err) { $('#elMsg').innerHTML = `<span style="color:var(--bad)">Kaydedilemedi: ${esc(err.message)}</span>`; save.disabled = false; }
  };
}

/* ---------- worker durumu (Kağan'ın PC'sindeki arka plan Claude) ---------- */
const fmtTime = (iso) => { try { return new Date(iso).toLocaleString('tr-TR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
const JOB_LABEL = { new_game: 'araştırma', regenerate: 'yeniden öneri', materials: 'materyal toplama', build: 'kurgu + ses', revise: 'düzeltme', suggest: 'yeni oyun önerileri',
  delete_game: `silme (${ADMIN.name})`, refresh_media: 'meme adaylarını yenileme' };
function jobName(j) {
  const m = /^\d{8}T\d{6}-([a-z_]+)-(.+)$/.exec(j || '');
  if (!m) return j || '';
  return `${m[2] === '_suggest' ? 'Öneri havuzu' : S.games.get(m[2])?.title || m[2]}: ${JOB_LABEL[m[1]] || m[1]}`;
}
// Kullanım limiti (Claude oturum / haftalık limit): devam saati Türkçe ve net yazılır (Kağan 2026-10-10).
// Eski kayıtlarda limit "hata" olarak geçebiliyor ("You've hit your session limit · resets 6:10pm") → mesajdan da anlaşılır.
const LIMIT_RE = /(usage|session|weekly|5-hour) limit|limit reached|hit your( \w+)? limit|out of (extra )?usage/i;
function limitReset(w) {
  if (w.resetAt) return new Date(w.resetAt);
  const m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(w.message || '');
  if (!m) return null;
  let h = +m[1]; const min = +(m[2] || 0), ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const base = new Date(w.at || Date.now()), d = new Date(base);
  d.setHours(h, min, 0, 0);
  if (d <= base) d.setDate(d.getDate() + 1);
  return d;
}
function fmtReset(d) {
  if (!d || isNaN(d)) return null;
  const hm = d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date())) / 864e5);
  return diff === 0 ? `bugün ${hm}` : diff === 1 ? `yarın ${hm}` : `${d.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' })} ${hm}`;
}
// Limit görünümü: kısa (üst bar) + uzun (bant / iş listesi) metin
function limitView(w, job) {
  const r = limitReset(w), when = fmtReset(r), passed = r && r <= new Date();
  const short = passed ? '⏳ Limit sıfırlandı' : `⏸ Limit doldu${r ? ` · devam ${r.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}` : ''}`;
  const long = `${WORKER_NAME}'ın Claude kullanım limiti doldu${job ? `; “${job}” yarım kaldı` : ''}. `
    + (passed ? `Limit sıfırlandı; ${WORKER_NAME} 5 dakika içinde kaldığı yerden devam eder.`
      : when ? `Devam saati: ${when}. ${WORKER_NAME} o saatte kaldığı yerden kendiliğinden devam edecek; bu arada seçim yapmaya devam edebilirsiniz.`
        : `Limit sıfırlanınca kaldığı yerden kendiliğinden devam edecek.`);
  return { short, long };
}
function workerView(w0) {
  if (!w0) return null;
  const w = { ...w0, job: jobName(w0.job) };
  const ageH = (Date.now() - new Date(w.at).getTime()) / 36e5;
  if (w.state === 'running' && ageH > 3) return { cls: 'warn', short: '⚠️ Çırak yanıt vermiyor', long: `Son durum ${fmtTime(w.at)}: "${w.job}" çalışıyordu ama 3 saattir haber yok. Kağan'ın bilgisayarı kapanmış olabilir; açılınca iş devam eder.` };
  if (w.state === 'running') return { cls: 'run', short: '🟢 Çalışıyor', long: `${WORKER_NAME} şu işi yapıyor: ${w.job}` };
  if (w.state === 'limited' || (w.state === 'error' && LIMIT_RE.test(w.message || ''))) return { cls: 'warn', ...limitView(w, w.job), banner: true, limit: true };
  if (w.state === 'error') return { cls: 'bad', short: '⚠️ Çırak hatası', long: `"${w.job || ''}" işinde hata oldu: ${w.message}. Kuyruktaki iş 5 dakika sonra tekrar denenecek; tekrarlarsa Kağan'a haber verin.`, banner: true };
  return { cls: 'idle', short: '● Boşta', long: `${WORKER_NAME} boşta. ${w.message || ''} (${fmtTime(w.at)})` };
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
  return v?.banner || v?.cls === 'warn' ? `<div class="card worker-banner ${v.cls}">${v.limit ? `⏸ ${esc(v.long)}` : `${esc(v.short)}: ${esc(v.long)}`}</div>` : '';
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
    const title = j.slug === '_suggest' ? 'Öneri havuzu' : S.games.get(j.slug)?.title || j.slug;
    const extra = j.type === 'regenerate' && j.payload?.sections ? ` (${j.payload.all ? 'tüm metin' : j.payload.sections.length + ' bölüm'})` : '';
    return `<div class="task ${isRun ? 'run' : ''}">
      <span class="task-n">${isRun ? (w.state === 'limited' ? '⏸' : '▶') : i + 1}</span>
      <div style="flex:1;min-width:0"><b>${esc(title)}</b>: ${esc(JOB_LABEL[j.type] || j.type)}${esc(extra)}
        <div class="small muted">${esc(j.by || '?')} istedi · ${isRun ? (w.state === 'limited' ? 'limit nedeniyle yarım kaldı' : `çalışıyor (${sinceText(w.at)})`) : `sırada (${sinceText(j.at)})`}</div></div>
      <a class="small" href="${j.slug === '_suggest' ? '#/' : `#/game/${encodeURIComponent(j.slug)}`}">aç →</a>
    </div>`;
  };
  const state = v ? `<span class="worker-pill ${v.cls}" title="${esc(v.long)}">${esc(v.short)}</span>` : '';
  const isLimit = w && (w.state === 'limited' || (w.state === 'error' && LIMIT_RE.test(w.message || '')));
  const limitRow = isLimit ? `<div class="task-alert warn">⏸ <div>${esc(limitView(w, jobName(w.job)).long)}${jobs.length ? ` <span class="muted">(${jobs.length} iş bekliyor)</span>` : ''}</div></div>`
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
  const isWorker = /^Claude( \(worker\))?$|^Worker$|^Askeri Ücretli Çalışan$|^Çırak$/.test(m[1]);
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
    const msg = d[2].split(' | ')[1] || '';
    if (d[1] === 'limited' || (d[1] === 'error' && LIMIT_RE.test(msg))) {
      const r = limitReset({ resetAt: parts.reset, message: msg, at: c.at });
      return { ...base, icon: '⏸', alert: 'warn', text: `Claude kullanım limiti doldu${job ? `; “${job}” yarım kaldı` : ''}. ${r ? `Devam saati: ${r.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}.` : 'Limit sıfırlanınca devam eder.'}` };
    }
    if (d[1] === 'error') return { ...base, icon: '⚠️', alert: 'bad', text: `hata oldu${job ? ` (${job})` : ''}: ${d[2].split(' | ')[1] || ''}`.slice(0, 220) };
    return null;
  }
  if (/^iş kuyruğu: /.test(rest)) {
    const [, type, slug] = /^iş kuyruğu: (\S+) (\S+)/.exec(rest) || [];
    return { who, icon: type === 'delete_game' ? '🗑' : '📥', text: `${S.games.get(slug)?.title || slug} için ${JOB_LABEL[type] || type} işini kuyruğa ekledi`, game: slug, at: c.at };
  }
  const ng = /^Yeni oyun: (.+)$/.exec(rest);
  if (ng) { const sl = slugify(ng[1]); return { who, icon: '🆕', text: 'yeni oyun ekledi', title: S.games.get(sl)?.title || ng[1], game: S.games.has(sl) ? sl : null, at: c.at }; }
  const g = /^([^:]+): (.*)$/.exec(rest);
  if (!g) return { who, icon: who === WORKER_NAME ? '🤖' : '✏️', text: rest, game: null, at: c.at };
  const raw = g[1].trim(), found = [...S.games.values()].find((x) => x.title === raw || x.slug === raw.toLowerCase());
  const slug = found?.slug || null, title = found?.title || raw;
  const icon = who === WORKER_NAME ? '🤖' : /silin/i.test(g[2]) ? '🗑' : /çıktı|başlatıldı|onaylandı|düzeltme|onay/i.test(g[2]) ? '🚦' : /yüklendi|yükleme/i.test(g[2]) ? '📤' : '✏️';
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
  $('#actWho').innerHTML = chip('all', 'Hepsi') + people.map((p) => chip(p, p === WORKER_NAME ? `🤖 ${WORKER_NAME}` : p)).join('') + chip('system', '🛠 Sistem');
  $('#actGame').innerHTML = `<option value="all">Tüm oyunlar</option>` + [...S.games.values()].map((x) => `<option value="${esc(x.slug)}" ${fg === x.slug ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
  $$('#actWho .chip-btn').forEach((b) => b.onclick = () => { ls.set('studio.actWho', b.dataset.who); renderActivity(); });
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
  try { S.login = await S.store.whoami(); } catch { S.login = null; }
  if (lockedName()) { S.user = lockedName(); ls.set('studio.user', S.user); }
  else if (S.user === ADMIN.name || (S.user && !S.members.includes(S.user))) { S.user = null; ls.del('studio.user'); }
  await loadWorkerStatus();
  try {
    const c = await readJSON('config/studio.json'); S.config = c?.data || {};
    const a = $('#driveRoot'); if (a && S.config.driveRootUrl) { a.href = S.config.driveRootUrl; a.innerHTML = DRIVE_SVG; a.hidden = false; }
    const y = $('#ytChannel'); if (y && S.config.youtube?.channelUrl) { y.href = S.config.youtube.channelUrl; y.innerHTML = YT_SVG; y.title = `YouTube: ${S.config.youtube.name} (${S.config.youtube.handle})`; y.hidden = false; }
  } catch {}
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
window.addEventListener('beforeunload', (e) => { if ([...S.pending.values()].some((l) => l.length) || S.uploading.size) { e.preventDefault(); e.returnValue = ''; } });
// Sayfaya yanlışlıkla bırakılan dosya tarayıcıda açılmasın (yükleme alanının dışında)
window.addEventListener('dragover', (e) => { if (!e.target.closest?.('.dropzone')) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (!e.target.closest?.('.dropzone')) e.preventDefault(); });

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
