import type { BrowserContext, Page } from "playwright";

import { OMNI_MOTION_EASING } from "./human-rhythm.js";

const OMNI_UI_STYLE = `
  :host, *, *::before, *::after {
    box-sizing: border-box;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  :host([data-omni-page-active="false"]) #nle-frame,
  :host([data-omni-page-active="false"]) #nle-badge,
  :host([data-omni-page-active="false"]) #nle-scratchpad,
  :host([data-omni-page-active="false"]) #nle-control-cluster,
  :host([data-omni-page-active="false"]) #nle-keyboard-shell,
  :host([data-omni-page-active="false"]) #nle-magic-mouse,
  :host([data-omni-page-active="false"]) .som-badge,
  :host([data-omni-page-active="false"]) .nle-ripple,
  :host([data-omni-page-active="false"]) .nle-spark {
    display: none !important;
  }
  #nle-frame {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 2147483640;
    opacity: 0;
    animation: overlayFade 260ms ${OMNI_MOTION_EASING} forwards;
  }
  #nle-frame::before,
  #nle-frame::after {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  #nle-frame::before {
    padding: 3px;
    background:
      linear-gradient(
        110deg,
        rgba(212, 175, 55, 0.08) 0%,
        rgba(255, 239, 167, 0.42) 18%,
        rgba(255, 215, 0, 0.24) 36%,
        rgba(255, 244, 196, 0.52) 58%,
        rgba(255, 215, 0, 0.22) 72%,
        rgba(212, 175, 55, 0.1) 100%
      );
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    filter: blur(16px) saturate(138%);
    opacity: 0.84;
    animation: edgeSweep 7.2s linear infinite;
  }
  #nle-frame::after {
    box-shadow:
      inset 0 0 0 1px rgba(255, 215, 0, 0.16),
      inset 0 0 36px rgba(212, 175, 55, 0.18),
      inset 0 0 120px rgba(212, 175, 55, 0.12),
      inset 0 0 180px rgba(2, 6, 23, 0.34);
    opacity: 0.72;
  }
  #nle-frame[data-executing="true"]::before,
  #nle-frame[data-executing="true"]::after {
    animation:
      edgeSweep 7.2s linear infinite,
      edgeHeartbeat 1.2s ease-in-out infinite;
  }
  #nle-badge,
  #nle-scratchpad,
  #nle-control-cluster,
  #nle-keyboard-shell {
    position: relative;
    overflow: hidden;
    isolation: isolate;
    background:
      radial-gradient(circle at top left, rgba(255, 215, 0, 0.08), transparent 40%),
      linear-gradient(180deg, rgba(15, 23, 42, 0.74), rgba(15, 23, 42, 0.56));
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(255, 215, 0, 0.14);
    box-shadow:
      0 24px 56px rgba(2, 6, 23, 0.24),
      inset 0 1px 0 rgba(255, 255, 255, 0.06),
      inset 0 -18px 42px rgba(15, 23, 42, 0.18);
  }
  #nle-badge::before,
  #nle-scratchpad::before,
  #nle-control-cluster::before,
  #nle-keyboard-shell::before {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, rgba(255, 255, 255, 0.09), transparent 42%);
    opacity: 0.52;
    pointer-events: none;
    z-index: -1;
  }
  #nle-badge {
    position: fixed;
    top: 24px;
    left: 50%;
    transform: translateX(-50%);
    min-width: 208px;
    padding: 6px 14px;
    border-radius: 999px;
    z-index: 2147483641;
    pointer-events: none;
    text-align: center;
    color: #f8fafc;
    font-family: Inter, "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    opacity: 0;
    animation:
      overlayFade 280ms ${OMNI_MOTION_EASING} forwards,
      badgePulse 4.6s ease-in-out 280ms infinite;
  }
  #nle-badge::before {
    inset: 1px;
    border-radius: inherit;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.01));
    opacity: 0.68;
    z-index: -1;
  }
  #nle-badge .major {
    font-size: 11px;
    line-height: 1.15;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: #D4AF37;
    text-shadow: 0 0 16px rgba(255, 215, 0, 0.26);
  }
  #nle-badge .nle {
    margin-top: 2px;
    font-size: 10px;
    line-height: 1.15;
    font-weight: 500;
    letter-spacing: 0.03em;
    color: rgba(248, 250, 252, 0.78);
  }
  #nle-scratchpad {
    position: fixed;
    right: 24px;
    top: 96px;
    width: min(420px, calc(100vw - 48px));
    height: min(72vh, 760px);
    z-index: 2147483644;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    border-radius: 24px;
    font-family: Inter, "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    transform: translateX(28px);
    opacity: 0;
    transition:
      transform 0.25s ${OMNI_MOTION_EASING},
      opacity 0.25s ease,
      width 0.25s ${OMNI_MOTION_EASING},
      height 0.25s ${OMNI_MOTION_EASING},
      inset 0.25s ${OMNI_MOTION_EASING},
      bottom 0.25s ${OMNI_MOTION_EASING};
  }
  #nle-scratchpad.visible {
    transform: translateX(0);
    opacity: 1;
  }
  #nle-scratchpad[data-window-state="closed"] {
    display: none;
  }
  #nle-scratchpad[data-window-state="minimized"] {
    top: auto;
    bottom: 18px;
    width: min(320px, calc(100vw - 36px));
    height: auto;
    min-height: 0;
  }
  #nle-scratchpad[data-window-state="fullscreen"] {
    inset: 14px;
    width: auto;
    height: auto;
    max-width: none;
    max-height: none;
    border-radius: 28px;
  }
  #nle-scratchpad-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 16px 18px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.01));
  }
  #nle-scratchpad[data-window-state="minimized"] #nle-scratchpad-header {
    cursor: pointer;
    padding-bottom: 16px;
  }
  #nle-scratchpad-header .header-actions {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  #nle-scratchpad-header .window-btn {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    border: 0;
    padding: 0;
    cursor: pointer;
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.2);
    transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
  }
  #nle-scratchpad-header .window-btn:hover {
    transform: scale(1.08);
    box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.08);
  }
  #nle-scratchpad-header .window-btn.red { background: #ff5f57; }
  #nle-scratchpad-header .window-btn.yellow { background: #febc2e; }
  #nle-scratchpad-header .window-btn.green { background: #28c840; }
  .scratchpad-title {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }
  .scratchpad-title strong {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    color: #D4AF37;
  }
  .scratchpad-title span {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: rgba(248, 250, 252, 0.56);
  }
  #nle-scratchpad-tabs {
    display: flex;
    gap: 8px;
    padding: 12px 16px 0;
  }
  .scratchpad-tab {
    min-height: 32px;
    padding: 0 12px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(15, 23, 42, 0.46);
    color: rgba(226, 232, 240, 0.7);
    cursor: pointer;
    font: 700 10px/1 Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  .scratchpad-tab.active {
    border-color: rgba(255, 215, 0, 0.24);
    background: rgba(255, 215, 0, 0.12);
    color: #ffe79c;
  }
  #nle-scratchpad-panels {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .scratchpad-panel {
    flex: 1;
    min-height: 0;
    display: none;
  }
  .scratchpad-panel.active {
    display: flex;
    flex-direction: column;
  }
  #nle-scratchpad-content {
    flex: 1;
    min-height: 160px;
    padding: 16px 16px 8px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
    scroll-behavior: smooth;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 215, 0, 0.16) transparent;
  }
  #nle-scratchpad-content::-webkit-scrollbar {
    width: 5px;
  }
  #nle-scratchpad-content::-webkit-scrollbar-thumb {
    background: rgba(255, 215, 0, 0.16);
    border-radius: 999px;
  }
  .scratchpad-entry {
    max-width: min(92%, 320px);
    padding: 12px 14px;
    border-radius: 18px;
    font-size: 12.5px;
    line-height: 1.6;
    color: rgba(248, 250, 252, 0.92);
    animation: scratchpadFade 180ms ${OMNI_MOTION_EASING};
    word-break: break-word;
  }
  .scratchpad-entry.ai {
    align-self: flex-start;
    background: linear-gradient(180deg, rgba(99, 102, 241, 0.14), rgba(15, 23, 42, 0.72));
    border: 1px solid rgba(129, 140, 248, 0.18);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .scratchpad-entry.human {
    align-self: flex-end;
    background: linear-gradient(180deg, rgba(255, 215, 0, 0.18), rgba(120, 74, 0, 0.2));
    border: 1px solid rgba(255, 215, 0, 0.24);
    color: rgba(255, 249, 219, 0.96);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .entry-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 7px;
  }
  .entry-badge {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .entry-badge.ai {
    color: #c7d2fe;
    background: rgba(129, 140, 248, 0.14);
    border: 1px solid rgba(129, 140, 248, 0.2);
  }
  .entry-badge.human {
    color: #ffe79c;
    background: rgba(255, 215, 0, 0.12);
    border: 1px solid rgba(255, 215, 0, 0.18);
  }
  .entry-time {
    font-family: "SF Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.04em;
    color: rgba(226, 232, 240, 0.34);
  }
  .entry-text {
    font-weight: 400;
    white-space: pre-wrap;
  }
  #nle-scratchpad-dropzone {
    margin: 12px 16px 0;
    padding: 10px 12px;
    border-radius: 16px;
    border: 1px dashed rgba(255, 215, 0, 0.14);
    color: rgba(226, 232, 240, 0.66);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    background: rgba(15, 23, 42, 0.26);
    transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  #nle-scratchpad[data-drop-active="true"] #nle-scratchpad-dropzone {
    border-color: rgba(255, 215, 0, 0.38);
    background: rgba(255, 215, 0, 0.08);
    color: #ffe79c;
  }
  #nle-scratchpad[data-active-tab="task"] #nle-scratchpad-dropzone,
  #nle-scratchpad[data-active-tab="task"] #nle-scratchpad-composer {
    display: none;
  }
  #nle-task-runtime-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 16px 16px 0;
  }
  .task-meta-pill {
    min-height: 28px;
    padding: 0 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(15, 23, 42, 0.46);
    color: rgba(226, 232, 240, 0.82);
    display: inline-flex;
    align-items: center;
    font: 600 10px/1 Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.04em;
  }
  #nle-scratchpad-panel-task {
    overflow-y: auto;
    gap: 12px;
    padding-bottom: 16px;
    scrollbar-width: thin;
    scrollbar-color: rgba(255, 215, 0, 0.16) transparent;
  }
  #nle-scratchpad-panel-task::-webkit-scrollbar {
    width: 5px;
  }
  #nle-scratchpad-panel-task::-webkit-scrollbar-thumb {
    background: rgba(255, 215, 0, 0.16);
    border-radius: 999px;
  }
  .task-card {
    margin: 0 16px;
    padding: 14px;
    border-radius: 20px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(15, 23, 42, 0.52);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .task-card h3 {
    margin: 0;
    color: #ffe79c;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .task-card p,
  .task-card ul,
  .task-card li {
    margin: 0;
    color: rgba(241, 245, 249, 0.88);
    font-size: 12px;
    line-height: 1.55;
  }
  .task-checklist {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .task-checklist-item {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px 12px;
    border-radius: 16px;
    background: rgba(2, 6, 23, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
  .task-checklist-dot {
    width: 14px;
    height: 14px;
    margin-top: 2px;
    border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    background: rgba(148, 163, 184, 0.16);
    flex: 0 0 auto;
  }
  .task-checklist-item[data-status="active"] .task-checklist-dot {
    background: rgba(255, 215, 0, 0.8);
    border-color: rgba(255, 215, 0, 0.9);
  }
  .task-checklist-item[data-status="completed"] .task-checklist-dot {
    background: rgba(16, 185, 129, 0.82);
    border-color: rgba(110, 231, 183, 0.9);
  }
  .task-checklist-item[data-status="blocked"] .task-checklist-dot {
    background: rgba(248, 113, 113, 0.82);
    border-color: rgba(252, 165, 165, 0.9);
  }
  .task-checklist-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .task-checklist-copy strong {
    font-size: 12px;
    color: rgba(248, 250, 252, 0.94);
  }
  .task-checklist-copy span {
    font-size: 10.5px;
    color: rgba(203, 213, 225, 0.68);
  }
  .task-timeline {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .task-timeline-entry {
    padding: 10px 12px;
    border-radius: 16px;
    background: rgba(2, 6, 23, 0.28);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }
  .task-timeline-entry strong {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: rgba(248, 250, 252, 0.94);
  }
  .task-brief-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  @keyframes scratchpadFade {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  #nle-scratchpad-composer {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    background: linear-gradient(180deg, rgba(15, 23, 42, 0.12), rgba(15, 23, 42, 0.36));
  }
  #nle-attachment-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .attachment-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    min-height: 32px;
    padding: 0 10px;
    border-radius: 999px;
    background: rgba(15, 23, 42, 0.58);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(241, 245, 249, 0.9);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  .attachment-chip[data-status="processing"],
  .attachment-chip[data-status="uploading"] {
    border-color: rgba(255, 215, 0, 0.26);
    color: #ffe79c;
  }
  .attachment-chip[data-status="ready"] {
    border-color: rgba(45, 212, 191, 0.22);
    color: #c7f9e9;
  }
  .attachment-chip[data-status="error"] {
    border-color: rgba(248, 113, 113, 0.24);
    color: #fecaca;
  }
  .attachment-chip .chip-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 220px;
  }
  .attachment-chip .chip-remove {
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: 0;
    font: inherit;
    opacity: 0.82;
  }
  #nle-composer-row {
    display: flex;
    align-items: flex-end;
    gap: 10px;
  }
  .composer-btn {
    width: 42px;
    min-width: 42px;
    height: 42px;
    border-radius: 16px;
    border: 1px solid rgba(255, 215, 0, 0.16);
    background: rgba(15, 23, 42, 0.62);
    color: #ffe79c;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .composer-btn:hover,
  .composer-btn[data-recording="true"] {
    border-color: rgba(255, 215, 0, 0.32);
    background: rgba(255, 215, 0, 0.1);
  }
  .composer-btn svg {
    width: 16px;
    height: 16px;
    display: block;
  }
  #nle-chat-input {
    flex: 1;
    min-width: 0;
    min-height: 42px;
    max-height: 168px;
    border-radius: 16px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 215, 0, 0.12);
    background: rgba(15, 23, 42, 0.58);
    color: rgba(248, 250, 252, 0.94);
    resize: none;
    overflow-y: hidden;
    font: 500 12.5px/1.45 Inter, "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    outline: none;
    transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  #nle-chat-input::placeholder {
    color: rgba(203, 213, 225, 0.42);
  }
  #nle-chat-input:focus {
    border-color: rgba(255, 215, 0, 0.26);
    box-shadow: 0 0 0 3px rgba(255, 215, 0, 0.08);
    background: rgba(15, 23, 42, 0.72);
  }
  #nle-chat-send {
    min-width: 84px;
    min-height: 42px;
    padding: 0 14px;
    border-radius: 16px;
    border: 1px solid rgba(255, 215, 0, 0.18);
    background:
      linear-gradient(180deg, rgba(255, 215, 0, 0.18), rgba(255, 215, 0, 0.08)),
      rgba(15, 23, 42, 0.74);
    color: #ffe79c;
    font: 600 11px/1 Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    cursor: pointer;
    transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    box-shadow:
      0 10px 24px rgba(0, 0, 0, 0.22),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }
  #nle-chat-send:hover {
    background:
      linear-gradient(180deg, rgba(255, 215, 0, 0.24), rgba(255, 215, 0, 0.12)),
      rgba(15, 23, 42, 0.8);
    border-color: rgba(255, 215, 0, 0.26);
    box-shadow:
      0 12px 28px rgba(0, 0, 0, 0.28),
      0 0 0 1px rgba(255, 215, 0, 0.06);
  }
  #nle-chat-send:active,
  #nle-chat-send.is-pressed {
    transform: scale(0.98);
  }
  #nle-chat-send[data-busy="true"] {
    cursor: progress;
    color: transparent;
    position: relative;
    pointer-events: none;
  }
  #nle-chat-send[data-busy="true"]::after {
    content: "";
    position: absolute;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid rgba(255, 215, 0, 0.32);
    border-top-color: #ffe79c;
    top: 50%;
    left: 50%;
    margin: -7px 0 0 -7px;
    animation: composerSpin 720ms linear infinite;
  }
  @keyframes composerSpin {
    to { transform: rotate(360deg); }
  }
  #nle-scratchpad[data-window-state="minimized"] #nle-scratchpad-content,
  #nle-scratchpad[data-window-state="minimized"] #nle-scratchpad-tabs,
  #nle-scratchpad[data-window-state="minimized"] #nle-scratchpad-panels,
  #nle-scratchpad[data-window-state="minimized"] #nle-scratchpad-dropzone,
  #nle-scratchpad[data-window-state="minimized"] #nle-scratchpad-composer {
    display: none;
  }
  #nle-scratchpad[data-window-state="fullscreen"] #nle-scratchpad-content {
    min-height: 0;
  }
  #nle-control-cluster {
    position: fixed;
    left: 24px;
    top: 92px;
    width: 250px;
    padding: 13px;
    border-radius: 24px;
    z-index: 2147483643;
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-family: Inter, "SF Pro Display", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    opacity: 0;
    transform: translateY(-8px);
    animation: overlayLift 280ms ${OMNI_MOTION_EASING} forwards;
    transition: transform 0.25s ${OMNI_MOTION_EASING}, opacity 0.25s ease;
  }
  #nle-control-cluster[data-visible="false"] {
    opacity: 0 !important;
    pointer-events: none !important;
    visibility: hidden !important;
    transform: translate(-28px, 24px) scale(0.92) !important;
    animation: none !important;
  }
  #nle-status-indicator {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 12px;
    border-radius: 16px;
    background: rgba(8, 145, 178, 0.09);
    border: 1px solid rgba(45, 212, 191, 0.16);
    color: #86efac;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease, border-color 0.15s ease, color 0.15s ease;
  }
  #nle-status-indicator::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: currentColor;
    box-shadow: 0 0 14px currentColor;
    animation: statusPulse 1.5s ease-in-out infinite;
  }
  #nle-status-indicator[data-state="human"] {
    background: rgba(255, 215, 0, 0.1);
    border-color: rgba(255, 215, 0, 0.22);
    color: #D4AF37;
  }
  #nle-status-indicator[data-state="paused"] {
    background: rgba(245, 158, 11, 0.1);
    border-color: rgba(245, 158, 11, 0.22);
    color: #fbbf24;
  }
  #nle-status-indicator[data-state="active"] {
    background: rgba(16, 185, 129, 0.09);
    border-color: rgba(16, 185, 129, 0.16);
    color: #86efac;
  }
  #nle-status-indicator[data-executing="true"] {
    box-shadow: 0 0 0 1px rgba(255, 215, 0, 0.08), 0 0 28px rgba(255, 215, 0, 0.14);
  }
  #nle-queue-counter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 38px;
    padding: 0 12px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(15, 23, 42, 0.42);
    color: rgba(241, 245, 249, 0.88);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  #nle-queue-counter strong {
    color: #ffe79c;
    font-size: 13px;
  }
  #nle-utility-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .utility-btn {
    min-height: 32px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(15, 23, 42, 0.42);
    color: rgba(241, 245, 249, 0.84);
    cursor: pointer;
    font: 700 9px/1 Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .utility-btn:hover {
    border-color: rgba(255, 215, 0, 0.2);
    color: #ffe79c;
  }
  #nle-export-tray {
    display: none;
    flex-direction: column;
    gap: 8px;
    padding: 6px 0 2px;
  }
  #nle-export-tray.visible {
    display: flex;
  }
  .export-link {
    width: 100%;
    min-height: 34px;
    border-radius: 14px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(15, 23, 42, 0.42);
    color: rgba(241, 245, 249, 0.9);
    cursor: pointer;
    font: 600 10px/1 Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
  }
  .export-link:hover {
    transform: translateY(-1px);
    border-color: rgba(255, 215, 0, 0.16);
    background: rgba(255, 215, 0, 0.06);
  }
  #nle-scratchpad-restore {
    display: none;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    border-radius: 999px;
    border: 1px solid rgba(255, 215, 0, 0.18);
    background: rgba(15, 23, 42, 0.54);
    color: #ffe79c;
    cursor: pointer;
    font: 700 10px/1 Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  #nle-scratchpad-restore.visible {
    display: inline-flex;
  }
  #nle-control-chip {
    position: fixed;
    left: 18px;
    bottom: 18px;
    z-index: 2147483643;
    display: none;
    align-items: center;
    justify-content: center;
    min-height: 38px;
    padding: 0 14px;
    border-radius: 999px;
    border: 1px solid rgba(255, 215, 0, 0.2);
    background: rgba(15, 23, 42, 0.72);
    color: #ffe79c;
    cursor: pointer;
    font: 700 10px/1 Inter, "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.28);
  }
  #nle-control-chip.visible {
    display: inline-flex;
  }
  #nle-badge[data-visible="false"] {
    opacity: 0 !important;
    pointer-events: none !important;
    visibility: hidden !important;
    transform: translate(-50%, -18px) scale(0.92) !important;
    animation: none !important;
  }
  @keyframes statusPulse {
    0%, 100% { opacity: 0.55; transform: scale(0.86); }
    50% { opacity: 1; transform: scale(1.12); }
  }
  .control-btn {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 50px;
    padding: 10px 11px;
    width: 100%;
    border-radius: 18px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)),
      rgba(15, 23, 42, 0.32);
    color: rgba(248, 250, 252, 0.88);
    cursor: pointer;
    user-select: none;
    text-align: left;
    transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .control-btn:hover {
    background:
      linear-gradient(180deg, rgba(255, 215, 0, 0.08), rgba(255, 215, 0, 0.03)),
      rgba(15, 23, 42, 0.58);
    border-color: rgba(255, 215, 0, 0.16);
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.22);
  }
  .control-btn:focus-visible {
    outline: none;
    box-shadow:
      0 0 0 3px rgba(255, 215, 0, 0.1),
      0 12px 30px rgba(0, 0, 0, 0.22);
  }
  .control-btn:active,
  .control-btn.is-pressed {
    transform: scale(0.98);
  }
  .control-btn.active {
    border-color: rgba(255, 215, 0, 0.22);
    background:
      linear-gradient(180deg, rgba(255, 215, 0, 0.12), rgba(255, 215, 0, 0.04)),
      rgba(15, 23, 42, 0.62);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.24);
  }
  .control-icon {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #D4AF37;
    background: rgba(255, 215, 0, 0.08);
    border: 1px solid rgba(255, 215, 0, 0.16);
    flex-shrink: 0;
  }
  .control-icon svg {
    width: 14px;
    height: 14px;
    display: block;
  }
  .control-copy {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
  }
  .control-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
    color: inherit;
  }
  .control-subtitle {
    font-size: 10px;
    font-weight: 500;
    color: rgba(226, 232, 240, 0.56);
  }
  #nle-keyboard-shell {
    position: fixed;
    left: 50%;
    bottom: 18px;
    width: min(1040px, calc(100vw - 48px));
    padding: 10px 12px 12px;
    border-radius: 24px;
    z-index: 2147483641;
    pointer-events: none;
    overflow-x: auto;
    opacity: 0;
    transform: translateX(-50%) translateY(18px);
    transition: opacity 0.2s ease, transform 0.2s ${OMNI_MOTION_EASING};
  }
  #nle-keyboard-shell.visible {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
  #nle-keyboard {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 940px;
  }
  .nle-kb-row {
    display: flex;
    gap: 5px;
    justify-content: center;
  }
  .nle-kb-key {
    min-width: 40px;
    height: 36px;
    padding: 0 8px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.07);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.04)),
      rgba(15, 23, 42, 0.48);
    color: rgba(248, 250, 252, 0.86);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: -0.01em;
    transition: background 0.15s ease, transform 0.15s ease, opacity 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .nle-kb-key.small { min-width: 36px; font-size: 10px; }
  .nle-kb-key.wide { min-width: 66px; font-size: 10px; }
  .nle-kb-key.xwide { min-width: 88px; font-size: 10px; }
  .nle-kb-key.mod { min-width: 58px; font-size: 10px; }
  .nle-kb-key.space { min-width: 248px; }
  .nle-kb-key.arrow { min-width: 42px; font-size: 11px; }
  .nle-kb-key.pressed {
    transform: translateY(1px) scale(0.98);
    border-color: rgba(255, 215, 0, 0.24);
    background:
      linear-gradient(180deg, rgba(255, 215, 0, 0.24), rgba(255, 215, 0, 0.08)),
      rgba(15, 23, 42, 0.58);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 6px 16px rgba(255, 215, 0, 0.12);
    color: #fff5d1;
  }
  #nle-magic-mouse {
    position: fixed;
    width: 14px;
    height: 26px;
    border-radius: 7px;
    background: rgba(15, 23, 42, 0.78);
    backdrop-filter: blur(20px) saturate(180%);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    border: 1px solid rgba(212, 175, 55, 0.3);
    box-shadow: 0 15px 35px rgba(2, 6, 23, 0.65), inset 0 1px 0 rgba(255, 255, 255, 0.08);
    pointer-events: none;
    z-index: 2147483647;
    transform: translate(-50%, -50%);
    transition: transform 0.2s ${OMNI_MOTION_EASING}, opacity 0.15s ease;
  }
  #nle-magic-mouse::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    background: radial-gradient(circle, rgba(255, 215, 0, 0.4) 0%, rgba(255, 215, 0, 0.12) 32%, transparent 72%);
    transform: translate(-50%, -50%) scale(0.55);
    opacity: 0;
    transition: transform 0.2s ${OMNI_MOTION_EASING}, opacity 0.2s ease-out;
    pointer-events: none;
  }
  #nle-magic-mouse.pulse {
    transform: translate(-50%, -50%) scale(1.15);
  }
  #nle-magic-mouse.pulse::after {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.2);
  }
  .nle-cursor-dot {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: #D4AF37;
    box-shadow: 0 0 10px rgba(212, 175, 55, 0.8);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .nle-cursor-led {
    position: absolute;
    top: 3px;
    left: 50%;
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: #4ade80;
    transform: translateX(-50%);
    pointer-events: none;
    animation: nleCursorLed 2s ease-in-out infinite;
  }
  @keyframes nleCursorLed {
    0%, 100% { opacity: 0.4; }
    50%      { opacity: 1; }
  }
  .som-badge {
    position: absolute;
    transform: translate(-100%, -100%);
    z-index: 2147483645;
    pointer-events: none;
    padding: 3px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: #1c1917;
    background: linear-gradient(180deg, #ffe79c 0%, #D4AF37 55%, #d4a514 100%);
    border: 1px solid rgba(255, 255, 255, 0.18);
    box-shadow: 0 0 18px rgba(255, 215, 0, 0.32);
  }
  .nle-ripple {
    position: fixed;
    width: 24px;
    height: 24px;
    border-radius: 999px;
    pointer-events: none;
    z-index: 2147483646;
    left: 0;
    top: 0;
    transform: translate(-50%, -50%) scale(0.2);
    border: 1px solid rgba(255, 215, 0, 0.42);
    background: radial-gradient(circle, rgba(255, 215, 0, 0.38) 0%, rgba(255, 215, 0, 0.14) 32%, transparent 72%);
    box-shadow: 0 0 30px rgba(255, 215, 0, 0.18);
    animation: nleRipple 200ms ease-out forwards;
  }
  .nle-spark {
    position: fixed;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    pointer-events: none;
    z-index: 2147483646;
    left: 0;
    top: 0;
    transform: translate(-50%, -50%) scale(0.35);
    background: radial-gradient(circle, rgba(255, 247, 214, 0.95) 0%, rgba(255, 215, 0, 0.84) 55%, rgba(255, 215, 0, 0) 100%);
    animation: nleSpark 220ms ease-out forwards;
  }
  @keyframes nleRipple {
    from { opacity: 0.92; transform: translate(-50%, -50%) scale(0.16); }
    to { opacity: 0; transform: translate(-50%, -50%) scale(4.2); }
  }
  @keyframes nleSpark {
    from { opacity: 0.95; transform: translate(-50%, -50%) scale(0.45); }
    to { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1.22); }
  }
  @keyframes overlayFade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @keyframes overlayLift {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes edgeSweep {
    0% { transform: translateX(-10%) scale(1.02); }
    50% { transform: translateX(10%) scale(1.04); }
    100% { transform: translateX(-10%) scale(1.02); }
  }
  @keyframes edgeHeartbeat {
    0%, 100% { opacity: 0.72; filter: blur(16px) saturate(138%); }
    40% { opacity: 1; filter: blur(18px) saturate(152%); }
    70% { opacity: 0.86; filter: blur(17px) saturate(145%); }
  }
  @keyframes badgePulse {
    0%, 100% { transform: translateX(-50%) scale(1); }
    50% { transform: translateX(-50%) scale(1.012); }
  }
  @media (max-width: 768px) {
    #nle-badge {
      top: 16px;
      min-width: 188px;
      padding: 6px 12px;
    }
    #nle-badge .major { font-size: 10px; }
    #nle-badge .nle { font-size: 9px; }
    #nle-control-cluster {
      left: 12px;
      right: 12px;
      top: 74px;
      width: auto;
      padding: 12px;
    }
    #nle-status-indicator {
      min-height: 36px;
      font-size: 10px;
    }
    .control-btn {
      min-height: 50px;
      padding: 10px 11px;
    }
    .control-subtitle {
      font-size: 9px;
    }
    #nle-scratchpad {
      left: 12px;
      right: 12px;
      top: 288px;
      width: auto;
      height: min(46vh, 460px);
      transform: translateY(18px);
    }
    #nle-scratchpad.visible {
      transform: translateY(0);
    }
    #nle-scratchpad[data-window-state="minimized"] {
      left: auto;
      right: 12px;
      bottom: 12px;
      top: auto;
      width: min(280px, calc(100vw - 24px));
      height: auto;
    }
    #nle-scratchpad[data-window-state="fullscreen"] {
      inset: 10px;
      left: 10px;
      right: 10px;
      top: 10px;
      bottom: 10px;
      width: auto;
      height: auto;
    }
    #nle-keyboard-shell {
      left: 8px;
      right: 8px;
      width: auto;
      transform: translateY(18px);
      padding: 10px;
    }
    #nle-keyboard-shell.visible {
      transform: translateY(0);
    }
    #nle-keyboard {
      min-width: 820px;
    }
    .nle-kb-key.space {
      min-width: 190px;
    }
    #nle-magic-mouse {
      width: 16px;
      height: 28px;
    }
  }
`;

const SCRATCHPAD_HTML = `
  <div id="nle-scratchpad-header">
    <div class="header-actions">
      <button id="nle-window-close" class="window-btn red" type="button" aria-label="Close scratchpad"></button>
      <button id="nle-window-minimize" class="window-btn yellow" type="button" aria-label="Minimize scratchpad"></button>
      <button id="nle-window-fullscreen" class="window-btn green" type="button" aria-label="Fullscreen scratchpad"></button>
    </div>
    <div class="scratchpad-title">
      <strong>EMPIRE COLLABORATION</strong>
      <span>Human + agent mission thread</span>
    </div>
  </div>
  <div id="nle-scratchpad-tabs" role="tablist" aria-label="Scratchpad views">
    <button id="nle-tab-live" class="scratchpad-tab active" type="button" data-tab="live" role="tab" aria-selected="true">Live</button>
    <button id="nle-tab-task" class="scratchpad-tab" type="button" data-tab="task" role="tab" aria-selected="false">Task</button>
  </div>
  <div id="nle-scratchpad-dropzone">Drop files, images, audio, or video here</div>
  <div id="nle-scratchpad-panels">
    <div id="nle-scratchpad-panel-live" class="scratchpad-panel active">
      <div id="nle-scratchpad-content"></div>
    </div>
    <div id="nle-scratchpad-panel-task" class="scratchpad-panel">
      <div id="nle-task-runtime-meta"></div>
      <section id="nle-task-objective" class="task-card"></section>
      <section id="nle-task-checklist" class="task-card"></section>
      <section id="nle-task-timeline" class="task-card"></section>
      <section id="nle-task-brief" class="task-card"></section>
    </div>
  </div>
  <div id="nle-scratchpad-composer">
    <div id="nle-attachment-strip"></div>
    <div id="nle-composer-row">
      <button id="nle-chat-file" class="composer-btn" type="button" aria-label="Upload files">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8.5 2.5V9.5C8.5 10.8807 7.38071 12 6 12C4.61929 12 3.5 10.8807 3.5 9.5V5.5C3.5 3.567 5.067 2 7 2C8.933 2 10.5 3.567 10.5 5.5V10C10.5 12.4853 8.48528 14.5 6 14.5C3.51472 14.5 1.5 12.4853 1.5 10V5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <button id="nle-chat-mic" class="composer-btn" type="button" aria-label="Record voice command">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="5.25" y="1.75" width="5.5" height="8.25" rx="2.75" stroke="currentColor" stroke-width="1.3"/>
          <path d="M3.5 7.75C3.5 10.2353 5.51472 12.25 8 12.25C10.4853 12.25 12.5 10.2353 12.5 7.75" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          <path d="M8 12.25V14.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          <path d="M5.5 14.5H10.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </button>
      <textarea id="nle-chat-input" rows="1" placeholder="Message the agent or dictate a command..." autocomplete="off"></textarea>
      <button id="nle-chat-send" type="button">Send</button>
    </div>
    <input id="nle-chat-file-input" type="file" multiple hidden />
  </div>
`;

const CONTROL_CLUSTER_HTML = `
  <div id="nle-status-indicator" data-state="active">Agent Active</div>
  <div id="nle-queue-counter"><span>Pending Queue</span><strong id="nle-queue-count">0</strong></div>
  <div id="nle-utility-row">
    <button id="nle-toggle-panel" class="utility-btn" type="button">Hide Panel</button>
    <button id="nle-toggle-badge" class="utility-btn" type="button">Hide Badge</button>
  </div>
  <button id="btn-takeover" class="control-btn" data-btn="takeover">
    <span class="control-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 2.25A2.75 2.75 0 1 1 8 7.75A2.75 2.75 0 0 1 8 2.25Z" stroke="currentColor" stroke-width="1.4"/>
        <path d="M3.25 13.25C3.8 10.9 5.56 9.75 8 9.75C10.44 9.75 12.2 10.9 12.75 13.25" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </span>
    <span class="control-copy">
      <span class="control-title">Take Over</span>
      <span class="control-subtitle">Hand controls to human</span>
    </span>
  </button>
  <button id="btn-pause" class="control-btn" data-btn="pause">
    <span class="control-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4.25" y="3" width="2.25" height="10" rx="1" fill="currentColor"/>
        <rect x="9.5" y="3" width="2.25" height="10" rx="1" fill="currentColor"/>
      </svg>
    </span>
    <span class="control-copy">
      <span class="control-title">Pause Mission</span>
      <span class="control-subtitle">Hold automation safely</span>
    </span>
  </button>
  <button id="btn-continue" class="control-btn active" data-btn="continue">
    <span class="control-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M5 3.5L12 8L5 12.5V3.5Z" fill="currentColor"/>
      </svg>
    </span>
    <span class="control-copy">
      <span class="control-title">Resume Mission</span>
      <span class="control-subtitle">Return to agent execution</span>
    </span>
  </button>
  <button id="btn-export" class="control-btn" data-btn="export">
    <span class="control-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M8 2.5V9.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        <path d="M5.25 7L8 9.75L10.75 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2.5 11.5H13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
      </svg>
    </span>
    <span class="control-copy">
      <span class="control-title">Export Logs</span>
      <span class="control-subtitle">View and download mission exports</span>
    </span>
  </button>
  <div id="nle-export-tray"></div>
  <button id="nle-scratchpad-restore" type="button">Restore Scratchpad</button>
`;

const CONTROL_CHIP_HTML = `
  <button id="nle-control-chip" type="button" aria-label="Restore Omni controls">
    Omni Controls
  </button>
`;

const KEYBOARD_HTML = `
  <div class="nle-kb-row">
    <div class="nle-kb-key wide small" data-k="Escape">esc</div>
    <div class="nle-kb-key small" data-k="F1">F1</div><div class="nle-kb-key small" data-k="F2">F2</div><div class="nle-kb-key small" data-k="F3">F3</div><div class="nle-kb-key small" data-k="F4">F4</div>
    <div class="nle-kb-key small" data-k="F5">F5</div><div class="nle-kb-key small" data-k="F6">F6</div><div class="nle-kb-key small" data-k="F7">F7</div><div class="nle-kb-key small" data-k="F8">F8</div>
    <div class="nle-kb-key small" data-k="F9">F9</div><div class="nle-kb-key small" data-k="F10">F10</div><div class="nle-kb-key small" data-k="F11">F11</div><div class="nle-kb-key small" data-k="F12">F12</div>
  </div>
  <div class="nle-kb-row">
    <div class="nle-kb-key" data-k="\`">\`</div><div class="nle-kb-key" data-k="1">1</div><div class="nle-kb-key" data-k="2">2</div><div class="nle-kb-key" data-k="3">3</div><div class="nle-kb-key" data-k="4">4</div><div class="nle-kb-key" data-k="5">5</div><div class="nle-kb-key" data-k="6">6</div><div class="nle-kb-key" data-k="7">7</div><div class="nle-kb-key" data-k="8">8</div><div class="nle-kb-key" data-k="9">9</div><div class="nle-kb-key" data-k="0">0</div><div class="nle-kb-key" data-k="-">-</div><div class="nle-kb-key" data-k="=">=</div><div class="nle-kb-key xwide small" data-k="Backspace">delete</div>
  </div>
  <div class="nle-kb-row">
    <div class="nle-kb-key wide small" data-k="Tab">tab</div><div class="nle-kb-key" data-k="q">q</div><div class="nle-kb-key" data-k="w">w</div><div class="nle-kb-key" data-k="e">e</div><div class="nle-kb-key" data-k="r">r</div><div class="nle-kb-key" data-k="t">t</div><div class="nle-kb-key" data-k="y">y</div><div class="nle-kb-key" data-k="u">u</div><div class="nle-kb-key" data-k="i">i</div><div class="nle-kb-key" data-k="o">o</div><div class="nle-kb-key" data-k="p">p</div><div class="nle-kb-key" data-k="[">[</div><div class="nle-kb-key" data-k="]">]</div><div class="nle-kb-key wide small" data-k="\\">\\</div>
  </div>
  <div class="nle-kb-row">
    <div class="nle-kb-key xwide small" data-k="CapsLock">caps</div><div class="nle-kb-key" data-k="a">a</div><div class="nle-kb-key" data-k="s">s</div><div class="nle-kb-key" data-k="d">d</div><div class="nle-kb-key" data-k="f">f</div><div class="nle-kb-key" data-k="g">g</div><div class="nle-kb-key" data-k="h">h</div><div class="nle-kb-key" data-k="j">j</div><div class="nle-kb-key" data-k="k">k</div><div class="nle-kb-key" data-k="l">l</div><div class="nle-kb-key" data-k=";">;</div><div class="nle-kb-key" data-k="'">'</div><div class="nle-kb-key xwide small" data-k="Enter">return</div>
  </div>
  <div class="nle-kb-row">
    <div class="nle-kb-key xwide small" data-k="ShiftLeft">shift</div><div class="nle-kb-key" data-k="z">z</div><div class="nle-kb-key" data-k="x">x</div><div class="nle-kb-key" data-k="c">c</div><div class="nle-kb-key" data-k="v">v</div><div class="nle-kb-key" data-k="b">b</div><div class="nle-kb-key" data-k="n">n</div><div class="nle-kb-key" data-k="m">m</div><div class="nle-kb-key" data-k=",">,</div><div class="nle-kb-key" data-k=".">.</div><div class="nle-kb-key" data-k="/">/</div><div class="nle-kb-key xwide small" data-k="ShiftRight">shift</div>
  </div>
  <div class="nle-kb-row">
    <div class="nle-kb-key mod small" data-k="Fn">fn</div><div class="nle-kb-key mod small" data-k="Control">control</div><div class="nle-kb-key mod small" data-k="Alt">option</div><div class="nle-kb-key mod small" data-k="MetaLeft">command</div><div class="nle-kb-key space small" data-k="Space">space</div><div class="nle-kb-key mod small" data-k="MetaRight">command</div><div class="nle-kb-key mod small" data-k="AltRight">option</div><div class="nle-kb-key arrow" data-k="ArrowLeft">◀</div><div class="nle-kb-key arrow" data-k="ArrowUp">▲</div><div class="nle-kb-key arrow" data-k="ArrowDown">▼</div><div class="nle-kb-key arrow" data-k="ArrowRight">▶</div>
  </div>
`;

export async function registerOmniUiLayer(context: BrowserContext): Promise<void> {
  const initScript = `
    (() => {
      const styleText = ${JSON.stringify(OMNI_UI_STYLE)};
      const scratchpadHtml = ${JSON.stringify(SCRATCHPAD_HTML)};
      const controlClusterHtml = ${JSON.stringify(CONTROL_CLUSTER_HTML)};
      const controlChipHtml = ${JSON.stringify(CONTROL_CHIP_HTML)};
      const keyboardHtml = ${JSON.stringify(KEYBOARD_HTML)};
      const shiftedKeyMap = {
        "~": "\`",
        "!": "1",
        "@": "2",
        "#": "3",
        "$": "4",
        "%": "5",
        "^": "6",
        "&": "7",
        "*": "8",
        "(": "9",
        ")": "0",
        "_": "-",
        "+": "=",
        "{": "[",
        "}": "]",
        "|": "\\\\",
        ":": ";",
        "\\"": "'",
        "<": ",",
        ">": ".",
        "?": "/",
      };

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function formatHeartbeatLabel(value) {
        if (!value) return "";
        const timestamp = typeof value === "string" ? Date.parse(value) : Number(value);
        if (!Number.isFinite(timestamp)) return "";
        const now = Date.now();
        const deltaSec = Math.max(0, Math.round((now - timestamp) / 1000));
        if (deltaSec < 45) return "just now";
        if (deltaSec < 3600) return Math.round(deltaSec / 60) + "m ago";
        if (deltaSec < 86400) return Math.round(deltaSec / 3600) + "h ago";
        return Math.round(deltaSec / 86400) + "d ago";
      }

      function getShadowRoot() {
        return window.nle_shadowRoot || null;
      }

      function getUiState() {
        if (!window.nle_uiState) {
          window.nle_uiState = {
            attachments: [],
            exportArtifacts: [],
            exportVisible: false,
            mediaChunks: [],
            mediaRecorder: null,
            recognition: null,
            recording: false,
            recordingStartedWithEmptyDraft: false,
            stream: null,
            transcriptDraft: "",
          };
        }
        return window.nle_uiState;
      }

      function getTaskBoard() {
        const controlState = window.nle_controlState || {};
        const taskBoard = controlState.taskBoard && typeof controlState.taskBoard === "object" ? controlState.taskBoard : {};
        return {
          activeTab: taskBoard.activeTab === "task" ? "task" : "live",
          brief: taskBoard.brief && typeof taskBoard.brief === "object" ? taskBoard.brief : null,
          checklist: Array.isArray(taskBoard.checklist) ? taskBoard.checklist : [],
          objective: typeof taskBoard.objective === "string" ? taskBoard.objective : "",
          timeline: Array.isArray(taskBoard.timeline) ? taskBoard.timeline : [],
        };
      }

      function setHostPageActive(active) {
        const container = document.getElementById("nle-visual-biometrics");
        if (!container) return;
        container.setAttribute("data-omni-page-active", active ? "true" : "false");
      }

      function resolveKeySelector(char) {
        if (char === " ") return '[data-k="Space"]';
        if (char === "\\\\b") return '[data-k="Backspace"]';
        if (char === "\\\\n") return '[data-k="Enter"]';
        if (char === "\\\\t") return '[data-k="Tab"]';
        if (char === "Shift") return '[data-k="ShiftLeft"]';
        const normalized = shiftedKeyMap[char] || (typeof char === "string" ? char.toLowerCase() : "");
        return normalized ? '[data-k="' + normalized.replaceAll('"', '\\\\"') + '"]' : null;
      }

      function appendScratchpad(text, type) {
        const root = getShadowRoot();
        if (!root) return;
        const scratchpadElement = root.querySelector("#nle-scratchpad");
        if (scratchpadElement && scratchpadElement.dataset.windowState !== "closed") {
          scratchpadElement.classList.add("visible");
        }
        const content = root.querySelector("#nle-scratchpad-content");
        if (!content) return;
        const now = new Date();
        const time = now.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
        const div = document.createElement("div");
        const safeType = type === "human" ? "human" : "ai";
        div.className = safeType === "human" ? "scratchpad-entry human" : "scratchpad-entry ai";
        div.innerHTML =
          '<div class="entry-header"><span class="entry-badge ' +
          safeType +
          '">' +
          (safeType === "human" ? "Human" : "Empire AI") +
          '</span><span class="entry-time">' +
          time +
          '</span></div><div class="entry-text">' +
          escapeHtml(text) +
          "</div>";
        content.appendChild(div);
        content.scrollTop = content.scrollHeight;
      }

      function animatePress(element) {
        if (!element) return;
        element.classList.add("is-pressed");
        setTimeout(function () {
          element.classList.remove("is-pressed");
        }, 160);
      }

      function autoSizeComposer() {
        const root = getShadowRoot();
        if (!root) return;
        const chatInput = root.querySelector("#nle-chat-input");
        if (!chatInput) return;
        const MIN_H = 42;
        const ROW_H = 22;
        const MAX_ROWS = 8;
        const MAX_H = MIN_H + ROW_H * (MAX_ROWS - 1);
        chatInput.style.height = MIN_H + "px";
        const nextHeight = Math.min(chatInput.scrollHeight, MAX_H);
        chatInput.style.height = Math.max(MIN_H, nextHeight) + "px";
        chatInput.style.overflowY = chatInput.scrollHeight > MAX_H ? "auto" : "hidden";
      }

      function bytesToBase64(bytes) {
        let binary = "";
        const chunkSize = 32768;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          const chunk = bytes.subarray(index, index + chunkSize);
          binary += String.fromCharCode.apply(null, chunk);
        }
        return btoa(binary);
      }

      function buildAttachmentPayload(file) {
        return file.arrayBuffer().then(function (buffer) {
          return {
            dataBase64: bytesToBase64(new Uint8Array(buffer)),
            id: file.name + "-" + file.size + "-" + file.lastModified + "-" + Math.random().toString(36).slice(2, 8),
            lastModified: file.lastModified || null,
            mimeType: file.type || null,
            name: file.name,
            size: file.size,
          };
        });
      }

      function renderAttachmentChips() {
        const root = getShadowRoot();
        if (!root) return;
        const strip = root.querySelector("#nle-attachment-strip");
        if (!strip) return;
        const state = getUiState();
        strip.innerHTML = "";
        state.attachments.forEach(function (attachment) {
          const chip = document.createElement("div");
          chip.className = "attachment-chip";
          chip.dataset.status = attachment.status || "uploading";

          const chipText = document.createElement("span");
          chipText.className = "chip-text";
          chipText.textContent =
            attachment.name + (attachment.statusLabel ? " · " + attachment.statusLabel : "");
          chip.appendChild(chipText);

          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "chip-remove";
          remove.textContent = "×";
          remove.addEventListener("click", function () {
            state.attachments = state.attachments.filter(function (item) {
              return item.id !== attachment.id;
            });
            renderAttachmentChips();
          });
          chip.appendChild(remove);

          strip.appendChild(chip);
        });
      }

      function base64ToBlob(base64, mimeType) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        return new Blob([bytes], { type: mimeType || "application/octet-stream" });
      }

      function renderExportTray() {
        const root = getShadowRoot();
        if (!root) return;
        const tray = root.querySelector("#nle-export-tray");
        if (!tray) return;
        const state = getUiState();
        tray.innerHTML = "";
        tray.classList.toggle("visible", Boolean(state.exportVisible && state.exportArtifacts.length));

        state.exportArtifacts.forEach(function (artifact) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "export-link";
          button.textContent = artifact.role === "overview-html" ? "Open Overview" : "Download " + artifact.filename;
          button.addEventListener("click", function () {
            const blob = base64ToBlob(artifact.contentBase64, artifact.mimeType);
            const url = URL.createObjectURL(blob);
            if (artifact.role === "overview-html") {
              window.open(url, "_blank", "noopener,noreferrer");
              setTimeout(function () {
                URL.revokeObjectURL(url);
              }, 60000);
              return;
            }
            const link = document.createElement("a");
            link.href = url;
            link.download = artifact.filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function () {
              URL.revokeObjectURL(url);
            }, 60000);
          });
          tray.appendChild(button);
        });
      }

      function renderTaskBoard() {
        const root = getShadowRoot();
        if (!root) return;
        const taskBoard = getTaskBoard();
        const runtimeProfile =
          window.nle_controlState && typeof window.nle_controlState.runtimeProfile === "object"
            ? window.nle_controlState.runtimeProfile
            : {};
        const runtimeMeta = root.querySelector("#nle-task-runtime-meta");
        const objective = root.querySelector("#nle-task-objective");
        const checklist = root.querySelector("#nle-task-checklist");
        const timeline = root.querySelector("#nle-task-timeline");
        const brief = root.querySelector("#nle-task-brief");
        if (!runtimeMeta || !objective || !checklist || !timeline || !brief) return;

        const metaPills = [];
        if (runtimeProfile && runtimeProfile.persistent === true) {
          metaPills.push("Managed Runtime");
          metaPills.push("Checkpoint Active");
          if (runtimeProfile.heartbeatAt) {
            const heartbeatLabel = formatHeartbeatLabel(runtimeProfile.heartbeatAt);
            if (heartbeatLabel) {
              metaPills.push("Heartbeat: " + heartbeatLabel);
            }
          }
        }
        runtimeMeta.innerHTML = metaPills
          .map(function (pill) {
            return '<span class="task-meta-pill">' + escapeHtml(pill) + "</span>";
          })
          .join("");
        runtimeMeta.style.display = metaPills.length ? "" : "none";

        objective.innerHTML =
          "<h3>Objective</h3><p>" +
          escapeHtml(taskBoard.objective || "Waiting for a declared mission objective.") +
          "</p>";

        checklist.innerHTML =
          "<h3>Checklist</h3><div class='task-checklist'>" +
          (taskBoard.checklist.length
            ? taskBoard.checklist
                .map(function (item) {
                  return (
                    '<div class="task-checklist-item" data-status="' +
                    escapeHtml(item.status || "pending") +
                    '">' +
                    '<span class="task-checklist-dot"></span>' +
                    '<div class="task-checklist-copy"><strong>' +
                    escapeHtml(item.label || "Pending step") +
                    "</strong>" +
                    (item.detail ? "<span>" + escapeHtml(item.detail) + "</span>" : "") +
                    "</div></div>"
                  );
                })
                .join("")
            : '<p>No checklist has been published yet.</p>') +
          "</div>";

        const timelineEntries = taskBoard.timeline.slice(-6).reverse();
        timeline.innerHTML =
          "<h3>Progress</h3><div class='task-timeline'>" +
          (timelineEntries.length
            ? timelineEntries
                .map(function (entry) {
                  return (
                    '<div class="task-timeline-entry" data-status="' +
                    escapeHtml(entry.status || "success") +
                    '"><strong>' +
                    escapeHtml(entry.label || "Update") +
                    "</strong><p>" +
                    escapeHtml(entry.detail || "") +
                    "</p></div>"
                  );
                })
                .join("")
            : '<p>No progress updates yet.</p>') +
          "</div>";

        const summaryLines =
          taskBoard.brief && Array.isArray(taskBoard.brief.summaryLines) ? taskBoard.brief.summaryLines : [];
        brief.innerHTML =
          "<h3>Executive Brief</h3>" +
          (taskBoard.brief
            ? "<p><strong>" +
              escapeHtml(taskBoard.brief.headline || "Mission summary") +
              "</strong></p><div class='task-brief-list'>" +
              summaryLines
                .map(function (line) {
                  return "<p>" + escapeHtml(line) + "</p>";
                })
                .join("") +
              "</div>"
            : "<p>Brief will populate as the mission progresses.</p>");
      }

      function setScratchpadWindowStateLocal(nextState, options) {
        const root = getShadowRoot();
        if (!root) return;
        const state = getUiState();
        const scratchpad = root.querySelector("#nle-scratchpad");
        const restore = root.querySelector("#nle-scratchpad-restore");
        if (!scratchpad || !restore) return;
        const normalized =
          nextState === "closed" || nextState === "fullscreen" || nextState === "minimized" ? nextState : "open";
        scratchpad.dataset.windowState = normalized;
        scratchpad.classList.toggle("visible", normalized !== "closed");
        restore.classList.toggle("visible", normalized === "closed");
        if (window.nle_controlState) {
          window.nle_controlState.scratchpadWindowState = normalized;
        }
        if (!options || options.sync !== false) {
          Promise.resolve(
            window.nle_setScratchpadWindowState && window.nle_setScratchpadWindowState(normalized),
          ).catch(function () {});
        }
        renderExportTray();
        autoSizeComposer();
      }

      function setScratchpadTabLocal(nextTab, options) {
        const root = getShadowRoot();
        if (!root) return;
        const scratchpad = root.querySelector("#nle-scratchpad");
        const liveTab = root.querySelector("#nle-tab-live");
        const taskTab = root.querySelector("#nle-tab-task");
        const livePanel = root.querySelector("#nle-scratchpad-panel-live");
        const taskPanel = root.querySelector("#nle-scratchpad-panel-task");
        if (!scratchpad || !liveTab || !taskTab || !livePanel || !taskPanel) return;
        const normalized = nextTab === "task" ? "task" : "live";
        scratchpad.dataset.activeTab = normalized;
        liveTab.classList.toggle("active", normalized === "live");
        liveTab.setAttribute("aria-selected", normalized === "live" ? "true" : "false");
        taskTab.classList.toggle("active", normalized === "task");
        taskTab.setAttribute("aria-selected", normalized === "task" ? "true" : "false");
        livePanel.classList.toggle("active", normalized === "live");
        taskPanel.classList.toggle("active", normalized === "task");
        if (window.nle_controlState) {
          window.nle_controlState.scratchpadActiveTab = normalized;
          if (window.nle_controlState.taskBoard) {
            window.nle_controlState.taskBoard.activeTab = normalized;
          }
        }
        renderTaskBoard();
        if (!options || options.sync !== false) {
          Promise.resolve(
            window.nle_setScratchpadTab && window.nle_setScratchpadTab(normalized),
          ).catch(function () {});
        }
      }

      function applyHudVisibility(controlState) {
        const root = getShadowRoot();
        if (!root) return;
        const cluster = root.querySelector("#nle-control-cluster");
        const badge = root.querySelector("#nle-badge");
        const chip = root.querySelector("#nle-control-chip");
        const panelToggle = root.querySelector("#nle-toggle-panel");
        const badgeToggle = root.querySelector("#nle-toggle-badge");
        const panelVisible = controlState.controlPanelVisible !== false;
        const badgeVisible = controlState.badgeVisible !== false;

        if (cluster) {
          cluster.dataset.visible = panelVisible ? "true" : "false";
        }
        if (badge) {
          badge.dataset.visible = badgeVisible ? "true" : "false";
        }
        if (chip) {
          chip.classList.toggle("visible", !panelVisible);
        }
        if (panelToggle) {
          panelToggle.textContent = panelVisible ? "Hide Panel" : "Show Panel";
        }
        if (badgeToggle) {
          badgeToggle.textContent = badgeVisible ? "Hide Badge" : "Show Badge";
        }
      }

      function attachmentSummaryForMessage(attachment) {
        const parts = ["- " + attachment.name];
        if (attachment.summary) {
          parts[0] += " (" + attachment.summary + ")";
        }
        if (attachment.previewText) {
          parts.push(attachment.previewText);
        }
        if (attachment.storagePath) {
          parts.push("Local artifact: " + attachment.storagePath);
        }
        return parts.join("\\n");
      }

      function submitComposer() {
        const root = getShadowRoot();
        if (!root) return;
        const state = getUiState();
        const chatInput = root.querySelector("#nle-chat-input");
        if (!chatInput) return;
        const sendBtn = root.querySelector("#nle-chat-send");
        if (sendBtn && sendBtn.dataset.busy === "true") return;
        const message = String(chatInput.value || "").trim();
        const readyAttachments = state.attachments.filter(function (attachment) {
          return attachment.status === "ready";
        });
        if (!message && readyAttachments.length === 0) return;

        const visibleMessage =
          message ||
          "Sent " + readyAttachments.length + " attachment" + (readyAttachments.length === 1 ? "" : "s") + " for review.";
        appendScratchpad(visibleMessage, "human");

        const attachmentBlock = readyAttachments.length
          ? "\\n\\n[Scratchpad Attachments]\\n" +
            readyAttachments.map(function (attachment) {
              return attachmentSummaryForMessage(attachment);
            }).join("\\n\\n")
          : "";

        const outbound = (message || "Review the attached files and continue the mission.") + attachmentBlock;
        chatInput.value = "";
        state.attachments = [];
        renderAttachmentChips();
        autoSizeComposer();

        if (sendBtn) {
          sendBtn.dataset.busy = "true";
          sendBtn.setAttribute("aria-busy", "true");
        }
        Promise.resolve(window.nle_humanMessage && window.nle_humanMessage(outbound))
          .catch(function () {
            appendScratchpad("Awaiting agent bridge recovery.", "ai");
          })
          .then(function () {
            if (sendBtn) {
              sendBtn.dataset.busy = "false";
              sendBtn.removeAttribute("aria-busy");
            }
          });
      }

      function applyTranscription(transcript, shouldAutoSubmit) {
        const root = getShadowRoot();
        if (!root) return;
        const chatInput = root.querySelector("#nle-chat-input");
        if (!chatInput) return;
        const normalized = String(transcript || "").trim();
        if (!normalized) return;
        if (chatInput.value.trim()) {
          chatInput.value = String(chatInput.value).trimEnd() + "\\n" + normalized;
        } else {
          chatInput.value = normalized;
        }
        autoSizeComposer();
        chatInput.focus();
        if (shouldAutoSubmit) {
          submitComposer();
        }
      }

      function stopRecording() {
        const root = getShadowRoot();
        const state = getUiState();
        const micButton = root ? root.querySelector("#nle-chat-mic") : null;
        state.recording = false;
        if (micButton) {
          micButton.dataset.recording = "false";
        }
        if (state.recognition) {
          try {
            state.recognition.stop();
          } catch (_) {}
        }
        if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
          try {
            state.mediaRecorder.stop();
          } catch (_) {}
        }
      }

      async function startRecording() {
        const root = getShadowRoot();
        if (!root) return;
        const state = getUiState();
        const micButton = root.querySelector("#nle-chat-mic");
        const chatInput = root.querySelector("#nle-chat-input");
        if (!micButton || !chatInput || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          appendScratchpad("Microphone is unavailable in this runtime.", "ai");
          return;
        }

        try {
          state.recording = true;
          state.stream = null;
          state.mediaChunks = [];
          state.transcriptDraft = "";
          state.recordingStartedWithEmptyDraft = !String(chatInput.value || "").trim();
          micButton.dataset.recording = "true";
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          state.stream = stream;

          const mediaRecorder = new MediaRecorder(stream);
          state.mediaRecorder = mediaRecorder;
          mediaRecorder.addEventListener("dataavailable", function (event) {
            if (event.data && event.data.size > 0) {
              state.mediaChunks.push(event.data);
            }
          });
          mediaRecorder.addEventListener("stop", function () {
            const chunks = state.mediaChunks.slice();
            const hasDraftTranscript = String(state.transcriptDraft || "").trim();
            const finalize = function (transcript, warning) {
              state.recording = false;
              state.mediaRecorder = null;
              state.mediaChunks = [];
              if (state.stream) {
                state.stream.getTracks().forEach(function (track) {
                  track.stop();
                });
              }
              state.stream = null;
              micButton.dataset.recording = "false";
              if (warning) {
                appendScratchpad(warning, "ai");
              }
              applyTranscription(
                transcript,
                state.recordingStartedWithEmptyDraft && getUiState().attachments.length === 0,
              );
            };

            if (hasDraftTranscript) {
              finalize(state.transcriptDraft, "");
              return;
            }

            if (!chunks.length) {
              finalize("", "No audio was captured.");
              return;
            }

            new Blob(chunks, { type: mediaRecorder.mimeType || "audio/webm" })
              .arrayBuffer()
              .then(function (buffer) {
                return Promise.resolve(
                  window.nle_transcribeScratchpadAudio &&
                    window.nle_transcribeScratchpadAudio(
                      bytesToBase64(new Uint8Array(buffer)),
                      mediaRecorder.mimeType || "audio/webm",
                      "scratchpad-mic.webm",
                    ),
                );
              })
              .then(function (result) {
                finalize(result && result.transcript ? result.transcript : "", result && result.warning ? result.warning : "");
              })
              .catch(function () {
                finalize("", "Audio captured, but transcription failed in this runtime.");
              });
          });

          const RecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition || null;
          if (RecognitionCtor) {
            const recognition = new RecognitionCtor();
            state.recognition = recognition;
            recognition.continuous = false;
            recognition.interimResults = true;
            recognition.lang = "en-US";
            recognition.onresult = function (event) {
              let interim = "";
              let finalText = "";
              for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const result = event.results[index];
                const transcript = result && result[0] ? result[0].transcript : "";
                if (result && result.isFinal) {
                  finalText += transcript;
                } else {
                  interim += transcript;
                }
              }
              state.transcriptDraft = (finalText || interim).trim();
              if (state.transcriptDraft) {
                chatInput.value = state.transcriptDraft;
                autoSizeComposer();
              }
            };
            recognition.onerror = function () {};
            recognition.onend = function () {
              state.recognition = null;
            };
            try {
              recognition.start();
            } catch (_) {}
          }

          mediaRecorder.start();
        } catch (_) {
          state.recording = false;
          state.stream = null;
          state.mediaRecorder = null;
          state.mediaChunks = [];
          micButton.dataset.recording = "false";
          appendScratchpad("Microphone access was denied.", "ai");
        }
      }

      function setControlState(input) {
        const root = getShadowRoot();
        if (!root) return;
        const controlState = Object.assign(
          {
            badgeVisible: true,
            controlPanelVisible: true,
            executing: false,
            humanControl: false,
            paused: false,
            pendingHumanMessages: 0,
            runtimeProfile: {
              continuityMode: "warm-state",
              heartbeatAt: null,
              persistent: false,
              provider: "standalone-runtime",
              operatorSessionId: null,
            },
            scratchpadActiveTab: "live",
            scratchpadWindowState: "open",
            sessionId: null,
            taskBoard: {
              activeTab: "live",
              brief: null,
              checklist: [],
              objective: null,
              timeline: [],
            },
          },
          window.nle_controlState || {},
          input || {},
        );
        window.nle_controlState = controlState;

        const btnTakeover = root.querySelector("#btn-takeover");
        const btnPause = root.querySelector("#btn-pause");
        const btnContinue = root.querySelector("#btn-continue");
        const statusIndicator = root.querySelector("#nle-status-indicator");
        const queueCount = root.querySelector("#nle-queue-count");
        const frame = root.querySelector("#nle-frame");
        const continueTitle = btnContinue && btnContinue.querySelector(".control-title");
        const continueSubtitle = btnContinue && btnContinue.querySelector(".control-subtitle");

        if (statusIndicator) {
          if (controlState.humanControl) {
            statusIndicator.textContent = "Human Control";
            statusIndicator.dataset.state = "human";
          } else if (controlState.paused) {
            statusIndicator.textContent = "Mission Paused";
            statusIndicator.dataset.state = "paused";
          } else if (controlState.executing) {
            statusIndicator.textContent = "Agent Executing";
            statusIndicator.dataset.state = "active";
          } else {
            statusIndicator.textContent = "Agent Active";
            statusIndicator.dataset.state = "active";
          }
          statusIndicator.dataset.executing = controlState.executing ? "true" : "false";
        }

        if (queueCount) {
          queueCount.textContent = String(controlState.pendingHumanMessages || 0);
        }
        if (frame) {
          frame.dataset.executing = controlState.executing ? "true" : "false";
        }

        if (btnTakeover) {
          btnTakeover.style.display = controlState.humanControl ? "none" : "flex";
        }
        if (btnPause) {
          btnPause.style.display = controlState.paused || controlState.humanControl ? "none" : "flex";
          btnPause.classList.toggle("active", Boolean(controlState.paused));
        }
        if (btnContinue) {
          btnContinue.style.display = controlState.paused || controlState.humanControl ? "flex" : "none";
          if (continueTitle) {
            continueTitle.textContent = controlState.humanControl ? "Resume AI" : "Resume Mission";
          }
          if (continueSubtitle) {
            continueSubtitle.textContent = controlState.humanControl
              ? "Return to automation"
              : "Continue task flow";
          }
        }

        setScratchpadWindowStateLocal(controlState.scratchpadWindowState || "open", { sync: false });
        setScratchpadTabLocal(controlState.scratchpadActiveTab || "live", { sync: false });
        applyHudVisibility(controlState);
        renderTaskBoard();
      }

      function setPageActive(active) {
        window.nle_pageActive = !!active;
        setHostPageActive(window.nle_pageActive);
      }

      function pulseCursor() {
        const root = getShadowRoot();
        if (!root) return;
        const cursor = root.querySelector("#nle-magic-mouse");
        if (!cursor) return;
        cursor.classList.remove("pulse");
        void cursor.offsetWidth;
        cursor.classList.add("pulse");
        setTimeout(function () {
          cursor.classList.remove("pulse");
        }, 220);
      }

      function spawnRipple(x, y) {
        const root = getShadowRoot();
        if (!root) return;
        const ripple = document.createElement("div");
        ripple.className = "nle-ripple";
        ripple.style.left = x + "px";
        ripple.style.top = y + "px";
        root.appendChild(ripple);
        setTimeout(function () {
          ripple.remove();
        }, 700);
      }

      function spawnSparkBurst(x, y) {
        const root = getShadowRoot();
        if (!root) return;
        const vectors = [
          [-18, -14],
          [18, -10],
          [-15, 16],
          [20, 18],
        ];
        vectors.forEach(function (vector) {
          const spark = document.createElement("div");
          spark.className = "nle-spark";
          spark.style.left = x + "px";
          spark.style.top = y + "px";
          spark.style.setProperty("--dx", vector[0] + "px");
          spark.style.setProperty("--dy", vector[1] + "px");
          root.appendChild(spark);
          setTimeout(function () {
            spark.remove();
          }, 650);
        });
      }

      window.nle_injectUI = function () {
        const existing = document.getElementById("nle-visual-biometrics");
        const hasHelpers =
          typeof window.writeToScratchpad === "function" &&
          typeof window.mapSoM === "function" &&
          typeof window.nleBroadcastKey === "function" &&
          typeof window.nle_setControlState === "function";
        if (existing && hasHelpers) {
          if (window.nle_controlState) {
            window.nle_setControlState(window.nle_controlState);
          }
          if (typeof window.nle_setPageActive === "function") {
            window.nle_setPageActive(window.nle_pageActive === true);
          } else {
            setHostPageActive(window.nle_pageActive === true);
          }
          renderAttachmentChips();
          renderExportTray();
          autoSizeComposer();
          return;
        }
        if (existing && !hasHelpers) {
          existing.remove();
        }

        const container = document.createElement("div");
        container.id = "nle-visual-biometrics";

        const shadowRoot = container.attachShadow({ mode: "closed" });
        const style = document.createElement("style");
        style.innerHTML = styleText;
        shadowRoot.appendChild(style);

        const frame = document.createElement("div");
        frame.id = "nle-frame";
        shadowRoot.appendChild(frame);

        const badge = document.createElement("div");
        badge.id = "nle-badge";
        badge.innerHTML =
          '<div class="major">EMPIRE OMNI BROWSER™</div><div class="nle">Next Level Empire™</div>';
        shadowRoot.appendChild(badge);

        const scratchpad = document.createElement("div");
        scratchpad.id = "nle-scratchpad";
        scratchpad.dataset.activeTab = "live";
        scratchpad.innerHTML = scratchpadHtml;
        shadowRoot.appendChild(scratchpad);

        const cluster = document.createElement("div");
        cluster.id = "nle-control-cluster";
        cluster.innerHTML = controlClusterHtml;
        shadowRoot.appendChild(cluster);

        const controlChip = document.createElement("div");
        controlChip.innerHTML = controlChipHtml;
        shadowRoot.appendChild(controlChip.firstElementChild);

        const keyboardShell = document.createElement("div");
        keyboardShell.id = "nle-keyboard-shell";
        keyboardShell.innerHTML = '<div id="nle-keyboard">' + keyboardHtml + "</div>";
        shadowRoot.appendChild(keyboardShell);

        const mouse = document.createElement("div");
        mouse.id = "nle-magic-mouse";
        mouse.innerHTML = '<div class="nle-cursor-dot"></div><div class="nle-cursor-led"></div>';
        shadowRoot.appendChild(mouse);

        document.documentElement.appendChild(container);
        window.nle_shadowRoot = shadowRoot;
        window.nle_setPageActive = setPageActive;
        window.nle_setScratchpadWindowStateLocal = setScratchpadWindowStateLocal;

        window.writeToScratchpad = function (text, type) {
          appendScratchpad(String(text ?? ""), type === "human" ? "human" : "ai");
        };
        window.nle_appendScratchpad = window.writeToScratchpad;
        window.nle_setControlState = setControlState;
        window.nle_setPageActive(window.nle_pageActive === true);

        window.nleBroadcastKey = function (char, isPress) {
          const kbShell = shadowRoot.querySelector("#nle-keyboard-shell");
          if (!kbShell) return;

          if (isPress && !kbShell.classList.contains("visible")) {
            kbShell.classList.add("visible");
            window.nle_keyboardVisible = true;
          }

          const keySelector = resolveKeySelector(char);
          if (!keySelector) return;

          const keyEl = shadowRoot.querySelector(keySelector);
          if (keyEl && isPress) {
            keyEl.classList.add("pressed");
            setTimeout(function () {
              keyEl.classList.remove("pressed");
            }, 150);
          }
        };

        window.nle_keyboardTimeout = null;
        window.nle_scheduleKeyboardHide = function () {
          if (window.nle_keyboardTimeout) clearTimeout(window.nle_keyboardTimeout);
          window.nle_keyboardTimeout = setTimeout(function () {
            const kb = shadowRoot.querySelector("#nle-keyboard-shell");
            if (kb) {
              kb.classList.remove("visible");
              window.nle_keyboardVisible = false;
            }
          }, 2000);
        };

        const btnTakeover = shadowRoot.querySelector("#btn-takeover");
        const btnPause = shadowRoot.querySelector("#btn-pause");
        const btnContinue = shadowRoot.querySelector("#btn-continue");
        const btnExport = shadowRoot.querySelector("#btn-export");
        const btnTogglePanel = shadowRoot.querySelector("#nle-toggle-panel");
        const btnToggleBadge = shadowRoot.querySelector("#nle-toggle-badge");
        const btnRestore = shadowRoot.querySelector("#nle-scratchpad-restore");
        const btnControlChip = shadowRoot.querySelector("#nle-control-chip");
        const chatInput = shadowRoot.querySelector("#nle-chat-input");
        const chatSend = shadowRoot.querySelector("#nle-chat-send");
        const fileButton = shadowRoot.querySelector("#nle-chat-file");
        const micButton = shadowRoot.querySelector("#nle-chat-mic");
        const fileInput = shadowRoot.querySelector("#nle-chat-file-input");
        const closeButton = shadowRoot.querySelector("#nle-window-close");
        const minimizeButton = shadowRoot.querySelector("#nle-window-minimize");
        const fullscreenButton = shadowRoot.querySelector("#nle-window-fullscreen");
        const header = shadowRoot.querySelector("#nle-scratchpad-header");
        const liveTab = shadowRoot.querySelector("#nle-tab-live");
        const taskTab = shadowRoot.querySelector("#nle-tab-task");

        if (chatInput) {
          chatInput.addEventListener("input", function () {
            autoSizeComposer();
          });
          chatInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitComposer();
            }
          });
          autoSizeComposer();
        }

        if (chatSend) {
          chatSend.addEventListener(
            "click",
            function (event) {
              event.stopPropagation();
              event.preventDefault();
              submitComposer();
            },
            true,
          );
        }

        if (fileButton && fileInput) {
          fileButton.addEventListener("click", function () {
            fileInput.click();
          });
          fileInput.addEventListener("change", function () {
            const files = Array.from(fileInput.files || []);
            if (!files.length) return;
            processFileList(files);
            fileInput.value = "";
          });
        }

        async function processFileList(files) {
          const state = getUiState();
          if (!files || !files.length) return;
          appendScratchpad(
            "Processing " + files.length + " scratchpad attachment" + (files.length === 1 ? "" : "s") + ".",
            "ai",
          );

          for (const file of files) {
            const pending = {
              id: file.name + "-" + file.size + "-" + file.lastModified,
              name: file.name,
              status: "uploading",
              statusLabel: "uploading",
            };
            state.attachments.push(pending);
            renderAttachmentChips();

            try {
              const payload = await buildAttachmentPayload(file);
              pending.id = payload.id;
              pending.status = "processing";
              pending.statusLabel = "processing";
              renderAttachmentChips();
              const results = await Promise.resolve(
                window.nle_processScratchpadFiles && window.nle_processScratchpadFiles([payload]),
              );
              const result = Array.isArray(results) ? results[0] : null;
              if (result && result.status === "ready") {
                pending.previewText = result.previewText || "";
                pending.status = "ready";
                pending.statusLabel = "ready";
                pending.storagePath = result.storagePath || "";
                pending.summary = result.summary || "";
              } else {
                pending.status = "error";
                pending.statusLabel = result && result.error ? "error" : "failed";
                pending.previewText = result && result.error ? result.error : "";
              }
            } catch (_) {
              pending.status = "error";
              pending.statusLabel = "failed";
            }
            renderAttachmentChips();
          }
        }

        if (micButton) {
          micButton.addEventListener("click", function () {
            const state = getUiState();
            if (state.recording) {
              stopRecording();
              return;
            }
            startRecording();
          });
        }

        if (closeButton) {
          closeButton.addEventListener("click", function (event) {
            event.stopPropagation();
            event.preventDefault();
            setScratchpadWindowStateLocal("closed");
          });
        }

        if (minimizeButton) {
          minimizeButton.addEventListener("click", function (event) {
            event.stopPropagation();
            event.preventDefault();
            setScratchpadWindowStateLocal("minimized");
          });
        }

        if (fullscreenButton) {
          fullscreenButton.addEventListener("click", function (event) {
            event.stopPropagation();
            event.preventDefault();
            const current =
              (window.nle_controlState && window.nle_controlState.scratchpadWindowState) || "open";
            setScratchpadWindowStateLocal(current === "fullscreen" ? "open" : "fullscreen");
          });
        }

        if (header) {
          header.addEventListener("click", function (event) {
            const target = event.target;
            if (target && target.closest && target.closest(".window-btn")) {
              return;
            }
            const current =
              (window.nle_controlState && window.nle_controlState.scratchpadWindowState) || "open";
            if (current === "minimized") {
              setScratchpadWindowStateLocal("open");
            }
          });
        }

        if (btnRestore) {
          btnRestore.addEventListener("click", function () {
            setScratchpadWindowStateLocal("open");
          });
        }

        if (liveTab) {
          liveTab.addEventListener("click", function () {
            setScratchpadTabLocal("live");
          });
        }

        if (taskTab) {
          taskTab.addEventListener("click", function () {
            setScratchpadTabLocal("task");
          });
        }

        if (btnExport) {
          btnExport.addEventListener(
            "click",
            function (event) {
              event.stopPropagation();
              event.preventDefault();
              animatePress(btnExport);
              const state = getUiState();
              if (state.exportArtifacts.length) {
                state.exportVisible = !state.exportVisible;
                renderExportTray();
                return;
              }
              Promise.resolve(window.nle_exportLogs && window.nle_exportLogs())
                .then(function (bundle) {
                  state.exportArtifacts = Array.isArray(bundle && bundle.artifacts) ? bundle.artifacts : [];
                  state.exportVisible = true;
                  renderExportTray();
                  appendScratchpad("Export bundle ready for overview + download.", "ai");
                })
                .catch(function () {
                  appendScratchpad("Export bundle failed to generate.", "ai");
                });
            },
            true,
          );
        }

        if (btnTogglePanel) {
          btnTogglePanel.addEventListener("click", function () {
            var __cs = window.nle_controlState || {};
            Promise.resolve(
              window.nle_setHudPreferences &&
                window.nle_setHudPreferences({
                  controlPanelVisible: __cs.controlPanelVisible === false,
                }),
            ).catch(function () {});
          });
        }

        if (btnToggleBadge) {
          btnToggleBadge.addEventListener("click", function () {
            var __cs = window.nle_controlState || {};
            Promise.resolve(
              window.nle_setHudPreferences &&
                window.nle_setHudPreferences({
                  badgeVisible: __cs.badgeVisible === false,
                }),
            ).catch(function () {});
          });
        }

        if (btnControlChip) {
          btnControlChip.addEventListener("click", function () {
            Promise.resolve(
              window.nle_setHudPreferences &&
                window.nle_setHudPreferences({
                  controlPanelVisible: true,
                }),
            ).catch(function () {});
          });
        }

        window.addEventListener(
          "keydown",
          function (event) {
            if (event.repeat || event.altKey || !(event.metaKey || event.ctrlKey) || !event.shiftKey) {
              return;
            }

            const key = String(event.key || "").toLowerCase();
            var __cs = window.nle_controlState || {};

            if (key === "b") {
              event.preventDefault();
              if (btnToggleBadge) {
                animatePress(btnToggleBadge);
              }
              Promise.resolve(
                window.nle_setHudPreferences &&
                  window.nle_setHudPreferences({
                    badgeVisible: __cs.badgeVisible === false,
                  }),
              ).catch(function () {});
              return;
            }

            if (key === "p") {
              event.preventDefault();
              if (btnTogglePanel) {
                animatePress(btnTogglePanel);
              }
              Promise.resolve(
                window.nle_setHudPreferences &&
                  window.nle_setHudPreferences({
                    controlPanelVisible: __cs.controlPanelVisible === false,
                  }),
              ).catch(function () {});
            }
          },
          true,
        );

        // Cmd+K / Ctrl+K — focus composer input. Esc — minimize scratchpad.
        window.addEventListener(
          "keydown",
          function (event) {
            if (event.repeat || event.altKey) return;
            const key = String(event.key || "").toLowerCase();

            if ((event.metaKey || event.ctrlKey) && !event.shiftKey && key === "k") {
              event.preventDefault();
              event.stopPropagation();
              Promise.resolve(
                window.nle_setScratchpadWindowStateLocal &&
                  window.nle_setScratchpadWindowStateLocal("open"),
              ).catch(function () {});
              const root = getShadowRoot();
              const focusTarget = root ? root.querySelector("#nle-chat-input") : null;
              if (focusTarget) {
                try {
                  focusTarget.focus();
                } catch (_) {}
              }
              return;
            }

            if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
              const root = getShadowRoot();
              if (!root) return;
              const scratchpad = root.querySelector("#nle-scratchpad");
              if (!scratchpad) return;
              const windowState = scratchpad.getAttribute("data-window-state") || "open";
              if (windowState === "minimized" || windowState === "closed") return;
              const activeEl = document.activeElement;
              const tag = activeEl && activeEl.tagName ? activeEl.tagName.toUpperCase() : "";
              if (tag === "INPUT" || tag === "TEXTAREA" || (activeEl && activeEl.isContentEditable)) {
                // Don't steal Esc from native form editors unless they're our composer.
                const scratchpadContains = scratchpad.contains(activeEl);
                if (!scratchpadContains) return;
              }
              event.preventDefault();
              event.stopPropagation();
              Promise.resolve(
                window.nle_setScratchpadWindowStateLocal &&
                  window.nle_setScratchpadWindowStateLocal("minimized"),
              ).catch(function () {});
            }
          },
          true,
        );

        if (btnTakeover) {
          btnTakeover.addEventListener(
            "click",
            function (event) {
              event.stopPropagation();
              event.preventDefault();
              animatePress(btnTakeover);
              var __cs = window.nle_controlState || {};
              var __sid = __cs.sessionId || null;
              var __secret = __cs.sessionSecret || null;
              Promise.resolve(window.nle_takeover && window.nle_takeover(__sid, __secret)).catch(function () {});
            },
            true,
          );
        }

        if (btnPause) {
          btnPause.addEventListener(
            "click",
            function (event) {
              event.stopPropagation();
              event.preventDefault();
              animatePress(btnPause);
              Promise.resolve(window.nle_togglePause && window.nle_togglePause()).catch(function () {});
            },
            true,
          );
        }

        if (btnContinue) {
          btnContinue.addEventListener(
            "click",
            function (event) {
              event.stopPropagation();
              event.preventDefault();
              animatePress(btnContinue);
              Promise.resolve(window.nle_resume && window.nle_resume()).catch(function () {});
            },
            true,
          );
        }

        scratchpad.addEventListener("dragenter", function (event) {
          event.preventDefault();
          scratchpad.dataset.dropActive = "true";
        });
        scratchpad.addEventListener("dragover", function (event) {
          event.preventDefault();
          scratchpad.dataset.dropActive = "true";
        });
        scratchpad.addEventListener("dragleave", function (event) {
          if (!scratchpad.contains(event.relatedTarget)) {
            scratchpad.dataset.dropActive = "false";
          }
        });
        scratchpad.addEventListener("drop", function (event) {
          event.preventDefault();
          scratchpad.dataset.dropActive = "false";
          const files = Array.from((event.dataTransfer && event.dataTransfer.files) || []);
          if (files.length) {
            processFileList(files);
          }
        });

        window.addEventListener(
          "mousemove",
          function (event) {
            if (!window.nle_pageActive) return;
            mouse.style.left = event.clientX + "px";
            mouse.style.top = event.clientY + "px";
          },
          true,
        );

        window.addEventListener(
          "mousedown",
          function (event) {
            if (!window.nle_pageActive) return;
            pulseCursor();
            spawnRipple(event.clientX, event.clientY);
            spawnSparkBurst(event.clientX, event.clientY);
          },
          true,
        );

        window.nle_somActive = false;
        window.mapSoM = function (startIndex) {
          const offset = typeof startIndex === "number" ? startIndex : 0;
          window.nle_somActive = true;
          const root = getShadowRoot() || document.body;
          root.querySelectorAll(".som-badge").forEach(function (badge) {
            badge.remove();
          });

          const interactives = Array.from(
            document.querySelectorAll('button, a, input, select, textarea, [role="button"]'),
          ).filter(function (element) {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && window.getComputedStyle(element).visibility !== "hidden";
          });

          interactives.forEach(function (element, index) {
            const id = offset + index;
            const rect = element.getBoundingClientRect();
            const badgeEl = document.createElement("div");
            badgeEl.className = "som-badge";
            badgeEl.style.top = rect.top + window.scrollY + "px";
            badgeEl.style.left = rect.left + window.scrollX + "px";
            badgeEl.innerText = String(id);
            root.appendChild(badgeEl);
          });

          return interactives.map(function (element, index) {
            const rect = element.getBoundingClientRect();
            return {
              index: offset + index,
              text: element.innerText || element.value || element.placeholder || "",
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
            };
          });
        };

        renderAttachmentChips();
        renderExportTray();
        window.nle_setControlState(window.nle_controlState || {});
      };

      function ensureUi() {
        try {
          window.nle_injectUI && window.nle_injectUI();
          if (window.nle_setPageActive) {
            window.nle_setPageActive(window.nle_pageActive === true);
          }
          if (window.nle_somActive && window.mapSoM) {
            window.mapSoM();
          }
          if (window.nle_controlState && window.nle_setControlState) {
            window.nle_setControlState(window.nle_controlState);
          }
        } catch (_) {
          // Ignore cross-origin or transient DOM states during reinjection.
        }
      }

      ensureUi();
      setInterval(ensureUi, 500);
      document.addEventListener("DOMContentLoaded", ensureUi, { once: true });
    })();
  `;

  // Stealth polyfill: suppress automation-detection signals that datacenter
  // Chrome (running under Xvfb) would otherwise leak.  Running headed through
  // Xvfb with a real display avoids the HeadlessChrome UA string; this script
  // handles the remaining JS-level fingerprinting vectors.
  await context.addInitScript(`
    (function() {
      // Override navigator.webdriver: Playwright sets this to true when
      // Chrome is launched via CDP.  Google Login checks this flag.
      Object.defineProperty(navigator, "webdriver", {
        get: function() { return undefined; },
        configurable: true,
      });

      // Restore chrome.runtime so extension-detection checks pass.
      // Playwright clears this; Google Login and other sites probe it.
      if (window.chrome && window.chrome.runtime === undefined) {
        window.chrome.runtime = {};
      }

      // Spoof the plugins array to look like a real browser install.
      // Headless Chrome returns an empty array; real Chrome returns
      // a Non enumerable array with "Chrome PDF Plugin" etc.
      if (navigator.plugins && navigator.plugins.length === 0) {
        Object.defineProperty(navigator, "plugins", {
          get: function() {
            return [1, 2, 3, 4, 5];
          },
          configurable: true,
        });
      }

      // Spoof languages array — headless defaults to en-US only;
      // real users typically have more.
      if (navigator.languages && navigator.languages.length === 1) {
        Object.defineProperty(navigator, "languages", {
          get: function() { return ["en-US", "en"]; },
          configurable: true,
        });
      }
    })();
  `);

  await context.addInitScript(initScript);
}

/**
 * EMERGENCY/RECOVERY-ONLY UI INJECTION
 * 
 * ⚠️  AUTHORITATIVE INJECTION PATH: addInitScript in registerOmniUiLayer()
 * 
 * CALL GRAPH:
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Normal Flow (99% of cases)                                  │
 * │   registerOmniUiLayer(context)                              │
 * │   └─ addInitScript(initScript)                              │
 * │      └─ Synchronous UI injection on page load               │
 * │         (paints BEFORE first frame, no UI flash)            │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * ┌─────────────────────────────────────────────────────────────┐
 * │ Emergency/Recovery Flow (1% edge cases)                     │
 * │   recoverTab() - Tab crash/unresponsive recovery            │
 * │   └─ forceInjectOmniUi(page) ← ONLY PERMITTED HERE          │
 * │      └─ Fallback UI injection when addInitScript failed     │
 * │         (cross-origin sandbox, page crash, etc.)            │
 * └─────────────────────────────────────────────────────────────┘
 * 
 * STRICT RULE: This function MUST NOT be called from:
 * - Page creation (addInitScript handles it)
 * - Normal navigation (addInitScript handles it)
 * - Page activation (UI already injected)
 * 
 * Supreme Commander Directive: "ONE authoritative call path"
 */
export async function forceInjectOmniUi(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      try {
        (window as any).nle_injectUI?.();
        (window as any).nle_setPageActive?.((window as any).nle_pageActive === true);
        if ((window as any).nle_somActive) {
          (window as any).mapSoM?.();
        }
        if ((window as any).nle_controlState) {
          (window as any).nle_setControlState?.((window as any).nle_controlState);
        }
      } catch {
        // Ignore transient evaluation errors during navigation.
      }
    })
    .catch(() => {});
}

export async function setOmniUiPageActive(page: Page, active: boolean): Promise<void> {
  await page
    .evaluate((nextActive) => {
      (window as any).nle_pageActive = nextActive;
      (window as any).nle_setPageActive?.(nextActive);
    }, active)
    .catch(() => {});
}
