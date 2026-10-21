import type { HostSession } from "./protocol";

type Chunk = { data: string; offset: number; size: number };
const downloads = new Map<string, Promise<string>>();
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
/** As the host's MAX_GENERATED_IMAGE_BYTES. */
const MAX_GENERATED_BYTES = 25 * 1024 * 1024;

/** Preview bytes live only in desktop snapshots, not in every host database
 * write. Unchanged attachments reuse their previous data across delta syncs.
 * Images an agent generated on the host are read the same way. */
export async function withRemoteAttachmentPreviews(
  machineId: string,
  snapshot: HostSession,
  known: HostSession | undefined,
  read: (params: {
    sessionId: string;
    id: string;
    offset: number;
  }) => Promise<Chunk>,
): Promise<HostSession> {
  const knownBlocks = known?.session.id === snapshot.session.id ? known.session.blocks : [];
  const previous = new Map<string, string | undefined>([
    ...knownBlocks.flatMap((block) => block.attachments ?? []).map((file) => [file.id, file.data] as const),
    ...knownBlocks.flatMap((block) => (block.image?.attachmentId ? [[block.image.attachmentId, block.image.data] as const] : [])),
  ]);

  /** One image's bytes as base64, in the chunks the host serves. */
  const download = (id: string, size: number): Promise<string> => {
    const key = JSON.stringify([machineId, snapshot.session.id, id]);
    let running = downloads.get(key);
    if (!running) {
      running = (async () => {
        const pieces: string[] = [];
        let offset = 0;
        while (offset < size) {
          const chunk = await read({ sessionId: snapshot.session.id, id, offset });
          if (
            chunk.size !== size ||
            chunk.offset <= offset ||
            chunk.offset > size ||
            atob(chunk.data).length !== chunk.offset - offset ||
            (chunk.offset < size && (chunk.offset - offset) % 3 !== 0)
          )
            throw new Error("Invalid image transfer");
          pieces.push(chunk.data);
          offset = chunk.offset;
        }
        return pieces.join("");
      })().finally(() => downloads.delete(key));
      downloads.set(key, running);
    }
    return running;
  };
  /** Missing images must not hide the conversation or mark its host offline. */
  const bytes = async (id: string, size: number) => {
    try {
      return previous.get(id) ?? (await download(id, size));
    } catch {
      return undefined;
    }
  };

  let changed = false;
  const blocks = await Promise.all(
    snapshot.session.blocks.map(async (block) => {
      const image = block.image;
      if (image?.attachmentId && !image.data && image.size <= MAX_GENERATED_BYTES) {
        const data = await bytes(image.attachmentId, image.size);
        if (data === undefined) return block;
        changed = true;
        return { ...block, image: { ...image, data } };
      }
      if (!block.attachments?.length) return block;
      const attachments = await Promise.all(
        block.attachments.map(async (file) => {
          if (file.kind !== "image" || file.data || file.previewUrl || file.size > MAX_PREVIEW_BYTES) return file;
          const data = await bytes(file.id, file.size);
          return data === undefined ? file : { ...file, data };
        }),
      );
      if (attachments.every((file, index) => file === block.attachments![index])) return block;
      changed = true;
      return { ...block, attachments };
    }),
  );
  return changed ? { ...snapshot, session: { ...snapshot.session, blocks } } : snapshot;
}
