# @openzosma/adapter-whatsapp

WhatsApp Business Cloud API channel adapter.

## Env

| Variable | Required | Purpose |
|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | yes | Meta permanent token |
| `WHATSAPP_VERIFY_TOKEN` | yes | Webhook verify token you choose |
| `WHATSAPP_APP_SECRET` | recommended | Validates `X-Hub-Signature-256` |
| `WHATSAPP_PHONE_NUMBER_ID` | optional | Fallback phone number id |
| `WHATSAPP_API_VERSION` | optional | Default `v21.0` |

## Webhooks

Mounted by the gateway when the env vars above are set:

- `GET /webhooks/whatsapp` — Meta verification handshake
- `POST /webhooks/whatsapp` — inbound messages

## Behaviour

- Maps `phone_number_id + user phone` to an OpenZosma session (24h TTL in memory)
- Supports text, image, document and audio inbound types
- Accumulates the full agent reply then sends it (WhatsApp cannot edit messages)
- Splits replies over 4096 characters on sentence boundaries when possible
