"use client";

import ReactMarkdown from "react-markdown";
import { markdownRehypePlugins, markdownUserRemarkPlugins, normalizeDisplayMath } from "@/lib/markdown";
import { TASK_CONTEXT_FIELDS, type TaskContextContent } from "@/lib/task-types";
import { useI18n } from "@/hooks/useI18n";
import styles from "./TaskSharedContext.module.css";

/** Same sanitized Markdown pipeline as chat, but entirely passive knowledge:
 * no URL/image requests, file links, diagram execution or code action buttons. */
export function TaskContextPreview({ content }: { content: TaskContextContent }) {
  const { t } = useI18n();
  return <div className={styles.preview}>
    {TASK_CONTEXT_FIELDS.map((key) => <section key={key}>
      <h4>{t(`tasks.context.${key}`)}</h4>
      <div className="markdown-body"><ReactMarkdown
        remarkPlugins={markdownUserRemarkPlugins} rehypePlugins={markdownRehypePlugins}
        urlTransform={() => ""} components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt}</span>,
          code: ({ children }) => <code>{children}</code>,
        }}>
        {normalizeDisplayMath(content[key])}
      </ReactMarkdown></div>
    </section>)}
  </div>;
}
