// An in-memory `MediaStore` for the file-output tests (D152): no disk, and the
// same never-overwrite rule as the real store — a taken name gets a `-N`
// variant before the extension.

import type { MediaStore, MediaWriteResult } from '../api/attachments.js';

/** A `MediaStore` that keeps its files in a Map the test can inspect. */
export interface MemoryMedia extends MediaStore {
  readonly files: Map<string, Uint8Array>;
}

export function createMemoryMedia(dir = '/media'): MemoryMedia {
  const files = new Map<string, Uint8Array>();
  return {
    dir,
    files,
    write(name, bytes): Promise<MediaWriteResult> {
      const dot = name.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
      let candidate = name;
      for (let i = 1; files.has(candidate); i += 1)
        candidate = `${stem}-${String(i)}${ext}`;
      files.set(candidate, bytes);
      return Promise.resolve({
        name: candidate,
        path: `${dir}/${candidate}`,
        bytes: bytes.byteLength,
      });
    },
    read(name) {
      const bytes = files.get(name);
      return bytes === undefined
        ? Promise.reject(new Error(`ENOENT: ${name}`))
        : Promise.resolve({ path: `${dir}/${name}`, bytes });
    },
  };
}
