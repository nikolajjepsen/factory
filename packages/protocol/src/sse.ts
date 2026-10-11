/** One server-sent event. Comment lines (keep-alives) are skipped. */
export interface SseMessage {
  event: string;
  data: string;
}

/**
 * Splits a text/event-stream into messages as chunks arrive. Handles events split across chunks,
 * multi-line data and CRLF line ends.
 */
export class SseParser {
  #buffer = '';

  push(chunk: string): SseMessage[] {
    this.#buffer += chunk.replace(/\r\n?/g, '\n');
    const messages: SseMessage[] = [];
    let end: number;
    while ((end = this.#buffer.indexOf('\n\n')) >= 0) {
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
      }
      if (data.length > 0) messages.push({ event, data: data.join('\n') });
    }
    return messages;
  }
}
