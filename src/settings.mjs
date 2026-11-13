export const DEFAULT_SETTINGS = Object.freeze({ refreshMode: 'manual', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300, switchMode: 'manual', switchStrategy: 'fiveHour', accountOrder: Object.freeze([]) });

export function validateSettings(value) {
  if (!value || !['manual', 'automatic'].includes(value.refreshMode)) throw new Error('Scegli aggiornamento manuale o automatico.');
  for (const field of ['activeIntervalSeconds', 'inactiveIntervalSeconds']) {
    if (!Number.isInteger(value[field]) || value[field] < 10 || value[field] > 86400) throw new Error('Gli intervalli devono essere compresi tra 10 secondi e 24 ore.');
  }
  const { switchMode = 'manual', switchStrategy = 'fiveHour', accountOrder = [] } = value;
  if (!['manual', 'automatic'].includes(switchMode)) throw new Error('Scegli cambio manuale o automatico.');
  if (!['fiveHour', 'weekly', 'ordered', 'custom'].includes(switchStrategy)) throw new Error('Criterio di cambio non valido.');
  if (!Array.isArray(accountOrder) || accountOrder.some(id => typeof id !== 'string' || id.length > 80) || new Set(accountOrder).size !== accountOrder.length) throw new Error('Ordine account non valido.');
  return { refreshMode: value.refreshMode, activeIntervalSeconds: value.activeIntervalSeconds, inactiveIntervalSeconds: value.inactiveIntervalSeconds, switchMode, switchStrategy, accountOrder: [...accountOrder] };
}

export function accountDue(account, activeKey, settings, now) {
  if (account.status === 'reauth') return false;
  const interval = (account.key === activeKey ? settings.activeIntervalSeconds : settings.inactiveIntervalSeconds) * 1000;
  const timestamps = [account.updatedAt, account.lastAttemptAt].map(v => Date.parse(v)).filter(Number.isFinite);
  const last = timestamps.length ? Math.max(...timestamps) : 0;
  return now >= Math.max(last + interval, account.retryAfterAt || 0);
}

export class Presence {
  constructor(leaseMs = 20000) { this.clients = new Map(); this.leaseMs = leaseMs; }
  update(id, visible, now = Date.now()) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(id) || typeof visible !== 'boolean') throw new Error('Presenza finestra non valida.');
    if (visible) this.clients.set(id, now);
    else this.clients.delete(id);
    this.visible(now);
  }
  visible(now = Date.now()) {
    for (const [id, last] of this.clients) if (now - last >= this.leaseMs) this.clients.delete(id);
    return this.clients.size > 0;
  }
}
