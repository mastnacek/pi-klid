import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { type KlidView, KLID_VIEWS, GLOBAL_CONFIG_PATH, COMMAND_DOCS, projectConfigPath } from "./types.js";
import { klid } from "./state.js";
import { applyQuietUi, setEnabled, setView } from "./overlay.js";
import { loadSpaiBoard, spaiBoardSource } from "../spai-board.js";

export function registerKlidCommand(
  pi: ExtensionAPI,
  persistEntry: () => void,
): void {
    pi.registerCommand("klid", {
      description: "Quiet zen mode: hide thinking and tool activity behind a breathing Working... animation",
      getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
        const trimmed = prefix.trimStart();

        const clean = (cleanPrefix: string): AutocompleteItem[] | null => {
          const tokens = cleanPrefix.split(/\s+/).filter(Boolean);
          const trailing = /\s$/.test(cleanPrefix);

          // Second level: view/dashboard accept cover|spai|kanban.
          if (tokens.length === 2 || (trailing && tokens.length === 1)) {
            const cmd = (tokens[0] ?? "").toLowerCase();
            if (cmd === "view" || cmd === "dashboard") {
              const typed = (tokens[1] ?? "").toLowerCase();
              const opts = KLID_VIEWS.filter((v) => v.startsWith(typed)).map((v) => ({
                value: `view ${v}`,
                label: `view ${v}`,
                description:
                  v === "cover"
                    ? "static quiet cover while working (passive)"
                    : v === "spai"
                      ? "SPAI task list while working (interactive)"
                      : "SPAI kanban board while working (interactive)",
              }));
              return opts.length > 0 ? opts : null;
            }
            return null;
          }
          if (tokens.length > 2) return null;

          const typed = (tokens[0] ?? "").toLowerCase();
          const NON_TERMINAL = new Set(["--global", "view", "dashboard"]);
          const items: AutocompleteItem[] = [];
          for (const [key, description] of Object.entries(COMMAND_DOCS)) {
            if (key.toLowerCase().startsWith(typed)) {
              items.push({
                value: NON_TERMINAL.has(key) ? `${key} ` : key,
                label: key,
                description,
              });
            }
          }
          return items.length > 0 ? items : null;
        };

        if (!trimmed.startsWith("--global")) return clean(trimmed);

        const afterGlobal = trimmed.slice(8).trimStart();
        const hasTrailingSpace = trimmed.length > 8 || /\s$/.test(prefix);
        if (!hasTrailingSpace && afterGlobal === "") {
          return [
            {
              value: "--global ",
              label: "--global",
              description: COMMAND_DOCS["--global"] ?? "save globally",
            },
          ];
        }

        const sub = clean(afterGlobal);
        if (!sub) return null;
        return sub
          .filter((item) => item.label !== "--global")
          .map((item) => ({
            value: `--global ${item.value}`,
            label: item.label,
            description: item.description,
          }));
      },
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const rawTokens = args.trim().split(/\s+/).filter(Boolean);
        const isGlobal = rawTokens.some((t) => t.toLowerCase() === "--global");
        const tokens = rawTokens.filter((t) => t.toLowerCase() !== "--global");
        const sub = (tokens[0] ?? "").toLowerCase();
        const scope = isGlobal ? "globally" : "for this project";

        const helpText = [
          "# pi-klid — Quiet Mode",
          "Hides thinking blocks and every tool-call / streaming update behind a",
          "quiet surface while the agent works — either a static \"Working...\"",
          "cover or a live SPAI task dashboard.",
          "",
          "### Commands:",
          "  /klid on                — Enable quiet mode",
          "  /klid off               — Disable quiet mode",
          "  /klid toggle            — Flip quiet mode",
          "  /klid view <view>       — cover | spai (task list) | kanban (board)",
          "  /klid status            — Show current quiet state",
          "  /klid help              — Display this reference banner",
          "",
          "Add `--global` to persist into ~/.pi/agent/pi-klid.json (every",
          "session); without it the setting goes to <cwd>/.pi/pi-klid.json.",
          "",
          "While enabled, thinking never renders (live or history). Tool",
          "activity is covered while the agent works; only the final answer",
          "appears when it settles. State + view persist across sessions.",
        ].join("\n");

        if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
          ctx.ui.notify(helpText, "info");
          return;
        }

        switch (sub) {
          case "on":
            setEnabled(ctx, true, isGlobal);
            persistEntry();
            ctx.ui.notify(
              `klid: quiet mode ON — I'll leave you alone while I work (saved ${scope})`,
              "info",
            );
            break;
          case "off":
            setEnabled(ctx, false, isGlobal);
            applyQuietUi(ctx, false);
            persistEntry();
            ctx.ui.notify(`klid: quiet mode OFF (saved ${scope})`, "info");
            break;
          case "toggle":
            setEnabled(ctx, !klid.enabled, isGlobal);
            if (!klid.enabled) applyQuietUi(ctx, false);
            persistEntry();
            ctx.ui.notify(
              `klid: quiet mode ${klid.enabled ? "ON" : "OFF"} (saved ${scope})`,
              "info",
            );
            break;
          case "view":
          case "dashboard": {
            const target = (tokens[1] ?? "").toLowerCase();
            if (KLID_VIEWS.includes(target as KlidView)) {
              setView(ctx, target as KlidView, isGlobal);
              persistEntry();
            } else {
              ctx.ui.notify(
                `klid: working view is \"${klid.view}\". Use: /klid view cover|spai|kanban`,
                "info",
              );
            }
            break;
          }
          case "status": {
            const state = klid.enabled ? "quiet mode ON" : "quiet mode OFF";
            const thinking = klid.enabled ? "hidden" : "visible";
            // Resolve the board source so the status is truthful even before the
            // first kanban run (a silent fallback is otherwise invisible).
            await loadSpaiBoard();
            const board = spaiBoardSource();
            const boardText =
              board.source === "pi-spai"
                ? "kanban: pi-spai's board"
                : `kanban: local fallback (${board.detail})`;
            ctx.ui.notify(
              `klid: ${state} | thinking: ${thinking} | view: ${klid.view} | ${boardText}\n` +
                `global: ${GLOBAL_CONFIG_PATH}\n` +
                `project: ${klid.cwd ? projectConfigPath(klid.cwd) : "(no session cwd)"}`,
              "info",
            );
            break;
          }
          default:
            ctx.ui.notify(`klid: unknown subcommand "${sub}". Use: /klid help`, "warning");
            break;
        }
      },
    });
}
