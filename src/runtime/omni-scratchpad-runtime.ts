import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";
import { ProofCapture } from "./proof-capture.js";
import { atomicWriteFile } from "./session-persistence.js";
import { sanitizeProtectedRuntimeText, sanitizeProtectedRuntimeValue } from "../security/trade-secret-guard.js";

const execFileAsync = promisify(execFile);
const xmlParser = new XMLParser({
  attributeNamePrefix: "",
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
});

const LOCAL_READER_SOURCE = String.raw`
import Foundation
import AppKit
import Vision
import PDFKit

struct Output: Codable {
  let height: Int?
  let mode: String
  let pageCount: Int?
  let text: String
  let width: Int?
}

func emit(_ output: Output) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(output) else {
    exit(9)
  }
  FileHandle.standardOutput.write(data)
}

func loadCGImage(from filePath: String) -> CGImage? {
  guard
    let image = NSImage(contentsOfFile: filePath),
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let cgImage = bitmap.cgImage
  else {
    return nil
  }
  return cgImage
}

func recognizeText(from cgImage: CGImage) -> String {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  do {
    try handler.perform([request])
  } catch {
    return ""
  }

  guard let results = request.results as? [VNRecognizedTextObservation] else {
    return ""
  }

  return results.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  exit(1)
}

let mode = args[1]
let filePath = args[2]

switch mode {
case "image":
  guard let cgImage = loadCGImage(from: filePath) else {
    exit(2)
  }
  emit(
    Output(
      height: cgImage.height,
      mode: mode,
      pageCount: nil,
      text: recognizeText(from: cgImage),
      width: cgImage.width
    )
  )
case "pdf":
  let url = URL(fileURLWithPath: filePath)
  guard let document = PDFDocument(url: url) else {
    exit(3)
  }

  var pages: [String] = []
  for index in 0..<document.pageCount {
    guard let page = document.page(at: index) else {
      continue
    }

    let directText = page.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !directText.isEmpty {
      pages.append(directText)
      continue
    }

    let bounds = page.bounds(for: .mediaBox)
    let thumb = page.thumbnail(
      of: NSSize(width: max(bounds.width, 1200), height: max(bounds.height, 1200)),
      for: .mediaBox
    )
    guard
      let tiff = thumb.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let cgImage = bitmap.cgImage
    else {
      continue
    }

    let ocr = recognizeText(from: cgImage).trimmingCharacters(in: .whitespacesAndNewlines)
    if !ocr.isEmpty {
      pages.append(ocr)
    }
  }

  emit(
    Output(
      height: nil,
      mode: mode,
      pageCount: document.pageCount,
      text: pages.joined(separator: "\n\n--- Page ---\n\n"),
      width: nil
    )
  )
default:
  exit(4)
}
`;

let localReaderBuild: Promise<string> | null = null;

export interface OmniScratchpadFileInput {
  dataBase64: string;
  id: string;
  lastModified?: number | null;
  mimeType?: string | null;
  name: string;
  size?: number | null;
}

export interface OmniScratchpadFileResult {
  category: "audio" | "document" | "image" | "other" | "presentation" | "spreadsheet" | "video";
  error?: string;
  extractedText: string;
  id: string;
  metadata: Record<string, unknown>;
  mimeType: string;
  name: string;
  previewText: string;
  size: number;
  status: "error" | "ready";
  storagePath: string;
  summary: string;
}

export interface OmniScratchpadAudioResult {
  audioPath: string;
  provider: string;
  transcript: string;
  warning?: string;
}

export interface OmniScratchpadExportArtifact {
  contentBase64: string;
  filename: string;
  mimeType: string;
  path: string;
  role: "mission-log-json" | "overview-html" | "scratchpad-json" | "scratchpad-txt";
}

export interface OmniScratchpadExportBundle {
  artifacts: OmniScratchpadExportArtifact[];
  generatedAt: string;
  overviewPath: string;
  sessionId: string;
}

export interface OmniScratchpadHistoryEntry {
  text: string;
  timestamp: string;
  type: "ai" | "human";
}

export interface OmniMissionLogEntry {
  action: string;
  detail: string;
  status: "error" | "recovery" | "success";
  timestamp: string;
}

export async function createScratchpadExportBundle(input: {
  missionLog: OmniMissionLogEntry[];
  proofCapture?: ProofCapture;
  scratchpadEntries: OmniScratchpadHistoryEntry[];
  sessionId: string;
}): Promise<OmniScratchpadExportBundle> {
  const proofCapture = input.proofCapture ?? new ProofCapture();
  const sessionPaths = proofCapture.getSessionPaths(input.sessionId);
  const exportDir = path.join(sessionPaths.rootDir, "exports");
  ensureDir(exportDir);

  const generatedAt = new Date().toISOString();
  const scratchpadJsonPath = path.join(exportDir, "scratchpad.json");
  const scratchpadTxtPath = path.join(exportDir, "scratchpad.txt");
  const missionLogJsonPath = path.join(exportDir, "mission-log.json");
  const overviewPath = path.join(exportDir, "overview.html");

  const scratchpadJson = JSON.stringify(sanitizeProtectedRuntimeValue(input.scratchpadEntries), null, 2);
  const missionLogJson = JSON.stringify(sanitizeProtectedRuntimeValue(input.missionLog), null, 2);
  const scratchpadTxt = input.scratchpadEntries
    .map((entry) => `[${entry.timestamp}] ${entry.type.toUpperCase()}: ${entry.text}`)
    .join("\n\n");

  atomicWriteFile(scratchpadJsonPath, scratchpadJson, { mode: 0o600 });
  atomicWriteFile(scratchpadTxtPath, sanitizeProtectedRuntimeText(scratchpadTxt), { mode: 0o600 });
  atomicWriteFile(missionLogJsonPath, missionLogJson, { mode: 0o600 });
  atomicWriteFile(
    overviewPath,
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Omni Scratchpad Export</title>
    <style>
      body { margin: 0; padding: 28px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: #020617; color: #e2e8f0; }
      h1, h2 { margin-top: 0; }
      .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
      .panel { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 18px; padding: 18px; }
      pre { margin: 0; white-space: pre-wrap; word-break: break-word; color: #cbd5e1; font-size: 12px; }
      .meta { color: #94a3b8; margin-bottom: 24px; }
    </style>
  </head>
  <body>
    <h1>Omni Scratchpad Export</h1>
    <p class="meta">Session ${escapeHtml(input.sessionId)} · Generated ${escapeHtml(generatedAt)}</p>
    <section class="grid">
      <article class="panel">
        <h2>Scratchpad</h2>
        <pre>${escapeHtml(scratchpadTxt)}</pre>
      </article>
      <article class="panel">
        <h2>Mission Log</h2>
        <pre>${escapeHtml(missionLogJson)}</pre>
      </article>
    </section>
  </body>
</html>`,
    { mode: 0o600 },
  );

  return {
    artifacts: [
      makeExportArtifact("scratchpad-json", "scratchpad.json", "application/json", scratchpadJsonPath),
      makeExportArtifact("scratchpad-txt", "scratchpad.txt", "text/plain", scratchpadTxtPath),
      makeExportArtifact("mission-log-json", "mission-log.json", "application/json", missionLogJsonPath),
      makeExportArtifact("overview-html", "overview.html", "text/html", overviewPath),
    ],
    generatedAt,
    overviewPath,
    sessionId: input.sessionId,
  };
}

export async function processScratchpadFiles(
  sessionId: string,
  files: OmniScratchpadFileInput[],
): Promise<OmniScratchpadFileResult[]> {
  const results: OmniScratchpadFileResult[] = [];
  for (const file of files) {
    results.push(await processSingleScratchpadFile(sessionId, file));
  }
  return results;
}

export async function transcribeScratchpadAudio(input: {
  base64: string;
  mimeType?: string | null;
  name?: string | null;
  sessionId: string;
}): Promise<OmniScratchpadAudioResult> {
  const buffer = Buffer.from(input.base64, "base64");
  const mimeType = normalizeMimeType(input.mimeType, input.name ?? undefined);
  const audioPath = writeUploadArtifact(
    input.sessionId,
    input.name && input.name.trim().length > 0 ? input.name : `scratchpad-audio.${extensionFromMimeType(mimeType)}`,
    buffer,
  );

  const transcript = await transcribeAudioBuffer(buffer, mimeType);
  if (transcript) {
    return {
      audioPath,
      provider: transcript.provider,
      transcript: transcript.text,
      warning: transcript.warning,
    };
  }

  const printableFallback = inferPrintableText(buffer);
  if (printableFallback) {
    return {
      audioPath,
      provider: "local-printable-fallback",
      transcript: printableFallback,
      warning: "Used local printable fallback because no transcription provider was available.",
    };
  }

  return {
    audioPath,
    provider: "metadata-only",
    transcript: "",
    warning: "Audio captured successfully, but no speech transcription provider was available in this runtime.",
  };
}

async function processSingleScratchpadFile(
  sessionId: string,
  file: OmniScratchpadFileInput,
): Promise<OmniScratchpadFileResult> {
  const buffer = Buffer.from(file.dataBase64, "base64");
  const size = buffer.byteLength;
  const mimeType = normalizeMimeType(file.mimeType, file.name);
  const storagePath = writeUploadArtifact(sessionId, file.name, buffer);
  const ext = path.extname(file.name).toLowerCase();

  try {
    if (isPlainTextLike(ext, mimeType)) {
      return buildResult({
        category: "document",
        extractedText: sanitizeExtractedText(readTextBuffer(buffer)),
        file,
        metadata: { extension: ext || null },
        mimeType,
        size,
        storagePath,
        summary: `Parsed ${labelForExtension(ext, mimeType)} locally`,
      });
    }

    if (isWordLike(ext, mimeType)) {
      const extractedText = sanitizeExtractedText(await extractWordDocumentText(storagePath));
      return buildResult({
        category: "document",
        extractedText,
        file,
        metadata: { extension: ext || null },
        mimeType,
        size,
        storagePath,
        summary: `Parsed ${labelForExtension(ext, mimeType)} locally`,
      });
    }

    if (isSpreadsheetLike(ext, mimeType)) {
      const spreadsheet = await extractSpreadsheetText(storagePath);
      return buildResult({
        category: "spreadsheet",
        extractedText: sanitizeExtractedText(spreadsheet.text),
        file,
        metadata: { extension: ext || null, sheets: spreadsheet.sheetNames },
        mimeType,
        size,
        storagePath,
        summary: `Parsed spreadsheet${spreadsheet.sheetNames.length > 0 ? ` (${spreadsheet.sheetNames.join(", ")})` : ""}`,
      });
    }

    if (isPresentationLike(ext, mimeType)) {
      const presentation = await extractPresentationText(storagePath);
      return buildResult({
        category: "presentation",
        extractedText: sanitizeExtractedText(presentation.text),
        file,
        metadata: { extension: ext || null, slides: presentation.slideCount },
        mimeType,
        size,
        storagePath,
        summary: `Parsed presentation with ${presentation.slideCount} slide${presentation.slideCount === 1 ? "" : "s"}`,
      });
    }

    if (mimeType === "application/pdf" || ext === ".pdf") {
      const pdf = await extractPdfText(storagePath);
      return buildResult({
        category: "document",
        extractedText: sanitizeExtractedText(pdf.text),
        file,
        metadata: { extension: ext || null, pageCount: pdf.pageCount },
        mimeType,
        size,
        storagePath,
        summary: `Parsed PDF${typeof pdf.pageCount === "number" ? ` (${pdf.pageCount} page${pdf.pageCount === 1 ? "" : "s"})` : ""}`,
      });
    }

    if (mimeType.startsWith("image/")) {
      const image = await extractImageText(storagePath);
      return buildResult({
        category: "image",
        extractedText: sanitizeExtractedText(image.text),
        file,
        metadata: { extension: ext || null, height: image.height, width: image.width },
        mimeType,
        size,
        storagePath,
        summary: `Parsed image${image.width && image.height ? ` (${image.width}×${image.height})` : ""}`,
      });
    }

    if (mimeType.startsWith("audio/")) {
      const audio = await extractMediaInsight(storagePath, mimeType, "audio");
      return buildResult({
        category: "audio",
        extractedText: sanitizeExtractedText(audio.text),
        file,
        metadata: audio.metadata,
        mimeType,
        size,
        storagePath,
        summary: audio.summary,
      });
    }

    if (mimeType.startsWith("video/")) {
      const video = await extractMediaInsight(storagePath, mimeType, "video");
      return buildResult({
        category: "video",
        extractedText: sanitizeExtractedText(video.text),
        file,
        metadata: audioVisualMetadata(video.metadata),
        mimeType,
        size,
        storagePath,
        summary: video.summary,
      });
    }

    const generic = await extractGenericFileInsight(storagePath, buffer, mimeType, ext);
    return buildResult({
      category: "other",
      extractedText: sanitizeExtractedText(generic.text),
      file,
      metadata: generic.metadata,
      mimeType,
      size,
      storagePath,
      summary: generic.summary,
    });
  } catch (error) {
    return {
      category: inferCategory(ext, mimeType),
      error: error instanceof Error ? error.message : String(error),
      extractedText: "",
      id: file.id,
      metadata: { extension: ext || null },
      mimeType,
      name: file.name,
      previewText: "",
      size,
      status: "error",
      storagePath,
      summary: `Failed to parse ${file.name}`,
    };
  }
}

function audioVisualMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return metadata;
}

function buildResult(input: {
  category: OmniScratchpadFileResult["category"];
  extractedText: string;
  file: OmniScratchpadFileInput;
  metadata: Record<string, unknown>;
  mimeType: string;
  size: number;
  storagePath: string;
  summary: string;
}): OmniScratchpadFileResult {
  const extractedText = input.extractedText.trim();
  const previewText = limitText(extractedText, 2000);
  const summarySuffix = extractedText
    ? ` · ${extractedText.length.toLocaleString()} chars`
    : ` · ${formatBytes(input.size)}`;

  return {
    category: input.category,
    extractedText,
    id: input.file.id,
    metadata: input.metadata,
    mimeType: input.mimeType,
    name: input.file.name,
    previewText,
    size: input.size,
    status: "ready",
    storagePath: input.storagePath,
    summary: `${input.summary}${summarySuffix}`,
  };
}

async function extractWordDocumentText(filePath: string): Promise<string> {
  const textutil = await execFileAsync("/usr/bin/textutil", ["-convert", "txt", "-stdout", filePath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = textutil.stdout.trim();
  if (text) {
    return text;
  }

  if (filePath.toLowerCase().endsWith(".docx")) {
    const xml = await readZipEntry(filePath, "word/document.xml");
    return collectXmlText(xml, "t");
  }

  return "";
}

async function extractSpreadsheetText(filePath: string): Promise<{ sheetNames: string[]; text: string }> {
  const entries = await listZipEntries(filePath);
  const workbookXml = await readZipEntry(filePath, "xl/workbook.xml");
  const sharedStringsXml = entries.includes("xl/sharedStrings.xml")
    ? await readZipEntry(filePath, "xl/sharedStrings.xml")
    : "";

  const workbook = workbookXml ? xmlParser.parse(workbookXml) : {};
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
  const sheets = toArray(workbook?.workbook?.sheets?.sheet);
  const sheetNames = sheets.map((sheet: Record<string, unknown>, index: number) =>
    String(sheet.name ?? `Sheet ${index + 1}`),
  );

  const worksheetEntries = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry))
    .sort();

  const sections: string[] = [];
  for (const [index, sheetEntry] of Array.from(worksheetEntries.entries())) {
    const xml = await readZipEntry(filePath, sheetEntry);
    const label = sheetNames[index] ?? path.basename(sheetEntry, ".xml");
    sections.push(`# ${label}`);
    sections.push(extractSheetRows(xml, sharedStrings));
  }

  return {
    sheetNames,
    text: sections.filter(Boolean).join("\n\n").trim(),
  };
}

async function extractPresentationText(filePath: string): Promise<{ slideCount: number; text: string }> {
  const entries = await listZipEntries(filePath);
  const slideEntries = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry))
    .sort();
  const slides: string[] = [];

  for (const [index, slideEntry] of Array.from(slideEntries.entries())) {
    const xml = await readZipEntry(filePath, slideEntry);
    const text = collectXmlText(xml, "t");
    slides.push(`Slide ${index + 1}\n${text}`.trim());
  }

  return {
    slideCount: slideEntries.length,
    text: slides.join("\n\n").trim(),
  };
}

async function extractPdfText(filePath: string): Promise<{ pageCount?: number; text: string }> {
  const output = await runLocalReader("pdf", filePath);
  const text = output.text?.trim() ?? "";
  if (text) {
    return { pageCount: output.pageCount, text };
  }

  const mdlsText = await readMdlsText(filePath);
  return {
    pageCount: output.pageCount,
    text: mdlsText,
  };
}

async function extractImageText(filePath: string): Promise<{ height?: number; text: string; width?: number }> {
  const output = await runLocalReader("image", filePath);
  return {
    height: output.height,
    text: output.text?.trim() ?? "",
    width: output.width,
  };
}

async function extractMediaInsight(
  filePath: string,
  mimeType: string,
  kind: "audio" | "video",
): Promise<{ metadata: Record<string, unknown>; summary: string; text: string }> {
  const probe = await runFfprobe(filePath);
  const metadata: Record<string, unknown> = {
    durationSeconds: probe.format?.duration ? Number(probe.format.duration) : null,
    formatName: probe.format?.format_name ?? null,
    sizeBytes: probe.format?.size ? Number(probe.format.size) : null,
    streams: Array.isArray(probe.streams)
      ? probe.streams.map((stream: Record<string, unknown>) => ({
          codecName: stream.codec_name ?? null,
          codecType: stream.codec_type ?? null,
          height: stream.height ?? null,
          sampleRate: stream.sample_rate ?? null,
          width: stream.width ?? null,
        }))
      : [],
  };

  let transcript = await transcribeAudioOrVideo(filePath, mimeType, kind);
  if (!transcript) {
    transcript = inferPrintableText(fs.readFileSync(filePath));
  }

  const detailLines = [
    `Format: ${String(metadata.formatName ?? "unknown")}`,
    `Duration: ${formatDuration(Number(metadata.durationSeconds ?? 0))}`,
  ];
  if (kind === "video") {
    const videoStream = Array.isArray(probe.streams)
      ? probe.streams.find((stream: Record<string, unknown>) => stream.codec_type === "video")
      : null;
    if (videoStream?.width && videoStream?.height) {
      detailLines.push(`Resolution: ${videoStream.width}x${videoStream.height}`);
    }
  }

  return {
    metadata,
    summary: `Parsed ${kind}${transcript ? " with transcript" : " metadata locally"}`,
    text: transcript || detailLines.join("\n"),
  };
}

async function extractGenericFileInsight(
  filePath: string,
  buffer: Buffer,
  mimeType: string,
  ext: string,
): Promise<{ metadata: Record<string, unknown>; summary: string; text: string }> {
  const maybeText = sanitizeExtractedText(readTextBuffer(buffer));
  if (maybeText) {
    return {
      metadata: { extension: ext || null },
      summary: `Read ${labelForExtension(ext, mimeType)}`,
      text: maybeText,
    };
  }

  const mdlsText = await readMdlsText(filePath);
  if (mdlsText) {
    return {
      metadata: { extension: ext || null },
      summary: `Indexed ${labelForExtension(ext, mimeType)} via local metadata`,
      text: mdlsText,
    };
  }

  const stringsText = await readBinaryStrings(filePath);
  return {
    metadata: { extension: ext || null },
    summary: `Read binary ${labelForExtension(ext, mimeType)} with local fallback`,
    text: stringsText,
  };
}

async function transcribeAudioOrVideo(
  filePath: string,
  mimeType: string,
  kind: "audio" | "video",
): Promise<string> {
  if (kind === "audio") {
    const buffer = fs.readFileSync(filePath);
    const transcript = await transcribeAudioBuffer(buffer, mimeType);
    return transcript?.text ?? "";
  }

  const audioPath = path.join(os.tmpdir(), `omni-video-audio-${Date.now()}.m4a`);
  try {
    await execFileAsync(
      "/opt/homebrew/bin/ffmpeg",
      ["-y", "-i", filePath, "-vn", "-acodec", "aac", audioPath],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    const buffer = fs.readFileSync(audioPath);
    const transcript = await transcribeAudioBuffer(buffer, "audio/mp4");
    return transcript?.text ?? "";
  } catch {
    return "";
  } finally {
    if (fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
  }
}

async function transcribeAudioBuffer(
  buffer: Buffer,
  mimeType: string,
): Promise<{ provider: string; text: string; warning?: string } | null> {
  const forgeApiUrl = process.env.OMNI_FORGE_API_URL ?? "";
  const forgeApiKey = process.env.OMNI_FORGE_API_KEY ?? "";
  if (!forgeApiUrl || !forgeApiKey) {
    return null;
  }

  const formData = new FormData();
  const filename = `scratchpad-audio.${extensionFromMimeType(mimeType)}`;
  formData.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);
  formData.append("model", "whisper-1");
  formData.append("response_format", "verbose_json");
  formData.append("prompt", "Transcribe the operator's voice command exactly.");

  const baseUrl = forgeApiUrl.endsWith("/") ? forgeApiUrl : `${forgeApiUrl}/`;
  const url = new URL("v1/audio/transcriptions", baseUrl).toString();
  const response = await fetch(url, {
    body: formData,
    headers: {
      authorization: `Bearer ${forgeApiKey}`,
      "Accept-Encoding": "identity",
    },
    method: "POST",
  });
  if (!response.ok) {
    return null;
  }

  const json = (await response.json()) as { text?: string };
  const text = typeof json.text === "string" ? json.text.trim() : "";
  if (!text) {
    return null;
  }

  return {
    provider: "forge-whisper",
    text,
  };
}

async function runFfprobe(filePath: string): Promise<Record<string, any>> {
  const { stdout } = await execFileAsync(
    "/opt/homebrew/bin/ffprobe",
    ["-v", "error", "-show_entries", "format=duration,size,format_name", "-show_streams", "-of", "json", filePath],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout || "{}");
}

async function readMdlsText(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/mdls", ["-raw", "-name", "kMDItemTextContent", filePath], {
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (text === "(null)" || text === "null") {
      return "";
    }
    return sanitizeExtractedText(text);
  } catch {
    return "";
  }
}

async function readBinaryStrings(filePath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/strings", ["-a", "-n", "6", filePath], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return sanitizeExtractedText(stdout);
  } catch {
    return "";
  }
}

async function listZipEntries(filePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("/usr/bin/unzip", ["-Z1", filePath], {
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function readZipEntry(filePath: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/unzip", ["-p", filePath, entry], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout ?? "";
}

function parseSharedStrings(xml: string): string[] {
  const parsed = xmlParser.parse(xml);
  const items = toArray(parsed?.sst?.si);
  return items.map((item) => {
    if (typeof item?.t === "string") {
      return item.t;
    }
    const runs = toArray(item?.r);
    return runs.map((run) => String(run?.t ?? "")).join("");
  });
}

function extractSheetRows(xml: string, sharedStrings: string[]): string {
  const parsed = xmlParser.parse(xml);
  const rows = toArray(parsed?.worksheet?.sheetData?.row);
  const lines = rows.map((row) => {
    const cells = toArray(row?.c).map((cell) => {
      const rawValue = cell?.v ?? cell?.is?.t ?? "";
      if (cell?.t === "s") {
        const index = Number(rawValue);
        return Number.isFinite(index) ? sharedStrings[index] ?? "" : "";
      }
      return String(rawValue ?? "");
    });
    return cells.join("\t").trimEnd();
  });
  return lines.filter(Boolean).join("\n");
}

function collectXmlText(xml: string, textKey: string): string {
  const matches = Array.from(
    xml.matchAll(new RegExp(`<[^>]*:${textKey}[^>]*>([\\s\\S]*?)<\\/[^>]*:${textKey}>`, "g")),
  );
  if (matches.length > 0) {
    return sanitizeExtractedText(matches.map((match) => decodeXmlEntities(match[1] ?? "")).join(" "));
  }

  const parsed = xmlParser.parse(xml);
  const values: string[] = [];
  walkXml(parsed, textKey, values);
  return sanitizeExtractedText(values.join(" "));
}

function walkXml(value: unknown, textKey: string, output: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkXml(item, textKey, output);
    }
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === textKey && typeof nested === "string") {
      output.push(nested);
      continue;
    }
    walkXml(nested, textKey, output);
  }
}

async function runLocalReader(
  mode: "image" | "pdf",
  filePath: string,
): Promise<{ height?: number; pageCount?: number; text?: string; width?: number }> {
  const binaryPath = await ensureLocalReaderBinary();
  const { stdout } = await execFileAsync(binaryPath, [mode, filePath], {
    env: {
      ...process.env,
      CLANG_MODULE_CACHE_PATH: path.join(os.tmpdir(), "omni-clang-cache"),
    },
    maxBuffer: 8 * 1024 * 1024,
  });
  return JSON.parse(stdout || "{}") as {
    height?: number;
    pageCount?: number;
    text?: string;
    width?: number;
  };
}

async function ensureLocalReaderBinary(): Promise<string> {
  if (localReaderBuild) {
    return localReaderBuild;
  }

  localReaderBuild = (async () => {
    const targetDir = path.join(os.tmpdir(), "omni-local-reader");
    const sourcePath = path.join(targetDir, "reader.swift");
    const binaryPath = path.join(targetDir, "reader-bin");
    const signaturePath = path.join(targetDir, "reader.sig");
    const signature = createHash("sha256").update(LOCAL_READER_SOURCE).digest("hex");

    ensureDir(targetDir);
    ensureDir(path.join(os.tmpdir(), "omni-clang-cache"));

    if (
      fs.existsSync(binaryPath) &&
      fs.existsSync(signaturePath) &&
      fs.readFileSync(signaturePath, "utf8") === signature
    ) {
      return binaryPath;
    }

    atomicWriteFile(sourcePath, LOCAL_READER_SOURCE, { mode: 0o600 });
    await execFileAsync(
      "/usr/bin/env",
      [
        "CLANG_MODULE_CACHE_PATH=" + path.join(os.tmpdir(), "omni-clang-cache"),
        "/usr/bin/swiftc",
        sourcePath,
        "-o",
        binaryPath,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    atomicWriteFile(signaturePath, signature, { mode: 0o600 });
    return binaryPath;
  })();

  try {
    return await localReaderBuild;
  } finally {
    localReaderBuild = null;
  }
}

function makeExportArtifact(
  role: OmniScratchpadExportArtifact["role"],
  filename: string,
  mimeType: string,
  filePath: string,
): OmniScratchpadExportArtifact {
  return {
    contentBase64: fs.readFileSync(filePath).toString("base64"),
    filename,
    mimeType,
    path: filePath,
    role,
  };
}

function writeUploadArtifact(sessionId: string, fileName: string, buffer: Buffer): string {
  const proofCapture = new ProofCapture();
  const sessionPaths = proofCapture.getSessionPaths(sessionId);
  const uploadDir = path.join(sessionPaths.rootDir, "uploads");
  ensureDir(uploadDir);
  const safeName = `${Date.now()}-${sanitizeFileName(fileName)}`;
  const targetPath = path.join(uploadDir, safeName);
  atomicWriteFile(targetPath, buffer, { mode: 0o600 });
  return targetPath;
}

function readTextBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8").replace(/^\uFEFF/, "");
  const printable = utf8.replace(/\0/g, "").trim();
  return printable;
}

function inferPrintableText(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8").replace(/\0/g, "");
  const cleaned = utf8
    .split("")
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    })
    .join("")
    .trim();
  if (cleaned.length < 6) {
    return "";
  }
  return limitText(cleaned, 1000);
}

function sanitizeExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(seconds: number): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) {
    return "unknown";
  }
  const whole = Math.round(seconds);
  const mins = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function normalizeMimeType(inputMimeType: string | null | undefined, fileName?: string): string {
  const mimeType = String(inputMimeType ?? "").trim().toLowerCase();
  if (mimeType) {
    return mimeType;
  }
  const ext = path.extname(fileName ?? "").toLowerCase();
  switch (ext) {
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".pdf":
      return "application/pdf";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function extensionFromMimeType(mimeType: string): string {
  switch (mimeType) {
    case "audio/webm":
      return "webm";
    case "audio/mp4":
      return "m4a";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
      return "wav";
    default:
      return "bin";
  }
}

function labelForExtension(ext: string, mimeType: string): string {
  if (ext) {
    return ext.slice(1).toUpperCase();
  }
  return mimeType || "file";
}

function sanitizeFileName(name: string): string {
  const trimmed = name.trim() || "attachment";
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function isPlainTextLike(ext: string, mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    [".csv", ".json", ".log", ".md", ".txt", ".xml", ".yml", ".yaml"].includes(ext)
  );
}

function isWordLike(ext: string, mimeType: string): boolean {
  return (
    [".doc", ".docx", ".odt", ".rtf", ".rtfd"].includes(ext) ||
    mimeType.includes("wordprocessingml") ||
    mimeType === "application/msword" ||
    mimeType === "application/rtf"
  );
}

function isSpreadsheetLike(ext: string, mimeType: string): boolean {
  return (
    [".xls", ".xlsm", ".xlsx", ".xltx"].includes(ext) ||
    mimeType.includes("spreadsheetml") ||
    mimeType === "application/vnd.ms-excel"
  );
}

function isPresentationLike(ext: string, mimeType: string): boolean {
  return (
    [".ppt", ".ppsx", ".pptx"].includes(ext) ||
    mimeType.includes("presentationml") ||
    mimeType === "application/vnd.ms-powerpoint"
  );
}

function inferCategory(ext: string, mimeType: string): OmniScratchpadFileResult["category"] {
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (isSpreadsheetLike(ext, mimeType)) return "spreadsheet";
  if (isPresentationLike(ext, mimeType)) return "presentation";
  return "document";
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n\n...[truncated ${text.length - maxChars} chars]`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ensureDir(targetDir: string): void {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { mode: 0o700, recursive: true });
  }
}
