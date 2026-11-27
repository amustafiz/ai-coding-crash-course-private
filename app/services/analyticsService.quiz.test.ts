import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getCourseAnalytics, getInstructorAnalytics } from "./analyticsService";

let counter = 0;

function addStudent() {
  counter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Student ${counter}`,
      email: `student${counter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function addQuiz(courseId: number, title: string, passingScore: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: `Lesson for ${title}`, position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title, passingScore })
    .returning()
    .get();
}

function addAttempt(
  userId: number,
  quizId: number,
  score: number,
  attemptedAt: string,
  passed = score >= 0.7
) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed, attemptedAt })
    .run();
}

describe("quiz analytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("uses each student's best attempt, even when it isn't their latest", () => {
    const quiz = addQuiz(base.course.id, "Basics", 0.7);
    const alice = addStudent();
    const bob = addStudent();

    // Alice: best 0.9 came first, latest is 0.4
    addAttempt(alice.id, quiz.id, 0.9, "2026-01-01T00:00:00.000Z");
    addAttempt(alice.id, quiz.id, 0.4, "2026-01-02T00:00:00.000Z");
    // Bob: a single failing attempt
    addAttempt(bob.id, quiz.id, 0.5, "2026-01-01T00:00:00.000Z");

    const [row] = getCourseAnalytics(base.course.id, "all").quizzes;

    expect(row.title).toBe("Basics");
    expect(row.averageScore).toBeCloseTo(0.7); // (0.9 + 0.5) / 2
    expect(row.passRate).toBeCloseTo(0.5); // Alice passes on her best
  });

  it("recomputes pass status from passingScore, ignoring the stored passed flag", () => {
    const quiz = addQuiz(base.course.id, "Middleware Check", 0.6);
    const student = addStudent();
    // Stored as failed by the old hardcoded 0.7 threshold
    addAttempt(student.id, quiz.id, 0.65, "2026-01-01T00:00:00.000Z", false);

    const [row] = getCourseAnalytics(base.course.id, "all").quizzes;

    expect(row.passRate).toBe(1);
  });

  it("counts every attempt, not just best ones", () => {
    const quiz = addQuiz(base.course.id, "Basics", 0.7);
    const alice = addStudent();
    const bob = addStudent();
    addAttempt(alice.id, quiz.id, 0.2, "2026-01-01T00:00:00.000Z");
    addAttempt(alice.id, quiz.id, 0.5, "2026-01-02T00:00:00.000Z");
    addAttempt(alice.id, quiz.id, 0.8, "2026-01-03T00:00:00.000Z");
    addAttempt(bob.id, quiz.id, 1, "2026-01-01T00:00:00.000Z");

    const [row] = getCourseAnalytics(base.course.id, "all").quizzes;

    expect(row.attemptCount).toBe(4);
  });

  it("returns null average and pass rate for a quiz with no attempts", () => {
    addQuiz(base.course.id, "Untouched", 0.7);

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
      const popular = addQuiz(base.course.id, "Popular", 0.7);
      const niche = addQuiz(base.course.id, "Niche", 0.7);
      const [a, b, c, d] = [
        addStudent(),
        addStudent(),
        addStudent(),
        addStudent(),
      ];
      addAttempt(a.id, popular.id, 1, "2026-01-01T00:00:00.000Z");
      addAttempt(b.id, popular.id, 1, "2026-01-01T00:00:00.000Z");
      addAttempt(c.id, popular.id, 0.4, "2026-01-01T00:00:00.000Z");
      addAttempt(c.id, popular.id, 1, "2026-01-02T00:00:00.000Z");
      addAttempt(d.id, niche.id, 0, "2026-01-01T00:00:00.000Z");

      const { summary } = getInstructorAnalytics(base.instructor.id, "all");

      // Pooled: (1 + 1 + 1 + 0) / 4 = 0.75; per-quiz averages would give 0.5
      expect(summary.averageQuizScore).toBeCloseTo(0.75);
    });

    it("excludes draft courses", () => {
      const draft = testDb
        .insert(schema.courses)
        .values({
          title: "Draft",
          slug: "draft",
          description: "d",
          salesCopy: "s",
          instructorId: base.instructor.id,
          categoryId: base.category.id,
          status: schema.CourseStatus.Draft,
        })
        .returning()
        .get();
      const live = addQuiz(base.course.id, "Live", 0.7);
      const hidden = addQuiz(draft.id, "Hidden", 0.7);
      const student = addStudent();
      addAttempt(student.id, live.id, 0.8, "2026-01-01T00:00:00.000Z");
      addAttempt(student.id, hidden.id, 0, "2026-01-01T00:00:00.000Z");

      const { summary } = getInstructorAnalytics(base.instructor.id, "all");

      expect(summary.averageQuizScore).toBeCloseTo(0.8);
    });

    it("is null when there are no attempts", () => {
      addQuiz(base.course.id, "Untouched", 0.7);

      const { summary } = getInstructorAnalytics(base.instructor.id, "all");

      expect(summary.averageQuizScore).toBeNull();
    });
  });
});
