import { and, asc, eq, gte, inArray, ne, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { db } from "~/db";
import {
  CourseStatus,
  courses,
  enrollments,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
} from "~/db/schema";
import {
  isActiveCourse,
  type ActiveCourseStatus,
  type AnalyticsRange,
} from "~/lib/analytics";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** ISO cutoff for `range`, or null for all time. Timestamps are stored as ISO strings. */
function rangeCutoff(range: AnalyticsRange): string | null {
  return range === "30d"
    ? new Date(Date.now() - THIRTY_DAYS_MS).toISOString()
    : null;
}

/** Filter on `column >= cutoff`, or no filter for all time. */
function onOrAfter(column: SQLiteColumn, cutoff: string | null) {
  return cutoff ? gte(column, cutoff) : undefined;
}

export type InstructorAnalyticsState = "no-courses" | "drafts-only" | "ready";

type CourseCardFields = {
  id: number;
  title: string;
  slug: string;
  description: string;
  coverImageUrl: string | null;
  lessonCount: number;
};

export type DraftCourseAnalytics = CourseCardFields & {
  status: CourseStatus.Draft;
  /** All-time enrollments — drafts ignore the range. */
  studentCount: number;
};

export type ActiveCourseAnalytics = CourseCardFields & {
  status: ActiveCourseStatus;
  /** Enrollments within the selected range. */
  studentCount: number;
  /** Integer cents, purchases within the selected range. */
  grossRevenue: number;
  /** All-time, 0–1, or null when there are no enrollments. */
  completionRate: number | null;
};

export type CourseAnalytics = DraftCourseAnalytics | ActiveCourseAnalytics;

export type InstructorAnalytics = {
  state: InstructorAnalyticsState;
  /** Totals across published and archived courses only. */
  summary: {
    /** Enrollments within the selected range. */
    studentCount: number;
    /** Integer cents, purchases within the selected range. */
    grossRevenue: number;
    /** All-time, pooled across all enrollments; null when there are none. */
    completionRate: number | null;
    /**
     * All-time, 0–1: mean of every student's best score on every quiz, pooled
     * (not an average of per-quiz averages). Null when there are no attempts.
     */
    averageQuizScore: number | null;
  };
  /** Every course the instructor owns, drafts included. */
  courses: CourseAnalytics[];
};

/** `part / whole`, or null when `whole` is 0 (nothing to measure). */
function ratioOrNull(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/** Lesson count per course, for courses matching `where` (over courses/modules). */
function getLessonCountsByCourse(where: SQL): Map<number, number> {
  return new Map(
    db
      .select({ courseId: modules.courseId, count: sql<number>`count(*)` })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(where)
      .groupBy(modules.courseId)
      .all()
      .map((row) => [row.courseId, row.count])
  );
}

type EnrollmentTotals = {
  /** All-time enrollments. */
  total: number;
  /** All-time enrollments with `completedAt` set. */
  completed: number;
  /** Enrollments on or after the cutoff (all of them with no cutoff). */
  inRange: number;
};

/** Enrollment totals per course, for courses matching `where` (over courses/enrollments). */
function getEnrollmentTotalsByCourse(
  where: SQL,
  cutoff: string | null
): Map<number, EnrollmentTotals> {
  return new Map(
    db
      .select({
        courseId: enrollments.courseId,
        total: sql<number>`count(*)`,
        completed: sql<number>`count(${enrollments.completedAt})`,
        inRange: cutoff
          ? sql<number>`count(case when ${enrollments.enrolledAt} >= ${cutoff} then 1 end)`
          : sql<number>`count(*)`,
      })
      .from(enrollments)
      .innerJoin(courses, eq(enrollments.courseId, courses.id))
      .where(where)
      .groupBy(enrollments.courseId)
      .all()
      .map(({ courseId, ...totals }) => [courseId, totals])
  );
}

/** Integer cents per course from purchases on or after the cutoff, for courses matching `where`. */
function getRevenueByCourse(
  where: SQL,
  cutoff: string | null
): Map<number, number> {
  return new Map(
    db
      .select({
        courseId: purchases.courseId,
        total: sql<number>`sum(${purchases.amountPaid})`,
      })
      .from(purchases)
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(and(where, onOrAfter(purchases.createdAt, cutoff)))
      .groupBy(purchases.courseId)
      .all()
      .map((row) => [row.courseId, row.total])
  );
}

type QuizStats = {
  id: number;
  title: string;
  passingScore: number;
  /**
   * Each enrolled student's best score per quiz. Ignores the stored `passed`
   * flag and attempts by users not enrolled in the quiz's course.
   */
  bestScores: number[];
  attemptCount: number;
};

/** Quizzes matching `where` (over quizzes/lessons/modules/courses), in course order. */
function getQuizStats(where: SQL | undefined): QuizStats[] {
  const quizRows = db
    .select({
      id: quizzes.id,
      title: quizzes.title,
      passingScore: quizzes.passingScore,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(where)
    .orderBy(asc(modules.position), asc(lessons.position), asc(quizzes.id))
    .all();
  if (quizRows.length === 0) return [];

  const perStudent = db
    .select({
      quizId: quizAttempts.quizId,
      best: sql<number>`max(${quizAttempts.score})`,
      attempts: sql<number>`count(*)`,
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizAttempts.quizId, quizzes.id))
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    // Only attempts by students enrolled in the quiz's course.
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, quizAttempts.userId),
        eq(enrollments.courseId, modules.courseId)
      )
    )
    .where(
      inArray(
        quizAttempts.quizId,
        quizRows.map((q) => q.id)
      )
    )
    .groupBy(quizAttempts.quizId, quizAttempts.userId)
    .all();

  const stats = new Map<number, QuizStats>(
    quizRows.map((q) => [q.id, { ...q, bestScores: [], attemptCount: 0 }])
  );
  for (const row of perStudent) {
    const quizStats = stats.get(row.quizId)!;
    quizStats.bestScores.push(row.best);
    quizStats.attemptCount += row.attempts;
  }
  return [...stats.values()];
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

export function getInstructorAnalytics(
  instructorId: number,
  range: AnalyticsRange
): InstructorAnalytics {
  const cutoff = rangeCutoff(range);
  const ownedByInstructor = eq(courses.instructorId, instructorId);
  const instructorCourses = db
    .select()
    .from(courses)
    .where(ownedByInstructor)
    .all();

  const lessonCounts = getLessonCountsByCourse(ownedByInstructor);
  const enrollmentTotals = getEnrollmentTotalsByCourse(
    ownedByInstructor,
    cutoff
  );
  const revenueByCourse = getRevenueByCourse(ownedByInstructor, cutoff);

  const courseEntries: CourseAnalytics[] = instructorCourses.map((course) => {
    const totals = enrollmentTotals.get(course.id);
    const cardFields: CourseCardFields = {
      id: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      coverImageUrl: course.coverImageUrl,
      lessonCount: lessonCounts.get(course.id) ?? 0,
    };

    if (!isActiveCourse(course)) {
      return {
        ...cardFields,
        status: CourseStatus.Draft,
        studentCount: totals?.total ?? 0,
      };
    }

    return {
      ...cardFields,
      status: course.status,
      studentCount: totals?.inRange ?? 0,
      grossRevenue: revenueByCourse.get(course.id) ?? 0,
      completionRate: ratioOrNull(totals?.completed ?? 0, totals?.total ?? 0),
    };
  });

  const activeEntries = courseEntries.filter(isActiveCourse);
  const activeTotals = activeEntries.map((c) => enrollmentTotals.get(c.id));
  const summary = {
    studentCount: sum(activeEntries.map((c) => c.studentCount)),
    grossRevenue: sum(activeEntries.map((c) => c.grossRevenue)),
    completionRate: ratioOrNull(
      sum(activeTotals.map((t) => t?.completed ?? 0)),
      sum(activeTotals.map((t) => t?.total ?? 0))
    ),
    averageQuizScore: mean(
      getQuizStats(
        and(ownedByInstructor, ne(courses.status, CourseStatus.Draft))
      ).flatMap((q) => q.bestScores)
    ),
  };

  const state: InstructorAnalyticsState =
    instructorCourses.length === 0
      ? "no-courses"
      : activeEntries.length === 0
        ? "drafts-only"
        : "ready";

  return { state, summary, courses: courseEntries };
}

/** Students and revenue follow the range; everything else is all-time. */
export type CourseAnalyticsDetail = {
  /** Enrollments within the selected range. */
  studentCount: number;
  /** Enrollments where that user has a purchase for this course. */
  paidStudentCount: number;
  /** Enrollments without a purchase row — redeemed team seats. */
  teamSeatStudentCount: number;
  /** Integer cents, purchases within the selected range. Team purchases count in full. */
  grossRevenue: number;
  /** All-time, 0–1, or null when there are no enrollments. */
  completionRate: number | null;
  /**
   * All-time, 0–1: mean across enrolled students of completed lessons ÷ lessons in the
   * course. Null when there are no enrollments or the course has no lessons.
   */
  averageProgress: number | null;
  /** All-time, one row per quiz in the course, in course order. */
  quizzes: QuizAnalytics[];
};

export type QuizAnalytics = {
  id: number;
  title: string;
  passingScore: number;
  /** 0–1: mean of each student's best attempt score; null with no attempts. */
  averageScore: number | null;
  /** 0–1: share of students whose best score >= passingScore; null with no attempts. */
  passRate: number | null;
  /** Every attempt, not just best ones. */
  attemptCount: number;
};

export function getCourseAnalytics(
  courseId: number,
  range: AnalyticsRange
): CourseAnalyticsDetail {
  const cutoff = rangeCutoff(range);
  const isThisCourse = eq(courses.id, courseId);

  // Students in range, split by whether they have a purchase for this course.
  const studentsInRange = db
    .select({
      count: sql<number>`count(distinct ${enrollments.id})`,
      paid: sql<number>`count(distinct ${purchases.userId})`,
    })
    .from(enrollments)
    .leftJoin(
      purchases,
      and(
        eq(purchases.userId, enrollments.userId),
        eq(purchases.courseId, enrollments.courseId)
      )
    )
    .where(
      and(
        eq(enrollments.courseId, courseId),
        onOrAfter(enrollments.enrolledAt, cutoff)
      )
    )
    .get();

  // Completion and progress are always all-time.
  const allTime = getEnrollmentTotalsByCourse(isThisCourse, null).get(courseId);
  const grossRevenue =
    getRevenueByCourse(isThisCourse, cutoff).get(courseId) ?? 0;
  const lessonCount = getLessonCountsByCourse(isThisCourse).get(courseId) ?? 0;

  // Completed (student, lesson) pairs, counting only enrolled students.
  const completedLessons =
    db
      .select({
        count: sql<number>`count(distinct ${lessonProgress.userId} || '-' || ${lessonProgress.lessonId})`,
      })
      .from(lessonProgress)
      .innerJoin(lessons, eq(lessonProgress.lessonId, lessons.id))
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(
        enrollments,
        and(
          eq(enrollments.userId, lessonProgress.userId),
          eq(enrollments.courseId, modules.courseId)
        )
      )
      .where(
        and(
          eq(modules.courseId, courseId),
          eq(lessonProgress.status, LessonProgressStatus.Completed)
        )
      )
      .get()?.count ?? 0;

  const studentCount = studentsInRange?.count ?? 0;
  const paidStudentCount = studentsInRange?.paid ?? 0;
  const allTimeStudents = allTime?.total ?? 0;

  return {
    studentCount,
    paidStudentCount,
    teamSeatStudentCount: studentCount - paidStudentCount,
    grossRevenue,
    completionRate: ratioOrNull(allTime?.completed ?? 0, allTimeStudents),
    averageProgress: ratioOrNull(
      completedLessons,
      allTimeStudents * lessonCount
    ),
    quizzes: getQuizStats(eq(modules.courseId, courseId)).map((q) => ({
      id: q.id,
      title: q.title,
      passingScore: q.passingScore,
      averageScore: mean(q.bestScores),
      passRate: ratioOrNull(
        q.bestScores.filter((score) => score >= q.passingScore).length,
        q.bestScores.length
      ),
      attemptCount: q.attemptCount,
    })),
  };
}
