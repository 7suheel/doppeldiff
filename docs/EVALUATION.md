# Evaluation on real commits

We ran doppeldiff on **39 historical commits from 17 well-known TypeScript/JavaScript libraries**: bug fixes
(where we know a behavior change happened) and refactors (where it should not). This page reports what it
found, what it missed and why, including the misses that are fundamental to the approach.

**Headline: on the newest held-out set (18 commits from 9 libraries, code frozen before the run), doppeldiff
found 3 of 13 verifiable bug fixes.** That is lower than on the earlier sets, and it is the honest number. After
fixing the tool bugs that set exposed, it finds 7 of 15; those later numbers are no longer held out.

Everything here is reproducible: `npm run build && scripts/evaluate.sh`. Raw JSON reports are in
[`evaluation/`](evaluation/): `before-tuning/`, `heldout-frozen/`, `before-noise-reduction/` (the first 21
commits before the noise work), `results/` (first 21, current version), `heldout2-frozen/` and
`heldout2-final/` (the second held-out set).

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
- **Second held-out set.** After the noise-reduction and generator work below, we froze the code (commit
  `4b2d457`) and picked commits from 9 libraries not used before, by a rule fixed in advance: in each library,
  the 2 most recent commits whose subject says "fix" and that change source files (skipping docs, build and
  type-only fixes). All 18 are reported, whatever the outcome. Only qs has runtime dependencies; we installed
  them in the checkout (`npm install --ignore-scripts`), as a user's CI would.

## Headline numbers

**v0.1.1 re-run:** all 39 commits were re-run after the v0.1.1 changes (realistic sizes, timeouts that do not stop
exploration, compact values). For every function, the status (changed / unchanged / not verified) and the number
of behaviors are the same as before, and so is the realism grouping that decides the main list. One filesize
behavior now leads with an "ordinary" example instead of a "seen" one. Detection and precision are therefore
unchanged. Run times varied within machine noise. The raw reports in `results/` and `heldout2-final/` are from
this re-run.

|                                                                            | Commits | Behavioral bug fixes found       | Not verifiable (out of v1 scope) |
| -------------------------------------------------------------------------- | ------- | -------------------------------- | -------------------------------- |
| Tuning set, before tuning                                                  | 8       | 2 of 7                           | 0                                |
| Tuning set, after tuning (before regex inputs)                             | 8       | 4 of 7 (5 of 7 at 10,000 inputs) | 0                                |
| Tuning set, final version                                                  | 8       | 5 of 7                           | 0                                |
| **Held-out set, frozen version**                                           | 13      | **2 of 6**                       | 5 commits                        |
| Held-out set, final version (regex inputs added after seeing these misses) | 13      | 4 of 6                           | 5 commits                        |
| All 21, previous version                                                   | 21      | 9 of 13                          | 5 commits                        |
| All 21, current version (generator work below, developed on these misses)  | 21      | 11 of 13                         | 5 commits                        |
| **Second held-out set, frozen version**                                    | 18      | **3 of 13**                      | 5 commits                        |
| Second held-out set, after fixing the tool bugs it exposed                 | 18      | 7 of 15                          | 3 commits                        |

Refactors: 2. One correctly reported as "no behavior change" across 6 functions (defu). For the other one (semver),
the report is a true difference that only happens on inputs semver never passes (details below).

Speed: every run took **0.5–8 seconds** at 1,000 inputs per function (median ≈ 2 s; date-fns, the largest repo,
6–8 s, mostly change detection).

## Noise: how many reported differences matter

Every reported difference is real in the narrow sense: it reproduces when the two versions run on the same input.
The question is whether a reviewer would care. We count a behavior as **noise** when it only happens on inputs the
code never receives or when it is an artifact a reviewer would dismiss.

| First 21 commits                      | Behaviors reported | Real | Noise | Shown in the main list | Precision of the main list |
| ------------------------------------- | ------------------ | ---- | ----- | ---------------------- | -------------------------- |
| Before noise reduction                | 14                 | 11   | 3     | all 14                 | 11 / 14 = **79 %**         |
| After (usage mining, guards, realism) | 15                 | 12   | 3     | 11 (2 unusual, 2 edge) | 10 / 11 = **91 %**         |

Where the noise went:

- **semver `compareIdentifiers(-2, 0)`** (2 behaviors). semver's tests and call sites only use non-negative
  integers, so negative inputs are rated _unusual_. They are collapsed under "ℹ️ only on unusual inputs", and
  `--fail-on unclaimed` no longer fails on them.
- **change-case `titleCase("0", [""])`** (invalid empty locale): still in the main list. Nothing in the project
  says `""` is not a locale, and we did not add a rule for it.
- **validator.js `isByteLength("\ud800", …)`** is the real fix, but a lone surrogate is an _edge_ input by
  definition, so it is collapsed into the "edge-case inputs only" section. Realism ranking can hide a real fix
  whose whole point is an edge case; the section is still in the report and the label is still "claimed".
- One behavior disappeared: `ufo@eb29945` `withoutBase("  a", " ")`. It is hit by 1–2 of 1,000 inputs; the current
  version finds it with seeds 2–6 but not with seed 1. The commit is still found through `withBase`.

On the second held-out set (frozen), all 8 reported behaviors are real differences. Six are the fix itself; two
are side effects on odd inputs (decamelize with the separator `"0"`, path-to-regexp with an invalid pattern).
After the fixes, filesize's internal helpers are verified and add 11 behaviors on argument combinations the
public `filesize()` never passes. They are real, but mostly noise to a reviewer.

## Results per commit

### Tuning set (ufo, validator.js, defu)

| Commit                                                                                         | Change                                            | Before tuning             | Final                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [unjs/ufo@5cd9e67](https://github.com/unjs/ufo/commit/5cd9e67)                                 | `withoutBase`: collapse leading slashes           | ❌ miss                   | ✅ `withoutBase("///", "//")` old `"//"`, new `"/"` (the protocol-relative URL the fix is about)                  |
| [unjs/ufo@eb29945](https://github.com/unjs/ufo/commit/eb29945)                                 | `withBase`/`withoutBase`: no false prefix matches | ✅                        | ✅ `withBase("a1", "a")` old `"a1"`, new `"a/a1"`                                                                 |
| [unjs/ufo@6cd1fcd](https://github.com/unjs/ufo/commit/6cd1fcd)                                 | `withoutTrailingSlash` with query string          | ❌ miss                   | ✅ `withoutTrailingSlash("_?/", true)` old `"/?/"`, new `"_?/"`                                                   |
| [validatorjs/validator.js@7d42ed2](https://github.com/validatorjs/validator.js/commit/7d42ed2) | `isByteLength`: unpaired UTF-16 surrogates        | ❌ miss                   | ✅ `isByteLength("\ud800", …)` old throws `URIError`, new `true`; also reported through `isEmail`, which calls it |
| [validatorjs/validator.js@a38f15b](https://github.com/validatorjs/validator.js/commit/a38f15b) | `isISO8601`: ordinal day 360                      | ❌ miss                   | ✅ (current version) `isISO8601("1690360")` old `false`, new `true`                                               |
| [validatorjs/validator.js@941db7f](https://github.com/validatorjs/validator.js/commit/941db7f) | `isSlug`: restrict allowed characters             | ✅                        | ✅ `isSlug("a")` old `false`, new `true`                                                                          |
| [unjs/defu@11ba022](https://github.com/unjs/defu/commit/11ba022)                               | ignore inherited enumerable properties            | ❌ miss (exports skipped) | ❌ miss (now tested, but see below)                                                                               |
| [unjs/defu@e458b63](https://github.com/unjs/defu/commit/e458b63)                               | refactor `isPlainObject`                          | ✅ no change              | ✅ no change in 6 functions                                                                                       |

The `isSlug` result is worth a closer look. The commit title says "restrict allowed characters", but the new
regex also accepts **one- and two-character slugs**, which were rejected before. The commit's own tests add `'f'`
and `'fo'` as valid, so the change was intended, but a reviewer reading only the title would not know. This is
exactly the kind of difference doppeldiff is meant to surface.

### Held-out set (es-toolkit, change-case, ms, slugify, semver)

| Commit                                                                                       | Change                                       | Frozen version                                                              | Final                                                                                      |
| -------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [toss/es-toolkit@69a4fd1a](https://github.com/toss/es-toolkit/commit/69a4fd1a)               | `startCase`: only uppercase the first letter | ✅ `startCase("𐖗")` old `"𐖗"`, new `"𐕰"` (the astral-plane part of the fix) | ✅ same                                                                                    |
| [toss/es-toolkit@2950de59](https://github.com/toss/es-toolkit/commit/2950de59)               | `clone`: preserve `DataView` offset/length   | ❌ miss                                                                     | ✅ (current) `clone(new DataView(buf, 0, 0))` old: the whole buffer, new: the empty window |
| [blakeembrey/change-case@976fa36](https://github.com/blakeembrey/change-case/commit/976fa36) | title case: words starting with numbers      | ✅ `titleCase("0a")` old `"0A"`, new `"0a"`                                 | ✅ same                                                                                    |
| [blakeembrey/change-case@59d762f](https://github.com/blakeembrey/change-case/commit/59d762f) | sentence case: acronyms                      | ❌ miss                                                                     | ❌ miss at 1,000 inputs (found at 5,000)                                                   |
| [vercel/ms@2669f23](https://github.com/vercel/ms/commit/2669f23)                             | negative decimals below -10                  | ❌ miss                                                                     | ✅ `ms("-00.2")` old `undefined`, new `-0.2`                                               |
| [vercel/ms@f0bc0a2](https://github.com/vercel/ms/commit/f0bc0a2)                             | negative numbers in the parse regex          | ❌ miss                                                                     | ✅ `ms("-6")` old `undefined`, new `-6`                                                    |
| [toss/es-toolkit@ee2676d1](https://github.com/toss/es-toolkit/commit/ee2676d1)               | `findLast`/`some` on array-likes             | ⏭️ not verified: overloaded functions                                       | ⏭️ same                                                                                    |
| [simov/slugify@f7a91b6](https://github.com/simov/slugify/commit/f7a91b6)                     | strict mode trimming                         | ⏭️ not verified: UMD module¹                                                | ⏭️ same                                                                                    |
| [simov/slugify@8d8c538](https://github.com/simov/slugify/commit/8d8c538)                     | case of Ę, Ī, Ķ, Ū                           | ⏭️ not verified: UMD module¹                                                | ⏭️ same                                                                                    |
| [npm/node-semver@bea6028](https://github.com/npm/node-semver/commit/bea6028)                 | increment dotted prerelease identifiers      | ⏭️ not verified: class methods                                              | ⏭️ same                                                                                    |
| [npm/node-semver@e583226](https://github.com/npm/node-semver/commit/e583226)                 | reject numeric segments after x-ranges       | ⏭️ not verified: class methods                                              | ⏭️ same                                                                                    |
| [toss/es-toolkit@be30b1bd](https://github.com/toss/es-toolkit/commit/be30b1bd)               | `merge`: type-level fix                      | n/a (only types changed; nothing to run)                                    | n/a                                                                                        |
| [npm/node-semver@e37e0ca](https://github.com/npm/node-semver/commit/e37e0ca)                 | "faster paths for compare" (refactor)        | ⚠️ difference outside the real domain                                       | ⚠️ same                                                                                    |

¹ In the frozen version, the UMD modules were reported as "no changed exported functions", which was **silently
wrong**. The final version lists them as "not verified" instead. That fix changes reporting only, not detection.

`change-case@976fa36` also reported a second behavior: `titleCase("0", "")` returns `"0"` before and now throws
`RangeError: Incorrect locale information provided`, because the new code calls `toLocaleUpperCase` with the
(invalid) empty locale. The difference is real; whether it matters depends on whether callers can pass `""`.

`semver@e37e0ca` adds a fast path for numeric identifiers. doppeldiff reports
`compareIdentifiers(-1, 0)`: old `1`, new `-1`. The difference is real, but semver only ever passes non-negative
numbers or strings. To a reviewer this is noise. In the previous version it was a false alarm out of the box. The
current version sees that semver's tests and call sites only use non-negative integers, rates the input
_unusual_ and collapses it ("ℹ️ 2 behavior changes only on unusual inputs"); `--fail-on unclaimed` exits 0. You
can also declare the domain in `doppeldiff.config.ts` (`where`).

## Why the misses happen

### First 21 commits

| Miss                               | Cause                                                                                                                                                                             | Status                                                                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isISO8601` ordinal day 360        | The fix changes a regex stored in a module-level constant. Literals there were not mined, and the regex uses backreferences, which fast-check cannot generate from.               | **Found now**: module-level constants are mined, backreferences are inlined, and strings on which the old and new regex disagree are searched for directly (see below). |
| es-toolkit `DataView`              | `DataView` was not generated. Once it was, a second bug showed: Node's IPC delivers a view as a window into the whole message buffer, so the old `clone` looked nondeterministic. | **Found now**: binary values are generated (as windows into larger buffers) and sent to the runner as exact descriptors.                                                |
| defu inherited properties          | The commit's own test pollutes `Object.prototype`. The bug only shows with global prototype pollution; doppeldiff varies inputs, not global state.                                | Not fixable by design. Objects with inherited enumerable properties are now generated, but defu's `isPlainObject` rejects them before the changed loop.                 |
| change-case sentence-case acronyms | Needs a word like `é.ß.` after another word, plus `{ sentenceCase: true }`.                                                                                                       | Found at 5,000 inputs, not at 1,000. Regexes with `\p{…}` classes now generate readable letters, and regex samples are used as fragments of longer strings.             |

### Second held-out set (frozen version)

| Commit                                                                                           | Change                                                          | Frozen version                                                                                                                        | After fixes                                                                                                                                               |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [sindresorhus/pretty-bytes@4e800a3](https://github.com/sindresorhus/pretty-bytes/commit/4e800a3) | formatting edge cases, option validation                        | ✅ `prettyBytes(5e-324)` old `"5e-324 B"`, new plain digits; invalid `maximumFractionDigits` now a `TypeError`                        | ✅ same                                                                                                                                                   |
| [sindresorhus/pretty-bytes@5cb9c95](https://github.com/sindresorhus/pretty-bytes/commit/5cb9c95) | fraction digits without localization                            | ❌ needs ≥ 10²⁷ bytes plus a fraction-digit option (grouping only shows at ≥ 1000 YB)                                                 | ❌                                                                                                                                                        |
| [sodiray/radash@4cab190](https://github.com/sodiray/radash/commit/4cab190)                       | `set`/`construct`: keys starting with digits                    | ✅ `set({}, "items.123abc.name", "a")` old `{ items: [] }`, new `{ items: { "123abc": … } }`                                          | ✅ same (also for `src/object.ts#set`, which the frozen version marked nondeterministic, see below)                                                       |
| [sodiray/radash@c378bd1](https://github.com/sodiray/radash/commit/c378bd1)                       | `snake`: split numbers from letters                             | ✅ `snake("hello-world12_19-bye")` old `"hello_world12_19_bye"`, new `"hello_world_12_19_bye"`                                        | ✅ same                                                                                                                                                   |
| [visionmedia/bytes.js@581b2b5](https://github.com/visionmedia/bytes.js/commit/581b2b5)           | `parse`: `null` for unparsable strings                          | ❌ **silently wrong**: "no changed exported functions" (CommonJS export before the hoisted function was not recognized)               | ✅ `parse(" ")` old `NaN`, new `null`                                                                                                                     |
| [visionmedia/bytes.js@db70acb](https://github.com/visionmedia/bytes.js/commit/db70acb)           | `thousandsSeparator` in the fraction                            | ❌ same detection bug                                                                                                                 | ✅ `format(0, { decimalPlaces: 5, fixedDecimals: 1, thousandsSeparator: " " })` old `"0.00 000B"`, new `"0.00000B"`                                       |
| [avoidwork/filesize.js@109ae60](https://github.com/avoidwork/filesize.js/commit/109ae60)         | precision with the default locale                               | ⏭️ not verified: JSDoc `{Object}` parameters were "unsupported"                                                                       | ✅ on the internal helper `applyNumberFormatting` (string results are now coerced when `locale` is `true`); `filesize()` itself unchanged at 1,000 inputs |
| [avoidwork/filesize.js@f5bd84b](https://github.com/avoidwork/filesize.js/commit/f5bd84b)         | locale formatting when precision is set                         | ⏭️ same                                                                                                                               | ✅ same, helper level only                                                                                                                                |
| [sindresorhus/camelcase@97e8e40](https://github.com/sindresorhus/camelcase/commit/97e8e40)       | what counts as a digit run                                      | ❌ needs non-ASCII digits (`١foo`) or a separator right after digits, with specific options                                           | ❌                                                                                                                                                        |
| [sindresorhus/camelcase@3433c29](https://github.com/sindresorhus/camelcase/commit/3433c29)       | `preserveConsecutiveUppercase` + `capitalizeAfterNumber: false` | ❌ needs both options at once plus a capital after punctuation                                                                        | ❌                                                                                                                                                        |
| [sindresorhus/decamelize@5fb69c0](https://github.com/sindresorhus/decamelize/commit/5fb69c0)     | plural acronyms (`userIDs`)                                     | ❌ the fix itself was missed; reported a real side effect instead: `decamelize("aA", { separator: "0", … })` old `"a0A"`, new `"a0a"` | ❌ same                                                                                                                                                   |
| [sindresorhus/decamelize@0eb37b4](https://github.com/sindresorhus/decamelize/commit/0eb37b4)     | words with decomposed accents                                   | ❌ needs letter + combining mark + capital (`"cafe\u0301Menu"`)                                                                       | ❌                                                                                                                                                        |
| [pillarjs/path-to-regexp@762bc6b](https://github.com/pillarjs/path-to-regexp/commit/762bc6b)     | `:name*` matching                                               | ❌ only an error-message difference on an invalid pattern (`*`), not the matching change                                              | ❌                                                                                                                                                        |
| [pillarjs/path-to-regexp@7dd6f8f](https://github.com/pillarjs/path-to-regexp/commit/7dd6f8f)     | `stringify` across empty text tokens                            | ⏭️ not verified: parameter is a class instance (`TokenData`)                                                                          | ⏭️                                                                                                                                                        |
| [ljharb/qs@54f7f3b](https://github.com/ljharb/qs/commit/54f7f3b)                                 | `stringify` must not sort the caller's `filter`                 | ❌ needs a real `sort` comparator; generated functions return constants, so sorting never reorders                                    | ❌                                                                                                                                                        |
| [ljharb/qs@05a8755](https://github.com/ljharb/qs/commit/05a8755)                                 | `%2e` dots, case-insensitive                                    | ❌ needs `%2e` in a key together with `allowDots`/`decodeDotInKeys`                                                                   | ❌                                                                                                                                                        |
| [date-fns/date-fns@766dea98](https://github.com/date-fns/date-fns/commit/766dea98)               | Temporal start of ISO week year                                 | ⏭️ not verified: overloaded function (two dependents tested, unchanged)                                                               | ⏭️                                                                                                                                                        |
| [date-fns/date-fns@b9c5865e](https://github.com/date-fns/date-fns/commit/b9c5865e)               | Chinese locale month parsing                                    | ⏭️ not verified: the changed exports are objects built by a factory, not functions                                                    | ⏭️                                                                                                                                                        |

The pattern in the misses: most need **two or three specific things at once** (an option combination plus a
particular shape of text), or a **real function argument** (a comparator). Random generation with mined values
rarely hits those in 1,000 inputs. The planned fixes are coverage-guided generation and, optionally, inputs suggested by
a local LLM (supported, not evaluated here).

Not verifiable in v1: **class methods** (semver), **overloaded functions** (es-toolkit compat, date-fns),
**UMD/IIFE modules** (slugify), **class-instance parameters** (path-to-regexp) and **exported values that are
not functions** (date-fns locales). They are listed explicitly in every report.

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

After the first 21 (noise reduction and detection, before the second held-out set):

6. **Real usage.** Literal arguments at call sites and literals in the function's tests run first and bias
   generation; values from test assertions' expected side are excluded.
7. **Input realism.** Every counterexample is rated _seen_ (values from tests/call sites), _ordinary_, _unusual_
   (outside the domain the tests and call sites use, e.g. negative when all observed numbers are ≥ 0) or _edge_
   (NaN, ±Infinity, -0, huge or tiny magnitudes, lone surrogates, control characters, invalid dates). Reports
   lead with realistic behaviors; edge-only behaviors are collapsed. Guard clauses of the old version
   (`if (n < 0) throw …`) make out-of-domain inputs rare, and `where` in the config declares a strict domain.
8. **Module-level constants** the function reads are mined (regexes, tables).
9. **Regex differences.** When a regex changed, strings on which the old and new regex disagree are searched
   for (samples of both regexes plus one-character mutations). Backreferences are inlined and `\p{…}` classes
   approximated so more regexes can be generated from.
10. **Binary data and inherited properties.** `DataView`, `ArrayBuffer` and typed arrays (as types and for untyped
    parameters) and objects with inherited enumerable properties.

After the second held-out set (tool bugs it exposed; general fixes):

11. CommonJS `module.exports = fn; module.exports.parse = parse` written before the hoisted declarations was not
    recognized, and the report silently said "no changed exported functions".
12. JSDoc `{Object}` parameters are generated as objects instead of being skipped.
13. Cross-file impact follows unchanged functions that call a changed function of the same file
    (`filesize()` → `decorateResult` → changed `applyNumberFormatting`).
14. The frozen clock also applies to `new date.constructor()` (radash `clone`), which made `set` look
    nondeterministic.
15. The runner removes properties that code under test adds to built-in prototypes (`set({}, "__proto__.x", 1)`),
    and encodes huge sparse arrays by their populated entries. Together these took radash `set` from 25 s with 46
    timeouts to 0.6 s.

We also found and fixed a performance problem: change detection on es-toolkit took 13 s because the TypeScript
program was rebuilt once per analyzed file. It now takes 2.7 s.

## Performance

| Run                                                                                                              | Wall time | Breakdown                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Real commits above (1,000 inputs/function)                                                                       | 0.5–8 s   | detection 0.5–6 s, verification 0.2–4 s                                                                                                         |
| Demo AI refactor, Action settings (10,000 inputs/function, 60 s budget), 3 functions                             | 9.4 s     | verification 7.8 s, every function at 10,000 inputs                                                                                             |
| Demo pure refactor, Action settings, 4 functions                                                                 | 6.7 s     | verification 5.2 s, every function at 10,000 inputs; `addBusinessDays` timed out on 2 edge-case inputs (huge `days`), similar ones were skipped |
| [Playground PR](https://github.com/7suheel/doppeldiff-playground/pull/1) on GitHub Actions (v0.1.1), 5 functions | 19 s job  | analysis 8.1 s (55 s with v0.1.0, which stopped one function at 242 inputs); the action step including its install took 14 s                    |

Measured on a 4-CPU Linux container, Node 22 (the playground row on GitHub's `ubuntu-latest`). GitHub Actions
additionally spends a few seconds on `npm ci --omit=dev` for the action itself (not included in the local rows).
The budget of < 60 s for ≤ 10 functions holds with a wide margin on these examples. Functions that loop for a long
time on ordinary inputs are the main risk; since v0.1.1, counts and loop bounds are generated mostly in realistic
ranges, and timeouts on edge-case inputs no longer stop exploration.

## Not evaluated

- **The LLM layer** (claim matching and input suggestions). There was no API key in the evaluation environment.
  Its plumbing is tested against mock servers, but the quality of its labels on real PRs is unmeasured.
- ~~The GitHub Action on real GitHub~~: verified on [7suheel/doppeldiff#1](https://github.com/7suheel/doppeldiff/pull/1) (the "AI refactor" scenario). The analyze job verified 3 functions at 10,000 inputs each in 3.4 s, and the comment workflow posted the sticky comment and updated it on the next push. That run also showed that GitHub rejects a workflow that triggers itself via `workflow_run`, so the setup is two files.
- **Monorepos with pnpm or yarn workspaces** (only npm workspaces are tested).
