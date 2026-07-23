# @cat-factory/provider-s3

## 0.2.200

### Patch Changes

- Updated dependencies [15249df]
  - @cat-factory/kernel@0.153.0

## 0.2.199

### Patch Changes

- Updated dependencies [2323df1]
  - @cat-factory/kernel@0.152.0

## 0.2.198

### Patch Changes

- Updated dependencies [71bd63f]
  - @cat-factory/kernel@0.151.0

## 0.2.197

### Patch Changes

- Updated dependencies [3c7d62b]
  - @cat-factory/kernel@0.150.0

## 0.2.196

### Patch Changes

- Updated dependencies [916278b]
  - @cat-factory/kernel@0.149.0

## 0.2.195

### Patch Changes

- Updated dependencies [1bcb223]
  - @cat-factory/kernel@0.148.5

## 0.2.194

### Patch Changes

- Updated dependencies [91ea6b7]
  - @cat-factory/kernel@0.148.4

## 0.2.193

### Patch Changes

- Updated dependencies [3999941]
  - @cat-factory/kernel@0.148.3

## 0.2.192

### Patch Changes

- Updated dependencies [021f2a0]
- Updated dependencies [021f2a0]
  - @cat-factory/kernel@0.148.2

## 0.2.191

### Patch Changes

- @cat-factory/kernel@0.148.1

## 0.2.190

### Patch Changes

- Updated dependencies [8053837]
  - @cat-factory/kernel@0.148.0

## 0.2.189

### Patch Changes

- Updated dependencies [511076d]
  - @cat-factory/kernel@0.147.3

## 0.2.188

### Patch Changes

- Updated dependencies [7f54858]
  - @cat-factory/kernel@0.147.2

## 0.2.187

### Patch Changes

- Updated dependencies [492d0a2]
  - @cat-factory/kernel@0.147.1

## 0.2.186

### Patch Changes

- Updated dependencies [a10bfdf]
  - @cat-factory/kernel@0.147.0

## 0.2.185

### Patch Changes

- Updated dependencies [f2b25ba]
  - @cat-factory/kernel@0.146.0

## 0.2.184

### Patch Changes

- @cat-factory/kernel@0.145.1

## 0.2.183

### Patch Changes

- Updated dependencies [9450415]
  - @cat-factory/kernel@0.145.0

## 0.2.182

### Patch Changes

- Updated dependencies [54c44bb]
  - @cat-factory/kernel@0.144.0

## 0.2.181

### Patch Changes

- Updated dependencies [0abcf31]
- Updated dependencies [6709dc4]
- Updated dependencies [a53bbf7]
  - @cat-factory/kernel@0.143.0

## 0.2.180

### Patch Changes

- Updated dependencies [5771e05]
  - @cat-factory/kernel@0.142.0

## 0.2.179

### Patch Changes

- Updated dependencies [f34ddf1]
  - @cat-factory/kernel@0.141.0

## 0.2.178

### Patch Changes

- Updated dependencies [6ad20d0]
  - @cat-factory/kernel@0.140.1

## 0.2.177

### Patch Changes

- Updated dependencies [9b3b85e]
  - @cat-factory/kernel@0.140.0

## 0.2.176

### Patch Changes

- efa3345: chore(deps): in-range dependency sweep + transitive upgrade and dedupe

  Update all dependencies within their existing semver ranges across the
  workspace (including the harness packages), run a transitive upgrade and
  `pnpm dedupe`, and re-adopt `@modular-vue/journeys@1.2.0` now that its neutral
  engine (`@modular-frontend/journeys-engine@1.8.0`) is published.

  - The Vercel AI SDK stays on `ai@6` / `@ai-sdk/*@3`: the newest
    `workers-ai-provider` (3.3.1) still peer-requires `ai@^6`, so a v7 bump
    remains blocked (moves within the pinned majors only).
  - `@modular-frontend/core` is pinned to a single `0.3.0` via a pnpm override:
    the 1.8.0 journeys engine hard-depends on `0.3.0` while the sibling
    `@modular-vue/*` bindings still range `^0.2.0`, which otherwise bundles two
    copies and splits the `JourneyRuntime` type. 0.3.0 is a strict superset
    (adds `discard`). Drop the override once the bindings widen their peer range.
  - `@cat-factory/executor-harness` runtime deps (`hono`, `@hono/node-server`)
    moved within range, so the runner-image tag is bumped and the three pins are
    re-synced (image publish/deploy is a maintainer follow-up).

- Updated dependencies [efa3345]
  - @cat-factory/kernel@0.139.3

## 0.2.175

### Patch Changes

- @cat-factory/kernel@0.139.2

## 0.2.174

### Patch Changes

- Updated dependencies [7c3d245]
  - @cat-factory/kernel@0.139.1

## 0.2.173

### Patch Changes

- Updated dependencies [bae59a7]
  - @cat-factory/kernel@0.139.0

## 0.2.172

### Patch Changes

- @cat-factory/kernel@0.138.1

## 0.2.171

### Patch Changes

- Updated dependencies [c47dfe1]
  - @cat-factory/kernel@0.138.0

## 0.2.170

### Patch Changes

- @cat-factory/kernel@0.137.1

## 0.2.169

### Patch Changes

- Updated dependencies [74c21ab]
  - @cat-factory/kernel@0.137.0

## 0.2.168

### Patch Changes

- Updated dependencies [f5ddc02]
- Updated dependencies [576f2e0]
  - @cat-factory/kernel@0.136.0

## 0.2.167

### Patch Changes

- Updated dependencies [720539f]
  - @cat-factory/kernel@0.135.0

## 0.2.166

### Patch Changes

- @cat-factory/kernel@0.134.1

## 0.2.165

### Patch Changes

- Updated dependencies [32a0720]
- Updated dependencies [54e117e]
- Updated dependencies [be6e109]
  - @cat-factory/kernel@0.134.0

## 0.2.164

### Patch Changes

- Updated dependencies [6564507]
  - @cat-factory/kernel@0.133.0

## 0.2.163

### Patch Changes

- Updated dependencies [b12d7a8]
  - @cat-factory/kernel@0.132.0

## 0.2.162

### Patch Changes

- Updated dependencies [5b1cbbf]
  - @cat-factory/kernel@0.131.0

## 0.2.161

### Patch Changes

- Updated dependencies [1869ad3]
  - @cat-factory/kernel@0.130.0

## 0.2.160

### Patch Changes

- @cat-factory/kernel@0.129.2

## 0.2.159

### Patch Changes

- Updated dependencies [6108525]
  - @cat-factory/kernel@0.129.1

## 0.2.158

### Patch Changes

- Updated dependencies [995249b]
  - @cat-factory/kernel@0.129.0

## 0.2.157

### Patch Changes

- @cat-factory/kernel@0.128.1

## 0.2.156

### Patch Changes

- Updated dependencies [d68e3a8]
- Updated dependencies [b414f34]
  - @cat-factory/kernel@0.128.0

## 0.2.155

### Patch Changes

- Updated dependencies [a552283]
  - @cat-factory/kernel@0.127.0

## 0.2.154

### Patch Changes

- Updated dependencies [55cae97]
  - @cat-factory/kernel@0.126.0

## 0.2.153

### Patch Changes

- Updated dependencies [f7e7139]
- Updated dependencies [5fa0a8e]
  - @cat-factory/kernel@0.125.0

## 0.2.152

### Patch Changes

- Updated dependencies [e5cd022]
  - @cat-factory/kernel@0.124.0

## 0.2.151

### Patch Changes

- Updated dependencies [6c4bcef]
  - @cat-factory/kernel@0.123.3

## 0.2.150

### Patch Changes

- Updated dependencies [2ce396d]
  - @cat-factory/kernel@0.123.2

## 0.2.149

### Patch Changes

- Updated dependencies [2c7ca2e]
  - @cat-factory/kernel@0.123.1

## 0.2.148

### Patch Changes

- Updated dependencies [e4c5abe]
  - @cat-factory/kernel@0.123.0

## 0.2.147

### Patch Changes

- Updated dependencies [1e684b7]
- Updated dependencies [1e684b7]
  - @cat-factory/kernel@0.122.0

## 0.2.146

### Patch Changes

- Updated dependencies [2a13ece]
  - @cat-factory/kernel@0.121.8

## 0.2.145

### Patch Changes

- Updated dependencies [3ce997d]
  - @cat-factory/kernel@0.121.7

## 0.2.144

### Patch Changes

- Updated dependencies [67dccb6]
  - @cat-factory/kernel@0.121.6

## 0.2.143

### Patch Changes

- f8f1aa8: Update workspace dependencies (direct + transitive) to the newest versions published before the
  `minimumReleaseAge` supply-chain cutoff. No source changes — dependency ranges + the lockfile only.

  - Refreshed direct deps to their newest cooldown-compliant releases: `wrangler` 4.110.0, `hono`
    4.12.29, `vitest` / `@vitest/coverage-v8` 4.1.10, `oxlint` 1.73.0, `knip` 6.26.0, `msw` 2.15.0,
    `pg-boss` 12.26.0, `sherif` 1.13.0, `turbo` 2.10.4, `vue-tsc` 3.3.7, `@types/node` 26.1.1,
    `@nuxtjs/i18n` 10.4.1, `@aws-sdk/client-s3` 3.1085.0.
  - `typescript` moved off the `7.0.1-rc` prerelease to the stable `7.0.2` release across every
    package that used the RC (the TS-6 world — the frontend layer and the two runner harnesses —
    stays on `^6.0.3`).
  - Vercel AI SDK family held to the `ai@6`-compatible majors that `workers-ai-provider@3.3.1` peers
    require (`ai` 6.0.224, `@ai-sdk/anthropic|openai|provider` on 3.x, `@ai-sdk/openai-compatible` on
    2.x, `@ai-sdk/amazon-bedrock` 4.x) — no v7/v5 major bumps.
  - Coding (`executor-harness`) and deploy runner harnesses updated too, including the pinned
    in-container coding-agent CLIs (Pi 0.80.6, Claude Code 2.1.207, Codex 0.144.1; the Pi todo /
    web-tools extensions stay at their lockstep 1.20.0). Their image tags and the three
    hand-maintained pins were bumped in lockstep, so the runner images must be re-published +
    deployed for the new tags to roll out.

- Updated dependencies [f8f1aa8]
  - @cat-factory/kernel@0.121.5

## 0.2.142

### Patch Changes

- Updated dependencies [4810353]
  - @cat-factory/kernel@0.121.4

## 0.2.141

### Patch Changes

- Updated dependencies [edad6e6]
  - @cat-factory/kernel@0.121.3

## 0.2.140

### Patch Changes

- @cat-factory/kernel@0.121.2

## 0.2.139

### Patch Changes

- Updated dependencies [473e849]
  - @cat-factory/kernel@0.121.1

## 0.2.138

### Patch Changes

- Updated dependencies [f4482c7]
  - @cat-factory/kernel@0.121.0

## 0.2.137

### Patch Changes

- Updated dependencies [22a4d9e]
  - @cat-factory/kernel@0.120.0

## 0.2.136

### Patch Changes

- Updated dependencies [a5dcf7d]
  - @cat-factory/kernel@0.119.0

## 0.2.135

### Patch Changes

- @cat-factory/kernel@0.118.1

## 0.2.134

### Patch Changes

- Updated dependencies [4f936de]
  - @cat-factory/kernel@0.118.0

## 0.2.133

### Patch Changes

- Updated dependencies [127fe3e]
  - @cat-factory/kernel@0.117.6

## 0.2.132

### Patch Changes

- Updated dependencies [774908c]
  - @cat-factory/kernel@0.117.5

## 0.2.131

### Patch Changes

- Updated dependencies [08a7da2]
  - @cat-factory/kernel@0.117.4

## 0.2.130

### Patch Changes

- Updated dependencies [6b968bb]
  - @cat-factory/kernel@0.117.3

## 0.2.129

### Patch Changes

- Updated dependencies [eeadc97]
  - @cat-factory/kernel@0.117.2

## 0.2.128

### Patch Changes

- Updated dependencies [cb7fd14]
  - @cat-factory/kernel@0.117.1

## 0.2.127

### Patch Changes

- Updated dependencies [be54a32]
  - @cat-factory/kernel@0.117.0

## 0.2.126

### Patch Changes

- Updated dependencies [51869b8]
  - @cat-factory/kernel@0.116.0

## 0.2.125

### Patch Changes

- Updated dependencies [a51a498]
  - @cat-factory/kernel@0.115.1

## 0.2.124

### Patch Changes

- Updated dependencies [b83bcc8]
- Updated dependencies [b83bcc8]
- Updated dependencies [a0c6934]
  - @cat-factory/kernel@0.115.0

## 0.2.123

### Patch Changes

- Updated dependencies [0f3c88b]
  - @cat-factory/kernel@0.114.0

## 0.2.122

### Patch Changes

- Updated dependencies [ed77be6]
  - @cat-factory/kernel@0.113.0

## 0.2.121

### Patch Changes

- Updated dependencies [7ee2530]
  - @cat-factory/kernel@0.112.1

## 0.2.120

### Patch Changes

- Updated dependencies [f25d5e2]
  - @cat-factory/kernel@0.112.0

## 0.2.119

### Patch Changes

- @cat-factory/kernel@0.111.1

## 0.2.118

### Patch Changes

- Updated dependencies [63f7881]
  - @cat-factory/kernel@0.111.0

## 0.2.117

### Patch Changes

- Updated dependencies [bcc843d]
  - @cat-factory/kernel@0.110.1

## 0.2.116

### Patch Changes

- Updated dependencies [a2db337]
  - @cat-factory/kernel@0.110.0

## 0.2.115

### Patch Changes

- Updated dependencies [8319e52]
  - @cat-factory/kernel@0.109.1

## 0.2.114

### Patch Changes

- Updated dependencies [8728bf7]
- Updated dependencies [7157908]
  - @cat-factory/kernel@0.109.0

## 0.2.113

### Patch Changes

- Updated dependencies [f1906cb]
  - @cat-factory/kernel@0.108.0

## 0.2.112

### Patch Changes

- Updated dependencies [44fafa4]
  - @cat-factory/kernel@0.107.0

## 0.2.111

### Patch Changes

- Updated dependencies [89c861a]
  - @cat-factory/kernel@0.106.0

## 0.2.110

### Patch Changes

- Updated dependencies [2d97812]
- Updated dependencies [b35e1a0]
  - @cat-factory/kernel@0.105.0

## 0.2.109

### Patch Changes

- @cat-factory/kernel@0.104.4

## 0.2.108

### Patch Changes

- @cat-factory/kernel@0.104.3

## 0.2.107

### Patch Changes

- Updated dependencies [bc77f89]
  - @cat-factory/kernel@0.104.2

## 0.2.106

### Patch Changes

- @cat-factory/kernel@0.104.1

## 0.2.105

### Patch Changes

- Updated dependencies [37d1517]
  - @cat-factory/kernel@0.104.0

## 0.2.104

### Patch Changes

- Updated dependencies [14eac27]
  - @cat-factory/kernel@0.103.0

## 0.2.103

### Patch Changes

- Updated dependencies [ecbcbec]
  - @cat-factory/kernel@0.102.0

## 0.2.102

### Patch Changes

- @cat-factory/kernel@0.101.2

## 0.2.101

### Patch Changes

- Updated dependencies [10787c4]
  - @cat-factory/kernel@0.101.1

## 0.2.100

### Patch Changes

- Updated dependencies [f596090]
  - @cat-factory/kernel@0.101.0

## 0.2.99

### Patch Changes

- Updated dependencies [9ea1e77]
  - @cat-factory/kernel@0.100.0

## 0.2.98

### Patch Changes

- @cat-factory/kernel@0.99.1

## 0.2.97

### Patch Changes

- Updated dependencies [1afa003]
  - @cat-factory/kernel@0.99.0

## 0.2.96

### Patch Changes

- Updated dependencies [bf31df7]
  - @cat-factory/kernel@0.98.0

## 0.2.95

### Patch Changes

- Updated dependencies [6f9d935]
  - @cat-factory/kernel@0.97.0

## 0.2.94

### Patch Changes

- Updated dependencies [5490103]
- Updated dependencies [dd6df12]
  - @cat-factory/kernel@0.96.0

## 0.2.93

### Patch Changes

- Updated dependencies [accb8ec]
  - @cat-factory/kernel@0.95.0

## 0.2.92

### Patch Changes

- Updated dependencies [cd435d1]
  - @cat-factory/kernel@0.94.0

## 0.2.91

### Patch Changes

- 77bc73c: Update dependencies to the latest versions within the supply-chain release-age
  window. The Vercel AI SDK family stays within the `ai@6` / `@ai-sdk/*` majors
  that `workers-ai-provider@^3` peers require (`ai@6.0.219`,
  `@ai-sdk/anthropic@3.0.92`, `@ai-sdk/openai@3.0.80`,
  `@ai-sdk/openai-compatible@2.0.56`, `@ai-sdk/provider@3.0.13`,
  `@ai-sdk/amazon-bedrock@4.0.128`). Other bumps include `@hono/node-server`,
  `pg-boss`, `undici`, `markdown-it`, `@aws-sdk/client-s3`, `@clack/prompts`,
  `@types/node`, and eligible transitive dependencies. `@cloudflare/workers-types`
  is held at `4.x` because `wrangler@4` peers on `^4`.
- Updated dependencies [77bc73c]
- Updated dependencies [076d02f]
  - @cat-factory/kernel@0.93.0

## 0.2.90

### Patch Changes

- Updated dependencies [029a689]
  - @cat-factory/kernel@0.92.0

## 0.2.89

### Patch Changes

- Updated dependencies [2e4d883]
  - @cat-factory/kernel@0.91.0

## 0.2.88

### Patch Changes

- Updated dependencies [773695b]
  - @cat-factory/kernel@0.90.0

## 0.2.87

### Patch Changes

- @cat-factory/kernel@0.89.1

## 0.2.86

### Patch Changes

- Updated dependencies [cfcb6c7]
  - @cat-factory/kernel@0.89.0

## 0.2.85

### Patch Changes

- Updated dependencies [f4c321e]
  - @cat-factory/kernel@0.88.0

## 0.2.84

### Patch Changes

- Updated dependencies [13a284f]
  - @cat-factory/kernel@0.87.0

## 0.2.83

### Patch Changes

- @cat-factory/kernel@0.86.1

## 0.2.82

### Patch Changes

- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
- Updated dependencies [c20a69a]
- Updated dependencies [49b498a]
- Updated dependencies [49b498a]
  - @cat-factory/kernel@0.86.0

## 0.2.81

### Patch Changes

- Updated dependencies [1f6d9fc]
  - @cat-factory/kernel@0.85.0

## 0.2.80

### Patch Changes

- Updated dependencies [e5ddaa4]
  - @cat-factory/kernel@0.84.0

## 0.2.79

### Patch Changes

- Updated dependencies [9bac054]
  - @cat-factory/kernel@0.83.0

## 0.2.78

### Patch Changes

- Updated dependencies [6c1efd1]
  - @cat-factory/kernel@0.82.0

## 0.2.77

### Patch Changes

- Updated dependencies [6edcce0]
  - @cat-factory/kernel@0.81.0

## 0.2.76

### Patch Changes

- Updated dependencies [ef57cb1]
  - @cat-factory/kernel@0.80.0

## 0.2.75

### Patch Changes

- @cat-factory/kernel@0.79.1

## 0.2.74

### Patch Changes

- Updated dependencies [47a2975]
  - @cat-factory/kernel@0.79.0

## 0.2.73

### Patch Changes

- Updated dependencies [b928904]
  - @cat-factory/kernel@0.78.0

## 0.2.72

### Patch Changes

- Updated dependencies [7fa7578]
  - @cat-factory/kernel@0.77.0

## 0.2.71

### Patch Changes

- Updated dependencies [55661f4]
  - @cat-factory/kernel@0.76.0

## 0.2.70

### Patch Changes

- Updated dependencies [ca5c3e8]
  - @cat-factory/kernel@0.75.0

## 0.2.69

### Patch Changes

- Updated dependencies [b216fdc]
  - @cat-factory/kernel@0.74.0

## 0.2.68

### Patch Changes

- Updated dependencies [7fd6a19]
  - @cat-factory/kernel@0.73.0

## 0.2.67

### Patch Changes

- Updated dependencies [0ac0dc4]
  - @cat-factory/kernel@0.72.0

## 0.2.66

### Patch Changes

- Updated dependencies [36f4cf6]
- Updated dependencies [b78adf5]
  - @cat-factory/kernel@0.71.0

## 0.2.65

### Patch Changes

- Updated dependencies [e0aab3f]
  - @cat-factory/kernel@0.70.2

## 0.2.64

### Patch Changes

- Updated dependencies [0d51638]
  - @cat-factory/kernel@0.70.1

## 0.2.63

### Patch Changes

- Updated dependencies [eb67d40]
  - @cat-factory/kernel@0.70.0

## 0.2.62

### Patch Changes

- @cat-factory/kernel@0.69.8

## 0.2.61

### Patch Changes

- Updated dependencies [7f9d215]
  - @cat-factory/kernel@0.69.7

## 0.2.60

### Patch Changes

- @cat-factory/kernel@0.69.6

## 0.2.59

### Patch Changes

- @cat-factory/kernel@0.69.5

## 0.2.58

### Patch Changes

- @cat-factory/kernel@0.69.4

## 0.2.57

### Patch Changes

- @cat-factory/kernel@0.69.3

## 0.2.56

### Patch Changes

- Updated dependencies [d7f6e1c]
- Updated dependencies [63cf6de]
  - @cat-factory/kernel@0.69.2

## 0.2.55

### Patch Changes

- Updated dependencies [120de05]
  - @cat-factory/kernel@0.69.1

## 0.2.54

### Patch Changes

- Updated dependencies [dcc8b32]
  - @cat-factory/kernel@0.69.0

## 0.2.53

### Patch Changes

- Updated dependencies [16ee6cc]
  - @cat-factory/kernel@0.68.1

## 0.2.52

### Patch Changes

- Updated dependencies [16621f8]
  - @cat-factory/kernel@0.68.0

## 0.2.51

### Patch Changes

- Updated dependencies [9b26ff1]
- Updated dependencies [e0aa45e]
- Updated dependencies [f70c273]
- Updated dependencies [6c51e31]
  - @cat-factory/kernel@0.67.0

## 0.2.50

### Patch Changes

- @cat-factory/kernel@0.66.1

## 0.2.49

### Patch Changes

- Updated dependencies [fb53662]
  - @cat-factory/kernel@0.66.0

## 0.2.48

### Patch Changes

- Updated dependencies [6f95aff]
  - @cat-factory/kernel@0.65.0

## 0.2.47

### Patch Changes

- Updated dependencies [3643708]
  - @cat-factory/kernel@0.64.0

## 0.2.46

### Patch Changes

- @cat-factory/kernel@0.63.4

## 0.2.45

### Patch Changes

- @cat-factory/kernel@0.63.3

## 0.2.44

### Patch Changes

- Updated dependencies [2e1354f]
  - @cat-factory/kernel@0.63.2

## 0.2.43

### Patch Changes

- @cat-factory/kernel@0.63.1

## 0.2.42

### Patch Changes

- Updated dependencies [f568a8c]
  - @cat-factory/kernel@0.63.0

## 0.2.41

### Patch Changes

- @cat-factory/kernel@0.62.4

## 0.2.40

### Patch Changes

- @cat-factory/kernel@0.62.3

## 0.2.39

### Patch Changes

- @cat-factory/kernel@0.62.2

## 0.2.38

### Patch Changes

- @cat-factory/kernel@0.62.1

## 0.2.37

### Patch Changes

- Updated dependencies [858799e]
  - @cat-factory/kernel@0.62.0

## 0.2.36

### Patch Changes

- @cat-factory/kernel@0.61.1

## 0.2.35

### Patch Changes

- Updated dependencies [15c5894]
  - @cat-factory/kernel@0.61.0

## 0.2.34

### Patch Changes

- Updated dependencies [f383515]
  - @cat-factory/kernel@0.60.0

## 0.2.33

### Patch Changes

- Updated dependencies [e4cddb4]
  - @cat-factory/kernel@0.59.0

## 0.2.32

### Patch Changes

- Updated dependencies [337d94d]
  - @cat-factory/kernel@0.58.0

## 0.2.31

### Patch Changes

- Updated dependencies [6009266]
  - @cat-factory/kernel@0.57.1

## 0.2.30

### Patch Changes

- Updated dependencies [1952d6b]
- Updated dependencies [1952d6b]
  - @cat-factory/kernel@0.57.0

## 0.2.29

### Patch Changes

- @cat-factory/kernel@0.56.1

## 0.2.28

### Patch Changes

- Updated dependencies [f9a173f]
  - @cat-factory/kernel@0.56.0

## 0.2.27

### Patch Changes

- Updated dependencies [fdeb466]
  - @cat-factory/kernel@0.55.4

## 0.2.26

### Patch Changes

- @cat-factory/kernel@0.55.3

## 0.2.25

### Patch Changes

- @cat-factory/kernel@0.55.2

## 0.2.24

### Patch Changes

- @cat-factory/kernel@0.55.1

## 0.2.23

### Patch Changes

- Updated dependencies [d5a0637]
- Updated dependencies [915861c]
  - @cat-factory/kernel@0.55.0

## 0.2.22

### Patch Changes

- Updated dependencies [48a3df6]
- Updated dependencies [48a3df6]
  - @cat-factory/kernel@0.54.0

## 0.2.21

### Patch Changes

- @cat-factory/kernel@0.53.1

## 0.2.20

### Patch Changes

- Updated dependencies [69558f9]
  - @cat-factory/kernel@0.53.0

## 0.2.19

### Patch Changes

- Updated dependencies [29d8b5d]
  - @cat-factory/kernel@0.52.0

## 0.2.18

### Patch Changes

- Updated dependencies [40f687d]
  - @cat-factory/kernel@0.51.0

## 0.2.17

### Patch Changes

- Updated dependencies [e0f1149]
  - @cat-factory/kernel@0.50.0

## 0.2.16

### Patch Changes

- Updated dependencies [fc324d2]
  - @cat-factory/kernel@0.49.0

## 0.2.15

### Patch Changes

- Updated dependencies [e3b3540]
  - @cat-factory/kernel@0.48.0

## 0.2.14

### Patch Changes

- @cat-factory/kernel@0.47.2

## 0.2.13

### Patch Changes

- @cat-factory/kernel@0.47.1

## 0.2.12

### Patch Changes

- Updated dependencies [4b5d267]
  - @cat-factory/kernel@0.47.0

## 0.2.11

### Patch Changes

- 8727f2b: Filesystem blob backend + UI-managed, per-account content storage.

  - New `FilesystemBinaryBlobBackend` (Node/local) stores binary artifacts (UI-tester
    screenshots, reference designs) on disk under a base path (default `.file-storage`,
    git-ignored). Added `'fs'` to `BinaryArtifactStorageKind`.
  - Content-storage configuration moves entirely into the UI, scoped per **account**
    (Account → Deployment settings), stored in `account_settings` (no DB migration; the
    S3 access keys are sealed in the existing secrets blob). The blob backend is now
    resolved per request/run from the account's settings via the new
    `makeResolveBinaryArtifactStore` seam (`@cat-factory/server`), replacing the static
    `binaryArtifactStore` on the container with a `resolveBinaryArtifactStore(workspaceId)`.
  - Available backends per runtime: **Node/local** offer `fs` / `s3` / `db`, **Cloudflare**
    offers `r2` only (S3 is deliberately not offered on the Worker — the AWS SDK does not belong
    in the Worker bundle). Defaults when an account hasn't configured storage: **local** defaults
    to the filesystem backend (works out of the box); **Node** defaults to off (storage requires
    explicit configuration); **Cloudflare** defaults to its R2 bucket.

  BREAKING: the env-var content-storage configuration is removed — `BINARY_STORAGE_BACKEND`,
  `S3_ARTIFACT_*`, and `AppConfig.binaryStorage`/`BinaryStorageConfig` no longer exist.
  Configure storage per-account in the UI instead. Switching an account's backend orphans its
  previously-stored artifacts (no migration of existing bytes), which is acceptable pre-1.0.

- Updated dependencies [764c05b]
- Updated dependencies [764c05b]
- Updated dependencies [8727f2b]
- Updated dependencies [56e6ce6]
  - @cat-factory/kernel@0.46.0

## 0.2.10

### Patch Changes

- 8fad695: Update dependencies to latest.

  - `undici` 7→8 (test-only `MockAgent`). undici's MockAgent must match Node's
    bundled undici to intercept the global `fetch`; Node 26 bundles undici 8.5.0,
    so the test runner / CI is pinned to **Node 26**. Production runtime is
    unaffected — `undici` is a dev/test dependency only, and the service still runs
    on any Node >=20 (e.g. the example `deploy/node` image stays on Node 24).
  - Minor/patch bumps: `wrangler` 4.105, `@cloudflare/*`, `@types/node` 26.0.1,
    `vue` 3.5.39, `msw` 2.14.6, `valibot` 1.4.2, `workers-ai-provider` 3.2.1,
    `@toad-contracts/*` (core 0.4.0, valibot 0.5.0, hono/testing/http-client 0.3.2),
    `@aws-sdk/client-s3` 3.1075.
  - The AI SDK (`ai`, `@ai-sdk/*`) is intentionally held at v6 / v3-v4: the latest
    `workers-ai-provider` (3.2.1, the Cloudflare Workers AI provider) still peers on
    `ai@^6` / `@ai-sdk/provider@^3` and is not yet compatible with `ai` v7.
  - Pinned the whole Vue runtime family to one version via a pnpm `override`
    (`vue` + `@vue/*` → 3.5.39). Bumping `vue` to 3.5.39 left Nuxt 4.4.8's
    transitive deps pinning parts of the graph to 3.5.38, so two copies of Vue were
    bundled into the SPA; Vue's render internals are module-level singletons, so the
    second copy crashed the app on boot (`Cannot read properties of null (reading
'ce')` in `renderSlot`) — a blank 500 page that hung the whole e2e suite. One
    version = one singleton.
  - GitHub Actions: `actions/checkout` v6→v7, `pnpm/action-setup` v6.0.9,
    `zizmorcore/zizmor-action` v0.5.7, `changesets/action` pinned to v1.9.0. CI Node 24→26.

- Updated dependencies [8fad695]
  - @cat-factory/kernel@0.45.5

## 0.2.9

### Patch Changes

- @cat-factory/kernel@0.45.4

## 0.2.8

### Patch Changes

- Updated dependencies [ab146e5]
  - @cat-factory/kernel@0.45.3

## 0.2.7

### Patch Changes

- c11a0cc: Republish with the compiled `dist/` payload. A prior `pnpm publish` ran without a build
  step, so the tarball shipped as an empty shell (only `package.json`, no `dist/`) and the
  package could not be imported. A `prepublishOnly` build hook now guarantees the package is
  compiled before it is packed, regardless of how publish is invoked.
- Updated dependencies [c11a0cc]
  - @cat-factory/kernel@0.45.2

## 0.2.6

### Patch Changes

- Updated dependencies [5363166]
  - @cat-factory/kernel@0.45.1

## 0.2.5

### Patch Changes

- Updated dependencies [eab73b8]
  - @cat-factory/kernel@0.45.0

## 0.2.4

### Patch Changes

- Updated dependencies [e641417]
  - @cat-factory/kernel@0.44.0

## 0.2.3

### Patch Changes

- Updated dependencies [bbafec9]
- Updated dependencies [bbafec9]
  - @cat-factory/kernel@0.43.0

## 0.2.2

### Patch Changes

- @cat-factory/kernel@0.42.2

## 0.2.1

### Patch Changes

- Updated dependencies [d1027ec]
  - @cat-factory/kernel@0.42.1

## 0.2.0

### Minor Changes

- 32c653f: Add a runtime-neutral binary-artifact storage abstraction (the foundation for the
  visual-confirmation gate's UI screenshots + reference design images).

  - New kernel port `BinaryArtifactStore` with a split, mix-and-match seam: a per-runtime
    `BinaryArtifactMetadataStore` (the queryable metadata) + a pluggable `BinaryBlobBackend`
    (the bytes — the "custom adapter interface"), composed by `createBinaryArtifactStore`.
  - Adapters: D1 metadata + R2 blob backend (Cloudflare — D1 can't hold large values, so
    bytes always go to R2); Drizzle/Postgres metadata + a Postgres `bytea` blob backend
    (Node/local, size-guarded); and a new opt-in `@cat-factory/provider-s3` package
    implementing the blob backend over an S3 (or S3-compatible) bucket.
  - Metadata table `binary_artifacts` mirrored D1 ⇄ Drizzle; a Node-only
    `binary_artifact_blobs` `bytea` table backs the `db` backend (no D1 equivalent).
  - `AppConfig.binaryStorage` selects the backend (`db` | `r2` | `s3`); wired in all three
    facades and surfaced on the request container. New workspace-scoped artifact API
    (upload reference / stream blob / list a run's artifacts). Cross-runtime conformance
    suite `defineBinaryArtifactsSuite` asserts store parity on both runtimes.

### Patch Changes

- 32c653f: Review round 4 (visual-confirmation gate / binary artifacts):

  - **Don't load the AWS SDK unless S3 is actually used.** `@cat-factory/provider-s3` now imports
    `@aws-sdk/client-s3` lazily (on the first S3 operation) instead of at module load, so a
    Node/local deployment running the `db` (or no) blob backend no longer pays the SDK's load cost
    even though the facade statically imports `S3BinaryBlobBackend` to wire its container.
  - **Guard Approve when the gate flags its screenshots as unreliable.** The visual-confirmation
    window now requires an explicit "I've reviewed this manually" acknowledgement before Approve is
    enabled whenever the gate set a `degradedReason` (no capture happened, a fix failed, or a fix
    landed AFTER the shown screenshots) — so a stale/empty gallery can't be approved in one blind
    click.
  - **Cheaper per-run upload cap.** The harness screenshot ingest precheck uses an indexed
    `countByExecution` (no row materialise) and only runs the post-insert overflow reconcile when the
    insert could actually cross the cap, so the steady-state upload is one COUNT + one insert.
  - **Serve a blob in a single metadata read** via `BinaryArtifactStore.getBlobWithMetadata`.
  - **Drop dangling screenshot refs.** The gate validates the agent-reported screenshot `artifactId`s
    against what the run actually uploaded, so a fabricated id or one removed by the retention sweep
    renders as "not captured" rather than a 404 image.
  - Make the UI-tester prompt honest: it now only instructs an upload when `ARTIFACT_UPLOAD_URL` is
    provided to the run (manual mode otherwise), and treats the reference-design directory as
    optional.

  The new `countByExecution` / `getBlobWithMetadata` store methods are mirrored D1 ⇄ Drizzle and
  asserted by the cross-runtime binary-artifacts conformance suite.

- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
- Updated dependencies [32c653f]
  - @cat-factory/kernel@0.42.0
