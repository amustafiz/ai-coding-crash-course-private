import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
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

export type InstructorAnalyticsState = "no-courses" | "drafts-only" | "ready";

type CourseBase = {
  id: number;
  title: string;
  slug: string;
  description: string;
  coverImageUrl: string | null;
  lessonCount: number;
  studentCount: number;
};

export type DraftCourseAnalytics = CourseBase & {
  status: CourseStatus.Draft;
};

export type ActiveCourseAnalytics = CourseBase & {
  status: CourseStatus.Published | CourseStatus.Archived;
  /** Integer cents. */
  grossRevenue: number;
  /** 0–1, or null when there are no enrollments. */
  completionRate: number | null;
};

export type CourseAnalytics = DraftCourseAnalytics | ActiveCourseAnalytics;

export type InstructorAnalytics = {
  state: InstructorAnalyticsState;
  /** Totals across published and archived courses only. */
  summary: {
    studentCount: number;
    /** Integer cents. */
    grossRevenue: number;
    /** Pooled across all enrollments; null when there are none. */
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

function rate(completed: number, total: number): number | null {
  return total === 0 ? null : completed / total;
}

type QuizStats = {
  id: number;
  title: string;
  passingScore: number;
  /** Each student's best score per quiz. Ignores the stored `passed` flag. */
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
    const s = stats.get(row.quizId)!;
    s.bestScores.push(row.best);
    s.attemptCount += row.attempts;
  }
  return [...stats.values()];
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((a, b) => a + b, 0) / values.length;
}

export function getInstructorAnalytics(
  instructorId: number
): InstructorAnalytics {
  const instructorCourses = db
    .select()
    .from(courses)
    .where(eq(courses.instructorId, instructorId))
    .all();

  const lessonCounts = new Map(
    db
      .select({ courseId: modules.courseId, count: sql<number>`count(*)` })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .innerJoin(courses, eq(modules.courseId, courses.id))
      .where(eq(courses.instructorId, instructorId))
      .groupBy(modules.courseId)
      .all()
      .map((row) => [row.courseId, row.count])
  );

  const enrollmentStats = new Map(
    db
      .select({
        courseId: enrollments.courseId,
        count: sql<number>`count(*)`,
        completed: sql<number>`count(${enrollments.completedAt})`,
      })
      .from(enrollments)
      .innerJoin(courses, eq(enrollments.courseId, courses.id))
      .where(eq(courses.instructorId, instructorId))
      .groupBy(enrollments.courseId)
      .all()
      .map((row) => [row.courseId, row])
  );

  const revenueByCourse = new Map(
    db
      .select({
        courseId: purchases.courseId,
        total: sql<number>`sum(${purchases.amountPaid})`,
      })
      .from(purchases)
      .innerJoin(courses, eq(purchases.courseId, courses.id))
      .where(eq(courses.instructorId, instructorId))
      .groupBy(purchases.courseId)
      .all()
      .map((row) => [row.courseId, row.total])
  );

  const summary = {
    studentCount: 0,
    grossRevenue: 0,
    completionRate: null as number | null,
  };
  let summaryCompleted = 0;

  const courseEntries: CourseAnalytics[] = instructorCourses.map((course) => {
    const stats = enrollmentStats.get(course.id);
    const base: CourseBase = {
      id: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      coverImageUrl: course.coverImageUrl,
      lessonCount: lessonCounts.get(course.id) ?? 0,
      studentCount: stats?.count ?? 0,
    };

    if (course.status === CourseStatus.Draft) {
      return { ...base, status: course.status };
    }

    const completed = stats?.completed ?? 0;
    const grossRevenue = revenueByCourse.get(course.id) ?? 0;
    summary.studentCount += base.studentCount;
    summary.grossRevenue += grossRevenue;
    summaryCompleted += completed;

    return {
      ...base,
      status: course.status,
      grossRevenue,
      completionRate: rate(completed, base.studentCount),
    };
  });
  summary.completionRate = rate(summaryCompleted, summary.studentCount);

  const averageQuizScore = mean(
    getQuizStats(
      and(
        eq(courses.instructorId, instructorId),
        ne(courses.status, CourseStatus.Draft)
      )
    ).flatMap((q) => q.bestScores)
  );

  const state: InstructorAnalyticsState =
    instructorCourses.length === 0
      ? "no-courses"
      : instructorCourses.every((c) => c.status === CourseStatus.Draft)
        ? "drafts-only"
        : "ready";

  return {
    state,
    summary: { ...summary, averageQuizScore },
    courses: courseEntries,
  };
}

export type CourseAnalyticsDetail = {
  studentCount: number;
  /** Enrollments where that user has a purchase for this course. */
  paidStudentCount: number;
  /** Enrollments without a purchase row — redeemed team seats. */
  teamSeatStudentCount: number;
  /** Integer cents. Team purchases count in full. */
  grossRevenue: number;
  /** 0–1, or null when there are no enrollments. */
  completionRate: number | null;
  /**
   * 0–1: mean across enrolled students of completed lessons ÷ lessons in the
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

export function getCourseAnalytics(courseId: number): CourseAnalyticsDetail {
  const students = db
    .select({
      count: sql<number>`count(distinct ${enrollments.id})`,
      paid: sql<number>`count(distinct ${purchases.userId})`,
      completed: sql<number>`count(distinct case when ${enrollments.completedAt} is not null then ${enrollments.id} end)`,
    })
    .from(enrollments)
    .leftJoin(
      purchases,
      and(
        eq(purchases.userId, enrollments.userId),
        eq(purchases.courseId, enrollments.courseId)
      )
    )
    .where(eq(enrollments.courseId, courseId))
    .get();

  const revenue = db
    .select({ total: sql<number>`coalesce(sum(${purchases.amountPaid}), 0)` })
    .from(purchases)
    .where(eq(purchases.courseId, courseId))
    .get();

  const lessonCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(lessons)
      .innerJoin(modules, eq(lessons.moduleId, modules.id))
      .where(eq(modules.courseId, courseId))
      .get()?.count ?? 0;

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

  const studentCount = students?.count ?? 0;
  const paidStudentCount = students?.paid ?? 0;

  return {
    studentCount,
    paidStudentCount,
    teamSeatStudentCount: studentCount - paidStudentCount,
    grossRevenue: revenue?.total ?? 0,
    completionRate: rate(students?.completed ?? 0, studentCount),
    averageProgress: rate(completedLessons, studentCount * lessonCount),
    quizzes: getQuizStats(eq(modules.courseId, courseId)).map((q) => ({
      id: q.id,
      title: q.title,
      passingScore: q.passingScore,
      averageScore: mean(q.bestScores),
      passRate: rate(
        q.bestScores.filter((score) => score >= q.passingScore).length,
        q.bestScores.length
      ),
      attemptCount: q.attemptCount,
    })),
  };
}
