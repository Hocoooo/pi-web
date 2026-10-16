import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getDraft, setDraft, clearDraft, rekeyDraft, restoreDraftSubmission } = await createJiti(import.meta.url).import("./draft-store.ts");
const videos = [
  { version: 1, path: "/synthetic/clip.mp4", mimeType: "video/mp4" },
  { version: 1, path: "/synthetic/clip.avi", mimeType: "video/avi" },
];

test("video-only memory drafts retain independent arrays and reference snapshots", () => {
  const key = "video-only";
  const references = videos.map(video => ({ ...video }));
  setDraft(key, { value: "", images: [], videos: references });
  references[0].path = "/changed.mp4";
  references.pop();
  assert.deepEqual(getDraft(key).videos, videos);
  const loaded = getDraft(key);
  loaded.videos[1].path = "/also-changed.avi";
  loaded.videos.pop();
  assert.deepEqual(getDraft(key).videos, videos);
  clearDraft(key);
  setDraft(key, { value: "", images: [], videos: [] });
  assert.equal(getDraft(key), null);
});

test("rejected submission keeps text/images/all videos through native session promotion", () => {
  const images = [{ data: "aGVsbG8=", mimeType: "image/png" }];
  restoreDraftSubmission("new-video", "Question", images, videos);
  const promoted = rekeyDraft("new-video", "native-video");
  assert.equal(getDraft("new-video"), null);
  assert.deepEqual(promoted, { value: "Question", images, videos });
  assert.deepEqual(getDraft("native-video"), promoted);
  clearDraft("native-video");
});

test("recovery merges references without silently discarding an over-cap concurrent draft", () => {
  const current = Array.from({ length: 4 }, (_, i) => ({ ...videos[0], path: `/synthetic/${i}.mp4` }));
  setDraft("merge-video", { value: "Later draft", images: [], videos: current });
  const restored = restoreDraftSubmission("merge-video", "Rejected question", [], videos);
  assert.equal(restored.value, "Rejected question\n\nLater draft");
  assert.deepEqual(restored.videos, [...videos, ...current]);
  clearDraft("merge-video");
});
