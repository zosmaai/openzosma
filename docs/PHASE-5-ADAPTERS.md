# Phase 5: Channel Adapters

**Duration:** 1 week
**Priority:** P1
**Depends on:** Phase 4 (orchestrator)

## Goal

Connect agents to Slack and WhatsApp. Each adapter translates between a channel's native protocol and the OpenZosma orchestrator. The web adapter is already covered by the gateway (REST + WebSocket).

## Architecture

```
Channel (Slack, WhatsApp)
        |
  Channel Adapter
  - Receives native events
  - Maps to OpenZosma sessions
  - Translates messages
  - Handles channel-specific UX
        |
  Orchestrator (gRPC)
  - Same API as gateway uses
  - No channel awareness
```

Adapters are lightweight. They do NOT contain business logic. They translate and route. They communicate with the orchestrator via the same gRPC API that the gateway uses.

## Slack Adapter (`packages/adapters/slack/`)

### Reference

Based on existing `pi-mono/packages/mom/` (Slack bot implementation). That package demonstrates:
- Socket Mode connection
- Thread-based conversations
- Message formatting
- File handling

### Connection Mode

**Socket Mode** (recommended for development and single-instance):
- No public URL required
- WebSocket connection from adapter to Slack
- Simpler setup

**HTTP Events API** (for production, multi-instance):
- Requires public URL
- Slack sends HTTP POST to adapter
- Supports multiple adapter instances behind a load balancer

### Mapping

| Slack Concept | OpenZosma Concept |
|---|---|
| Channel + Thread | Session |
| Message in thread | User message |
| Bot reply in thread | Assistant message |
| File upload | Message attachment |
| Reaction | (not mapped) |

### Session Management

```typescript
// Map: Slack thread -> OpenZosma session
// Key: `slack:session:${channelId}:${threadTs}`
// Stored in Valkey with TTL (24h idle timeout)

async function getOrCreateSession(
  channelId: string,
  threadTs: string,
  userId: string,
): Promise<string> {
  const key = `slack:session:${channelId}:${threadTs}`

  let sessionId = await valkey.get(key)
  if (sessionId) {
    await valkey.expire(key, 86400)  // refresh TTL
    return sessionId
  }

  // Create new session via orchestrator gRPC
  const session = await orchestrator.createSession({
    userId: resolveUserId(userId),
    metadata: { channel: "slack", channelId, threadTs },
  })

  await valkey.set(key, session.id, "EX", 86400)
  return session.id
}
```

### Message Handling

```typescript
// Incoming Slack message -> OpenZosma
async function handleSlackMessage(event: SlackMessageEvent) {
  const userId = resolveUserId(event.user)
  const sessionId = await getOrCreateSession(
    event.channel, event.thread_ts ?? event.ts, event.user,
  )

  // Send to orchestrator via gRPC and stream response
  const events = orchestrator.sendMessage({
    sessionId,
    content: event.text,
  })

  // Accumulate response and post to Slack
  let responseText = ""
  let slackMessageTs: string | null = null

  for await (const agentEvent of events) {
    if (agentEvent.type === "message_update") {
      responseText += agentEvent.text

      // Update Slack message periodically (throttled to avoid rate limits)
      if (shouldUpdate(responseText)) {
        if (slackMessageTs) {
          await slack.chat.update({ channel: event.channel, ts: slackMessageTs, text: responseText })
        } else {
          const result = await slack.chat.postMessage({
            channel: event.channel, thread_ts: event.thread_ts ?? event.ts, text: responseText
          })
          slackMessageTs = result.ts
        }
      }
    }

    if (agentEvent.type === "tool_execution_end") {
      // Post tool output as a collapsed block
      await slack.chat.postMessage({
        channel: event.channel, thread_ts: event.thread_ts ?? event.ts,
        blocks: formatToolOutput(agentEvent),
      })
    }
  }

  // Final update with complete response
  if (slackMessageTs) {
    await slack.chat.update({ channel: event.channel, ts: slackMessageTs, text: responseText })
  }
}
```

### User Resolution

Slack users are mapped to OpenZosma users. On first message from a Slack user:
1. Look up mapping in Valkey: `slack:user:${slackUserId}` -> OpenZosma user ID
2. If not found, look up or create a user in the `users` table with the Slack user's email (fetched from Slack API)
3. Cache the mapping in Valkey

```typescript
async function resolveUserId(slackUserId: string): Promise<string> {
  const cached = await valkey.get(`slack:user:${slackUserId}`)
  if (cached) return cached

  // Fetch Slack user profile for email
  const slackUser = await slack.users.info({ user: slackUserId })
  const email = slackUser.user?.profile?.email

  // Find or create OpenZosma user
  const result = await pool.query(
    "SELECT id FROM users WHERE email = $1",
    [email],
  )

  let userId: string
  if (result.rows[0]) {
    userId = result.rows[0].id
  } else {
    const insert = await pool.query(
      "INSERT INTO users (email, name, role) VALUES ($1, $2, 'member') RETURNING id",
      [email, slackUser.user?.real_name],
    )
    userId = insert.rows[0].id
  }

  await valkey.set(`slack:user:${slackUserId}`, userId, "EX", 86400 * 30)
  return userId
}
```

### Slack App Configuration

Required scopes:
- `app_mentions:read` -- respond when mentioned
- `chat:write` -- send messages
- `files:read` -- access uploaded files
- `channels:history` -- read channel messages (for thread context)
- `groups:history` -- read private channel messages
- `users:read` -- resolve user profiles
- `users:read.email` -- get user emails for mapping

### Setup

1. Create Slack App and install to workspace
2. Configure bot token and app-level token in env vars (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`)
3. Start adapter (connects via Socket Mode or registers webhook URL)

## WhatsApp Adapter (`packages/adapters/whatsapp/`)

### WhatsApp Business Cloud API

Uses Meta's Cloud API (hosted by Meta, no on-premise infrastructure needed).

### Mapping

| WhatsApp Concept | OpenZosma Concept |
|---|---|
| Phone number + conversation | Session |
| Text message | User message |
| Media message (image, doc) | Message attachment |
| Template message | Notification |

### Webhook Receiver

```typescript
// WhatsApp sends webhooks to: POST /webhooks/whatsapp
app.post("/webhooks/whatsapp", async (c) => {
  const body = await c.req.json()

  // Verify webhook signature
  if (!verifyWhatsAppSignature(c.req, body)) {
    return c.json({ error: "Invalid signature" }, 401)
  }

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      if (change.field === "messages") {
        for (const message of change.value.messages) {
          await handleWhatsAppMessage(change.value.metadata, message)
        }
      }
    }
  }

  return c.json({ ok: true })
})

// Webhook verification (GET)
app.get("/webhooks/whatsapp", (c) => {
  const mode = c.req.query("hub.mode")
  const token = c.req.query("hub.verify_token")
  const challenge = c.req.query("hub.challenge")

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return c.text(challenge!)
  }
  return c.text("Forbidden", 403)
})
```

### Session Management

```typescript
// Map: phone number -> OpenZosma session
// WhatsApp conversations have a 24-hour window
// Key: `whatsapp:session:${phoneNumberId}:${userPhone}`

async function getOrCreateSession(
  phoneNumberId: string,
  userPhone: string,
): Promise<string> {
  const key = `whatsapp:session:${phoneNumberId}:${userPhone}`

  let sessionId = await valkey.get(key)
  if (sessionId) {
    await valkey.expire(key, 86400)  // 24h window
    return sessionId
  }

  const userId = await resolveWhatsAppUser(userPhone)
  const session = await orchestrator.createSession({
    userId,
    metadata: { channel: "whatsapp", phoneNumberId, userPhone },
  })

  await valkey.set(key, session.id, "EX", 86400)
  return session.id
}
```

### Message Handling

```typescript
async function handleWhatsAppMessage(metadata: any, message: WhatsAppMessage) {
  const sessionId = await getOrCreateSession(
    metadata.phone_number_id, message.from,
  )

  // Convert WhatsApp message to content
  let content = ""
  switch (message.type) {
    case "text":
      content = message.text.body
      break
    case "image":
    case "document":
    case "audio":
      // Download media and include as attachment
      content = message.caption ?? ""
      break
  }

  const events = orchestrator.sendMessage({
    sessionId,
    content,
  })

  // Accumulate response (WhatsApp doesn't support message editing)
  let responseText = ""
  for await (const event of events) {
    if (event.type === "message_update") {
      responseText += event.text
    }
  }

  // Send complete response
  // WhatsApp has a 4096 character limit per message
  const chunks = splitMessage(responseText, 4096)
  for (const chunk of chunks) {
    await sendWhatsAppMessage(metadata.phone_number_id, message.from, chunk)
  }
}
```

### Sending Messages

```typescript
async function sendWhatsAppMessage(
  phoneNumberId: string,
  to: string,
  text: string,
) {
  await fetch(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      }),
    },
  )
}
```

### WhatsApp Setup

1. Create Meta Business Account and WhatsApp Business App
2. Configure webhook URL in Meta dashboard
3. Set env vars: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`
4. Subscribe to `messages` webhook field

## Adapter Registration

Adapters register themselves with the orchestrator at startup:

```typescript
// packages/gateway/src/adapters.ts
interface ChannelAdapter {
  name: string
  init(orchestrator: OrchestratorClient): Promise<void>
  shutdown(): Promise<void>
}

// Registration
const adapters: ChannelAdapter[] = [
  ...(config.slack ? [new SlackAdapter(config.slack)] : []),
  ...(config.whatsapp ? [new WhatsAppAdapter(config.whatsapp)] : []),
]

for (const adapter of adapters) {
  await adapter.init(orchestratorClient)
}
```

Adapters are optional. If `SLACK_BOT_TOKEN` is not set, the Slack adapter is not started. Same for WhatsApp.

## Deliverables

1. `packages/adapters/slack/` -- Slack adapter (Socket Mode + HTTP Events)
2. `packages/adapters/whatsapp/` -- WhatsApp adapter (Cloud API webhooks)
3. Session mapping (channel thread/conversation -> OpenZosma session)
4. User resolution (channel user -> OpenZosma user)
5. Message translation (channel-native format <-> OpenZosma format)
6. Streaming response handling (Slack: message updates, WhatsApp: chunked)
7. Tests (mocked Slack/WhatsApp APIs)
