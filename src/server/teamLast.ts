// Senaste riktiga rapporterna från AI-teamet, så att sidan kan visa dem
// direkt när den laddas (i stället för påhittad demo-data).
// Bara i minnet: efter omstart är den tom tills nästa tur har körts.

export interface TeamLast {
  at: number;
  symbols: string[];
  reports: Record<string, unknown>;
}

let last: TeamLast | null = null;

export function setTeamLast(reports: Record<string, unknown>, symbols: string[]): void {
  last = { at: Date.now(), symbols, reports };
}

export function getTeamLast(): TeamLast | null {
  return last;
}
