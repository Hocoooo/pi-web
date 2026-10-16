import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getDraft, setDraft, clearDraft, rekeyDraft, restoreDraftSubmission } = await createJiti(import.meta.url).import("./draft-store.ts");
const video = { version: 1, path: "/synthetic/clip.mp4", mimeType: "video/mp4" };

test("video-only memory drafts are retained and reference snapshots are independent", () => {
  const key = "video-only";
  const reference = { ...video };
  setDraft(key, { value: "", images: [], video: reference });
  reference.path = "/changed.mp4";
  assert.deepEqual(getDraft(key).video, video);
  const loaded = getDraft(key);
  loaded.video.path = "/also-changed.mp4";
  assert.deepEqual(getDraft(key).video, video);
  clearDraft(key);
});

test("basic rejected submission keeps text/images/video through native session promotion", () => {
  const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
  restoreDraftSubmission("new-video", "Question", images, video);
  const promoted = rekeyDraft("new-video", "native-video");
  assert.equal(getDraft("new-video"), null);
  assert.deepEqual(promoted, { value: "Question", images, video });
  assert.deepEqual(getDraft("native-video"), promoted);
  clearDraft("native-video");
});
