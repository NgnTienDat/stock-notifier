import { randomUUID } from "node:crypto";
import type { Prisma, WebhookEvent } from "@prisma/client";
import db from "../../db.server";

export type WebhookClaim = WebhookEvent & { leaseToken: string };
export const MAX_WEBHOOK_ATTEMPTS = 8;

export async function enqueueWebhook(input: {
  shopDomain: string;
  webhookId: string;
  eventId?: string | null;
  topic: string;
  locationGid: string;
  inventoryItemGid?: string;
}) {
  return db.$transaction(
    async (tx) => {
      await tx.shopSettings.createMany({
        data: [{ shopDomain: input.shopDomain }],
        skipDuplicates: true,
      });
      const [settings] = await tx.$queryRaw<
        { updatedAt: Date }[]
      >`SELECT "updatedAt" FROM "ShopSettings" WHERE "shopDomain"=${input.shopDomain} FOR UPDATE`;
      const scope = {
        shopDomain: input.shopDomain,
        locationGid: input.locationGid,
      };
      const location = await tx.monitoredLocation.findUnique({
        where: { shopDomain_locationGid: scope },
      });
      const { count } = await tx.webhookEvent.createMany({
        data: [
          {
            ...input,
            generation: location?.generation,
            nextAttemptAt: new Date(),
          },
        ],
        skipDuplicates: true,
      });
      if (!count) return "duplicate";
      if (input.topic === "LOCATIONS_DELETE" && !location?.deletedAt) {
        // Fence deleted IDs immediately; cleanup stays in the worker, never in HTTP.
        const now = new Date();
        await tx.monitoredLocation.upsert({
          where: { shopDomain_locationGid: scope },
          create: { ...scope, isActive: false, deletedAt: now },
          update: {
            isActive: false,
            deletedAt: now,
            version: { increment: 1 },
            generation: { increment: 1 },
          },
        });
        await tx.shopSettings.update({
          where: { shopDomain: input.shopDomain },
          data: {
            updatedAt: new Date(
              Math.max(now.getTime(), settings.updatedAt.getTime() + 1),
            ),
          },
        });
      }
      return "queued";
    },
    { maxWait: 1000, timeout: 2000 },
  );
}

export async function claimWebhookJob(
  shopDomain?: string,
): Promise<WebhookClaim | null> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      UPDATE "WebhookEvent" SET "nextAttemptAt"=NULL,"leaseUntil"=NULL,"leaseToken"=NULL,
        "lastError"='Webhook retry limit reached; reconciliation required.',"result"='retry_exhausted'
      WHERE "processedAt" IS NULL AND "attempts">=${MAX_WEBHOOK_ATTEMPTS}
        AND "nextAttemptAt" IS NOT NULL AND ("leaseUntil" IS NULL OR "leaseUntil"<=NOW())
        AND (${shopDomain ?? null}::text IS NULL OR "shopDomain"=${shopDomain ?? null})
    `;
    const [job] = await tx.$queryRaw<WebhookClaim[]>`
      WITH candidate AS (
        SELECT id FROM "WebhookEvent" WHERE "processedAt" IS NULL AND "topic" IS NOT NULL
          AND "nextAttemptAt"<=NOW() AND "attempts"<${MAX_WEBHOOK_ATTEMPTS}
          AND ("leaseUntil" IS NULL OR "leaseUntil"<=NOW())
          AND (${shopDomain ?? null}::text IS NULL OR "shopDomain"=${shopDomain ?? null})
        ORDER BY "nextAttemptAt","receivedAt",id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE "WebhookEvent" j SET "attempts"=j."attempts"+1,"leaseToken"=${randomUUID()},
        "leaseUntil"=NOW()+INTERVAL '5 minutes'
      FROM candidate c WHERE j.id=c.id RETURNING j.*
    `;
    return job ?? null;
  });
}

export async function completeWebhookJob(
  tx: Prisma.TransactionClient,
  job: WebhookClaim,
  result: string,
) {
  const count = await tx.$executeRaw`
    UPDATE "WebhookEvent" SET "processedAt"=NOW(),"nextAttemptAt"=NULL,"leaseToken"=NULL,
      "leaseUntil"=NULL,"lastError"=NULL,"result"=${result}
    WHERE id=${job.id} AND "shopDomain"=${job.shopDomain} AND "processedAt" IS NULL
      AND "leaseToken"=${job.leaseToken} AND "leaseUntil">NOW()
  `;
  if (count !== 1) throw new Error("Webhook lease lost; rollback required");
}

export async function assertWebhookLease(
  tx: Prisma.TransactionClient,
  job: WebhookClaim,
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "WebhookEvent" WHERE id=${job.id} AND "shopDomain"=${job.shopDomain}
      AND "leaseToken"=${job.leaseToken} AND "leaseUntil">NOW() AND "processedAt" IS NULL FOR UPDATE
  `;
  if (rows.length !== 1)
    throw new Error("Webhook lease lost; rollback required");
}

export function finishIgnoredWebhook(job: WebhookClaim, result: string) {
  return db.$transaction((tx) => completeWebhookJob(tx, job, result));
}

export function workerMilliseconds(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 100 || value > 3600000)
    throw new Error(
      `Invalid ${name}: expected milliseconds from 100 to 3600000`,
    );
  return value;
}

export async function retryWebhookJob(job: WebhookClaim) {
  const delay = Math.min(
    workerMilliseconds("WEBHOOK_RETRY_BASE_MS", 5000) * 2 ** (job.attempts - 1),
    300000,
  );
  await db.$executeRaw`
    UPDATE "WebhookEvent" SET "leaseToken"=NULL,"leaseUntil"=NULL,
      "nextAttemptAt"=CASE WHEN "attempts"<${MAX_WEBHOOK_ATTEMPTS} THEN NOW()+${delay}*INTERVAL '1 millisecond' ELSE NULL END,
      "lastError"='Webhook processing failed; verify offline auth/API/database and retry.',
      "result"=CASE WHEN "attempts"<${MAX_WEBHOOK_ATTEMPTS} THEN 'retry_pending' ELSE 'retry_exhausted' END
    WHERE id=${job.id} AND "shopDomain"=${job.shopDomain} AND "processedAt" IS NULL
      AND "leaseToken"=${job.leaseToken} AND "leaseUntil">NOW()
  `;
}
