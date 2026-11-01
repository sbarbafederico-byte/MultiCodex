import test from 'node:test';
import assert from 'node:assert/strict';
import { accountDue, Presence, DEFAULT_SETTINGS } from '../src/settings.mjs';
import { normalizeProfile, readAccountProfile } from '../src/profile.mjs';

test('window presence expires after a closed or unresponsive client stops sending heartbeats', () => {
  const presence = new Presence(20000);
  presence.update('window-one', true, 1000);
  assert.equal(presence.visible(20999), true);
  assert.equal(presence.visible(21000), false);
});
test('hiding one window leaves automatic updates enabled if another is still visible', () => {
  const presence = new Presence();
  presence.update('window-one', true, 1000);
  presence.update('window-two', true, 1000);
  presence.update('window-one', false, 2000);
  assert.equal(presence.visible(2000), true);
  presence.update('window-two', false, 2000);
  assert.equal(presence.visible(2000), false);
});
test('failed refreshes honor retry delay and expired logins wait for user reconnection', () => {
  const now = Date.now();
  assert.equal(accountDue({ key: 'one', retryAfterAt: now + 30000 }, 'one', DEFAULT_SETTINGS, now), false);
  assert.equal(accountDue({ key: 'one', status: 'reauth' }, 'one', DEFAULT_SETTINGS, now), false);
});
test('only profile names are selected from the remote profile response', () => {
  assert.deepEqual(normalizeProfile({ profile: { username: ' ale89089 ', display_name: ' Ale ', profile_picture_url: 'private' }, stats: { private: true } }), { profileDisplayName: 'Ale', profileUsername: 'ale89089' });
  assert.equal(normalizeProfile({ name: 'OAuth identity' }), null);
});
test('profile requests do not follow redirects and denied profiles remain optional', async () => {
  const auth = { tokens: { access_token: 'test-token', account_id: 'test-account' } };
  const result = await readAccountProfile(auth, async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/wham/profiles/me');
    assert.equal(options.redirect, 'error');
    return { ok: false };
  });
  assert.equal(result, null);
});
