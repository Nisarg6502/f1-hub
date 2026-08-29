# Team Radio — the plain-English version

Written 2026-08-29. This is the "what are we actually doing and why" doc.
`TEAM-RADIO-PLAN.md` is the build instructions; this one is the reasoning.
Everything factual below was measured against the live APIs on 2026-08-29, not
assumed.

---

## 1. What team radio data actually is

When you watch a race and a box slides in saying **"Box, box, box"** with the
driver's name on it, F1's broadcast team has picked one radio clip out of the
hundreds flying around the pit lane and pushed it to air.

F1 also publishes those same clips to a public web address. That is what we'd be
using. Specifically:

- F1 uploads MP3 files to its own timing server, `livetiming.formula1.com`.
- Alongside them it publishes a small index file listing every clip: **when it
  happened, which car number it belongs to, and the filename.**
- A free service called **OpenF1** mirrors that index into a friendly JSON API.

So we get audio, and we get "car #63, at 15:34:26". That's it.

### The single most important thing to understand

**Nobody tells us who is speaking.**

Not OpenF1. And I checked F1's own origin file directly — `TeamRadio.json` on
their server — and it contains exactly three fields per clip: timestamp, racing
number, filename. There is no transcript, no "this is the driver / this is the
engineer" label, no "this one is important" tag.

That single gap is the reason this feature is bigger than it looks. Every part
of what you asked for —

- showing the words on screen,
- knowing which line is the driver and which is the pit wall,
- putting `***` over swearing,
- picking the interesting ones out of the boring ones

— all need **text**. And there is no text. So the very first thing we have to
build is a machine that listens to the audio and writes down what was said.
Everything else is downstream of that.

---

## 2. Where we can get it free — the honest list

| Source | What it gives | Free? | Verdict |
|---|---|---|---|
| **OpenF1 `/team_radio`** | Timestamp, car number, MP3 link. 2023 → today. | Yes, no signup, no key | **Our primary source.** Already the same API this app uses for Race Control. |
| **F1 `livetiming.formula1.com`** | Identical data, one step upstream | Yes | **Our fallback.** Useful if OpenF1 goes down or gaps out — but it has no extra information, I checked. |
| **Hugging Face `MikCil/f1-team-radio`** | 14,681 clips **with transcripts already written**, 2018–2025 | Yes — CC BY 4.0 licence, we just have to credit it | **A genuine gift.** Saves us transcribing seven years of history, and gives us a big pile of real examples to test our "who's speaking" detector against. |
| **RaceFans team radio transcripts** | Human-written transcripts **with speaker labels** | Free to read | Useful to sanity-check our accuracy by eye. Not something we should scrape and republish. |
| F1TV / official broadcast | Everything, perfectly labelled | No — paid, closed | Not available to us. |

**The short answer to "where can we source this free": OpenF1 for the clips,
Hugging Face for historical transcripts, and our own transcription for anything
recent.**

---

## 3. How much is actually there? (This will surprise you)

I measured every 2026 race and sprint. Here is the real picture:

| Round | Session | Clips |
|---|---|---|
| Australia → Miami | 8 sessions | **0** |
| Canada | Sprint / Race | 13 / 33 |
| Monaco | Race | 36 |
| Spain | Race | 40 |
| Austria | Race | 23 |
| Britain | Sprint / Race | 4 / 20 |
| Belgium | Race | 29 |
| Hungary | Race | 36 |
| Netherlands | Sprint / Race | 6 / 31 |
| | **Total 2026 so far** | **271** |

### Three things to take from that table

**1. 2026 has a hard cutoff, not a slow decline.** There is nothing at all
before the Canadian GP on 23 May, and then every single race after it has data.
OpenF1's own documentation says "most 2026 events provide no radio data" — that
is now out of date, and I'd have believed it if I hadn't measured. Roughly half
the 2026 season is covered, and the recent half is the covered half.

**2. Per driver, per race, you get about two clips.** Median is 2. The busiest
driver in a race gets around 7–10. And only 9 to 14 of the 20 drivers appear at
all — a quiet midfield afternoon often produces literally nothing for a driver.

**3. It used to be four times richer.** 2023 and 2024 averaged ~110 clips per
race. 2025 and 2026 average ~30. F1 has quietly cut back what it publishes.

### So what does that mean for the feature?

It means **the "too many messages" problem you were worried about mostly does
not exist in 2026.** 31 clips spread over a two-hour race is roughly one every
four minutes. That is not a firehose — that is a pleasant trickle.

The filtering problem is real for *2023 and 2024* races (110 clips is one every
minute, which would be exhausting), and for a chaotic race. The 2024 Hungarian
GP had 144 clips; Belgium had 146. So we should build the ranking — but as a
"nice-to-have that earns its keep on the busy races", not as a rescue mission
for the common case.

**Also worth knowing:** F1 is already filtering for us. OpenF1's docs say only
"a limited selection" of communications are published. What we receive has
already been through a broadcast producer's judgement about what was worth
airing. We are ranking an already-curated list, not raw pit-lane chatter.

### Other measured facts that shape the build

- **A whole race is about 8½ minutes of audio.** That is the entire radio
  content of a Grand Prix. It's tiny.
- **A typical clip is 9 seconds.** Shortest at Zandvoort was 2.8s, longest was
  **192 seconds** — Bortoleto's channel, which I assume was left open. We need
  to handle that gracefully rather than pop a three-minute wall of text on
  screen.
- We can work out any clip's length **without downloading it** — the files are a
  fixed bitrate, so the file size divides straight into seconds.

---

## 4. "Which is the driver and which is the team?"

This is the part with no free shortcut, so here is how I'd get it.

**You've asked for both approaches to be built and compared, which I think is
right.** They're genuinely different bets and the answer isn't obvious from an
armchair.

### Approach A — read it off the words

Transcribe the clip, then ask a language model to split it up and label each
line. It works because F1 radio is extremely formulaic:

> *"Box this lap, box this lap"* — obviously the pit wall.
> *"I've got no grip, the tyres are gone"* — obviously the driver.
> *"Copy that"* — could be either. This is where it gets it wrong.

**Cheap, no new infrastructure, reuses the AI setup this app already has.** Weak
on short acknowledgements and on clips where both people say similar things.

### Approach B — listen to the voices

Before reading the words, use a second AI model to separate the audio into
distinct speakers — "voice 1 talks here and here, voice 2 talks there" — purely
from how the voices sound, ignoring meaning entirely. *Then* we only have to
decide which of the two voices is the driver, once per clip, instead of guessing
line by line.

**More accurate in principle, especially on back-and-forth exchanges.** But it
adds a real machine-learning service that we have to run and keep running, and
race radio is horrible audio — compressed, clipped, engine noise, helmet muffle.

### How we decide

We build both, hand-label about 150 real utterances as ground truth, and score
them. If B doesn't clearly win, A ships — because A is dramatically simpler to
operate and simplicity has real value.

**A useful reality check on difficulty:** F1 themselves built exactly this,
running live during races. It reportedly took 75 model iterations and 7 hours of
hand-annotated audio to get production-quality results. We are not going to beat
that with a weekend of prompting, and we shouldn't pretend otherwise. Our target
is "good enough that it's obviously right most of the time, and honestly says
*unattributed* when it isn't sure" — never a confident wrong label.

### The rule I'd hold us to

**When the machine isn't confident, it must say so, not guess.** A radio box
that says "we're not sure who said this" is fine. A radio box that confidently
puts the driver's angry words in his engineer's mouth is embarrassing and
undermines every other number in the app.

---

## 5. What it'll look like in Watch mode

This is the bit you actually asked for, so let me be specific.

When the replay clock reaches the moment a radio clip happened, a box slides in
from the bottom-left — the same place and the same feel as the broadcast:

```
+----------------------------------------------+
|#  RUSSELL                TEAM RADIO    LAP 34|
|#                                             |
|#  RUS   "The tyres are completely gone,      |
|#         I can't hold him"                   |
|#  PIT   "Understood George, box this lap"    |
|#                                    > 0:09   |
+----------------------------------------------+
     ^ this left bar is the team's colour
```

- **The left bar and the driver's name are in the team's colour** — Mercedes
  green, Ferrari red, McLaren orange. The app already has these exact colours in
  one place and uses them everywhere else, so this is free.
- **The driver's lines are in team colour, the pit wall's are in plain grey.**
  That way you can tell who's talking at a glance without reading the labels.
  When we're not confident, the label reads `RADIO` and both lines are neutral.
- **Swearing is masked as `***`** in the caption. More on that below.
- **It appears silently and stays about 6 seconds**, then slides out. If two
  clips land close together they queue rather than overlap.
- **There's a play button on the box.** Per your choice, the audio does *not*
  autoplay — you tap to hear it. This matters more than it sounds: browsers
  block unrequested audio anyway, and if you're watching this next to a TV
  showing the same race, surprise audio is actively annoying.
- **Nothing from the future ever leaks.** Watch mode already refuses to show
  race control messages from laps you haven't reached — a companion screen that
  spoils the red flag is worse than useless — and radio follows the same rule.

**One nice piece of luck:** the hardest part of this — working out exactly where
in the replay a clip belongs — is already solved. The app already had to
calculate the precise instant of lights-out in order to line up its per-second
timing data, and that same calculation turns a radio timestamp into "34 minutes
and 12 seconds into the race" with no new work at all.

**One small catch:** F1's server doesn't allow browsers to *inspect* the audio,
only play it. So a waveform that genuinely dances to the voice would need us to
proxy the file through our own server. A tasteful animated waveform that just
looks alive while the clip plays costs nothing — and honestly looks identical.

---

## 6. Swear words

You asked for `***`, so: `***`.

Two separate things, and it's worth keeping them separate:

**Masking the text — easy, doing it.** Once we have the transcript, replacing
profanity with `***` is a solved problem. We store the raw transcript privately
(we need it for the "who's speaking" model to work well) and the API only ever
serves the masked version. Clips containing strong language get a flag, so any
part of the app can decide to be more careful with them.

**Bleeping the actual audio — not doing it in v1.** To bleep the audio we'd have
to know the exact millisecond of each swear word, edit the MP3, and then host
the edited file ourselves. The moment we edit the file we can no longer point at
F1's copy, so we need storage, a processing job, and we take on ownership of a
modified version of F1's content. That is a lot of machinery for a small gain.

**So: the caption is clean, the audio is raw — and the user has to press play to
hear it.** That's a reasonable place to land: nothing offensive appears without
the user choosing it, and we haven't built an audio editing pipeline.

---

## 7. Where else this gets used

Once the transcripts exist, radio stops being one feature and becomes an
ingredient. Ranked by "worth it vs. effort":

**Tier 1 — obviously worth it**

- **Watch mode popup.** The thing you asked for. Ships first.
- **A "Radio" module on the Pitwall page.** The full list for a race, filterable
  by driver, playable, searchable. Pitwall already has six modules and Race
  Control is its next-door neighbour — this slots straight in.
- **Race Replay timeline markers.** A little tick on the scrub bar wherever a
  radio clip sits, so you can jump between them. Also means nothing is ever
  silently hidden, even if the ranking decides not to feature it.

**Tier 2 — high value, needs transcripts working well**

- **AI Recap grounded in real quotes.** Right now the recap narrates numbers.
  With radio it could say *why* — and cite an actual quote rather than an
  invented motivation. The app already has a citation-chip mechanism for exactly
  this.
- **The Pitwall chat assistant.** "What did Mercedes tell Russell about the
  tyres?" becomes an answerable question with a real, verifiable quote behind it,
  instead of a polite refusal.
- **Strategy Commentary.** A pit call is currently a dot on a chart. With radio,
  it's a dot on a chart *plus the sentence that caused it* — the single most
  explanatory thing you could attach to a strategy view.

**Tier 3 — fun, cheap once the rest exists**

- **Driver personality stats.** Most talkative driver of the season. Longest
  single transmission. Who swears most (masked, obviously). Who says the least.
  This is genuinely good social-media bait and costs almost nothing once the
  transcripts are sitting in the database.
- **"Radio moment of the race"** on the race detail page — one featured clip.
- **Team-by-team comparison.** Which pit walls talk to their drivers most? Is
  there a pattern between radio volume and mistakes?

**Tier 4 — flagged, but I'd say no for now**

- **Live radio during a session.** OpenF1 charges for real-time data, and our
  transcription adds delay on top. It would arrive late and cost money.
- **A season-long "greatest quotes" hall of fame.** Lovely idea, but pre-2023
  audio isn't in the API at all, so it becomes a manual curation project — a
  different kind of work from everything above.

---

## 8. What it costs

Almost nothing, which is the happy surprise.

- **Transcription: nothing at all.** The original plan was to pay Groq about four
  cents an hour, which would have come to roughly a dollar for everything. Then
  Groq's free tier started asking for credits — so transcription now runs the
  same model, `whisper-large-v3-turbo`, **on your own machine**. No key, no
  quota, no account.

  This turned out to be the better answer anyway, not a consolation prize. The
  job is a one-time backfill of about forty minutes of audio, and it never runs
  on the live site — the website only ever reads finished transcripts out of the
  database. So the model never goes anywhere near the deployed server. Measured
  on your 12 cores: about nine minutes of computer time per race, and under two
  hours for every 2026 race that has radio. Once, for free, forever.
- **The "who's speaking" model:** one small call per clip against the AI service
  the app already pays for. Done once per clip, cached forever, exactly like the
  AI Recap already works.
- **Storage:** we never host the audio. We point at F1's server. We only store a
  few hundred short text records.
- **Ongoing:** roughly 31 new clips a fortnight. This is not a system that grows
  into a problem.

---

## 9. What could go wrong

**F1 stops publishing radio again.** They already did it for the first eight
rounds of 2026. Nothing we can do — but the feature must degrade to an honest
empty state ("no radio published for this session") rather than looking broken.

**The speaker labelling is wrong often enough to be embarrassing.** Mitigated by
the bake-off, and by the hard rule that low confidence shows as *unattributed*
rather than as a guess.

**Transcription mangles names and jargon.** Whisper will absolutely write
"Verstappen" as "for stopping" on bad audio — the free corpus we checked is full
of real examples ("Van der Waal" for Vandoorne, "SuperSalt" for supersoft,
"virtual safeguard" for virtual safety car). A short glossary of driver names,
team names and F1 vocabulary fed to the model fixes most of it, and the Hugging
Face corpus lets us measure how much.

**A rude word slips through the filter.** Word lists are never complete,
particularly with accents and clipped audio. Given the audio only plays on tap
and the caption is our own text, the blast radius is small — but we should be
able to add to the list without a redeploy.

**Rights.** We hotlink F1's own public files and we don't re-host or edit
anything, which is the same posture the app already takes with Race Control and
its images. The transcripts are ours. If we use the Hugging Face corpus we must
credit it — CC BY 4.0 requires attribution, and there's already an attributions
page to put it on.

---

## 10. What happens in what order

**Phase 1 — the popup you asked for.** Transcription running, `***` masking,
both attribution approaches built and scored against each other, winner wired up,
team-coloured box appearing in Watch mode at the right moment with a play button.
This is a complete, demonstrable thing on its own.

**Phase 2 — the full feed.** Radio module on the Pitwall page, tick marks on the
Race Replay timeline, per-driver filtering and search.

**Phase 3 — radio as evidence.** Recap and Strategy Commentary quote real radio
with citations; the chat assistant gets a radio tool.

**Phase 4 — the fun stuff.** Personality stats, notability ranking earning its
keep on the busy 2023/2024 races, historical backfill.

The build instructions for all of that are in `TEAM-RADIO-PLAN.md`.
