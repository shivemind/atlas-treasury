import { ConflictError } from "./errors";

export type TransitionMap<S extends string> = Partial<Record<S, readonly S[]>>;

export interface StateMachine<S extends string> {
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): void;
  validTargets(from: S): readonly S[];
  isTerminal(state: S): boolean;
}

export function defineTransitions<S extends string>(
  map: TransitionMap<S>,
): StateMachine<S> {
  return {
    canTransition(from: S, to: S): boolean {
      return (map[from] ?? []).includes(to);
    },

    assertTransition(from: S, to: S): void {
      if (!this.canTransition(from, to)) {
        throw new ConflictError(
          "INVALID_STATE_TRANSITION",
          `Cannot transition from '${from}' to '${to}'.`,
        );
      }
    },

    validTargets(from: S): readonly S[] {
      return map[from] ?? [];
    },

    isTerminal(state: S): boolean {
      return (map[state] ?? []).length === 0;
    },
  };
}
