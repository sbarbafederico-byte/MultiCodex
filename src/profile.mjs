function text(value) { return typeof value === 'string' ? value.trim().slice(0, 254) : ''; }

export function normalizeProfile(result) {
  const profile = result?.profile || result?.profile_details;
  if (!profile || (!Object.hasOwn(profile, 'display_name') && !Object.hasOwn(profile, 'username'))) return null;
  return { profileDisplayName: text(profile.display_name), profileUsername: text(profile.username) };
}

export async function readAccountProfile(auth, fetcher = fetch) {
  // Optional read of the same first-party profile used by the installed Codex client.
  // An unavailable profile must never turn a successful quota read into an auth error.
  try {
    const response = await fetcher('https://chatgpt.com/backend-api/wham/profiles/me', {
      headers: { Authorization: 'Bearer ' + auth.tokens.access_token, 'ChatGPT-Account-ID': auth.tokens.account_id },
      redirect: 'error', signal: AbortSignal.timeout(6000),
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
    return normalizeProfile(await response.json());
  } catch { return null; }
}
