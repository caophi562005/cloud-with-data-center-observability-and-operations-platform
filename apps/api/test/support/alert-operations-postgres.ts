export function requireIsolatedPostgresTestUrl(
  environment: NodeJS.ProcessEnv,
): string {
  const input = environment.ALERT_OPERATIONS_TEST_DATABASE_URL;
  try {
    if (
      environment.ALERT_OPERATIONS_TEST_ALLOW_WRITE !== '1' ||
      !input ||
      /[\s\\]/u.test(input)
    )
      throw new Error();
    const url = new URL(input);
    const port = Number(url.port);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.hostname !== '127.0.0.1' ||
      !url.username ||
      !url.password ||
      !url.port ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      url.pathname !== '/opsgrid_alert_operations_test' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return input;
  } catch {
    throw new Error('Isolated PostgreSQL test target required');
  }
}
