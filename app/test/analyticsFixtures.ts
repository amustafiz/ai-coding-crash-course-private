import * as schema from "~/db/schema";
import type { createTestDb, seedBaseData } from "~/test/setup";

const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

let counter = 0;

/**
 * Row builders for the analytics service tests. Bind them to the test database
 * and base data created in `beforeEach`; each insert gets a unique name/slug.
 */
export function createAnalyticsFixtures(
  testDb: ReturnType<typeof createTestDb>,
  base: ReturnType<typeof seedBaseData>
) {
  function addUser(role: schema.UserRole, label: string) {
    counter++;
    return testDb
      .insert(schema.users)
      .values({
        name: `${label} ${counter}`,
        email: `${label.toLowerCase()}${counter}@example.com`,
        role,
      })
      .returning()
      .get();
  }

  function addCourse({
    instructorId = base.instructor.id,
    status = schema.CourseStatus.Published,
    price = 0,
  }: {
    instructorId?: number;
    status?: schema.CourseStatus;
    price?: number;
  } = {}) {
    counter++;
    return testDb
      .insert(schema.courses)
      .values({
        title: `Course ${counter}`,
        slug: `course-${counter}`,
        description: "d",
        salesCopy: "s",
        instructorId,
        categoryId: base.category.id,
        status,
        price,
      })
      .returning()
      .get();
  }

  function addEnrollment(
    userId: number,
    courseId: number,
    {
      enrolledAt,
      completedAt = null,
    }: { enrolledAt?: string; completedAt?: string | null } = {}
  ) {
    return testDb
      .insert(schema.enrollments)
      .values({ userId, courseId, enrolledAt, completedAt })
      .returning()
      .get();
  }

  function addPurchase(
    userId: number,
    courseId: number,
    amountPaid: number,
    createdAt?: string
  ) {
    return testDb
      .insert(schema.purchases)
      .values({ userId, courseId, amountPaid, country: null, createdAt })
      .returning()
      .get();
  }

  /** One module holding `count` lessons. */
  function addLessons(courseId: number, count: number) {
    const mod = testDb
      .insert(schema.modules)
      .values({ courseId, title: "Module", position: 1 })
      .returning()
      .get();
    return Array.from({ length: count }, (_, i) =>
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${i}`, position: i + 1 })
        .returning()
        .get()
    );
  }

  function completeLesson(
    userId: number,
    lessonId: number,
    completedAt = DEFAULT_TIMESTAMP
  ) {
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId,
        lessonId,
        status: schema.LessonProgressStatus.Completed,
        completedAt,
      })
      .run();
  }

  /** A quiz on a new lesson in a new module of `courseId`. */
  function addQuiz(courseId: number, title = "Quiz", passingScore = 0.7) {
    const [lesson] = addLessons(courseId, 1);
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
    attemptedAt = DEFAULT_TIMESTAMP,
    passed = score >= 0.7
  ) {
    testDb
      .insert(schema.quizAttempts)
      .values({ userId, quizId, score, passed, attemptedAt })
      .run();
  }

  return {
    addInstructor: () => addUser(schema.UserRole.Instructor, "Instructor"),
    addStudent: () => addUser(schema.UserRole.Student, "Student"),
    addCourse,
    addEnrollment,
    addPurchase,
    addLessons,
    completeLesson,
    addQuiz,
    addAttempt,
  };
}
