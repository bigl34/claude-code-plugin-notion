import { wrapUntrustedField } from "@local/cli-utils";

/* eslint-disable @typescript-eslint/no-explicit-any -- Notion API payloads are
   dynamic, schema-varying JSON; this mirrors cli.ts / notion-connector. */
type NotionJson = Record<string, any>;


const NOTION_ID = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ENUM_TOKEN = /^[a-z][a-z0-9_]{0,63}$/;

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

const CURSOR = /^[A-Za-z0-9_\-=:.]{1,512}$/;

const PROPERTY_ID = /^[A-Za-z0-9%_'~!*().+\-]{1,128}$/;

const TIME_ZONE = /^[A-Za-z][A-Za-z0-9+_\-]*(?:\/[A-Za-z0-9+_\-]+){0,2}$/;

const CODE_LANGUAGE = /^[a-z0-9+#.\- ]{1,32}$/;

const SMUGGLING_CODEPOINTS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFE00-\uFE0F\uFEFF]/;

function isNotionId(value: string): boolean {
  return NOTION_ID.test(value);
}

function isNotionIdOrPropertyId(value: string): boolean {
  return NOTION_ID.test(value) || PROPERTY_ID.test(value);
}

function isEnumToken(value: string): boolean {
  return ENUM_TOKEN.test(value);
}

function isIsoTimestamp(value: string): boolean {
  return ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function isCursor(value: string): boolean {
  return CURSOR.test(value);
}

function isTimeZone(value: string): boolean {
  return TIME_ZONE.test(value);
}

function isCodeLanguage(value: string): boolean {
  return CODE_LANGUAGE.test(value);
}

export function isPlainEmoji(value: string): boolean {
  if (value.length === 0 || value.length > 8) return false;
  if (SMUGGLING_CODEPOINTS.test(value)) return false;
  const codepoints = [...value];
  if (codepoints.length > 2) return false;
  return codepoints.every((codepoint) => /\p{Extended_Pictographic}/u.test(codepoint));
}

const NOTION_URL_HOSTS = new Set(["notion.so", "www.notion.so", "app.notion.com"]);
const CANONICAL_NOTION_URL = /^https:\/\/(?:notion\.so|www\.notion\.so|app\.notion\.com)\/(?:p\/)?[0-9a-f]{32}$/;

export function canonicalizeNotionUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!NOTION_URL_HOSTS.has(parsed.hostname)) return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (!last) return null;
  const match = /^(?:.*-)?([0-9a-f]{32})$/.exec(last);
  if (!match) return null;

  const prefix = segments[0] === "p" ? "p/" : "";
  const canonical = `https://${parsed.hostname}/${prefix}${match[1]}`;
  return CANONICAL_NOTION_URL.test(canonical) ? canonical : null;
}

const BARE_STRING_VALIDATORS: Record<string, (value: string) => boolean> = {
  id: isNotionIdOrPropertyId,
  object: isEnumToken,
  type: isEnumToken,
  page_id: isNotionId,
  database_id: isNotionId,
  data_source_id: isNotionId,
  block_id: isNotionId,
  workspace_id: isNotionId,
  user_id: isNotionId,
  comment_id: isNotionId,
  discussion_id: isNotionId,
  parent_id: isNotionId,
  _parent_id: isNotionId,
  request_id: isNotionId,
  next_cursor: isCursor,
  start_cursor: isCursor,
  created_time: isIsoTimestamp,
  last_edited_time: isIsoTimestamp,
  edited_time: isIsoTimestamp,
  expiry_time: isIsoTimestamp,
  start: isIsoTimestamp,
  end: isIsoTimestamp,
  time_zone: isTimeZone,
  color: isEnumToken,
  format: isEnumToken,
  function: isEnumToken,
  state: isEnumToken,
  role: isEnumToken,
  language: isCodeLanguage,
  emoji: isPlainEmoji,
};


const BODY_TIER_KEYS = new Set(["plain_text", "content", "expression"]);
const TITLE_TIER_KEYS = new Set(["title", "text"]);
const URL_TIER_KEYS = new Set(["url", "href", "public_url", "avatar_url", "link", "propertyNames"]);
const NAME_TIER_KEYS = new Set([
  "name",
  "email",
  "phone_number",
  "prefix",
  "workspace_name",
  "rollup_property_name",
  "relation_property_name",
  "synced_property_name",
]);

export function capFor(key: string): number {
  if (BODY_TIER_KEYS.has(key)) return 8000;
  if (TITLE_TIER_KEYS.has(key)) return 500;
  if (URL_TIER_KEYS.has(key)) return 2000;
  if (NAME_TIER_KEYS.has(key)) return 200;
  return 2000;
}


const WRAPPER_KEYS = new Set([
  "_trust",
  "_field",
  "value",
  "truncated",
  "originalLength",
  "htmlConverted",
  "suspicious",
]);
const SAFE_FIELD_PATH = /^[A-Za-z0-9_.[\]]+$/;

export function isWrappedFieldShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate._trust !== "untrusted") return false;
  if (typeof candidate._field !== "string" || !SAFE_FIELD_PATH.test(candidate._field)) return false;
  if (typeof candidate.value !== "string") return false;
  for (const [key, entry] of Object.entries(candidate)) {
    if (!WRAPPER_KEYS.has(key)) return false;
    if (key === "truncated" || key === "htmlConverted" || key === "suspicious") {
      if (entry !== true) return false;
    }
    if (key === "originalLength" && typeof entry !== "number") return false;
  }
  return true;
}


const SAFE_OBJECT_KEY = /^[A-Za-z0-9_]+$/;

export interface NotionPropertyEntry {
  name: unknown;
  id: unknown;
  type: unknown;
  value: unknown;
}

export function looksLikePropertyMap(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(([, entry]) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const property = entry as Record<string, unknown>;
    const type = property.type;
    if (typeof type !== "string" || type.length === 0) return false;
    if (!Object.prototype.hasOwnProperty.call(property, type)) return false;
    return typeof property.id === "string" && property.id.length > 0;
  });
}


export interface WrapStats {
  wrapped: number;
  suspicious: number;
  truncated: number;
  notes: string[];
}

export function createWrapStats(): WrapStats {
  return { wrapped: 0, suspicious: 0, truncated: 0, notes: [] };
}

export interface DeepWrapOptions {
  stats?: WrapStats;
  canonicalUrlPaths?: ReadonlySet<string>;
  maxDepth?: number;
  maxArrayLength?: number;
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_ARRAY_LENGTH = 5000;
const STRUCTURAL_SUMMARY_CAP = 4000;

function childPath(path: string, key: string): string {
  return path.length > 0 ? `${path}.${key}` : key;
}

function wrapLeaf(path: string, key: string, value: string, stats: WrapStats | undefined): unknown {
  const wrapped = wrapUntrustedField(path, value, { maxChars: capFor(key) });
  if (stats) {
    stats.wrapped += 1;
    if (wrapped.suspicious) stats.suspicious += 1;
    if (wrapped.truncated) stats.truncated += 1;
  }
  return wrapped;
}

function wrapStructure(path: string, key: string, value: unknown, stats: WrapStats | undefined, why: string): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "";
  } catch {
    serialized = "[unserialisable]";
  }
  if (stats) stats.notes.push(`${path}: ${why}`);
  const wrapped = wrapUntrustedField(path, serialized, { maxChars: Math.max(capFor(key), STRUCTURAL_SUMMARY_CAP) });
  if (stats) {
    stats.wrapped += 1;
    if (wrapped.suspicious) stats.suspicious += 1;
    if (wrapped.truncated) stats.truncated += 1;
  }
  return wrapped;
}

export function deepWrapNotion(value: unknown, path: string, options: DeepWrapOptions = {}): unknown {
  return deepWrapInternal(value, path, path.split(".").pop() ?? path, 0, options);
}

function deepWrapInternal(
  value: unknown,
  path: string,
  key: string,
  depth: number,
  options: DeepWrapOptions,
): unknown {
  const stats = options.stats;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;

  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;

  if (typeof value === "string") {
    if (options.canonicalUrlPaths?.has(path)) {
      const canonical = canonicalizeNotionUrl(value);
      if (canonical !== null) return canonical;
      return wrapLeaf(path, key, value, stats);
    }
    const validator = BARE_STRING_VALIDATORS[key];
    if (validator && validator(value)) return value;
    return wrapLeaf(path, key, value, stats);
  }

  if (typeof value !== "object") {
    return wrapLeaf(path, key, String(value), stats);
  }

  if (isWrappedFieldShape(value)) return value;

  if (depth >= maxDepth) {
    return wrapStructure(path, key, value, stats, `structure deeper than ${maxDepth} levels was summarised`);
  }

  if (Array.isArray(value)) {
    const arrayItemPath = `${path}[]`;
    const limited = value.length > maxArrayLength;
    const items = (limited ? value.slice(0, maxArrayLength) : value).map((item) =>
      deepWrapInternal(item, arrayItemPath, key, depth + 1, options),
    );
    if (limited && stats) {
      stats.notes.push(`${path}: array truncated to ${maxArrayLength} of ${value.length} items`);
    }
    return items;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);

  if (looksLikePropertyMap(record)) {
    return notionPropertyEntries(record, path, { ...options, depth: depth + 1 });
  }

  if (keys.some((candidate) => !SAFE_OBJECT_KEY.test(candidate))) {
    return wrapStructure(path, key, record, stats, "object keys are not structural; wrapped whole");
  }

  return Object.fromEntries(
    keys.map((candidate) => [
      candidate,
      deepWrapInternal(record[candidate], childPath(path, candidate), candidate, depth + 1, options),
    ]),
  );
}

export function notionPropertyEntries(
  properties: NotionJson | undefined,
  path: string,
  options: DeepWrapOptions & { depth?: number } = {},
): NotionPropertyEntry[] {
  if (!properties || typeof properties !== "object") return [];
  const entryPath = `${path}[]`;
  const depth = options.depth ?? 0;
  return Object.entries(properties).map(([name, property]) => {
    const record = (property ?? {}) as Record<string, unknown>;
    const rawId = record.id;
    const rawType = record.type;
    return {
      name: wrapLeaf(childPath(entryPath, "name"), "name", name, options.stats),
      id: typeof rawId === "string" && isNotionIdOrPropertyId(rawId)
        ? rawId
        : deepWrapInternal(rawId, childPath(entryPath, "id"), "id", depth, options),
      type: typeof rawType === "string" && isEnumToken(rawType)
        ? rawType
        : deepWrapInternal(rawType, childPath(entryPath, "type"), "type", depth, options),
      value: deepWrapInternal(record, childPath(entryPath, "value"), "value", depth, options),
    };
  });
}


export const NOTION_RESPONSE_LIMITS = {
  maxBytes: 2_000_000,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxNodes: 400_000,
  maxArrayLength: DEFAULT_MAX_ARRAY_LENGTH,
} as const;

export interface ResponseMeasurement {
  bytes: number;
  depth: number;
  nodes: number;
  maxArrayLength: number;
  withinBudget: boolean;
  violations: string[];
}

export function notionResponseBudget(value: unknown): ResponseMeasurement {
  let bytes = 0;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf-8");
  } catch {
    bytes = Number.POSITIVE_INFINITY;
  }

  let nodes = 0;
  let depth = 0;
  let widest = 0;
  const queue: Array<{ node: unknown; level: number }> = [{ node: value, level: 1 }];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) break;
    nodes += 1;
    if (current.level > depth) depth = current.level;
    const node = current.node;
    if (Array.isArray(node)) {
      if (node.length > widest) widest = node.length;
      for (const item of node) queue.push({ node: item, level: current.level + 1 });
    } else if (node && typeof node === "object") {
      for (const item of Object.values(node as Record<string, unknown>)) {
        queue.push({ node: item, level: current.level + 1 });
      }
    }
  }

  const violations: string[] = [];
  if (bytes > NOTION_RESPONSE_LIMITS.maxBytes) violations.push(`bytes ${bytes} > ${NOTION_RESPONSE_LIMITS.maxBytes}`);
  if (depth > NOTION_RESPONSE_LIMITS.maxDepth) violations.push(`depth ${depth} > ${NOTION_RESPONSE_LIMITS.maxDepth}`);
  if (nodes > NOTION_RESPONSE_LIMITS.maxNodes) violations.push(`nodes ${nodes} > ${NOTION_RESPONSE_LIMITS.maxNodes}`);
  if (widest > NOTION_RESPONSE_LIMITS.maxArrayLength) {
    violations.push(`array length ${widest} > ${NOTION_RESPONSE_LIMITS.maxArrayLength}`);
  }

  return { bytes, depth, nodes, maxArrayLength: widest, withinBudget: violations.length === 0, violations };
}


export function notionPageTitle(obj: NotionJson | undefined): string {
  const props = obj?.properties ?? {};
  for (const value of Object.values(props as Record<string, any>)) {
    if (value?.type === "title" && Array.isArray(value.title) && value.title.length > 0) {
      return value.title.map((t: any) => t?.plain_text ?? "").join("");
    }
  }
  if (Array.isArray(obj?.title)) {
    return obj!.title.map((t: any) => t?.plain_text ?? "").join("");
  }
  if (typeof obj?.title === "string") return obj.title;
  return "";
}

export function richTextToPlain(richText: any[] | undefined): string {
  if (!Array.isArray(richText)) return "";
  return richText.map((t: any) => t?.plain_text ?? "").join("");
}

function personOrIdLabel(person: NotionJson | undefined): string {
  if (!person) return "";
  return person.name || person.id || "";
}

function compactJsonLabel(raw: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return "";
  }
  if (!json || json === "{}" || json === "[]" || json === "null") return "";
  return json.length > 500 ? `${json.slice(0, 500)}…` : json;
}

export function notionPropertyToText(name: string, prop: NotionJson | undefined): string {
  if (!prop || prop.type === "title") return "";
  switch (prop.type) {
    case "rich_text": {
      const text = richTextToPlain(prop.rich_text);
      return text ? `${name}: ${text}` : "";
    }
    case "number":
      return prop.number !== null && prop.number !== undefined ? `${name}: ${prop.number}` : "";
    case "select":
      return prop.select ? `${name}: ${prop.select.name}` : "";
    case "multi_select": {
      const selected = (prop.multi_select ?? []).map((s: any) => s.name).join(", ");
      return selected ? `${name}: ${selected}` : "";
    }
    case "status":
      return prop.status ? `${name}: ${prop.status.name}` : "";
    case "date":
      if (prop.date) {
        const { start, end } = prop.date;
        return end ? `${name}: ${start} → ${end}` : `${name}: ${start}`;
      }
      return "";
    case "checkbox":
      return `${name}: ${prop.checkbox ? "Yes" : "No"}`;
    case "url":
      return prop.url ? `${name}: ${prop.url}` : "";
    case "email":
      return prop.email ? `${name}: ${prop.email}` : "";
    case "phone_number":
      return prop.phone_number ? `${name}: ${prop.phone_number}` : "";
    case "people": {
      const people = (prop.people ?? []).map((p: any) => p.name || p.id).join(", ");
      return people ? `${name}: ${people}` : "";
    }
    case "files": {
      const files = (prop.files ?? [])
        .map((f: any) => f.name || f.external?.url || f.file?.url)
        .join(", ");
      return files ? `${name}: ${files}` : "";
    }
    case "relation": {
      const count = prop.relation?.length || 0;
      return count > 0 ? `${name}: ${count} linked items` : "";
    }
    case "formula":
      if (prop.formula) {
        const value = prop.formula.string
          ?? prop.formula.number
          ?? prop.formula.boolean
          ?? prop.formula.date?.start;
        return value !== undefined && value !== null ? `${name}: ${value}` : "";
      }
      return "";
    case "rollup":
      if (prop.rollup) {
        const value = prop.rollup.number
          ?? prop.rollup.date?.start
          ?? prop.rollup.array?.length;
        return value !== undefined && value !== null ? `${name}: ${value}` : "";
      }
      return "";
    case "unique_id": {
      const number = prop.unique_id?.number;
      if (number === null || number === undefined) return "";
      const prefix = prop.unique_id?.prefix;
      return `${name}: ${prefix ? `${prefix}-${number}` : number}`;
    }
    case "created_time":
      return prop.created_time ? `${name}: ${prop.created_time}` : "";
    case "last_edited_time":
      return prop.last_edited_time ? `${name}: ${prop.last_edited_time}` : "";
    case "created_by": {
      const label = personOrIdLabel(prop.created_by);
      return label ? `${name}: ${label}` : "";
    }
    case "last_edited_by": {
      const label = personOrIdLabel(prop.last_edited_by);
      return label ? `${name}: ${label}` : "";
    }
    case "verification": {
      const state = prop.verification?.state;
      if (!state) return "";
      const by = personOrIdLabel(prop.verification?.verified_by);
      return by ? `${name}: ${state} (${by})` : `${name}: ${state}`;
    }
    default: {
      const raw = prop[prop.type];
      if (raw === null || raw === undefined) return "";
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        const text = String(raw);
        return text ? `${name}: ${text}` : "";
      }
      const label = compactJsonLabel(raw);
      return label ? `${name}: ${label}` : "";
    }
  }
}

export function notionPropertiesToText(properties: NotionJson | undefined): string {
  if (!properties) return "";
  const lines: string[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const text = notionPropertyToText(key, value as NotionJson);
    if (text) lines.push(text);
  }
  return lines.join("\n");
}

export function notionBlockPlainText(block: NotionJson | undefined): string {
  const type = block?.type;
  if (!type || typeof type !== "string") return "";
  const data = block[type];
  if (type === "table_row" && Array.isArray(data?.cells)) {
    return data.cells
      .map((cell: any[]) => richTextToPlain(cell))
      .filter((cellText: string) => cellText.length > 0)
      .join(" | ");
  }
  return richTextToPlain(data?.rich_text);
}


interface NotionBlockChildrenPage {
  results?: NotionJson[];
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionBlockChildrenOptions {
  startCursor?: string;
  pageSize?: number;
}

interface FlattenNotionBlocksOptions {
  parentId: string;
  maxDepth: number;
  maxBlocks?: number;
  fetchChildren: (blockId: string, options?: NotionBlockChildrenOptions) => Promise<NotionBlockChildrenPage>;
}

function isUnsupportedChildrenError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string" &&
    (error as { message: string }).message.includes("not supported")
  );
}

export interface FlattenedNotionBlocks {
  blocks: NotionJson[];
  truncated: boolean;
}

export async function flattenNotionBlocksDepthFirstWithTruncation(
  blocks: NotionJson[],
  options: FlattenNotionBlocksOptions,
): Promise<FlattenedNotionBlocks> {
  const out: NotionJson[] = [];
  let truncated = false;
  const maxBlocks = options.maxBlocks;
  const remaining = (): number =>
    maxBlocks === undefined ? Number.POSITIVE_INFINITY : Math.max(maxBlocks - out.length, 0);

  const walk = async (nodes: NotionJson[], parentId: string, currentDepth: number): Promise<void> => {
    for (const block of nodes) {
      if (remaining() <= 0) {
        truncated = true;
        break;
      }
      out.push({ ...block, _parent_id: parentId, _depth: currentDepth });

      if (!block.has_children || currentDepth >= options.maxDepth) {
        continue;
      }
      if (remaining() <= 0) {
        truncated = true;
        continue;
      }

      let startCursor: string | undefined;
      do {
        const room = remaining();
        if (room <= 0) {
          truncated = true;
          break;
        }
        try {
          const page = await options.fetchChildren(block.id, {
            startCursor,
            pageSize: Number.isFinite(room) ? Math.min(100, room) : undefined,
          });
          await walk(page.results ?? [], block.id, currentDepth + 1);
          startCursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
        } catch (error) {
          if (isUnsupportedChildrenError(error)) {
            break;
          }
          throw error;
        }
      } while (startCursor);
    }
  };

  await walk(blocks, options.parentId, 0);
  return { blocks: out, truncated };
}

export async function flattenNotionBlocksDepthFirst(
  blocks: NotionJson[],
  options: FlattenNotionBlocksOptions,
): Promise<NotionJson[]> {
  const flattened = await flattenNotionBlocksDepthFirstWithTruncation(blocks, options);
  return flattened.blocks;
}

export interface ViewOptions {
  stats?: WrapStats;
  fieldPrefix?: string;
  includePayload?: boolean;
}

function fieldPrefixOf(options: ViewOptions): string {
  return options.fieldPrefix ?? "";
}

function payloadPathOf(options: ViewOptions): string {
  return `${fieldPrefixOf(options)}payload`;
}

function payloadOf(object: NotionJson | undefined, options: ViewOptions, canonicalUrl: boolean): unknown {
  const path = payloadPathOf(options);
  return deepWrapNotion(object ?? {}, path, {
    stats: options.stats,
    canonicalUrlPaths: canonicalUrl ? new Set([`${path}.url`, `${path}.public_url`]) : undefined,
  });
}

function wrappedTitle(object: NotionJson | undefined, field: string, stats: WrapStats | undefined): unknown {
  return wrapLeaf(field, "title", notionPageTitle(object), stats);
}

export function conveniencePageUrl(object: NotionJson | undefined, field: string, stats: WrapStats | undefined): unknown {
  const canonical = canonicalizeNotionUrl(object?.url);
  if (canonical !== null) return canonical;
  if (typeof object?.url === "string" && object.url.length > 0) {
    return wrapLeaf(field, "url", object.url, stats);
  }
  const id = typeof object?.id === "string" ? object.id.replace(/-/g, "") : "";
  return NOTION_ID.test(id) ? `https://www.notion.so/${id}` : "";
}

export function notionPageView(page: NotionJson, options: ViewOptions = {}) {
  const prefix = fieldPrefixOf(options);
  const base = {
    title: wrappedTitle(page, `${prefix}title`, options.stats),
    properties: wrapLeaf(`${prefix}properties`, "content", notionPropertiesToText(page?.properties), options.stats),
  };
  if (options.includePayload === false) return base;
  return { ...base, payload: payloadOf(page, options, true) };
}

export function notionRowView(row: NotionJson, options: ViewOptions = {}) {
  const prefix = fieldPrefixOf(options);
  const base = {
    id: row?.id,
    url: conveniencePageUrl(row, `${prefix}url`, options.stats),
    created_time: row?.created_time,
    last_edited_time: row?.last_edited_time,
    title: wrappedTitle(row, `${prefix}title`, options.stats),
    properties: wrapLeaf(`${prefix}properties`, "content", notionPropertiesToText(row?.properties), options.stats),
  };
  if (options.includePayload === false) return base;
  return { ...base, payload: payloadOf(row, options, true) };
}

export function notionDatabaseView(db: NotionJson, options: ViewOptions = {}) {
  const prefix = fieldPrefixOf(options);
  const base = {
    id: db?.id,
    object: db?.object,
    url: conveniencePageUrl(db, `${prefix}url`, options.stats),
    created_time: db?.created_time,
    last_edited_time: db?.last_edited_time,
    title: wrappedTitle(db, `${prefix}title`, options.stats),
    propertyNames: wrapLeaf(
      `${prefix}propertyNames`,
      "propertyNames",
      Object.keys(db?.properties ?? {}).join(", "),
      options.stats,
    ),
    schema: notionPropertyEntries(db?.properties, `${prefix}schema`, { stats: options.stats }),
  };
  if (options.includePayload === false) return base;
  return { ...base, payload: payloadOf(db, options, true) };
}

export function notionBlockView(block: NotionJson, options: ViewOptions = {}) {
  const prefix = fieldPrefixOf(options);
  const base = {
    id: block?.id,
    type: block?.type,
    has_children: block?.has_children,
    created_time: block?.created_time,
    last_edited_time: block?.last_edited_time,
    parent_id: block?._parent_id,
    depth: block?._depth,
    text: wrapLeaf(`${prefix}text`, "content", notionBlockPlainText(block), options.stats),
  };
  if (options.includePayload === false) return base;
  return { ...base, payload: payloadOf(block, options, false) };
}

export function notionSearchItemView(
  item: NotionJson,
  options: ViewOptions & { parentDatabaseTitle?: string } = {},
) {
  const prefix = fieldPrefixOf(options);
  const base: NotionJson = {
    id: item?.id,
    object: item?.object,
    url: conveniencePageUrl(item, `${prefix}url`, options.stats),
    created_time: item?.created_time,
    last_edited_time: item?.last_edited_time,
    parent: item?.parent
      ? {
          type: item.parent.type,
          database_id: item.parent.database_id,
          page_id: item.parent.page_id,
          workspace: item.parent.workspace,
          block_id: item.parent.block_id,
        }
      : undefined,
    title: wrappedTitle(item, `${prefix}title`, options.stats),
  };
  if (options.parentDatabaseTitle !== undefined) {
    base.parent_database_title = wrapLeaf(
      `${prefix}parent_database_title`,
      "title",
      options.parentDatabaseTitle,
      options.stats,
    );
  }
  if (options.includePayload === false) return base;
  return { ...base, payload: payloadOf(item, options, true) };
}

export function notionCommentView(comment: NotionJson, options: ViewOptions = {}) {
  const prefix = fieldPrefixOf(options);
  const base = {
    id: comment?.id,
    created_time: comment?.created_time,
    last_edited_time: comment?.last_edited_time,
    created_by: comment?.created_by?.id,
    parent: comment?.parent
      ? { type: comment.parent.type, page_id: comment.parent.page_id, block_id: comment.parent.block_id }
      : undefined,
    discussion_id: comment?.discussion_id,
    text: wrapLeaf(`${prefix}text`, "content", richTextToPlain(comment?.rich_text), options.stats),
  };
  if (options.includePayload === false) return base;
  return { ...base, payload: payloadOf(comment, options, false) };
}

export function notionUserView(user: NotionJson, options: ViewOptions = {}) {
  const prefix = fieldPrefixOf(options);
  const base = {
    id: user?.id,
    object: user?.object,
    type: user?.type,
    name: wrapLeaf(`${prefix}name`, "name", user?.name ?? "", options.stats),
  };
  if (options.includePayload === false) return base;
  return { ...base, payload: payloadOf(user, options, false) };
}

export function notionWriteEcho(
  command: string,
  response: NotionJson | undefined,
  options: { stats?: WrapStats } = {},
): { metadata: NotionJson; content: NotionJson } {
  const record = (response ?? {}) as NotionJson;
  const metadata: NotionJson = { command };
  const id = typeof record.id === "string" && isNotionId(record.id) ? record.id : undefined;
  if (id) metadata.id = id;
  if (typeof record.object === "string" && isEnumToken(record.object)) metadata.object = record.object;
  if (typeof record.type === "string" && isEnumToken(record.type)) metadata.type = record.type;
  for (const key of ["created_time", "last_edited_time"] as const) {
    const value = record[key];
    if (typeof value === "string" && isIsoTimestamp(value)) metadata[key] = value;
  }
  const canonicalUrl = canonicalizeNotionUrl(record.url);
  if (canonicalUrl) metadata.url = canonicalUrl;
  for (const key of ["archived", "in_trash", "is_archived", "has_children"] as const) {
    if (typeof record[key] === "boolean") metadata[key] = record[key];
  }
  return {
    metadata,
    content: { payload: deepWrapNotion(record, "payload", { stats: options.stats, canonicalUrlPaths: new Set(["payload.url", "payload.public_url"]) }) },
  };
}

export function wrapStatsNotes(stats: WrapStats): string[] {
  const notes = [...stats.notes];
  if (stats.suspicious > 0) {
    notes.push(`${stats.suspicious} untrusted field(s) matched a known prompt-injection pattern`);
  }
  if (stats.truncated > 0) {
    notes.push(`${stats.truncated} untrusted field(s) were truncated at their per-key cap`);
  }
  return notes;
}
