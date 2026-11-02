import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth, getCurrentUser, isGoogleConfigured } from "@/lib/auth";
import { isAuthConfigured } from "@/lib/auth-db";
import { describeAuthError } from "@/lib/auth-errors";
import { getActiveSeasonYear, getDriverStandings } from "@/lib/api";
import AccountView, { type GridDriver, type GridTeam } from "@/components/account/account-view";

export const metadata: Metadata = {
  title: "Account | APEX",
  robots: { index: false },
};

/** Per request: it is one person's account. */
export const dynamic = "force-dynamic";

/**
 * The favourites picker offers the CURRENT grid, read from the driver
 * standings (which carry each driver's team). Before the first race of a
 * season those are empty, so it falls back to last season's grid rather than
 * offering an empty list; a favourite is an id, so it survives the switch.
 */
async function loadGrid(): Promise<{ season: number; drivers: GridDriver[]; teams: GridTeam[] }> {
  const active = getActiveSeasonYear();
  for (const season of [active, active - 1]) {
    try {
      const { driver_standings: standings = [] } = await getDriverStandings(season);
      if (standings.length === 0) continue;
      const teams = new Map<string, GridTeam>();
      const drivers: GridDriver[] = [];
      for (const row of standings) {
        const id = row.Driver.driverId;
        if (!id) continue;
        const team = row.Constructors?.[row.Constructors.length - 1];
        drivers.push({
          id,
          name: [row.Driver.givenName, row.Driver.familyName].filter(Boolean).join(" ") || id,
          team: team?.name ?? "",
        });
        if (team?.constructorId && !teams.has(team.constructorId)) {
          teams.set(team.constructorId, { id: team.constructorId, name: team.name ?? team.constructorId });
        }
      }
      drivers.sort((a, b) => a.name.localeCompare(b.name));
      return {
        season,
        drivers,
        teams: [...teams.values()].sort((a, b) => a.name.localeCompare(b.name)),
      };
    } catch {
      // Backend unreachable: the picker shows its own "couldn't load" state
      // and everything else on the page still works.
    }
  }
  return { season: active, drivers: [], teams: [] };
}

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!isAuthConfigured()) redirect("/signin");
  const user = await getCurrentUser();
  if (!user) redirect("/signin?next=/account");

  const params = await searchParams;
  const [grid, accounts] = await Promise.all([
    loadGrid(),
    getAuth()
      .api.listUserAccounts({ headers: await headers() })
      .catch(() => []),
  ]);
  const errorParam = Array.isArray(params.error) ? params.error[0] : params.error;

  return (
    <AccountView
      user={user}
      grid={grid}
      providers={accounts.map(({ providerId, accountId }) => ({ providerId, accountId }))}
      googleEnabled={isGoogleConfigured()}
      welcome={params.welcome === "1"}
      error={describeAuthError(errorParam)}
    />
  );
}
