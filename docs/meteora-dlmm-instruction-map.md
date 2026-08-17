# Meteora DLMM Instruction Map (Complete — 71 Instructions)

Source: `https://github.com/MeteoraAg/dlmm-sdk/main/idls/dlmm.json`
Program ID: `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
Generated: 2026-03-09

## Classification Legend

| Category | Description | Copy-Trading Relevance |
|----------|-------------|----------------------|
| **MUST** | Core LP operations (Open/Close/Add/Remove/Fee) | Required for copy-trading |
| **OPTIONAL** | Rebalance, rewards | Nice-to-have |
| **SKIP-SWAP** | Swap instructions | Bot uses Jupiter, not program swap |
| **SKIP-ADMIN** | Admin/Init pool/Config | Not relevant for copy-trading |
| **SKIP-INTERNAL** | Migration, internal bookkeeping | Not relevant |

---

## MUST — Core LP Instructions (Copy-Trading Required)

| # | Instruction | Discriminator (hex) | Args | Notes |
|---|------------|---------------------|------|-------|
| 36 | `initialize_position` | `dbc0ea47bebf6650` | lower_bin_id: i32, width: i32 | v1 — open new position |
| 37 | `initialize_position2` | `8f13f291d50f6873` | lower_bin_id: i32, width: i32 | v2 — preferred |
| 39 | `initialize_position_pda` | `2e527d92558de499` | lower_bin_id: i32, width: i32 | PDA-based position |
| 38 | `initialize_position_by_operator` | `fbbdbef475fe2394` | lower_bin_id: i32, width: i32, fee_owner: pubkey, lock_release_point: u64 | Operator-managed position |
| 15 | `close_position` | `7b86510031446262` | (none) | v1 — close position (same disc as Orca!) |
| 16 | `close_position2` | `ae5a2373ba2893e2` | (none) | v2 |
| 17 | `close_position_if_empty` | `3b7cd4765b986e9d` | (none) | Close only if no liquidity left |
| 1 | `add_liquidity` | `b59d59438fb63448` | LiquidityParameter | v1 — add liquidity (bin amounts + distribution) |
| 2 | `add_liquidity2` | `e4a24e1c46db7473` | LiquidityParameter, RemainingAccountsInfo | v2 — preferred |
| 3 | `add_liquidity_by_strategy` | `0703967f94283dc8` | LiquidityParameterByStrategy | v1 — strategy-based (Spot/Curve/BidAsk) |
| 4 | `add_liquidity_by_strategy2` | `03dd95da6f8d76d5` | LiquidityParameterByStrategy, RemainingAccountsInfo | v2 — preferred |
| 5 | `add_liquidity_by_strategy_one_side` | `2905eeaf64e106cd` | LiquidityParameterByStrategyOneSide | One-sided strategy add |
| 6 | `add_liquidity_by_weight` | `1c8cee63e7a21595` | LiquidityParameterByWeight | Weight-based distribution |
| 7 | `add_liquidity_one_side` | `5e9b6797465fdca5` | LiquidityOneSideParameter | One-sided add |
| 8 | `add_liquidity_one_side_precise` | `a1c26754ab47fa9a` | AddLiquiditySingleSidePreciseParameter | Precise one-sided |
| 9 | `add_liquidity_one_side_precise2` | `2133a3c975627de7` | AddLiquiditySingleSidePreciseParameter2, RemainingAccountsInfo | v2 precise one-sided |
| 48 | `remove_liquidity` | `5055d14818ceb16c` | vec\<BinLiquidityReduction\> | v1 — remove by bin |
| 49 | `remove_liquidity2` | `e6d7527ff165e392` | vec\<BinLiquidityReduction\>, RemainingAccountsInfo | v2 — preferred |
| 50 | `remove_liquidity_by_range` | `1a526698f04a691a` | from_bin_id: i32, to_bin_id: i32, bps_to_remove: u16 | Remove by range + BPS |
| 51 | `remove_liquidity_by_range2` | `cc02c391359191cd` | from_bin_id: i32, to_bin_id: i32, bps_to_remove: u16, RemainingAccountsInfo | v2 — preferred |
| 47 | `remove_all_liquidity` | `0a333d2370691855` | (none) | Remove 100% liquidity |
| 10 | `claim_fee` | `a9204f8988e84689` | (none) | v1 — claim trading fees |
| 11 | `claim_fee2` | `70bf65ab1c907fbb` | min_bin_id: i32, max_bin_id: i32, RemainingAccountsInfo | v2 — preferred |

**Total MUST: 23 instructions**

---

## OPTIONAL — Rebalance & Rewards

| # | Instruction | Discriminator (hex) | Args | Notes |
|---|------------|---------------------|------|-------|
| 46 | `rebalance_liquidity` | `5c04b0c177b95309` | RebalanceLiquidityParams, RemainingAccountsInfo | Atomic rebalance (remove+add) |
| 12 | `claim_reward` | `955fb5f25e5a9ea2` | reward_index: u64 | v1 — claim LP rewards |
| 13 | `claim_reward2` | `be037f77b2579db7` | reward_index: u64, min_bin_id: i32, max_bin_id: i32, RemainingAccountsInfo | v2 |
| 66 | `update_fees_and_rewards` | `9ae6fa0decd14bdf` | (none) | v1 — sync fee/reward state |
| 65 | `update_fees_and_reward2` | `208eb89a6741b858` | min_bin_id: i32, max_bin_id: i32 | v2 |
| 22 | `decrease_position_length` | `c2db882019606925` | length_to_remove: u16, side: u8 | Shrink bin range |
| 27 | `increase_position_length` | `505375d3420d2195` | length_to_add: u16, side: u8 | v1 — expand bin range |
| 28 | `increase_position_length2` | `ffd2cc477389e171` | minimum_upper_bin_id: i32 | v2 — expand range |
| 67 | `update_position_operator` | `cab8678fb4bf74d9` | operator: pubkey | Change position operator |

**Total OPTIONAL: 9 instructions**

---

## SKIP-SWAP — Swap Instructions (Bot Uses Jupiter)

| # | Instruction | Discriminator (hex) | Args | Notes |
|---|------------|---------------------|------|-------|
| 57 | `swap` | `f8c69e91e17587c8` | amount_in: u64, min_amount_out: u64 | v1 |
| 58 | `swap2` | `414b3f4ceb5b5b88` | amount_in: u64, min_amount_out: u64, RemainingAccountsInfo | v2 |
| 59 | `swap_exact_out` | `fa49652126cf4bb8` | max_in_amount: u64, out_amount: u64 | Exact output swap v1 |
| 60 | `swap_exact_out2` | `2bd7f784893cf351` | max_in_amount: u64, out_amount: u64, RemainingAccountsInfo | v2 |
| 61 | `swap_with_price_impact` | `38ade6d0ade49ccd` | amount_in: u64, active_id: Option\<i32\>, max_price_impact_bps: u16 | Price impact limit v1 |
| 62 | `swap_with_price_impact2` | `4a62c0d6b1334b33` | amount_in: u64, active_id: Option\<i32\>, max_price_impact_bps: u16, RemainingAccountsInfo | v2 |

**Total SKIP-SWAP: 6 instructions**

---

## SKIP-ADMIN — Pool Init, Config, Admin

| # | Instruction | Discriminator (hex) | Args | Notes |
|---|------------|---------------------|------|-------|
| 33 | `initialize_lb_pair` | `2d9aedd2dd0fa65c` | active_id: i32, bin_step: u16 | Create pool v1 |
| 34 | `initialize_lb_pair2` | `493b2478ed536cc6` | InitializeLbPair2Params | Create pool v2 |
| 31 | `initialize_customizable_permissionless_lb_pair` | `2e2729876fb7c840` | CustomizableParams | Permissionless pool v1 |
| 32 | `initialize_customizable_permissionless_lb_pair2` | `f349817e3313f16b` | CustomizableParams | Permissionless pool v2 |
| 35 | `initialize_permission_lb_pair` | `6c66d555fb033515` | InitPermissionPairIx | Permission-gated pool |
| 29 | `initialize_bin_array` | `235613b94ed44bd3` | index: i64 | Init bin array account |
| 30 | `initialize_bin_array_bitmap_extension` | `2f9de2b40cf02147` | (none) | Init bitmap extension |
| 40 | `initialize_preset_parameter` | `42bc47d3626d0eba` | InitPresetParametersIx | v1 preset |
| 41 | `initialize_preset_parameter2` | `b807f0ab672fb779` | InitPresetParameters2Ix | v2 preset |
| 18 | `close_preset_parameter` | `04949164861ab53d` | (none) | v1 |
| 19 | `close_preset_parameter2` | `27195f6b7411731c` | (none) | v2 |
| 42 | `initialize_reward` | `5f87c0c4f281e644` | reward_index, reward_duration, funder | Setup reward emission |
| 43 | `initialize_token_badge` | `fd4dcd5f1be059df` | (none) | Token badge init |
| 20 | `close_token_badge` | `6c92566eb3fe0a68` | (none) | Close token badge |
| 21 | `create_claim_protocol_fee_operator` | `331396fc699d305b` | (none) | Create fee operator |
| 14 | `close_claim_protocol_fee_operator` | `082957235030791a` | (none) | Close fee operator |
| 24 | `fund_reward` | `bc32f9a55d97263f` | reward_index, amount, carry_forward, RemainingAccountsInfo | Fund reward pool |
| 52 | `set_activation_point` | `5bf90fa51a81fe7d` | activation_point: u64 | Set pool activation |
| 53 | `set_pair_status` | `43f8e7899a95d9ae` | status: u8 | Set pool status |
| 54 | `set_pair_status_permissionless` | `4e3b98d346b72ed0` | status: u8 | Permissionless status |
| 55 | `set_pre_activation_duration` | `a53dc9f4829f1664` | pre_activation_duration: u64 | Pre-activation config |
| 56 | `set_pre_activation_swap_address` | `398b2f7bd850df0a` | pre_activation_swap_address: pubkey | Pre-activation swap addr |
| 63 | `update_base_fee_parameters` | `4ba8dfa110c3032f` | BaseFeeParameter | Update base fee |
| 64 | `update_dynamic_fee_parameters` | `5ca12ef6ffbd1616` | DynamicFeeParameter | Update dynamic fee |
| 68 | `update_reward_duration` | `8aaec4a9d5ebfe6b` | reward_index, new_duration | Update reward duration |
| 69 | `update_reward_funder` | `d31c3020d7a02317` | reward_index, new_funder | Update reward funder |
| 25 | `go_to_a_bin` | `9248aee028fd54ae` | bin_id: i32 | Move active bin |
| 26 | `increase_oracle_length` | `be3d7d57674f9ead` | length_to_add: u64 | Expand oracle |
| 70 | `withdraw_ineligible_reward` | `94ce2ac3f7316708` | reward_index, RemainingAccountsInfo | Withdraw ineligible reward |
| 71 | `withdraw_protocol_fee` | `9ec99ebd215da267` | max_amount_x, max_amount_y, RemainingAccountsInfo | Withdraw protocol fee |

**Total SKIP-ADMIN: 30 instructions**

---

## SKIP-INTERNAL — Migration & Misc

| # | Instruction | Discriminator (hex) | Args | Notes |
|---|------------|---------------------|------|-------|
| 44 | `migrate_bin_array` | `11179fd365b829f1` | (none) | Migrate bin array format |
| 45 | `migrate_position` | `0f843b32c706fb2e` | (none) | Migrate position format |
| 23 | `for_idl_type_generation_do_not_call` | `b46945505f32496c` | DummyIx | IDL placeholder — never called |

**Total SKIP-INTERNAL: 3 instructions**

---

## Summary

| Category | Count | Details |
|----------|-------|---------|
| **MUST** (core LP) | 23 | 4 open + 3 close + 9 add + 5 remove + 2 claim_fee |
| **OPTIONAL** (rebalance/rewards) | 9 | 1 rebalance + 2 claim_reward + 2 update_fees + 3 position length + 1 operator |
| **SKIP-SWAP** | 6 | 6 swap variants |
| **SKIP-ADMIN** | 30 | Pool init, config, admin |
| **SKIP-INTERNAL** | 3 | Migration, IDL dummy |
| **Total** | **71** | |

---

## Cross-DEX Comparison

| Operation | Byreal (Raydium CLMM) | Orca Whirlpool | Meteora DLMM |
|-----------|----------------------|----------------|---------------|
| Open Position | `openPosition` | `openPosition` | `initialize_position` / `initialize_position2` |
| Close Position | `closePosition` | `closePosition` (disc: `7b86510031446262`) | `close_position` (disc: `7b86510031446262` — SAME!) |
| Add Liquidity | `increaseLiquidity` | `increaseLiquidity` | `add_liquidity2` / `add_liquidity_by_strategy2` |
| Remove Liquidity | `decreaseLiquidity` | `decreaseLiquidity` | `remove_liquidity2` / `remove_all_liquidity` |
| Claim Fees | `chain.collectFees()` | `collectFees` | `claim_fee` / `claim_fee2` |
| Rebalance | Manual (close+open) | Manual | `rebalance_liquidity` (atomic!) |

### Key Differences from Orca/Byreal
1. **Bin-based** (not tick-based) — positions defined by `lower_bin_id` + `width` (number of bins)
2. **Multiple add strategies** — Spot/Curve/BidAsk/Weight/OneSide/Precise (9 variants!)
3. **Atomic rebalance** — single instruction to remove+add liquidity
4. **`close_position` discriminator identical to Orca** — `7b86510031446262` — parser must check program ID
5. **v1/v2 pattern** — v2 adds `RemainingAccountsInfo` for Token-2022 support
6. **No "increase/decrease" naming** — uses "add_liquidity" / "remove_liquidity" instead

---

## Parser Priority (Discriminators to Match)

For the TX parser, these are the discriminators to match (in order of importance):

```typescript
const METEORA_DLMM_DISCRIMINATORS: Record<string, string> = {
  // Open Position
  'dbc0ea47bebf6650': 'initialize_position',
  '8f13f291d50f6873': 'initialize_position2',
  '2e527d92558de499': 'initialize_position_pda',
  'fbbdbef475fe2394': 'initialize_position_by_operator',

  // Close Position
  '7b86510031446262': 'close_position',
  'ae5a2373ba2893e2': 'close_position2',
  '3b7cd4765b986e9d': 'close_position_if_empty',

  // Add Liquidity (all 9 variants)
  'b59d59438fb63448': 'add_liquidity',
  'e4a24e1c46db7473': 'add_liquidity2',
  '0703967f94283dc8': 'add_liquidity_by_strategy',
  '03dd95da6f8d76d5': 'add_liquidity_by_strategy2',
  '2905eeaf64e106cd': 'add_liquidity_by_strategy_one_side',
  '1c8cee63e7a21595': 'add_liquidity_by_weight',
  '5e9b6797465fdca5': 'add_liquidity_one_side',
  'a1c26754ab47fa9a': 'add_liquidity_one_side_precise',
  '2133a3c975627de7': 'add_liquidity_one_side_precise2',

  // Remove Liquidity (all 5 variants)
  '5055d14818ceb16c': 'remove_liquidity',
  'e6d7527ff165e392': 'remove_liquidity2',
  '1a526698f04a691a': 'remove_liquidity_by_range',
  'cc02c391359191cd': 'remove_liquidity_by_range2',
  '0a333d2370691855': 'remove_all_liquidity',

  // Claim Fees
  'a9204f8988e84689': 'claim_fee',
  '70bf65ab1c907fbb': 'claim_fee2',

  // Optional: Rebalance
  '5c04b0c177b95309': 'rebalance_liquidity',

  // Optional: Claim Rewards
  '955fb5f25e5a9ea2': 'claim_reward',
  'be037f77b2579db7': 'claim_reward2',
};
```
