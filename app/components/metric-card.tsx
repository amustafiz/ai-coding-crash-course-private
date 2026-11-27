import { Card, CardContent } from "~/components/ui/card";

/** A headline figure with an icon, a label and an optional line of detail. */
export function MetricCard({
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
