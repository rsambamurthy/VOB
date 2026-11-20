// Lists every API route (method + full path) from the Express app.
import { createApp } from '../../server/src/app.js';
const app: any = await (createApp as any)();
const out: string[] = [];
function walk(stack: any[], prefix: string) {
  for (const l of stack) {
    if (l.route) { for (const m of Object.keys(l.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${l.route.path}`); }
    else if (l.name === 'router' && l.handle?.stack) {
      const src = l.regexp?.source ?? '';
      const p = src.replace('^\\', '').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/').replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ':param').replace(/\$$/, '').replace(/^\^/, '');
      walk(l.handle.stack, prefix + (p === '/' ? '' : p));
    }
  }
}
walk(app._router.stack, '');
console.log(JSON.stringify([...new Set(out)]));
process.exit(0);
