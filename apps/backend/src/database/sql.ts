/**
 * TypeORM's Postgres driver returns `[rows, rowCount]` for UPDATE and DELETE
 * statements run through `manager.query`, and plain `rows` otherwise. This
 * returns the rows of an `UPDATE/DELETE ... RETURNING` either way.
 */
export function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') return result[0] as T[];
  return Array.isArray(result) ? (result as T[]) : [];
}
