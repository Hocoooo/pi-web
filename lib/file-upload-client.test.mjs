import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { dropMentionText, splitDroppedItems } = await jiti.import("./file-upload-client.ts");
const { videoMimeTypeForFile } = await jiti.import("./video-attachments.ts");

const file = (name, type = "") => new File(["x"], name, { type });

test("a chat drop attaches images, uploads other files, and leaves folders out", () => {
  const photo = file("photo.png", "image/png");
  const notes = file("notes.md", "text/markdown");
  const data = file("data.bin");
  const result = splitDroppedItems([
    { kind: "file", file: photo },
    { kind: "file", file: notes },
    { kind: "folder", name: "src" },
    { kind: "file", file: data },
  ]);
  assert.deepEqual(result.images, [photo]);
  assert.deepEqual(result.files, [notes, data]);
  assert.deepEqual(result.folders, ["src"]);
});

test("video candidates stay out of image/ordinary uploads, including invalid video MIME and empty MIME suffixes", () => {
  const videos = [file("CLIP.MP4"), file("clip.AVI"), file("clip.avi", "video/x-msvideo"), file("clip.mov", "video/quicktime"), file("wrong.mp4", "image/png")];
  const photo = file("photo.png", "image/png"), unknown = file("unknown.bin"), noMimeImage = file("photo.jpg");
  assert.deepEqual(splitDroppedItems([
    ...videos.map(file => ({ kind: "file", file })),
    { kind: "folder", name: "folder.mp4" },
    ...[photo, unknown, noMimeImage].map(file => ({ kind: "file", file })),
  ]), { videos, images: [photo], files: [unknown, noMimeImage], folders: ["folder.mp4"] });
});

test("picker and drop share a small deterministic MP4/AVI MIME rule", () => {
  for (const [name, type, expected] of [
    ["CLIP.MP4", "", "video/mp4"], ["clip.AVI", "", "video/avi"],
    ["clip.mp4", "video/mp4", "video/mp4"], ["clip.avi", "video/avi", "video/avi"],
    ["clip.avi", "video/x-msvideo", "video/avi"],
    ["clip.mp4", "video/avi"], ["clip.avi", "video/mp4"],
    ["clip.mp4", "image/png"], ["clip.mp4", "application/octet-stream"],
    ["clip.mov", "video/quicktime"], ["notes.txt", "video/mp4"], ["no-extension", ""],
  ]) assert.equal(videoMimeTypeForFile(file(name, type)), expected, `${name}: ${type}`);
});

test("mentions follow the drop order and only name files now in the working directory", () => {
  const files = [file("b.txt"), file("my notes.md"), file("failed.log"), file("a.txt")];
  assert.equal(
    dropMentionText(files, ["a.txt", "my notes.md", "b.txt"]),
    '@b.txt @"my notes.md" @a.txt ',
  );
  assert.equal(dropMentionText(files, []), "");
});
