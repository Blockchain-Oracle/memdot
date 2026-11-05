import { NextResponse } from "next/server";
import { currentUser, memdot } from "@/lib/server";

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const userId = await currentUser();
  const client = await memdot.client();
  // This server's key reaches everyone's memories, so check whose this is before acting on it.
  const memory = await client.memories.get(id).catch(() => null);
  if (memory?.userId !== userId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  await client.memories.delete(id);
  return NextResponse.json({ deleted: true });
}
