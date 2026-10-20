# Ops Agent — connecting your AI agent to Recall's memory

There are **two ways an agent reads this memory**, and the first one is the
point of the whole entry:

| | Path | What it proves |
|---|---|---|
| **1** | **[Walrus Memory's own MCP server](#path-1--walrus-memorys-native-mcp-recommended)** — first-party `memwal_*` tools | An agent reads, with **zero re-entry**, the exact memories the **website** wrote. Portability made literal. |
| **2** | **[Recall's own MCP server](#path-2--recalls-mcp-server)** (`/api/mcp`) | A product surface: read-only, per-user scoped, pre-synthesized answers and a Today feed. |

Path 1 is the stronger demo and uses **first-party Walrus tooling**. Path 2 is
what a shipped product would expose to a paying user's own agent.

---

## Path 1 — Walrus Memory's native MCP (recommended)

Walrus Memory ships its **own MCP server** with the memory tools
(`memwal_recall`, `memwal_remember`, …). Point your agent at the same Walrus
Memory account Recall writes to and it can recall everything people typed into
the web app — because those memories *are* Walrus blobs, not app rows.

### Install (Claude Code — plugin path, adds lifecycle hooks)

```bash
claude plugin marketplace add https://github.com/MystenLabs/MemWal.git
claude plugin install memwal@memwal-plugins -s user
claude plugin list
```

Restart Claude Code, then ask the agent to run `memwal_login` and open the URL
it returns (sign in with the Sessions wallet that owns the account).

> MCP-only alternative (any MCP client, no lifecycle hooks):
> `claude mcp add memwal -- npx -y @mysten-incubation/memwal-mcp`
> Docs: <https://docs.wal.app/walrus-memory/mcp/overview>

### Scope it to this project (recommended)

Walrus memory is per-account. To keep this project's agent pinned to the same
account, sign in once and approve the project:

```bash
mkdir -p .memwal
memwal-mcp login                     # writes ~/.memwal/credentials.json
cp ~/.memwal/credentials.json .memwal/credentials.json
memwal-mcp approve-project
echo '.memwal/' >> .gitignore        # it holds a delegate key
```

### Prove the portability claim

Capture something in the browser at **https://recall-walrus-memory.fly.dev**,
then ask the agent — with no context pasted, no export, nothing:

> *"Who did I meet that's hiring React engineers?"*

The agent calls `memwal_recall` against the Recall namespace and answers from
the same encrypted blob the website wrote. **That** is a chatbot memory that
survives the session, the app, and the vendor.

---

## Path 2 — Recall's MCP server

Recall's own MCP server (`/api/mcp`) is a product surface: read-only,
auto-scoped to the signed-in user's key, and it returns *synthesized* answers
plus the Today feed rather than raw tools. Use it when you want the product's
judgment, not just its blobs.

> What you need: **a signed-in Recall account** and **one API key** you generate
> yourself. That's it — no AWS, no database, no other setup.

### Step 1 — Generate your API key (in the app)

1. Open the live app: **https://recall-walrus-memory.fly.dev**
2. Sign in with any email (a private memory space is created instantly).
3. In the **API keys · MCP access** panel (right side of the workspace), click
   **Generate API key**.
4. **Copy the key now — it's shown only once.** It looks like
   `recu_<random-letters-and-numbers>`.

> If you have no memories yet, capture one first (type something like *"Met
> Sarah Chen at the meetup — she's hiring React engineers"*) so your agent has
> data to query.

### Step 2 — Verify the key works (optional but recommended)

```bash
export RECALL_MCP_API_KEY="<your-recall-key>"
pnpm exec tsx scripts/mcp-verify.ts
```

You should see the six tools (`list_people`, `search_memories`, `ask_memory`,
`get_person`, `get_today`, `recent_memories`) and `connection verified ✔`.

To run a semantic search straight away:

```bash
RECALL_MCP_QUERY="who is hiring react engineers" pnpm exec tsx scripts/mcp-verify.ts
```

### Step 3 — Connect your agent

Pick your tool. In every case the **server URL** is the same:

```
https://recall-walrus-memory.fly.dev/api/mcp
```

### Claude Code

```bash
claude mcp add recall https://recall-walrus-memory.fly.dev/api/mcp \
  --transport http --header "Authorization: Bearer <your-key>"
```

Then in Claude Code run `/mcp` and confirm `recall` shows **connected** (green).
Ask: *"which person is hiring React engineers?"*

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "recall": {
      "type": "http",
      "url": "https://recall-walrus-memory.fly.dev/api/mcp",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}
```

Restart Cursor, then check **Settings → MCP** — `recall` should be enabled and
the tools listed.

### VS Code / GitHub Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "recall": {
      "type": "http",
      "url": "https://recall-walrus-memory.fly.dev/api/mcp",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}
```

### Cline

Add to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "recall": {
      "type": "streamableHttp",
      "url": "https://recall-walrus-memory.fly.dev/api/mcp",
      "headers": { "Authorization": "Bearer <your-key>" }
    }
  }
}
```

### Codex

```bash
codex mcp add recall --url https://recall-walrus-memory.fly.dev/api/mcp \
  --header "Authorization: Bearer <your-key>"
```

### Step 4 — Ask your agent about your memory

Once connected, try natural-language prompts (no SQL needed):

- "Which person is hiring React engineers?"
- "What did I promise Marcus?"
- "Who should I reconnect with?"
- "Summarize what I know about Sarah Chen."
- "What did I capture most recently?"

### Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401 invalid_token` | Wrong/expired key, or the key was generated by a different account | Generate a new key in the app; copy it fully (starts `recu_`) |
| Tool says "connection failed / server not found" | Missing `--transport http` or wrong URL | Use the exact URL + `--transport http` above |
| `403` / tools don't appear | Key was revoked | Generate a new key |
| Works locally but not from a hosted client | Key copied with a trailing space | Regenerate and paste cleanly |

> The endpoint is **read-only**: every tool is scoped to your `user_id` by the
> key. Keys store only a SHA-256 hash — never the raw secret. Revoke a key
> anytime in the app.

---

## Operating the memory layer (for the demo / judges)

Durable memory lives in **Walrus Memory**, not in the app server. Every claim
below is a command in this repo, not a claim in prose:

| Claim | Command | What it shows |
|---|---|---|
| Round-trip | `pnpm memwal:verify` | health → probe blob certified → recalled back |
| Decisions are calibrated | `pnpm judge:verify` | routing, person resolution, paraphrase ranking, citation verdicts |
| Whole product path | `pnpm verify:e2e` | 25 checks: capture structure, cited recall, abstention, isolation, durability |
| **Memory outlives the app** | `pnpm memwal:durability` | blobs owned on Sui; `restore()` rebuilds the index; **recall still answers with the local projection deleted** |
| Live state | `GET /api/health` | Walrus reachability, account, namespace, epoch lifetime, `counts.walrus_blobs` |

- **Dashboard:** connect the Sessions wallet at
  [memory.walrus.xyz](https://memory.walrus.xyz) to browse namespaces
  (`recall-<userId>`), blobs, and expiry. Anyone can fetch a blob by id from
  the public aggregator and get **ciphertext** — the app surfaces this as a
  ⬡ chip next to each memory: *publicly verifiable, privately readable*.
- **Lifetime:** the onchain storage window is authoritative, and it is shorter
  than the SDK default. Measured via Tatum RPC: blobs at epoch 40 with storage
  through epoch 55 → **196 days**, not 50 epochs. `GET /api/health` and the
  Memory Health card report the chain's answer (`end_epoch` → real date), and
  warn before expiry instead of discovering it as amnesia.

## Demo it in the video

1. Browser: capture a memory, show the ⬡ blob chip appear.
2. Claude Code with the **native Walrus Memory MCP** connected (Path 1) — ask
   *"Who did I meet that's hiring React engineers?"* It answers from the blob
   the website wrote. No export, no copy-paste.
3. Optionally `pnpm memwal:durability` on camera for the "delete the index and
   recall still works" proof.
