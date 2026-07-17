import { z } from "zod";

export const SITE_DISCOVERY_EVENT_SCHEMA_VERSION = 1 as const;

const HostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );

export const SiteDiscoveryRequestedEventSchema = z
  .object({
    id: z.string().uuid(),
    schemaVersion: z.literal(SITE_DISCOVERY_EVENT_SCHEMA_VERSION),
    type: z.literal("site.discovery.requested"),
    idempotencyKey: z.string().trim().min(1).max(512),
    occurredAt: z.string().datetime({ offset: true }),
    payload: z
      .object({
        siteId: z.string().uuid(),
        initialUrl: HostnameSchema,
        baseDomain: HostnameSchema,
        leaseToken: z.string().uuid(),
        leaseUntil: z.string().datetime({ offset: true }),
        policyVersion: z.number().int().positive().max(1_000_000),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    const expectedKey = `site.discovery:${event.payload.siteId}:${event.payload.leaseToken}`;
    if (event.idempotencyKey !== expectedKey) {
      context.addIssue({
        code: "custom",
        message: "idempotency key does not match the site lease",
        path: ["idempotencyKey"],
      });
    }

    if (Date.parse(event.payload.leaseUntil) <= Date.parse(event.occurredAt)) {
      context.addIssue({
        code: "custom",
        message: "lease must expire after the event occurred",
        path: ["payload", "leaseUntil"],
      });
    }

    if (
      event.payload.initialUrl !== event.payload.baseDomain &&
      !event.payload.initialUrl.endsWith(`.${event.payload.baseDomain}`)
    ) {
      context.addIssue({
        code: "custom",
        message: "initial URL must be within the base domain",
        path: ["payload", "initialUrl"],
      });
    }
  });

export type SiteDiscoveryRequestedEvent = z.infer<
  typeof SiteDiscoveryRequestedEventSchema
>;
