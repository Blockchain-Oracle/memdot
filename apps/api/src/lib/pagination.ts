import { desc, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { badRequest } from "./errors.js";

/**
 * Keyset pagination on (created_at, id), newest first. The cursor is opaque to clients and
 * stable under inserts, unlike offsets. Timestamps are stored at millisecond precision, so the
 * cursor's JS Date matches the column exactly and rows sharing a timestamp are not skipped.
 */
interface Cursor {
  t: string;
  id: string | number;
}

export function encodeCursor(createdAt: Date, id: string | number): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id } satisfies Cursor)).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as Cursor;
    if (typeof value.t !== "string" || value.id === undefined) throw new Error();
    return value;
  } catch {
    throw badRequest("BAD_CURSOR", "That page cursor is not valid. Start from the first page.");
  }
}

export function afterCursor(
  cursor: string | undefined,
  createdAt: PgColumn,
  id: PgColumn,
): SQL | undefined {
  if (!cursor) return undefined;
  const { t, id: lastId } = decodeCursor(cursor);
  // A row comparison, so an index on (…, created_at, id) can start right after the cursor.
  return sql`(${createdAt}, ${id}) < (${new Date(t).toISOString()}::timestamptz, ${lastId})`;
}

export const newestFirst = (createdAt: PgColumn, id: PgColumn) => [desc(createdAt), desc(id)];

/** Fetch limit + 1 rows, then call this to split off the next cursor. */
export function page<T extends { createdAt: Date; id: string | number }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
