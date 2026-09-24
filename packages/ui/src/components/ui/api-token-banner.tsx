/**
 * API Token Entry + Auth Banner
 *
 * Hardened deployments start the server with `--auth=apikey`; from then on
 * every API call needs the user's DuckBrain API key. This component pair is
 * the UI's side of that contract:
 *
 * - ApiTokenControl — a small header button ("API token") opening a popover
 *   where the user pastes their token. Saved to localStorage via
 *   setApiToken() and shown masked once set.
 * - ApiAuthBanner — a fixed banner shown while API calls are failing with
 *   401 (store flag set by the boot hook / any auth error reaching the
 *   query layer), pointing the user at the token entry.
 */

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, X } from "lucide-react";
import { clearApiToken, getApiToken, setApiToken } from "../../lib/api-client";
import { useUIStore } from "../../stores/ui-store";

/**
 * Header token control: button + popover with the token input.
 *
 * Plain text, no jargon: paste your token, save, done. The token is shown
 * masked once set; clearing it removes it from localStorage.
 */
export function ApiTokenControl() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [stored, setStored] = useState<string | null>(() => getApiToken());
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const save = () => {
    if (!draft.trim()) return;
    setApiToken(draft);
    setStored(getApiToken());
    setDraft("");
    // The saved token changes every request's auth: refetch everything once.
    void queryClient.invalidateQueries();
  };

  const clear = () => {
    clearApiToken();
    setStored(null);
    setDraft("");
    // Removing the token changes every request's auth: refetch once.
    void queryClient.invalidateQueries();
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
          stored ? "status-dot-active" : ""
        }`}
        style={{
          backgroundColor: stored
            ? "rgba(0, 255, 102, 0.1)"
            : "var(--color-glass)",
          color: stored ? "var(--color-success)" : "var(--color-clinical)",
          border: `1px solid ${stored ? "rgba(0, 255, 102, 0.3)" : "var(--color-glass-border)"}`,
        }}
        title="Enter your DuckBrain API token"
      >
        <KeyRound className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">API token</span>
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-72 glass-panel rounded-lg p-3 z-50 animate-in slide-in-from-top-2"
          style={{ borderColor: "var(--color-glass-border)" }}
        >
          <div className="flex items-center justify-between mb-2">
            <span
              className="text-sm"
              style={{ color: "var(--color-clinical)" }}
            >
              {stored ? "Token set" : "No token set"}
            </span>
            <button
              onClick={() => setOpen(false)}
              aria-label="Close token entry"
              className="p-1 hover:bg-white/10 rounded"
            >
              <X
                className="w-3.5 h-3.5"
                style={{ color: "var(--color-clinical)" }}
              />
            </button>
          </div>

          <label
            htmlFor="duckbrain-api-token-input"
            className="block text-xs mb-1"
            style={{ color: "var(--color-clinical)" }}
          >
            DuckBrain API token
          </label>
          <input
            id="duckbrain-api-token-input"
            ref={inputRef}
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Paste your token..."
            className="w-full glass-input px-2 py-1.5 rounded text-sm"
          />

          <div className="flex items-center justify-end gap-2 mt-2">
            {stored && (
              <button
                onClick={clear}
                className="px-2 py-1 text-sm rounded hover:bg-white/10 transition-colors"
                style={{ color: "var(--color-clinical)" }}
              >
                Clear
              </button>
            )}
            <button
              onClick={save}
              className="px-3 py-1 text-sm rounded glass-button"
              style={{ color: "var(--color-azure)" }}
            >
              Save
            </button>
          </div>

          {stored && (
            <p
              className="mt-2 text-xs break-all"
              style={{ color: "var(--color-clinical)", opacity: 0.7 }}
            >
              Saved:{" "}
              {stored.slice(0, 3) + "•".repeat(Math.max(stored.length - 3, 0))}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Fixed banner shown while the API is rejecting requests with 401 and no
 * working token is saved. Saving a token refreshes the queries; when one
 * succeeds the boot hook clears the flag and the banner disappears.
 */
export function ApiAuthBanner() {
  const queryClient = useQueryClient();
  const namespaceBootError = useUIStore((state) => state.namespaceBootError);
  const [draft, setDraft] = useState("");

  if (!namespaceBootError) return null;

  const saveFromBanner = async (token: string) => {
    setApiToken(token);
    setDraft("");
    // Saved token changes every request's auth; refetch everything once.
    // When the boot query then succeeds it clears namespaceBootError and
    // this banner disappears.
    await queryClient.invalidateQueries();
  };

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[200] px-4 py-3"
      style={{
        backgroundColor: "rgba(251, 191, 36, 0.1)",
        borderBottom: "1px solid rgba(251, 191, 36, 0.3)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ backgroundColor: "rgba(251, 191, 36, 0.2)" }}
          >
            <KeyRound
              className="w-4 h-4"
              style={{ color: "var(--color-amber)" }}
            />
          </div>
          <div>
            <p
              className="text-sm font-medium"
              style={{ color: "var(--color-amber)" }}
            >
              Not authorized — enter your DuckBrain API token
            </p>
            <p
              className="text-xs"
              style={{ color: "var(--color-clinical)", opacity: 0.8 }}
            >
              This server requires an API token. Paste it below or use the API
              token button.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input
            type="password"
            placeholder="Paste your token..."
            aria-label="DuckBrain API token"
            className="glass-input px-3 py-1.5 rounded text-sm min-w-[220px]"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            onClick={() => draft.trim() && saveFromBanner(draft)}
            className="px-3 py-1.5 rounded text-sm glass-button"
            style={{ color: "var(--color-amber)" }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
