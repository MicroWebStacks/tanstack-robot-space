import { createFileRoute } from '@tanstack/react-router'

import { useRobotStatus } from '../lib/robotStatusClient'
import type { UiStatusFieldMeta } from '../lib/robotStatus'

export const Route = createFileRoute('/')({ component: RobotDashboard })

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return '--'
  if (Math.abs(value) < 10) return value.toFixed(1)
  if (Math.abs(value) < 100) return value.toFixed(0)
  return Math.round(value).toString()
}

function formatNumberWithUnit(value: number, unit: string) {
  const suffix = unit ? unit : ''
  return `${formatNumber(value)}${suffix}`
}

function formatValueText(value: number | null, unit: string) {
  if (value == null) return '--'
  if (unit === '%') return `${Math.round(value)}%`
  return formatNumberWithUnit(value, unit)
}

function labelFromId(id: string) {
  let label = id
  label = label.replace(/^hz_/, '')
  label = label.replace(/_/g, ' ')
  return label.replace(/\b\w/g, (ch) => ch.toUpperCase())
}

function gaugeColorClass(meta: UiStatusFieldMeta) {
  const id = meta.id
  if (id.includes('cpu')) return 'stroke-amber-400'
  if (id.includes('volt')) return 'stroke-emerald-500'
  if (meta.unit === 'Hz') return 'stroke-sky-400'
  return 'stroke-indigo-400'
}

function RingGauge({
  label,
  valueText,
  fraction,
  minLabel,
  maxLabel,
  colorClass,
}: {
  label: string
  valueText: string
  fraction: number | null
  minLabel: string
  maxLabel: string
  colorClass: string
}) {
  const size = 148
  const strokeWidth = 14
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset =
    fraction == null ? circumference : circumference * (1 - fraction)

  return (
    <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 shadow-lg shadow-black/30">
      <div className="text-sm text-slate-200">{label}</div>
      <div className="relative mx-auto mt-3 h-[148px] w-[148px]">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="h-full w-full -rotate-90"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-slate-700"
          />
          {fraction != null ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              className={colorClass}
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-3xl font-medium text-slate-100 tabular-nums">
            {valueText}
          </div>
        </div>
      </div>
      <div className="mt-2 flex justify-between text-xs text-slate-400 tabular-nums">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  )
}

function RateBar({
  label,
  hz,
  targetHz,
  unit,
}: {
  label: string
  hz: number | null
  targetHz: number
  unit: string
}) {
  const valueText =
    hz == null
      ? `--/${formatNumberWithUnit(targetHz, unit)}`
      : `${formatNumberWithUnit(hz, unit)}/${formatNumberWithUnit(targetHz, unit)}`
  const percent =
    hz == null ? 0 : clampNumber((hz / targetHz) * 100, 0, 100)

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-slate-200">{label}</span>
        <span className="text-sm text-slate-300 tabular-nums">{valueText}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-700">
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

function ValueTile({
  label,
  valueText,
  unit,
}: {
  label: string
  valueText: string
  unit: string
}) {
  return (
    <div className="rounded-xl bg-slate-900/70 border border-slate-700 p-4 shadow-lg shadow-black/30">
      <div className="text-sm text-slate-200">{label}</div>
      <div className="mt-3 text-3xl font-medium text-slate-100 tabular-nums">
        {valueText}
        {valueText !== '--' && unit && !valueText.endsWith(unit) ? (
          <span className="ml-1 text-lg text-slate-300">{unit}</span>
        ) : null}
      </div>
    </div>
  )
}

function RobotDashboard() {
  const { status } = useRobotStatus()

  const fields = status?.fields ?? []
  const values = status?.values ?? {}
  const hasAnyValue = Object.values(values).some((v) => v != null)

  const targetFields = fields.filter((f) => f.target != null)
  const gaugeFields = fields.filter(
    (f) => f.target == null && f.min != null && f.max != null,
  )
  const otherFields = fields.filter(
    (f) => f.target == null && (f.min == null || f.max == null),
  )

  return (
    <div
      className="min-h-screen p-4 text-white"
      style={{
        backgroundColor: '#000',
        backgroundImage:
          'radial-gradient(60% 60% at 0% 100%, #334155 0%, #0f172a 55%, #000 100%)',
      }}
    >
      <div className="mx-auto w-full max-w-sm">
        <div className="grid grid-cols-2 gap-3">
          {gaugeFields.map((meta) => {
            const value = values[meta.id] ?? null
            const min = meta.min ?? 0
            const max = meta.max ?? 1
            const fraction =
              value == null || meta.min == null || meta.max == null || max === min
                ? null
                : clampNumber((value - min) / (max - min), 0, 1)

            return (
              <RingGauge
                key={meta.id}
                label={meta.label ?? labelFromId(meta.id)}
                valueText={formatValueText(value, meta.unit)}
                fraction={fraction}
                minLabel={formatNumberWithUnit(min, meta.unit)}
                maxLabel={formatNumberWithUnit(max, meta.unit)}
                colorClass={gaugeColorClass(meta)}
              />
            )
          })}

          {targetFields.length ? (
            <div className="col-span-2 rounded-xl bg-slate-900/70 border border-slate-700 p-4 shadow-lg shadow-black/30">
              <div className="text-sm text-slate-200">Targets</div>
              <div className="mt-4 space-y-5">
                {targetFields.map((meta) => (
                  <RateBar
                    key={meta.id}
                    label={meta.label ?? labelFromId(meta.id)}
                    hz={values[meta.id] ?? null}
                    targetHz={meta.target ?? 0}
                    unit={meta.unit}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {otherFields.map((meta) => (
            <ValueTile
              key={meta.id}
              label={meta.label ?? labelFromId(meta.id)}
              valueText={formatValueText(values[meta.id] ?? null, meta.unit)}
              unit={meta.unit}
            />
          ))}
        </div>
        <div className="mt-4 text-center text-xs text-slate-500">
          {status && hasAnyValue
            ? `seq ${status.seq}${status.stack ? ` · ${status.stack}` : ''}`
            : 'No data'}
        </div>
      </div>
    </div>
  )
}
