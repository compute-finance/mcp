# Changelog

## [0.7.0](https://github.com/compute-finance/mcp/compare/v0.6.2...v0.7.0) (2026-07-20)


### Features

* price catalog-only models in compute_estimate and data_get_price ([#44](https://github.com/compute-finance/mcp/issues/44)) ([7bcb136](https://github.com/compute-finance/mcp/commit/7bcb13651157e7e4a34b86092615274621f5d570))

## [0.6.2](https://github.com/compute-finance/mcp/compare/v0.6.1...v0.6.2) (2026-07-08)


### Tests

* harden smoke against basket rotation and drop non-smoke checks ([#42](https://github.com/compute-finance/mcp/issues/42)) ([d91d2e5](https://github.com/compute-finance/mcp/commit/d91d2e5df127cb8cc02c6f0053faf3ba04b85270))

## [0.6.1](https://github.com/compute-finance/mcp/compare/v0.6.0...v0.6.1) (2026-07-06)


### Bug Fixes

* format overhead total in SCU units, not raw tokens ([#38](https://github.com/compute-finance/mcp/issues/38)) ([f33e075](https://github.com/compute-finance/mcp/commit/f33e075ea8dc5acf1ea52cf3fd75939afacd237d))

## [0.6.0](https://github.com/compute-finance/mcp/compare/v0.5.0...v0.6.0) (2026-07-02)


### ⚠ BREAKING CHANGES

* drop `integrated` field from oracle basket and catalog outputs ([#36](https://github.com/compute-finance/mcp/issues/36))

### Features

* drop `integrated` field from oracle basket and catalog outputs ([#36](https://github.com/compute-finance/mcp/issues/36)) ([4d468a2](https://github.com/compute-finance/mcp/commit/4d468a2e5bc008f91d2529607c1d78e2a0eec53b))

## [0.5.0](https://github.com/compute-finance/mcp/compare/v0.4.0...v0.5.0) (2026-06-26)


### Features

* add an SCU position section to the session report ([#32](https://github.com/compute-finance/mcp/issues/32)) ([a4df944](https://github.com/compute-finance/mcp/commit/a4df944172f06169d5344700d2fde35ed81191bc))
* lead prompt-submit hook with SCU and cache savings ([#27](https://github.com/compute-finance/mcp/issues/27)) ([4b11556](https://github.com/compute-finance/mcp/commit/4b11556a23bef7dd03eeadd24a3d55b0832ae0a8))
* resolve models via oracle API and flag off-basket sessions ([#34](https://github.com/compute-finance/mcp/issues/34)) ([4fa0951](https://github.com/compute-finance/mcp/commit/4fa0951758c85a97518d0fed1e2a790a80bd271c))
* show context overhead per inference in the session report ([#30](https://github.com/compute-finance/mcp/issues/30)) ([123fdc4](https://github.com/compute-finance/mcp/commit/123fdc4d240ad547d2439f19740554ea4f4aa0d2))
* show four-way token split and context footprint in reports ([#28](https://github.com/compute-finance/mcp/issues/28)) ([17a985d](https://github.com/compute-finance/mcp/commit/17a985df9dc347e44c260ff9e251f75bb42d7111))
* show model list prices as a × index ladder in the session report ([#33](https://github.com/compute-finance/mcp/issues/33)) ([195eb77](https://github.com/compute-finance/mcp/commit/195eb77ff931a92b2f4f22dfb1ef42a9ab7381d9))
* show savings % and exclude current session from history median ([#29](https://github.com/compute-finance/mcp/issues/29)) ([cf5f9fb](https://github.com/compute-finance/mcp/commit/cf5f9fbefb22f8c3d3ca40407eefc403faccbd86))


### Code Refactoring

* split block helpers into per-concern modules ([#31](https://github.com/compute-finance/mcp/issues/31)) ([0cd76a4](https://github.com/compute-finance/mcp/commit/0cd76a4f5606e714ed5fe5dd12a746f8b6a7fa54))

## [0.4.0](https://github.com/compute-finance/mcp/compare/v0.3.0...v0.4.0) (2026-06-17)


### ⚠ BREAKING CHANGES

* family-keyed basket and methodology-versioned breakdown ([#20](https://github.com/compute-finance/mcp/issues/20))
* source cache pricing exclusively from the oracle ([#19](https://github.com/compute-finance/mcp/issues/19))

### Features

* add data_get_baseline tool, surface computeIndex in data_get_scu ([#23](https://github.com/compute-finance/mcp/issues/23)) ([7188749](https://github.com/compute-finance/mcp/commit/718874930869960accf552f08492e02b6799090b))
* add data_get_catalog and data_get_model_price_at tools ([#22](https://github.com/compute-finance/mcp/issues/22)) ([27b040a](https://github.com/compute-finance/mcp/commit/27b040a25e77bf7e390ea18bd2fa048a239e525e))
* add data_get_history and data_get_model_price_history tools ([#21](https://github.com/compute-finance/mcp/issues/21)) ([28f8f86](https://github.com/compute-finance/mcp/commit/28f8f861f0549f36953635b75e877d8b185bec9d))
* add data_get_methodology tool, read version dynamically ([#17](https://github.com/compute-finance/mcp/issues/17)) ([90d61f7](https://github.com/compute-finance/mcp/commit/90d61f7a22dacfd85716f5bc083a5a66933817d3))
* add data_get_scu_at tool ([#24](https://github.com/compute-finance/mcp/issues/24)) ([390bb0d](https://github.com/compute-finance/mcp/commit/390bb0d48b7e3f796980151a4fa34d452c253309))
* family-keyed basket and methodology-versioned breakdown ([#20](https://github.com/compute-finance/mcp/issues/20)) ([8055512](https://github.com/compute-finance/mcp/commit/805551280ea6abcfca183215dd055b1acf75f7b1))
* source cache pricing exclusively from the oracle ([#19](https://github.com/compute-finance/mcp/issues/19)) ([c66491a](https://github.com/compute-finance/mcp/commit/c66491a6a2db025ffd69d5db2b322001f67cebc2))

## [0.3.0](https://github.com/compute-finance/mcp/compare/v0.2.0...v0.3.0) (2026-06-01)


### Features

* split MCP turn counter into prompts/inferences/tool_calls ([#11](https://github.com/compute-finance/mcp/issues/11)) ([5ed411c](https://github.com/compute-finance/mcp/commit/5ed411ca83cf3cacb1ff6a858e56d014d8a55d08))


### Bug Fixes

* add data source and parameter examples to MCP tool descriptions (CF-233) ([#5](https://github.com/compute-finance/mcp/issues/5)) ([b1bd726](https://github.com/compute-finance/mcp/commit/b1bd7262a73448ab1b81a46c5d025c7e0d68bf9e))


### Documentation

* add MIT license note to CONTRIBUTING.md (CF-468) ([#8](https://github.com/compute-finance/mcp/issues/8)) ([e267080](https://github.com/compute-finance/mcp/commit/e26708026bc9a93f41b5b9c3d7b615a5ad47cd12))


### Tests

* add live smoke tests and CI workflow for MCP tools ([#9](https://github.com/compute-finance/mcp/issues/9)) ([dab5463](https://github.com/compute-finance/mcp/commit/dab546343bf524ec344c391fdff80f6ac016bc4f))
* add regression tests for MCP isError error paths (CF-330) ([#6](https://github.com/compute-finance/mcp/issues/6)) ([bcbc85c](https://github.com/compute-finance/mcp/commit/bcbc85cdf17013a3f696f16bbb3d3ce137aed79a))
