const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = value => value ? new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : 'Non disponibile';
function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60;
  return h ? `${h}h ${m}m ${s % 60}s` : `${m}m ${s % 60}s`;
}
const delta = value => value == null ? 'Non misurabile' : '+' + Number(value).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' p.p.';
function turnCard(t, active = false) {
  const elapsedValue = active ? Date.now() - Date.parse(t.startedAt) : t.durationMs ?? (Date.parse(t.completedAt) - Date.parse(t.startedAt));
  const replies = t.messages.map(m => `<div class="home-reply"><strong>${m.phase === 'commentary' ? 'Avanzamento Codex' : 'Risposta Codex'}</strong><time>${esc(date(m.createdAt))}</time><div>${esc(m.text)}</div></div>`).join('');
  return `<article class="home-turn ${active ? 'running' : ''}" data-turn="${esc(t.id)}"><div class="home-turn-top"><span class="home-project">▤ ${esc(t.project.name)}</span><span class="home-status ${active ? 'live' : ''}">${active ? '● IN CORSO' : t.status === 'completed' ? 'CONCLUSO' : t.status === 'unconfirmed' ? 'DA VERIFICARE' : t.status === 'failed' ? 'ERRORE' : 'INTERROTTO'}</span></div><div class="home-prompt">${esc(t.prompt)}</div><div class="home-turn-meta"><span>Avviato ${esc(date(t.startedAt))}</span><span ${active ? `data-elapsed="${esc(t.startedAt)}"` : ''}>${Number.isFinite(elapsedValue) ? esc(elapsed(elapsedValue)) : 'Durata non disponibile'}</span><span>${esc(t.title)}</span></div><div class="home-usage"><div><span>Limite 5 ore · variazione osservata</span><b>${esc(delta(t.usage.fiveHour))}</b></div><div><span>Limite settimanale · variazione osservata</span><b>${esc(delta(t.usage.weekly))}</b></div><small>${t.usage.from ? `Campioni: ${esc(date(t.usage.from))} → ${esc(date(t.usage.to))}` : 'In attesa di almeno due campioni dei limiti nella sessione.'}</small></div><details data-replies="${esc(t.id)}" ${active ? 'open' : ''}><summary>${active ? 'Avanzamento e risposte in corso' : 'Mostra risposte e avanzamento'} · ${t.messages.length}</summary><div class="home-replies">${replies || '<p class="field-note">Nessun aggiornamento pubblico ancora salvato da Codex.</p>'}</div></details></article>`;
}
export function initHome({ api, refreshLimits, meter }) {
  let visible = false, loading = false, latest = null, rendered = '', accountRendered = '';
  function render(data) {
    latest = data;
    const error = [data.error, ...data.warnings].filter(Boolean).join(' ');
    $('#home-error').hidden = !error; $('#home-error').textContent = error;
    $('#home-updated').textContent = data.updatedAt ? `Attività locale aggiornata: ${date(data.updatedAt)} · lettura automatica` : 'Lettura dell’attività locale…';
    const content = JSON.stringify([!!data.updatedAt, data.error, data.active, data.recent, data.uncertain]);
    if (content === rendered) return;
    rendered = content;
    const open = new Map([...document.querySelectorAll('[data-replies]')].map(d => [d.dataset.replies, d.open]));
    const scroll = new Map([...document.querySelectorAll('[data-replies]')].map(d => { const el = d.querySelector('.home-replies'); return [d.dataset.replies, { top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 30 }]; }));
    $('#home-active-count').textContent = data.active.length;
    $('#home-active').innerHTML = data.active.map(t => turnCard(t, true)).join('') || `<div class="home-empty">${data.updatedAt ? 'Nessun prompt in corso rilevato.' : 'Ricerca dei prompt in corso…'}</div>`;
    $('#home-recent').innerHTML = data.recent.map(t => turnCard(t)).join('') || '<div class="home-empty">Nessun prompt concluso disponibile nella cronologia locale.</div>';
    $('#home-uncertain').hidden = !data.uncertain.length;
    $('#home-uncertain-list').innerHTML = data.uncertain.map(t => turnCard(t)).join('');
    for (const d of document.querySelectorAll('[data-replies]')) if (open.has(d.dataset.replies)) d.open = open.get(d.dataset.replies);
    for (const d of document.querySelectorAll('[data-replies]')) { const previous = scroll.get(d.dataset.replies), el = d.querySelector('.home-replies'); el.scrollTop = !previous || previous.bottom ? el.scrollHeight : previous.top; }
  }
  async function load() {
    if (!visible || loading || document.visibilityState !== 'visible') return;
    loading = true;
    try { render(await api('dashboard')); }
    catch (error) { $('#home-error').hidden = false; $('#home-error').textContent = error.message; }
    finally { loading = false; }
  }
  function updateAccounts(state, connected) {
    $('#home-refresh-limits').disabled = !connected || !!state.busy || state.login?.status === 'pending' || state.switchJob?.status === 'running';
    const value = JSON.stringify(state.accounts);
    if (value === accountRendered) return;
    accountRendered = value;
    $('#home-accounts').innerHTML = state.accounts.map(a => `<article class="home-account ${a.active ? 'active' : ''}"><div><strong>${esc(a.label || a.profileDisplayName || a.profileUsername || a.accountName || 'Account ChatGPT')}</strong><span class="home-status ${a.active ? 'live' : ''}">${a.active ? 'ATTIVO IN CODEX' : 'INATTIVO'}</span></div><div class="home-account-quotas">${meter('Limite delle 5 ore', a.limits?.fiveHour)}${meter('Limite settimanale', a.limits?.weekly, true)}</div><small>Limiti aggiornati: ${esc(date(a.updatedAt))}${a.error ? ' · ' + esc(a.error) : ''}</small></article>`).join('') || '<div class="home-empty">Aggiungi un account dalla sezione Account.</div>';
  }
  $('#home-refresh-limits').addEventListener('click', refreshLimits);
  setInterval(load, 2000);
  setInterval(() => { if (visible) for (const el of document.querySelectorAll('[data-elapsed]')) el.textContent = elapsed(Date.now() - Date.parse(el.dataset.elapsed)); }, 1000);
  document.addEventListener('visibilitychange', () => { if (visible) load(); });
  return { show(value) { visible = value; if (visible) load(); }, updateAccounts };
}
