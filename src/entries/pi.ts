import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { startServer } from "../core/server.ts";
import { junieLogin, junieRefreshToken } from "../core/oauth.ts";
import { buildProviderModels, cleanOldModelsJson } from "../core/models.ts";
import { getProxyDiagnostics } from "../core/proxy.ts";

const require = createRequire(import.meta.url);
const { version: PLUGIN_VERSION } = require("../../package.json");

/** A run of text with one style — styling is applied after wrapping, so that
 *  the ANSI escapes never confuse the width arithmetic. */
type Span = { text: string; color?: ThemeColor; bold?: boolean; italic?: boolean };

function styleSpan({ text, color, bold, italic }: Span, theme: Theme): string {
  let styled = text;
  if (bold) styled = theme.bold(styled);
  if (italic) styled = theme.italic(styled);
  if (color) styled = theme.fg(color, styled);
  return styled;
}

/** Word-wrap styled spans, keeping each word's style intact. */
function wrapSpans(spans: Span[], width: number, indent: string, theme: Theme): string[] {
  const words = spans.flatMap((span) =>
    span.text.split(/\s+/).filter(Boolean).map((text) => ({ ...span, text })),
  );

  const lines: string[] = [];
  let current: Span[] = [];
  let length = 0;
  const flush = (continuation: string) => {
    if (current.length > 0) lines.push(continuation + current.map((s) => styleSpan(s, theme)).join(" "));
    current = [];
    length = 0;
  };

  for (const word of words) {
    const added = length === 0 ? word.text.length : length + 1 + word.text.length;
    if (length > 0 && added > width) flush(lines.length === 0 ? indent : `${indent}  `);
    current.push(word);
    length = length === 0 ? word.text.length : added;
  }
  flush(lines.length === 0 ? indent : `${indent}  `);

  return lines.length > 0 ? lines : [""];
}

/**
 * Colour a value word by word — never inside a word, so that "−$2.14" survives
 * wrapping in one piece. Money is highlighted, and `backticks` mark a value
 * worth picking out (the license type), which keeps the decision in the report
 * text instead of teaching the renderer about content.
 */
function valueSpans(text: string, color: ThemeColor): Span[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      if (word.startsWith("`") && word.endsWith("`")) {
        return { text: word.slice(1, -1), color: "warning" as ThemeColor, bold: true };
      }
      return { text: word.replaceAll("`", ""), color: /\$\d/.test(word) ? ("success" as ThemeColor) : color };
    });
}

/**
 * Escape, in every encoding a terminal may use for it.
 *
 * A bare "\x1b" only arrives in legacy mode. With the Kitty keyboard protocol
 * (which iTerm2 negotiates) Escape is `CSI 27 u` — optionally carrying
 * modifier and event-type fields — and xterm's modifyOtherKeys mode sends
 * `CSI 27 ; <mod> ; 27 ~` instead. Matching only "\x1b" misses both.
 * pi-tui's `matchesKey` handles all of this, but importing it is not an
 * option (see showOverlay below).
 */
function isEscapeKey(data: string): boolean {
  if (data === "\x1b") return true;

  // CSI u: \x1b[<codepoint>[:alternates][;<mod>[:<event>]]u — 27 = Escape
  const csiU = data.match(/^\x1b\[(\d+)(?::\d*)*(?:;\d+(?::\d+)?)?u$/);
  if (csiU) return csiU[1] === "27";

  // modifyOtherKeys: \x1b[27;<mod>;<codepoint>~
  return /^\x1b\[27;\d+;27~$/.test(data);
}

/** Enter, in legacy (\r or \n) and Kitty (`CSI 13 u`) encodings. */
function isEnterKey(data: string): boolean {
  if (data === "\r" || data === "\n") return true;
  const csiU = data.match(/^\x1b\[(\d+)(?::\d*)*(?:;\d+(?::\d+)?)?u$/);
  return csiU?.[1] === "13";
}

// Arrow keys with optional CSI parameters (the Kitty protocol adds modifier and
// event fields), plus the vi-style aliases and space.
const SCROLL_KEY_RE = /\x1b\[([\d;:]*)([AB])|([kj ])/g;

/**
 * Lines to scroll for an input chunk: negative is up, 0 means "not a scroll key".
 *
 * Holding a key down repeats it faster than the TUI hands over chunks, so one
 * chunk can carry several presses — counting them all keeps a held arrow
 * scrolling smoothly instead of moving a single line per chunk.
 */
function scrollStep(data: string): number {
  let step = 0;
  SCROLL_KEY_RE.lastIndex = 0;
  for (let m = SCROLL_KEY_RE.exec(data); m; m = SCROLL_KEY_RE.exec(data)) {
    // Kitty key-release events (event type 3) would otherwise count twice.
    if (m[1] && m[1].endsWith(":3")) continue;
    switch (m[2] ?? m[3]) {
      case "A":
      case "k":
        step -= 1;
        break;
      case "B":
      case "j":
        step += 1;
        break;
      case " ":
        step += 10;
        break;
    }
  }
  return step;
}

/**
 * Render one line of the report's markdown subset — `**Label:** value`,
 * whole-line `*italics*` for hints, `- ` bullets and `` `code` `` — giving
 * labels, values and amounts distinct colours.
 */
function renderReportLine(raw: string, width: number, theme: Theme): string[] {
  const plain = raw;
  if (!plain.trim()) return [""];

  const indent = plain.startsWith("- ") ? "   " : " ";
  const available = width - indent.length - 2;

  // Hint text: "*…*"
  if (/^\*[^*].*\*$/.test(plain)) {
    return wrapSpans([{ text: plain.slice(1, -1), color: "dim", italic: true }], available, indent, theme);
  }

  // Bullet: "- Tariff: $50.31 of $70.00" or a plain item like "- claude-opus-5"
  if (plain.startsWith("- ")) {
    const [, key, rest] = plain.slice(2).match(/^([^:]+:)?\s*(.*)$/s) ?? [];
    const spans: Span[] = [{ text: "-", color: "dim" }];
    if (key) spans.push({ text: key, color: "muted" });
    // A bullet without a label carries the content itself, so it stays readable
    spans.push(...valueSpans(rest ?? "", key ? "muted" : "text"));
    return wrapSpans(spans, available, indent, theme);
  }

  // Heading with a label: "**Balance:** $5.00 remaining"
  const labelled = plain.match(/^\*\*(.+?)\*\*\s*(.*)$/s);
  if (labelled) {
    const [, label, rest] = labelled;
    return wrapSpans(
      [{ text: label, color: "accent", bold: true }, ...valueSpans(rest, "muted")],
      available,
      indent,
      theme,
    );
  }

  // Plain body text (the model list) — full contrast, it is meant to be read
  return wrapSpans(valueSpans(plain, "text"), available, indent, theme);
}

export default async function (pi: ExtensionAPI) {
  // Clean stale provider entries from ~/.pi/agent/models.json (left by old pi-junie setup)
  await cleanOldModelsJson();

  // Start proxy on ephemeral port (OS assigns a free port)
  const { server, port } = await startServer();

  const oauth = {
    name: "JetBrains Junie",
    login: junieLogin,
    refreshToken: junieRefreshToken,
    getApiKey: (cred: { access: string }) => cred.access,
  };

  // Single provider — OpenAI models inherit provider-level api/baseUrl,
  // Claude models override per-model (api + baseUrl).
  pi.registerProvider("junie", {
    name: "JetBrains Junie",
    baseUrl: `http://localhost:${port}/v1`,
    api: "openai-completions",
    authHeader: true,
    oauth,
    models: [
      ...buildProviderModels("openai", Number(port)),
      ...buildProviderModels("claude", Number(port)),
      ...buildProviderModels("grok", Number(port)),
      ...buildProviderModels("gemini", Number(port)),
    ] as any,
  });

  // Balance tracking after each turn
  let startBalance: number | undefined;

  // 100,000 Grazie credits = 1 USD (from ai.grazie.utils.mpp.money.Credit.CREDITS_IN_DOLLAR)
  const CREDITS_PER_USD = 100_000;

  function creditsToUsd(credits: number): number {
    return credits / CREDITS_PER_USD;
  }

  function formatDollars(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  function formatDate(ms: number | undefined): string | undefined {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
    return new Date(ms).toISOString().slice(0, 10);
  }

  /** Grazie reports credits; /auth/test reports plain USD for some licence types. */
  function makeAmountFormatter(balanceUnit: unknown) {
    const isCredits = balanceUnit === "CREDITS";
    return (value: number | undefined): string | undefined =>
      typeof value === "number" && Number.isFinite(value)
        ? formatDollars(isCredits ? creditsToUsd(value) : value)
        : undefined;
  }

  /** The status line only makes sense while a Junie model is doing the work. */
  function isJunieModel(model: { provider?: string } | undefined): boolean {
    return model?.provider === "junie";
  }

  // Handlers fire-and-forget syncStatus so the model picker is not blocked on
  // Grazie. A fresh {} token per sync means only the latest run may apply;
  // older in-flight fetches still finish but their result is dropped.
  let statusToken: object | undefined;

  type BalanceSnapshot = { balanceLeft: number; balanceUnit: unknown };

  async function fetchBalance(ctx: ExtensionContext): Promise<BalanceSnapshot | undefined> {
    try {
      // The proxy can reuse the auth header of the last chat request, but
      // before the first turn there is none — so resolve the key like /junie.
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("junie");
      const res = await fetch(`http://localhost:${port}/junie/balance`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) return;
      const { balanceLeft, balanceUnit } = await res.json();
      if (typeof balanceLeft !== "number") return;
      return { balanceLeft, balanceUnit };
    } catch {
      return; // best-effort — don't spam errors for a status line
    }
  }

  function applyBalanceStatus(ctx: ExtensionContext, { balanceLeft, balanceUnit }: BalanceSnapshot) {
    startBalance ??= balanceLeft;
    const used = startBalance - balanceLeft;
    const money = makeAmountFormatter(balanceUnit);
    ctx.ui.setStatus(
      "junie",
      `Junie: ${money(balanceLeft)} left · −${money(used)} this session`,
    );
  }

  /** A status set with setStatus() is sticky, so leaving Junie has to clear it. */
  function clearStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus("junie", undefined);
  }

  async function syncStatus(ctx: ExtensionContext, model = ctx.model) {
    const token = {};
    statusToken = token;

    if (!isJunieModel(model)) {
      clearStatus(ctx);
      return;
    }

    const snap = await fetchBalance(ctx);
    if (!snap || statusToken !== token) return;
    try {
      applyBalanceStatus(ctx, snap);
    } catch {
      // ctx is stale after session replacement/reload while the fetch was
      // in flight — the new instance owns the status line now, drop it.
    }
  }

  pi.on("session_start", (event, ctx) => {
    // "this session" is a per-session delta, so a different session starts over
    if (event.reason !== "startup" && event.reason !== "reload") startBalance = undefined;
    void syncStatus(ctx);
  });

  // Fires for /model, the model picker and restore — the only signal for
  // switching to or away from Junie.
  pi.on("model_select", (event, ctx) => {
    void syncStatus(ctx, event.model);
  });

  pi.on("turn_end", (_event, ctx) => {
    void syncStatus(ctx);
  });

  /**
   * Report text that can be replaced while the overlay is already on screen,
   * so the balance round-trip does not have to be awaited before showing
   * anything.
   */
  function createLiveReport(initial: string) {
    let markdown = initial;
    let requestRender: (() => void) | undefined;

    return {
      get markdown() {
        return markdown;
      },
      set(next: string) {
        markdown = next;
        requestRender?.();
      },
      /** Called by the overlay once — and cleared again when it closes, so a
       *  late arriving response cannot poke a component that is already gone. */
      bind(render: (() => void) | undefined) {
        requestRender = render;
      },
    };
  }

  type LiveReport = ReturnType<typeof createLiveReport>;

  /** Show a report in a dismissible overlay, outside the conversation. */
  async function showOverlay(ctx: ExtensionCommandContext, report: LiveReport) {
    // Rendered by hand rather than with pi-tui's Markdown component: pi-tui
    // lives in pi's own nested node_modules and is not resolvable from an
    // installed extension, so importing it would break at runtime.
    await ctx.ui.custom((tui, theme, _keybindings, done) => {
      report.bind(() => tui.requestRender());

      // The TUI does not clip a component to the terminal — anything too tall
      // just pushes the conversation off-screen. So the report scrolls itself.
      let offset = 0;

      return {
        render(width: number) {
          const inner = Math.max(20, width - 2);
          const body = report.markdown.split("\n").flatMap((raw) => renderReportLine(raw, inner, theme));

          const viewport = Math.max(5, (process.stdout.rows ?? 24) - 10);
          const maxOffset = Math.max(0, body.length - viewport);
          offset = Math.min(offset, maxOffset);

          const rule = theme.fg("accent", "─".repeat(width));
          const hint = maxOffset > 0
            ? ` ↑/↓ to scroll (${offset + 1}-${Math.min(offset + viewport, body.length)} of ${body.length}) · Enter/Esc to close`
            : " Press Enter or Esc to close";

          return [rule, ...body.slice(offset, offset + viewport), theme.fg("dim", hint), rule];
        },
        invalidate() {},
        handleInput(data: string) {
          if (isEscapeKey(data) || isEnterKey(data)) {
            done(undefined);
            return;
          }
          const step = scrollStep(data);
          if (step !== 0) {
            offset = Math.max(0, offset + step);
            tui.requestRender();
          }
        },
      };
    });

    report.bind(undefined);
  }

  /** The lines that need no network — everything the proxy already knows. */
  function reportHeader(): string[] {
    const diag = getProxyDiagnostics();
    const lines = [
      `**Junie Bridge** ${PLUGIN_VERSION} — running on port ${port}`,
      `**HTTP Proxy:** ${diag.proxy ?? "none (direct connection)"}`,
    ];
    if (diag.proxy) {
      lines.push(`**Proxy Auth:** ${diag.auth}`);
    }
    return lines;
  }

  async function buildReport(ctx: ExtensionCommandContext, wantsConnTest: boolean): Promise<string> {
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("junie");
      const balanceHeaders: Record<string, string> = {};
      if (apiKey) balanceHeaders["Authorization"] = `Bearer ${apiKey}`;

      // The balance round-trip dominates the command's latency, so everything
      // it doesn't depend on is fetched alongside it rather than after it.
      const [balanceRes, modelsRes, testRes] = await Promise.all([
        fetch(`http://localhost:${port}/junie/balance`, { headers: balanceHeaders }),
        fetch(`http://localhost:${port}/v1/models`),
        wantsConnTest ? fetch(`http://localhost:${port}/junie/test`) : undefined,
      ]);

      // Read the body either way — on failure it carries the reason
      const balanceInfo = await balanceRes.json().catch(() => null);
      const modelsInfo = modelsRes.ok ? await modelsRes.json() : null;
      const testInfo = testRes?.ok ? await testRes.json().catch(() => null) : null;

      const lines = reportHeader();
      lines.push("");

      if (balanceInfo?.balanceLeft != null) {
        const money = makeAmountFormatter(balanceInfo.balanceUnit);
        lines.push(`**Balance:** ${money(balanceInfo.balanceLeft)} remaining`);

        // Detailed split — only present when the Grazie QuotaAPI answered
        const quota = balanceInfo.quota;
        if (quota?.tariff) {
          const refill = formatDate(quota.refill?.next);
          lines.push(
            `- Tariff: ${money(quota.tariff.available)} of ${money(quota.tariff.maximum)}` +
              (refill ? ` · refills ${refill}` : ""),
          );
        }
        if (quota?.topUp?.maximum) {
          lines.push(`- Top-up: ${money(quota.topUp.available)} of ${money(quota.topUp.maximum)}`);
        }

        if (startBalance != null) {
          lines.push(`**Session usage:** −${money(startBalance - balanceInfo.balanceLeft)}`);
        }

        if (balanceInfo.licenseType) {
          lines.push("");
          lines.push(`**License type:** \`${balanceInfo.licenseType}\``);
          const until = formatDate(quota?.until);
          if (until) lines.push(`- Valid until ${until}`);
          if (balanceInfo.licenseType === "TRIAL") {
            lines.push(
              "*Unexpected license type? Junie may hand out free trial credits on top of your paid subscription." +
                " Once your free credits are spent your paid quota should display.*",
            );
          }
        }
      } else {
        const reason = balanceInfo?.error?.message ?? "no response from the proxy";
        lines.push(`**Balance:** unavailable — ${reason}`);
        lines.push("*If this persists, run /login to re-authenticate.*");
      }

      if (testInfo) {
        lines.push("");
        lines.push("**Connectivity:**");
        for (const [name, t] of Object.entries(testInfo.tests) as [string, any][]) {
          const icon = t.ok ? "+" : "!";
          lines.push(`- [${icon}] ${name}: ${t.ok ? `ok${t.status ? ` (${t.status})` : ""}` : t.error}`);
        }
      }

      if (modelsInfo?.data) {
        lines.push("");
        lines.push(`**Models** (${modelsInfo.data.length}):`);
        for (const m of modelsInfo.data) {
          lines.push(`- ${m.id}`);
        }
      }

      return lines.join("\n");
    } catch (e) {
      return [
        ...reportHeader(),
        "",
        `**Error:** ${e instanceof Error ? e.message : String(e)}`,
      ].join("\n");
    }
  }

  // /junie command for debugging and status
  pi.registerCommand("junie", {
    description: "Show Junie proxy status, balance, and connectivity info",
    async handler(args, ctx) {
      const wantsConnTest = args?.trim() === "test" || getProxyDiagnostics().proxy != null;
      const pending = buildReport(ctx, wantsConnTest);

      // pi.sendMessage() would be simpler, but every custom message is converted
      // into a user message for the LLM (convertToLlm in pi's core/messages) —
      // the `display` flag only controls TUI rendering. A status dump has no
      // business in the context window, so it goes into a dismissible overlay
      // instead. Without a TUI (RPC/print mode) there is nothing to show it in,
      // so the message is the fallback rather than losing the output entirely.
      if (!ctx.hasUI) {
        pi.sendMessage({ customType: "junie-status", content: await pending, display: true });
        return;
      }

      // The balance call goes upstream to Grazie and takes a second or two.
      // Waiting for it before opening the overlay makes the command feel stuck,
      // so the overlay opens on the local facts and fills itself in.
      const placeholder = [...reportHeader(), "", "**Balance:** loading…"];
      if (wantsConnTest) placeholder.push("", "**Connectivity:** loading…");
      placeholder.push("", "**Models:** loading…");

      const report = createLiveReport(placeholder.join("\n"));
      void pending.then((markdown) => report.set(markdown));

      await showOverlay(ctx, report);
    },
  });

  // Shutdown: close proxy when Pi exits
  pi.on("session_shutdown", async () => {
    server.close();
  });
}
