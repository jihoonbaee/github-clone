// Entrypoint: bind a port, register it with the trial environment, and serve
// until the environment says the trial is done.
//
// With MAKEFUN_ENV_URL set (a trial): bind port 0, POST {"port": N} to
// $MAKEFUN_ENV_URL/register, then poll GET $MAKEFUN_ENV_URL/done until it
// answers {"done": true}, and exit 0.
// Without it (local development): listen on $PORT (default 8080) and serve
// until killed.

import { createForgeServer, createStore, listen } from './app.ts';

const REGISTER_ATTEMPTS = 20;
const REGISTER_INTERVAL_MS = 250;
const DONE_POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.ok) return;
      lastError = new Error(`register answered HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(REGISTER_INTERVAL_MS);
  }
  throw new Error(
    `could not register with ${envUrl}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The environment may be briefly unreachable; keep polling.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  const store = createStore();
  const server = createForgeServer(store);
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== '') {
    const port = await listen(server, 0);
    await register(envUrl, port);
    await waitForDone(envUrl);
    server.close();
    return;
  }
  const port = Number(process.env.PORT ?? 8080);
  const bound = await listen(server, Number.isFinite(port) ? port : 8080);
  console.log(`forge listening on http://127.0.0.1:${bound}`);
  // Serve until the process is killed.
  await new Promise<void>(() => {});
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
