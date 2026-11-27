import { describe, it, expect, beforeEach, vi } from "vitest";
import { createAnalyticsFixtures } from "~/test/analyticsFixtures";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;
let fx: ReturnType<typeof createAnalyticsFixtures>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getCourseAnalytics } from "./analyticsService";

describe("getCourseAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    fx = createAnalyticsFixtures(testDb, base);
  });

  it("splits students into paid and team-seat, counting a team purchase in full", () => {
    const course = fx.addCourse();
    const soloBuyer = fx.addStudent();
    const teamBuyer = fx.addStudent();
    const seatHolder1 = fx.addStudent();
    const seatHolder2 = fx.addStudent();

    fx.addPurchase(soloBuyer.id, course.id, 4999);
    fx.addEnrollment(soloBuyer.id, course.id);
    // Team buyer bought 3 seats: took one, two more redeemed via coupons
    fx.addPurchase(teamBuyer.id, course.id, 14997);
    fx.addEnrollment(teamBuyer.id, course.id);
    fx.addEnrollment(seatHolder1.id, course.id);
    fx.addEnrollment(seatHolder2.id, course.id);

    // A purchase of a different course doesn't make someone "paid" here
    const other = fx.addCourse();
    fx.addPurchase(seatHolder1.id, other.id, 1000);

    const result = getCourseAnalytics(course.id, "all");

    expect(result).toMatchObject({
      studentCount: 4,
      paidStudentCount: 2,
      teamSeatStudentCount: 2,
      grossRevenue: 19996,
    });
  });

  it("reports completion rate and average progress independently", () => {
    const course = fx.addCourse();
    const lessons = fx.addLessons(course.id, 4);
    const done = "2026-01-01T00:00:00.000Z";

    // Finished: all 4 lessons, completed timestamp set
    const finisher = fx.addStudent();
    fx.addEnrollment(finisher.id, course.id, { completedAt: done });
    lessons.forEach((l) => fx.completeLesson(finisher.id, l.id));

    // Halfway: 2 of 4 lessons, not completed
    const halfway = fx.addStudent();
    fx.addEnrollment(halfway.id, course.id);
    fx.completeLesson(halfway.id, lessons[0].id);
    fx.completeLesson(halfway.id, lessons[1].id);

    // Just started: 0 of 4, plus a started-but-unfinished lesson
    const starter = fx.addStudent();
    fx.addEnrollment(starter.id, course.id);
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: starter.id,
        lessonId: lessons[2].id,
        status: schema.LessonProgressStatus.InProgress,
      })
      .run();

    // Not enrolled, but completed a lesson in this course — ignored
    fx.completeLesson(fx.addStudent().id, lessons[0].id);

    // Halfway student's progress in another course doesn't leak in
    const other = fx.addCourse();
    const [otherLesson] = fx.addLessons(other.id, 1);
    fx.completeLesson(halfway.id, otherLesson.id);

    const result = getCourseAnalytics(course.id, "all");

    // 1 of 3 completed; progress mean of 1, 0.5, 0 = 0.5
    expect(result.completionRate).toBeCloseTo(1 / 3);
    expect(result.averageProgress).toBe(0.5);
  });

  it("returns zero counts and null rates for a course with no students", () => {
    const course = fx.addCourse();
    fx.addLessons(course.id, 3);

    expect(getCourseAnalytics(course.id, "all")).toEqual({
      studentCount: 0,
      paidStudentCount: 0,
      teamSeatStudentCount: 0,
      grossRevenue: 0,
      completionRate: null,
      averageProgress: null,
      quizzes: [],
    });
  });

  it("returns null average progress for a course with students but no lessons", () => {
    const course = fx.addCourse();
    fx.addEnrollment(fx.addStudent().id, course.id, {
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    fx.addEnrollment(fx.addStudent().id, course.id);

    const result = getCourseAnalytics(course.id, "all");

    expect(result.studentCount).toBe(2);
    expect(result.completionRate).toBe(0.5);
    expect(result.averageProgress).toBeNull();
  });
});
