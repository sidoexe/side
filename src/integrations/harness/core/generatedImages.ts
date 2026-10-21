import {
  deleteGeneratedImages as deleteLocal,
  saveGeneratedImage as saveLocal,
  type GeneratedImageAsset,
} from "../../../platform/tauri/fs";

/** Where an agent's generated images are kept: the app's own folder on the
 * desktop, or a host's attachment store, from which every client reads them
 * (`attachmentId`). */
export type GeneratedImageStore = {
  save(input: { data: string; name: string }): Promise<GeneratedImageAsset & { attachmentId?: string }>;
  delete(paths: string[]): Promise<void>;
};

// Read when called, not when this module loads.
let current: GeneratedImageStore = { save: (input) => saveLocal(input), delete: (paths) => deleteLocal(paths) };

/** The host keeps the images of the turns it runs itself. */
export function setGeneratedImageStore(store: GeneratedImageStore): void {
  current = store;
}

export const saveGeneratedImage = (input: { data: string; name: string }) => current.save(input);
export const deleteGeneratedImages = (paths: string[]) => current.delete(paths);
