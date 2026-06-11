import { z } from "zod";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import type { Tool, ToolContext } from "../Tool.js";

const DEFAULT_BASE_URL = "https://lightmake.site";
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;

const inputSchema = z.object({
  action: z
    .enum(["search", "info", "files", "install"])
    .describe("SkillHub action to run"),
  query: z.string().optional().describe("Search keyword for action=search"),
  slug: z.string().optional().describe("Skill slug for info/files/install"),
  version: z.string().optional().describe("Skill version for files/install"),
  page: z.number().int().positive().optional().describe("Search page number"),
  pageSize: z
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_SIZE)
    .optional()
    .describe("Search page size"),
  scope: z
    .enum(["project", "global"])
    .optional()
    .describe("Install scope. project writes .neros/skills, global writes ~/.neros/skills"),
  force: z.boolean().optional().describe("Overwrite files when installing an existing skill"),
  baseUrl: z.string().url().optional().describe("SkillHub API base URL"),
});

type Input = z.infer<typeof inputSchema>;

type SkillHubSearchItem = {
  slug?: string;
  name?: string;
  description?: string;
  description_zh?: string;
  version?: string;
  downloads?: number;
  stars?: number;
  source?: string;
};

type SkillHubFile = {
  path?: string;
  size?: number;
  sha256?: string;
};

function assertSlug(slug: string | undefined): string {
  const value = slug?.trim();
  if (!value) {
    throw new Error("slug is required");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) {
    throw new Error(`Invalid SkillHub slug: ${slug}`);
  }
  return value;
}

function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, path: string, params?: Record<string, string | undefined>): URL {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function fetchJson<T>(url: URL, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "neros-skillhub-tool/0.1",
    },
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`SkillHub request failed ${response.status}: ${body.slice(0, 300)}`);
  }
  const text = await response.text();
  if (/^\s*</.test(text)) {
    throw new Error(
      `SkillHub returned HTML instead of JSON for ${url.pathname}. Try baseUrl=${DEFAULT_BASE_URL}`,
    );
  }
  return JSON.parse(text) as T;
}

async function fetchBytes(url: URL, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      "User-Agent": "neros-skillhub-tool/0.1",
    },
    signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`SkillHub file request failed ${response.status}: ${body.slice(0, 300)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function extractSearchResult(raw: unknown): { skills: SkillHubSearchItem[]; total: number } {
  const record = raw as {
    data?: { skills?: SkillHubSearchItem[]; total?: number };
    skills?: SkillHubSearchItem[];
    total?: number;
  };
  return {
    skills: Array.isArray(record.data?.skills)
      ? record.data.skills
      : Array.isArray(record.skills)
        ? record.skills
        : [],
    total:
      typeof record.data?.total === "number"
        ? record.data.total
        : typeof record.total === "number"
          ? record.total
          : 0,
  };
}

function extractFilesResult(raw: unknown): { files: SkillHubFile[]; version?: string } {
  const record = raw as { files?: SkillHubFile[]; version?: string };
  return {
    files: Array.isArray(record.files) ? record.files : [],
    version: record.version,
  };
}

function getSkillSummary(raw: unknown): Record<string, unknown> {
  const record = raw as Record<string, unknown>;
  const skill = (record["skill"] && typeof record["skill"] === "object"
    ? (record["skill"] as Record<string, unknown>)
    : record) as Record<string, unknown>;
  const latestVersion =
    record["latestVersion"] && typeof record["latestVersion"] === "object"
      ? (record["latestVersion"] as Record<string, unknown>)
      : undefined;
  return {
    slug: skill["slug"],
    name: skill["displayName"] ?? skill["name"],
    summary: skill["summary_zh"] ?? skill["summary"] ?? skill["description_zh"] ?? skill["description"],
    version: latestVersion?.["version"] ?? skill["version"],
    source: skill["source"],
    stats: skill["stats"],
    homepage: skill["homepage"] ?? skill["sourceUrl"],
  };
}

function resolveInstallRoot(context: ToolContext, scope: "project" | "global"): string {
  return scope === "global"
    ? resolve(homedir(), ".neros", "skills")
    : resolve(context.cwd, ".neros", "skills");
}

function assertSafeRelativePath(filePath: string | undefined): string {
  const value = filePath?.trim();
  if (!value || value.startsWith("/") || value.includes("\\")) {
    throw new Error(`Invalid SkillHub file path: ${filePath}`);
  }
  const resolved = resolve("/", value);
  const rel = relative("/", resolved);
  if (!rel || rel.startsWith("..")) {
    throw new Error(`Invalid SkillHub file path: ${filePath}`);
  }
  return rel;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function installSkillHubSkill(
  input: Input,
  context: ToolContext,
): Promise<Record<string, unknown>> {
  const slug = assertSlug(input.slug);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const scope = input.scope ?? "project";
  const root = resolveInstallRoot(context, scope);
  const targetDir = resolve(root, slug);
  const targetRel = relative(root, targetDir);
  if (targetRel.startsWith("..")) {
    throw new Error("Resolved skill path escapes the skills root");
  }
  if (!input.force && (await pathExists(targetDir))) {
    throw new Error(`Skill already exists at ${targetDir}. Pass force=true to overwrite files.`);
  }

  const filesUrl = buildUrl(baseUrl, `/api/v1/skills/${encodeURIComponent(slug)}/files`, {
    version: input.version,
  });
  const filesResult = extractFilesResult(await fetchJson<unknown>(filesUrl, context.signal));
  if (filesResult.files.length === 0) {
    throw new Error(`SkillHub returned no files for ${slug}`);
  }

  await mkdir(targetDir, { recursive: true });
  const written: string[] = [];
  for (const file of filesResult.files) {
    const safePath = assertSafeRelativePath(file.path);
    const fileUrl = buildUrl(baseUrl, `/api/v1/skills/${encodeURIComponent(slug)}/file`, {
      path: safePath,
      version: input.version ?? filesResult.version,
    });
    const bytes = await fetchBytes(fileUrl, context.signal);
    const outPath = resolve(targetDir, safePath);
    const rel = relative(targetDir, outPath);
    if (!rel || rel.startsWith("..")) {
      throw new Error(`Skill file escapes target directory: ${safePath}`);
    }
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, bytes);
    written.push(safePath);
  }

  const origin = {
    source: "skillhub",
    baseUrl,
    slug,
    version: input.version ?? filesResult.version,
    installedAt: new Date().toISOString(),
    files: written,
  };
  const originPath = resolve(targetDir, ".skillhub", "origin.json");
  await mkdir(dirname(originPath), { recursive: true });
  await writeFile(originPath, `${JSON.stringify(origin, null, 2)}\n`, "utf-8");

  return {
    ok: true,
    slug,
    version: origin.version,
    scope,
    targetDir,
    files: written,
  };
}

export const skillhubTool: Tool<Input, unknown> = {
  name: "skillhub",
  description:
    "Search SkillHub skills, inspect skill metadata/files, and install skills into .neros/skills or ~/.neros/skills.",
  inputSchema,
  parametersJsonSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["search", "info", "files", "install"],
        description: "SkillHub action to run",
      },
      query: { type: "string", description: "Search keyword for action=search" },
      slug: { type: "string", description: "Skill slug for info/files/install" },
      version: { type: "string", description: "Skill version for files/install" },
      page: { type: "number", description: "Search page number" },
      pageSize: { type: "number", description: "Search page size, max 50" },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "Install scope. project writes .neros/skills, global writes ~/.neros/skills",
      },
      force: { type: "boolean", description: "Overwrite files when installing an existing skill" },
      baseUrl: { type: "string", description: "SkillHub API base URL" },
    },
    required: ["action"],
  },
  risk: "network",
  isEnabled: () => true,
  async run(input: Input, context: ToolContext): Promise<unknown> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    switch (input.action) {
      case "search": {
        const page = String(input.page ?? 1);
        const pageSize = String(input.pageSize ?? DEFAULT_PAGE_SIZE);
        const url = buildUrl(baseUrl, "/api/skills", {
          keyword: input.query,
          page,
          pageSize,
        });
        const result = extractSearchResult(await fetchJson<unknown>(url, context.signal));
        return {
          total: result.total,
          skills: result.skills.map((skill) => ({
            slug: skill.slug,
            name: skill.name,
            description: skill.description_zh ?? skill.description,
            version: skill.version,
            downloads: skill.downloads,
            stars: skill.stars,
            source: skill.source,
          })),
        };
      }
      case "info": {
        const slug = assertSlug(input.slug);
        const url = buildUrl(baseUrl, `/api/v1/skills/${encodeURIComponent(slug)}`);
        return getSkillSummary(await fetchJson<unknown>(url, context.signal));
      }
      case "files": {
        const slug = assertSlug(input.slug);
        const url = buildUrl(baseUrl, `/api/v1/skills/${encodeURIComponent(slug)}/files`, {
          version: input.version,
        });
        return extractFilesResult(await fetchJson<unknown>(url, context.signal));
      }
      case "install":
        return installSkillHubSkill(input, context);
    }
  },
};
