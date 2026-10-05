/**
 * Bootstrap: prints plain progress lines (independent of the logger) so a failed or slow
 * start-up is always visible, then loads the real server from main.ts.
 */
const started = Date.now();
console.log(`[startup] API starting (Node ${process.version}, ${process.platform})…`);
const slow = setTimeout(() => console.log('[startup] still loading after 20 s — if this doesn’t finish, press Ctrl+C and run:  cd server  then  npx tsx src/index.ts  and send the output'), 20_000);
try {
  await import('./main.js');
  console.log(`[startup] modules loaded in ${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error('\n[startup] API FAILED TO START:\n', err, '\n');
  const msg = String((err as Error)?.message ?? err);
  if (/Cannot find (package|module)/.test(msg)) console.error('[startup] Fix: run  npm install  in the main project folder, then  npm run dev  again.\n');
  if (/Configuration error|ENCRYPTION_KEY|DEV_SHOW_OTP/.test(msg)) console.error('[startup] Fix: correct the setting named above in server\\.env, then start again.\n');
  process.exit(1);
} finally {
  clearTimeout(slow);
}
export {};
