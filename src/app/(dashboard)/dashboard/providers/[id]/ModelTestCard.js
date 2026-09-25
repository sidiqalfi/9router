"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, Button } from "@/shared/components";
import { translate } from "@/i18n/runtime";

const MAX_TEST_MS = 120000; // client-side cap; aborts a hung test

/**
 * ModelTestCard - free-text model tester below the "Available Models" card.
 * Streams the model's response live via /api/models/playground (SSE).
 */
export default function ModelTestCard({
  models = [],
  connections = [],
  isFreeNoAuth = false,
  requestAlias,
  resolveThinkingSuffix,
}) {
  const [modelId, setModelId] = useState(null); // null → derive from models
  const [connectionId, setConnectionId] = useState("auto");
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("idle"); // idle | streaming | done | error
  const [error, setError] = useState("");
  const [latencyMs, setLatencyMs] = useState(null);
  const [usage, setUsage] = useState(null);
  const abortRef = useRef(null);
  const outputRef = useRef(null);

  const streaming = status === "streaming";

  // Derive effective selection during render (no effect needed):
  // null → first model; stale id (model list changed) → first model.
  const effectiveModelId = models.some((m) => m.id === modelId) ? modelId : models[0]?.id || "";

  // Keep auto-scroll pinned to the bottom while streaming
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const connectionLabel = (c) =>
    c?.name?.trim() || c?.email?.trim() || c?.displayName?.trim() || (c?.id || "").slice(0, 8);

  const resetResult = () => {
    setOutput("");
    setError("");
    setUsage(null);
    setLatencyMs(null);
    setStatus("idle");
  };

  const send = async () => {
    const text = prompt.trim();
    if (!text || !effectiveModelId || streaming) return;
    if (!isFreeNoAuth && connections.length === 0) return;

    const suffix = resolveThinkingSuffix ? resolveThinkingSuffix(effectiveModelId) : null;
    const fullModel = suffix ? `${requestAlias}/${effectiveModelId}(${suffix})` : `${requestAlias}/${effectiveModelId}`;

    const controller = new AbortController();
    abortRef.current = controller;
    const abortTimer = setTimeout(() => controller.abort(), MAX_TEST_MS);

    setOutput("");
    setError("");
    setLatencyMs(null);
    setUsage(null);
    setStatus("streaming");
    const startAt = Date.now();

    let assistantText = "";
    let gotFirstToken = false;

    try {
      const response = await fetch("/api/models/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          model: fullModel,
          messages: [{ role: "user", content: text }],
          connectionId: connectionId === "auto" ? null : connectionId,
          maxTokens: 1024,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        const message = data?.error || data?.message || `Request failed (${response.status})`;
        throw new Error(typeof message === "string" ? message : JSON.stringify(message));
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const chunk = JSON.parse(payload);
            if (chunk.usage?.total_tokens) setUsage(chunk.usage);

            const choice = chunk.choices?.[0];
            const delta = choice?.delta || {};
            const piece =
              [delta.content, choice?.message?.content, chunk.output_text, chunk.text]
                .filter((t) => typeof t === "string" && t.length > 0)[0] || "";
            if (!piece) continue;
            if (!gotFirstToken) {
              gotFirstToken = true;
              setLatencyMs(Date.now() - startAt);
            }
            assistantText += piece;
            setOutput(assistantText);
          } catch {
            // Ignore malformed chunks.
          }
        }
      }

      setLatencyMs(Date.now() - startAt);
      setStatus(assistantText ? "done" : "error");
      if (!assistantText) setError("Empty response from model");
    } catch (err) {
      if (err?.name === "AbortError") {
        if (assistantText) {
          setStatus("done");
          setOutput(`${assistantText}\n\n(stopped)`);
        } else {
          setStatus("error");
          setError("Request timed out or stopped");
        }
        setLatencyMs(Date.now() - startAt);
      } else {
        setStatus("error");
        setError(err?.message || "Request failed");
        if (assistantText) setOutput(assistantText);
      }
    } finally {
      clearTimeout(abortTimer);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const handleModelChange = (id) => {
    setModelId(id);
    resetResult();
  };

  const handleConnectionChange = (id) => {
    setConnectionId(id);
    resetResult();
  };

  const noModels = models.length === 0;
  const noConnections = !isFreeNoAuth && connections.length === 0;
  const canSend = !noModels && !noConnections && !!prompt.trim() && !streaming;

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{"Model Playground"}</h2>
        {streaming && (
          <span className="flex items-center gap-1 text-xs text-text-muted">
            <span
              className="material-symbols-outlined text-sm"
              style={{ animation: "spin 1s linear infinite" }}
            >
              progress_activity
            </span>
            {"Streaming..."}
          </span>
        )}
      </div>

      {noModels ? (
        <p className="text-sm text-text-muted">{"Add a model to test it here."}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-col gap-2 sm:flex-row">
            <select
              value={effectiveModelId}
              onChange={(e) => handleModelChange(e.target.value)}
              disabled={streaming}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none disabled:opacity-50 sm:flex-1"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name || m.id}
                </option>
              ))}
            </select>
            <select
              value={connectionId}
              onChange={(e) => handleConnectionChange(e.target.value)}
              disabled={streaming || isFreeNoAuth}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:border-primary focus:outline-none disabled:opacity-50 sm:flex-1"
            >
              <option value="auto">{"Auto"}</option>
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {connectionLabel(c)}
                </option>
              ))}
            </select>
          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            disabled={streaming}
            placeholder="Type anything to test this model..."
            className="w-full resize-none rounded-lg border border-border-subtle bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
          />

          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-text-muted">{"Enter to send · Shift+Enter for newline"}</span>
            {streaming ? (
              <Button size="sm" variant="secondary" icon="stop" onClick={stop}>
                {"Stop"}
              </Button>
            ) : (
              <Button size="sm" icon="send" onClick={send} disabled={!canSend}>
                {"Send"}
              </Button>
            )}
          </div>

          {noConnections && (
            <p className="mt-2 text-xs text-amber-500">{"Add a connection to test this model."}</p>
          )}

          <pre
            ref={outputRef}
            className="mt-3 min-h-[80px] max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-sidebar p-3 font-mono text-xs text-text-main"
          >
            {output || (status === "idle" ? "Response will appear here..." : "")}
          </pre>

          <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-text-muted">
            {latencyMs != null && <span>{`${latencyMs} ms`}</span>}
            {usage?.total_tokens != null && <span>{`${usage.total_tokens} tokens`}</span>}
            {error && <span className="break-all text-red-500">{error}</span>}
          </div>
        </>
      )}
    </Card>
  );
}
