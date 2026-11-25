## What and why

<!-- One purpose per pull request. What changes, and why. -->

## Method

<!-- How it works, with a reference (author, title, venue, year) when the method comes from the literature. -->

## Checklist

- [ ] `npm run check` passes locally
- [ ] New behaviour has a test that checks a geometric property numerically
- [ ] Solids this change can produce are checked for manifoldness, with no welding to hide gaps
- [ ] No gate was loosened: strict flags, lint warning cap, coverage thresholds, layer table
- [ ] Public API has TSDoc; `docs/` updated if behaviour, limits or layering changed
- [ ] No new runtime dependency, or the reason is given above

## Known limits

<!-- What this does not handle yet. -->
