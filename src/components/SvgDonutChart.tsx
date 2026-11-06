export function SvgDonutChart({
  slices,
  centerTitle,
  centerSubtitle,
}: {
  slices: ReadonlyArray<{ label: string; percentage: number; color: string }>;
  centerTitle: string;
  centerSubtitle: string;
}) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let cumulativePercent = 0;

  return (
    <div className="relative w-36 h-36 flex items-center justify-center">
      <svg viewBox="0 0 140 140" className="w-36 h-36 -rotate-90" aria-label={centerTitle}>
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="transparent"
          className="stroke-slate-200 dark:stroke-slate-800"
          strokeWidth="16"
        />
        {slices.map((slice, i) => {
          const strokeDasharray = `${(slice.percentage / 100) * circumference} ${circumference}`;
          const strokeDashoffset = -((cumulativePercent / 100) * circumference);
          cumulativePercent += slice.percentage;
          return (
            <circle
              key={i}
              cx="70"
              cy="70"
              r={radius}
              fill="transparent"
              stroke={slice.color}
              strokeWidth="16"
              strokeDasharray={strokeDasharray}
              strokeDashoffset={strokeDashoffset}
            >
              <title>{`${slice.label}: ${slice.percentage}%`}</title>
            </circle>
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
        <span className="text-sm font-mono font-semibold text-slate-900">{centerTitle}</span>
        <span className="text-[11px] text-slate-500">{centerSubtitle}</span>
      </div>
    </div>
  );
}
