/**
 * email-navigator.ts — Gmail + Outlook Web App recipe book.
 *
 * Teaches the AI precise selector sequences for common email operations.
 * Instead of guessing UI selectors, the agent calls these recipes which
 * know the exact Gmail/OWA DOM structure.
 *
 * Requires: the browser is already logged into Gmail or Outlook.
 * Authentication is handled separately via credential-vault.ts + vault_fill.
 *
 * Supported operations:
 *   - compose: open compose window, fill To/Subject/Body, send
 *   - reply:   open a thread by URL, click Reply, fill body, send
 *   - read_inbox: navigate to inbox, return list of { subject, from, snippet, url }
 */

import type { Page } from "playwright";

export type EmailResult =
  | { ok: true; action: string; detail?: string }
  | { ok: false; reason: string };

export type InboxEntry = {
  subject: string;
  from: string;
  snippet: string;
  url: string;
};

export type NavigateEmailInput =
  | { action: "compose"; to: string; subject: string; body: string }
  | { action: "reply"; thread_url: string; body: string }
  | { action: "read_inbox" };

/** Route email actions to the right provider based on current URL or provider hint. */
export async function navigateEmail(
  page: Page,
  input: NavigateEmailInput,
): Promise<EmailResult | { ok: true; entries: InboxEntry[] }> {
  const url = page.url().toLowerCase();
  const isGmail = url.includes("mail.google.com") || url.includes("google.com/mail");
  const isOutlook = url.includes("outlook.live.com") || url.includes("outlook.office.com") || url.includes("outlook.office365.com");

  if (input.action === "read_inbox") {
    if (isGmail || !isOutlook) {
      // Navigate to Gmail inbox if not already there
      if (!isGmail) {
        await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
      }
      return readGmailInbox(page);
    }
    if (!isOutlook) {
      await page.goto("https://outlook.live.com/mail/0/inbox", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    }
    return readOutlookInbox(page);
  }

  if (input.action === "compose") {
    if (isOutlook) return composeOutlook(page, input);
    // Default to Gmail
    if (!isGmail) {
      await page.goto("https://mail.google.com/mail/u/0/#inbox", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    }
    return composeGmail(page, input);
  }

  if (input.action === "reply") {
    await page.goto(input.thread_url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const newUrl = page.url();
    if (newUrl.includes("mail.google.com")) return replyGmail(page, input);
    if (newUrl.includes("outlook")) return replyOutlook(page, input);
    return { ok: false, reason: "unknown_email_provider" };
  }

  return { ok: false, reason: "unknown_action" };
}

// ── Gmail ─────────────────────────────────────────────────────────────────────

async function composeGmail(
  page: Page,
  input: { to: string; subject: string; body: string },
): Promise<EmailResult> {
  try {
    // Click Compose button
    await page.locator('[gh="cm"], [data-tooltip="Compose"], button:has-text("Compose")').first().click({ timeout: 8000 });
    await page.waitForTimeout(1000);

    // Fill To field
    const toField = page.locator('input[name="to"], textarea[name="to"], [aria-label="To"]').first();
    await toField.fill(input.to, { timeout: 5000 });
    await page.keyboard.press("Tab");

    // Fill Subject
    const subjField = page.locator('input[name="subjectbox"], input[placeholder*="Subject"], [aria-label="Subject"]').first();
    await subjField.fill(input.subject, { timeout: 5000 });

    // Fill Body
    const bodyField = page.locator('[role="textbox"][aria-label*="Message Body"], [aria-label="Message Body"], div[contenteditable="true"]').first();
    await bodyField.click();
    await bodyField.fill(input.body);

    // Click Send
    await page.locator('div[data-tooltip*="Send"], [aria-label*="Send"], button:has-text("Send")').first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    return { ok: true, action: "compose", detail: `Sent to ${input.to}` };
  } catch (err) {
    return { ok: false, reason: `Gmail compose failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function replyGmail(
  page: Page,
  input: { body: string },
): Promise<EmailResult> {
  try {
    // Click Reply button in thread view
    await page.locator('button[data-tooltip*="Reply"], [aria-label*="Reply"], button:has-text("Reply")').first().click({ timeout: 8000 });
    await page.waitForTimeout(800);

    // Type in the reply box
    const replyBox = page.locator('[role="textbox"][aria-label*="Message Body"], div[contenteditable="true"]').last();
    await replyBox.click();
    await replyBox.fill(input.body);

    await page.locator('div[data-tooltip*="Send"], button:has-text("Send")').first().click({ timeout: 5000 });
    await page.waitForTimeout(1000);

    return { ok: true, action: "reply" };
  } catch (err) {
    return { ok: false, reason: `Gmail reply failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function readGmailInbox(page: Page): Promise<{ ok: true; entries: InboxEntry[] }> {
  try {
    const rows = await page.locator('tr.zA').all();
    const entries: InboxEntry[] = [];
    for (const row of rows.slice(0, 20)) {
      try {
        const subject = await row.locator('.y6 span[data-thread-perm-id], .bog').first().innerText().catch(() => "");
        const from = await row.locator('.yP, .zF, span[email]').first().innerText().catch(() => "");
        const snippet = await row.locator('.y2').first().innerText().catch(() => "");
        const href = await row.locator('td').first().evaluate((el) => {
          const a = el.closest("tr")?.querySelector("a");
          return a ? a.href : "";
        }).catch(() => "");
        if (subject || from) entries.push({ subject, from, snippet, url: href });
      } catch {
        // skip row
      }
    }
    return { ok: true, entries };
  } catch {
    return { ok: true, entries: [] };
  }
}

// ── Outlook Web App ───────────────────────────────────────────────────────────

async function composeOutlook(
  page: Page,
  input: { to: string; subject: string; body: string },
): Promise<EmailResult> {
  try {
    await page.locator('button[aria-label*="New message"], button[aria-label*="New mail"], button:has-text("New message")').first().click({ timeout: 8000 });
    await page.waitForTimeout(1000);

    await page.locator('input[aria-label*="To:"], div[aria-label*="To"]').first().fill(input.to);
    await page.keyboard.press("Tab");

    await page.locator('input[aria-label*="Subject"], div[aria-label*="Subject"]').first().fill(input.subject);

    await page.locator('div[contenteditable="true"][aria-label*="Message body"], div[role="textbox"]').first().fill(input.body);

    await page.locator('button[aria-label*="Send"], button:has-text("Send")').first().click({ timeout: 5000 });
    await page.waitForTimeout(1500);

    return { ok: true, action: "compose", detail: `Sent to ${input.to}` };
  } catch (err) {
    return { ok: false, reason: `Outlook compose failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function replyOutlook(page: Page, input: { body: string }): Promise<EmailResult> {
  try {
    await page.locator('button[aria-label*="Reply"], button:has-text("Reply")').first().click({ timeout: 8000 });
    await page.waitForTimeout(800);
    await page.locator('div[contenteditable="true"], div[role="textbox"]').first().fill(input.body);
    await page.locator('button[aria-label*="Send"]').first().click({ timeout: 5000 });
    return { ok: true, action: "reply" };
  } catch (err) {
    return { ok: false, reason: `Outlook reply failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function readOutlookInbox(page: Page): Promise<{ ok: true; entries: InboxEntry[] }> {
  try {
    const items = await page.locator('[role="option"][class*="mail"]').all();
    const entries: InboxEntry[] = [];
    for (const item of items.slice(0, 20)) {
      try {
        const subject = await item.locator('[class*="subject"]').first().innerText().catch(() => "");
        const from = await item.locator('[class*="sender"], [class*="from"]').first().innerText().catch(() => "");
        const snippet = await item.locator('[class*="preview"], [class*="snippet"]').first().innerText().catch(() => "");
        entries.push({ subject, from, snippet, url: page.url() });
      } catch {
        // skip
      }
    }
    return { ok: true, entries };
  } catch {
    return { ok: true, entries: [] };
  }
}
