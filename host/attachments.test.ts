import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "./store";
import { hostGeneratedImages, readAttachmentChunk, writeAttachmentChunk } from "./attachments";

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

it("accepts ordered chunks and an identical retry while rejecting changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "remote-upload-test-"));
  const store = new HostStore(join(directory, "host.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const chunk = (offset: number, data: string) =>
    writeAttachmentChunk(store, {
      id,
      offset,
      size: 6,
      data: Buffer.from(data).toString("base64"),
    });
  expect(chunk(0, "abc")).toEqual({ offset: 3 });
  expect(chunk(0, "abc")).toEqual({ offset: 3 });
  expect(() => chunk(0, "xyz")).toThrow("does not match");
  expect(() => chunk(4, "ef")).toThrow("out of order");
  expect(chunk(3, "def")).toEqual({ offset: 6 });
  expect(() =>
    writeAttachmentChunk(store, {
      id: "../escape",
      offset: 0,
      size: 1,
      data: "YQ==",
    }),
  ).toThrow("Invalid attachment ID");
});

it("keeps an agent's generated image where every client can read it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "generated-image-test-"));
  const store = new HostStore(join(directory, "host.db"));
  cleanups.push(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // The 8-byte PNG signature and a little more.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const images = hostGeneratedImages(store);
  const asset = await images.save({ data: png.toString("base64"), name: "cat.png" });
  expect(asset).toMatchObject({ mimeType: "image/png", size: png.length });
  await expect(images.save({ data: Buffer.from("text").toString("base64"), name: "x" })).rejects.toThrow(/not an image/);

  const project = store.addProject(directory, "p");
  store.save(
    {
      projectId: project.id,
      revision: 1,
      status: "idle",
      updatedAt: 1,
      session: {
        id: "s",
        harness: "codex",
        model: "codex:test",
        runtimeMode: "supervised",
        title: "Images",
        cwd: directory,
        blocks: [
          { id: "made", role: "image", text: "", image: { path: asset.path, name: "cat.png", mimeType: asset.mimeType, size: asset.size, attachmentId: asset.attachmentId } },
        ],
      },
    } as never,
    { type: "test" },
  );
  const chunk = readAttachmentChunk(store, { sessionId: "s", id: asset.attachmentId, offset: 0 });
  expect(Buffer.from(chunk.data, "base64")).toEqual(png);
  expect(chunk).toMatchObject({ offset: png.length, size: png.length });
}, 10_000);
