# Phase 7: Web Dashboard

**Duration:** 2 weeks
**Priority:** P1
**Depends on:** Phase 3 (gateway), Phase 4 (orchestrator)

## Goal

Build a Next.js web dashboard for admins and users. The dashboard is a pure client -- it consumes the OpenZosma REST and WebSocket APIs. No API routes in the critical path.

## Architecture

```
apps/web/ (Next.js)
    |
    | REST API calls + WebSocket
    |
packages/gateway/ (Hono server)
```

The dashboard runs on its own domain (e.g., `app.openzosma.dev`) and calls the backend API (e.g., `api.openzosma.dev`). In development, both run locally with CORS configured.

## Tech Stack

- **Next.js 15** (App Router)
- **React 19**
- **Tailwind CSS 4**
- **shadcn/ui** -- component library
- **TanStack Query** -- data fetching and caching
- **@openzosma/sdk** -- typed API client (from `packages/sdk/`)

## Client SDK (`packages/sdk/`)

Typed client for the OpenZosma API. Used by the dashboard and available to external developers.

```typescript
import { OpenZosma } from "@openzosma/sdk"

const client = new OpenZosma({
  baseUrl: "https://api.openzosma.dev",
  apiKey: "oz_...",  // or session cookie for dashboard
})

// Sessions
const session = await client.sessions.create({ agentConfigId: "..." })
const messages = await client.sessions.messages(session.id)

// Streaming
const stream = client.sessions.stream(session.id)
for await (const event of stream) {
  // AgentEvent: message_update, tool_execution_start, etc.
}

// WebSocket (real-time)
const ws = client.sessions.connect(session.id)
ws.send({ type: "message", content: "Hello" })
ws.on("event", (event: AgentEvent) => { ... })

// Agents
const agents = await client.agents.list()

// Usage
const usage = await client.usage.get({ from: "2025-01-01", to: "2025-01-31" })
```

## Pages

### Authentication

**`/login`**
- Email/password form
- OAuth buttons (GitHub, Google)
- "Create account" link

**`/register`**
- Email, password, name
- Or OAuth signup
- First user is auto-promoted to admin

### Dashboard

**`/dashboard`**
- Active sessions count
- Today's token usage (chart)
- Recent conversations (list)
- Quick actions: new chat, configure agent

### Chat

**`/chat`** and **`/chat/:sessionId`**
- Real-time agent interaction via WebSocket
- Message list with streaming responses
- Tool execution display (collapsible blocks showing tool name, input, output)
- File attachments (drag-and-drop)
- Session sidebar (list of recent sessions)
- New session button (with agent config selector)

This is the most complex page. Key components:

```
ChatPage
├── SessionSidebar
│   ├── SessionList
│   └── NewSessionButton
├── ChatArea
│   ├── MessageList
│   │   ├── UserMessage
│   │   ├── AssistantMessage (streaming)
│   │   └── ToolExecutionBlock (collapsible)
│   ├── TypingIndicator
│   └── InputArea
│       ├── TextInput (multiline)
│       ├── AttachmentButton
│       └── SendButton
└── SessionInfo (right panel, optional)
    ├── SessionStatus
    ├── TokenUsage
    └── AgentConfig
```

### Sessions

**`/sessions`**
- Paginated list of all sessions
- Filter by status, date range, agent
- Search by message content
- Click to view session detail

**`/sessions/:id`**
- Full message history (read-only replay)
- Session metadata (agent config, sandbox ID, duration, token usage)
- Export conversation (JSON, markdown)

### Agents

**`/agents`**
- List of configured agents
- Create new agent config
- Edit existing agent config

**`/agents/:id`** (edit form)
- Name, description
- Model selector (dropdown: gpt-4o, claude-sonnet, etc.)
- System prompt (textarea)
- Tools enabled (checkboxes: read, write, edit, bash, grep, etc.)
- Skills enabled (checkboxes: database, reports)
- Temperature, max tokens (sliders)
- Test button (opens quick chat with this config)

### Connections

**`/connections`**
- List database connections
- Add new connection
- Test connection
- View cached schema

**`/connections/new`** and **`/connections/:id`**
- Connection type selector (PostgreSQL, MySQL, MongoDB, etc.)
- Connection form (host, port, database, username, password -- or connection string)
- Read-only toggle
- Query timeout, row limit
- Test connection button
- Schema preview (after successful test)

### Settings

**`/settings`**
- **General:** Instance name, sandbox pool size, quota configuration
- **Team:** Invite users, manage roles (admin/member)
- **API Keys:** Create, list, revoke API keys
- **Integrations:** Slack bot token, WhatsApp configuration

## State Management

- **Server state:** TanStack Query (sessions, messages, agents, connections, usage)
- **Client state:** React context (auth state, UI preferences)
- **Real-time state:** WebSocket connection managed by custom hook

```typescript
// Custom hook for WebSocket chat
function useChat(sessionId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const ws = client.sessions.connect(sessionId)
    wsRef.current = ws

    ws.on("event", (event: AgentEvent) => {
      switch (event.type) {
        case "message_start":
          setIsStreaming(true)
          setMessages(prev => [...prev, { id: event.id, role: "assistant", content: "" }])
          break
        case "message_update":
          setMessages(prev => {
            const last = prev[prev.length - 1]
            return [...prev.slice(0, -1), { ...last, content: last.content + event.text }]
          })
          break
        case "message_end":
          setIsStreaming(false)
          break
        case "tool_execution_start":
          // Add tool execution block
          break
        case "tool_execution_end":
          // Update tool execution with result
          break
      }
    })

    return () => ws.close()
  }, [sessionId])

  const sendMessage = (content: string) => {
    wsRef.current?.send(JSON.stringify({ type: "message", content }))
    setMessages(prev => [...prev, { role: "user", content }])
  }

  return { messages, isStreaming, sendMessage }
}
```

## Responsive Design

- Desktop: full layout with sidebars
- Tablet: collapsible sidebars
- Mobile: single-pane navigation (session list -> chat -> details)

The chat page is the primary mobile use case. It should feel native-like with:
- Bottom-anchored input
- Smooth scrolling
- Pull-to-refresh for session list

## Deliverables

1. `apps/web/` -- Next.js 15 application
2. `packages/sdk/` -- typed API client
3. All pages listed above
4. WebSocket-based real-time chat
5. Responsive design (desktop, tablet, mobile)
6. Authentication flows (email/password, OAuth)
7. Component library (shadcn/ui based)
8. TanStack Query integration for data fetching
