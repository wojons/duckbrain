/**
 * SDK-PARITY-001: Server-Sent Events, parsed without a dependency.
 *
 * The feed is `/api/events/{namespace}` (src/http/routes/events.ts): one
 * `data: <json>` line per frame, frames separated by a blank line. This parser
 * is transport only — it never interprets the payload, it yields whatever
 * object the server sent (including the opening `connected` frame).
 */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary !== -1) {
        const rawFrame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + boundaryLength(buffer, boundary));
        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
        boundary = findBoundary(buffer);
      }
    }
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function findBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function boundaryLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function parseFrame(rawFrame: string): Record<string, unknown> | null {
  const data: string[] = [];
  for (const line of rawFrame.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(":")) continue;
    if (!line.startsWith("data:")) continue;
    data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
  }
  if (data.length === 0) return null;
  const payload = data.join("\n");
  try {
    const parsed: unknown = JSON.parse(payload);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { data: parsed };
  } catch {
    return { data: payload };
  }
}
