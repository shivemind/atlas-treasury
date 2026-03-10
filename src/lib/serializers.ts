export function serializeWebhookEndpoint(
  endpoint: {
    id: string;
    merchantId: string;
    url: string;
    secret?: string;
    isActive: boolean;
    eventTypes: unknown;
    createdAt: Date;
    updatedAt: Date;
  },
  options?: { includeSecret?: boolean },
) {
  const result: Record<string, unknown> = {
    id: endpoint.id,
    merchant_id: endpoint.merchantId,
    url: endpoint.url,
    is_active: endpoint.isActive,
    enabled_events: endpoint.eventTypes,
    created_at: endpoint.createdAt.toISOString(),
    updated_at: endpoint.updatedAt.toISOString(),
  };
  if (options?.includeSecret && endpoint.secret) {
    result.secret = endpoint.secret;
  }
  return result;
}

export function serializeWebhookDelivery(delivery: {
  id: string;
  merchantId: string;
  webhookEndpointId: string;
  eventType: string;
  payload: unknown;
  status: string;
  deliveredAt: Date | null;
  nextAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  attempts?: Array<{
    attemptNumber: number;
    responseStatus: number | null;
    createdAt: Date;
    completedAt: Date | null;
  }>;
}) {
  return {
    id: delivery.id,
    merchant_id: delivery.merchantId,
    webhook_endpoint_id: delivery.webhookEndpointId,
    event_type: delivery.eventType,
    payload: delivery.payload,
    status: delivery.status,
    delivered_at: delivery.deliveredAt?.toISOString() ?? null,
    next_attempt_at: delivery.nextAttemptAt?.toISOString() ?? null,
    created_at: delivery.createdAt.toISOString(),
    updated_at: delivery.updatedAt.toISOString(),
    attempts: delivery.attempts?.map((a) => ({
      attempt_number: a.attemptNumber,
      response_status: a.responseStatus,
      created_at: a.createdAt.toISOString(),
      completed_at: a.completedAt?.toISOString() ?? null,
    })),
  };
}

export function serializeEvent(event: {
  id: string;
  merchantId: string;
  type: string;
  entityType: string;
  entityId: string;
  payload: unknown;
  actorType: string | null;
  actorId: string | null;
  createdAt: Date;
}) {
  return {
    id: event.id,
    merchant_id: event.merchantId,
    type: event.type,
    entity_type: event.entityType,
    entity_id: event.entityId,
    payload: event.payload,
    actor_type: event.actorType,
    actor_id: event.actorId,
    created_at: event.createdAt.toISOString(),
  };
}

export function serializeIdentity(
  merchant: { id: string; name: string; status: string },
  apiKey: {
    id: string;
    name: string;
    role: string;
    scopes: string[];
    keyPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
  },
) {
  return {
    merchant: {
      id: merchant.id,
      name: merchant.name,
      status: merchant.status,
    },
    apiKey: {
      id: apiKey.id,
      name: apiKey.name,
      role: apiKey.role,
      scopes: apiKey.scopes,
      keyPrefix: apiKey.keyPrefix,
      createdAt: apiKey.createdAt,
      lastUsedAt: apiKey.lastUsedAt,
    },
  };
}
