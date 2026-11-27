import { Link, data, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { requireStaff } from "~/lib/access.server";
import { getCourseById } from "~/services/courseService";
import { getCourseAnalytics } from "~/services/analyticsService";
import { formatDollars, formatRate } from "~/lib/utils";
import { parseRange, RangeToggle } from "~/components/range-toggle";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  DollarSign,
  TrendingUp,
  Users,
} from "lucide-react";

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course?.title ?? "Course Analytics";
  return [
    { title: `Analytics: ${title} — Cadence` },
    { name: "description", content: `Analytics for ${title}` },
  ];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  await requireStaff(request, courseId);

  const course = getCourseById(courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  const range = parseRange(request);
  return {
    range,
    course: { id: course.id, title: course.title },
    analytics: getCourseAnalytics(courseId, range),
  };
}

function MetricCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail?: string;
  icon: React.ReactNode;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="flex items-center gap-3">
        <div className="rounded-md bg-muted p-2 text-muted-foreground">
          {icon}
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-semibold">{value}</p>
          {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export default function CourseAnalyticsPage({
  loaderData,
}: Route.ComponentProps) {
  const { range, course, analytics } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/instructor" className="hover:text-foreground">
          My Courses
        </Link>
        <span className="mx-2">/</span>
        <Link to={`/instructor/${course.id}`} className="hover:text-foreground">
          {course.title}
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <Link
        to={`/instructor/${course.id}`}
        className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="mr-1 size-4" />
        Back to course editor
      </Link>

      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{course.title}</h1>
          <p className="mt-1 text-muted-foreground">Course analytics</p>
        </div>
        <RangeToggle range={range} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Students"
          value={analytics.studentCount.toLocaleString("en-US")}
          detail={`${analytics.paidStudentCount.toLocaleString("en-US")} paid · ${analytics.teamSeatStudentCount.toLocaleString("en-US")} team-seat`}
          icon={<Users className="size-5" />}
        />
        <MetricCard
          label="Gross revenue"
          value={formatDollars(analytics.grossRevenue)}
          icon={<DollarSign className="size-5" />}
        />
        <MetricCard
          label="Completion rate (all-time)"
          value={formatRate(analytics.completionRate)}
          icon={<CheckCircle2 className="size-5" />}
        />
        <MetricCard
          label="Average progress (all-time)"
          value={formatRate(analytics.averageProgress)}
          icon={<TrendingUp className="size-5" />}
        />
      </div>

      <Card className="mt-8">
        <CardHeader>
          <CardTitle>
            Quizzes{" "}
            <span className="text-sm font-normal text-muted-foreground">
              (all-time)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {analytics.quizzes.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This course has no quizzes.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Quiz</th>
                    <th className="py-2 pr-4 text-right font-medium">
                      Average score
                    </th>
                    <th className="py-2 pr-4 text-right font-medium">
                      Pass rate
                    </th>
                    <th className="py-2 text-right font-medium">Attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.quizzes.map((quiz) => (
                    <tr key={quiz.id} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        {quiz.title}
                        <span className="ml-2 text-xs text-muted-foreground">
                          pass mark {formatRate(quiz.passingScore)}
                        </span>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatRate(quiz.averageScore)}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {formatRate(quiz.passRate)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {quiz.attemptCount.toLocaleString("en-US")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading course analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
    } else if (error.status === 403) {
      title = "Access denied";
    } else if (error.status === 404) {
      title = "Course not found";
    } else {
      title = `Error ${error.status}`;
    }
    message = typeof error.data === "string" ? error.data : error.statusText;
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/instructor">
          <Button variant="outline">Back to My Courses</Button>
        </Link>
      </div>
    </div>
  );
}
