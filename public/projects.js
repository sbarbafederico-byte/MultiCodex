const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => value == null ? '—' : Number(value).toLocaleString('it-IT');
const date = value => value ? new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Non disponibile';
function bytes(value) {
  if (value == null) return '—';
  if (!value) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return number(Number((value / 1024 ** i).toFixed(i ? 1 : 0))) + ' ' + units[i];
}
const duration = value => value ? `${Math.floor(value / 3600000)}h ${Math.floor(value / 60000) % 60}m` : '—';
const countPrompts = p => (p.incompleteHistory && p.prompts != null ? '≥ ' : '') + number(p.prompts);
const size = p => (p.disk?.partial && p.disk.bytes != null ? '≥ ' : '') + bytes(p.disk?.bytes);
const codexSize = p => p.codexStorage ? (p.codexStorage.partial ? '≥ ≈ ' : '≈ ') + bytes(p.codexStorage.attributedBytes) : '—';
function conversationPaths(p) {
  const s = p.codexStorage;
  return s ? [...new Set([...s.stores.filter(f => f.kind === 'conversations').map(f => f.path), ...s.files.filter(f => f.kind === 'conversations' && f.available).map(f => f.path)])] : [];
}
function sourcePaths(storage) {
  const files = storage?.files || [], databases = storage?.databases || [];
  return [...files.map(f => `<div class="storage-path"><code>${esc(f.path)}</code><small>${f.available ? bytes(f.bytes) : 'Percorso registrato · file non presente'}</small></div>`), ...databases.map(f => `<div class="storage-path"><code>${esc(f.path)}</code><small>Database condiviso · ${f.kind === 'conversations' ? 'cronologia' : f.kind === 'logs' ? 'log' : 'dati'}</small></div>`)].join('') || '<p class="field-note">Nessun percorso locale individuato per questa conversazione.</p>';
}
function storageReport(p) {
  const s = p.codexStorage;
  if (!s) return '<section class="codex-storage-report"><h3>Dati Codex del progetto</h3><p>Lettura dei percorsi in corso…</p></section>';
  return `<section class="codex-storage-report"><h3>Dati Codex del progetto</h3><p class="field-note">Include conversazioni principali e sottoagenti. Il totale indicativo somma file dedicati e contenuto logico nei database condivisi.</p><div class="project-card-stats has-codex">${stat('TOTALE INDICATIVO', codexSize(p))}${stat('FILE DEDICATI', bytes(s.fileBytes))}${stat('CONTENUTO NEI DATABASE', bytes(s.databaseBytes))}${stat('ARCHIVI CONDIVISI', number(s.stores.length))}</div><div class="storage-categories">${s.categories.map(c => `<div><b>${esc(c.label)}</b><span>File: ${esc(bytes(c.fileBytes))}</span><span>Database (contenuto logico): ${esc(bytes(c.databaseBytes))} · ${number(c.rows)} righe</span></div>`).join('')}</div>${s.partial ? '<p class="project-partial">Una parte dei dati Codex non è stata letta: il totale è parziale.</p>' : ''}<details open class="storage-group"><summary>File e cartelle associati · ${number(s.files.length)}</summary>${s.files.map(f => `<div class="storage-path"><code>${esc(f.path)}</code><small>${f.available ? `${f.directory ? 'Cartella · ' : ''}${esc(bytes(f.bytes))}${f.partial ? ' · parziale' : ''}${f.counted ? '' : ' · già incluso nella cartella superiore'}${f.insideProject ? ' · già nel peso dei file del progetto' : ''}` : 'Percorso registrato · file non presente'}</small></div>`).join('') || '<p class="field-note">Nessun file dedicato individuato; le conversazioni possono essere conservate nei database qui sotto.</p>'}</details><details open class="storage-group"><summary>Database condivisi · ${number(s.stores.length)}</summary>${s.stores.map(store => `<details class="shared-store"><summary><span>${esc(store.path)}</span><small>${esc(bytes(store.databaseBytes))} di contenuto del progetto · ${number(store.rows)} righe</small></summary><p class="field-note">Dimensione fisica dell’intero archivio: ${esc(bytes(store.physicalBytes))}, inclusi WAL e SHM. È condivisa con altri progetti e non viene sommata al peso di questo progetto.</p>${store.physicalFiles.map(f => `<div class="storage-path"><code>${esc(f.path)}</code><small>${esc(bytes(f.bytes))} · condiviso</small></div>`).join('')}<div class="extension-list">${store.tables.map(t => `<span><b>${esc(t.name)}</b> ${number(t.rows)} righe · ${esc(bytes(t.bytes))}</span>`).join('')}</div></details>`).join('') || '<p class="field-note">Nessuna riga associata nei database disponibili.</p>'}</details><details class="storage-group"><summary>Altri riferimenti Codex</summary><div class="storage-path"><code>${esc(s.home)}</code><small>Cartella dati Codex · condivisa</small></div>${s.references.map(r => `<div class="storage-path"><code>${esc(r.path)}</code><small>${esc(r.label)}</small></div>`).join('')}</details>${s.notes.map(note => `<p class="field-note">${esc(note)}</p>`).join('')}</section>`;
}
function gitLabel(git) {
  if (!git) return 'Git in lettura…';
  if (!git.repository) return 'Senza repository Git';
  if (git.unavailable) return 'Git non leggibile';
  return `${git.branch} · ${git.clean ? 'nessuna modifica' : `${number(git.modifiedFiles + git.untrackedFiles)} modifiche`}`;
}
const stat = (label, value, note = '') => `<div><span>${esc(label)}</span><strong>${esc(value)}</strong>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
const row = (label, value) => `<div class="project-info-row"><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;

export function initProjects({ api, toast }) {
  let visible = false, loading = false, snapshot = null, selected = null, conversation = null, nextBefore = null, messagesLoading = false, detailFingerprint = '';
  let detailThreads = [];
  const fingerprint = p => JSON.stringify([p?.disk, p?.git, p?.codexStorage, p?.prompts, p?.firstActivityAt, p?.lastActivityAt]);
  function render() {
    if (!snapshot) return;
    const all = snapshot.projects;
    $('#project-count').textContent = all.length;
    const scanning = snapshot.status === 'scanning';
    $('#refresh-projects').disabled = scanning;
    $('#refresh-projects').textContent = scanning ? '↻ Scansione in corso…' : '↻ Aggiorna progetti';
    $('#projects-status').textContent = scanning ? `Lettura dei dati locali · ${snapshot.completed} di ${snapshot.total || '…'} cartelle analizzate` : snapshot.updatedAt ? `Ultima scansione: ${date(snapshot.updatedAt)}` : 'Dati locali di Codex';
    const warning = [snapshot.error, ...snapshot.warnings].filter(Boolean).join(' ');
    $('#projects-error').hidden = !warning;
    $('#projects-error').textContent = warning;
    const knownDisk = all.filter(p => p.disk?.bytes != null);
    const diskPartial = scanning || knownDisk.length < all.length || all.some(p => p.disk?.partial);
    const promptPartial = all.some(p => p.incompleteHistory);
    $('#projects-overview').innerHTML = stat('PROGETTI COLLEGATI', number(all.length), 'Cartelle locali in Codex') + stat('SPAZIO COMPLESSIVO', (diskPartial ? '≥ ' : '') + bytes(knownDisk.reduce((n, p) => n + p.disk.bytes, 0)), diskPartial ? (scanning ? 'Scansione in corso' : 'Alcuni progetti hanno dati parziali') : 'Somma dei progetti, inclusi Git e dipendenze') + stat('I TUOI PROMPT', (promptPartial ? '≥ ' : '') + number(all.reduce((n, p) => n + (p.prompts || 0), 0)), promptPartial ? 'Parte della cronologia non è disponibile' : 'Messaggi utente registrati') + stat('CONVERSAZIONI', number(all.reduce((n, p) => n + p.conversations, 0)), `${number(all.reduce((n, p) => n + p.subagentConversations, 0))} conversazioni di sottoagenti a parte`);
    const codexPartial = all.some(p => !p.codexStorage || p.codexStorage.partial);
    $('#projects-overview').insertAdjacentHTML('beforeend', stat('DATI CODEX', (codexPartial ? '≥ ≈ ' : '≈ ') + bytes(all.reduce((n, p) => n + (p.codexStorage?.attributedBytes || 0), 0)), 'File dedicati + contenuto nei database'));
    const query = $('#project-search').value.trim().toLocaleLowerCase();
    const projects = all.filter(p => [p.name, ...p.roots].some(s => s.toLocaleLowerCase().includes(query)));
    const order = $('#project-sort').value;
    projects.sort((a, b) => order === 'name' ? a.name.localeCompare(b.name, 'it') : order === 'activity' ? String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')) : order === 'size' ? (b.disk?.bytes ?? -1) - (a.disk?.bytes ?? -1) : order === 'prompts' ? (b.prompts ?? -1) - (a.prompts ?? -1) : 0);
    $('#projects-empty').hidden = !!projects.length || scanning;
    $('#project-list').innerHTML = projects.map(p => `<article class="project-card"><div class="project-card-heading"><div class="project-symbol" aria-hidden="true">▤</div><div><h2>${esc(p.name)}</h2><p class="project-path">${p.roots.map(esc).join('<br>')}</p><div class="card-conversation-paths">${conversationPaths(p).slice(0, 2).map(file => `<p><b>Conversazioni</b><br>${esc(file)}</p>`).join('')}${conversationPaths(p).length > 2 ? `<small>Altri ${conversationPaths(p).length - 2} percorsi nei dettagli</small>` : ''}</div></div><span class="project-tag ${p.disk?.status === 'missing' ? 'missing' : ''}">${p.disk?.status === 'missing' ? 'Cartella non trovata' : p.disk?.partial ? 'Scansione parziale' : p.git?.repository ? 'Git' : 'Locale'}</span></div><div class="project-card-stats has-codex">${stat('FILE PROGETTO', size(p))}${stat('DATI CODEX', codexSize(p))}${stat('PROMPT', countPrompts(p))}${stat('CONVERSAZIONI', number(p.conversations))}</div><dl class="project-dates">${row('Prima attività', date(p.firstActivityAt))}${row('Ultima attività', date(p.lastActivityAt))}</dl><div class="project-card-bottom"><span title="${esc(gitLabel(p.git))}">${esc(gitLabel(p.git))}</span><button class="button secondary" data-project="${esc(p.id)}" aria-label="Dettagli ${esc(p.name)}">Dettagli →</button></div></article>`).join('');
  }
  async function load() {
    if (loading || !visible) return;
    loading = true;
    try {
      snapshot = await api('projects'); render();
      const current = snapshot.projects.find(p => p.id === selected);
      if (current && $('#project-dialog').open && !$('#conversation-dialog').open && fingerprint(current) !== detailFingerprint) await showDetail(selected, false);
    } catch (error) { $('#projects-error').hidden = false; $('#projects-error').textContent = error.message; }
    finally { loading = false; }
  }
  function renderDetail(p) {
    detailThreads = p.threads;
    const disk = p.disk, git = p.git;
    const diskNote = !disk ? 'Scansione della cartella in corso…' : disk.status === 'missing' ? 'La cartella non è disponibile su questo computer.' : disk.partial ? `Dati parziali: limite di scansione o accessi negati (${number(disk.unreadable)}).` : 'Dimensione logica dei file, comprese dipendenze e cartelle nascoste.';
    $('#project-detail').innerHTML = `<h2>${esc(p.name)}</h2><p class="project-path">${p.roots.map(esc).join('<br>')}</p><div class="project-card-stats detail-stats">${stat('SPAZIO', size(p))}${stat('FILE', disk?.bytes == null ? '—' : number(disk.files))}${stat('PROMPT', countPrompts(p))}${stat('CONVERSAZIONI', number(p.conversations))}</div><div class="project-detail-grid"><section><h3>Date e attività</h3><dl>${row('Prima attività', date(p.firstActivityAt))}${row('Ultima attività', date(p.lastActivityAt))}${row('Risposte e aggiornamenti Codex', number(p.replies))}${row('Conversazioni archiviate', number(p.archivedConversations))}${row('Conversazioni dei sottoagenti', number(p.subagentConversations))}${row('Tempo di elaborazione registrato', duration(p.recordedDurationMs))}${row('Token registrati da Codex', p.recordedTokens ? number(p.recordedTokens) : 'Non disponibili')}</dl><p class="field-note">I token sono il contatore locale di Codex, inclusi contesti riletti e cache: non corrispondono alla quota delle 5 ore o settimanale. La prima attività è il primo prompt disponibile; in sua assenza si usa la data iniziale del progetto in Codex.${p.firstActivitySource === 'project' ? ' Per questo progetto è stata usata la data iniziale perché non è disponibile un primo prompt.' : ''}</p></section><section><h3>Spazio sul disco</h3><dl>${row('File del progetto e altri dati', disk?.bytes == null ? '—' : bytes(disk.bytes - disk.gitBytes - disk.generatedBytes))}${row('Dipendenze e output generati', bytes(disk?.generatedBytes))}${row('Cronologia Git (.git)', bytes(disk?.gitBytes))}${row('Cartelle analizzate', disk?.bytes == null ? '—' : number(disk.folders))}${row('Collegamenti non seguiti', number(disk?.skippedLinks))}</dl><p class="field-note">${esc(diskNote)} I collegamenti simbolici e le junction non vengono seguiti. Limite: 250.000 file o 2 minuti per progetto.</p>${disk?.extensions?.length ? `<h4>Tipi di file per spazio</h4><div class="extension-list">${disk.extensions.map(e => `<span><b>${esc(e.extension)}</b> ${esc(bytes(e.bytes))} · ${number(e.files)} file</span>`).join('')}</div>` : ''}</section><section><h3>Repository Git</h3><dl>${row('Stato', gitLabel(git))}${git?.repository && !git.unavailable ? row('File modificati / nuovi', `${number(git.modifiedFiles)} / ${number(git.untrackedFiles)}`) + row('Commit avanti / indietro', `${number(git.ahead)} / ${number(git.behind)}`) + row('Origine', git.remote || 'Non configurata') : ''}</dl><p class="field-note">Confronto con i riferimenti Git già presenti sul PC; nessun fetch, commit o push.</p></section><section><h3>File più grandi</h3>${disk?.largestFiles?.length ? `<dl>${disk.largestFiles.map(f => row(f.path, bytes(f.bytes))).join('')}</dl>` : '<p class="field-note">Nessun dato disponibile.</p>'}</section></div>${storageReport(p)}<div class="section-title"><h3>Conversazioni <span class="muted">${number(p.conversations)}</span></h3><span>Clicca per leggere prompt e risposte</span></div>${p.incompleteHistory ? `<p class="project-partial">Cronologia non disponibile per ${number(p.incompleteHistory)} conversazioni. I conteggi visibili possono essere inferiori al totale reale.</p>` : ''}<div class="thread-list">${p.threads.map(t => `<div class="thread-entry"><button class="thread-row" data-thread="${esc(t.id)}"><span><b>${esc(t.title)}</b><small>${esc(date(t.updatedAt))}${t.model ? ' · ' + esc(t.model) : ''}${t.archived ? ' · Archiviata' : ''}</small></span><span class="thread-count">${number(t.metrics?.prompts)} prompt<small>${number(t.metrics?.replies)} risposte</small></span><span aria-hidden="true">→</span></button><details class="thread-paths"><summary>Percorsi della conversazione</summary>${sourcePaths(t.storage)}</details></div>`).join('') || '<p class="field-note">Non ci sono conversazioni locali associate a questo progetto.</p>'}</div>`;
  }
  async function showDetail(id, open = true) {
    selected = id;
    if (open) { $('#project-detail').textContent = 'Lettura del progetto…'; $('#project-dialog').showModal(); }
    try { const p = await api('projects/' + id); if (selected === id) { renderDetail(p); detailFingerprint = fingerprint(p); } }
    catch (error) { if (selected === id) $('#project-detail').textContent = error.message; }
  }
  async function loadMessages(older = false) {
    if (messagesLoading || !conversation) return;
    const current = conversation;
    messagesLoading = true; $('#older-messages').disabled = true;
    $('#conversation-notice').textContent = 'Lettura della cronologia…';
    try {
      const result = await api(`projects/${current.projectId}/conversations/${current.threadId}${older && nextBefore != null ? '?before=' + nextBefore : ''}`);
      if (conversation !== current) return;
      nextBefore = result.nextBefore;
      const markup = result.messages.map(m => `<article class="chat-message ${m.role === 'user' ? 'user' : 'assistant'}"><div class="chat-meta"><strong>${m.role === 'user' ? 'Tu' : m.phase === 'commentary' ? 'Codex · aggiornamento' : 'Codex'}</strong><time>${esc(date(m.createdAt))}</time></div><div class="chat-text">${esc(m.text)}</div>${m.truncated ? '<small class="muted">Messaggio abbreviato dopo 32.000 caratteri.</small>' : ''}</article>`).join('');
      if (older) $('#conversation-messages').insertAdjacentHTML('afterbegin', markup);
      else $('#conversation-messages').innerHTML = markup;
      $('#conversation-title').textContent = result.title;
      $('#older-messages').hidden = nextBefore == null;
      $('#conversation-notice').textContent = result.unavailable ? 'La cronologia di questa conversazione non è più presente sul computer.' : !result.messages.length && !older ? 'Nessun messaggio leggibile nella cronologia locale.' : nextBefore != null ? 'Sono mostrati gli ultimi messaggi. Puoi caricare quelli precedenti.' : 'Inizio della cronologia disponibile.';
    } catch (error) { if (conversation === current) $('#conversation-notice').textContent = error.message; }
    finally { messagesLoading = false; $('#older-messages').disabled = false; }
  }
  $('#project-search').addEventListener('input', render);
  $('#project-sort').addEventListener('change', render);
  $('#refresh-projects').addEventListener('click', async () => {
    $('#refresh-projects').disabled = true;
    try { snapshot = await api('projects/refresh', {}); render(); }
    catch (error) { toast(error.message); $('#refresh-projects').disabled = false; }
  });
  $('#project-list').addEventListener('click', event => { const button = event.target.closest('[data-project]'); if (button) showDetail(button.dataset.project); });
  $('#close-project').addEventListener('click', () => $('#project-dialog').close());
  $('#project-dialog').addEventListener('close', () => { selected = null; });
  $('#project-detail').addEventListener('click', event => {
    const button = event.target.closest('[data-thread]');
    if (!button || messagesLoading) return;
    conversation = { projectId: selected, threadId: button.dataset.thread };
    $('#conversation-paths').innerHTML = sourcePaths(detailThreads.find(t => t.id === button.dataset.thread)?.storage);
    nextBefore = null; $('#conversation-messages').replaceChildren(); $('#conversation-title').textContent = 'Conversazione'; $('#older-messages').hidden = true;
    $('#conversation-dialog').showModal(); loadMessages();
  });
  $('#close-conversation').addEventListener('click', () => $('#conversation-dialog').close());
  $('#conversation-dialog').addEventListener('close', () => { conversation = null; });
  $('#older-messages').addEventListener('click', () => loadMessages(true));
  setInterval(() => { if (visible && snapshot?.status === 'scanning') load(); }, 1500);
  return { show(value) { visible = value; if (visible) load(); } };
}
