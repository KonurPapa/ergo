# How Auto mode picks AI models

When you run a task in Ergo, several AI helpers work on it, one after another. **Auto mode** decides which AI model each helper uses, and how hard it should think, so the task gets done well without paying for more than it needs. This page explains how that decision is made, in plain terms.

---

## First, a few terms

**AI model**
: The "brain" that does the work, for example *Claude Sonnet* or *GPT-6 Sol*. Companies release several models at once: some are fast and cheap, others are slower, more expensive and more capable.

**Provider**
: The company whose models you use, such as Anthropic (Claude), OpenAI (GPT), Google (Gemini) or xAI (Grok). You choose one when you set up your AI profile, and Auto mode only picks from that provider's models.

**Token**
: The unit AI companies charge by. Roughly, one token is three-quarters of a word. Everything the model reads (your task, files, notes) and everything it writes costs tokens. Prices are quoted per million tokens, e.g. "$2 in / $10 out".

**Stage** (or **agent**)
: One of the helpers that work on a task:
  - The **manager** reads the task, makes a plan, and splits the work into pieces.
  - **Workers** each do one piece of the plan.
  - The **QA checker** (quality assurance) independently tests the finished work and either passes it or sends it back with problems to fix. It's **off by default**, because most models check their own work well and many tasks are done in one go. Turn it on for a task with **QA verification** in the task's ⋯ menu.
  - **Bookkeeping** helpers write the task overview and the completion log.

**Effort** (or **reasoning effort**)
: How long a model "thinks" before answering, from *Low* to *Max*. More effort catches more mistakes on hard problems, but costs more tokens and time. On easy problems it just costs more.

**Tier**
: Auto mode sorts your provider's models into three groups:

  | Tier | What it means | Example (Anthropic) |
  |---|---|---|
  | **Light** | The cheapest model that's still reliably decent | Claude Haiku |
  | **Standard** | Nearly as good as the best, for much less | Claude Sonnet |
  | **Top** | The strongest model available | Claude Opus |

**Prompt caching**
: When a model is sent the same text again, the provider can keep it in memory and charge far less for it, often 5–25% of the normal price. Agents resend their whole conversation every step, so caching saves a lot of money. It's always on in Ergo.

---

## Step 1: Rating the task

Before any real work starts, a small, cheap model (the **tiny model**, e.g. Claude Haiku) writes the task overview: the "here's what I think you want" summary you can check. While doing that, it also gives the task three ratings:

| Rating | Question it answers | Scale |
|---|---|---|
| **Kind** | What sort of work is this? | coding, writing, research, operations, data, other |
| **Complexity** | How *big* is it? | 1 = a one-line fix … 5 = a large, multi-part project |
| **Reasoning** | How *hard* is each step? | 1 = routine … 5 = tricky design or debugging |

The ratings are saved with the overview, so running the same task again doesn't pay to rate it twice.

---

## Step 2: Choosing a tier and effort for each stage

Auto mode uses a simple principle:

> **Size decides the model. Difficulty decides the effort.**

A big but routine task needs a model that can keep track of a lot. It doesn't need to think deeply about each step. A small but tricky bug is the opposite: a capable model thinking hard.

For coding tasks at the default *Medium* setting:

| Task | Manager | Workers | QA checker |
|---|---|---|---|
| Trivial (complexity 1) | Standard | Light | Standard |
| Typical (complexity 2–3) | Standard | Standard | Standard |
| Large, or very tricky (complexity 4, or reasoning 4+) | Top | Standard | Top |
| Largest (complexity 5) | Top | Top | Top |

The thinking effort follows the reasoning rating: routine work gets *Low*, ordinary work *Medium*, tricky work *High* or *Extra High*. Workers think one step less than the manager, because they follow the manager's plan.

**Safety floors for coding.** The manager and the QA checker never use the light tier on coding tasks. A weak plan or a weak check can sink the whole task. Workers never use it on anything above complexity 2. Benchmark scores make cheap models look closer to expensive ones than they really are on long, multi-step jobs, so Ergo leans toward caution.

**Bookkeeping** (the overview and completion log) always uses the light tier with little effort. It's simple work.

### The Effort slider

The slider next to the run button nudges Auto mode toward saving money or toward quality:

| Setting | What changes |
|---|---|
| **Low** | One tier lower and less thinking, but never below the safety floors |
| **Medium** | The plan above (the default) |
| **High** | Stronger manager and QA checker, and more thinking for everyone |
| **Extra High** | Every stage one tier stronger, with much more thinking |
| **Max** | The strongest model at maximum thinking, whatever it costs |

### Manual mode

If you'd rather choose for yourself, switch **Models** from *Auto* to *Manual*. Ergo then uses exactly the models you set for each stage in your AI profile's advanced settings. The Effort slider then only controls thinking time.

---

## Step 3: Where the prices and strengths come from

- **Prices** are fetched from a public price list that tracks every major provider (LiteLLM). Ergo refreshes it twice a day, and keeps a copy for when you're offline.
- **Strengths** (how good each model is at coding and at general reasoning) come from a table built from published benchmark tests. If you add a free key from *Artificial Analysis* (an independent benchmarking site) under **Settings → Model data**, Ergo uses their live scores instead.
- **New models** that aren't in the table yet are estimated from their price compared with the provider's other models.

A model that's both weaker *and* more expensive than another one is never used.

---

## Step 4: When the work fails

The QA checker can reject the work and send it back with a list of problems. Normally the same model would just try again. Auto mode **steps up** instead:

- **First retry:** the manager and workers move up one tier (e.g. Sonnet → Opus). In CLI runs (Claude Code, Codex, Antigravity) the manager is already mid-conversation and keeps its model; the workers it sends back to fix things step up, and the manager starts a step up on the next run.
- **Already on the top tier:** they think harder instead (e.g. Opus at Medium → Opus at High).

The QA checker keeps its model, because it was right to catch the problem.

If a task's last run failed or you stopped it, the next run of that task starts one step up (at most two). Once a run succeeds, the next one starts from the normal plan again.

Why not always start strong? A failed run costs the tokens it used, plus your time checking it, plus a second run. Stepping up only when needed avoids paying top prices for work a cheaper model handles fine, without risking a run of failures.

---

## Step 5: Learning from your own runs

Auto mode's starting plan is an educated guess. Over time Ergo adjusts it to *your* tasks and projects using a small table of results. Ergo keeps it as a file you can open: `config/model-calibration.json`, next to the agent instructions in your Ergo storage folder.

**What it records.** After each run, for each stage: what kind of task it was (coding or not, and how difficult), which model and effort were used, whether the run succeeded, and what it cost.

**What counts as success or failure.**

| Event | What Ergo learns |
|---|---|
| QA passed, or the run finished | Success for the models that did the work |
| QA failed after all retries, or the run broke | Failure |
| QA passed only after stepping up | The starting models failed and the stepped-up models succeeded. This shows exactly where the line was. |
| You stopped the run | Nothing (stopping can mean many things) |
| You ran the task again | Nothing (you may just be repeating a routine task) |
| Your messages while it works | See below |
| Your answer to "How did this task do?" | Good or bad for the models that did the work. It replaces the automatic verdict and counts double (see below) |

**Your messages count.** You can type messages to the agent while it works, or after it finishes. Most are ordinary directions ("use the existing helper", "also update the README"). Ergo ignores those for learning. A few messages say something about the model itself, and Ergo records those:

- "That's wrong, try again" or "this isn't what I asked for" means the model wasn't good enough.
- "Use a stronger model" means the same.
- "Switch to a cheaper model" or "this is overkill" means it was more than needed.

**How it changes the plan.** Before a task runs, Ergo checks the table for similar tasks:

- If the planned setting **often failed** on tasks like this, it starts one step stronger. It needs at least three results first, for example half of six runs failing.
- If a cheaper setting has a **long, strong track record** on tasks like this, it may start one step cheaper. That means roughly seven successes in a row, or something similar like 12 out of 13. It never goes below the safety floors, and never on thin evidence.
- It compares the **total expected cost of getting a good result**, including the cost of failed attempts. A cheap model that often fails isn't actually cheap.

**Trying a cheaper model, now and then.** Some tasks look like they'd be fine on a cheaper setting. For those, Ergo occasionally starts the manager *or* the workers (never both, and never QA) one step cheaper, so it can find out. It only does this when:

- the planned setting has a strong record on tasks like this (about seven clean results, or four "good" answers);
- the cheaper setting has too little data to decide, and hasn't done badly so far;
- a dice roll comes up, about one such run in four.

It never goes below the safety floors. If the task has QA verification on, QA still checks the work, and a QA retry steps back up as usual. The run's notes say when Ergo is trying a cheaper model, and afterwards the task card asks you how it went. Choosing *Low* or *Manual* yourself builds the same evidence. Old results gradually count for less, so the table keeps up with new models and with how your projects change. When a provider releases a new model, its predecessor's results count for half until the new model builds its own record.

**"How did this task do?"** After some Auto runs, the task card asks for a quick **Good** or **Bad**. It only asks when Ergo can't judge the run well on its own:

| When | Why your answer helps |
|---|---|
| QA couldn't reach a verdict | Your answer is the only check |
| Ergo has fewer than three results for this model on tasks like this | Ergo can't tell yet whether it picked well |
| The run tried a cheaper model | Ergo keeps asking until it has three answers for that model. A "bad" quickly sends similar tasks back up |

It doesn't ask when the run failed or you stopped it, when you already judged the model in a message, in Manual mode, or once a model has a solid record on tasks like this. So the questions taper off as Ergo learns.

Your answer counts double, because you saw the result and QA only checked it. "Bad" counts against the models that did the work, and against QA if QA passed it. "Good" counts for them. Ignore the question, or close it with ×, and nothing is recorded.

The run's notes always say when the table changed a pick, and why. For example: *"Your history: Sonnet at Medium passed 3 of 6 coding tasks like this, so starting on Opus."* You can see the table, or reset it, under **Settings → Model data**.

---

## How prompt caching keeps costs down

Agents resend their whole conversation at every step. Without caching, a long run pays full price for the same text dozens of times. Ergo is built to get the most from caching:

- **Always on.** Ergo marks the stable parts of every request (instructions, tool lists, the task overview) as cacheable for providers that need it (Anthropic). OpenAI, Google and xAI cache automatically. CLI agents such as Claude Code cache on their own.
- **Stable starts.** The parts that don't change come first and stay word-for-word identical for the whole run, because a cache only matches text that hasn't changed. Your messages mid-run are added at the end and never rewrite what came before.
- **Models are chosen once, up front.** A cache belongs to one model, so switching models mid-run throws it away. Ergo picks models before each stage starts, and only switches when a retry steps up. That costs one full-price re-read, which is worth it to fix a failure.
- **Prices include it.** When Auto mode compares costs, it uses each provider's cached price, which varies. For example, Anthropic, OpenAI and Google charge about 5% of the normal price for cached text, while xAI charges 25%.

---

## Quick reference

- **Default behaviour:** Auto mode at Medium effort, with prompt caching always on.
- **To spend less:** move Effort to Low. The safety floors still apply.
- **For important work:** move Effort to High or Extra High.
- **To choose models yourself:** set Models to Manual.
- **To see why a model was picked:** open the run's "Models" step in the task notes.
- **To inspect or reset what Ergo has learned:** Settings → Model data, or the file `config/model-calibration.json`.
