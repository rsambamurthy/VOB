/** After rotating ENCRYPTION_KEY (old key in ENCRYPTION_KEY_PREVIOUS): re-encrypt everything with the new key. Run: npm run db:reencrypt */
import { pool } from '../lib/db.js';
import { sealExistingData } from './dataMigrations.js';

const n = await sealExistingData(true);
console.log(`Re-encrypted ${n} record(s) with the current ENCRYPTION_KEY. You can now remove ENCRYPTION_KEY_PREVIOUS.`);
await pool.end();
