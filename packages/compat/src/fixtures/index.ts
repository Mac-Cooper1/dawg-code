/** Every compatibility fixture, by name. Each feature keeps its own file under setups/. */
import { FIXTURES as HOOKS } from "./setups/hooks.ts";
import { FIXTURES as REPORT } from "./setups/report.ts";
import { FIXTURES as SANDBOX } from "./setups/sandbox.ts";
import { FIXTURES as SKILLS } from "./setups/skills.ts";
import type { CompatFixture } from "./types.ts";

export {
  FIXTURE_HOME,
  FIXTURE_PROJECT,
  fixtureDifferences,
  type MaterialisedFixture,
  materialiseFixture,
} from "./materialise.ts";
export type { CompatFixture, ExpectedItem } from "./types.ts";

export const COMPAT_FIXTURES: Readonly<Record<string, CompatFixture>> = {
  ...REPORT,
  ...SKILLS,
  ...HOOKS,
  ...SANDBOX,
};
