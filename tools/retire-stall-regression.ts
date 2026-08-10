import { createRun, resolveChoice, simulatePeriod, type RunSetup } from "../src/engine/run";
import type { Choice, GameState } from "../src/engine/types";

const baseSetup: Omit<RunSetup, "seed"> = {
  nationalityId: "bra",
  position: "ST",
  leagueId: "premier-league",
  clubId: "man-city",
  pace: "normal",
  blessings: [],
  ascension: 0,
  permPerks: [],
};

function chooseForProgress(game: GameState): Choice {
  const choices = game.pendingChoice?.choices ?? [];
  return choices.find((choice) => choice.kind === "stay") ?? choices[0]!;
}

function advanceOne(game: GameState): GameState {
  if (!game.pendingChoice) return simulatePeriod(game);
  const choice = chooseForProgress(game);
  const resolved = resolveChoice(game, choice);
  return resolved.phase === "playing" && !resolved.pendingChoice
    ? simulatePeriod(resolved)
    : resolved;
}

for (let i = 0; i < 500; i++) {
  const seed = `retirestall${i}`;
  let game = simulatePeriod(createRun({ ...baseSetup, seed }));
  let guard = 0;
  while (game.phase === "playing" && guard++ < 200) {
    if (game.pendingChoice?.key === "dignified_retire") {
      if (Object.keys(game.pendingMods ?? {}).length === 0) {
        throw new Error(`dignified retirement was not reached as a queued tail event for ${seed}`);
      }
      const choice = game.pendingChoice.choices.find((item) => item.id === "retire");
      if (!choice) throw new Error(`retire choice missing for ${seed}`);

      const resolved = resolveChoice(game, choice);
      if (resolved.phase !== "playing" || resolved.pendingChoice || !resolved.pendingMods?.forceRetire) {
        throw new Error(`retire choice did not leave the expected pending terminal state for ${seed}: ${JSON.stringify({
          phase: resolved.phase,
          pendingChoice: resolved.pendingChoice?.key ?? null,
          pendingChoices: resolved.pendingChoices?.map((item) => item.key) ?? [],
          pendingMods: resolved.pendingMods,
          lastOutcome: resolved.lastOutcome,
        })}`);
      }

      const ended = simulatePeriod(resolved);
      if (ended.phase !== "summary" || !ended.retired || ended.retirementReason !== "voluntary") {
        throw new Error(`retire choice did not finalize the run for ${seed}`);
      }

      console.log(`PASS seed=${seed} age=${ended.age} seasons=${ended.seasons.length}`);
      process.exit(0);
    }
    game = advanceOne(game);
  }
}

throw new Error("No dignified retirement event found in 500 deterministic runs");
