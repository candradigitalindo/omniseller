"use client";

import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import ReactEChartsCore from "echarts-for-react/lib/core";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

echarts.use([LineChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface TrendData {
  /** axis label per point */
  labels: string[];
  /** tooltip label per point, and of the point it is compared with */
  tooltipLabels: { current: string; previous: string | null }[];
  current: number[];
  /** the period before, point by point; null without a comparison */
  previous: (number | null)[] | null;
  names: { current: string; previous: string };
  format: (value: number) => string;
  axisFormat: (value: number) => string;
}

/**
 * The report's trend (L30): this period as a 2 px line in slot 1 with a light area, the period before as a
 * gray dashed line, one Y axis, the legend above (DOKUMEN-UI-UX 13). No names at the line ends: both lines
 * end on today, often close together, and names stacked there cannot be read.
 */
export function TrendChart({ data }: { data: TrendData }) {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<{ text: string; muted: string; grid: string; line: string } | null>(null);

  useEffect(() => {
    // colors come from the CSS tokens, so the dark theme gets its own (13.2)
    void resolvedTheme;
    setColors({
      text: cssVar("--text-700"),
      muted: cssVar("--text-500"),
      grid: cssVar("--grid"),
      line: cssVar("--chart-1"),
    });
  }, [resolvedTheme]);

  if (!colors) return <div className="h-72" />;

  const option = {
    animationDuration: 200,
    textStyle: { fontFamily: "var(--font-inter), sans-serif" },
    // a single line is named by the card's title; two get a legend (13.3)
    legend: {
      show: data.previous !== null,
      top: 0,
      left: 0,
      icon: "roundRect",
      itemWidth: 12,
      itemHeight: 4,
      textStyle: { color: colors.text, fontSize: 13 },
    },
    grid: { top: data.previous ? 36 : 12, left: 8, right: 24, bottom: 8, containLabel: true },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line" },
      formatter: (items: { dataIndex: number; seriesIndex: number; marker: string; value: number | null }[]) => {
        const i = items[0]?.dataIndex ?? 0;
        const labels = data.tooltipLabels[i];
        return items
          .filter((p) => p.value !== null && p.value !== undefined)
          .map((p) => {
            const when = p.seriesIndex === 0 ? labels?.current : labels?.previous;
            return `${p.marker}${when ?? ""}: <b>${data.format(p.value as number)}</b>`;
          })
          .join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: data.labels,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: colors.muted, fontSize: 12, hideOverlap: true },
    },
    yAxis: {
      type: "value",
      minInterval: 1,
      splitLine: { lineStyle: { color: colors.grid } },
      axisLabel: { color: colors.muted, fontSize: 12, formatter: data.axisFormat },
    },
    series: [
      {
        name: data.names.current,
        type: "line",
        data: data.current,
        showSymbol: data.current.length === 1,
        symbolSize: 8,
        lineStyle: { width: 2, cap: "round", join: "round" },
        color: colors.line,
        areaStyle: { opacity: 0.08 },
        z: 3,
      },
      ...(data.previous
        ? [
            {
              name: data.names.previous,
              type: "line",
              data: data.previous,
              showSymbol: data.previous.length === 1,
              symbolSize: 8,
              lineStyle: { width: 2, type: "dashed", cap: "round", join: "round" },
              color: colors.muted,
              z: 2,
            },
          ]
        : []),
    ],
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
