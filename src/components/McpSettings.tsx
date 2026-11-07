// Settings › AI assistants (MCP): how Claude and other MCP clients start `fairbeam mcp` with this
// installation's Python, package and openEMS (GET /api/mcp/config; docs/MCP.md).
import { createResource, createSignal, Show } from "solid-js";
import { api } from "../runner/api";
import { t } from "../i18n";

export default function McpSettings() {
  const [config] = createResource(() => api.mcpConfig().catch(() => null));
  const [copied, setCopied] = createSignal("");
  const desktopJson = () => (config() ? JSON.stringify({ mcpServers: config()!.mcpServers }, null, 2) : "");
  const copy = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 2000); } catch { setCopied(""); }
  };
  return (
    <fieldset class="gs-mcp">
      <legend>{t("settings.mcp.title")}</legend>
      <p class="note">{t("settings.mcp.intro")}</p>
      <Show when={config()} fallback={<p class="note">{config.loading ? t("settings.mcp.loading") : t("settings.mcp.unavailable")}</p>}>
        <div class="dz-field">
          <label class="dz-label" for="gs-mcp-claude-code">{t("settings.mcp.claudeCode")}</label>
          <textarea id="gs-mcp-claude-code" class="rp-input dz-input mono gs-mcp-text" rows={3} readonly spellcheck={false} value={config()!.claude_code} />
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => void copy("code", config()!.claude_code)}>{copied() === "code" ? t("settings.mcp.copied") : t("settings.mcp.copy")}</button>
        </div>
        <div class="dz-field">
          <label class="dz-label" for="gs-mcp-json">{t("settings.mcp.desktop")}</label>
          <textarea id="gs-mcp-json" class="rp-input dz-input mono gs-mcp-text" rows={8} readonly spellcheck={false} value={desktopJson()} />
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => void copy("json", desktopJson())}>{copied() === "json" ? t("settings.mcp.copied") : t("settings.mcp.copy")}</button>
        </div>
        <p class="note">{t("settings.mcp.note")}</p>
      </Show>
    </fieldset>
  );
}
