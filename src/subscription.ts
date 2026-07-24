import { sql } from 'kysely'
import { JetstreamSubscriptionBase, JetstreamEvent } from './util/jetstream'
import {
  computeLexiconScore,
  LEXICON_SCORE_VERSION,
} from './util/lexiconScore'

// High-confidence patterns — always match, no context needed
const HIGH_CONFIDENCE_PATTERNS = [
  /\bska[-\s]?punk\b/i,
  /\bska[-\s]?core\b/i,
  /\bthird[-\s]?wave\s+ska\b/i,
  /\bskankin[g']?\b/i,
  /\brudeboy\b/i,
  /\brudegirl\b/i,
  /\b(2|two)[-\s]?tone\s+ska\b/i,
  /#ska\b/i,
  /#blueska\b/i, // feed-specific tag: anyone using it is explicitly opting in
  /#skasky\b/i,
  /\bmadstock\b/i,
  /\bby Madness\b/,   // case-sensitive: capital-M = credit line; lowercase = common phrase
  // Unambiguous band/artist names (specific enough to not need context)
  /\bska[-\s]?(cover|version|remix|arrangement)\b/i,
  /\b(the\s+)?skatalites\b/i,
  /\boperation\s+ivy\b/i,
  /\bless\s+than\s+jake\b/i,
  /\bstreetlight\s+manifesto\b/i,
  /\breel\s+big\s+fish\b/i,
  /\bmighty\s+mighty\s+bosstones\b/i,
  /\btoots\s+(and|&)\s+(the\s+)?maytals\b/i,
  /\bdesmond\s+dekker\b/i,
  /\bthe\s+beat\b.*\bska\b/i,
  // Original ska (late 1950s–60s)
  /\bLaurel\s+Aitken\b/i,
  /\bRoland\s+Alphonso\b/i,
  /\bTheophilus\s+Beckford\b/i,
  /\bVal\s+Bennett\b/i,
  /\bKen\s+Boothe\b/i,
  /\bBaba\s+Brooks\b/i,
  /\bPrince\s+Buster\b/i,
  /\b(the\s+)?Clarendonians\b/i,
  /\bJimmy\s+Cliff\b/i,
  /\bStranger\s+Cole\b/i,
  /\bDerrick\s+Harriott\b/i,
  /\bJustin\s+Hinds\b/i,
  /\bJah\s+Jerry\b/i,
  /\bLloyd\s+Knibb\b/i,
  /\bByron\s+Lee\b/i,
  /\bCount\s+Machuki\b/i,
  /\bCarlos\s+Malcolm\b/i,
  /\bTommy\s+McCook\b/i,
  /\b(the\s+)?Melodians\b/i,
  /\bDerrick\s+Morgan\b/i,
  /\bJackie\s+Opel\b/i,
  /\bScratch\s+Perry\b/i,
  /\bLord\s+Tanamo\b/i,
  /\bErnest\s+Ranglin\b/i,
  /\b(the\s+)?Silvertones\b/i,
  /\bMillie\s+Small\b/i,
  /\bSymarip\b/i,
  /\bLynn\s+Taitt\b/i,
  /\bAlton\s+Ellis\b/i,
  /\bDelroy\s+Wilson\b/i,
  // 2-Tone revival (late 1970s–80s)
  /\bAkrylykz\b/i,
  /\b(the\s+)?Apollinaires\b/i,
  /\bPauline\s+Black\b/i,
  /\bMike\s+Barson\b/i,
  /\bRhoda\s+Dakar\b/i,
  /\bJerry\s+Dammers\b/i,
  /\bLynval\s+Golding\b/i,
  /\bHorace\s+Panter\b/i,
  /\bRoddy\s+Radiation\b/i,
  /\bRanking\s+Roger\b/i,
  /\bChas\s+Smash\b/i,
  /\bNeville\s+Staple\b/i,
  /\bDave\s+Wakeling\b/i,
  /\bDaniel\s+Woodgate\b/i,
  /\bEverett\s+Morton\b/i,
  // Third-wave ska (1980s–90s)
  /\bAllniters\b/i,
  /\b(the\s+)?Aquabats\b/i,
  /\bArrogant\s+Sons\s+of\s+Bitches\b/i,
  /\bBig\s+D\s+and\s+the\s+Kids\s+Table\b/i,
  /\bBim\s+Skala\s+Bim\b/i,
  /\bBruce\s+Lee\s+Band\b/i,
  /\bBuck-O-Nine\b/i,
  /\bCherry\s+Poppin['']?\s*Daddies\b/i,
  /\b(the\s+)?Chinkees\b/i,
  /\bCitizen\s+Fish\b/i,
  /\bDance\s+Hall\s+Crashers\b/i,
  /\bDeal['']s\s+Gone\s+Bad\b/i,
  /\bEdna['']s\s+Goldfish\b/i,
  /\bFive\s+Iron\s+Frenzy\b/i,
  /\bFuzigish\b/i,
  /\b(the\s+)?Gadjits\b/i,
  /\bGOGO[-\s]?13\b/i,
  /\b(the\s+)?Hotknives\b/i,
  /\bInspecter\s+7\b/i,
  /\b(the\s+)?Insyderz\b/i,
  /\bKing\s+Apparatus\b/i,
  /\bFabulosos\s+Cadillacs\b/i,
  /\bMad\s+Caddies\b/i,
  /\bMark\s+Foggo\b/i,
  /\bSkasters\b/i,
  /\bMe\s+Mom\s+and\s+Morgentaler\b/i,
  /\bMephiskapheles\b/i,
  /\bMu[-\s]?330\b/i,
  /\bMustard\s+Plug\b/i,
  /\b(O\.C\.\s+)?Supertones\b/i,
  /\bPante[oó]n\s+Rococ[oó]\b/i,
  /\b(the\s+)?Planet\s+Smashers\b/i,
  /\bRough\s+Kutz\b/i,
  /\bRx\s+Bandits\b/i,
  /\b(the\s+)?Scofflaws\b/i,
  /\bSiren\s+Six\b/i,
  /\bSka-P\b/i,
  /\bSkavoovie\b/i,
  /\b(the\s+)?Skoidats\b/i,
  /\bSlow\s+Gherkin\b/i,
  /\bStubborn\s+All[-\s]Stars\b/i,
  /\bSuperhiks\b/i,
  /\bTokyo\s+Ska\s+Paradise\b/i,
  /\b(the\s+)?Uptones\b/i,
  // Post-third wave (2000s–present)
  /\bBandits\s+of\s+the\s+Acoustic\s+Revolution\b/i,
  /\bBeebs\s+and\s+Her\s+Money\s+Makers\b/i,
  /\bBomb\s+the\s+Music\s+Industry\b/i,
  /\b(the\s+)?Brass\s+Action\b/i,
  /\bCapdown\b/i,
  /\b(the\s+)?Cat\s+Empire\b/i,
  /\bChase\s+Long\s+Beach\b/i,
  /\bEn\s+Tol\s+Sarmiento\b/i,
  /\b(the\s+)?Flatliners\b/i,
  /\bGollbetty\b/i,
  /\bHowards\s+Alias\b/i,
  /\bHub\s+City\s+Stompers\b/i,
  /\bImperial\s+Leisure\b/i,
  /\b(the\s+)?Interrupters\b/i,
  /\bKing\s+Blues\b/i,
  /\bKingston\s+Rudieska\b/i,
  /\bLocomondo\b/i,
  /\bOreskaband\b/i,
  /\b(the\s+)?Orobians\b/i,
  /\bPannonia\s+Allstars\b/i,
  /\bRedSka\b/i,
  /\bSka\s+Cubano\b/i,
  /\b(the\s+)?Skints\b/i,
  /\bSlightly\s+Stoopid\b/i,
  /\bSonic\s+Boom\s+Six\b/i,
  /\b(the\s+)?Unlimiters\b/i,

  // ---- Pioneer Valley Ska Fest — TEMPORARY promotion (remove after the weekend) ----
  // Festival hashtags, name, venue, and lineup bands — always-match for the fest.
  // A few lineup names collide with common phrases and are music-context-gated in
  // AMBIGUOUS_BAND_PATTERNS instead. (Buck-O-Nine already covered above.)
  /#pvsf\b/i,
  /#pioneervalleyskafest\b/i,
  /#pvska\b/i,
  /#pvskafest\b/i,
  /\bpioneer\s+valley\s+ska\s+fest(ival)?\b/i,
  /\bwestern\s+mass(achusetts)?\s+ska\b/i,
  /\b413\s?ska\b/i, // "413 ska", "413ska", "#413ska"
  /\b52\s*sumner\b/i, // festival venue: "52 Sumner St", "52 Sumner", "#52Sumner"
  /\bSgt\.?\s+Scag\b/i,
  /\bGirth\s+Control\b/i,
  /\bcode\s?name:?\s+rocky\b/i,
  /\bSkarmy\s+of\s+Darkness\b/i,
  /\bJoker['’]?s\s+Republic\b/i,
  /\bDo\s+It\s+With\s+Malice\b/i,
  /\b(the\s+)?New\s+Limits\b/i,
  /\b(the\s+)?Agonizers\b/i,
  /\b(the\s+)?Phensic\b/i,
  /\bFuton\s+Lasagna\b/i,
  /\bThreat\s+Level\s+Burgundy\b/i,
  /\bStructure\s+Sounds\b/i,
  /\bSo\s+Many\s+Dangers\b/i,
  /\bGreen\s+Street\s+Fiends\b/i,
  /\bJersey\s+Calling\b/i,
  /\bVoluntary\s+Hazing\b/i,
  /\b(the\s+)?Maka\s+Sticks\b/i,
  /\b(the\s+)?Skluttz\b/i,
  /\bSABON\b/, // case-sensitive: all-caps band styling; avoids the "Sabon" soap brand
  /\bSkaleton\s+Crew\b/i,
  /\bAnalog\s+Daydream\b/i,
  /\b(the\s+)?Valley\s+Moonstompers(\s+Society)?\b/i,
  /\bGhost\s+Tones\b/i,
  /\bPWRUP\b/i,
  // ---- end Pioneer Valley Ska Fest temporary block ----
]

// Band names that are also common words — require music context to match.
// Band names that overlap with common English words — require music context to match.
const AMBIGUOUS_BAND_PATTERNS = [
  /\bthe\s+specials\b/i,
  /\b(the\s+)?selecter\b/i,
  // Madness handled separately via classifyMadness() — not listed here
  /\bsave\s+ferris\b/i,
  /\bgoldfinger\b/i,
  /\bBad\s+Manners\b/,  // case-sensitive: lowercase "bad manners" = common phrase
  /\bsuggs\b/i,         // Madness frontman; music-gated to avoid NFL (Terrell Suggs) false positives
  // rock-?steady removed: now handled by isRocksteadyMusic() gate below isSkaRelated()

  // ---- Pioneer Valley Ska Fest — TEMPORARY (remove after the weekend) ----
  // Lineup bands whose names are common phrases/proper nouns — music-context-gated
  // so they don't flood the feed. Still pass in any festival/gig/show post.
  /\b(the\s+)?Going\s+Rate\b/i, // idiom: "the going rate for..."
  /\bPink\s+Slip\b/i,           // idiom: getting fired
  /\bThumper\b/i,               // Bambi character
  /\b(the\s+)?Selectmen\b/i,    // New England town government
  /\bHorizon\s+Point\b/i,       // generic place/company name
  // ---- end Pioneer Valley Ska Fest temporary block ----

  // TODO names — uncomment only after auditing false-positive risk for the specific name.
  // Original ska (late 1950s–60s)
  // TODO: The Blues Busters (COLLIDE: Leo Gorcey "Blues Busters" 1950 film)
  // /\b(the\s+)?Blues\s+Busters\b/i,
  // TODO: Don Drummond (COLLIDE: Canadian economist Don Drummond)
  // /\bDon\s+Drummond\b/i,
  // TODO: Jackie Edwards (COLLIDE: rugby league player; Bahamian long jumper; UK councillor)
  // /\bJackie\s+Edwards\b/i,
  // TODO: The Ethiopians (COLLIDE: nationality — extremely broad false-positive risk)
  // /\b(the\s+)?Ethiopians\b/i,
  // TODO: The Paragons (COLLIDE: "paragons of virtue" idiom; very common phrase)
  // /\b(the\s+)?Paragons\b/i,
  // TODO: The Pioneers (COLLIDE: generic "pioneers" in any field)
  // /\b(the\s+)?Pioneers\b/i,
  // TODO: Rico Rodriguez (COLLIDE: Sofía Vergara's son in Modern Family; footballer)
  // /\bRico\s+Rodriguez\b/i,
  // 2-Tone revival (late 1970s–80s)
  // TODO: The English Beat / The Beat (COLLIDE: "beat" as common noun/verb; "beat them")
  // /\b(the\s+)?(English\s+)?Beat\b/i,
  // TODO: Buster Bloodvessel (COLLIDE: lookalike meme comparisons)
  // /\bBuster\s+Bloodvessel\b/i,
  // TODO: The Bodysnatchers (COLLIDE: "Invasion of the Body Snatchers")
  // /\b(the\s+)?Bodysnatchers\b/i,
  // TODO: John Bradbury (COLLIDE: common name — consider requiring Specials co-occurrence)
  // /\bJohn\s+Bradbury\b/i,
  // TODO: Andy Cox (COLLIDE: common name — consider requiring "The Beat" co-occurrence)
  // /\bAndy\s+Cox\b/i,
  // TODO: Judge Dread (COLLIDE: misspelling of Judge Dredd; comic character)
  // /\bJudge\s+Dread\b/i,
  // TODO: Chris Foreman (COLLIDE: common name — consider requiring Madness co-occurrence)
  // /\bChris\s+Foreman\b/i,
  // TODO: Terry Hall (COLLIDE: common name; singer died 2022, heavy tribute content)
  // /\bTerry\s+Hall\b/i,
  // TODO: Lee Thompson (COLLIDE: very common name; requires strong co-occurrence signal)
  // /\bLee\s+Thompson\b/i,
  // Third-wave ska (1980s–90s)
  // TODO: Animal Chin (COLLIDE: Powell Peralta "The Search for Animal Chin" skate film)
  // /\bAnimal\s+Chin\b/i,
  // TODO: Area-7 (COLLIDE: generic "area 7" without hyphen; punctuation-sensitive)
  // /\bArea-7\b/,
  // TODO: Athena (COLLIDE: goddess of wisdom; common brand/proper noun)
  // /\bAthena\b/i,
  // TODO: BeNuts (COLLIDE: brand collision)
  // /\bBeNuts\b/i,
  // TODO: Blue Meanies (COLLIDE: Beatles' Yellow Submarine villains; drug slang; political)
  // /\bBlue\s+Meanies\b/i,
  // TODO: Catch 22 (COLLIDE: Heller novel; "catch-22" as idiom)
  // /\bCatch\s+22\b/i,
  // TODO: Choking Victim (COLLIDE: literal phrase; medical context)
  // /\bChoking\s+Victim\b/i,
  // TODO: Chris Murray (COLLIDE: common name — multiple notable people)
  // /\bChris\s+Murray\b/i,
  // TODO: Common Rider (COLLIDE: "common rider" character archetype; tour contract term)
  // /\bCommon\s+Rider\b/i,
  // TODO: The Crazy 8s (COLLIDE: "crazy eights" card game; common phrase)
  // /\b(the\s+)?Crazy\s+8s\b/i,
  // TODO: Desorden Publico (COLLIDE: Spanish phrase "public disorder")
  // /\bDesorden\s+Publico\b/i,
  // TODO: Distemper (COLLIDE: animal disease; paint/decorating term)
  // /\bDistemper\b/i,
  // TODO: Doe Maar (COLLIDE: Dutch phrase "just do it")
  // /\bDoe\s+Maar\b/i,
  // TODO: Downfall (COLLIDE: common noun; Hitler parody meme film)
  // /\bDownfall\b/i,
  // TODO: The Expendables (COLLIDE: Stallone film franchise)
  // /\b(the\s+)?Expendables\b/i,
  // TODO: Falling Sickness (COLLIDE: archaic term for epilepsy)
  // /\bFalling\s+Sickness\b/i,
  // TODO: Farse (COLLIDE: multiple collisions including archaic "farce" variant)
  // /\bFarse\b/i,
  // TODO: Fishbone (COLLIDE: common noun — fish anatomy; herringbone pattern)
  // /\bFishbone\b/i,
  // TODO: Gals Panic (COLLIDE: 1990s arcade game)
  // /\bGals\s+Panic\b/i,
  // TODO: Go Jimmy Go (COLLIDE: encouragement phrase; song title by multiple artists)
  // /\bGo\s+Jimmy\s+Go\b/i,
  // TODO: Hepcat (COLLIDE: jazz slang for a hip person; general colloquial use)
  // /\bHepcat\b/i,
  // TODO: The Hippos (COLLIDE: hippopotamus)
  // /\b(the\s+)?Hippos\b/i,
  // TODO: The Hooters (COLLIDE: restaurant chain; vulgar slang)
  // /\b(the\s+)?Hooters\b/i,
  // TODO: The Impossibles (COLLIDE: Hannah-Barbera cartoon band)
  // /\b(the\s+)?Impossibles\b/i,
  // TODO: Jeffries Fan Club (COLLIDE: Hakeem Jeffries political content)
  // /\bJeffries\s+Fan\s+Club\b/i,
  // TODO: Johnny Socko (COLLIDE: tokusatsu character)
  // /\bJohnny\s+Socko\b/i,
  // TODO: Kemuri (COLLIDE: Japanese word for "smoke"; video game)
  // /\bKemuri\b/i,
  // TODO: The Kingpins (COLLIDE: "the bosses" / organised crime slang)
  // /\b(the\s+)?Kingpins\b/i,
  // TODO: The Know How (COLLIDE: "the know-how" = necessary skills; very common phrase)
  // /\b(the\s+)?Know\s+How\b/i,
  // TODO: Leftöver Crack (COLLIDE: drug reference; umlaut may help uniqueness)
  // /\bLeft[oö]ver\s+Crack\b/i,
  // TODO: Let's Go Bowling (COLLIDE: Lebowski quote; generic bowling invitation)
  // /\bLet['']s\s+Go\s+Bowling\b/i,
  // TODO: Link 80 (COLLIDE: "link 80" without context matches tech/web content)
  // /\bLink\s+80\b/i,
  // TODO: Long Shot Party (COLLIDE: political long shot; film technique; general party)
  // /\bLong\s+Shot\s+Party\b/i,
  // TODO: Mealticket (COLLIDE: "meal ticket" = financial handout idiom)
  // /\bMeal\s*[Tt]icket\b/i,
  // TODO: Monkey (COLLIDE: animal; too common without heavy co-occurrence requirement)
  // /\bMonkey\b/i,
  // TODO: Mr. Review (COLLIDE: AI product naming; generic reviewer reference)
  // /\bMr\.?\s+Review\b/i,
  // TODO: No Doubt (COLLIDE: "no doubt" is an extremely common affirmation phrase)
  // /\bNo\s+Doubt\b/i,
  // TODO: Pilfers (COLLIDE: "pilfer" = to steal)
  // /\bPilfers\b/i,
  // TODO: The Porkers (COLLIDE: derogatory for police; vulgar slang)
  // /\b(the\s+)?Porkers\b/i,
  // TODO: Potshot (COLLIDE: "take a potshot" = cheap criticism idiom)
  // /\bPotshot\b/i,
  // TODO: Pressure Cooker (COLLIDE: kitchen appliance; pressure-as-metaphor)
  // /\bPressure\s+Cooker\b/i,
  // TODO: Rancid (COLLIDE: very common adjective for spoiled food)
  // /\bRancid\b/i,
  // TODO: Ruder Than You (COLLIDE: comparative phrase; easily appears in non-ska contexts)
  // /\bRuder\s+Than\s+You\b/i,
  // TODO: The Rudiments (COLLIDE: "the rudiments" = basic principles; drum fundamentals)
  // /\b(the\s+)?Rudiments\b/i,
  // TODO: The Skunks (COLLIDE: animal; odor metaphor)
  // /\b(the\s+)?Skunks\b/i,
  // TODO: Slapstick (COLLIDE: physical comedy genre)
  // /\bSlapstick\b/i,
  // TODO: Spunge (COLLIDE: intentional "sponge" misspelling — brand/shoe/game confusion)
  // /\bSpunge\b/i,
  // TODO: Spring Heeled Jack (COLLIDE: Victorian urban legend / Penny Dreadful character)
  // /\bSpring\s+Heeled\s+Jack\b/i,
  // TODO: Subb (COLLIDE: multiple potential collisions including "sub" spelling variants)
  // /\bSubb\b/i,
  // TODO: Sublime (COLLIDE: extremely common adjective)
  // /\bSublime\b/i,
  // TODO: Suburban Legends (COLLIDE: Taylor Swift fan community with same name)
  // /\bSuburban\s+Legends\b/i,
  // TODO: Suburban Rhythm (COLLIDE: "Seafront Crew" track; generic phrase)
  // /\bSuburban\s+Rhythm\b/i,
  // TODO: The Suicide Machines (COLLIDE: literal "suicide machines"; AI safety discourse)
  // /\b(the\s+)?Suicide\s+Machines\b/i,
  // TODO: The Toasters (COLLIDE: kitchen appliance; very common in non-ska context)
  // /\b(the\s+)?Toasters\b/i,
  // TODO: The Untouchables (COLLIDE: TV show; Eliot Ness film; social caste term)
  // /\b(the\s+)?Untouchables\b/i,
  // Post-third wave (2000s–present)
  // TODO: Folly (COLLIDE: architecture term; "act of folly" idiom; too broad)
  // /\bFolly\b/i,
  // TODO: The Forces of Evil (COLLIDE: generic villain descriptor)
  // /\b(the\s+)?Forces\s+of\s+Evil\b/i,
  // TODO: I Voted for Kodos (COLLIDE: Simpsons reference; political satire)
  // /\bI\s+Voted\s+for\s+Kodos\b/i,
  // TODO: The Johnstones (COLLIDE: common surname — multiple bands/people)
  // /\b(the\s+)?Johnstones\b/i,
  // TODO: King Prawn (COLLIDE: Pepe the King Prawn; seafood)
  // /\bKing\s+Prawn\b/i,
  // TODO: Lightyear (COLLIDE: Buzz Lightyear; astronomical unit; Pixar film)
  // /\bLightyear\b/i,
  // TODO: The Locos (COLLIDE: "locos" = crazy in Spanish; train locomotive content)
  // /\b(the\s+)?Locos\b/i,
  // TODO: Murphy's Kids (COLLIDE: "Eddie Murphy's kids" etc.; parentage references)
  // /\bMurphy['']s\s+Kids\b/i,
  // TODO: No Torso (COLLIDE: literal phrase; body horror; Portuguese)
  // /\bNo\s+Torso\b/i,
  // TODO: Random Hand (COLLIDE: "random hand" in poker/chance; generic phrase)
  // /\bRandom\s+Hand\b/i,
  // TODO: Rude King (COLLIDE: "that was rude, king" internet phrase)
  // /\bRude\s+King\b/i,
  // TODO: Russkaja (COLLIDE: "Russian woman" in German; Russian war content)
  // /\bRusskaja\b/i,
  // TODO: The Rudimentals (COLLIDE: "rudimentals" = foundational skills; cf. The Rudiments above)
  // /\b(the\s+)?Rudimentals\b/i,
  // TODO: Sounds Like Chicken (COLLIDE: food comparison phrase)
  // /\bSounds\s+Like\s+Chicken\b/i,
  // TODO: Starpool (COLLIDE: Deadpool/Star Butterfly crossover fanart; song title)
  // /\bStarpool\b/i,
  // TODO: The Supervillains (COLLIDE: ubiquitous in comics/gaming/superhero content)
  // /\b(the\s+)?Supervillains\b/i,
  // TODO: Talco (COLLIDE: Portuguese for "talcum"; Texas town; Polish surname)
  // /\bTalco\b/i,
  // TODO: The Upgrades (COLLIDE: "upgrades" extremely common in tech/gaming)
  // /\b(the\s+)?Upgrades\b/i,
  // TODO: Westbound Train (COLLIDE: Dennis Brown reggae song; general train travel content)
  // /\b(the\s+)?Westbound\s+Train\b/i,
]

// Music context words that validate ambiguous terms
const MUSIC_CONTEXT =
  /\b(band|bands|music|song|songs|album|albums|track|tracks|record|records|vinyl|playlist|listen|listening|heard|concert|concerts|show|shows|gig|gigs|tour|touring|live|genre|sound|sounds|horns|brass|trumpet|trombone|saxophone|upstroke|offbeat|tune|tunes)\b/i

// Stricter music context for ambiguous band names — excludes generic bridging words
// (listen/listening, heard, genre, sound, music, playlist) that appear in non-music contexts
// ("listening to a podcast", "I've heard the news"). Used for AMBIGUOUS_BAND_PATTERNS rescue.
const MUSIC_CONTEXT_STRONG =
  /\b(band|bands|song|songs|album|albums|track|tracks|record|records|vinyl|concert|concerts|show|shows|gig|gigs|tour|touring|live|horns|brass|trumpet|trombone|saxophone|upstroke|offbeat|tune|tunes)\b/i

// English music loanwords that appear even in non-English ska posts
const ENGLISH_MUSIC_SIGNALS =
  /\b(gig|gigs|show|shows|band|bands|concert|live|vinyl|ep|lp|bandcamp|spotify|soundcloud|tour|touring|skanking|skank|setlist|encore|venue|merch|lineup|festival|soundcheck|rehearsal|jam|riff)\b/i

// Music context for the Madness MEDIUM rescue — same as MUSIC_CONTEXT but excludes "music".
// The bare word "music" appears as a title word in phrases like "True Tales of Music, Madness and
// Mayhem" and does not reliably signal the ska band sense.
const MADNESS_MEDIUM_RESCUE =
  /\b(band|bands|song|songs|album|albums|track|tracks|record|records|vinyl|playlist|listen|listening|concert|concerts|show|shows|gig|gigs|tour|touring|live|genre|sound|sounds|horns|brass|trumpet|trombone|saxophone|upstroke|offbeat|tune|tunes|ep|lp|bandcamp|spotify|soundcloud|setlist|encore|venue|merch|lineup|festival|soundcheck|rehearsal|jam|riff)\b/i


// Swedish/Norwegian "ska" as modal verb: detected via surrounding grammar
const NORDIC_SKA_PATTERNS = [
  // Swedish subject + ska (jag/du/han/hon/vi/de/ni + ska)
  /\b(jag|du|han|hon|vi|de|den|det|man|ni)\s+ska\b/i,
  // ska + Swedish/Norse modal infinitives
  /\bska\s+(vara|göra|ha|bli|ta|komma|se|få|kunna|vilja|gå|säga|veta|tro|börja|sluta|försöka|behöva|finnas|heta|verka|känna|leva|dö|äta|dricka|sova|jobba|arbeta|spela|läsa|skriva|köpa|sälja|hjälpa|hända|prata|titta|lyssna|träffa|möta|visa|ge|hålla|stå|sitta|ligga|springa|flyga|köra|resa|bo|flytta|fram|dit|hem|bort|upp|ner|ned|tillbaka|vidare|iväg|loss)\b/i,
  // inverted: ska du/vi/jag
  /\bska\s+(vi|du|jag|ni|han|hon|de|man)\b/i,
  // common Norwegian modal: skal + infinitive marker
  /\bskal\s+(du|vi|jeg|dere|han|hun|de|man)\b/i,
  /\b(jeg|du|han|hun|vi|de|dere|man)\s+skal\b/i,
  // Swedish connectives tightly coupling ska
  /\b(det|som|att|och)\s+ska\b/i,
]

// Bond-film exclusion constants. Music context rescues all Bond checks.
const BOND_STRONG_RE = /\bjames bond\b|\bbond (film|movie)\b/i
const GOLDFINGER_RE = /\bgoldfinger\b/i
const GOLDFINGER_BOND_CTX_RE =
  /\bjames bond\b|\bbond (film|movie|villain|franchise|series)\b|\b007\b|\boddjob\b|\bauric\b|\bsean connery\b/i

// Substring exclusions — checked before ambiguous pattern tests
const EXCLUDE_PATTERNS = [
  /\bpolska\b/i, // Polish dance / "Polish" in Swedish
  /\$ska\b/i, // crypto token
  /\bska\s+(coin|token|crypto|airdrop)\b/i,
  /\b(alaska|nebraska|itasca)\b/i,
  // Slavic feminine surnames: "ńska", "śka", etc. — the non-ASCII consonant is \W
  // in JS, so \b fires before "ska" and \bska\b incorrectly matches (e.g. Jasińska).
  // Lookbehind catches exactly this: a Unicode letter immediately before the boundary.
  /(?<=\p{L})\bska\b/u,

  // Madness handled by classifyMadness() below — not listed here

  // Rocksteady Studios (Batman: Arkham games) and TMNT characters Bebop & Rocksteady
  /\b(arkham|rocksteady\s+studios?)\b/i,
  /\b(bebop|beebop)\b.*\brock[-\s]?steady\b|\brock[-\s]?steady\b.*\b(bebop|beebop)\b/i,

  // skanks+skanking co-occurrence handled by SKANKS_SKANKING_RE above isSkaRelated()
]

// Fraction of near-misses to log — 10% gives a representative sample without
// overwhelming stdout on a high-volume firehose. Grep fly logs for "nearMiss".
const NEAR_MISS_SAMPLE_RATE = 0.1

// ---- Madness structural classifier ----------------------------------------
// Distinguishes Madness (ska band) from compound proper nouns, titles, and
// forced sentence-initial capitals. Ported from scripts/madness_filter.py.
//
//   HIGH   (≥ 0.70) — mid-sentence standalone capital: confidently the band
//   MEDIUM (≥ 0.45) — sentence-initial or lightly flanked: pass to context gate
//   LOW    (≥ 0.25) — single adjacent proper noun: probably not the band
//   REJECT (< 0.25) — flanked by 2+, known collocation, or quoted: not the band
//
// Key fix over the old regex approach: direct-adjacency phrases like "March Madness"
// are caught via flankCount (no connective required), and coordinators like "and"
// stop the scan so "Madness and Blur" doesn't penalise Madness.

// Glue words scanned across when measuring flanking proper nouns.
const _MC = new Set([
  'a', 'an', 'as', 'at', 'by', 'down', 'for', 'from', 'if', 'in',
  'into', 'like', 'near', 'of', 'off', 'on', 'once', 'onto', 'over',
  'past', 'than', 'that', 'the', 'to', 'upon', 'when', 'with',
  'de', 'del', 'la', 'le', 'du',
])
// Coordinators stop the scan — they separate list items, not phrase parts.
const _MCOORD = new Set(['and', 'or', 'nor', 'but', 'so', 'yet'])
const _MSEND = new Set(['.', '!', '?'])
const _MQ = new Set(['"', '“', '”', '‘', '’', "'"])
// Direct left-adjacency collocations that are always false positives.
const _MLEFT = new Set(['march'])
// Madness band member names — scan past these in _mFlank without counting them
// as flanking proper nouns, so "Suggs and Lee from Madness" isn't penalised.
const _MMEMBER = new Set([
  "suggs", "barson", "foreman", "thompson", "woodgate", "bedford", "smyth",
  "smash", "chas", "cathal", "kix", "lee", "mike", "chris", "mark", "dan", "graham",
])
// Genre/scene terms that, when capitalized in a list adjacent to Madness, do NOT trigger the
// title-list exclusion — "Ska, Madness and Punk" is a music post, not a subtitle.
const _MMUSIC_TERMS = new Set(["ska", "reggae", "punk", "dub", "jazz", "soul", "pop", "rock"])
const _MTOK = /[A-Za-z][A-Za-z’’]*|[.,;:!?"""–—\/&-]/g

function _mToks(text: string): Array<[string, number]> {
  const re = new RegExp(_MTOK.source, 'g')
  const out: Array<[string, number]> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push([m[0], m.index])
  return out
}

function _mQSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let open: number | null = null
  for (let i = 0; i < text.length; i++) {
    if (_MQ.has(text[i])) {
      // Skip straight apostrophe when word-internal (contraction or possessive).
      // "you've", "Madness's" must not create quote spans.
      if (text[i] === "'" && i > 0 && /[A-Za-z]/.test(text[i - 1])) continue
      if (open === null) open = i
      else { spans.push([open, i]); open = null }
    }
  }
  return spans
}

function _mFlank(toks: Array<[string, number]>, i: number, dir: -1 | 1): number {
  let count = 0, j = i + dir
  while (j >= 0 && j < toks.length) {
    const w = toks[j][0]
    if (!/^[A-Za-z]/.test(w)) break
    const wl = w.toLowerCase()
    if (_MCOORD.has(wl) || wl === 'i') break
    if (_MMEMBER.has(wl)) { j += dir; continue }
    if (_MC.has(wl)) { j += dir; continue }
    if (w[0] >= 'A' && w[0] <= 'Z') { count++; j += dir; continue }
    break
  }
  return count
}

function _mSentInit(toks: Array<[string, number]>, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const t = toks[k][0]
    if (_MQ.has(t)) continue
    if (!/^[A-Za-z]/.test(t)) return _MSEND.has(t)
    return false
  }
  return true
}

function classifyMadness(text: string): 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT' {
  const toks = _mToks(text)
  const qspans = _mQSpans(text)
  const rank = { REJECT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const
  let best: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT' = 'REJECT'

  for (let i = 0; i < toks.length; i++) {
    const [tok, start] = toks[i]
    const base = tok.toLowerCase().replace(/['']s?$/, '')
    if (base !== 'madness') continue
    if (!(tok[0] >= 'A' && tok[0] <= 'Z')) continue  // lowercase → not the band
    const possessive = /['']s?$/.test(tok)  // "Madness'" or "Madness's" → ownership = band

    let score = 0.5
    const inQ = qspans.some(([s, e]) => s < start && start < e)
    if (inQ) score -= 0.35

    const L = _mFlank(toks, i, -1)
    const R = _mFlank(toks, i, 1)
    if (L + R >= 2) score -= 0.45
    else if (L + R === 1) score -= 0.28

    if (i > 0 && /^[A-Za-z]/.test(toks[i - 1][0])) {
      if (_MLEFT.has(toks[i - 1][0].toLowerCase())) score -= 0.5
    }

    // Title-list: "CapWord, Madness and CapWord" — a capitalized non-member, non-genre word
    // on BOTH sides (past comma/colon left, past coordinator right) signals a subtitle or
    // section heading. "True Tales of Music, Madness and Mayhem" → REJECT, not rescuable.
    // "Ska, Madness and Punk" is exempt because ska/punk are in _MMUSIC_TERMS.
    if (L + R === 0 && !inQ) {
      const _isCap = (w: string) =>
        /^[A-Z]/.test(w) && !_MMEMBER.has(w.toLowerCase()) && !_MC.has(w.toLowerCase()) && !_MMUSIC_TERMS.has(w.toLowerCase())
      const rCap = i + 2 < toks.length &&
        _MCOORD.has(toks[i + 1][0].toLowerCase()) && _isCap(toks[i + 2][0])
      const lCap = i >= 2 &&
        !/^[A-Za-z]/.test(toks[i - 1][0]) && _isCap(toks[i - 2][0])
      if (rCap && lCap) score -= 0.40
    }

    if (possessive) score += 0.4  // "Madness' album" → band ownership, strong signal
    const sentInit = _mSentInit(toks, i)
    if (!sentInit && L + R === 0 && !inQ) score += 0.10  // MEDIUM: needs music context
    if (sentInit) score = Math.min(score, 0.55)
    score = Math.max(0, Math.min(1, score))

    const tier: 'HIGH' | 'MEDIUM' | 'LOW' | 'REJECT' =
      score >= 0.70 ? 'HIGH' : score >= 0.45 ? 'MEDIUM' : score >= 0.25 ? 'LOW' : 'REJECT'
    if (rank[tier] > rank[best]) best = tier
  }
  return best
}
// ---- end Madness classifier ------------------------------------------------

// Returns a reason tag if the post had some ska-adjacent signal but was rejected,
// or null if it had no signal at all (no point logging pure noise).
function nearMissReason(text: string, isReply: boolean): string | null {
  const hasHighConf = HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))
  const hasAmbiguous = AMBIGUOUS_BAND_PATTERNS.some((p) => p.test(text))
  const hasMadness = /\bMadness\b/.test(text)
  const hasSka = /\bska\b/i.test(text)
  const hasTwoTone = /\b(2|two)[-\s]?tone\b/i.test(text)
  const hasRudeBoyGirl = /\brude[-\s]?(boy|girl)\b/i.test(text)

  if (!hasHighConf && !hasAmbiguous && !hasMadness && !hasSka && !hasTwoTone && !hasRudeBoyGirl) {
    return null // no ska signal at all — not a near-miss
  }

  const madnessTier = hasMadness ? classifyMadness(text) : null
  const madnessExcluded = madnessTier === 'LOW' || madnessTier === 'REJECT'
  const madnessAmbiguous = madnessTier === 'MEDIUM' || madnessTier === 'HIGH'

  // Exclusion fired despite a positive signal — highest audit priority
  if (EXCLUDE_PATTERNS.some((p) => p.test(text)) || madnessExcluded) {
    if (hasHighConf) return 'exclude:high_confidence'
    if (hasAmbiguous || madnessExcluded) return 'exclude:ambiguous_band'
    if (hasSka) return 'exclude:ska'
    return 'exclude:other'
  }

  // Reply gate blocked it — would have passed the full gate on a root post
  if (isReply && !hasHighConf) {
    if (hasAmbiguous || hasMadness) return 'reply:ambiguous_band'
    if (hasSka) return 'reply:ska'
    return 'reply:other'
  }

  // Ambiguous band matched but no music context
  if ((hasAmbiguous || madnessAmbiguous) && !MUSIC_CONTEXT.test(text) && !ENGLISH_MUSIC_SIGNALS.test(text)) {
    return 'ambiguous:no_context'
  }

  // Standalone ska blocked by Nordic grammar
  if (hasSka && NORDIC_SKA_PATTERNS.some((p) => p.test(text))) {
    return 'ska:nordic'
  }

  // Standalone ska but no music context
  if (hasSka && !MUSIC_CONTEXT.test(text) && !ENGLISH_MUSIC_SIGNALS.test(text)) {
    return 'ska:no_context'
  }

  // Two-tone / rude boy without music context
  if ((hasTwoTone || hasRudeBoyGirl) && !MUSIC_CONTEXT.test(text)) {
    return 'two_tone_or_rude:no_context'
  }

  return 'unknown'
}

// Language-agnostic scene corroboration: co-occurrence with any of these terms
// in the same post confirms the music genre sense of rocksteady/rock-steady.
const SCENE_CORROBORATION_RE =
  /\b(ska|reggae|dub|lovers\s+rock|two[-\s]?tone|2[-\s]?tone|trojan|studio\s+one|skank(?:ing)?|jamaican?|dancehall|mento|stranger\s+cole|hopeton\s+lewis|dandy\s+livingstone|alton\s+ellis|prince\s+buster|desmond\s+dekker)\b/i

// Non-music senses of rocksteady: TMNT characters, Arkham already in EXCLUDE_PATTERNS,
// specific R&B/pop artists whose songs share the name, and promo-item contexts.
const ROCKSTEADY_BLOCKERS_RE =
  /\b(bebop|beebop|turtles?|tmnt|shredder|splinter|krang|donnie|mikey|raph|leonardo|sheamus|rhinoceros|aretha|the\s+whispers|dressed\s+to\s+kill|press\s+kit|lure\s+pods?)\b/i

// Adjectival/metaphorical use: intensifier before, or a plain noun (not music) right after.
const ROCKSTEADY_ADJ_RE =
  /\b(otherwise|very|pretty|quite|so|really|fairly|remarkably)\s+rock[-\s]?steady\b|\brock[-\s]?steady\s+(run|runs|hands?|pace|nerves?|grip|guy|presence|performance|defen[cs]e)\b/i

// 2-tone bands that compound with Madness as a strong corroborating signal.
const TWOTONE_BANDS_RE =
  /\b(the\s+)?(specials|selecter|the\s+beat|bad\s+manners|bodysnatchers|hotknives)\b/i

// Madness MEDIUM rescue: distinctive band member names (generic first names excluded)
// and well-known hit titles. Either in the same post as Madness rescues a MEDIUM tier result.
const MADNESS_MEMBER_RE =
  /\b(suggs|barson|foreman|smyth|smash|cathal|kix|woodgate|bedford)\b/i
const MADNESS_SONGS_RE =
  /\b(baggy\s+trousers|one\s+step\s+beyond|night\s+boat\s+to\s+cairo|house\s+of\s+fun|it\s+must\s+be\s+love|in\s+the\s+middle\s+of\s+the\s+street)\b/i

// Owns all rock-steady / rocksteady / rock–steady decisions. Called from isSkaRelated
// immediately after EXCLUDE_PATTERNS so Arkham/bebop+rocksteady are already handled.
function isRocksteadyMusic(text: string): boolean {
  // #rocksteady hashtag explicitly opts into the genre; blockers still apply.
  if (/#rocksteady\b/i.test(text)) return !ROCKSTEADY_BLOCKERS_RE.test(text)
  if (ROCKSTEADY_BLOCKERS_RE.test(text)) return false
  if (ROCKSTEADY_ADJ_RE.test(text)) return false
  const hasScene = SCENE_CORROBORATION_RE.test(text)
  // Capital-R mid-sentence with no scene context → proper noun (character/game boss/studio).
  // Negative lookbehind for sentence start (^) and sentence-ending punctuation + space.
  if (/(?<!^)(?<![.!?]\s)\bRocksteady\b/.test(text) && !hasScene) return false
  return hasScene || MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)
}

// Must be checked before HIGH_CONFIDENCE because "skanking" is high-confidence
// but the co-occurrence with derogatory "skanks" overrides it.
const SKANKS_SKANKING_RE = /\bskanks\b.*\bskanking\b|\bskanking\b.*\bskanks\b/i

// Structural spam: posts where @mentions + #hashtags dominate the content.
// Floor of 3 mentions before ratio kicks in — normal posts rarely exceed this.
const MENTION_SPAM_FLOOR = 3
const MENTION_SPAM_RATIO = 0.6

export function isMentionSpam(text: string): boolean {
  const mentions = (text.match(/@[\w.:-]+/g) ?? []).length
  if (mentions < MENTION_SPAM_FLOOR) return false
  const hashtags = (text.match(/#\w+/g) ?? []).length
  const noise = mentions + hashtags
  const prose = text.replace(/@[\w.:-]+/g, '').replace(/#\w+/g, '')
  const proseWords = (prose.match(/\b[a-zA-Z]{2,}\b/g) ?? []).length
  return noise / (noise + proseWords) >= MENTION_SPAM_RATIO
}

export function isSkaRelated(text: string): boolean {
  // Hard override: derogatory "skanks" co-occurring with "skanking" — checked
  // before HIGH_CONFIDENCE so it isn't bypassed by the skanking pattern.
  if (SKANKS_SKANKING_RE.test(text)) return false

  // High-confidence: always pass
  if (HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))) {
    return true
  }

  // Madness requires structural classification to distinguish the band from
  // compound proper nouns (March Madness, Sound of Madness, Midnight Madness).
  // Handled before the generic exclusion/ambiguous passes.
  if (/\bMadness\b/.test(text)) {
    // Co-occurrence with another 2-tone band + music context is a strong compound signal.
    if (TWOTONE_BANDS_RE.test(text) && (MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text))) return true
    const tier = classifyMadness(text)
    if (tier === 'HIGH') return true
    // MEDIUM rescue: music-context words, OR a distinctive member name, OR a well-known hit.
    // All three are MEDIUM-only — REJECT/LOW (e.g. "March Madness" + "Suggs") are not rescued.
    if (tier === 'MEDIUM' && (
      MADNESS_MEDIUM_RESCUE.test(text) ||
      MADNESS_MEMBER_RE.test(text) ||
      MADNESS_SONGS_RE.test(text)
    )) return true
    // LOW/REJECT: signal suppressed — fall through to other checks
  }

  // Hard exclusions
  if (EXCLUDE_PATTERNS.some((p) => p.test(text))) {
    return false
  }

  // Rocksteady gate: fully owns all rock-steady / rocksteady decisions.
  // EXCLUDE_PATTERNS above already handles Arkham and bebop+rocksteady co-occurrence.
  if (/\brock[-\s]?steady\b/i.test(text)) {
    return isRocksteadyMusic(text)
  }

  const hasStandaloneSka = /\bska\b/i.test(text)
  const hasTwoTone = /\b(2|two)[-\s]?tone\b/i.test(text)
  const hasRudeBoyGirl = /\brude[-\s]?(boy|girl)\b/i.test(text)

  // Bond-film signals — exclude unless music context is present.
  const hasMusicCtx = MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)
  if (BOND_STRONG_RE.test(text) && !hasMusicCtx) return false
  if (GOLDFINGER_RE.test(text) && GOLDFINGER_BOND_CTX_RE.test(text) && !hasMusicCtx) return false

  // Ambiguous band names require strong music context (not just generic bridging words like
  // "listening" or "heard" which appear in non-music contexts like podcast posts or news).
  if (AMBIGUOUS_BAND_PATTERNS.some((p) => p.test(text))) {
    if (MUSIC_CONTEXT_STRONG.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)) {
      return true
    }
  }

  if (hasStandaloneSka) {
    // Filter out Nordic grammar patterns
    if (NORDIC_SKA_PATTERNS.some((p) => p.test(text))) {
      // Only rescue if there are English music signals (bilingual ska posts)
      return ENGLISH_MUSIC_SIGNALS.test(text)
    }
    // Non-Nordic standalone ska → require at least music context or music signal
    return MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)
  }

  if (hasRudeBoyGirl && MUSIC_CONTEXT.test(text)) return true
  // two-tone appears in fashion/automotive/design; strip "show(s)" before testing
  // so "show off your eyes" doesn't rescue it, but "show tonight" still does via gig/concert
  if (hasTwoTone && MUSIC_CONTEXT.test(text.replace(/\bshows?\b/gi, ''))) return true

  return false
}

const AUTHOR_AFFINITY_THRESHOLD = 0.5

export class FirehoseSubscription extends JetstreamSubscriptionBase {
  private authorAffinity = new Map<string, { score: number; tier: string }>()

  async loadAuthorAffinity(): Promise<void> {
    const rows = await this.db
      .selectFrom('author_score')
      .select(['did', 'score', 'tier'])
      .execute()
    this.authorAffinity = new Map(rows.map((r) => [r.did, { score: r.score, tier: r.tier }]))
    console.log(
      `author affinity: loaded ${this.authorAffinity.size} accounts (threshold ${AUTHOR_AFFINITY_THRESHOLD})`,
    )
  }

  // Returns the account's affinity tier if it should bypass the keyword gate
  // for this post, or null if not eligible.
  //   full       — root posts + replies indexed
  //   posts_only — root posts only; replies still need keyword gate
  //   metered    — root posts only; algo applies 1-per-page cap + like threshold
  //   gate_only  — always returns null: scored for ranking but never gate-exempt
  // Content exclusions (Madness compound nouns, TMNT, etc.) block all tiers.
  private getAffinityTier(did: string, text: string): 'full' | 'posts_only' | 'metered' | null {
    const entry = this.authorAffinity.get(did)
    if (!entry || entry.score < AUTHOR_AFFINITY_THRESHOLD) return null
    if (entry.tier === 'gate_only') return null  // scored for ranking, never gate-exempt
    if (SKANKS_SKANKING_RE.test(text)) return null
    if (EXCLUDE_PATTERNS.some((p) => p.test(text))) return null
    const hasMusicCtx = MUSIC_CONTEXT.test(text) || ENGLISH_MUSIC_SIGNALS.test(text)
    if (BOND_STRONG_RE.test(text) && !hasMusicCtx) return null
    if (GOLDFINGER_RE.test(text) && GOLDFINGER_BOND_CTX_RE.test(text) && !hasMusicCtx) return null
    if (/\bMadness\b/.test(text)) {
      const tier = classifyMadness(text)
      if (tier === 'LOW' || tier === 'REJECT') return null
    }
    if (/\brock[-\s]?steady\b/i.test(text) && !isRocksteadyMusic(text)) return null
    return entry.tier as 'full' | 'posts_only' | 'metered'
  }

  async handleEvent(evt: JetstreamEvent) {
    if (evt.kind !== 'commit' || !evt.commit) return
    try {
      await this.processEvent(evt)
    } catch (err) {
      console.error('firehose write error (dropping event):', err)
    }
  }

  private async processEvent(evt: JetstreamEvent) {
    const { commit } = evt!
    const uri = `at://${evt.did}/${commit!.collection}/${commit!.rkey}`

    if (commit!.collection === 'app.bsky.feed.post') {
      if (commit!.operation === 'delete') {
        await this.db.deleteFrom('post').where('uri', '=', uri).execute()
      } else if (commit!.operation === 'create' && commit!.record) {
        // Hard-blocked accounts: totally excluded before any gate logic
        if (this.authorAffinity.get(evt.did)?.tier === 'blocked') return

        const text = (commit!.record['text'] as string) ?? ''

        // Structural spam: @mention flood — skip before semantic checks
        if (isMentionSpam(text)) return
        // Replies lack parent context — require a standalone high-confidence signal
        // rather than the looser standalone-ska + music-context gate.
        const isReply = Boolean(commit!.record['reply'])
        const keywordMatch = isReply
          ? HIGH_CONFIDENCE_PATTERNS.some((p) => p.test(text))
          : isSkaRelated(text)
        // Always check affinity tier so metered cap applies even when the keyword gate also fires.
        // gate_only accounts return null here — they're scored for ranking but always use the gate.
        const authorTier = this.getAffinityTier(evt.did, text)
        const affinityMatch = authorTier !== null && (!isReply || authorTier === 'full')
        if (keywordMatch || affinityMatch) {
          await this.db
            .insertInto('post')
            .values({
              uri,
              cid: commit!.cid ?? '',
              authorDid: evt.did,
              indexedAt: new Date().toISOString(),
              likeCount: 0,
              lexiconScore: computeLexiconScore(text),
              scoreVersion: LEXICON_SCORE_VERSION,
              inclusionReason: affinityMatch ? authorTier! : 'keyword',
            })
            .onConflict((oc) => oc.doNothing())
            .execute()
        } else if (Math.random() < NEAR_MISS_SAMPLE_RATE) {
          const reason = nearMissReason(text, isReply)
          if (reason) {
            console.log(
              JSON.stringify({ nearMiss: true, reason, uri, text: text.slice(0, 200) }),
            )
          }
        }
      }
    } else if (commit!.collection === 'app.bsky.feed.like') {
      if (commit!.operation === 'create' && commit!.record) {
        const subject = commit!.record['subject'] as
          | { uri?: string }
          | undefined
        const subjectUri = subject?.uri
        if (subjectUri) {
          // Only track likes on posts we've indexed — storing all firehose likes fills the DB
          const updated = await this.db
            .updateTable('post')
            .set({ likeCount: sql`likeCount + 1` })
            .where('uri', '=', subjectUri)
            .executeTakeFirst()
          if (Number(updated.numUpdatedRows) > 0) {
            await this.db
              .insertInto('like')
              .values({ uri, subjectUri })
              .onConflict((oc) => oc.doNothing())
              .execute()
          }
        }
      } else if (commit!.operation === 'delete') {
        const likeRow = await this.db
          .selectFrom('like')
          .select('subjectUri')
          .where('uri', '=', uri)
          .executeTakeFirst()
        if (likeRow) {
          await this.db
            .updateTable('post')
            .set({ likeCount: sql`MAX(0, likeCount - 1)` })
            .where('uri', '=', likeRow.subjectUri)
            .execute()
          await this.db.deleteFrom('like').where('uri', '=', uri).execute()
        }
      }
    }
  }
}
