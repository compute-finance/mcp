# Changelog

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
