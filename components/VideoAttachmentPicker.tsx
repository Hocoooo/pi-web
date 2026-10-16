"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { uploadFiles } from "@/lib/file-upload-client";
import { MAX_VIDEO_ATTACHMENTS, MAX_VIDEO_FILE_BYTES, MAX_VIDEO_REQUEST_BYTES, videoMimeTypeForFile, type VideoReference } from "@/lib/video-attachments";

export interface VideoAttachmentPickerHandle {
  select: (files: File[]) => void;
}

type Upload = { id: number; name: string; progress: number; error?: string };

/** The chooser and drops share append, validation and per-file upload/removal. */
export const VideoAttachmentPicker = forwardRef<VideoAttachmentPickerHandle, {
  cwd?: string | null;
  videos?: VideoReference[];
  disabled: boolean;
  onChange: (videos: VideoReference[] | undefined) => void;
  /** An unfinished or failed selection must not silently become a text-only send. */
  onBlockedChange: (blocked: boolean) => void;
  onFilesUploaded?: () => void;
}>(function VideoAttachmentPicker({ cwd, videos, disabled, onChange, onBlockedChange, onFilesUploaded }, ref) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const uploadsRef = useRef<Upload[]>([]);
  const uploadChain = useRef(Promise.resolve());
  const videosRef = useRef(videos ?? []);
  videosRef.current = videos ?? [];
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [skipped, setSkipped] = useState<Set<VideoReference>>(new Set());
  const [selectionError, setSelectionError] = useState<string | null>(null);
  useEffect(() => () => { uploadsRef.current = []; }, []);

  const updateUploads = (next: Upload[]) => {
    uploadsRef.current = next;
    setUploads(next);
    onBlockedChange(next.length > 0);
  };
  const changeVideos = (next: VideoReference[]) => {
    videosRef.current = next;
    onChange(next.length ? next : undefined);
  };
  const removeUpload = (id: number) => {
    // The uploader may finish writing, but cannot restore a removed selection.
    updateUploads(uploadsRef.current.filter(upload => upload.id !== id));
    setSelectionError(null);
  };
  const select = (files: File[]) => {
    if (!files.length) return;
    if (disabled) { setSelectionError(t("chat.videoIdleOnly")); return; }
    if (files.length + videosRef.current.length + uploadsRef.current.length > MAX_VIDEO_ATTACHMENTS) {
      setSelectionError(t("chat.videoCountLimit", { count: MAX_VIDEO_ATTACHMENTS })); return;
    }
    setSelectionError(null);
    // Reserve every slot synchronously so a second drop cannot exceed the cap.
    const pending = files.map(file => ({ id: ++nextId.current, name: file.name, progress: 0 }));
    updateUploads([...uploadsRef.current, ...pending]);
    files.forEach((file, index) => {
      const id = pending[index].id;
      const active = () => uploadsRef.current.some(upload => upload.id === id);
      const update = (patch: Partial<Upload>) => {
        if (active()) updateUploads(uploadsRef.current.map(upload => upload.id === id ? { ...upload, ...patch } : upload));
      };
      // Serialize this small bounded list so references keep selection order,
      // including files appended by later drops while an upload is pending.
      uploadChain.current = uploadChain.current.then(async () => {
        if (!active()) return;
        try {
          const mimeType = videoMimeTypeForFile(file);
          if (!mimeType) throw new Error(t("chat.videoFormat"));
          if (file.size > MAX_VIDEO_FILE_BYTES) throw new Error(t("chat.videoTooLarge", { size: MAX_VIDEO_FILE_BYTES / 1024 / 1024 }));
          if (!cwd) throw new Error(t("chat.dropNeedsCwd"));
          const { status, data } = await uploadFiles(cwd, [file], "skip", progress => update({ progress }));
          if (!active()) return;
          const existing = data.skipped?.includes(file.name) === true;
          if ((status !== 200 && status !== 207) || data.errors?.length || (!existing && !data.uploaded?.includes(file.name))) {
            throw new Error(data.error ?? data.errors?.[0]?.error ?? `HTTP ${status}: upload not confirmed`);
          }
          const video: VideoReference = { version: 1, path: `${cwd.replace(/[\\/]+$/, "")}/${file.name}`, mimeType };
          changeVideos([...videosRef.current, video]);
          if (existing) setSkipped(current => new Set([...current, video]));
          updateUploads(uploadsRef.current.filter(upload => upload.id !== id));
          if (!existing) onFilesUploaded?.();
        } catch (error) {
          update({ progress: 0, error: error instanceof Error ? error.message : String(error) });
        }
      });
    });
  };
  useImperativeHandle(ref, () => ({ select }));
  const buttonStyle = { border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)", color: "var(--text-muted)", padding: "4px 8px", fontSize: 12, cursor: "pointer" };

  return (
    <div style={{ marginBottom: 6, fontSize: 12, minWidth: 0 }}>
      <input ref={input} type="file" multiple accept=".mp4,.avi" aria-label={t("chat.attachVideo")} style={{ display: "none" }} onChange={e => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = "";
        select(files);
      }} />
      <button type="button" disabled={disabled || !cwd || (videos?.length ?? 0) + uploads.length >= MAX_VIDEO_ATTACHMENTS} onClick={() => input.current?.click()} style={buttonStyle} title={t("chat.videoLimit", { count: MAX_VIDEO_ATTACHMENTS, size: MAX_VIDEO_FILE_BYTES / 1024 / 1024, budget: MAX_VIDEO_REQUEST_BYTES / 1024 / 1024 })}>
        {t("chat.attachVideo")}
      </button>
      {videos?.map((video, index) => (
        <div key={index} data-video-attachment style={{ padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, overflowWrap: "anywhere" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0 }} title={video.path}>{video.path.split(/[\\/]/).pop()}</span>
            <button type="button" disabled={disabled} onClick={() => { changeVideos(videosRef.current.filter((_, i) => i !== index)); setSelectionError(null); }} aria-label={t("chat.removeVideo")} style={buttonStyle}>×</button>
          </div>
          <div role="status" style={{ color: "var(--text-muted)" }}>{skipped.has(video) ? t("chat.videoSkipped") : t("chat.videoReady")}</div>
        </div>
      ))}
      {uploads.map(upload => (
        <div key={upload.id} data-video-attachment style={{ padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, overflowWrap: "anywhere" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0 }}>{upload.name}</span>
            <button type="button" disabled={disabled} onClick={() => removeUpload(upload.id)} aria-label={t("chat.removeVideo")} style={buttonStyle}>×</button>
          </div>
          <div role={upload.error ? "alert" : "status"} style={{ color: upload.error ? "var(--error, #ef4444)" : "var(--text-muted)" }}>
            {upload.error ? t("chat.dropFailed", { message: upload.error }) : t("chat.videoUploading", { progress: upload.progress })}
          </div>
        </div>
      ))}
      {selectionError && <div role="alert" style={{ color: "var(--error, #ef4444)", marginTop: 4 }}>{selectionError}</div>}
    </div>
  );
});
