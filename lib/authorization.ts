/**
 * Private object lookups share one ownership boundary. The owner must come
 * from the verified application session (or the authenticated task runner),
 * never a request body, URL parameter, email, or caller-supplied header.
 *
 * Keep every query literal: resource/table names cannot become SQL input.
 * Missing and foreign objects both return null, before object storage or any
 * provider is contacted. Mutations must still include their own user_id
 * predicate, so a lookup is never a substitute for authorization at write time.
 */
const OWNED_QUERIES = Object.freeze({
  conversation: 'SELECT * FROM conversations WHERE id=? AND user_id=?',
  file: 'SELECT * FROM files WHERE id=? AND user_id=?',
  share: 'SELECT id FROM public_shares WHERE id=? AND user_id=?',
  media: 'SELECT * FROM media_assets WHERE id=? AND user_id=?',
  reference: "SELECT * FROM media_assets WHERE id=? AND user_id=? AND kind='reference'",
  browser: 'SELECT id,url,title,content,created_at FROM browser_sessions WHERE id=? AND user_id=?',
  task: 'SELECT * FROM scheduled_tasks WHERE id=? AND user_id=?',
  artifact: 'SELECT id,object_key,name,size FROM work_artifacts WHERE id=? AND user_id=?',
});

export type OwnedResource = keyof typeof OWNED_QUERIES;

export async function findOwnedResource<Row = Record<string, unknown>>(
  sql: D1Database, resource: OwnedResource, id: string, owner: string,
): Promise<Row | null> {
  // Fail closed if a future caller accidentally omits its authenticated owner.
  // Runtime validation also protects direct JS callers of this TS module.
  if (typeof owner !== 'string' || !owner.trim() || typeof id !== 'string' || !id
    || !Object.hasOwn(OWNED_QUERIES, resource)) return null;
  return sql.prepare(OWNED_QUERIES[resource]).bind(id, owner).first<Row>();
}
