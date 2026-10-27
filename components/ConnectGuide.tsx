"use client";

import { useState } from "react";
import Link from "next/link";

const LIVE_URL = "https://dejavu-memory.fly.dev";

type ToolKey = "claude" | "cursor" | "vscode";

const TOOLS: { key: ToolKey; label: string; blurb: string }[] = [
  { key: "claude", label: "Claude Code", blurb: "Terminal AI coding assistant" },
  { key: "cursor", label: "Cursor", blurb: "AI code editor" },
  { key: "vscode", label: "VS Code / Copilot", blurb: "Editor with GitHub Copilot" },
];

function commandFor(tool: ToolKey, key: string): string {
  const url = `${LIVE_URL}/api/mcp`;
  switch (tool) {
    case "claude":
      return `claude mcp add dejavu ${url} --transport http --header "Authorization: Bearer ${key}"`;
    case "cursor":
      return JSON.stringify(
        {
          mcpServers: {
            recall: {
              type: "http",
              url,
              headers: { Authorization: `Bearer ${key}` },
            },
          },
        },
        null,
        2,
      );
    case "vscode":
      return JSON.stringify(
        {
          servers: {
            recall: {
              type: "http",
              url,
              headers: { Authorization: `Bearer ${key}` },
            },
          },
        },
        null,
        2,
      );
  }
}

const NATIVE_MCP_SNIPPET = `claude plugin marketplace add https://github.com/MystenLabs/MemWal.git
claude plugin install memwal@memwal-plugins -s user`;

function humanStepsFor(tool: ToolKey): string[] {
  switch (tool) {
    case "claude":
      return [
        "Run the command below in your terminal.",
        'Then type "claude" and hit Enter to start a session.',
        "When Claude starts, type: “which person is hiring React engineers?”",
      ];
    case "cursor":
      return [
        "Create (or open) a file named mcp.json inside the .cursor folder in your project.",
        "Paste the JSON below into that file and save.",
        "Restart Cursor. Then open Settings → MCP and make sure “dejavu” is enabled.",
      ];
    case "vscode":
      return [
        "Create (or open) a file named mcp.json inside the .vscode folder in your project.",
        "Paste the JSON below into that file and save.",
        "Restart VS Code. Then ask GitHub Copilot: “which person is hiring React engineers?”",
      ];
  }
}

export function ConnectGuide({
  existingKeys,
  hasKeys,
}: {
  existingKeys: { id: string; name: string; prefix: string }[];
  hasKeys: boolean;
}) {
  const [tool, setTool] = useState<ToolKey>("claude");
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);

  const displayKey = key || "PASTE_YOUR_KEY_HERE";
  const cmd = commandFor(tool, displayKey);

  async function copy() {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
  }

  const current = TOOLS.find((t) => t.key === tool)!;

  return (
    <main className="min-h-screen bg-paper text-ink">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <Link href="/" className="text-sm text-ink/50 transition hover:text-ink">
          ← Back to Dejavu
        </Link>

        <header className="mt-4">
          <h1 className="text-3xl font-semibold tracking-tight">
            Connect your AI assistant
          </h1>
          <p className="mt-2 text-ink/60">
            Want to ask Claude or Cursor about the people you&apos;ve met? Give
            it a key and it can read <em>your</em> memory — nobody else&apos;s.
            Takes about a minute.
          </p>
        </header>

        {/* Step 1 */}
        <section className="mt-8">
          <StepBadge n={1} title="Get your key" />
          <p className="mt-2 text-sm text-ink/70">
            Sign in and generate a key — it looks like{" "}
            <code className="rounded bg-ink/5 px-1.5 py-0.5 font-mono text-xs">
              djav_abc123…
            </code>
          </p>

          {hasKeys ? (
            <div className="mt-3 rounded-xl border border-ink/10 bg-white p-4">
              <p className="mb-2 text-xs font-medium text-ink/50">
                Your existing keys:
              </p>
              <ul className="space-y-1.5">
                {existingKeys.map((k) => (
                  <li
                    key={k.id}
                    className="flex items-center justify-between rounded-lg border border-ink/5 bg-paper px-3 py-2 text-sm"
                  >
                    <span>
                      <span className="font-medium">{k.name}</span>
                      <span className="ml-2 font-mono text-xs text-ink/40">
                        {k.prefix}…
                      </span>
                    </span>
                    <button
                      onClick={() => setKey("")}
                      className="text-xs text-ink/40 hover:text-ink"
                      title="You can't see the full key again — generate a new one if you need it"
                    >
                      (hidden)
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink/50">
                Keys are shown only once. If you don&apos;t remember it, that&apos;s fine —
                just generate a new one below.
              </p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-ink/70">
              You don&apos;t have a key yet. Go to{" "}
              <Link href="/workspace" className="font-medium text-accent hover:underline">
                your workspace
              </Link>{" "}
              → <b>API keys · MCP access</b> → <b>Generate API key</b>, then
              copy it.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              href="/workspace"
              className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-paper transition hover:bg-ink/90"
            >
              Open workspace → generate a key
            </Link>
          </div>
        </section>

        {/* Step 2 */}
        <section className="mt-10">
          <StepBadge n={2} title="Paste your key" />
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Paste your djav_… key here"
            className="mt-2 w-full rounded-xl border border-ink/10 bg-white px-4 py-3 font-mono text-sm focus:border-accent focus:outline-none"
          />
          <p className="mt-1 text-xs text-ink/40">
            Your key stays in this tab — it&apos;s used to build the command below.
          </p>
        </section>

        {/* Step 3 */}
        <section className="mt-10">
          <StepBadge n={3} title="Pick your assistant & copy the setup" />

          <div className="mt-3 inline-flex rounded-lg bg-ink/5 p-1 text-sm">
            {TOOLS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTool(t.key)}
                className={`rounded-md px-3 py-1.5 font-medium transition ${
                  tool === t.key
                    ? "bg-white text-ink shadow-sm"
                    : "text-ink/50 hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-xs text-ink/40">{current.blurb}</p>

          <pre className="mt-3 overflow-x-auto rounded-xl border border-ink/10 bg-ink p-4 text-xs leading-relaxed text-paper">
            <code>{cmd}</code>
          </pre>
          <button
            onClick={copy}
            className="mt-2 rounded-lg border border-ink/15 bg-white px-4 py-2 text-sm font-medium text-ink/70 transition hover:border-accent/40 hover:text-ink"
          >
            {copied ? "Copied ✓" : "Copy setup"}
          </button>

          <ol className="mt-4 space-y-1.5 text-sm text-ink/70">
            {humanStepsFor(tool).map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-accent">{i + 1}.</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* What you can ask */}
        <section className="mt-10">
          <StepBadge n={4} title="Try it" />
          <p className="mt-2 text-sm text-ink/70">
            Once connected, just ask in plain words — no technical setup needed:
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {[
              "Which person is hiring React engineers?",
              "Who has the most memories?",
              "What did I promise Marcus?",
              "Who should I reconnect with?",
            ].map((q) => (
              <div
                key={q}
                className="rounded-xl border border-ink/5 bg-white px-4 py-3 text-sm text-ink/80"
              >
                “{q}”
              </div>
            ))}
          </div>
        </section>

        <footer className="mt-12 border-t border-ink/10 pt-4 text-xs text-ink/40">
          Your key is scoped to <em>your</em> memories. It can read them and
          capture new ones, but it can never touch another user&apos;s data — and
          you can revoke it anytime in the workspace.
        </footer>

        {/* The stronger path: Walrus Memory's own MCP tools */}
        <section className="mt-10">
          <StepBadge n={5} title="Or: read the same memories with Walrus Memory’s own tools" />
          <p className="mt-2 text-sm text-ink/70">
            Your memories are encrypted blobs on Walrus — not rows in our
            database. So any agent with Walrus Memory&apos;s native MCP server
            can recall exactly what you typed here, with nothing to export or
            paste.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-xl border border-ink/10 bg-ink p-4 text-xs leading-relaxed text-paper">
            <code>{NATIVE_MCP_SNIPPET}</code>
          </pre>
          <ol className="mt-4 space-y-1.5 text-sm text-ink/70">
            {[
              "Run the two commands above in your terminal.",
              "Restart Claude Code, then ask it to run “memwal_login” and open the link it prints (use the wallet that owns this account).",
              "Capture someone here in the browser, then ask: “who did I meet that’s hiring React engineers?”",
            ].map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-accent">{i + 1}.</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-ink/50">
            Same encrypted blob, different client. That is what &quot;portable
            memory&quot; means. Full guide:{" "}
            <a
              className="font-medium text-accent hover:underline"
              href="https://docs.wal.app/walrus-memory/mcp/overview"
              target="_blank"
              rel="noreferrer"
            >
              Walrus Memory MCP docs
            </a>
          </p>
        </section>
      </div>
    </main>
  );
}

function StepBadge({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-bold text-white">
        {n}
      </span>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
    </div>
  );
}
