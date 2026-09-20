// Minimal ambient-deklaration av node:sqlite.
//
// Repots @types/node är 20.x och saknar typer för node:sqlite, som finns
// inbyggt i Node 22.22 (fungerar utan flagga, ger bara en ExperimentalWarning).
// Att bumpa @types/node till 22 är den "riktiga" lösningen men ligger utanför
// Fas 1 — tsc har redan befintliga fel och en bump riskerar att lägga till fler.
//
// Här deklareras bara det vi faktiskt använder. Runtime påverkas inte alls;
// tsx typkollar inte. Ta bort filen den dag @types/node bumpas.
declare module "node:sqlite" {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Array<Record<string, unknown>>;
  }

  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
