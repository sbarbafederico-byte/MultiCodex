import { createHash } from 'node:crypto';

export function decodeClaims(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

// Token claims are display metadata, never used as proof of authentication.
export function identityFromAuth(auth) {
  const tokens = auth?.tokens;
  if (!tokens?.access_token || !tokens?.account_id) throw new Error('Accesso ChatGPT non presente.');
  const id = decodeClaims(tokens.id_token || '');
  const access = decodeClaims(tokens.access_token);
  const profile = access['https://api.openai.com/profile'] || {};
  const account = access['https://api.openai.com/auth'] || id['https://api.openai.com/auth'] || {};
  const subject = id.sub || account.chatgpt_user_id || profile.email || id.email;
  if (!subject) throw new Error('Impossibile identificare questo account ChatGPT.');
  const key = createHash('sha256').update(subject + ':' + tokens.account_id).digest('hex');
  return {
    key, accountId: tokens.account_id,
    accountName: typeof id.name === 'string' ? id.name : (typeof profile.name === 'string' ? profile.name : ''),
    authName: typeof id.name === 'string' ? id.name : (typeof profile.name === 'string' ? profile.name : ''),
    accountEmail: typeof id.email === 'string' ? id.email : (typeof profile.email === 'string' ? profile.email : ''),
    plan: account.chatgpt_plan_type || 'unknown',
  };
}

export function normalizeWindow(window) {
  if (!window) return null;
  const used = window.usedPercent;
  return {
    remaining: Number.isFinite(used) ? Math.max(0, Math.min(100, 100 - used)) : null,
    minutes: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
  };
}

export function normalizeLimits(result) {
  const buckets = result?.rateLimitsByLimitId || {};
  const selected = buckets.codex || result?.rateLimits || Object.values(buckets)[0] || {};
  const windows = [selected.primary, selected.secondary].filter(Boolean);
  // Labels follow server durations; never assume primary means 5h.
  const fiveHour = windows.find(w => w.windowDurationMins === 300);
  const weekly = windows.find(w => w.windowDurationMins === 10080);
  const resets = result?.rateLimitResetCredits;
  return {
    fiveHour: normalizeWindow(fiveHour),
    weekly: normalizeWindow(weekly),
    otherWindows: windows.filter(w => w !== fiveHour && w !== weekly).map(normalizeWindow),
    resets: resets == null ? null : {
      count: Number.isFinite(resets.availableCount) ? resets.availableCount : null,
      credits: Array.isArray(resets.credits) ? resets.credits.map(c => ({
        status: c.status, expiresAt: c.expiresAt ?? null,
        expiryProvided: Object.hasOwn(c, 'expiresAt'), grantedAt: c.grantedAt ?? null,
      })) : null,
    },
    plan: selected.planType || null,
  };
}

export function classifyError(error) {
  if (error.code === 'SESSION_SAVE_FAILED') return { status: 'error', message: 'Salvataggio locale della sessione non riuscito. Riprova; non occorre ricollegare l’account.' };
  if (error.windowsAction) return { status: 'error', message: error.message };
  if (error.code === 'CODEX_ENGINE_START_FAILED' || error.code === 'CODEX_ENGINE_CLOSED') return { status: 'error', message: 'Motore Codex non disponibile. Riprova Aggiorna; se persiste, riapri MultiCodex.' };
  if (error.code === 'CODEX_RPC_TIMEOUT') return { status: 'error', message: 'Il motore Codex non ha risposto in tempo durante la lettura dei limiti. Riprova Aggiorna.' };
  const message = (error.upstream || error.message || '').toLowerCase();
  if (/\b401\b|unauthori|token.*(?:expired|revoked|reused)|refresh_token_(?:expired|reused|invalid)|invalid_grant|sign.?in|authentication (?:failed|required)|not logged/.test(message)) {
    return { status: 'reauth', message: 'Accesso da rinnovare. Usa «Ricollega» per accedere di nuovo.' };
  }
  if (/429|rate.?limit/.test(message)) return { status: 'error', message: 'Troppe richieste. Attendi e riprova.' };
  return { status: 'error', message: 'Impossibile aggiornare i dati. Controlla la connessione e riprova.' };
}
