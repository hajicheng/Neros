import React, { useEffect, useMemo, useState } from "react";
import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Box, Text, useInput } from "ink";
import { installSkillHubSkill } from "@neros/core/tools/builtin/skillhub.js";

type Props = {
  onSubmit: (content: string) => void;
  onCancel: () => void;
  isProcessing: boolean;
  cwd: string;
  columns: number;
};

type SkillEntry = {
  slug: string;
  name: string;
  description: string;
  scope: "project" | "global";
  path: string;
};

type SkillPanelMode = "closed" | "list" | "add";
type SlashCommand = {
  name: string;
  description: string;
};

const MAX_VISIBLE_SKILL_OPTIONS = 8;
const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/skills", description: "Browse and add downloaded skills" },
];

function parseFrontmatterValue(raw: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, "im").exec(raw);
  if (!match?.[1]) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

async function loadSkillsFromDir(
  dir: string,
  scope: SkillEntry["scope"],
): Promise<SkillEntry[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: SkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    try {
      const raw = await readFile(skillFile, "utf-8");
      const name = parseFrontmatterValue(raw, "name") || entry.name;
      const description = parseFrontmatterValue(raw, "description");
      skills.push({
        slug: entry.name,
        name,
        description,
        scope,
        path: skillDir,
      });
    } catch {
      // Ignore folders that are not skills.
    }
  }
  return skills;
}

async function loadDownloadedSkills(cwd: string): Promise<SkillEntry[]> {
  const projectDir = resolve(cwd, ".neros", "skills");
  const globalDir = resolve(homedir(), ".neros", "skills");
  const [projectSkills, globalSkills] = await Promise.all([
    loadSkillsFromDir(projectDir, "project"),
    loadSkillsFromDir(globalDir, "global"),
  ]);
  const merged = new Map<string, SkillEntry>();
  for (const skill of globalSkills) merged.set(skill.slug, skill);
  for (const skill of projectSkills) merged.set(skill.slug, skill);
  return [...merged.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return "…";
  return `${value.slice(0, maxLength - 1)}…`;
}

export function InputBox({ onSubmit, onCancel, isProcessing, cwd, columns }: Props) {
  const [input, setInput] = useState("");
  const [skillMode, setSkillMode] = useState<SkillPanelMode>("closed");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [selectedSlashIndex, setSelectedSlashIndex] = useState(0);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [addStatus, setAddStatus] = useState<string | null>(null);
  const [deleteStatus, setDeleteStatus] = useState<string | null>(null);
  const isInstallingSkill = addStatus?.startsWith("Installing ") ?? false;

  const isSkillsCommand = input.trim() === "/skills";
  const isSlashInput = input === "/" || (input.startsWith("/") && !isSkillsCommand);
  const filteredSlashCommands = useMemo(() => {
    const query = input.slice(1).trim().toLowerCase();
    const commands = query
      ? SLASH_COMMANDS.filter((command) => command.name.slice(1).includes(query))
      : SLASH_COMMANDS;
    return commands.length > 0 ? commands : SLASH_COMMANDS;
  }, [input]);
  const skillOptions = useMemo(
    () => [...skills, { slug: "__add_more__", name: "Add More", description: "", scope: "project" as const, path: "" }],
    [skills],
  );
  const visibleSkillCount = Math.min(MAX_VISIBLE_SKILL_OPTIONS, skillOptions.length);
  const firstVisibleSkillIndex = clamp(
    selectedSkillIndex - visibleSkillCount + 1,
    0,
    Math.max(0, skillOptions.length - visibleSkillCount),
  );
  const visibleSkillOptions = skillOptions.slice(
    firstVisibleSkillIndex,
    firstVisibleSkillIndex + visibleSkillCount,
  );
  const labelWidth = clamp(Math.floor(columns * 0.34), 18, 34);
  const descWidth = Math.max(12, columns - labelWidth - 10);
  const inputWidth = Math.max(8, columns - 6);
  const displayInput =
    input.length > inputWidth ? `…${input.slice(-(inputWidth - 1))}` : input;
  const separator = "─".repeat(Math.max(1, (columns || 80) - 1));

  useEffect(() => {
    if (!isSkillsCommand || skillMode === "add") return;
    let cancelled = false;
    setSkillMode("list");
    setSkillsLoading(true);
    setSkillsError(null);
    setDeleteStatus(null);
    loadDownloadedSkills(cwd)
      .then((items) => {
        if (cancelled) return;
        setSkills(items);
        setSelectedSkillIndex(0);
      })
      .catch((err) => {
        if (cancelled) return;
        setSkillsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, isSkillsCommand, skillMode]);

  useEffect(() => {
    if (!isSkillsCommand && skillMode !== "add") {
      setSkillMode("closed");
    }
  }, [isSkillsCommand, skillMode]);

  useEffect(() => {
    if (skillMode === "closed" && isSlashInput) {
      setSlashMenuOpen(true);
      setSelectedSlashIndex(0);
    } else {
      setSlashMenuOpen(false);
    }
  }, [isSlashInput, skillMode]);

  useInput(
    (ch, key) => {
      if (slashMenuOpen) {
        if (key.escape) {
          setSlashMenuOpen(false);
          setInput("");
          return;
        }
        if (key.upArrow) {
          setSelectedSlashIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedSlashIndex((prev) =>
            Math.min(filteredSlashCommands.length - 1, prev + 1),
          );
          return;
        }
        if (key.return) {
          const selected = filteredSlashCommands[selectedSlashIndex];
          if (!selected) return;
          setInput(selected.name);
          setSlashMenuOpen(false);
          if (selected.name === "/skills") {
            setSkillMode("list");
          }
          return;
        }
      }

      if (skillMode === "list") {
        if (key.escape) {
          if (isProcessing) {
            onCancel();
            return;
          }
          setSkillMode("closed");
          setInput("");
          return;
        }
        if (key.upArrow) {
          setSelectedSkillIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedSkillIndex((prev) => Math.min(skillOptions.length - 1, prev + 1));
          return;
        }
        if (key.pageUp) {
          setSelectedSkillIndex((prev) => Math.max(0, prev - MAX_VISIBLE_SKILL_OPTIONS));
          return;
        }
        if (key.pageDown) {
          setSelectedSkillIndex((prev) =>
            Math.min(skillOptions.length - 1, prev + MAX_VISIBLE_SKILL_OPTIONS),
          );
          return;
        }
        if (key.return) {
          if (isProcessing || skillsLoading) return;
          const selected = skillOptions[selectedSkillIndex];
          if (!selected) return;
          if (selected.slug === "__add_more__") {
            setSkillMode("add");
            setInput("");
            setAddStatus(null);
            return;
          }
          onSubmit(
            `请读取并使用已下载的 skill "${selected.name}"。Skill 路径: ${selected.path}`,
          );
          setSkillMode("closed");
          setInput("");
          return;
        }
        if (ch === "d") {
          if (isProcessing || skillsLoading) return;
          const selected = skillOptions[selectedSkillIndex];
          if (!selected || selected.slug === "__add_more__") return;
          setDeleteStatus(`Deleting ${selected.name}…`);
          void rm(selected.path, { recursive: true, force: true })
            .then(async () => {
              const updated = await loadDownloadedSkills(cwd);
              setSkills(updated);
              setSelectedSkillIndex((prev) => Math.min(prev, updated.length));
              setDeleteStatus(`Deleted ${selected.name}`);
            })
            .catch((err) => {
              setDeleteStatus(err instanceof Error ? err.message : String(err));
            });
          return;
        }
      }

      if (skillMode === "add") {
        if (key.escape) {
          if (isProcessing || isInstallingSkill) {
            onCancel();
            return;
          }
          setSkillMode("list");
          setInput("/skills");
          setAddStatus(null);
          return;
        }
        if (key.return) {
          if (isProcessing || isInstallingSkill) return;
          if (input.trim()) {
            const slug = input.trim();
            setAddStatus(`Installing ${slug}…`);
            void installSkillHubSkill(
              { action: "install", slug, scope: "project", force: true },
              { cwd },
            )
              .then(async (result) => {
                const targetDir =
                  result && typeof result === "object" && "targetDir" in result
                    ? String(result.targetDir)
                    : "";
                setAddStatus(`Installed ${slug}${targetDir ? ` -> ${targetDir}` : ""}`);
                setInput("/skills");
                setSkillMode("list");
                setSkills(await loadDownloadedSkills(cwd));
                setSelectedSkillIndex(0);
              })
              .catch((err) => {
                setAddStatus(err instanceof Error ? err.message : String(err));
              });
          }
          return;
        }
      }

      if (key.return) {
        if (isProcessing) return;
        if (isSkillsCommand) {
          setSkillMode("list");
          return;
        }
        if (input.trim()) {
          onSubmit(input);
          setInput("");
        }
        return;
      }
      if (key.escape) {
        if (isProcessing) {
          onCancel();
        } else {
          setInput("");
          setSkillMode("closed");
        }
        return;
      }
      if (key.backspace || key.delete) {
        setInput((prev) => prev.slice(0, -1));
        return;
      }
      if (key.ctrl && ch === "c") {
        if (isProcessing) {
          onCancel();
        } else {
          process.exit(0);
        }
        return;
      }
      if (key.ctrl || key.meta) return;
      if (ch) {
        setInput((prev) => prev + ch);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      {slashMenuOpen && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="red">Commands</Text>
          {filteredSlashCommands.map((command, index) => {
            const selected = index === selectedSlashIndex;
            return (
              <Box key={command.name}>
                <Text color={selected ? "red" : undefined}>
                  {selected ? "❯ " : "  "}
                  {truncate(command.name, 18).padEnd(18)}
                </Text>
                <Text dimColor>{` ${truncate(command.description, Math.max(12, columns - 24))}`}</Text>
              </Box>
            );
          })}
          <Text dimColor>↑/↓ select · Enter choose · Esc close</Text>
        </Box>
      )}

      {(skillMode === "list" || isSkillsCommand) && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="red">Skills</Text>
          {skillsLoading && <Text dimColor>loading downloaded skills…</Text>}
          {skillsError && <Text color="red">{skillsError}</Text>}
          {!skillsLoading && !skillsError && skills.length === 0 && (
            <Text dimColor>No downloaded skills yet.</Text>
          )}
          {!skillsLoading &&
            !skillsError &&
            visibleSkillOptions.map((skill, offset) => {
              const index = firstVisibleSkillIndex + offset;
              const selected = index === selectedSkillIndex;
              const isAddMore = skill.slug === "__add_more__";
              const label = isAddMore
                ? "Add More"
                : `${skill.name} (${skill.scope})`;
              const desc = isAddMore
                ? "search or install a SkillHub skill"
                : skill.description || basename(skill.path);
              return (
                <Box key={`${skill.scope}:${skill.slug}`} width="100%">
                  <Text color={selected ? "red" : undefined}>
                    {selected ? "❯ " : "  "}
                    {truncate(label, labelWidth).padEnd(labelWidth)}
                  </Text>
                  <Text dimColor>{` ${truncate(desc, descWidth)}`}</Text>
                </Box>
              );
            })}
          {!skillsLoading && !skillsError && skillOptions.length > visibleSkillCount && (
            <Text dimColor>
              {`showing ${firstVisibleSkillIndex + 1}-${firstVisibleSkillIndex + visibleSkillOptions.length} of ${skillOptions.length}`}
            </Text>
          )}
          {deleteStatus && (
            <Text color={deleteStatus.startsWith("Deleted") ? "green" : undefined}>
              {truncate(deleteStatus, Math.max(20, columns - 4))}
            </Text>
          )}
          <Text dimColor>↑/↓ scroll · PgUp/PgDn jump · Enter choose · d delete · Esc close</Text>
        </Box>
      )}

      {skillMode === "add" && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="red">Add Skill</Text>
          <Text dimColor>Type an exact SkillHub slug, then Enter.</Text>
          <Text dimColor>Example: weather, excel-xlsx</Text>
          {addStatus && (
            <Text color={addStatus.startsWith("Installed") ? "green" : undefined}>
              {truncate(addStatus, Math.max(20, columns - 4))}
            </Text>
          )}
        </Box>
      )}

      <Box width={columns || undefined} overflow="hidden">
        <Text color="red">{separator}</Text>
      </Box>
      <Box paddingX={1}>
        <Text bold color="red">{"❯ "}</Text>
        <Text>
          {displayInput}
          {!isProcessing && <Text color="red">▌</Text>}
        </Text>
        {input.length === 0 && !isProcessing && (
          <Text dimColor>
            {skillMode === "add" ? "SkillHub slug or keyword…" : "Type a message…"}
          </Text>
        )}
        {isProcessing && (
          <Text dimColor italic> thinking… (Esc pause · Ctrl+C interrupt)</Text>
        )}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>
          {"  ? for shortcuts"}
        </Text>
      </Box>
    </Box>
  );
}
