/** JEV är förkontroll, därefter exakt två agentroller. Inget råd får lägga till fler roller automatiskt. */
export async function runTwoAgentPipeline<J, T extends { analyses: readonly unknown[] } | null, H>(jobs: {
  jev: () => Promise<J>;
  technical: (jev: J) => Promise<T>;
  head: (technical: T, jev: J) => Promise<H>;
}): Promise<{ jev: J; technical: T; head: H }> {
  const jev = await jobs.jev();
  const technical = await jobs.technical(jev);
  if (!technical || !technical.analyses.length) throw new Error("Teknisk analys saknas; Hanna startas inte och inga orderförslag skapas");
  const head = await jobs.head(technical, jev);
  return { jev, technical, head };
}
