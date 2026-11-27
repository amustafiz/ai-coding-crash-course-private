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

import { getInstructorAnalytics } from "./analyticsService";

let counter = 0;

function addInstructor() {
  counter++;
  return testDb
    .insert(schema.users)
    .values({
      name: `Instructor ${counter}`,
      email: `instructor${counter}@example.com`,
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
}

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

function addCourse(
  instructorId: number,
  status: schema.CourseStatus = schema.CourseStatus.Published,
  price = 0
) {
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
  for (let i = 0; i < count; i++) {
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i}`, position: i + 1 })
      .run();
  }
}

describe("getInstructorAnalytics (dashboard)", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("reports the no-courses state for an instructor without courses", () => {
    const instructor = addInstructor();

    const result = getInstructorAnalytics(instructor.id);

    expect(result.state).toBe("no-courses");
    expect(result.courses).toEqual([]);
  });

  it("reports the drafts-only state and still lists the draft courses", () => {
    const instructor = addInstructor();
    const draft = addCourse(instructor.id, schema.CourseStatus.Draft);
    addEnrollment(addStudent().id, draft.id);

    const result = getInstructorAnalytics(instructor.id);

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
    const instructor = addInstructor();
    const course = addCourse(instructor.id);
    addLessons(course.id, 3);

    const result = getInstructorAnalytics(instructor.id);

    expect(result.state).toBe("ready");
    expect(result.summary).toEqual({
      studentCount: 0,
      grossRevenue: 0,
      completionRate: null,
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
    const student = addStudent();
    addEnrollment(student.id, base.course.id, "2026-01-01T00:00:00.000Z");
    addPurchase(student.id, base.course.id, 4999);

    const instructor = addInstructor();
    const mine = addCourse(instructor.id);

    const result = getInstructorAnalytics(instructor.id);

    expect(result.courses.map((c) => c.id)).toEqual([mine.id]);
    expect(result.summary).toEqual({
      studentCount: 0,
      grossRevenue: 0,
      completionRate: null,
    });
  });

  it("excludes drafts from the totals but keeps them in the course list", () => {
    const instructor = addInstructor();
    const published = addCourse(instructor.id);
    const archived = addCourse(instructor.id, schema.CourseStatus.Archived);
    const draft = addCourse(instructor.id, schema.CourseStatus.Draft);

    const a = addStudent();
    const b = addStudent();
    const c = addStudent();
    addEnrollment(a.id, published.id, "2026-01-01T00:00:00.000Z");
    addPurchase(a.id, published.id, 1000);
    addEnrollment(b.id, archived.id);
    addPurchase(b.id, archived.id, 2000);
    addEnrollment(c.id, draft.id, "2026-01-01T00:00:00.000Z");
    addPurchase(c.id, draft.id, 50000);

    const result = getInstructorAnalytics(instructor.id);

    expect(result.state).toBe("ready");
    expect(result.summary).toEqual({
      studentCount: 2,
      grossRevenue: 3000,
      completionRate: 0.5,
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
    const instructor = addInstructor();
    const course = addCourse(instructor.id);
    const buyer = addStudent();
    // One purchase row for 5 seats at $49.99
    addPurchase(buyer.id, course.id, 24995);

    const result = getInstructorAnalytics(instructor.id);

    expect(result.summary.grossRevenue).toBe(24995);
    expect(result.courses[0]).toMatchObject({ grossRevenue: 24995 });
  });

  it("counts a regional-price purchase at the amount actually paid", () => {
    const instructor = addInstructor();
    const course = addCourse(
      instructor.id,
      schema.CourseStatus.Published,
      4999
    );
    // Full price, and a purchasing-power-adjusted price
    addPurchase(addStudent().id, course.id, 4999);
    addPurchase(addStudent().id, course.id, 1500);

    const result = getInstructorAnalytics(instructor.id);

    expect(result.summary.grossRevenue).toBe(6499);
    expect(result.courses[0]).toMatchObject({ grossRevenue: 6499 });
  });

  it("pools the summary completion rate across enrollments instead of averaging course rates", () => {
    const instructor = addInstructor();
    const big = addCourse(instructor.id);
    const small = addCourse(instructor.id);
    const done = "2026-01-01T00:00:00.000Z";

    // big: 1 of 4 completed (25%); small: 1 of 1 completed (100%)
    addEnrollment(addStudent().id, big.id, done);
    addEnrollment(addStudent().id, big.id);
    addEnrollment(addStudent().id, big.id);
    addEnrollment(addStudent().id, big.id);
    addEnrollment(addStudent().id, small.id, done);

    const result = getInstructorAnalytics(instructor.id);

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
