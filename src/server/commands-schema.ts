/**
 * commands-schema.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 2 Task 9: JSON Schema for the SessionCommand discriminated union.
 *
 * The schema is built at module load time from a single source of truth
 * (COMMAND_DEFINITIONS). When a new command is added to SessionCommand,
 * add an entry here and the schema is regenerated.
 *
 * The returned schema is a JSON Schema (draft-07) with `oneOf` per command
 * type, where each branch is `{ type: "object", properties: { type: { const },
 * <other>: ... }, required: ["type", ...] }`.
 *
 * The schema is exposed via GET /api/commands (Task 9 endpoint, wired in
 * local-server.ts) so dashboards and clients can introspect the API surface
 * without a separate documentation build.
 */

export type JsonSchema = {
  $schema?: string;
  additionalProperties?: boolean;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  title?: string;
  type: "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";
};

type CommandField = {
  description: string;
  required: boolean;
  schema: JsonSchema;
};

type CommandDefinition = {
  description: string;
  fields: Record<string, CommandField>;
  name: string;
};

const STRING: JsonSchema = { type: "string" };
const INTEGER: JsonSchema = { type: "integer" };
const BOOLEAN: JsonSchema = { type: "boolean" };
const NULLABLE_STRING: JsonSchema = { type: "string" };

function stringField(description: string, required = true): CommandField {
  return { description, required, schema: STRING };
}

function nullableStringField(description: string, required = false): CommandField {
  return { description, required, schema: NULLABLE_STRING };
}

function integerField(description: string, required = true): CommandField {
  return { description, required, schema: INTEGER };
}

function booleanField(description: string, required = true): CommandField {
  return { description, required, schema: BOOLEAN };
}

function enumField(description: string, values: string[], required = true): CommandField {
  return { description, required, schema: { description, enum: values, type: "string" } };
}

function objectField(
  description: string,
  properties: Record<string, JsonSchema | CommandField>,
  required = true,
): CommandField {
  const propertiesSchema: Record<string, JsonSchema> = {};
  for (const [k, v] of Object.entries(properties)) {
    propertiesSchema[k] = "type" in v ? v : v.schema;
  }
  return {
    description,
    required,
    schema: { additionalProperties: false, description, properties: propertiesSchema, type: "object" },
  };
}

function arrayField(description: string, items: JsonSchema | CommandField, required = true): CommandField {
  const itemsSchema: JsonSchema = "type" in items ? items : items.schema;
  return { description, required, schema: { description, items: itemsSchema, type: "array" } };
}

const COMMAND_DEFINITIONS: CommandDefinition[] = [
  {
    description: "Navigate the current page to a URL.",
    fields: {
      type: enumField("command discriminator", ["navigate"]),
      url: stringField("absolute or relative URL to navigate to"),
    },
    name: "navigate",
  },
  {
    description: "Click on an element. Exactly one of selector/text/coordinates is required.",
    fields: {
      coordinates: objectField(
        "absolute viewport coordinates to click at (bypasses DOM lookup)",
        { x: INTEGER, y: INTEGER },
        false,
      ),
      match_index: integerField("0-based index for repeated text matches (default 0)", false),
      selector: stringField("CSS selector of the element to click", false),
      text: stringField("visible text of the element to click (fuzzy-resolved via AX tree)", false),
      type: enumField("command discriminator", ["click"]),
    },
    name: "click",
  },
  {
    description: "Type text into a selector-resolved input element.",
    fields: {
      selector: stringField("CSS selector of the input element"),
      text: stringField("text to type into the element"),
      type: enumField("command discriminator", ["type"]),
    },
    name: "type",
  },
  {
    description: "Take a screenshot of the current page (saved to the session's records).",
    fields: {
      label: nullableStringField("optional human-readable label for the screenshot", false),
      type: enumField("command discriminator", ["screenshot"]),
    },
    name: "screenshot",
  },
  {
    description: "Pause the current mission. Operator resume continues execution.",
    fields: {
      reason: nullableStringField("optional reason for the pause", false),
      type: enumField("command discriminator", ["pause"]),
    },
    name: "pause",
  },
  {
    description: "Resume a paused mission.",
    fields: {
      reason: nullableStringField("optional reason for the resume", false),
      type: enumField("command discriminator", ["resume"]),
    },
    name: "resume",
  },
  {
    description: "Return the current session status snapshot.",
    fields: {
      type: enumField("command discriminator", ["status"]),
    },
    name: "status",
  },
  {
    description: "Low-level computer-use command (mouse/keyboard/clipboard/screen).",
    fields: {
      action: objectField(
        "ComputerAction discriminated union (16 variants: screenshot, move, click, type, key, confirm_action, wait, done, right_click, double_click, shortcut, drag, scroll, hover, clipboard_read, clipboard_write, screenshot_element, file_upload, file_download, fill_form, scroll_until, enter_frame, exit_frame, shadow_pierce)",
        { type: STRING },
      ),
      confirm: booleanField("true to grant confirmation for an irreversible/financial action (Rail 2)"),
      type: enumField("command discriminator", ["computer"]),
    },
    name: "computer",
  },
  {
    description: "Send a human directive to the agent. Subject to model-guard policy.",
    fields: {
      message: stringField("the directive text"),
      type: enumField("command discriminator", ["directive"]),
    },
    name: "directive",
  },
  {
    description: "Submit a model-side assistant reply to the scratchpad.",
    fields: {
      message: stringField("the assistant reply text"),
      type: enumField("command discriminator", ["assistant_reply"]),
    },
    name: "assistant_reply",
  },
  // Wave 2 high-level wrappers
  {
    description: "Right-click on a selector-resolved element.",
    fields: {
      selector: stringField("CSS selector of the element to right-click"),
      type: enumField("command discriminator", ["right_click"]),
    },
    name: "right_click",
  },
  {
    description: "Double-click on a selector-resolved element.",
    fields: {
      selector: stringField("CSS selector of the element to double-click"),
      type: enumField("command discriminator", ["double_click"]),
    },
    name: "double_click",
  },
  {
    description: "Move the mouse cursor to a selector-resolved element (no click).",
    fields: {
      selector: stringField("CSS selector of the element to hover"),
      type: enumField("command discriminator", ["hover"]),
    },
    name: "hover",
  },
  {
    description: "Press a global keyboard shortcut (e.g. ['Control', 'c']).",
    fields: {
      keys: arrayField("ordered list of key names to press in sequence", STRING),
      type: enumField("command discriminator", ["shortcut"]),
    },
    name: "shortcut",
  },
  {
    description: "Drag from one selector-resolved element to another.",
    fields: {
      fromSelector: stringField("CSS selector of the source element"),
      toSelector: stringField("CSS selector of the destination element"),
      type: enumField("command discriminator", ["drag"]),
    },
    name: "drag",
  },
  {
    description: "Scroll the page to a target Y coordinate (relative to current scroll).",
    fields: {
      selector: stringField("CSS selector of the element to scroll near"),
      targetY: integerField("target scroll Y coordinate in pixels"),
      type: enumField("command discriminator", ["scroll"]),
    },
    name: "scroll",
  },
  {
    description: "Upload a local file via a file input element.",
    fields: {
      filePath: stringField("absolute path to the file to upload"),
      selector: stringField("CSS selector of the <input type=file> element"),
      type: enumField("command discriminator", ["file_upload"]),
    },
    name: "file_upload",
  },
  {
    description: "Download a URL to a local path (preserves session cookies).",
    fields: {
      savePath: stringField("absolute path to write the downloaded bytes to"),
      type: enumField("command discriminator", ["file_download"]),
      url: stringField("URL to download from"),
    },
    name: "file_download",
  },
  {
    description: "Screenshot a single element (returns base64 PNG).",
    fields: {
      label: nullableStringField("optional label for the screenshot artifact", false),
      selector: stringField("CSS selector of the element to capture"),
      type: enumField("command discriminator", ["screenshot_element"]),
    },
    name: "screenshot_element",
  },
  {
    description: "Fill multiple form fields in one call.",
    fields: {
      fields: arrayField(
        "list of {selector, value} pairs to fill",
        objectField(
          "one form field",
          { selector: STRING, value: STRING },
        ),
      ),
      type: enumField("command discriminator", ["fill_form"]),
    },
    name: "fill_form",
  },
  {
    description: "Scroll until a target selector becomes visible.",
    fields: {
      direction: enumField("scroll direction", ["down", "up"], false),
      maxScrolls: integerField("maximum number of scroll attempts before giving up (default 20, max 200)", false),
      target: stringField("CSS selector or text to wait for"),
      type: enumField("command discriminator", ["scroll_until"]),
    },
    name: "scroll_until",
  },
  {
    description: "Enter an iframe context for subsequent commands.",
    fields: {
      frameSelector: stringField("CSS selector of the iframe element or its URL"),
      type: enumField("command discriminator", ["enter_frame"]),
    },
    name: "enter_frame",
  },
  {
    description: "Exit the current iframe and return to the main page context.",
    fields: {
      type: enumField("command discriminator", ["exit_frame"]),
    },
    name: "exit_frame",
  },
  {
    description: "Click a shadow-DOM element (uses Playwright's >>> piercing).",
    fields: {
      selector: stringField("selector that pierces shadow roots (e.g. 'my-component >>> button')"),
      type: enumField("command discriminator", ["shadow_click"]),
    },
    name: "shadow_click",
  },
  // Wave 2 AI helpers
  {
    description: "Create a new draft plan; returns a plan_id used by execute_plan / next_step.",
    fields: {
      goal: stringField("natural-language goal for the plan"),
      type: enumField("command discriminator", ["plan"]),
    },
    name: "plan",
  },
  {
    description: "Execute a plan (with optional inline steps) via the planner's Plan->Observe->Execute->Verify loop.",
    fields: {
      plan_id: stringField("plan identifier returned from a prior `plan` call"),
      steps: arrayField(
        "optional inline steps; replaces the plan's current steps when provided",
        objectField(
          "one plan step",
          {
            action: objectField(
              "the action for this step",
              { reason: STRING, selector: STRING, targetY: INTEGER, text: STRING, type: STRING, url: STRING },
              false,
            ),
            intent: STRING,
          },
        ),
        false,
      ),
      type: enumField("command discriminator", ["execute_plan"]),
    },
    name: "execute_plan",
  },
  {
    description: "Append and run a single step of a plan.",
    fields: {
      plan_id: stringField("plan identifier returned from a prior `plan` call"),
      step: objectField(
        "the step to append and run",
        {
          action: objectField(
            "the action for this step",
            { reason: STRING, selector: STRING, targetY: INTEGER, text: STRING, type: STRING, url: STRING },
            false,
          ),
          intent: STRING,
        },
      ),
      type: enumField("command discriminator", ["next_step"]),
    },
    name: "next_step",
  },
  {
    description: "Return the current page's accessibility-tree summary (AX hash, title, url, hints).",
    fields: {
      type: enumField("command discriminator", ["describe_page"]),
    },
    name: "describe_page",
  },
  {
    description: "Find elements by text. Exact match by default; fuzzy=true applies Levenshtein distance <= 2 to the AX tree.",
    fields: {
      fuzzy: booleanField("true to apply Levenshtein distance <= 2 over the AX tree (default false = exact match)"),
      text: stringField("text to search for"),
      type: enumField("command discriminator", ["find"]),
    },
    name: "find",
  },
  {
    description: "Wait until a JavaScript predicate returns true (page.waitForFunction).",
    fields: {
      predicate: stringField("JavaScript expression to evaluate; wait until truthy"),
      timeout_ms: integerField("timeout in milliseconds (default 10000, max 120000)", false),
      type: enumField("command discriminator", ["wait_for"]),
    },
    name: "wait_for",
  },
  // Wave 2 CAPTCHA
  {
    description: "Detect CAPTCHA surfaces on the current page (reCAPTCHA, hCaptcha, Cloudflare).",
    fields: {
      type: enumField("command discriminator", ["detect_captcha"]),
    },
    name: "detect_captcha",
  },
  {
    description: "Pause the mission for human verification (CAPTCHA or other auth wall).",
    fields: {
      reason: nullableStringField("optional reason for the human handoff", false),
      timeout_ms: integerField("timeout in milliseconds (default 300000, max 3600000)", false),
      type: enumField("command discriminator", ["wait_for_human"]),
    },
    name: "wait_for_human",
  },
  {
    description: "Navigate to a primary URL; fall back to a fallback URL if a CAPTCHA is detected.",
    fields: {
      fallback_url: stringField("URL to navigate to if a CAPTCHA is detected on the primary URL"),
      type: enumField("command discriminator", ["navigate_with_fallback"]),
      url: stringField("primary URL to navigate to"),
    },
    name: "navigate_with_fallback",
  },
];

function buildCommandBranch(def: CommandDefinition): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    type: { description: "command discriminator", enum: [def.name], type: "string" },
  };
  const required: string[] = ["type"];
  for (const [fieldName, field] of Object.entries(def.fields)) {
    if (fieldName === "type") continue;
    properties[fieldName] = field.schema;
    if (field.required) {
      required.push(fieldName);
    }
  }
  return {
    additionalProperties: false,
    description: def.description,
    properties,
    required,
    type: "object",
  };
}

let cachedSchema: JsonSchema | null = null;

export function getCommandsSchema(): JsonSchema {
  if (cachedSchema) return cachedSchema;
  const oneOf = COMMAND_DEFINITIONS.map(buildCommandBranch);
  cachedSchema = {
    $schema: "http://json-schema.org/draft-07/schema#",
    additionalProperties: false,
    description: "V-Engine v0.3 SessionCommand union — the body of POST /api/sessions/{id}/command",
    oneOf,
    title: "SessionCommand",
    type: "object",
  };
  return cachedSchema;
}

export function listCommandNames(): string[] {
  return COMMAND_DEFINITIONS.map((def) => def.name);
}

export function getCommandDefinition(name: string): CommandDefinition | null {
  return COMMAND_DEFINITIONS.find((def) => def.name === name) ?? null;
}
