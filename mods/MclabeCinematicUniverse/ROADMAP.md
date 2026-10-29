# The Mclabe Cinematic Universe: lore and roadmap

The lore comes from tel0s and Cody. This file is the reference for every Mclabe
quest: what is true, what the player knows when, and what comes next.

## Canon (from tel0s and Cody)

- **Three brothers:** Jemery, Danvid and Bellamy Mclabe.
- **Jemery Mclabe** is an earnest, if not simple, man. He wanders the swamp
  south of Lumbridge. At the start of the series he does not know what
  happened to Danvid or Bellamy.
- **Danvid Mclabe** drowned in olive oil at the tender age of 34. He was
  overly, weirdly excited about the olive oil job: his "dream job", an
  obsession with olive oil. He worked and drowned in **Brimhaven** (oceanic,
  and likely frequented by the types Jimley Creben belongs to).
- **Bellamy Mclabe** has assumed the identity of **Dr. Thrick**, a man who
  strongly rejects germ theory, in the middle of the plague in West
  Ardougne.
- **Jimley Creben** is a suspicious character: a balding man with manic
  energy. Little is known about him, but he is related to all of this. In
  The Brothers Mclabe he is only hinted at, never seen.

### The secret (Cody's idea)

Jimley, not one to follow good business practices, has been **cutting the
olive oil with a dangerous magical substance**. Anyone who consumes enough of
the oil turns into a sort of **olive oil elemental zombie**. Because Danvid
fell into it entirely, he has become an **olive oil monstrosity**. This comes
out in a later quest; the climax, **Oil Be Seeing You**, is the battle with
Danvid.

## Added in The Brothers Mclabe (not canon yet: change freely)

- Jimley ran **Creben's Fine Oils** out of the Brimhaven docks. He came to
  the barrels at night with a "secret ingredient", and left without a word
  after Danvid vanished.
- **Mags**, Danvid's bunkmate at Creben's bunkhouse, tells the player what
  happened.
- Nobody found Danvid's body: only his cap on the barrel's rim, and scratch
  marks inside it. The oil is subtly wrong: warm, faintly shimmering, and now
  and then it seems to move by itself. *(Foreshadows the secret without
  explaining it.)*
- Dr. Thrick blames the plague on miasma (bad smells) and prescribes olive
  oil gargles. His clinic has a crate of Creben's oil, and he flinches at the
  name Creben. *(Sets up later outbreaks among his patients. Base content
  note: in Biohazard the West Ardougne plague turns out to be a hoax, so none
  of his patients die of it, and he takes the credit.)*
- The player unmasks Dr. Thrick by matching the handwriting on his
  prescription to Bellamy's letter (the curls on his capitals).
- The brothers' mother has died ("Mum would be so proud").

## Quests

1. **The Brothers Mclabe** (done, this mod): Jemery asks the player to find
   out what happened to Danvid and Bellamy. The player learns that Danvid
   drowned in olive oil in Brimhaven, brings back a bottle of the oil, and
   unmasks Dr. Thrick as Bellamy. Jimley Creben is only hinted at. Requires
   Plague City. See README.md for the walkthrough.
2. *Ideas, in no fixed order:*
   - Jimley Creben's oil business: who buys his oil, where the "secret
     ingredient" comes from, the first oil-sick patients (perhaps among Dr.
     Thrick's).
   - Bellamy's arc: Dr. Thrick's patients start to glisten.
3. **Oil Be Seeing You** (the climax): the truth about the oil comes out, and
   the player battles Danvid, now an olive oil monstrosity.

## Continuity notes

- Saved values: `%mclabe_brothers`, `%mclabe_danvid`, `%mclabe_bellamy` (see
  config/mclabe.constant for the stages). Later quests can read them, for
  example to check that the player knows Dr. Thrick is Bellamy.
- The player keeps **Danvid's Olive Oil** after the quest (Jemery cannot bear
  to keep it). A later quest can make it react.
- The earlier demo's `%mclabe_grief_stage` is gone; its id stays reserved in
  mods/idmap.json.
