export function DashboardWelcome({
  organizationName,
  firstName,
}: {
  organizationName: string;
  firstName: string;
}) {
  return (
    <section className="dashboard-welcome">
      <h1>Good morning, {firstName}</h1>
      <p>Here's what's happening in {organizationName}.</p>
    </section>
  );
}
