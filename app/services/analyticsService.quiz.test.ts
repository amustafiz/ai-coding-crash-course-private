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

import { getCourseAnalytics, getInstructorAnalytics } from "./analyticsService";

/** A student enrolled in each of `courseIds` (default: the base course). */
function addEnrolledStudent(...courseIds: number[]) {
  const student = fx.addStudent();
  for (const courseId of courseIds.length ? courseIds : [base.course.id]) {
    fx.addEnrollment(student.id, courseId);
  }
  return student;
}

describe("quiz analytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
    fx = createAnalyticsFixtures(testDb, base);
  });

  it("uses each student's best attempt, even when it isn't their latest", () => {
    const quiz = fx.addQuiz(base.course.id, "Basics", 0.7);
    const alice = addEnrolledStudent();
    const bob = addEnrolledStudent();

    // Alice: best 0.9 came first, latest is 0.4
    fx.addAttempt(alice.id, quiz.id, 0.9, "2026-01-01T00:00:00.000Z");
    fx.addAttempt(alice.id, quiz.id, 0.4, "2026-01-02T00:00:00.000Z");
    // Bob: a single failing attempt
    fx.addAttempt(bob.id, quiz.id, 0.5, "2026-01-01T00:00:00.000Z");

    const [row] = getCourseAnalytics(base.course.id, "all").quizzes;

    expect(row.title).toBe("Basics");
    expect(row.averageScore).toBeCloseTo(0.7); // (0.9 + 0.5) / 2
    expect(row.passRate).toBeCloseTo(0.5); // Alice passes on her best
  });

  it("recomputes pass status from passingScore, ignoring the stored passed flag", () => {
    const quiz = fx.addQuiz(base.course.id, "Middleware Check", 0.6);
    const student = addEnrolledStudent();
    // Stored as failed by the old hardcoded 0.7 threshold
    fx.addAttempt(student.id, quiz.id, 0.65, "2026-01-01T00:00:00.000Z", false);

    const [row] = getCourseAnalytics(base.course.id, "all").quizzes;

    expect(row.passRate).toBe(1);
  });

  it("counts every attempt, not just best ones", () => {
    const quiz = fx.addQuiz(base.course.id, "Basics", 0.7);
    const alice = addEnrolledStudent();
    const bob = addEnrolledStudent();
    fx.addAttempt(alice.id, quiz.id, 0.2, "2026-01-01T00:00:00.000Z");
    fx.addAttempt(alice.id, quiz.id, 0.5, "2026-01-02T00:00:00.000Z");
    fx.addAttempt(alice.id, quiz.id, 0.8, "2026-01-03T00:00:00.000Z");
    fx.addAttempt(bob.id, quiz.id, 1, "2026-01-01T00:00:00.000Z");

    const [row] = getCourseAnalytics(base.course.id, "all").quizzes;

    expect(row.attemptCount).toBe(4);
  });

  it("ignores attempts by users not enrolled in the quiz's course", () => {
    const quiz = fx.addQuiz(base.course.id, "Basics", 0.7);
    const enrolled = addEnrolledStudent();
    const outsider = fx.addStudent();
    fx.addAttempt(enrolled.id, quiz.id, 0.8, "2026-01-01T00:00:00.000Z");
    fx.addAttempt(outsider.id, quiz.id, 0.2, "2026-01-01T00:00:00.000Z");
    fx.addAttempt(outsider.id, quiz.id, 0.3, "2026-01-02T00:00:00.000Z");

    const [row] = getCourseAnalytics(base.course.id, "all").quizzes;
    const { summary } = getInstructorAnalytics(base.instructor.id, "all");

    expect(row).toMatchObject({
      averageScore: 0.8,
      passRate: 1,
      attemptCount: 1,
    });
    expect(summary.averageQuizScore).toBeCloseTo(0.8);
  });

  it("returns null average and pass rate for a quiz with no attempts", () => {
    fx.addQuiz(base.course.id, "Untouched", 0.7);

    const quizzes = getCourseAnalytics(base.course.id, "all").quizzes;

    expect(quizzes).toEqual([
      expect.objectContaining({
        title: "Untouched",
        averageScore: null,
        passRate: null,
        attemptCount: 0,
      }),
    ]);
  });

  it("returns an empty list for a course with no quizzes", () => {
    expect(getCourseAnalytics(base.course.id, "all").quizzes).toEqual([]);
  });

  describe("dashboard average quiz score", () => {
    it("pools best attempts across quizzes rather than averaging per-quiz averages", () => {
      const popular = fx.addQuiz(base.course.id, "Popular", 0.7);
      const niche = fx.addQuiz(base.course.id, "Niche", 0.7);
      const [a, b, c, d] = [
        addEnrolledStudent(),
        addEnrolledStudent(),
        addEnrolledStudent(),
        addEnrolledStudent(),
      ];
      fx.addAttempt(a.id, popular.id, 1, "2026-01-01T00:00:00.000Z");
      fx.addAttempt(b.id, popular.id, 1, "2026-01-01T00:00:00.000Z");
      fx.addAttempt(c.id, popular.id, 0.4, "2026-01-01T00:00:00.000Z");
      fx.addAttempt(c.id, popular.id, 1, "2026-01-02T00:00:00.000Z");
      fx.addAttempt(d.id, niche.id, 0, "2026-01-01T00:00:00.000Z");

      const { summary } = getInstructorAnalytics(base.instructor.id, "all");

      // Pooled: (1 + 1 + 1 + 0) / 4 = 0.75; per-quiz averages would give 0.5
      expect(summary.averageQuizScore).toBeCloseTo(0.75);
    });

    it("excludes draft courses", () => {
      const draft = fx.addCourse({ status: schema.CourseStatus.Draft });
      const live = fx.addQuiz(base.course.id, "Live", 0.7);
      const hidden = fx.addQuiz(draft.id, "Hidden", 0.7);
      const student = addEnrolledStudent(base.course.id, draft.id);
      fx.addAttempt(student.id, live.id, 0.8, "2026-01-01T00:00:00.000Z");
      fx.addAttempt(student.id, hidden.id, 0, "2026-01-01T00:00:00.000Z");

      const { summary } = getInstructorAnalytics(base.instructor.id, "all");

      expect(summary.averageQuizScore).toBeCloseTo(0.8);
    });

    it("is null when there are no attempts", () => {
      fx.addQuiz(base.course.id, "Untouched", 0.7);

      const { summary } = getInstructorAnalytics(base.instructor.id, "all");

      expect(summary.averageQuizScore).toBeNull();
    });
  });
});
