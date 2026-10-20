# Minecraft field guide

## How to work
- Break big requests into steps and do them one tool call at a time. After each result, decide the next step from what actually happened.
- Tool results are ground truth. If a tool returns `Error: ...`, read it — it usually names the fix (missing tool, missing material, nothing nearby). Adapt instead of repeating the same call.
- High-level tools already handle the details. `collect_block` finds, walks to, mines and picks up blocks. `craft_item` crafts all intermediate parts and sets up a crafting table itself. `smelt_item` sets up a furnace and fuel itself. Do not micro-manage these with `go_to` + `dig_block` unless they fail.
- Craft the final item directly (`craft_item wooden_pickaxe`), never its parts (planks, sticks, table) one by one.
- Gather full amounts in one call (`collect_block log count 4`), not one block at a time.
- Check before guessing: `check_inventory`, `get_recipe`, `find_blocks`, `look_around`, `get_status`.
- If nothing is found nearby, `explore` in a direction, then search again. Try 2–3 times before giving up.
- Coordinates: y is height. Sea level is ~y63. Negative y is deep underground (deepslate below y0).

## Worked examples
- "Get me a stone pickaxe" (empty inventory): `get_recipe stone_pickaxe` → it reports the total raw materials, e.g. "2 log, 3 cobblestone" plus a wooden pickaxe is needed to mine stone. So: `collect_block log count 4` → `craft_item wooden_pickaxe` → `collect_block stone count 3` → `craft_item stone_pickaxe` → `give_item` to the player → short final reply. About 5 calls, not 15.
- "Make torches": `craft_item torch count 8`. If it errors with "need 1 coal", `collect_block coal`, or make charcoal: `smelt_item oak_log`.
- "Get iron": need a stone pickaxe first. `find_blocks iron` → `collect_block iron count 3` → `smelt_item raw_iron` → iron_ingot.
- "Build a small hut here": read your position from the state, gather ~80 cobblestone or dirt, then `fill_region` with `hollow: true` around a 5×4×5 box next to you, then `dig_block` one wall block at ground level (and the one above it) for a door.
- When `craft_item` says "Still need to gather in total: …", gather the full amounts listed (a little extra is fine), then call `craft_item` again for the final item.

## Progression (the usual order)
1. **Wood**: `collect_block log` (any tree type). 1 log → 4 planks. 2 planks → 4 sticks. 4 planks → crafting table.
2. **Wooden pickaxe**: 3 planks + 2 sticks (needs a crafting table — `craft_item` handles it). About 3 logs covers table + pickaxe.
3. **Stone**: mining `stone` drops `cobblestone` and needs a pickaxe. Stone tools = 3 cobblestone (pick/axe) + 2 sticks.
4. **Furnace**: 8 cobblestone. **Torches**: coal or charcoal + stick → 4 torches.
5. **Iron**: iron ore (y −16 to 64, common in caves/mountains) needs a stone pickaxe or better. Mining drops `raw_iron`; `smelt_item raw_iron` → `iron_ingot`.
6. **Diamonds**: deep (y −64 to 16, best around y −58), need an iron pickaxe.

## Tool tiers (what a pickaxe can harvest)
- wooden/golden: stone, cobblestone, coal ore
- stone: + iron ore, copper ore, lapis ore
- iron: + gold ore, diamond ore, redstone ore, emerald ore
- diamond/netherite: + obsidian, ancient debris
- Axes are fastest for wood, shovels for dirt/sand/gravel, swords/shears for leaves and cobwebs. The best tool is chosen automatically.
- Mining a block without the required tool destroys it with **no drop** — the tools refuse to do this and tell you what is needed.

## Common recipes (all via `craft_item`)
- Tools: pickaxe 3 material + 2 sticks; axe 3 + 2; shovel 1 + 2; sword 2 + 1 stick; hoe 2 + 2. Materials: planks, cobblestone, iron_ingot, diamond.
- Armour (iron/diamond/leather): helmet 5, chestplate 8, leggings 7, boots 4.
- chest: 8 planks · bed: 3 wool + 3 planks · bucket: 3 iron_ingot · shield: 6 planks + 1 iron_ingot
- bread: 3 wheat · fishing_rod: 3 sticks + 2 string · bow: 3 sticks + 3 string · arrows: flint + stick + feather
- Any wood type works where planks are needed. Use `get_recipe` when unsure.

## Smelting (`smelt_item`)
- raw_iron/raw_gold/raw_copper → ingots · sand → glass · cobblestone → stone · log → charcoal (a fuel)
- Raw meat (beef, porkchop, chicken, mutton, cod, salmon) → cooked versions, which restore much more hunger.
- Fuel: coal/charcoal smelt 8 items each; logs and planks 1.5 each. Each item takes 10 seconds.

## Survival
- Food bar ≤ 6 stops health regeneration and sprinting. Eat when food < 14 (`eat`). Good food: cooked meat, bread, baked potato. Food sources: hunt animals with `attack` (cow, pig, sheep, chicken), then cook.
- Night (tick 13000–23000) spawns zombies, skeletons, creepers and spiders in the dark. Options: `sleep` in a bed, stay in a lit enclosed space, or `defend`.
- "Protect yourself" / "defend me": `equip_best_armor`, then `defend`. Don't go hunting mobs in caves.
- Creepers explode — kill fast or move away. Skeletons shoot from range. Don't fight with low health (< 6): retreat, eat, then fight.
- Lava and deep water are dangerous. Pathfinding avoids them, but digging straight down is risky.
- Torches (light level) stop mobs spawning near a base.

## Building
- `place_block` needs a solid block next to the target to attach to. Build from the ground up.
- `fill_region` builds cuboids: a wall is thin on one axis, a floor has y1 = y2, `hollow: true` makes a box shell (simple shelter: hollow 5×4×5 box, then break one block for a door).
- A quick shelter for the night: about 60–80 dirt or cobblestone.
- To get onto a roof or out of a hole, `go_to` handles climbing when blocks are available.

## Storage & items
- `deposit_items` / `withdraw_items` / `view_container` work on the nearest chest unless coordinates are given.
- To hand items to a player use `give_item`. To discard, `drop_item`.
- The inventory has 36 slots; check `check_inventory` before long gathering trips.

## Animals & farming
- "Harvest the crops" / "farm": `harvest_crops` (optionally `crop: "wheat"`). It only takes ripe crops, replants, and keeps going until nothing ripe is left. Don't use `collect_block` on crops; it would destroy unripe ones.
- If it reports crops still growing, say so; they need time (or bone meal via `use_item_on_block`).
- New farm: till dirt within 4 blocks of water with a hoe (`use_item_on_block`), then `plant_seeds`. Seeds come from breaking grass (`collect_block short_grass`).
- Breed with `interact_entity` holding food: cows/sheep → wheat, pigs → carrot/potato, chickens → seeds. Two adults needed.
- Shear sheep (shears = 2 iron_ingot) for wool, or kill them. Milk cows with a bucket.

## Communication
- Keep chat short (one or two sentences). For long tasks, a brief progress `say` every few steps is welcome.
- When you are done, reply with a short final summary — it is sent to chat automatically, so don't also `say` the same thing.
- If a request is impossible or unclear, say what's missing or ask a short question.

## When stuck
