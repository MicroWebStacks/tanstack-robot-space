import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import type { RobotStatus } from '../lib/robotStatus'
import {
  DEFAULT_STATUS_STALE_MS,
  DRIVER_TARGET_HZ,
  LIDAR_TARGET_HZ,
  ODOM_TARGET_HZ,
  SLAM_TARGET_HZ,
  VOLTAGE_MAX_V,
  VOLTAGE_MIN_V,
} from '../lib/robotStatus'

export const Route = createFileRoute('/')({ component: RobotDashboard })

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function formatHz(value: number) {
  if (Number.isNaN(value)) return '--'
  if (Number.isFinite(value) && Math.abs(value) < 100) return value.toFixed(0)
  return Math.round(value).toString()
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
}: {
  label: string
  hz: number | null
  targetHz: number
}) {
  const valueText =
    hz == null ? `--/${formatHz(targetHz)}Hz` : `${formatHz(hz)}/${formatHz(targetHz)}Hz`
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

function RobotDashboard() {
  const [status, setStatus] = useState<RobotStatus | null>(null)
  const staleTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    const clearStaleTimeout = () => {
      if (staleTimeoutRef.current == null) return
      window.clearTimeout(staleTimeoutRef.current)
      staleTimeoutRef.current = null
    }

    const applyStatus = (next: RobotStatus | null) => {
      if (cancelled) return

      clearStaleTimeout()
      setStatus(next)

      if (!next) return
      staleTimeoutRef.current = window.setTimeout(() => {
        setStatus(null)
      }, DEFAULT_STATUS_STALE_MS)
    }

    fetch('/api/status')
      .then((res) => res.json() as Promise<{ status: RobotStatus | null }>)
      .then((data) => applyStatus(data.status ?? null))
      .catch(() => {})

    const es = new EventSource('/api/status/stream')

    const onStatus = (event: MessageEvent<string>) => {
      try {
        applyStatus(JSON.parse(event.data) as RobotStatus)
      } catch {
        // ignore malformed frames
      }
    }

    const onClear = () => applyStatus(null)

    es.addEventListener('status', onStatus as EventListener)
    es.addEventListener('clear', onClear)

    return () => {
      cancelled = true
      clearStaleTimeout()
      es.close()
    }
  }, [])

  const cpuPercent = status?.cpuPercent ?? null
  const cpuFraction =
    cpuPercent == null ? null : clampNumber(cpuPercent / 100, 0, 1)
  const cpuText = cpuPercent == null ? '--' : `${Math.round(cpuPercent)}%`

  const voltageV = status?.voltageV ?? null
  const voltageFraction =
    voltageV == null
      ? null
      : clampNumber(
          (voltageV - VOLTAGE_MIN_V) / (VOLTAGE_MAX_V - VOLTAGE_MIN_V),
          0,
          1,
        )
  const voltageText = voltageV == null ? '--' : `${voltageV.toFixed(1)}V`

  const driverHz = status?.rates?.hz_driver?.hz ?? null
  const odomHz = status?.rates?.hz_odom?.hz ?? null
  const lidarHz = status?.rates?.hz_lidar?.hz ?? null
  const slamHz = status?.rates?.hz_slam?.hz ?? null

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
          <RingGauge
            label="Voltage"
            valueText={voltageText}
            fraction={voltageFraction}
            minLabel={`${VOLTAGE_MIN_V}V`}
            maxLabel={`${VOLTAGE_MAX_V}V`}
            colorClass="stroke-emerald-500"
          />
          <RingGauge
            label="CPU"
            valueText={cpuText}
            fraction={cpuFraction}
            minLabel="0%"
            maxLabel="100%"
            colorClass="stroke-amber-400"
          />
          <div className="col-span-2 rounded-xl bg-slate-900/70 border border-slate-700 p-4 shadow-lg shadow-black/30">
            <div className="text-sm text-slate-200">Pipeline Hz</div>
            <div className="mt-4 space-y-5">
              <RateBar label="driver" hz={driverHz} targetHz={DRIVER_TARGET_HZ} />
              <RateBar label="odom" hz={odomHz} targetHz={ODOM_TARGET_HZ} />
              <RateBar label="lidar" hz={lidarHz} targetHz={LIDAR_TARGET_HZ} />
              <RateBar label="slam" hz={slamHz} targetHz={SLAM_TARGET_HZ} />
            </div>
          </div>
        </div>
        <div className="mt-4 text-center text-xs text-slate-500">
          {status ? `seq ${status.seq}` : 'No data'}
        </div>
      </div>
    </div>
  )
}
