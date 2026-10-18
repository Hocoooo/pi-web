import { redirect } from "next/navigation";

/** Old bookmarks use the same chat-hosted panel, not a second dashboard surface. */
export default async function TasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams({ tasks: "1" });
  for (const key of ["sourceSession", "summarySession"] as const) {
    if (typeof params[key] === "string") query.set(key, params[key]);
  }
  redirect(`/?${query}`);
}
