/**
 * Per-tenant onboarding configuration: published version (cached), editable draft,
 * publish with validation, version history and restore.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../lib/db.js';
import { HttpError } from '../lib/http.js';
import { DEFAULT_HOME, packFor } from '../countries/registry.js';
import { configSchema, findIssues, allFieldIds, type OnboardingConfig } from '../config/types.js';

const { tenantConfigs, roles } = schema;

// Short TTL so several API instances pick up a publish within a minute.
const TTL_MS = 60_000;
const cache = new Map<string, { version: number; config: OnboardingConfig; at: number }>();
const clone = <T>(x: T): T => structuredClone(x);

/** Starting template for a workspace in this home country (from its country pack). */
export function templateFor(country?: string | null): OnboardingConfig {
  const make = packFor(country ?? DEFAULT_HOME).template ?? packFor(DEFAULT_HOME).template!;
  return make();
}

/** Called when a workspace is created. */
export async function seedInitialConfig(tenantId: string, config: OnboardingConfig = templateFor(DEFAULT_HOME), userId?: string) {
  await db.insert(tenantConfigs).values({ tenantId, version: 1, status: 'PUBLISHED', config: clone(config), note: 'Initial template', publishedAt: new Date(), publishedById: userId ?? null, updatedById: userId ?? null });
}

export async function getPublished(tenantId: string): Promise<{ version: number; config: OnboardingConfig }> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return { version: hit.version, config: hit.config };
  const row = await db.query.tenantConfigs.findFirst({ where: and(eq(tenantConfigs.tenantId, tenantId), eq(tenantConfigs.status, 'PUBLISHED')) });
  if (!row) throw new HttpError(500, 'This workspace has no published onboarding configuration');
  cache.set(tenantId, { version: row.version, config: row.config, at: Date.now() });
  return { version: row.version, config: row.config };
}

export const getConfig = async (tenantId: string) => (await getPublished(tenantId)).config;

export function invalidate(tenantId: string) { cache.delete(tenantId); }

async function roleKeys(tenantId: string) {
  return (await db.select({ key: roles.key }).from(roles).where(eq(roles.tenantId, tenantId))).map((r) => r.key);
}

export async function getDraft(tenantId: string) {
  return db.query.tenantConfigs.findFirst({ where: and(eq(tenantConfigs.tenantId, tenantId), eq(tenantConfigs.status, 'DRAFT')) });
}

export async function editorState(tenantId: string) {
  const [published, draft, keys] = await Promise.all([getPublished(tenantId), getDraft(tenantId), roleKeys(tenantId)]);
  const versions = await db.select({ id: tenantConfigs.id, version: tenantConfigs.version, status: tenantConfigs.status, note: tenantConfigs.note, publishedAt: tenantConfigs.publishedAt, updatedAt: tenantConfigs.updatedAt })
    .from(tenantConfigs).where(eq(tenantConfigs.tenantId, tenantId)).orderBy(desc(tenantConfigs.version));
  return {
    published,
    draft: draft ? { version: draft.version, config: draft.config, updatedAt: draft.updatedAt, issues: findIssues(draft.config, keys) } : null,
    versions,
  };
}

/** Saves (creating if needed) the draft. Structure must be valid; reference problems are returned as issues. */
export async function saveDraft(tenantId: string, raw: unknown, userId: string) {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new HttpError(400, `${i.path.join(' › ')}: ${i.message}`, parsed.error.issues);
  }
  const config = parsed.data as OnboardingConfig;
  const draft = await getDraft(tenantId);
  if (draft) {
    await db.update(tenantConfigs).set({ config, updatedById: userId }).where(eq(tenantConfigs.id, draft.id));
  } else {
    const { version } = await getPublished(tenantId);
    const [{ max }] = await db.select({ max: tenantConfigs.version }).from(tenantConfigs).where(eq(tenantConfigs.tenantId, tenantId)).orderBy(desc(tenantConfigs.version)).limit(1);
    await db.insert(tenantConfigs).values({ tenantId, version: Math.max(version, max) + 1, status: 'DRAFT', config, updatedById: userId });
  }
  return findIssues(config, await roleKeys(tenantId));
}

export async function discardDraft(tenantId: string) {
  await db.delete(tenantConfigs).where(and(eq(tenantConfigs.tenantId, tenantId), eq(tenantConfigs.status, 'DRAFT')));
}

export interface ConfigDiff { fieldsAdded: string[]; fieldsRemoved: string[]; documentsAdded: string[]; documentsRemoved: string[]; levels: { before: string[]; after: string[] } }

export function diffConfigs(a: OnboardingConfig, b: OnboardingConfig): ConfigDiff {
  const fa = new Set(allFieldIds(a)), fb = new Set(allFieldIds(b));
  const da = new Set(a.documents.map((d) => d.type)), dbs = new Set(b.documents.map((d) => d.type));
  return {
    fieldsAdded: [...fb].filter((x) => !fa.has(x)),
    fieldsRemoved: [...fa].filter((x) => !fb.has(x)),
    documentsAdded: [...dbs].filter((x) => !da.has(x)),
    documentsRemoved: [...da].filter((x) => !dbs.has(x)),
    levels: { before: a.workflow.levels.map((l) => l.label), after: b.workflow.levels.map((l) => l.label) },
  };
}

export async function publishDraft(tenantId: string, userId: string, note?: string) {
  const draft = await getDraft(tenantId);
  if (!draft) throw new HttpError(409, 'There is no draft to publish');
  const issues = findIssues(draft.config, await roleKeys(tenantId));
  if (issues.length) throw new HttpError(422, `Fix ${issues.length} problem${issues.length > 1 ? 's' : ''} before publishing`, issues);
  const prev = await getPublished(tenantId);
  await db.transaction(async (tx) => {
    await tx.update(tenantConfigs).set({ status: 'ARCHIVED' }).where(and(eq(tenantConfigs.tenantId, tenantId), eq(tenantConfigs.status, 'PUBLISHED')));
    await tx.update(tenantConfigs).set({ status: 'PUBLISHED', publishedAt: new Date(), publishedById: userId, note: note?.slice(0, 300) || null }).where(eq(tenantConfigs.id, draft.id));
  });
  invalidate(tenantId);
  return { version: draft.version, diff: diffConfigs(prev.config, draft.config) };
}

export async function getVersion(tenantId: string, version: number) {
  const row = await db.query.tenantConfigs.findFirst({ where: and(eq(tenantConfigs.tenantId, tenantId), eq(tenantConfigs.version, version)) });
  if (!row) throw new HttpError(404, 'Version not found');
  return row;
}

/** Copies an older version into the draft (replacing any existing draft). */
export async function restoreToDraft(tenantId: string, version: number, userId: string) {
  const row = await getVersion(tenantId, version);
  const draft = await getDraft(tenantId);
  if (draft) await db.delete(tenantConfigs).where(eq(tenantConfigs.id, draft.id));
  return saveDraft(tenantId, row.config, userId);
}

/** Roles referenced by the published workflow — used to stop deleting a role that's in use. */
export async function rolesInUse(tenantId: string) {
  const rows = await db.select({ config: tenantConfigs.config }).from(tenantConfigs).where(and(eq(tenantConfigs.tenantId, tenantId), inArray(tenantConfigs.status, ['PUBLISHED', 'DRAFT'])));
  return new Set(rows.flatMap((r) => r.config.workflow.levels.map((l) => l.roleKey)));
}
