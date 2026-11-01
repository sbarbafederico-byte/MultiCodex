'use strict';
const $ = selector => document.querySelector(selector);
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('token')) {
  sessionStorage.setItem('multicodex-token', fragment.get('token'));
  history.replaceState(null, '', '/');
}
const token = sessionStorage.getItem('multicodex-token') || '';
let state = null, editingId = null, acting = false, lastLoginId = null, lastLoginStatus = null, connected = false, editingDefaultLabel = null;
let settingsDirty = false;
const clientId = sessionStorage.getItem('multicodex-client') || crypto.randomUUID();
sessionStorage.setItem('multicodex-client', clientId);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (seconds, options = {}) => seconds == null ? 'Non disponibile' : new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', ...options }).format(new Date(seconds * 1000));
const formatUpdated = iso => iso ? new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso)) : 'Non ancora aggiornato';
function remainingTime(seconds) {
  if (!seconds) return '';
  const mins = Math.ceil((seconds * 1000 - Date.now()) / 60000);
  if (mins <= 0) return 'in attesa di aggiornamento';
  const days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), minutes = mins % 60;
  return days ? `tra ${days}g ${hours}h` : hours ? `tra ${hours}h ${minutes}m` : `tra ${minutes}m`;
}
async function api(route, data) {
  let response;
  try { response = await fetch('/api/' + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + token, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }); } catch {
    throw new Error('Collegamento con l’hub interrotto. Attendi qualche secondo e riprova; se persiste, riapri MultiCodex dal desktop. I campi inseriti sono ancora qui.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Operazione non riuscita.');
  return result;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
}
function meter(label, value, weekly = false) {
  const percentage = value?.remaining;
  const available = percentage != null;
  const rounded = available ? Math.round(percentage * 10) / 10 : null;
  const color = percentage <= 10 ? 'critical' : percentage <= 30 ? 'low' : weekly ? 'weekly' : '';
  const reset = value?.resetsAt;
  return `<div class="quota"><div class="quota-top"><span class="quota-label">${label}</span><span class="quota-value">${available ? escape(rounded) + '%' : '—'}<small>${available ? 'rimasto' : 'non disponibile'}</small></span></div><div class="meter" role="meter" aria-label="${label}: disponibilità rimasta" ${available ? `aria-valuenow="${percentage}" aria-valuemin="0" aria-valuemax="100"` : 'aria-valuetext="Non disponibile"'}><div class="meter-fill ${color}" data-width="${available ? percentage : 0}"></div></div><div class="quota-reset">${reset ? `Ripristino <time>${escape(date(reset))}</time> · ${escape(remainingTime(reset))}` : 'Ripristino non disponibile'}</div></div>`;
}
function resetsHTML(limits) {
  const resets = limits?.resets;
  if (resets == null) return '<p>Informazioni non disponibili</p>';
  if (resets.count === 0) return '<p>Nessun reset disponibile</p>';
  if (!resets.credits?.length) return '<p>Scadenze non disponibili</p>';
  const rows = resets.credits.filter(c => c.status === 'available' || c.status === 'unknown');
  let text = rows.map((credit, i) => {
    const soon = credit.expiresAt && credit.expiresAt * 1000 - Date.now() < 3 * 86400000;
    return `<p class="${soon ? 'soon' : ''}">Reset ${i + 1} · ${credit.expiresAt ? 'scade ' + escape(date(credit.expiresAt)) : credit.expiryProvided ? 'senza scadenza indicata' : 'scadenza non disponibile'}</p>`;
  }).join('');
  if (!rows.length || (resets.count != null && resets.count > rows.length)) text += '<p>Altre scadenze non disponibili</p>';
  return text;
}
function renderCard(account, disabled) {
  const name = account.label || account.profileDisplayName || account.profileUsername || account.accountName || account.accountEmail || 'Account ChatGPT';
  const initials = (account.profileDisplayName || name).split(/\s+/).slice(0, 2).map(x => x[0] || '').join('').toUpperCase();
  const badge = account.active ? 'ATTIVO IN CODEX' : account.status === 'reauth' ? 'DA RICOLLEGARE' : 'COLLEGATO';
  const extras = (account.limits?.otherWindows || []).map(w => meter(w.minutes == null ? 'Altra finestra' : `Finestra di ${w.minutes} minuti`, w)).join('');
  return `<article class="account-card ${account.active ? 'active' : ''}" data-id="${escape(account.id)}">
    <div class="card-top"><span class="plan">CHATGPT ${escape(account.plan || '')}</span><span class="status-pill ${account.active ? 'active' : ''}">${badge}</span></div>
    <div class="identity"><div class="avatar" aria-hidden="true">${escape(initials || 'C')}</div><div class="identity-text"><h3>${escape(name)}</h3><p class="account-name">Nome profilo: <b>${escape(account.profileDisplayName || 'Non disponibile')}</b></p><p class="account-name">Username: <b>${escape(account.profileUsername ? '@' + account.profileUsername.replace(/^@/, '') : 'Non disponibile')}</b></p><p class="account-name">Nome accesso: ${escape(account.authName || account.accountName || 'Non disponibile')}</p><p class="account-email">Email account: ${escape(account.accountEmail || 'Non disponibile')}</p>${account.personalEmail?.trim() ? `<p class="account-email">Email GamsGo: ${escape(account.personalEmail.trim())}</p>` : ''}${account.profileStatus === 'unavailable' ? '<p class="account-name profile-unavailable">Profilo attuale non aggiornabile; ultimi nomi disponibili.</p>' : ''}</div></div>
    ${account.error ? `<div class="card-error">${escape(account.error)}</div>` : ''}
    <div class="quotas">${meter('Limite delle 5 ore', account.limits?.fiveHour)}${meter('Limite settimanale', account.limits?.weekly, true)}${extras}</div>
    <div class="resets"><div class="resets-head"><span>↺ &nbsp;Banked reset</span><span class="reset-count">${escape(account.limits?.resets?.count ?? '—')}</span></div><div class="reset-dates">${resetsHTML(account.limits)}</div></div>
    <div class="card-bottom"><button class="button primary switch-button ${account.active ? 'current' : ''}" data-action="switch" ${disabled || account.status === 'reauth' ? 'disabled' : ''}>${account.active ? '↗ Apri Codex · account attuale' : 'Usa questo account →'}</button><div class="card-tools"><button data-action="edit" ${disabled ? 'disabled' : ''}>Modifica</button><button data-action="refresh" ${disabled ? 'disabled' : ''}>Aggiorna</button><button data-action="reconnect" ${disabled ? 'disabled' : ''}>Ricollega</button><button class="remove-button" data-action="remove" ${disabled ? 'disabled' : ''}>Rimuovi</button></div></div>
    <div class="updated">${account.status === 'error' || account.status === 'reauth' ? 'Ultimi dati riusciti: ' : 'Aggiornato: '}${escape(formatUpdated(account.updatedAt))}</div>
  </article>`;
}
function banner(element, text, status, action) {
  element.hidden = !text;
  element.className = 'banner' + (status === 'error' || status === 'interrupted' ? ' error' : status === 'success' ? ' success' : '');
  element.replaceChildren();
  if (!text) return;
  const span = document.createElement('span'); span.textContent = text; element.append(span);
  if (action) { const button = document.createElement('button'); button.textContent = action.label; button.addEventListener('click', action.run); element.append(button); }
}
function render() {
  if (!state) return;
  const accounts = state.accounts;
  const disabled = !connected || !!state.busy || state.login?.status === 'pending' || state.switchJob?.status === 'running' || acting;
  $('#account-count').textContent = accounts.length;
  $('#summary-count').textContent = String(accounts.length).padStart(2, '0');
  const active = accounts.find(a => a.active);
  $('#summary-active').textContent = active ? active.label || active.profileDisplayName || active.profileUsername || active.accountName || active.accountEmail : 'Nessuno rilevato';
  const known = accounts.filter(a => a.limits?.resets?.count != null);
  $('#summary-resets').textContent = known.length ? known.reduce((sum, a) => sum + a.limits.resets.count, 0) + (known.length < accounts.length ? ' +' : '') : '—';
  $('#operation-status').textContent = state.busy || (state.login?.status === 'pending' ? 'Accesso in corso' : 'Hub pronto');
  $('#accounts').innerHTML = accounts.map(a => renderCard(a, disabled)).join('');
  document.querySelectorAll('[data-width]').forEach(el => { el.style.width = el.dataset.width + '%'; });
  $('#empty').hidden = !!accounts.length;
  $('#add-account').disabled = disabled;
  $('#refresh-all').disabled = disabled || !accounts.length;
  $('#import-current').disabled = disabled;
  const settings = state.settings || { refreshMode: 'manual', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300 };
  $('#refresh-all span').textContent = settings.refreshMode === 'automatic' ? 'Aggiorna ora' : 'Aggiorna';
  $('#poll-note').textContent = settings.refreshMode === 'automatic' ? `Automatico · attivo ${settings.activeIntervalSeconds}s · altri ${settings.inactiveIntervalSeconds / 60} min · solo con finestra visibile` : 'Modalità manuale · usa i pulsanti Aggiorna';
  if (!settingsDirty) applySettingsForm(settings);
  const flow = state.login;
  banner($('#flow-banner'), flow?.message, flow?.status, flow?.status === 'pending' ? { label: 'Annulla accesso', run: () => act(() => api('login/cancel', {})) } : null);
  const job = state.switchJob;
  banner($('#switch-banner'), job?.message || state.startupWarning, job?.status, job?.status === 'interrupted' || job?.status === 'error' ? { label: 'Ripristina account precedente', run: () => act(() => api('recover', {})) } : null);
  if (flow?.status === 'success' && (lastLoginId !== flow.id || lastLoginStatus !== 'success')) toast(flow.message);
  lastLoginId = flow?.id; lastLoginStatus = flow?.status;
}
function applySettingsForm(settings) {
  document.querySelector(`input[name="refresh-mode"][value="${settings.refreshMode}"]`).checked = true;
  $('#active-interval').value = settings.activeIntervalSeconds;
  $('#inactive-interval').value = settings.inactiveIntervalSeconds / 60;
  $('#refresh-intervals').disabled = settings.refreshMode !== 'automatic';
}
function navigate(page) {
  const settingsPage = page === 'settings';
  $('#accounts-page').hidden = settingsPage;
  $('#settings-page').hidden = !settingsPage;
  $('#nav-accounts').classList.toggle('nav-current', !settingsPage);
  $('#nav-settings').classList.toggle('nav-current', settingsPage);
  $('#nav-accounts').toggleAttribute('aria-current', !settingsPage);
  $('#nav-settings').toggleAttribute('aria-current', settingsPage);
  if (settingsPage) $('#nav-settings').setAttribute('aria-current', 'page');
  else $('#nav-accounts').setAttribute('aria-current', 'page');
  sessionStorage.setItem('multicodex-page', settingsPage ? 'settings' : 'accounts');
}
async function presence() {
  try { await api('presence', { clientId, visible: document.visibilityState === 'visible' }); } catch {}
}
async function load() {
  try {
    state = await api('state');
    connected = true;
    $('#connection-error').hidden = !state.notice;
    $('#connection-error').textContent = state.notice || '';
    render();
  } catch (error) {
    connected = false;
    render();
    $('#connection-error').hidden = false;
    $('#connection-error').textContent = error.message || 'Hub non raggiungibile. Riaprilo dal collegamento sul desktop.';
    $('#operation-status').textContent = 'Riconnessione all’hub…';
  }
}
async function act(action) {
  if (acting) return;
  acting = true; render();
  try { await action(); } catch (error) { toast(error.message); }
  finally { acting = false; await load(); }
}
function openAccountDialog(account = null) {
  editingId = account?.id || null;
  editingDefaultLabel = account && !account.label ? account.profileDisplayName || '' : null;
  $('#dialog-eyebrow').textContent = account ? 'INFORMAZIONI PERSONALI' : 'NUOVO ACCESSO';
  $('#dialog-title').textContent = account ? 'Modifica account' : 'Aggiungi un account';
  $('#dialog-description').textContent = account ? `Account ChatGPT: ${account.accountEmail || account.accountName || 'collegato'}. Nome ed email dell’account restano quelli forniti da ChatGPT.` : 'Si aprirà una finestra browser separata. Accedi lì con l’account da aggiungere.';
  $('#account-label').value = account?.label || account?.profileDisplayName || '';
  $('#personal-email').value = account?.personalEmail || '';
  $('#save-account').textContent = account ? 'Salva modifiche' : 'Apri accesso';
  $('#dialog-error').textContent = '';
  $('#account-dialog').showModal();
}
$('#add-account').addEventListener('click', () => openAccountDialog());
$('#nav-accounts').addEventListener('click', () => navigate('accounts'));
$('#nav-settings').addEventListener('click', () => navigate('settings'));
$('#settings-form').addEventListener('input', () => {
  settingsDirty = true;
  $('#settings-save-state').textContent = 'Modifiche da salvare';
  $('#refresh-intervals').disabled = document.querySelector('input[name="refresh-mode"]:checked').value !== 'automatic';
});
$('#settings-defaults').addEventListener('click', () => {
  applySettingsForm({ refreshMode: 'manual', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300 });
  settingsDirty = true;
  $('#settings-save-state').textContent = 'Valori iniziali ripristinati · premi Salva';
});
$('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (acting) return;
  acting = true;
  $('#save-settings').disabled = true;
  $('#settings-error').textContent = '';
  try {
    const settings = {
      refreshMode: document.querySelector('input[name="refresh-mode"]:checked').value,
      activeIntervalSeconds: Number($('#active-interval').value),
      inactiveIntervalSeconds: Number($('#inactive-interval').value) * 60,
    };
    await api('settings', settings);
    settingsDirty = false;
    $('#settings-save-state').textContent = 'Impostazioni salvate';
    await presence();
    toast('Impostazioni salvate.');
  } catch (error) { $('#settings-error').textContent = error.message; }
  finally { acting = false; $('#save-settings').disabled = false; await load(); }
});
$('#refresh-all').addEventListener('click', () => act(() => api('refresh', {})));
$('#import-current').addEventListener('click', () => act(async () => { await api('import', {}); await api('refresh', {}); }));
$('#close-dialog').addEventListener('click', () => $('#account-dialog').close());
$('#cancel-dialog').addEventListener('click', () => $('#account-dialog').close());
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
$('#account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (acting) return;
  acting = true;
  $('#save-account').disabled = true;
  $('#dialog-error').textContent = '';
  try {
    const enteredLabel = $('#account-label').value.trim();
    const info = { label: editingDefaultLabel !== null && enteredLabel === editingDefaultLabel ? '' : enteredLabel, personalEmail: $('#personal-email').value };
    await api(editingId ? 'account/edit' : 'login', editingId ? { id: editingId, ...info } : info);
    $('#account-dialog').close();
    if (editingId) toast('Informazioni salvate.');
  } catch (error) { $('#dialog-error').textContent = error.message; }
  finally { acting = false; $('#save-account').disabled = false; await load(); }
});
$('#accounts').addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const id = button.closest('[data-id]').dataset.id;
  const account = state.accounts.find(a => a.id === id);
  if (!account) return;
  switch (button.dataset.action) {
    case 'edit': openAccountDialog(account); break;
    case 'refresh': act(() => api('refresh', { id })); break;
    case 'switch': act(() => api('switch', { id })); break;
    case 'reconnect': act(() => api('login', { targetId: id })); break;
    case 'remove':
      if (confirm(`Rimuovere ${account.label || account.accountEmail || account.accountName} dall’hub? L’account ChatGPT e i file del progetto restano sul computer.`)) act(() => api('account/remove', { id }));
      break;
  }
});
navigate(sessionStorage.getItem('multicodex-page'));
await load();
await presence();
document.addEventListener('visibilitychange', presence);
window.addEventListener('pagehide', () => {
  fetch('/api/presence', { method: 'POST', keepalive: true, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, visible: false }) }).catch(() => {});
});
setInterval(presence, 10000);
setInterval(load, 3000);
