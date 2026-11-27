import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

import { getCourseAnalytics, getInstructorAnalytics } from "./analyticsService";

const NOW = "2026-06-30T12:00:00.000Z";
// Exactly 30 × 24h before NOW — inclusive boundary.
const CUTOFF = "2026-05-31T12:00:00.000Z";
const JUST_OUTSIDE = "2026-05-31T11:59:59.999Z";
const RECENT = "2026-06-20T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

function addQuizWithAttempts(lessonId: number, scores: [number, number][]) {
  const quiz = testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
  for (const [userId, score] of scores) {
    fx.addAttempt(userId, quiz.id, score, OLD);
  }
  return quiz;
}

/**
 * A course with: a recent paid student (who completed every lesson), a
 * team-seat student enrolled exactly at the cutoff, a paid student just
 * outside it, and an old team-seat student halfway through.
 */
function seedCourseAcrossCutoff() {
  const course = fx.addCourse();
  const lessons = fx.addLessons(course.id, 2);

  const recentBuyer = fx.addStudent();
  fx.addPurchase(recentBuyer.id, course.id, 5000, RECENT);
  fx.addEnrollment(recentBuyer.id, course.id, {
    enrolledAt: RECENT,
    completedAt: RECENT,
  });
  lessons.forEach((l) => fx.completeLesson(recentBuyer.id, l.id));

  const atCutoffSeat = fx.addStudent();
  fx.addEnrollment(atCutoffSeat.id, course.id, { enrolledAt: CUTOFF });

  const outsideBuyer = fx.addStudent();
  fx.addPurchase(outsideBuyer.id, course.id, 3000, JUST_OUTSIDE);
  fx.addEnrollment(outsideBuyer.id, course.id, { enrolledAt: JUST_OUTSIDE });

  const oldSeat = fx.addStudent();
  fx.addEnrollment(oldSeat.id, course.id, { enrolledAt: OLD });
  fx.completeLesson(oldSeat.id, lessons[0].id);

  // Purchase at exactly the cutoff, from someone not (yet) enrolled
  fx.addPurchase(fx.addStudent().id, course.id, 700, CUTOFF);

  addQuizWithAttempts(lessons[0].id, [
    [recentBuyer.id, 0.9],
    [oldSeat.id, 0.5],
  ]);

  return course;
}

describe("time range", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    testDb = createTestDb();
    base = seedBaseData(testDb);
    fx = createAnalyticsFixtures(testDb, base);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getCourseAnalytics", () => {
    it("counts students and revenue on or after the rolling 30-day cutoff", () => {
      const course = seedCourseAcrossCutoff();

      expect(getCourseAnalytics(course.id, "all")).toMatchObject({
        studentCount: 4,
        paidStudentCount: 2,
        teamSeatStudentCount: 2,
        grossRevenue: 8700,
      });
      expect(getCourseAnalytics(course.id, "30d")).toMatchObject({
        studentCount: 2,
        paidStudentCount: 1,
        teamSeatStudentCount: 1,
        grossRevenue: 5700,
      });
    });

    it("keeps completion rate, average progress and quiz figures all-time", () => {
      const course = seedCourseAcrossCutoff();

      // All-time: 1 of 4 completed; progress (2 + 0 + 0 + 1) / (4 × 2)
      const expected = {
        completionRate: 0.25,
        averageProgress: 3 / 8,
        quizzes: [
          expect.objectContaining({
            averageScore: 0.7,
            passRate: 0.5,
            attemptCount: 2,
          }),
        ],
      };
      expect(getCourseAnalytics(course.id, "all")).toMatchObject(expected);
      expect(getCourseAnalytics(course.id, "30d")).toMatchObject(expected);
    });
  });

  describe("getInstructorAnalytics", () => {
    function seedDashboard() {
      const published = seedCourseAcrossCutoff();
      const archived = fx.addCourse({ status: schema.CourseStatus.Archived });
      const s1 = fx.addStudent();
      fx.addPurchase(s1.id, archived.id, 1000, OLD);
      fx.addEnrollment(s1.id, archived.id, {
        enrolledAt: OLD,
        completedAt: OLD,
      });
      const s2 = fx.addStudent();
      fx.addPurchase(s2.id, archived.id, 2000, CUTOFF);
      fx.addEnrollment(s2.id, archived.id, { enrolledAt: CUTOFF });
      fx.addLessons(archived.id, 3);
      return { published, archived };
    }

    it("filters summary and per-course students and revenue by range", () => {
      const { published, archived } = seedDashboard();

      const all = getInstructorAnalytics(base.instructor.id, "all");
      const recent = getInstructorAnalytics(base.instructor.id, "30d");

      expect(all.summary).toMatchObject({
        studentCount: 6,
        grossRevenue: 11700,
      });
      expect(recent.summary).toMatchObject({
        studentCount: 3,
        grossRevenue: 7700,
      });

      const card = (r: typeof all, id: number) =>
        r.courses.find((c) => c.id === id);
      expect(card(all, published.id)).toMatchObject({
        studentCount: 4,
        grossRevenue: 8700,
        lessonCount: 2,
      });
      expect(card(recent, published.id)).toMatchObject({
        studentCount: 2,
        grossRevenue: 5700,
        lessonCount: 2,
      });
      expect(card(all, archived.id)).toMatchObject({
        studentCount: 2,
        grossRevenue: 3000,
        lessonCount: 3,
      });
      expect(card(recent, archived.id)).toMatchObject({
        studentCount: 1,
        grossRevenue: 2000,
        lessonCount: 3,
      });
    });

    it("keeps a draft course's student count all-time, ignoring the range", () => {
      const draft = fx.addCourse({ status: schema.CourseStatus.Draft });
      fx.addEnrollment(fx.addStudent().id, draft.id, { enrolledAt: OLD });
      fx.addEnrollment(fx.addStudent().id, draft.id, { enrolledAt: RECENT });

      const recent = getInstructorAnalytics(base.instructor.id, "30d");

      expect(recent.courses.find((c) => c.id === draft.id)).toMatchObject({
        studentCount: 2,
      });
    });

    it("keeps completion rates and average quiz score all-time", () => {
      const { published, archived } = seedDashboard();

      const all = getInstructorAnalytics(base.instructor.id, "all");
      const recent = getInstructorAnalytics(base.instructor.id, "30d");

      for (const r of [all, recent]) {
        // 2 of 6 enrollments completed; best scores 0.9 and 0.5
        expect(r.summary.completionRate).toBeCloseTo(2 / 6);
        expect(r.summary.averageQuizScore).toBeCloseTo(0.7);
        expect(r.courses.find((c) => c.id === published.id)).toMatchObject({
          completionRate: 0.25,
        });
        expect(r.courses.find((c) => c.id === archived.id)).toMatchObject({
          completionRate: 0.5,
        });
      }
    });
  });
});
