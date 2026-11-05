First-run onboarding as a full window, not a modal: three steps (Bridge, AI, Local model), one decision per screen, large type and generous space, with the system's only gradient glow and choreographed motion.

**Layout.** The window is `canvas` with a soft `accent-subtle` radial glow and a faint dot grid fading out from the top centre. Brand top-left, **Set up later** top-right. One 560px column holds: three progress bars with step names (completed ones are clickable), an eyebrow ("Step 2 of 3"), a `display` title (32/40), a 15px lede in `ink-muted`, the step's content, and a footer with **Back**, **Skip** and one 40px primary button. A single privacy line sits at the bottom of the window.

**Steps**
1. **Connect Ergo to this computer.** A status card with a 48px orb: a spinning `accent-text` ring while it looks for the bridge, then a green check that pops in, with "Ergo Bridge is running · localhost:5174". Download link while searching. Port and launch command stay behind an **Advanced** disclosure. Continue unlocks once the bridge is found.
2. **Choose the AI that does the work.** A segmented control (My subscription / API key), then four 72px provider tiles in a 2×2 grid, each with its official provider logo icon, name and the plan it uses. The selected tile gets an `accent-text` edge, a 3px `accent-subtle` halo and a check that scales in. The primary button names the outcome: **Connect Claude**. API key mode swaps the reassurance line for a key field.
3. **Add a small local model** (optional). The same status card shows size, then a gradient progress meter with MB counted live, then **Installed**. Facts about where it lives and how to remove it sit below as quiet icon rows. Skip stays available until the download starts; the user can continue while it downloads.

**Motion** (all from tokens; off under `prefers-reduced-motion`): the glow fades and scales in once on load; each step slides 24px in the direction of travel over `duration-page` (320ms, `ease-out`), with its parts rising 6px in a 40ms stagger; progress bars fill from the left; status checks pop. Nothing loops except the searching ring.

**Provider marks** use each provider's official logo icon under its brand guidelines (Anthropic for Claude, OpenAI for ChatGPT, Gemini star for Gemini).

**Removed from the old onboarding:** the boxed modal, the numbered stepper with connecting rules, green-filled buttons and success panels, the "Preferences are saved locally" footer on every step (now one line for the whole flow), and the second **Sign out** button next to Connect.
