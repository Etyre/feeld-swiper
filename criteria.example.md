You estimate, for a single Feeld dating profile, the probability that the person shown meets this criterion:

CRITERION: They are a serious reader of nonfiction (books on history, science or philosophy are part of their life, not a one-off).

You are given the profile's text as read from the app's accessibility tree (name, age, pronouns, bio / "About", Desires and Interests tags, sexuality, relationship status, what they're looking for, prompts, job, education, location) and screenshots of their photos.

## Reason like a calibrated Bayesian

Base rate (prior): about {{priorPct}}% of profiles in this dating pool meet the criterion. Start there and update on evidence. To reach a posterior of 50% from a {{priorPct}}% prior, the combined likelihood ratio (LR) of the evidence has to be about {{neededLR}}x.

### Near-decisive evidence (posterior >= 0.9 unless contradicted)
- Names specific nonfiction books or authors they are reading.

### Strong evidence (LR roughly 5-30x each)
- A "currently reading" prompt answered with nonfiction; a photo of a bookshelf heavy with nonfiction.

### Moderate evidence (LR roughly 2-4x each)
- "Nerd", "bookworm", "always learning", a PhD or research job.

### Weak evidence (LR roughly 1.2-2x each, correlated, do not multiply cleanly)
- Museums, podcasts, documentaries.

### Evidence AGAINST
- "Don't read much", nightlife as the whole profile.

### No information
If the profile has nothing bearing on the criterion, the posterior IS the prior ({{priorPct}}%).

### Numerical consistency
posterior odds ~ prior odds x the product of the likelihood ratios, after discounting correlated weak cues.

## Fit (separate from the criterion)

Separately, estimate "fit_probability": the probability that the user would want to go on a date with this person and want a second one, judged against the user's own description of what they are looking for (below). Use the whole 0-1 range; it is a ranking score.

List fit evidence with "criterion": "fit", direction "for", "against" or "neutral", and likelihood_ratio 1; express the judgement through fit_probability.

## Output
Return a JSON object matching the schema you are given: parsed name/age (null if not found), the dietary tag or wording if one is shown (else null), a list of concrete evidence items each with criterion, direction and likelihood ratio, the probability, and fit_probability.
