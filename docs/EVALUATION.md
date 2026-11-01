# Evaluation on real commits

We ran doppeldiff on **21 historical commits from 8 well-known TypeScript/JavaScript libraries**: bug fixes
(where we know a behavior change happened) and refactors (where it should not). This page reports what it
found, what it missed and why, including the misses that are fundamental to the approach.

Everything here is reproducible: `npm run build && scripts/evaluate.sh`. Raw JSON reports are in
[`evaluation/`](evaluation/): `before-tuning/`, `heldout-frozen/` and `results/` (final version).

## Method

- For each commit: `doppeldiff --base <commit>^ --head <commit> --claim "<commit subject>" --runs 1000 --seed 1`.
  Defaults otherwise (250 ms per-call timeout, frozen clock), **no dependency install**, no LLM.
- A bug fix counts as **found** if doppeldiff reports at least one behavior difference that is the fix (judged by
  reading the diff and the commit's tests). "Unchanged" on a refactor counts as **correct**.
- **Tuning set vs held-out set.** We first ran 8 commits (ufo, validator.js, defu), looked at the misses, and
  improved the input generators (see below). Then we ran 13 **new** commits from 5 other libraries with the code
  frozen. After seeing the held-out misses we added one more generator (regex-derived strings). We report the
  held-out numbers from the frozen version as the headline, and the later numbers separately, because they are
  no longer held out.

## Headline numbers

|                                                                            | Commits | Behavioral bug fixes found       | Not verifiable (out of v1 scope) |
| -------------------------------------------------------------------------- | ------- | -------------------------------- | -------------------------------- |
| Tuning set, before tuning                                                  | 8       | 2 of 7                           | 0                                |
| Tuning set, after tuning (before regex inputs)                             | 8       | 4 of 7 (5 of 7 at 10,000 inputs) | 0                                |
| Tuning set, final version                                                  | 8       | 5 of 7                           | 0                                |
| **Held-out set, frozen version**                                           | 13      | **2 of 6**                       | 5 commits                        |
| Held-out set, final version (regex inputs added after seeing these misses) | 13      | 4 of 6                           | 5 commits                        |
| **All 21, final version**                                                  | 21      | **9 of 13**                      | 5 commits                        |

Refactors: 2. One correctly reported as "no behavior change" across 6 functions (defu). For the other one (semver),
the report is a true difference that only happens on inputs semver never passes (details below).

Speed: every run took **1–6 seconds** at 1,000 inputs per function (median ≈ 2 s; the largest repo, es-toolkit with
~2,000 TypeScript files, ≈ 5 s, mostly change detection).

## Results per commit

### Tuning set (ufo, validator.js, defu)

| Commit                                                                                         | Change                                            | Before tuning             | Final                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [unjs/ufo@5cd9e67](https://github.com/unjs/ufo/commit/5cd9e67)                                 | `withoutBase`: collapse leading slashes           | ❌ miss                   | ✅ `withoutBase("///", "//")` old `"//"`, new `"/"` (the protocol-relative URL the fix is about)                  |
| [unjs/ufo@eb29945](https://github.com/unjs/ufo/commit/eb29945)                                 | `withBase`/`withoutBase`: no false prefix matches | ✅                        | ✅ `withBase("a1", "a")` old `"a1"`, new `"a/a1"`                                                                 |
| [unjs/ufo@6cd1fcd](https://github.com/unjs/ufo/commit/6cd1fcd)                                 | `withoutTrailingSlash` with query string          | ❌ miss                   | ✅ `withoutTrailingSlash("_?/", true)` old `"/?/"`, new `"_?/"`                                                   |
| [validatorjs/validator.js@7d42ed2](https://github.com/validatorjs/validator.js/commit/7d42ed2) | `isByteLength`: unpaired UTF-16 surrogates        | ❌ miss                   | ✅ `isByteLength("\ud800", …)` old throws `URIError`, new `true`; also reported through `isEmail`, which calls it |
| [validatorjs/validator.js@a38f15b](https://github.com/validatorjs/validator.js/commit/a38f15b) | `isISO8601`: ordinal day 360                      | ❌ miss                   | ❌ miss                                                                                                           |
| [validatorjs/validator.js@941db7f](https://github.com/validatorjs/validator.js/commit/941db7f) | `isSlug`: restrict allowed characters             | ✅                        | ✅ `isSlug("a")` old `false`, new `true`                                                                          |
| [unjs/defu@11ba022](https://github.com/unjs/defu/commit/11ba022)                               | ignore inherited enumerable properties            | ❌ miss (exports skipped) | ❌ miss (now tested, but see below)                                                                               |
| [unjs/defu@e458b63](https://github.com/unjs/defu/commit/e458b63)                               | refactor `isPlainObject`                          | ✅ no change              | ✅ no change in 6 functions                                                                                       |

The `isSlug` result is worth a closer look. The commit title says "restrict allowed characters", but the new
regex also accepts **one- and two-character slugs**, which were rejected before. The commit's own tests add `'f'`
and `'fo'` as valid, so the change was intended, but a reviewer reading only the title would not know. This is
exactly the kind of difference doppeldiff is meant to surface.

### Held-out set (es-toolkit, change-case, ms, slugify, semver)

| Commit                                                                                       | Change                                       | Frozen version                                                              | Final                                        |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| [toss/es-toolkit@69a4fd1a](https://github.com/toss/es-toolkit/commit/69a4fd1a)               | `startCase`: only uppercase the first letter | ✅ `startCase("𐖗")` old `"𐖗"`, new `"𐕰"` (the astral-plane part of the fix) | ✅ same                                      |
| [toss/es-toolkit@2950de59](https://github.com/toss/es-toolkit/commit/2950de59)               | `clone`: preserve `DataView` offset/length   | ❌ miss                                                                     | ❌ miss                                      |
| [blakeembrey/change-case@976fa36](https://github.com/blakeembrey/change-case/commit/976fa36) | title case: words starting with numbers      | ✅ `titleCase("0a")` old `"0A"`, new `"0a"`                                 | ✅ same                                      |
| [blakeembrey/change-case@59d762f](https://github.com/blakeembrey/change-case/commit/59d762f) | sentence case: acronyms                      | ❌ miss                                                                     | ❌ miss                                      |
| [vercel/ms@2669f23](https://github.com/vercel/ms/commit/2669f23)                             | negative decimals below -10                  | ❌ miss                                                                     | ✅ `ms("-00.2")` old `undefined`, new `-0.2` |
| [vercel/ms@f0bc0a2](https://github.com/vercel/ms/commit/f0bc0a2)                             | negative numbers in the parse regex          | ❌ miss                                                                     | ✅ `ms("-6")` old `undefined`, new `-6`      |
| [toss/es-toolkit@ee2676d1](https://github.com/toss/es-toolkit/commit/ee2676d1)               | `findLast`/`some` on array-likes             | ⏭️ not verified: overloaded functions                                       | ⏭️ same                                      |
| [simov/slugify@f7a91b6](https://github.com/simov/slugify/commit/f7a91b6)                     | strict mode trimming                         | ⏭️ not verified: UMD module¹                                                | ⏭️ same                                      |
| [simov/slugify@8d8c538](https://github.com/simov/slugify/commit/8d8c538)                     | case of Ę, Ī, Ķ, Ū                           | ⏭️ not verified: UMD module¹                                                | ⏭️ same                                      |
| [npm/node-semver@bea6028](https://github.com/npm/node-semver/commit/bea6028)                 | increment dotted prerelease identifiers      | ⏭️ not verified: class methods                                              | ⏭️ same                                      |
| [npm/node-semver@e583226](https://github.com/npm/node-semver/commit/e583226)                 | reject numeric segments after x-ranges       | ⏭️ not verified: class methods                                              | ⏭️ same                                      |
| [toss/es-toolkit@be30b1bd](https://github.com/toss/es-toolkit/commit/be30b1bd)               | `merge`: type-level fix                      | n/a (only types changed; nothing to run)                                    | n/a                                          |
| [npm/node-semver@e37e0ca](https://github.com/npm/node-semver/commit/e37e0ca)                 | "faster paths for compare" (refactor)        | ⚠️ difference outside the real domain                                       | ⚠️ same                                      |

¹ In the frozen version, the UMD modules were reported as "no changed exported functions", which was **silently
wrong**. The final version lists them as "not verified" instead. That fix changes reporting only, not detection.

`change-case@976fa36` also reported a second behavior: `titleCase("0", "")` returns `"0"` before and now throws
`RangeError: Incorrect locale information provided`, because the new code calls `toLocaleUpperCase` with the
(invalid) empty locale. The difference is real; whether it matters depends on whether callers can pass `""`.

`semver@e37e0ca` adds a fast path for numeric identifiers. doppeldiff reports
`compareIdentifiers(-1, 0)`: old `1`, new `-1`. The difference is real, but semver only ever passes non-negative
numbers or strings. To a reviewer this is noise. You can remove it by declaring the input domain in
`doppeldiff.config.ts` (`args`), but out of the box it is a false alarm.

## Why the misses happen

| Miss                               | Cause                                                                                                                                        | Fixable?                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `isISO8601` ordinal day 360        | Needs a valid ISO date in ordinal form (`2009-360`) plus a specific code path; random and regex-shaped strings do not hit it in 1,000 tries. | Partly: LLM-suggested inputs are designed for this (not evaluated, no API key in this run). Coverage-guided generation is on the roadmap. |
| defu inherited properties          | The bug needs objects with enumerable properties on their **prototype**. doppeldiff generates plain data.                                    | Possible as a generator option; out of scope for v1.                                                                                      |
| es-toolkit `DataView`              | `DataView` is not a generated type.                                                                                                          | Yes, by adding the type.                                                                                                                  |
| change-case sentence-case acronyms | Needs text like `"i.e. foo"` together with `{ sentenceCase: true }` mid-sentence.                                                            | Hard for random generation; LLM suggestions or grammar-based generation.                                                                  |

Not verifiable in v1 (5 of 13 held-out commits): **class methods** (semver), **overloaded functions**
(es-toolkit compat), and **UMD/IIFE modules** (slugify). They are listed explicitly in every report. Class methods
are the largest gap and the first roadmap item.

## What we changed during evaluation

All changes are general (none mention a specific library). The tuning set showed four gaps:

1. **Related string arguments.** URL/path functions only behave differently when one argument is a prefix of
   another (`withoutBase("/a//b", "/a")`). Strings are now also composed from a shared pool of fragments (string
   literals from the code plus `/ // ? # & = : .`), so arguments often share prefixes.
2. **UTF-16 edge cases.** Lone surrogates, combining marks, zero-width characters and BOMs are now generated
   explicitly; uniformly random code points almost never hit them.
3. **Untyped options objects.** Objects for `any`/JavaScript parameters now use the property names the code
   reads (`options.min`, destructured names) as keys.
4. **Callable values.** `export const defu = createDefu()` was skipped as "not a function". Values whose type has
   a single call signature are now tested.

After the held-out run:

5. **Regex-derived inputs.** Strings matching the regex literals in the changed code (lookarounds removed, `i`
   flag dropped). This is what found both `ms` fixes. It was developed after seeing those misses, so those two
   finds are reported separately above.

We also found and fixed a performance problem: change detection on es-toolkit took 13 s because the TypeScript
program was rebuilt once per analyzed file. It now takes 2.7 s.

## Performance

| Run                                                                                  | Wall time | Breakdown                                                                                             |
| ------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------- |
| Real commits above (1,000 inputs/function)                                           | 1–6 s     | detection 0.7–3.2 s, verification 0.5–2 s                                                             |
| Demo AI refactor, Action settings (10,000 inputs/function, 60 s budget), 3 functions | 6.3 s     | verification 4.7 s                                                                                    |
| Demo pure refactor, Action settings, 4 functions                                     | 7.4 s     | `addBusinessDays` stopped after 242 inputs because of repeated timeouts on huge `days` values (5.0 s) |

Measured on a 4-CPU Linux container, Node 22. GitHub Actions additionally spends about 10–20 s on
`npm ci --omit=dev` for the action itself (not included above). The budget of < 60 s for ≤ 10 functions holds
with a wide margin on these examples; functions that loop for a long time on large inputs are the main risk.

## Not evaluated

- **The LLM layer** (claim matching and input suggestions). There was no API key in the evaluation environment.
  Its plumbing is tested against mock servers, but the quality of its labels on real PRs is unmeasured.
- **The GitHub Action on real GitHub** (artifacts, `workflow_run`, comments). Its logic is tested with fakes.
- **Monorepos with pnpm or yarn workspaces** (only npm workspaces are tested).
