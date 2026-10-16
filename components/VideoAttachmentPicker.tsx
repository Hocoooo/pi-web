"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { uploadFiles } from "@/lib/file-upload-client";
import { MAX_VIDEO_FILE_BYTES, videoMimeTypeForFile, type VideoReference } from "@/lib/video-attachments";

export interface VideoAttachmentPickerHandle {
  select: (files: File[]) => void;
}

/** One selection/upload path for the file chooser and chat drops. Transport reads the ready reference later. */
export const VideoAttachmentPicker = forwardRef<VideoAttachmentPickerHandle, {
  cwd?: string | null;
  video?: VideoReference;
  disabled: boolean;
  onChange: (video: VideoReference | undefined) => void;
  /** An unfinished or failed selection must not silently become a text-only send. */
  onBlockedChange: (blocked: boolean) => void;
  onFilesUploaded?: () => void;
}>(function VideoAttachmentPicker({ cwd, video, disabled, onChange, onBlockedChange, onFilesUploaded }, ref) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const attempt = useRef(0);
  const [upload, setUpload] = useState<{ name: string; progress: number; error?: string } | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const occupied = useRef(false);
  occupied.current = !!video || !!upload;
  useEffect(() => () => { attempt.current++; }, []);

  const remove = () => {
    attempt.current++; // The shared uploader may finish writing, but cannot restore a removed selection.
    setUpload(null);
    setSkipped(false);
    setSelectionError(null);
    occupied.current = false;
    onChange(undefined);
    onBlockedChange(false);
  };
  const select = async (files: File[]) => {
    if (!files.length) return;
    if (files.length !== 1 || occupied.current) { setSelectionError(t("chat.videoOneOnly")); return; }
    if (disabled) { setSelectionError(t("chat.videoIdleOnly")); return; }
    occupied.current = true; // A second drop in the same event turn must not replace this selection.
    setSelectionError(null);
    const id = ++attempt.current;
    const file = files[0];
    onBlockedChange(true);
    setUpload({ name: file.name, progress: 0 });
    try {
      const mimeType = videoMimeTypeForFile(file);
      if (!mimeType) throw new Error(t("chat.videoFormat"));
      if (file.size > MAX_VIDEO_FILE_BYTES) throw new Error(t("chat.videoTooLarge", { size: MAX_VIDEO_FILE_BYTES / 1024 / 1024 }));
      if (!cwd) throw new Error(t("chat.dropNeedsCwd"));
      const { status, data } = await uploadFiles(cwd, [file], "skip", progress => {
        if (attempt.current === id) setUpload({ name: file.name, progress });
      });
      if (attempt.current !== id) return;
      const existing = data.skipped?.includes(file.name) === true;
      if ((status !== 200 && status !== 207) || data.errors?.length || (!existing && !data.uploaded?.includes(file.name))) {
        throw new Error(data.error ?? data.errors?.[0]?.error ?? `HTTP ${status}: upload not confirmed`);
      }
      onChange({ version: 1, path: `${cwd.replace(/[\\/]+$/, "")}/${file.name}`, mimeType });
      setSkipped(existing);
      setUpload(null);
      onBlockedChange(false);
      if (!existing) onFilesUploaded?.();
    } catch (error) {
      if (attempt.current === id) setUpload({ name: file.name, progress: 0, error: error instanceof Error ? error.message : String(error) });
    }
  };
  useImperativeHandle(ref, () => ({ select: files => { void select(files); } }));
  const name = video?.path.split(/[\\/]/).pop() ?? upload?.name;
  const buttonStyle = { border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text-muted)", padding: "4px 8px", fontSize: 12, cursor: "pointer" };

  return (
    <div style={{ marginBottom: 6, fontSize: 12, minWidth: 0 }}>
      <input ref={input} type="file" accept=".mp4,.avi" aria-label={t("chat.attachVideo")} style={{ display: "none" }} onChange={e => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        void select(files);
      }} />
      {!name ? (
        <button type="button" disabled={disabled || !cwd} onClick={() => input.current?.click()} style={buttonStyle} title={t("chat.videoLimit", { size: MAX_VIDEO_FILE_BYTES / 1024 / 1024 })}>
          {t("chat.attachVideo")}
        </button>
      ) : (
        <div data-video-attachment style={{ padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, overflowWrap: "anywhere" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0 }} title={video?.path}>{name}</span>
            <button type="button" onClick={remove} aria-label={t("chat.removeVideo")} style={buttonStyle}>×</button>
          </div>
          <div role={upload?.error ? "alert" : "status"} style={{ color: upload?.error ? "var(--error, #ef4444)" : "var(--text-muted)" }}>
            {upload?.error ? t("chat.dropFailed", { message: upload.error })
              : upload ? t("chat.videoUploading", { progress: upload.progress })
              : skipped ? t("chat.videoSkipped") : t("chat.videoReady")}
          </div>
        </div>
      )}
      {selectionError && <div role="alert" style={{ color: "var(--error, #ef4444)", marginTop: 4 }}>{selectionError}</div>}
    </div>
  );
});
