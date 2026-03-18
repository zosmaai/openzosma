import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type { AgentEvent, Session, SessionMessage } from "./types.js";

const openai = new OpenAI();

const DEFAULT_MODEL = "gpt-4o-mini";

export class SessionManager {
  private sessions = new Map<string, Session>();

  createSession(): Session {
    const session: Session = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      messages: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  async *sendMessage(
    sessionId: string,
    content: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      yield { type: "error", error: `Session ${sessionId} not found` };
      return;
    }

    // Store user message
    const userMsg: SessionMessage = {
      id: randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    session.messages.push(userMsg);

    const turnId = randomUUID();
    const messageId = randomUUID();

    yield { type: "turn_start", id: turnId };
    yield { type: "message_start", id: messageId };

    let fullResponse = "";

    try {
      const messages: OpenAI.ChatCompletionMessageParam[] = session.messages.map(
        (m) => ({
          role: m.role,
          content: m.content,
        }),
      );

      const stream = await openai.chat.completions.create(
        {
          model: DEFAULT_MODEL,
          messages,
          stream: true,
        },
        { signal },
      );

      for await (const chunk of stream) {
        if (signal?.aborted) {
          break;
        }

        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullResponse += delta;
          yield { type: "message_update", id: messageId, text: delta };
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        // Cancellation is not an error
      } else {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        yield { type: "error", error: errorMessage };
      }
    }

    // Store assistant message
    if (fullResponse) {
      const assistantMsg: SessionMessage = {
        id: messageId,
        role: "assistant",
        content: fullResponse,
        createdAt: new Date().toISOString(),
      };
      session.messages.push(assistantMsg);
    }

    yield { type: "message_end", id: messageId };
    yield { type: "turn_end", id: turnId };
  }
}
