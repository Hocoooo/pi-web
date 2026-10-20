type Priority = "foreground" | "background";
type Job = { start: () => void };

/** Process-wide admission for read-only project identity queries, not worktree
 * mutations. Defer launches to a new turn: async execFile still has a costly
 * synchronous spawn prefix on Windows. Reserve capacity for current-session
 * authoritative reads rather than queuing them behind the entire sidebar. */
export function createProjectResolutionQueue() {
  const foreground: Job[] = [];
  const background: Job[] = [];
  let active = 0;
  let activeBackground = 0;
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      while (active < 4) {
        const isBackground = foreground.length === 0;
        const job = isBackground
          ? activeBackground < 2 ? background.shift() : undefined
          : foreground.shift();
        if (!job) break;
        active++;
        if (isBackground) activeBackground++;
        job.start();
      }
    });
  };
  return {
    run<T>(priority: Priority, work: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const release = () => {
          active--;
          if (priority === "background") activeBackground--;
          if (foreground.length || background.length) schedule();
        };
        const job = { start: () => {
          Promise.resolve().then(work).then(
            value => { release(); resolve(value); },
            error => { release(); reject(error); },
          );
        } };
        (priority === "background" ? background : foreground).push(job);
        schedule();
      });
    },
  };
}

declare global {
  var __piProjectResolutionQueue: ReturnType<typeof createProjectResolutionQueue> | undefined;
}
export function queueProjectResolution<T>(priority: Priority, work: () => Promise<T>): Promise<T> {
  return (globalThis.__piProjectResolutionQueue ??= createProjectResolutionQueue()).run(priority, work);
}
