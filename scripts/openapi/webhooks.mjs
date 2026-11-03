// The document's OpenAPI 3.1 `webhooks` section: every push the platform sends, so a receiver
// generates the body type from the same document its client comes from. Each names a component
// hoisted through `COMPONENT_SCHEMAS` in generate-openapi.mjs.

const SIGNING =
  'Verify `x-cat-factory-signature` (`v1=<hex HMAC-SHA256(secret, "<x-cat-factory-timestamp>.<raw body>")>`) over the raw body before parsing, and refuse a timestamp outside your replay window.'

function push(summary, description, component) {
  return {
    post: {
      summary,
      description: `${description} ${SIGNING}`,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: `#/components/schemas/${component}` } } },
      },
      responses: { 200: { description: 'Any 2xx acknowledges the push.' } },
    },
  }
}

export const WEBHOOKS = {
  directoryDelivery: push(
    'A directory webhook push',
    'Sent to each registered directory webhook endpoint: a page of directory changes, or word that the endpoint must resynchronize. Dedupe on `deliveryId`: a failed push is retried with the same id.',
    'DirectoryWebhookDelivery',
  ),
  notificationDelivery: push(
    'A notification push',
    'Sent to each notification webhook endpoint subscribed to the notification’s type, on every state edge of the card (raised, acted, dismissed); key on `notification.status`. Dedupe on `deliveryId`.',
    'NotificationWebhookDelivery',
  ),
  runLifecycleDelivery: push(
    'A run lifecycle push',
    'Sent to each notification webhook endpoint subscribed to the event (`runEvents`). `run.started` is sent once; the terminal and step events are at-least-once, so dedupe on `deliveryId`, never on the body, whose timestamps are re-stamped on a replay.',
    'RunWebhookDelivery',
  ),
  platformAlertDelivery: push(
    'A platform health push',
    'Sent to each notification webhook endpoint subscribed to the event (`alertEvents`) when the account’s run health crosses, or clears, an operator threshold. Dedupe on `deliveryId`.',
    'PlatformAlertWebhookDelivery',
  ),
}
