import { and, eq } from "drizzle-orm";
import { db, loaRequestsTable, type LoaRequest } from "@workspace/db";

export async function createLoaRequest(input: {
  guildId: string;
  requesterId: string;
  requesterName: string;
  requestText: string;
  startDate: string;
  endDate: string;
}) {
  const [request] = await db
    .insert(loaRequestsTable)
    .values({
      ...input,
      status: "pending",
    })
    .returning();
  return request;
}

export async function getLoaRequest(id: number) {
  const [request] = await db
    .select()
    .from(loaRequestsTable)
    .where(eq(loaRequestsTable.id, id))
    .limit(1);
  return request ?? null;
}

export async function decideLoaRequest(
  id: number,
  status: "approved" | "declined",
  decidedById: string,
  decidedByName: string,
): Promise<LoaRequest | null> {
  const [request] = await db
    .update(loaRequestsTable)
    .set({
      status,
      decidedById,
      decidedByName,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(loaRequestsTable.id, id),
        eq(loaRequestsTable.status, "processing"),
      ),
    )
    .returning();
  return request ?? null;
}

export async function claimLoaRequest(id: number) {
  const [request] = await db
    .update(loaRequestsTable)
    .set({
      status: "processing",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(loaRequestsTable.id, id),
        eq(loaRequestsTable.status, "pending"),
      ),
    )
    .returning();
  return request ?? null;
}

export async function releaseLoaRequest(id: number) {
  await db
    .update(loaRequestsTable)
    .set({
      status: "pending",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(loaRequestsTable.id, id),
        eq(loaRequestsTable.status, "processing"),
      ),
    );
}