import { goals as baritoneGoals } from '@miner-org/mineflayer-baritone'
import { Vec3 } from 'vec3'

/**
 * Compatibility shim over @miner-org/mineflayer-baritone.
 * Keeps the old mineflayer-pathfinder constructor signatures so call sites
 * like `new goals.GoalNear(x, y, z, range)` stay unchanged.
 */

class GoalNear extends baritoneGoals.GoalNear {
  constructor(x: number, y: number, z: number, range: number) {
    super(new Vec3(x, y, z), range)
  }
}

/** Old GoalBlock meant "stand on that exact cell"; GoalNear with range 0 does that. */
class GoalBlock extends baritoneGoals.GoalNear {
  constructor(x: number, y: number, z: number) {
    super(new Vec3(x, y, z), 0)
  }
}

/**
 * Old GoalLookAtBlock stopped within reach of a block. Baritone has no
 * equivalent; GoalNear with the reach as radius is the closest match.
 */
class GoalLookAtBlock extends baritoneGoals.GoalNear {
  constructor(pos: Vec3, _world?: any, opts?: { reach?: number }) {
    super(pos, opts?.reach ?? 4)
  }
}

/**
 * Static snapshot of the entity's position. Baritone has no dynamic follow
 * goal, so combat callers must re-issue this as the target moves.
 */
class GoalFollow extends baritoneGoals.GoalNear {
  constructor(entity: { position: Vec3 }, range: number) {
    super(entity.position, range)
  }
}

class GoalXZ extends baritoneGoals.GoalXZ {
  constructor(x: number, z: number) {
    super(new Vec3(x, 0, z))
  }
}

/** Inverts a goal (used to push the bot out of a cell it is standing in). */
class GoalInvert extends baritoneGoals.GoalInvert {}

export const goals = {
  GoalNear,
  GoalBlock,
  GoalLookAtBlock,
  GoalFollow,
  GoalXZ,
  GoalInvert
}