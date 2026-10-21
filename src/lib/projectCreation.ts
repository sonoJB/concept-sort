/**
 * New projects are created through an unauthenticated route (the creator receives the admin token in the response). On a
 * deployed server that is an open door: anyone who finds the address could create projects and fill the small data volume
 * (which also threatens the backups). In production the route is therefore OFF unless ALLOW_PROJECT_CREATION=1 is set on the
 * server; development and tests keep it open.
 */
export function projectCreationAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_PROJECT_CREATION === "1" || env.NODE_ENV !== "production";
}
