/** Initialize the current Persona's prefix through the public console API after a launch. */
export async function refreshStartupPrefix(baseUrl, { timeoutMs = 180000, pollMs = 500, transport = fetch } = {}) {
  const url = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Startup prefix initialization requires a loopback console URL');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let ready = false;
    try {
      const response = await transport(new URL('/api/runs', url), { signal: AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now()))) });
      ready = response.ok && typeof (await response.json()).current === 'string';
    } catch { /* The CLI may still be loading. */ }
    if (ready) {
      const response = await transport(new URL('/api/session/reload-prefix', url), { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
      if (!response.ok || !(await response.json()).ok) throw new Error('Startup prefix initialization was not confirmed');
      return { refreshed: true };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error('Startup prefix initialization timed out');
}
