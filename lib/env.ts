import { z } from "zod";

/**
 * Centralized, validated environment access.
 * Fails fast at startup if required configuration is missing, so we never
 * ship a build that silently misbehaves in production.
 */
const schema = z.object({
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 chars"),

  AWS_REGION: z.string().default("us-east-1"),
  // Bedrock API key (bearer token) for the Mantle Chat Completions endpoint.
  // No IAM keys needed: embeddings live in Walrus Memory's relayer.
  BEDROCK_API_KEY: z.string().optional(),

  BEDROCK_TEXT_MODEL_ID: z.string().default("amazon.nova-micro-v1:0"),

  AI_PROVIDER: z.enum(["bedrock", "mock"]).default("bedrock"),

  // Prose provider. Bedrock's hosted API keys expire; the prose layer is
  // therefore provider-agnostic with a fallback chain:
  //   primary  = LLM_PROVIDER=openai-compatible (any OpenAI-compatible API)
  //   fallback = Bedrock Mantle (BEDROCK_API_KEY)
  //   last     = LLM_FALLBACK_* (a second OpenAI-compatible provider)
  // With none configured, Dejavu falls back to deterministic local writing.
  LLM_PROVIDER: z.enum(["openai-compatible", "bedrock"]).default("bedrock"),
  LLM_PROVIDER_NAME: z.string().optional(),
  LLM_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().default("mistralai/mistral-small"),
  LLM_FALLBACK_NAME: z.string().optional(),
  LLM_FALLBACK_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),
  LLM_FALLBACK_API_KEY: z.string().optional(),
  LLM_FALLBACK_MODEL: z.string().default("mistralai/mistral-small"),
  // Nebius Token Factory — OpenAI-compatible, stable keys, open-weight models
  // (Qwen / Kimi / GLM / DeepSeek). Our primary writer.
  TOKENFACTORY_API_KEY: z.string().optional(),
  TOKENFACTORY_BASE_URL: z
    .string()
    .default("https://api.tokenfactory.nebius.com/v1"),
  TOKENFACTORY_MODEL: z
    .string()
    .default("Qwen/Qwen3-30B-A3B-Instruct-2507"),
  // Keyless open-weights gateway used only when every configured provider is
  // dead, so a demo never falls back to regex-written prose. Set "off" to
  // disable it entirely.
  LLM_EMERGENCY_FALLBACK: z.enum(["on", "off"]).default("on"),

  // Walrus Memory (MemWal) — the durable memory layer. One operator account
  // pays for storage; per-user isolation is via namespace (see lib/memwal.ts).
  // Generate at https://memory.walrus.xyz . When unset, the app runs on the
  // local projection store only (no cross-session Walrus recall).
  MEMWAL_PRIVATE_KEY: z.string().optional(),
  MEMWAL_ACCOUNT_ID: z.string().optional(),
  MEMWAL_SERVER_URL: z
    .string()
    .default("https://relayer.memory.walrus.xyz"),

  // TypeSafe (Jev) — every *decision* in the pipeline (intent routing, person
  // resolution, relevance ranking, citation verification). When unset, those
  // decisions fall back to the Bedrock generative paths. Prose generation
  // (extraction JSON, answer synthesis) always stays on Bedrock/Voxtral.
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL_ID: z.string().default("jev-latest"),

  // Tatum — independent onchain verification of the memory layer via Sui RPC
  // (Walrus system epoch, MemWalAccount delegation, Blob objects + expiry).
  // Optional: without it the app trusts the relayer and skips chain checks.
  TATUM_API_KEY: z.string().optional(),
  TATUM_SUI_RPC_URL: z.string().default("https://sui-mainnet.gateway.tatum.io"),
  TATUM_WALRUS_SYSTEM_OBJECT_ID: z
    .string()
    .default("0x2134d52768ea07e8c43570ef975eb3e4c27a39fa6396bef985b5abc58d03ddd2"),

  // Local projection store (people, facts, commitments, users). Overridable
  // for tests; defaults to ./data/recall.json.
  DEJAVU_DATA_PATH: z.string().optional(),

  APP_URL: z.string().default("http://localhost:3000"),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // Backwards compatibility: pre-rename deployments used RECALL_* env names.
  // Read them as defaults so a rebrand never breaks a running deployment.
  const legacy = { ...process.env } as NodeJS.ProcessEnv;
  if (!legacy.DEJAVU_DATA_PATH && legacy.RECALL_DATA_PATH) legacy.DEJAVU_DATA_PATH = legacy.RECALL_DATA_PATH;
  if (!legacy.DEJAVU_AWS_ACCESS_KEY_ID && legacy.RECALL_AWS_ACCESS_KEY_ID) legacy.DEJAVU_AWS_ACCESS_KEY_ID = legacy.RECALL_AWS_ACCESS_KEY_ID;
  if (!legacy.DEJAVU_AWS_SECRET_ACCESS_KEY && legacy.RECALL_AWS_SECRET_ACCESS_KEY) legacy.DEJAVU_AWS_SECRET_ACCESS_KEY = legacy.RECALL_AWS_SECRET_ACCESS_KEY;
  const parsed = schema.safeParse(legacy);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** True when no Bedrock API key is configured or AI_PROVIDER=mock. */
export function isMockAI(): boolean {
  const e = env();
  if (e.AI_PROVIDER === "mock") return true;
  return !e.BEDROCK_API_KEY;
}
