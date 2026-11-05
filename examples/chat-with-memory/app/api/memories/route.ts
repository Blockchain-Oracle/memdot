import { NextResponse } from "next/server";
import { currentUser, memdot } from "@/lib/server";

const PAGE = 50;

export async function GET() {
  const userId = await currentUser();
  const client = await memdot.client();
  const namespaceId = process.env.MEMDOT_NAMESPACE;
  const { results } = await client.memories.list({
    ...(namespaceId ? { namespaceId } : {}),
    pageSize: PAGE,
    filters: { AND: [{ user_id: userId }] },
  });
  return NextResponse.json({
    memories: results.map(({ id, memory, createdAt }) => ({ id, memory, createdAt })),
  });
}
