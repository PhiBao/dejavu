import { redirect } from "next/navigation";
import { getUserId } from "@/lib/auth";
import { listApiKeys } from "@/lib/api-keys";
import { ConnectGuide } from "@/components/ConnectGuide";

/**
 * Plain-language guide for connecting your AI agent (Claude Code, Cursor,
 * VS Code...) to YOUR memory through Dejavu's MCP server.
 *
 * Anyone can read this page. If signed in, it shows your existing keys so the
 * copy-paste commands are ready to go.
 */
export default async function GuidePage() {
  const userId = await getUserId();
  const keys = userId ? await listApiKeys(userId) : [];

  return <ConnectGuide existingKeys={keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix }))} hasKeys={keys.length > 0} />;
}
