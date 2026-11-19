export interface SseFrame {
  event?: string;
  data: string;
}

/**
 * Parses a Server-Sent Events byte stream into individual event frames.
 * Handles CRLF/LF line endings, multi-line `data:` payloads, and clean EOF flushing.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseFrame | null => {
    if (dataLines.length === 0) {
      currentEvent = undefined;
      return null;
    }
    const frame: SseFrame = {
      event: currentEvent,
      data: dataLines.join("\n"),
    };
    currentEvent = undefined;
    dataLines = [];
    return frame;
  };

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      else if (done) buffer += decoder.decode();

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          const frame = flush();
          if (frame) yield frame;
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          currentEvent = line.slice("event:".length).trim();
        } else if (line.startsWith("data:")) {
          const payload = line.slice("data:".length);
          dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
        }
      }

      if (done) {
        if (buffer.trim()) {
          const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
          if (line.startsWith("data:")) {
            const payload = line.slice("data:".length);
            dataLines.push(payload.startsWith(" ") ? payload.slice(1) : payload);
          }
        }
        const frame = flush();
        if (frame) yield frame;
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
