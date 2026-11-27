import { Link, useSearchParams } from "react-router";
import type { AnalyticsRange } from "~/services/analyticsService";
import { cn } from "~/lib/utils";

/** Reads `?range=30d` from a request URL; anything else means all time. */
export function parseRange(request: Request): AnalyticsRange {
  return new URL(request.url).searchParams.get("range") === "30d"
    ? "30d"
    : "all";
}

const OPTIONS: { value: AnalyticsRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "30d", label: "Last 30 days" },
];

/** "All time / Last 30 days" toggle, stored in the URL as `?range=30d`. */
export function RangeToggle({ range }: { range: AnalyticsRange }) {
  const [searchParams] = useSearchParams();

  return (
    <div
      role="group"
      aria-label="Time range"
      className="inline-flex rounded-md border bg-muted p-0.5 text-sm"
    >
      {OPTIONS.map((option) => {
        const params = new URLSearchParams(searchParams);
        if (option.value === "all") params.delete("range");
        else params.set("range", option.value);
        const search = params.toString();
        const active = option.value === range;
        return (
          <Link
            key={option.value}
            to={{ search: search ? `?${search}` : "" }}
            preventScrollReset
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded px-3 py-1 font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}
