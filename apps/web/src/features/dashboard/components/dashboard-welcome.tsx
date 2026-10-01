export function DashboardWelcome({
  organizationName,
  firstName,
}: {
  organizationName: string;
  firstName: string;
}) {
  return (
    <section className="grid gap-[0.4rem]">
      <h1 className="text-retro-cyan font-[var(--font-pixel)] text-[clamp(1rem,2.2vw,1.4rem)] font-normal tracking-[0.06em] leading-[1.45] uppercase text-shadow-[2px_2px_0_var(--cloudops-shadow)]">
        Good morning, {firstName}
      </h1>
      <p className="text-retro-muted">Here's what's happening in {organizationName}.</p>
    </section>
  );
}
