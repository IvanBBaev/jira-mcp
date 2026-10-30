// Bodies, both ways: capped text and byte reads raced against the attempt
// guard, and the multipart upload the attachment route sends (D515).

import { MAX_ATTACHMENT_BYTES, MAX_TEXT_BODY_BYTES } from '../http-util.js';
import type { JiraError, JiraMultipartFile } from '../types.js';
import type { CallContext } from './context.js';
import type { AttemptGuard } from './guard.js';

/**
 * Read a body whose CONTENT cannot change the outcome — an error body, a
 * drained redirect. The status has already decided what happens, so a read that
 * fails costs a message snippet, not the verdict.
 */
export async function readTextOrEmpty(
  guard: AttemptGuard,
  response: Response,
): Promise<string> {
  try {
    const read = await readTextCapped(guard, response);
    // Over the cap: the snippet is not worth the allocation (CC-384).
    return read.kind === 'text' ? read.text : '';
  } catch {
    return '';
  }
}

/** A text body, or how many bytes had arrived when it crossed the cap. */
export type CappedText =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'over'; readonly bytes: number };

/**
 * Read a text body under {@link MAX_TEXT_BODY_BYTES}, counting as it arrives and
 * cancelling the transfer at the chunk that crosses the cap (CC-384). Every read
 * is raced against the attempt guard, like the attachment reader.
 *
 * A response with no stream (bodiless, or a fetch stub that has none) has
 * nothing to meter and is read whole.
 */
export async function readTextCapped(
  guard: AttemptGuard,
  response: Response,
): Promise<CappedText> {
  const body = response.body;
  if (body === null) return { kind: 'text', text: await guard.guard(response.text()) };

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await guard.guard(reader.read());
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_TEXT_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { kind: 'over', bytes: total };
      }
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  parts.push(decoder.decode());
  return { kind: 'text', text: parts.join('') };
}

/** The request a body belongs to, as an error message names it. */
type CallLabel = Pick<CallContext, 'method' | 'route' | 'fail'>;

/** Breach of {@link MAX_ATTACHMENT_BYTES}, in either direction. */
export function attachmentTooLarge(
  call: CallLabel,
  bytes: number,
  direction: 'download' | 'upload',
): JiraError {
  const { method, route } = call;
  return call.fail({
    // Same kind an HTTP 413 maps to: the caller asked for something the
    // wire will not carry, and no retry can change that.
    kind: 'validation',
    message: `The ${direction} for ${method} ${route} is over the ${String(MAX_ATTACHMENT_BYTES)}-byte attachment limit (${String(bytes)} bytes).`,
    retryable: false,
    remediation:
      'This limit is compiled in and has no environment override. Use a smaller file, or move the attachment outside this server.',
  });
}

/**
 * Read a whole body as bytes, counting AS IT ARRIVES and aborting the
 * transfer at the byte that crosses the cap — buffering first and checking
 * afterwards would defeat the point of having a cap.
 *
 * Every read is raced against the attempt guard: a source that drips one
 * chunk an hour is exactly the transfer the timeout exists for, and it is
 * indistinguishable from a healthy one until the clock says otherwise.
 */
export async function readBytesCapped(
  call: CallLabel,
  guard: AttemptGuard,
  response: Response,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    // No stream to meter (an empty body, or a fetch stub that returns
    // none): the buffer is already in memory, so just police its size.
    //
    // The over-cap arm below is NOT reachable through a conformant fetch
    // and is kept anyway. Per the Fetch standard a null `body` means a
    // bodiless response — 204/205/304, or one constructed with a null body
    // — so "no stream" and "50 MiB of bytes" cannot both be true on the
    // wire; CC-91 covers the reachable half (204 → zero bytes). Forcing the
    // other half would take a Response with both `body` and `arrayBuffer`
    // overridden, which tests the double rather than this code. It stays
    // because the alternative to a wrong cap here is no cap at all: any
    // future fetch that buffers instead of streaming would hand the process
    // an unbounded allocation, and this line is what refuses it.
    const buffer = await guard.guard(response.arrayBuffer());
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw attachmentTooLarge(call, buffer.byteLength, 'download');
    }
    return new Uint8Array(buffer);
  }

  // `Response.body` is a stream of bytes, but the ambient type leaves the
  // chunk type open; this is the one place that pins it.
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await guard.guard(reader.read());
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_ATTACHMENT_BYTES) throw attachmentTooLarge(call, total, 'download');
      chunks.push(chunk.value);
    }
  } catch (error) {
    // Whatever ended the read — the cap, the attempt timeout, the caller —
    // the transfer stops here rather than going on pulling bytes that now
    // have no destination.
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Turn the declared parts into a `FormData`, refusing anything the Jira
 * upload route cannot mean. The size check runs on the summed part sizes
 * BEFORE a single `Blob` exists, so an oversized upload never gets copied.
 */
export function buildMultipart(
  call: CallLabel & Pick<CallContext, 'spec'>,
  parts: readonly JiraMultipartFile[],
): FormData {
  const { method, route, fail, spec } = call;
  if (spec.body !== undefined) {
    throw fail({
      kind: 'config',
      message: `${method} ${route} was given both a JSON body and multipart parts.`,
      remediation: 'A request carries one or the other; this is a caller bug.',
    });
  }
  if (method !== 'POST') {
    throw fail({
      kind: 'config',
      message: `${method} ${route} cannot carry multipart parts; only POST uploads can.`,
      remediation: 'This is a caller bug: send the upload as a POST.',
    });
  }
  if (parts.length === 0) {
    throw fail({
      kind: 'config',
      message: `${method} ${route} was given an empty multipart body.`,
      remediation: 'Send at least one file part.',
    });
  }

  let total = 0;
  for (const part of parts) total += part.bytes.byteLength;
  if (total > MAX_ATTACHMENT_BYTES) throw attachmentTooLarge(call, total, 'upload');

  const form = new FormData();
  for (const part of parts) {
    const blob = new Blob([part.bytes], {
      type: part.contentType ?? 'application/octet-stream',
    });
    form.append(part.field, blob, part.filename);
  }
  return form;
}
