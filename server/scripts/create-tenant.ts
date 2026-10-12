/**
 * Provision a new customer workspace and invite its first administrator.
 *   npm run tenant:create -- --slug acme --name "Acme Ltd" --admin-name "Anita Rao" --admin-email anita@acme.com
 */
import { parseArgs } from 'node:util';
import { createTenant } from '../src/services/tenants.js';
import { pool } from '../src/lib/db.js';

const { values } = parseArgs({ options: { slug: { type: 'string' }, name: { type: 'string' }, 'admin-name': { type: 'string' }, 'admin-email': { type: 'string' }, color: { type: 'string' }, product: { type: 'string' } } });
if (!values.slug || !values.name || !values['admin-name'] || !values['admin-email']) {
  console.error('Usage: npm run tenant:create -- --slug <id> --name "<Company>" --admin-name "<Name>" --admin-email <email> [--color #6d1a73] [--product "VendorGate"]');
  process.exit(1);
}
try {
  const r = await createTenant({ slug: values.slug, name: values.name, adminName: values['admin-name'], adminEmail: values['admin-email'],
    branding: { primaryColor: values.color, productName: values.product } });
  console.log(`\nWorkspace "${r.tenant.slug}" created (${r.roles.length} default roles).`);
  console.log(`Invitation for ${r.admin.email}:\n  ${r.inviteLink}\n`);
} catch (e: any) {
  console.error(`Failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
