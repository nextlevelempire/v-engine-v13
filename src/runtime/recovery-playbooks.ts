export interface OmniRecoveryPlaybook {
  code: string;
  summary: string;
  steps: string[];
}

const PLAYBOOKS: OmniRecoveryPlaybook[] = [
  {
    code: "network-drop",
    summary: "Browser lost network access or target fetch timed out.",
    steps: [
      "Retry navigate with exponential backoff.",
      "If retries fail, capture proof checkpoint and persist warm-resume state.",
      "Resume session after connectivity returns or switch target session.",
    ],
  },
  {
    code: "dom-mutation",
    summary: "Selectors or page structure changed mid-task.",
    steps: [
      "Re-run semantic page extraction and Set-of-Mark mapping.",
      "Capture error screenshot and DOM snapshot.",
      "Retry with updated selectors or operator intervention.",
    ],
  },
  {
    code: "auth-expiry",
    summary: "Session lost auth state or hit a sign-in wall.",
    steps: [
      "Persist warm-resume state and current URL.",
      "Mark session recoverable and request operator re-auth if needed.",
      "Replay cookies/storage after auth recovery and resume queue.",
    ],
  },
  {
    code: "daemon-loss",
    summary: "Daemon process died or became unreachable.",
    steps: [
      "Start a fresh daemon process.",
      "Load warm-resume state from OMNI_HOME session storage and restore the queue.",
      "Reattach CLI clients to the new daemon port.",
    ],
  },
  {
    code: "browser-crash",
    summary: "Chrome or page runtime died unexpectedly.",
    steps: [
      "Persist warm-resume state and audit the crash.",
      "Relaunch visible Chrome unless opt-in headless fallback is enabled.",
      "Restore cookies, storage, URL, and pending commands into a new session.",
    ],
  },
];

export function getRecoveryPlaybook(code: string): OmniRecoveryPlaybook {
  return (
    PLAYBOOKS.find((playbook) => playbook.code === code) ?? {
      code,
      summary: "No dedicated playbook found.",
      steps: [
        "Capture proof checkpoint and audit context.",
        "Persist warm-resume state if session data exists.",
        "Escalate to operator review with the recorded artifacts.",
      ],
    }
  );
}

export function listRecoveryPlaybooks(): OmniRecoveryPlaybook[] {
  return [...PLAYBOOKS];
}
