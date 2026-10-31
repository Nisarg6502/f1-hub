"use client";

import type { ComponentType } from "react";
import { WIDGET_CATALOGUE, type WidgetSize, type WidgetSpec, type WidgetType } from "@/lib/home-layout";
import CountdownWidget from "./widgets/countdown-widget";
import SeasonWidget from "./widgets/season-widget";
import { LastRaceWidget, LeaderWidget, NextCircuitWidget } from "./widgets/bento-widgets";
import { ConstructorStandingsWidget, DriverStandingsWidget, TitleFightWidget } from "./widgets/standings-widgets";
import { AskPitwallWidget, ExploreWidget, RaceWeekWidget, TipsWidget } from "./widgets/misc-widgets";
import type { WidgetProps } from "./widget-kit";

/**
 * The React half of a widget: how it is named and how it is drawn. The data
 * half (sizes, `revealsResults`, uniqueness) is `WIDGET_CATALOGUE` in
 * `lib/home-layout.ts`; `widgetSpec()` below merges them.
 *
 * Typed `Record<WidgetType, …>`, so a type added to the catalogue without an
 * entry here fails the build. That is the whole extension story — the "catch
 * me up" card becomes a widget by adding one catalogue line and one entry
 * here; nothing in the grid, the editor or the gallery changes.
 */
export interface WidgetDefinition {
  title: string;
  /** One line for the gallery. Says what it shows, not how it looks. */
  description: string;
  /** Material Symbols ligature for the gallery row. Decorative. */
  icon: string;
  Component: ComponentType<WidgetProps>;
  /**
   * True when the widget currently has nothing to show. Outside edit mode an
   * empty widget's cell is not rendered at all — an empty grid item still
   * costs a row gap, which would leave a 20px seam where the old page simply
   * closed up. In edit mode it renders anyway (with a placeholder) so it can
   * still be moved or removed.
   */
  isEmpty?: (data: WidgetProps["data"]) => boolean;
}

export const WIDGET_REGISTRY: Record<WidgetType, WidgetDefinition> = {
  countdown: {
    title: "Race countdown",
    description: "Time to lights out at the next Grand Prix. Full width, it is the hero, with the season card beside it.",
    icon: "timer",
    Component: CountdownWidget,
  },
  "race-week": {
    title: "Race week",
    description: "The latest session's top three during a race weekend.",
    icon: "flag",
    Component: RaceWeekWidget,
    isEmpty: (data) => !data.raceWeekActive,
  },
  season: {
    title: "Season progress",
    description: "How far through the season we are, and how close the title is.",
    icon: "donut_large",
    Component: SeasonWidget,
  },
  leader: {
    title: "Championship leader",
    description: "Who leads the drivers' championship, on how many points.",
    icon: "emoji_events",
    Component: LeaderWidget,
  },
  "last-race": {
    title: "Last time out",
    description: "The most recent Grand Prix winner. Large shows the whole podium.",
    icon: "sports_score",
    Component: LastRaceWidget,
  },
  "next-circuit": {
    title: "Next circuit",
    description: "Where the next race is. Larger sizes add the map and the weekend.",
    icon: "route",
    Component: NextCircuitWidget,
  },
  "driver-standings": {
    title: "Driver standings",
    description: "The drivers' table: top 3, 5 or 10 by size.",
    icon: "format_list_numbered",
    Component: DriverStandingsWidget,
  },
  "constructor-standings": {
    title: "Constructor standings",
    description: "The constructors' table: top 3, 5 or 10 by size.",
    icon: "groups",
    Component: ConstructorStandingsWidget,
  },
  "title-fight": {
    title: "Title fight",
    description: "The points gap at the top and what each contender has to make up.",
    icon: "swords",
    Component: TitleFightWidget,
  },
  "ask-pitwall": {
    title: "Ask the Pitwall",
    description: "Opens the Pitwall Assistant for cited answers about any race.",
    icon: "forum",
    Component: AskPitwallWidget,
  },
  tips: {
    title: "Discovery tips",
    description: "A rotating pointer to the parts of APEX most people miss.",
    icon: "lightbulb",
    Component: TipsWidget,
  },
  explore: {
    title: "Explore the season",
    description: "Shortcuts to the calendar, standings, drivers and teams.",
    icon: "explore",
    Component: ExploreWidget,
  },
};

export function widgetSpec(type: WidgetType): WidgetSpec & WidgetDefinition {
  return { ...WIDGET_CATALOGUE[type], ...WIDGET_REGISTRY[type] };
}

export const SIZE_LABEL: Record<WidgetSize, { short: string; long: string }> = {
  s: { short: "S", long: "Small" },
  m: { short: "M", long: "Medium" },
  l: { short: "L", long: "Large" },
  full: { short: "Full", long: "Full width" },
};
