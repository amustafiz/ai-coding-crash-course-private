import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { createAnalyticsFixtures } from "~/test/analyticsFixtures";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let fx: ReturnType<typeof createAnalyticsFixtures>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getInstructorAnalytics } from "./analyticsService";

describe("getInstructorAnalytics (dashboard)", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    fx = createAnalyticsFixtures(testDb, base);
  });

  it("reports the no-courses state for an instructor without courses", () => {
    const instructor = fx.addInstructor();

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.state).toBe("no-courses");
    expect(result.courses).toEqual([]);
  });

  it("reports the drafts-only state and still lists the draft courses", () => {
    const instructor = fx.addInstructor();
    const draft = fx.addCourse({
      instructorId: instructor.id,
      status: schema.CourseStatus.Draft,
    });
    fx.addEnrollment(fx.addStudent().id, draft.id);

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.state).toBe("drafts-only");
    expect(result.courses).toHaveLength(1);
    expect(result.courses[0]).toMatchObject({
      id: draft.id,
      status: schema.CourseStatus.Draft,
      studentCount: 1,
      lessonCount: 0,
    });
  });

  it("reports the ready state for a published course with no students, with zero counts and null rates", () => {
    const instructor = fx.addInstructor();
    const course = fx.addCourse({ instructorId: instructor.id });
    fx.addLessons(course.id, 3);

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.state).toBe("ready");
    expect(result.summary).toEqual({
      studentCount: 0,
      grossRevenue: 0,
      completionRate: null,
      averageQuizScore: null,
    });
    expect(result.courses).toEqual([
      expect.objectContaining({
        id: course.id,
        lessonCount: 3,
        studentCount: 0,
        grossRevenue: 0,
        completionRate: null,
      }),
    ]);
  });

  it("never includes another instructor's courses, students or revenue", () => {
    // base.course belongs to base.instructor
    const student = fx.addStudent();
    fx.addEnrollment(student.id, base.course.id, {
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    fx.addPurchase(student.id, base.course.id, 4999);

    const instructor = fx.addInstructor();
    const mine = fx.addCourse({ instructorId: instructor.id });

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.courses.map((c) => c.id)).toEqual([mine.id]);
    expect(result.summary).toEqual({
      studentCount: 0,
      grossRevenue: 0,
      completionRate: null,
      averageQuizScore: null,
    });
  });

  it("excludes drafts from the totals but keeps them in the course list", () => {
    const instructor = fx.addInstructor();
    const published = fx.addCourse({ instructorId: instructor.id });
    const archived = fx.addCourse({
      instructorId: instructor.id,
      status: schema.CourseStatus.Archived,
    });
    const draft = fx.addCourse({
      instructorId: instructor.id,
      status: schema.CourseStatus.Draft,
    });

    const a = fx.addStudent();
    const b = fx.addStudent();
    const c = fx.addStudent();
    fx.addEnrollment(a.id, published.id, {
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    fx.addPurchase(a.id, published.id, 1000);
    fx.addEnrollment(b.id, archived.id);
    fx.addPurchase(b.id, archived.id, 2000);
    fx.addEnrollment(c.id, draft.id, {
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    fx.addPurchase(c.id, draft.id, 50000);

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.state).toBe("ready");
    expect(result.summary).toEqual({
      studentCount: 2,
      grossRevenue: 3000,
      completionRate: 0.5,
      averageQuizScore: null,
    });
    expect(result.courses).toHaveLength(3);
    const draftEntry = result.courses.find((x) => x.id === draft.id)!;
    expect(draftEntry).toMatchObject({ studentCount: 1 });
    expect(draftEntry).not.toHaveProperty("grossRevenue");
    expect(draftEntry).not.toHaveProperty("completionRate");
    expect(result.courses.find((x) => x.id === archived.id)).toMatchObject({
      grossRevenue: 2000,
      completionRate: 0,
    });
  });

  it("counts a team purchase in full", () => {
    const instructor = fx.addInstructor();
    const course = fx.addCourse({ instructorId: instructor.id });
    const buyer = fx.addStudent();
    // One purchase row for 5 seats at $49.99
    fx.addPurchase(buyer.id, course.id, 24995);

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.summary.grossRevenue).toBe(24995);
    expect(result.courses[0]).toMatchObject({ grossRevenue: 24995 });
  });

  it("counts a regional-price purchase at the amount actually paid", () => {
    const instructor = fx.addInstructor();
    const course = fx.addCourse({
      instructorId: instructor.id,
      status: schema.CourseStatus.Published,
      price: 4999,
    });
    // Full price, and a purchasing-power-adjusted price
    fx.addPurchase(fx.addStudent().id, course.id, 4999);
    fx.addPurchase(fx.addStudent().id, course.id, 1500);

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.summary.grossRevenue).toBe(6499);
    expect(result.courses[0]).toMatchObject({ grossRevenue: 6499 });
  });

  it("pools the summary completion rate across enrollments instead of averaging course rates", () => {
    const instructor = fx.addInstructor();
    const big = fx.addCourse({ instructorId: instructor.id });
    const small = fx.addCourse({ instructorId: instructor.id });
    const done = "2026-01-01T00:00:00.000Z";

    // big: 1 of 4 completed (25%); small: 1 of 1 completed (100%)
    fx.addEnrollment(fx.addStudent().id, big.id, { completedAt: done });
    fx.addEnrollment(fx.addStudent().id, big.id);
    fx.addEnrollment(fx.addStudent().id, big.id);
    fx.addEnrollment(fx.addStudent().id, big.id);
    fx.addEnrollment(fx.addStudent().id, small.id, { completedAt: done });

    const result = getInstructorAnalytics(instructor.id, "all");

    expect(result.courses.find((c) => c.id === big.id)).toMatchObject({
      completionRate: 0.25,
    });
    expect(result.courses.find((c) => c.id === small.id)).toMatchObject({
      completionRate: 1,
    });
    // Pooled: 2 of 5 = 40%, not the 62.5% average of per-course rates
    expect(result.summary.completionRate).toBe(0.4);
  });
});
