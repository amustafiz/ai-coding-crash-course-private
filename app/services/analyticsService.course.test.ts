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

import { getCourseAnalytics } from "./analyticsService";

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

function addCourse() {
  counter++;
  return testDb
    .insert(schema.courses)
    .values({
      title: `Course ${counter}`,
      slug: `course-${counter}`,
      description: "d",
      salesCopy: "s",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

function addEnrollment(
  userId: number,
  courseId: number,
  completedAt: string | null = null
) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, completedAt })
    .returning()
    .get();
}

function addPurchase(userId: number, courseId: number, amountPaid: number) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, country: null })
    .returning()
    .get();
}

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

function completeLesson(userId: number, lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
}

describe("getCourseAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("splits students into paid and team-seat, counting a team purchase in full", () => {
    const course = addCourse();
    const soloBuyer = addStudent();
    const teamBuyer = addStudent();
    const seatHolder1 = addStudent();
    const seatHolder2 = addStudent();

    addPurchase(soloBuyer.id, course.id, 4999);
    addEnrollment(soloBuyer.id, course.id);
    // Team buyer bought 3 seats: took one, two more redeemed via coupons
    addPurchase(teamBuyer.id, course.id, 14997);
    addEnrollment(teamBuyer.id, course.id);
    addEnrollment(seatHolder1.id, course.id);
    addEnrollment(seatHolder2.id, course.id);

    // A purchase of a different course doesn't make someone "paid" here
    const other = addCourse();
    addPurchase(seatHolder1.id, other.id, 1000);

    const result = getCourseAnalytics(course.id);

    expect(result).toMatchObject({
      studentCount: 4,
      paidStudentCount: 2,
      teamSeatStudentCount: 2,
      grossRevenue: 19996,
    });
  });

  it("reports completion rate and average progress independently", () => {
    const course = addCourse();
    const lessons = addLessons(course.id, 4);
    const done = "2026-01-01T00:00:00.000Z";

    // Finished: all 4 lessons, completed timestamp set
    const finisher = addStudent();
    addEnrollment(finisher.id, course.id, done);
    lessons.forEach((l) => completeLesson(finisher.id, l.id));

    // Halfway: 2 of 4 lessons, not completed
    const halfway = addStudent();
    addEnrollment(halfway.id, course.id);
    completeLesson(halfway.id, lessons[0].id);
    completeLesson(halfway.id, lessons[1].id);

    // Just started: 0 of 4, plus a started-but-unfinished lesson
    const starter = addStudent();
    addEnrollment(starter.id, course.id);
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: starter.id,
        lessonId: lessons[2].id,
        status: schema.LessonProgressStatus.InProgress,
      })
      .run();

    // Not enrolled, but completed a lesson in this course — ignored
    completeLesson(addStudent().id, lessons[0].id);

    // Halfway student's progress in another course doesn't leak in
    const other = addCourse();
    const [otherLesson] = addLessons(other.id, 1);
    completeLesson(halfway.id, otherLesson.id);

    const result = getCourseAnalytics(course.id);

    // 1 of 3 completed; progress mean of 1, 0.5, 0 = 0.5
    expect(result.completionRate).toBeCloseTo(1 / 3);
    expect(result.averageProgress).toBe(0.5);
  });

  it("returns zero counts and null rates for a course with no students", () => {
    const course = addCourse();
    addLessons(course.id, 3);

    expect(getCourseAnalytics(course.id)).toEqual({
      studentCount: 0,
      paidStudentCount: 0,
      teamSeatStudentCount: 0,
      grossRevenue: 0,
      completionRate: null,
      averageProgress: null,
    });
  });

  it("returns null average progress for a course with students but no lessons", () => {
    const course = addCourse();
    addEnrollment(addStudent().id, course.id, "2026-01-01T00:00:00.000Z");
    addEnrollment(addStudent().id, course.id);

    const result = getCourseAnalytics(course.id);

    expect(result.studentCount).toBe(2);
    expect(result.completionRate).toBe(0.5);
    expect(result.averageProgress).toBeNull();
  });
});
