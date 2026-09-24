import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type KlidView = "cover" | "spai" | "kanban";

export const KLID_VIEWS: KlidView[] = ["cover", "spai", "kanban"];

export interface KlidConfig {
  enabled: boolean;
  view: KlidView;
}

export const GLOBAL_CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-klid.json");
export const STATUS_KEY = "klid";
// TUI-only state is also mirrored as a custom session entry so it survives
// reloads and follows /tree branch navigation (AGENTS.md §5/§6).
export const STATE_ENTRY_TYPE = "pi-klid-state";

/** Project override: <cwd>/.pi/pi-klid.json (wins over the global file). */
export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "pi-klid.json");
}

export const COMMAND_DOCS: Record<string, string> = {
  "--global": "save the following setting globally (~/.pi/agent/)",
  on: "enable quiet mode",
  off: "disable quiet mode",
  toggle: "flip quiet mode",
  view: "select working view (cover | spai | kanban)",
  status: "show current quiet state",
  help: "display this reference banner",
};
// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function readConfigFile(path: string): Partial<KlidConfig> {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as Partial<KlidConfig>;
    }
  } catch {
    // Corrupt/missing layer — non-fatal, fall through to the next one.
  }
  return {};
}

/**
 * Effective config with the mandatory cascade:
 * defaults <- ~/.pi/agent/pi-klid.json <- <cwd>/.pi/pi-klid.json.
 * Without a cwd only the global layer applies.
 */
export function loadConfig(cwd?: string): KlidConfig {
  const global = readConfigFile(GLOBAL_CONFIG_PATH);
  const project = cwd ? readConfigFile(projectConfigPath(cwd)) : {};
  const merged = { ...global, ...project };
  return {
    enabled: merged.enabled === true,
    view: KLID_VIEWS.includes(merged.view as KlidView) ? (merged.view as KlidView) : "cover",
  };
}

export function saveConfig(cfg: KlidConfig, isGlobal = false, cwd?: string): void {
  const target = isGlobal || !cwd ? GLOBAL_CONFIG_PATH : projectConfigPath(cwd);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      JSON.stringify({ enabled: cfg.enabled, view: cfg.view }, null, 2) + "\n",
      "utf8",
    );
  } catch {
    // Non-fatal: persistence is best-effort.
  }
}
