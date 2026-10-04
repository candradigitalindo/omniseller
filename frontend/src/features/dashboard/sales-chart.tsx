"use client";

import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/lib/core";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { channelChartSlot } from "@/components/common/channel";
import { formatDayMonth, formatRupiah } from "@/lib/format";

echarts.use([LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

export interface SalesSeries {
  channel: string;
  displayName: string;
  revenue: number[];
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Sales per day per channel (L01): 2 px lines, points only on hover, one Y axis, horizontal grid lines,
 * the legend above and labels at the line ends (DOKUMEN-UI-UX 13). Colors follow the channel (13.2).
 */
export function SalesChart({ dates, series, timeZone }: { dates: string[]; series: SalesSeries[]; timeZone: string }) {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<{ text: string; muted: string; grid: string; slots: string[] } | null>(null);

  useEffect(() => {
    // colors come from the CSS tokens, so the dark theme gets its own slots (13.2)
    void resolvedTheme;
    setColors({
      text: cssVar("--text-700"),
      muted: cssVar("--text-500"),
      grid: cssVar("--grid"),
      slots: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => cssVar(`--chart-${i}`)),
    });
  }, [resolvedTheme]);

  if (!colors) return <div className="h-72" />;

  const option = {
    animationDuration: 200,
    textStyle: { fontFamily: "var(--font-inter), sans-serif" },
    legend: { top: 0, left: 0, icon: "roundRect", itemWidth: 12, itemHeight: 4, textStyle: { color: colors.text } },
    grid: { top: 36, left: 8, right: 96, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line" },
      valueFormatter: (v: number) => formatRupiah(v),
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: dates.map((d) => formatDayMonth(`${d}T12:00:00Z`, timeZone)),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: colors.muted, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      splitLine: { lineStyle: { color: colors.grid } },
      axisLabel: {
        color: colors.muted,
        formatter: (v: number) =>
          v >= 1_000_000 ? `${Math.round(v / 100_000) / 10} jt` : v >= 1000 ? `${Math.round(v / 1000)} rb` : `${v}`,
      },
    },
    series: series.map((s) => ({
      name: s.displayName,
      type: "line",
      data: s.revenue,
      showSymbol: false,
      lineStyle: { width: 2 },
      color: colors.slots[channelChartSlot(s.channel) - 1],
      areaStyle: series.length === 1 ? { opacity: 0.08 } : undefined,
      endLabel: { show: series.length <= 4, formatter: "{a}", color: colors.text },
    })),
  };

  return (
    <ReactEChartsCore
      echarts={echarts}
      option={option}
      notMerge
      style={{ height: 288 }}
      opts={{ renderer: "canvas" }}
    />
  );
}
