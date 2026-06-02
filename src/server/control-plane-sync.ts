const CONTROL_PLANE_URL = process.env.OMNI_CONTROL_PLANE_URL?.trim() || "";
const INGEST_SECRET = process.env.OMNI_INGEST_SECRET?.trim() || "";

type IngestKind =
  | "artifact.upsert"
  | "guardrail.incident"
  | "session.event"
  | "session.snapshot"
  | "vault.upsert";

type IngestEnvelope = {
  kind: IngestKind;
  payload: Record<string, unknown>;
};

type SessionStatus =
  | "awaiting_auth"
  | "closed"
  | "completed"
  | "failed"
  | "launching"
  | "paused"
  | "running";

function isEnabled(): boolean {
  return Boolean(CONTROL_PLANE_URL && INGEST_SECRET);
}

async function postEnvelope(envelope: IngestEnvelope): Promise<void> {
  if (!isEnabled()) {
    return;
  }

  const target = new URL("/api/runtime/ingest", CONTROL_PLANE_URL);
  try {
    const response = await fetch(target, {
      body: JSON.stringify(envelope),
      headers: {
        "content-type": "application/json",
        "x-omni-ingest-secret": INGEST_SECRET,
      },
      method: "POST",
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(
        `[omni-control-plane-sync] ${envelope.kind} failed: ${response.status} ${text}`.trim(),
      );
    }
  } catch (error) {
    console.warn("[omni-control-plane-sync] request failed:", error);
  }
}

export async function syncRuntimeSessionSnapshot(input: {
  authWall: boolean;
  actionLog?: Array<{ type: string; ts: string }>;
  currentUrl?: string | null;
  orgId?: string | null;
  runtimeSessionId?: string | null;
  sessionId: string;
  status: SessionStatus;
  totalArtifactCount?: number;
  userId?: string | null;
}): Promise<void> {
  await postEnvelope({
    kind: "session.snapshot",
    payload: {
      actionLog: input.actionLog ?? null,
      authWall: input.authWall,
      currentUrl: input.currentUrl ?? null,
      orgId: input.orgId ?? null,
      runtimeSessionId: input.runtimeSessionId ?? null,
      sessionId: input.sessionId,
      status: input.status,
      totalArtifactCount: input.totalArtifactCount ?? null,
      userId: input.userId ?? null,
    },
  });
}

export async function syncRuntimeEvent(input: {
  data: Record<string, unknown>;
  eventType: string;
  orgId?: string | null;
  sessionId: string;
  timestamp: string;
  userId?: string | null;
}): Promise<void> {
  await postEnvelope({
    kind: "session.event",
    payload: {
      ...input.data,
      eventType: input.eventType,
      orgId: input.orgId ?? null,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      userId: input.userId ?? null,
    },
  });
}

export async function syncArtifactRecord(input: {
  artifactId: string;
  checksumSha256?: string | null;
  contentBase64?: string | null;
  contentType?: string | null;
  downloadUrl?: string | null;
  fileName?: string | null;
  label: string;
  metadata?: Record<string, unknown>;
  orgId: string;
  path?: string | null;
  sessionId: string;
  sizeBytes?: number | null;
  type: string;
  userId: string;
}): Promise<void> {
  await postEnvelope({
    kind: "artifact.upsert",
    payload: {
      artifactId: input.artifactId,
      checksumSha256: input.checksumSha256 ?? null,
      contentBase64: input.contentBase64 ?? null,
      contentType: input.contentType ?? null,
      downloadUrl: input.downloadUrl ?? null,
      fileName: input.fileName ?? null,
      label: input.label,
      metadata: input.metadata ?? {},
      orgId: input.orgId,
      path: input.path ?? null,
      sessionId: input.sessionId,
      sizeBytes: input.sizeBytes ?? null,
      type: input.type,
      userId: input.userId,
    },
  });
}

export async function syncVaultRecord(input: {
  domains: string[];
  envelope?: Record<string, unknown>;
  lastUrl?: string | null;
  orgId: string;
  service: string;
  title: string;
  userId: string;
}): Promise<void> {
  await postEnvelope({
    kind: "vault.upsert",
    payload: {
      domains: input.domains,
      envelope: input.envelope ?? {},
      lastUrl: input.lastUrl ?? null,
      orgId: input.orgId,
      service: input.service,
      title: input.title,
      userId: input.userId,
    },
  });
}

export async function syncGuardrailIncident(input: {
  kind: string;
  orgId: string;
  payload: Record<string, unknown>;
  sessionId?: string | null;
  severity: "info" | "warning" | "critical";
  userId?: string | null;
}): Promise<void> {
  await postEnvelope({
    kind: "guardrail.incident",
    payload: {
      kind: input.kind,
      orgId: input.orgId,
      sessionId: input.sessionId ?? null,
      severity: input.severity,
      userId: input.userId ?? null,
      ...input.payload,
    },
  });
}
