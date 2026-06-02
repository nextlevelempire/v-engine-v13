import "./styles.css";

type SessionSummary = {
  agentId: string;
  commandCount: number;
  createdAt: string;
  lastActiveAt: string;
  objective: string | null;
  persistent: boolean;
  sessionId: string;
};

type SessionEvent = {
  data: Record<string, unknown>;
  eventId: string;
  sessionId: string;
  timestamp: string;
  type: string;
};

const state = {
  events: [] as SessionEvent[],
  health: null as Record<string, unknown> | null,
  sessions: [] as SessionSummary[],
  selectedSessionId: "" as string,
  stream: null as EventSource | null,
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("App root not found");
}

app.innerHTML = `
  <main class="shell">
    <section class="hero">
      <div class="eyebrow">Standalone Runtime</div>
      <h1>Omni Browser V4 Control Plane</h1>
      <p>Live runtime, hardened guardrails, HTTP directives, and SSE events without any CRM inheritance.</p>
      <div class="metrics" id="metrics"></div>
    </section>
    <section class="grid">
      <section class="panel stack">
        <h2>Create Session</h2>
        <form id="create-session-form">
          <input id="objective" name="objective" placeholder="Mission objective" />
          <button type="submit">Create Standalone Session</button>
        </form>
        <div class="controls">
          <input id="navigate-url" placeholder="https://example.com" />
          <div class="button-row">
            <button id="navigate-button" type="button">Navigate</button>
            <button id="status-button" class="secondary" type="button">Refresh Status</button>
            <button id="screenshot-button" class="secondary" type="button">Screenshot</button>
          </div>
          <textarea id="directive-message" placeholder="Operator directive"></textarea>
          <div class="button-row">
            <button id="directive-button" type="button">Queue Directive</button>
          </div>
        </div>
      </section>
      <section class="panel">
        <h2>Sessions</h2>
        <div class="session-list" id="session-list"></div>
      </section>
    </section>
    <section class="panel">
      <h2>Event Stream</h2>
      <div class="event-log" id="event-log"></div>
    </section>
  </main>
`;

const metricsNode = query("#metrics");
const sessionListNode = query("#session-list");
const eventLogNode = query("#event-log");

query<HTMLFormElement>("#create-session-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const objective = query<HTMLInputElement>("#objective").value.trim();
  const created = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ objective }),
    headers: { "content-type": "application/json" },
  });
  if (typeof created.sessionId === "string") {
    state.selectedSessionId = created.sessionId;
    connectStream(created.sessionId);
  }
  await refresh();
});

query<HTMLButtonElement>("#navigate-button").addEventListener("click", async () => {
  if (!state.selectedSessionId) return;
  const url = query<HTMLInputElement>("#navigate-url").value.trim();
  if (!url) return;
  await command({ type: "navigate", url });
});

query<HTMLButtonElement>("#status-button").addEventListener("click", async () => {
  if (!state.selectedSessionId) return;
  await command({ type: "status" });
});

query<HTMLButtonElement>("#screenshot-button").addEventListener("click", async () => {
  if (!state.selectedSessionId) return;
  await command({ label: "manual", type: "screenshot" });
});

query<HTMLButtonElement>("#directive-button").addEventListener("click", async () => {
  if (!state.selectedSessionId) return;
  const message = query<HTMLTextAreaElement>("#directive-message").value.trim();
  if (!message) return;
  await command({ message, type: "directive" });
  query<HTMLTextAreaElement>("#directive-message").value = "";
});

void refresh();

async function refresh(): Promise<void> {
  state.health = await api("/api/health");
  const sessionsPayload = await api("/api/sessions");
  state.sessions = Array.isArray(sessionsPayload.sessions) ? sessionsPayload.sessions : [];
  if (!state.selectedSessionId && state.sessions[0]) {
    state.selectedSessionId = state.sessions[0].sessionId;
    connectStream(state.selectedSessionId);
  }
  render();
}

async function command(payload: Record<string, unknown>): Promise<void> {
  const result = await api(`/api/sessions/${state.selectedSessionId}/command`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
  state.events.unshift({
    data: result,
    eventId: `local-${Date.now()}`,
    sessionId: state.selectedSessionId,
    timestamp: new Date().toISOString(),
    type: "command.response",
  });
  render();
}

function connectStream(sessionId: string): void {
  state.stream?.close();
  state.events = [];
  state.stream = new EventSource(`/api/sessions/${sessionId}/events`);
  state.stream.onmessage = (event) => {
    const parsed = JSON.parse(event.data) as SessionEvent;
    state.events.unshift(parsed);
    render();
  };
  state.stream.addEventListener("session.snapshot", (event) => {
    const parsed = JSON.parse((event as MessageEvent).data) as SessionEvent;
    state.events.unshift(parsed);
    render();
  });
}

function render(): void {
  metricsNode.innerHTML = [
    metric("Transport", String(state.health?.transport ?? "unknown")),
    metric("Runtime", String(state.health?.runtime ?? "unknown")),
    metric("Sessions", String(state.sessions.length)),
    metric("Selected", state.selectedSessionId || "none"),
  ].join("");

  sessionListNode.innerHTML = state.sessions
    .map((session) => {
      const active = session.sessionId === state.selectedSessionId ? " active" : "";
      return `
        <article class="session-card${active}" data-session-id="${session.sessionId}">
          <header>
            <strong>${escapeHtml(session.sessionId.slice(0, 8))}</strong>
            <span class="pill">${session.persistent ? "Persistent" : "Ephemeral"}</span>
          </header>
          <p class="muted">${escapeHtml(session.objective || "No mission objective yet.")}</p>
          <div class="muted">Agent: ${escapeHtml(session.agentId)}</div>
          <div class="muted">Commands: ${session.commandCount}</div>
        </article>
      `;
    })
    .join("");

  for (const card of Array.from(sessionListNode.querySelectorAll<HTMLElement>(".session-card"))) {
    card.onclick = () => {
      const sessionId = card.dataset.sessionId || "";
      state.selectedSessionId = sessionId;
      connectStream(sessionId);
      render();
    };
  }

  eventLogNode.innerHTML = state.events
    .slice(0, 16)
    .map(
      (event) => `
        <article class="event-card">
          <header>
            <strong>${escapeHtml(event.type)}</strong>
            <span class="pill">${new Date(event.timestamp).toLocaleTimeString()}</span>
          </header>
          <div class="muted">${escapeHtml(event.sessionId)}</div>
          <pre>${escapeHtml(JSON.stringify(event.data, null, 2))}</pre>
        </article>
      `,
    )
    .join("");
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span class="muted">${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

async function api(pathname: string, init?: RequestInit): Promise<any> {
  const response = await fetch(pathname, init);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }
  return element;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
