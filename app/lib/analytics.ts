import { CourseStatus } from "~/db/schema";

/** `"30d"` = rolling window: timestamps `>= now - 30 × 24h`. */
export type AnalyticsRange = "all" | "30d";

/** Reads `?range=30d` from a request URL; anything else means all time. */
export function parseRange(request: Request): AnalyticsRange {
  return new URL(request.url).searchParams.get("range") === "30d"
    ? "30d"
    : "all";
}

export type ActiveCourseStatus = CourseStatus.Published | CourseStatus.Archived;

/** Published or archived — the courses that have analytics. Drafts don't. */
export function isActiveCourse<T extends { status: CourseStatus }>(
  course: T
): course is T & { status: ActiveCourseStatus } {
  return course.status !== CourseStatus.Draft;
}
